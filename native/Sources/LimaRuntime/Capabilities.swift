import AppKit
import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaContext
import LimaNotes
import LimaProtocol
import LimaSearch

/// The single manifest of everything Lima can do (docs/architecture/unified-architecture.md).
/// Rail, address bar, palette, home, MCP and the activity timeline are all
/// projections of this list; no surface defines its own functions.
public struct CapabilityDefinition: Codable, Sendable, Equatable {
    public struct Input: Codable, Sendable, Equatable {
        public var name: String
        public var placeholder: String
        public var required: Bool
    }

    public struct Surfaces: Codable, Sendable, Equatable {
        public var rail: Bool = false
        public var search: Bool = true
        public var palette: Bool = true
        public var home: Bool = false
    }

    public var id: String
    public var title: String
    public var summary: String
    public var category: String
    public var icon: String
    public var keywords: [String]
    public var input: Input?
    public var surfaces: Surfaces
    public var risk: ActionKind
    /// Grant an external agent needs; nil means not exposed over MCP.
    public var mcpScope: String?
    /// Order within the rail (bottom-up) / home.
    public var rank: Int
}

/// Closed set of result shapes, rendered by one ResultView in every surface.
public enum CapabilityResult {
    static func text(_ text: String, copy: Bool = true) -> JSONValue {
        .object(["type": .string("text"), "text": .string(text), "copy": .bool(copy)])
    }
    static func list(_ items: [(title: String, subtitle: String, value: String)]) -> JSONValue {
        .object(["type": .string("list"), "items": .array(items.map {
            .object(["title": .string($0.title), "subtitle": .string($0.subtitle), "value": .string($0.value)])
        })])
    }
    static func markdown(_ markdown: String) -> JSONValue {
        .object(["type": .string("markdown"), "markdown": .string(markdown)])
    }
    static func open(_ url: String) -> JSONValue {
        .object(["type": .string("open"), "url": .string(url)])
    }
    static func notice(_ message: String, tone: String = "ok") -> JSONValue {
        .object(["type": .string("notice"), "message": .string(message), "tone": .string(tone)])
    }
}

public struct CapabilityRun: Codable, Sendable {
    public var runId: String
    public var capability: String
    public var title: String
    public var icon: String
    public var origin: String
    public var input: String
    public var startedAt: Double
    public var durationMs: Double?
    public var ok: Bool?
    public var error: String?
}

typealias CapabilityHandler = @Sendable (_ input: String, _ runtime: Runtime, _ context: CallContext) async throws -> JSONValue

public final class CapabilityRegistry: @unchecked Sendable {
    public private(set) var definitions: [CapabilityDefinition] = []
    private var handlers: [String: CapabilityHandler] = [:]
    private let lock = NSLock()
    private var runs: [CapabilityRun] = []

    init() { registerAll() }

    public func definition(_ id: String) -> CapabilityDefinition? { definitions.first { $0.id == id } }

    public func recentRuns(limit: Int = 100) -> [CapabilityRun] {
        lock.lock(); defer { lock.unlock() }
        return Array(runs.suffix(limit).reversed())
    }

    // MARK: Execution — the single policy point for every surface

    func run(_ id: String, input: String, runtime: Runtime, context: CallContext, approvalDigest: String? = nil) async throws -> JSONValue {
        guard let definition = definition(id), let handler = handlers[id] else {
            throw BridgeError(.badRequest, "unknown capability \(id)")
        }
        if let required = definition.input, required.required, input.trimmingCharacters(in: .whitespaces).isEmpty {
            throw BridgeError(.badRequest, "\(definition.title) needs \(required.placeholder.lowercased())")
        }
        try authorize(definition, input: input, context: context, approvalDigest: approvalDigest)

        var record = CapabilityRun(runId: UUID().uuidString, capability: id, title: definition.title, icon: definition.icon,
                                   origin: context.origin.rawValue, input: String(input.prefix(200)),
                                   startedAt: Date().timeIntervalSince1970 * 1000, durationMs: nil, ok: nil, error: nil)
        runtime.broadcast("capability.started", (try? JSONValue.from(record)) ?? .null)
        let started = Date()
        do {
            let result = try await handler(input, runtime, context)
            record.ok = true
            record.durationMs = Date().timeIntervalSince(started) * 1000
            finish(record, runtime: runtime, definition: definition)
            return result
        } catch {
            record.ok = false
            record.durationMs = Date().timeIntervalSince(started) * 1000
            record.error = (error as? BridgeError)?.message ?? String(describing: error)
            finish(record, runtime: runtime, definition: definition)
            throw error
        }
    }

