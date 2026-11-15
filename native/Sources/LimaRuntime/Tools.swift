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
            let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/config.toml")
            if let text = try? String(contentsOf: config, encoding: .utf8),
               let line = text.split(separator: "\n").first(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("model ") || $0.hasPrefix("model=") }),
               let value = line.split(separator: "=", maxSplits: 1).last?.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) {
                entries.append(Entry(id: value, label: "\(value) (config)"))
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
        return entries
    }
}

/// Built-in commands that replace the Lima 4.x extension platform
/// (spec v1 §5.4) with stable IDs, searchable from Universal Search.
public struct ToolDefinition: Codable, Sendable {
    public var id: String
    public var title: String
    public var keywords: [String]
    public var takesInput: Bool
    /// "inline" results render in Search; "browser" tools are performed by
    /// the browser UI (open a panel, start capture overlay…).
    public var surface: String

    var searchDocument: SearchDocument {
        SearchDocument(source: "tool", id: id, title: title, body: keywords.joined(separator: " "), subtitle: "Lima command",
                       action: SearchAction("runTool", ["tool": id]))
    }
}

public final class ToolRegistry: @unchecked Sendable {
    public let definitions: [ToolDefinition] = [
        .init(id: "notes.new", title: "New Note", keywords: ["note", "create", "write"], takesInput: true, surface: "browser"),
        .init(id: "notes.newCanvas", title: "New Canvas", keywords: ["canvas", "whiteboard", "diagram"], takesInput: true, surface: "browser"),
        .init(id: "terminal.new", title: "New Terminal", keywords: ["shell", "zsh", "console", "terminal"], takesInput: false, surface: "browser"),
        .init(id: "chat.new", title: "New AI Chat", keywords: ["ai", "claude", "codex", "opencode", "chat"], takesInput: true, surface: "browser"),
        .init(id: "screenshot.region", title: "Screenshot Region", keywords: ["capture", "screen", "snip", "screenshot"], takesInput: false, surface: "inline"),
        .init(id: "screenshot.window", title: "Screenshot Window", keywords: ["capture", "window", "screenshot"], takesInput: false, surface: "inline"),
        .init(id: "screenshot.display", title: "Screenshot Display", keywords: ["capture", "monitor", "display", "screen", "screenshot"], takesInput: true, surface: "inline"),
        .init(id: "audio.outputs", title: "Switch Audio Output", keywords: ["audio", "output", "speakers", "headphones", "sound", "airpods"], takesInput: true, surface: "inline"),
        .init(id: "audio.volume", title: "Set Volume", keywords: ["volume", "sound", "mute", "louder", "quieter"], takesInput: true, surface: "inline"),
        .init(id: "media.playpause", title: "Play / Pause Music", keywords: ["spotify", "music", "pause", "play"], takesInput: false, surface: "inline"),
        .init(id: "media.next", title: "Next Track", keywords: ["spotify", "music", "skip", "next"], takesInput: false, surface: "inline"),
        .init(id: "media.dj", title: "Spotify DJ", keywords: ["spotify", "dj", "music"], takesInput: false, surface: "inline"),
        .init(id: "password.generate", title: "Generate Password", keywords: ["password", "secret", "random", "passphrase"], takesInput: true, surface: "inline"),
        .init(id: "uuid.generate", title: "Generate UUID", keywords: ["uuid", "guid", "id"], takesInput: false, surface: "inline"),
        .init(id: "json.format", title: "Format JSON", keywords: ["json", "pretty", "format", "formatter"], takesInput: true, surface: "inline"),
        .init(id: "time.zones", title: "World Clock / Time Zones", keywords: ["time", "timezone", "clock", "convert", "utc"], takesInput: true, surface: "inline"),
        .init(id: "emoji.search", title: "Emoji Picker", keywords: ["emoji", "emoticon", "smiley"], takesInput: true, surface: "inline"),
        .init(id: "display.sleep", title: "Sleep Displays", keywords: ["display", "sleep", "screen off"], takesInput: false, surface: "inline"),
        .init(id: "report.generate", title: "Generate Weekly Report Now", keywords: ["weekly", "report", "summary", "accomplish"], takesInput: false, surface: "inline"),
        .init(id: "github.inbox", title: "GitHub: My Pull Requests & Reviews", keywords: ["github", "pr", "pull", "review", "issues"], takesInput: false, surface: "inline")
    ]

