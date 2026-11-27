import AppKit
import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaProtocol
import LimaSearch

/// Models offered per CLI. Aliases are resolved by the CLI itself; a
/// "default" entry always exists so a broken catalog never blocks chat.
enum ModelCatalog {
    /// One model, with the effort levels it accepts (nil: no effort setting)
    /// and the level its CLI uses when none is chosen.
    struct Entry: Codable, Equatable {
        var id: String
        var label: String
        var efforts: [Effort]? = nil
        var defaultEffort: String? = nil
        var older: Bool? = nil
    }
    struct Effort: Codable, Equatable { var id: String; var label: String }

    static let claudeEfforts = ["low", "medium", "high", "xhigh", "max"].map { Effort(id: $0, label: effortLabel($0)) }

    static func effortLabel(_ id: String) -> String {
        ["minimal": "Minimal", "low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra high", "max": "Max", "ultra": "Ultra"][id] ?? id.capitalized
    }

    /// Claude Code's own model list, which it keeps up to date in
    /// ~/.claude/cache/model-catalog (newest Claude Code catalog wins).
    static func claudeModels(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [Entry] {
        let folder = (ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"].map { URL(fileURLWithPath: $0) } ?? home.appendingPathComponent(".claude"))
            .appendingPathComponent("cache/model-catalog")
        let files = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.lastPathComponent.hasSuffix("-cc.json") }
            .sorted { (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast) ?? .distantPast
                > (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast) ?? .distantPast }
        for file in files {
            guard let data = try? Data(contentsOf: file),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let config = (root["catalog"] as? [String: Any])?["config"] as? [String: Any],
                  let models = config["models"] as? [[String: Any]], !models.isEmpty else { continue }
            let entries = models.compactMap { model -> Entry? in
                guard let id = model["id"] as? String, id.hasPrefix("claude-") else { return nil }
                let thinking = model["thinking"] as? [String: Any]
                let options = (thinking?["effort_options"] as? [[String: Any]] ?? []).compactMap { option -> Effort? in
                    guard let effort = option["id"] as? String else { return nil }
                    return Effort(id: effort, label: effortLabel(effort))
                }
                let runtime = model["runtime"] as? [String: Any]
                return Entry(id: id, label: model["name"] as? String ?? id, efforts: options,
                             defaultEffort: runtime?["default_effort"] as? String, older: model["section"] as? String == "overflow" ? true : nil)
            }
            if !entries.isEmpty { return entries.filter { $0.older != true } + entries.filter { $0.older == true } }
        }
        return [Entry(id: "opus", label: "Opus", efforts: claudeEfforts, defaultEffort: "medium"),
                Entry(id: "sonnet", label: "Sonnet", efforts: claudeEfforts, defaultEffort: "medium"),
                Entry(id: "fable", label: "Fable", efforts: claudeEfforts, defaultEffort: "medium"),
                Entry(id: "haiku", label: "Haiku", efforts: claudeEfforts, defaultEffort: "medium")]
    }

    static func models(for provider: CLIProvider) -> [Entry] {
        var entries: [Entry] = []
        switch provider {
        case .claude:
            let models = claudeModels()
            // The CLI's default model takes the efforts of its newest main model.
            entries.append(Entry(id: "default", label: "CLI default", efforts: models.first?.efforts ?? claudeEfforts, defaultEffort: models.first?.defaultEffort))
            entries += models
        case .codex:
            entries.append(Entry(id: "default", label: "CLI default"))
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
                    let levels = (model["supported_reasoning_levels"] as? [[String: Any]] ?? []).compactMap { $0["effort"] as? String }
                    return Entry(id: id, label: model["display_name"] as? String ?? id,
                                 efforts: levels.isEmpty ? nil : levels.map { Effort(id: $0, label: effortLabel($0)) },
                                 defaultEffort: model["default_reasoning_level"] as? String)
                }
                // The CLI default and a configured model take the efforts their model lists.
                for index in entries.indices where entries[index].efforts == nil {
                    let slug = entries[index].id == "default" ? (entries.first { $0.label.hasSuffix("(config)") }?.id ?? entries.dropFirst().first?.id) : entries[index].id
                    if let match = entries.first(where: { $0.id == slug && $0.efforts != nil }) {
                        entries[index].efforts = match.efforts
                        entries[index].defaultEffort = match.defaultEffort
                    }
                }
            }
        case .opencode:
            entries.append(Entry(id: "default", label: "CLI default"))
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