    /// Same broker decision for every origin. A direct user gesture in Lima's
    /// own UI is the confirmation for `confirm`-level actions; agents, MCP
    /// clients and automations need an explicit single-use approval, and MCP
    /// additionally needs the capability's scope grant.
    func authorize(_ definition: CapabilityDefinition, input: String, context: CallContext, approvalDigest: String?) throws {
        if context.origin == .mcp {
            guard let scope = definition.mcpScope else {
                throw BridgeError(.notAuthorized, "\(definition.id) is not available to external agents")
            }
            guard MCPGrants.shared.allows(scope: scope) else {
                throw BridgeError(.confirmationRequired, "Allow \(scope) for MCP clients in Lima → Integrations first")
            }
        }
        let decision = AuthorizationBroker.defaultPolicy[definition.risk] ?? .block
        switch decision {
        case .allow:
            return
        case .block:
            throw BridgeError(.notAuthorized, "\(definition.title) is blocked by policy")
        case .confirm, .requestAuthorization, .separatePermission:
            if context.origin == .browser { return }
            let operation = ActionOperation(kind: definition.risk, origin: context.origin, targets: [definition.id], arguments: [input])
            guard let approvalDigest, approvalDigest == (try? ApprovalLedger.shared.digest(operation)), ApprovalLedger.shared.consume(operation) else {
                throw BridgeError(.confirmationRequired, "\(definition.title) needs your approval in Lima")
            }
        }
    }

    private func finish(_ record: CapabilityRun, runtime: Runtime, definition: CapabilityDefinition) {
        lock.lock()
        runs.append(record)
        if runs.count > 200 { runs.removeFirst(runs.count - 200) }
        lock.unlock()
        runtime.broadcast("capability.finished", (try? JSONValue.from(record)) ?? .null)
        // Navigation is not activity; everything else joins the action history.
        if definition.category != "navigate" {
            runtime.recordActivity(ActivityEvent(kind: .task, title: definition.title, detail: record.ok == true ? "via \(record.origin)" : "failed: \(record.error ?? "")",
                                                 metadata: ["capability": definition.id, "origin": record.origin]))
        }
    }

    // MARK: Manifest

    private func add(_ id: String, _ title: String, _ summary: String, category: String, icon: String, keywords: [String] = [],
                     input: (String, Bool)? = nil, rail: Bool = false, home: Bool = false, search: Bool = true,
                     risk: ActionKind = .localUtility, mcp: String? = nil, rank: Int = 100, handler: @escaping CapabilityHandler) {
        definitions.append(CapabilityDefinition(
            id: id, title: title, summary: summary, category: category, icon: icon, keywords: keywords,
            input: input.map { .init(name: "input", placeholder: $0.0, required: $0.1) },
            surfaces: .init(rail: rail, search: search, palette: true, home: home),
            risk: risk, mcpScope: mcp, rank: rank))
        handlers[id] = handler
    }

