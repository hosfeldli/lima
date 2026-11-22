import Foundation
import LimaProtocol

/// Link previews for embeds in Notes. Most sites refuse to be framed
/// (X-Frame-Options, frame-ancestors), so Lima reads the page's own
/// metadata natively instead: title, description, site name and preview
/// image. No cookies are sent and the image is returned as a data URL, so
/// the note never loads remote content itself.
actor LinkPreviews {
    static let shared = LinkPreviews()

    private var cache: [String: (at: Date, value: JSONValue)] = [:]
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 12
        configuration.httpAdditionalHeaders = [
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        ]
        return URLSession(configuration: configuration)
    }()

    static func allowed(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return false }
        if url.scheme == "https" { return true }
        return url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    }

    func preview(_ address: String) async throws -> JSONValue {
        guard let url = URL(string: address), Self.allowed(url) else {
            throw BridgeError(.badRequest, "Lima previews HTTPS pages and local previews only.")
        }
        if let hit = cache[url.absoluteString], Date().timeIntervalSince(hit.at) < 1800 { return hit.value }
        let (data, response) = try await fetch(url, limit: 1_000_000)
        let final = response.url ?? url
        let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        var result: [String: JSONValue] = ["url": .string(url.absoluteString), "site": .string(final.host ?? url.host ?? "")]
        if type.hasPrefix("image/") {
            result["title"] = .string(final.lastPathComponent)
            result["image"] = .string("data:\(type.split(separator: ";").first ?? "image/png");base64,\(data.base64EncodedString())")
        } else {
            let html = String(decoding: data, as: UTF8.self)
            let meta = Self.metadata(html)
            result["title"] = .string(meta["og:title"] ?? meta["twitter:title"] ?? meta["title"] ?? final.host ?? "")
            if let description = meta["og:description"] ?? meta["twitter:description"] ?? meta["description"] {
                result["description"] = .string(String(description.prefix(400)))
            }
            if let site = meta["og:site_name"] { result["site"] = .string(site) }
            if let image = meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"],
               let imageURL = URL(string: image, relativeTo: final)?.absoluteURL, Self.allowed(imageURL),
               let (bytes, imageResponse) = try? await fetch(imageURL, limit: 1_500_000),
               let mime = (imageResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first,
               mime.hasPrefix("image/"), mime != "image/svg+xml" {
                result["image"] = .string("data:\(mime);base64,\(bytes.base64EncodedString())")
            }
        }
        let value = JSONValue.object(result)
        cache[url.absoluteString] = (Date(), value)
        if cache.count > 200 { cache.removeAll() }
        return value
    }

    private func fetch(_ url: URL, limit: Int) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(from: url)
        if let status = (response as? HTTPURLResponse)?.statusCode, !(200..<400).contains(status) {
            throw BridgeError(.badRequest, "The site answered with HTTP \(status).")
        }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= limit { break }
        }
        return (data, response)
    }

    /// `<title>` and `<meta name|property=… content=…>` values, decoded.
    static func metadata(_ html: String) -> [String: String] {
        let head = String((html.range(of: "</head>", options: .caseInsensitive).map { html[..<$0.lowerBound] } ?? html[...]).prefix(400_000))
        var values: [String: String] = [:]
        if let title = head.range(of: #"<title[^>]*>([\s\S]*?)</title>"#, options: [.regularExpression, .caseInsensitive]) {
            let inner = head[title].replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            values["title"] = decode(inner)
        }
        guard let tag = try? NSRegularExpression(pattern: #"<meta\s+[^>]*>"#, options: .caseInsensitive),
              let attribute = try? NSRegularExpression(pattern: #"([a-zA-Z:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#) else { return values }
        let range = NSRange(head.startIndex..., in: head)
        for match in tag.matches(in: head, range: range) {
            guard let tagRange = Range(match.range, in: head) else { continue }
            let text = String(head[tagRange])
            var attributes: [String: String] = [:]
            for pair in attribute.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let key = Range(pair.range(at: 1), in: text), let raw = Range(pair.range(at: 2), in: text) else { continue }
                attributes[text[key].lowercased()] = String(text[raw]).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            }
            guard let name = (attributes["property"] ?? attributes["name"])?.lowercased(), let content = attributes["content"],
                  values[name] == nil else { continue }
            values[name] = decode(content)
        }
        return values
    }

    static func decode(_ text: String) -> String {
        var value = text
        for (entity, character) in [("&amp;", "&"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&nbsp;", " ")] {
            value = value.replacingOccurrences(of: entity, with: character)
        }
        if let numeric = try? NSRegularExpression(pattern: #"&#(x?)([0-9a-fA-F]+);"#) {
            for match in numeric.matches(in: value, range: NSRange(value.startIndex..., in: value)).reversed() {
                guard let whole = Range(match.range, in: value), let digits = Range(match.range(at: 2), in: value) else { continue }
                let hex = Range(match.range(at: 1), in: value).map { !value[$0].isEmpty } ?? false
                if let code = UInt32(value[digits], radix: hex ? 16 : 10), let scalar = Unicode.Scalar(code) {
                    value.replaceSubrange(whole, with: String(Character(scalar)))
                }
            }
        }
        return value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
