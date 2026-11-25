import AppKit
import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaProtocol
import LimaSearch

/// Models offered per CLI. Aliases are resolved by the CLI itself; a
/// "default" entry always exists so a broken catalog never blocks chat.
enum ModelCatalog {
    struct Entry: Codable { var id: String; var label: String }

    static func models(for provider: CLIProvider) -> [Entry] {
        var entries = [Entry(id: "default", label: "CLI default")]
        switch provider {
        case .claude:
            entries += [Entry(id: "sonnet", label: "Sonnet"), Entry(id: "opus", label: "Opus"), Entry(id: "haiku", label: "Haiku")]
        case .codex:
            let location = ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0) }
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
            let config = location.appendingPathComponent("config.toml")
            if let text = try? String(contentsOf: config, encoding: .utf8),
               let line = text.split(separator: "\n").first(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("model ") || $0.hasPrefix("model=") }),
               let value = line.split(separator: "=", maxSplits: 1).last?.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) {
                entries.append(Entry(id: value, label: "\(value) (config)"))
            }
            if let data = try? Data(contentsOf: location.appendingPathComponent("models_cache.json")),
               let cache = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let models = cache["models"] as? [[String: Any]] {
                entries += models.compactMap { model in
                    guard let id = model["slug"] as? String, model["visibility"] as? String != "hide" else { return nil }
                    return Entry(id: id, label: model["display_name"] as? String ?? id)
                }
            }
        case .opencode:
            if let path = CLIDiscovery().locate(.opencode) {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: path)
                process.arguments = ["models"]
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                if (try? process.run()) != nil {
                    DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if process.isRunning { process.terminate() } }
                    process.waitUntilExit()
                    let lines = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n")
                    entries += lines.prefix(200).map { Entry(id: String($0), label: String($0)) }
                }
            }
        }
        var seen = Set<String>()
        return entries.filter { seen.insert($0.id).inserted }
    }
}