    private func registerAll() {
        func open(_ url: String) -> CapabilityHandler { { _, _, _ in CapabilityResult.open(url) } }
        let q: @Sendable (String) -> String = { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0 }

        // Navigate: every Lima surface (rail order is bottom-up by rank)
        add("open.home", "Lima Home", "Live overview and quick actions", category: "navigate", icon: "home", keywords: ["dashboard", "start"], rail: true, rank: 0, handler: open("about:lima"))
        add("open.workspaces", "Workspaces", "AI workspaces: folder, terminal, agent and tabs", category: "navigate", icon: "workspace", keywords: ["projects", "agents"], rail: true, rank: 0, handler: open("about:lima?view=workspaces"))
        add("open.notes", "Notes", "All notes, organized by your bookmark folders", category: "navigate", icon: "note", keywords: ["notebook"], rail: true, rank: 1, handler: open("about:lima?view=notes"))
        add("open.chat", "AI Chat", "Conversations with Claude, Codex and OpenCode", category: "navigate", icon: "chat", keywords: ["assistant"], rail: true, rank: 2, handler: open("about:lima?view=chat"))
        add("open.terminal", "Terminal", "A shell that keeps running when tabs close", category: "navigate", icon: "terminal", keywords: ["shell", "zsh"], rail: true, rank: 3, handler: open("about:lima?view=terminal"))
        add("open.agents", "Agents", "Installed CLIs, running chats and terminals", category: "navigate", icon: "agents", rail: true, rank: 4, handler: open("about:lima?view=agents"))
        add("open.activity", "Activity", "Every action Lima ran, from every surface", category: "navigate", icon: "activity", keywords: ["history", "log", "timeline"], rail: true, rank: 5, handler: open("about:lima?view=activity"))
        add("open.context", "Context Shelf", "Activity metadata and weekly reports", category: "navigate", icon: "context", keywords: ["week", "reports"], rail: true, rank: 6, handler: open("about:lima?view=context"))
        add("open.studio", "Screenshot Studio", "Capture, annotate and read text", category: "navigate", icon: "studio", rail: true, rank: 7, handler: open("about:lima?view=studio"))
        add("open.audio", "Audio", "Output device, volume and now playing", category: "navigate", icon: "audio", rail: true, rank: 8, handler: open("about:lima?view=audio"))
        add("open.integrations", "Integrations & Settings", "Services, MCP grants, storage", category: "navigate", icon: "integrations", keywords: ["settings", "preferences"], rail: true, rank: 9, handler: open("about:lima?view=integrations"))

        // Create
        add("note.new", "New Note", "Create a note (it becomes a bookmark)", category: "create", icon: "note", keywords: ["write", "create"],
            input: ("Title", false), home: true, risk: .localUtility, mcp: "notes:write", rank: 10) { input, runtime, _ in
            let note = try await runtime.notes.create(title: input, kind: .classic)
            return CapabilityResult.open("about:lima?note=\(note.id)")
        }
        add("canvas.new", "New Canvas", "A freeform canvas for diagrams and plans", category: "create", icon: "canvas", keywords: ["whiteboard", "diagram"],
            input: ("Title", false), home: true, mcp: "notes:write", rank: 11) { input, runtime, _ in
            let note = try await runtime.notes.create(title: input.isEmpty ? "Untitled Canvas" : input, kind: .canvas)
            return CapabilityResult.open("about:lima?note=\(note.id)")
        }
        add("terminal.new", "New Terminal", "Start a zsh session in a tab", category: "create", icon: "terminal", keywords: ["shell"],
            home: true, risk: .runBuildOrTest, rank: 12) { _, runtime, _ in
            let info = try await runtime.terminals.create(cwd: nil)
            return CapabilityResult.open("about:lima?terminal=\(info.id)")
        }
        add("workspace.new", "New AI Workspace", "A folder, terminal and agent that work together in their own tab folder", category: "ai", icon: "workspace",
            keywords: ["project", "agent", "folder"], input: ("Name", false), home: true, risk: .runBuildOrTest, mcp: "workspaces:create", rank: 9) { input, runtime, context in
            let workspace = try await runtime.createWorkspace(name: input.isEmpty ? "Workspace" : input, directory: nil, provider: .claude,
                                                              parentID: context.workspaceID, task: nil)
            return CapabilityResult.open("about:lima?workspace=\(workspace.id)")
        }
        add("chat.new", "New AI Chat", "Start a conversation, optionally with a first message", category: "ai", icon: "chat", keywords: ["claude", "codex", "opencode"],
            input: ("Message", false), home: true, rank: 13) { input, _, _ in
            CapabilityResult.open(input.isEmpty ? "about:lima?chat=new" : "about:lima?chat=new&prompt=\(q(input))")
        }
        add("ai.ask", "Quick Ask", "Fast answer: no tools, no page or file access", category: "ai", icon: "spark", keywords: ["question", "answer"],
            input: ("Question", true), home: true, rank: 14) { input, _, _ in
            CapabilityResult.open("about:lima?ask=\(q(input))")
        }

        // Capture
        for (id, title, mode, rank) in [("screenshot.region", "Screenshot Region", "region", 20), ("screenshot.window", "Screenshot Window", "window", 21), ("screenshot.display", "Screenshot Display", "display", 22)] {
            add(id, title, "Capture to Screenshot Studio (never added to activity history)", category: "capture", icon: "studio", keywords: ["capture", "screen", "snip"],
                input: mode == "display" ? ("Display number", false) : nil, home: mode == "region", risk: .captureScreen, mcp: "screen:capture", rank: rank) { input, _, _ in
                let captureMode: CaptureService.Mode = mode == "region" ? .region : mode == "window" ? .window : .display(Int(input.filter(\.isNumber)) ?? 1)
                let record = try await CaptureService.shared.capture(captureMode)
                return .object(["type": .string("image"), "png": .string(record.pngBase64), "width": .number(Double(record.width)),
                                "height": .number(Double(record.height)), "id": .string(record.id)])
            }
        }

        // System & media
        add("audio.output", "Switch Audio Output", "Pick where sound plays", category: "system", icon: "audio", keywords: ["speakers", "headphones", "airpods", "sound"],
            input: ("Device name", false), home: true, risk: .systemControl, mcp: "media:control", rank: 30) { input, _, _ in
            let devices = AudioDevices.outputs()
            if !input.isEmpty, let match = devices.first(where: { $0.name.localizedCaseInsensitiveContains(input) }) {
                try AudioDevices.setDefaultOutput(match.id)
                return CapabilityResult.notice("Output: \(match.name)")
            }
            return .object(["type": .string("devices"), "items": try JSONValue.from(AudioDevices.outputs())])
        }
        add("audio.volume", "Set Volume", "0–100, or “mute”", category: "system", icon: "volume", keywords: ["louder", "quieter", "mute"],
            input: ("Level 0–100", false), risk: .systemControl, mcp: "media:control", rank: 31) { input, _, _ in
            if let value = Double(input.replacingOccurrences(of: "%", with: "")) { try AudioDevices.setVolume(Float(min(max(value, 0), 100) / 100)) }
            else if input.lowercased() == "mute" { try AudioDevices.setVolume(0) }
            return CapabilityResult.notice("Volume \(Int(((AudioDevices.volume() ?? 0) * 100).rounded()))%")
        }
        for (id, title, command, icon) in [("media.playpause", "Play / Pause", "playpause", "play"), ("media.next", "Next Track", "next track", "next"), ("media.previous", "Previous Track", "previous track", "previous")] {
            add(id, title, "Spotify or Music", category: "media", icon: icon, keywords: ["music", "spotify"], risk: .systemControl, mcp: "media:control", rank: 32) { _, _, _ in
                try MediaControl.send(command)
                return CapabilityResult.notice(title)
            }
        }
        add("media.dj", "Spotify DJ", "Open DJ in Spotify", category: "media", icon: "spark", keywords: ["music", "spotify"], risk: .systemControl, rank: 35) { _, _, _ in
            MediaControl.openDJ()
            return CapabilityResult.notice("Opening Spotify DJ")
        }
        add("display.sleep", "Sleep Displays", "Turn displays off now", category: "system", icon: "moon", risk: .systemControl, rank: 36) { _, _, _ in
            _ = try? Process.run(URL(fileURLWithPath: "/usr/bin/pmset"), arguments: ["displaysleepnow"])
            return CapabilityResult.notice("Displays sleeping")
        }
        add("app.open", "Open Application", "Launch an installed app", category: "system", icon: "app", keywords: ["launch", "app"],
            input: ("App name", true), risk: .systemControl, rank: 37) { input, _, _ in
            let apps = AppCatalog.scan()
            guard let app = apps.first(where: { $0.title.caseInsensitiveCompare(input) == .orderedSame })
                ?? apps.first(where: { $0.title.localizedCaseInsensitiveContains(input) }),
                  let path = app.action.payload["path"] else { throw BridgeError(.badRequest, "No app matches “\(input)”") }
            try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: NSWorkspace.OpenConfiguration())
            return CapabilityResult.notice("Opened \(app.title)")
        }