    func run(_ id: String, input: String, runtime: Runtime, context: CallContext) async throws -> JSONValue {
        func text(_ value: String, copy: Bool = true) -> JSONValue {
            .object(["type": .string("text"), "text": .string(value), "copy": .bool(copy)])
        }
        func list(_ items: [(String, String, String)]) -> JSONValue {
            .object(["type": .string("list"), "items": .array(items.map {
                .object(["title": .string($0.0), "subtitle": .string($0.1), "value": .string($0.2)])
            })])
        }
        let argument = input.trimmingCharacters(in: .whitespaces)

        switch id {
        case "password.generate":
            let length = Int(argument).map { min(max($0, 8), 128) } ?? 24
            let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_!@#%+=")
            var bytes = [UInt8](repeating: 0, count: length)
            _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
            return text(String(bytes.map { alphabet[Int($0) % alphabet.count] }))
        case "uuid.generate":
            return text(UUID().uuidString.lowercased())
        case "json.format":
            guard let data = argument.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
                  let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else {
                return text("Paste JSON after the command, e.g. “Format JSON {\"a\":1}”", copy: false)
            }
            return text(String(decoding: pretty, as: UTF8.self))
        case "time.zones":
            return list(WorldClock.rows(query: argument))
        case "emoji.search":
            return list(EmojiCatalog.search(argument).map { ($0.emoji, $0.name, $0.emoji) })
        case "uuid": return text(UUID().uuidString)
        case "display.sleep":
            _ = try? Process.run(URL(fileURLWithPath: "/usr/bin/pmset"), arguments: ["displaysleepnow"])
            return text("Displays sleeping", copy: false)
        case "audio.outputs":
            let devices = AudioDevices.outputs()
            if !argument.isEmpty, let match = devices.first(where: { $0.name.localizedCaseInsensitiveContains(argument) }) {
                try AudioDevices.setDefaultOutput(match.id)
                return text("Output: \(match.name)", copy: false)
            }
            return .object(["type": .string("audioOutputs"), "items": try JSONValue.from(devices)])
        case "audio.volume":
            if let value = Double(argument.replacingOccurrences(of: "%", with: "")) {
                try AudioDevices.setVolume(Float(min(max(value, 0), 100) / 100))
            } else if argument.lowercased() == "mute" {
                try AudioDevices.setVolume(0)
            }
            return .object(["type": .string("volume"), "value": .number(Double(AudioDevices.volume() ?? 0) * 100)])
        case "media.playpause", "media.next":
            try MediaControl.send(id == "media.next" ? "next track" : "playpause")
            return text(id == "media.next" ? "Skipped" : "Toggled playback", copy: false)
        case "media.dj":
            MediaControl.openDJ()
            return text("Opening Spotify DJ", copy: false)
        case "screenshot.region", "screenshot.window", "screenshot.display":
            let mode: CaptureService.Mode = id == "screenshot.region" ? .region : id == "screenshot.window" ? .window : .display(Int(argument.filter(\.isNumber)) ?? 1)
            let capture = try await CaptureService.shared.capture(mode)
            return .object(["type": .string("capture"), "capture": try JSONValue.from(capture)])
        case "report.generate":
            let report = try await runtime.context.generateReportNow()
            runtime.search.index.upsert(Runtime.document(for: report))
            return .object(["type": .string("report"), "id": .string(report.id), "markdown": .string(report.markdown)])
        case "github.inbox":
            return try await Integrations.githubSummary()
        default:
            // Browser-surface tools are performed by the UI.
            guard definitions.contains(where: { $0.id == id }) else { throw BridgeError(.badRequest, "unknown tool \(id)") }
            return .object(["type": .string("browser"), "tool": .string(id), "input": .string(argument)])
        }
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