/// Answers computed locally as you type (calculator, unit-free math).
enum InstantAnswers {
    static func answer(for query: String) -> SearchResult? {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 3, trimmed.range(of: #"^[0-9\.\s\+\-\*/\(\)%^−–×·÷]+$"#, options: .regularExpression) != nil,
              trimmed.range(of: #"[\+\-\*/%^−–×·÷]"#, options: .regularExpression) != nil,
              let value = Calculator.evaluate(trimmed), value.isFinite else { return nil }
        let formatted = value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(format: "%.10g", value)
        return SearchResult(key: "calc", source: "tool", title: "= \(formatted)", subtitle: trimmed, score: 1000,
                            action: SearchAction("copyText", ["text": formatted]))
    }
}

/// Recursive-descent arithmetic (no NSExpression: it can raise ObjC exceptions).
///
/// Accepts + − × ÷ * / % ^ and parentheses, in ASCII or the Unicode signs.
/// Precedence follows math notation: ^ binds tighter than a leading minus
/// (−2^2 = −4) and is right-associative; spaces never join numbers ("1 2" is
/// an error, not 12). Anything it can't read exactly returns nil.
enum Calculator {
    enum Token: Equatable { case number(Double), op(Character), open, close }

    static let signs: [Character: Character] = ["−": "-", "–": "-", "—": "-", "×": "*", "·": "*", "∗": "*", "÷": "/", "⁄": "/", "∕": "/"]

    static func tokens(_ text: String) -> [Token]? {
        var result: [Token] = []
        let chars = Array(text.map { signs[$0] ?? $0 })
        var index = 0
        while index < chars.count {
            let c = chars[index]
            if c.isWhitespace { index += 1; continue }
            if "+-*/%^".contains(c) { result.append(.op(c)); index += 1; continue }
            if c == "(" { result.append(.open); index += 1; continue }
            if c == ")" { result.append(.close); index += 1; continue }
            guard c.isASCII, c.isNumber || c == "." else { return nil }
            let start = index
            while index < chars.count, chars[index].isASCII, chars[index].isNumber || chars[index] == "." { index += 1 }
            guard let value = Double(String(chars[start..<index])) else { return nil } // "1.2.3", "."
            // Two numbers in a row ("1 2") don't mean anything.
            if case .number = result.last { return nil }
            result.append(.number(value))
        }
        return result
    }

    static func evaluate(_ text: String) -> Double? {
        guard let tokens = tokens(text), !tokens.isEmpty else { return nil }
        var parser = Parser(tokens: tokens)
        guard let value = parser.expression(), parser.index == tokens.count, value.isFinite else { return nil }
        return value
    }

    struct Parser {
        let tokens: [Token]
        var index = 0
        var depth = 0
        func peek() -> Token? { index < tokens.count ? tokens[index] : nil }
        mutating func expression() -> Double? {
            guard var value = term() else { return nil }
            while case .op(let op) = peek(), op == "+" || op == "-" {
                index += 1
                guard let rhs = term() else { return nil }
                value = op == "+" ? value + rhs : value - rhs
            }
            return value
        }
        mutating func term() -> Double? {
            guard var value = unary() else { return nil }
            while case .op(let op) = peek(), op == "*" || op == "/" || op == "%" {
                index += 1
                guard let rhs = unary(), op == "*" || rhs != 0 else { return nil } // no division by zero
                value = op == "*" ? value * rhs : op == "/" ? value / rhs : value.truncatingRemainder(dividingBy: rhs)
            }
            return value
        }
        /// A leading sign applies to the whole power: −2^2 = −(2^2).
        mutating func unary() -> Double? {
            if case .op(let op) = peek(), op == "-" || op == "+" {
                index += 1
                guard depth < 64 else { return nil }
                depth += 1; defer { depth -= 1 }
                return unary().map { op == "-" ? -$0 : $0 }
            }
            return power()
        }
        mutating func power() -> Double? {
            guard let base = primary() else { return nil }
            guard case .op("^") = peek() else { return base }
            index += 1
            guard depth < 64 else { return nil }
            depth += 1; defer { depth -= 1 }
            guard let exponent = unary() else { return nil } // right-associative; 2^-1 allowed
            return pow(base, exponent)
        }
        mutating func primary() -> Double? {
            switch peek() {
            case .number(let value): index += 1; return value
            case .open:
                index += 1
                guard depth < 64 else { return nil }
                depth += 1; defer { depth -= 1 }
                guard let value = expression(), peek() == .close else { return nil }
                index += 1
                return value
            default: return nil
            }
        }
    }
}

enum WorldClock {
    static let zones: [(String, String)] = [
        ("Local", TimeZone.current.identifier), ("UTC", "UTC"), ("San Francisco", "America/Los_Angeles"), ("New York", "America/New_York"),
        ("London", "Europe/London"), ("Berlin", "Europe/Berlin"), ("Mumbai", "Asia/Kolkata"), ("Singapore", "Asia/Singapore"),
        ("Tokyo", "Asia/Tokyo"), ("Sydney", "Australia/Sydney")
    ]

    static func rows(query: String) -> [(String, String, String)] {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE HH:mm"
        let lower = query.lowercased()
        var matches = zones.filter { lower.isEmpty || $0.0.lowercased().contains(lower) || $0.1.lowercased().contains(lower) }
        if matches.isEmpty, let zone = TimeZone.knownTimeZoneIdentifiers.first(where: { $0.lowercased().contains(lower.replacingOccurrences(of: " ", with: "_")) }) {
            matches = [(zone.split(separator: "/").last.map(String.init)?.replacingOccurrences(of: "_", with: " ") ?? zone, zone)]
        }
        return matches.compactMap { name, identifier in
            guard let zone = TimeZone(identifier: identifier) else { return nil }
            formatter.timeZone = zone
            let time = formatter.string(from: Date())
            return (time, "\(name) · \(zone.abbreviation() ?? identifier)", time)
        }
    }
}

enum EmojiCatalog {
    struct Entry { var emoji: String; var name: String }

    static let all: [Entry] = {
        // Inside Lima.app: Contents/Resources/lima-runtime; in development: the SwiftPM bundle.
        let executable = URL(fileURLWithPath: (CommandLine.arguments[0] as NSString).resolvingSymlinksInPath)
        let packaged = executable.deletingLastPathComponent().appendingPathComponent("../Resources/lima-runtime/emoji-test.txt").standardizedFileURL
        let url = FileManager.default.fileExists(atPath: packaged.path) ? packaged : Bundle.module.url(forResource: "emoji-test", withExtension: "txt")
        guard let url, let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n").compactMap { line in
            guard line.contains("; fully-qualified"), let hash = line.firstIndex(of: "#") else { return nil }
            let tail = line[line.index(after: hash)...].trimmingCharacters(in: .whitespaces)
            let parts = tail.split(separator: " ", maxSplits: 2)
            guard parts.count == 3 else { return nil }
            return Entry(emoji: String(parts[0]), name: String(parts[2]))
        }
    }()

    static func search(_ query: String) -> [Entry] {
        let terms = query.lowercased().split(separator: " ")
        guard !terms.isEmpty else { return Array(all.prefix(40)) }
        return Array(all.filter { entry in terms.allSatisfy { entry.name.lowercased().contains($0) } }.prefix(40))
    }
}