        // Data & AI
        add("report.generate", "Generate Weekly Report", "Summarize this week from activity", category: "data", icon: "context", keywords: ["week", "summary", "accomplish"],
            home: true, mcp: "context:read", rank: 40) { _, runtime, _ in
            let report = try await runtime.context.generateReportNow()
            runtime.search.index.upsert(Runtime.document(for: report))
            return CapabilityResult.markdown(report.markdown)
        }
        add("github.inbox", "GitHub Inbox", "PRs awaiting your review and your open PRs", category: "data", icon: "github", keywords: ["pr", "pull", "review"],
            home: true, mcp: "github:read", rank: 41) { _, _, _ in try await Integrations.githubSummary() }

        // Utilities (the former extension platform, spec §5.4)
        add("password.generate", "Generate Password", "Random password (8–128 chars)", category: "developer", icon: "key", keywords: ["secret", "random"],
            input: ("Length", false), rank: 50) { input, _, _ in
            let length = Int(input).map { min(max($0, 8), 128) } ?? 24
            let alphabet = Array("abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_!@#%+=")
            var bytes = [UInt8](repeating: 0, count: length)
            _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
            return CapabilityResult.text(String(bytes.map { alphabet[Int($0) % alphabet.count] }))
        }
        add("uuid.generate", "Generate UUID", "A random UUID", category: "developer", icon: "hash", keywords: ["guid", "id"], mcp: "utilities", rank: 51) { _, _, _ in
            CapabilityResult.text(UUID().uuidString.lowercased())
        }
        add("json.format", "Format JSON", "Pretty-print and sort keys", category: "developer", icon: "braces", keywords: ["pretty", "formatter"],
            input: ("JSON", true), mcp: "utilities", rank: 52) { input, _, _ in
            guard let object = try? JSONSerialization.jsonObject(with: Data(input.utf8), options: [.fragmentsAllowed]),
                  let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else {
                throw BridgeError(.badRequest, "That isn't valid JSON")
            }
            return CapabilityResult.text(String(decoding: pretty, as: UTF8.self))
        }
        add("calc", "Calculator", "Arithmetic with + − × ÷ % ^ and parentheses", category: "developer", icon: "calc", keywords: ["math", "calculate"],
            input: ("Expression", true), mcp: "utilities", rank: 53) { input, _, _ in
            guard let value = Calculator.evaluate(input.replacingOccurrences(of: "×", with: "*").replacingOccurrences(of: "÷", with: "/")), value.isFinite else {
                throw BridgeError(.badRequest, "Can't evaluate “\(input)”")
            }
            return CapabilityResult.text(value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(format: "%.10g", value))
        }
        add("time.zones", "World Clock", "Current time around the world", category: "developer", icon: "globe", keywords: ["timezone", "utc", "clock"],
            input: ("City or zone", false), mcp: "utilities", rank: 54) { input, _, _ in
            CapabilityResult.list(WorldClock.rows(query: input).map { (title: $0.0, subtitle: $0.1, value: $0.2) })
        }
        add("emoji.search", "Emoji Picker", "Find and copy emoji", category: "developer", icon: "smile", keywords: ["emoticon", "smiley"],
            input: ("Describe it", false), rank: 55) { input, _, _ in
            CapabilityResult.list(EmojiCatalog.search(input).map { (title: $0.emoji, subtitle: $0.name, value: $0.emoji) })
        }
    }
}

extension CapabilityDefinition {
    var searchDocument: SearchDocument {
        SearchDocument(source: "tool", id: id, title: title, body: ([summary] + keywords + [category]).joined(separator: " "),
                       subtitle: summary, action: SearchAction("runCapability", ["id": id]))
    }
}
