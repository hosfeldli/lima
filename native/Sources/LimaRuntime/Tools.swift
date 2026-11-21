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
        let trimmed = query.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "×", with: "*").replacingOccurrences(of: "÷", with: "/")
        guard trimmed.count >= 3, trimmed.range(of: #"^[0-9\.\s\+\-\*/\(\)%^]+$"#, options: .regularExpression) != nil,
              trimmed.range(of: #"[\+\-\*/%^]"#, options: .regularExpression) != nil,
              let value = Calculator.evaluate(trimmed), value.isFinite else { return nil }
        let formatted = value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(format: "%.10g", value)
        return SearchResult(key: "calc", source: "tool", title: "= \(formatted)", subtitle: trimmed, score: 1000,
                            action: SearchAction("copyText", ["text": formatted]))
    }
}

/// Recursive-descent arithmetic (no NSExpression: it can raise ObjC exceptions).
enum Calculator {
    static func evaluate(_ text: String) -> Double? {
        var parser = Parser(chars: Array(text.filter { !$0.isWhitespace }))
        guard let value = parser.expression(), parser.index == parser.chars.count else { return nil }
        return value
    }

    struct Parser {
        let chars: [Character]
        var index = 0
        mutating func peek() -> Character? { index < chars.count ? chars[index] : nil }
        mutating func expression() -> Double? {
            guard var value = term() else { return nil }
            while let op = peek(), op == "+" || op == "-" {
                index += 1
                guard let rhs = term() else { return nil }
                value = op == "+" ? value + rhs : value - rhs
            }
            return value
        }
        mutating func term() -> Double? {
            guard var value = power() else { return nil }
            while let op = peek(), op == "*" || op == "/" || op == "%" {
                index += 1
                guard let rhs = power() else { return nil }
                value = op == "*" ? value * rhs : op == "/" ? value / rhs : value.truncatingRemainder(dividingBy: rhs)
            }
            return value
        }
        mutating func power() -> Double? {
            guard let base = unary() else { return nil }
            if peek() == "^" { index += 1; guard let exponent = power() else { return nil }; return pow(base, exponent) }
            return base
        }
        mutating func unary() -> Double? {
            if peek() == "-" { index += 1; return unary().map { -$0 } }
            if peek() == "(" {
                index += 1
                let value = expression()
                guard peek() == ")" else { return nil }
                index += 1
                return value
            }
            let start = index
            while let c = peek(), c.isNumber || c == "." { index += 1 }
            return start == index ? nil : Double(String(chars[start..<index]))
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
