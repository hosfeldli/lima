import Foundation
import LimaAuthorization
import LimaProtocol

/// One gate for every caller that isn't Lima's own interface (workspace
/// agents, outside MCP tools, anything else on the socket), applied before a
/// method runs. Individual handlers keep their own, narrower checks.
///
/// - Reads of personal content by outside tools need that MCP read grant
///   (Settings → Data & permissions); without it the user is asked.
/// - Actions that belong to the user (their screen, secrets, settings,
///   history, updates) are never refused outright: the user approves them
///   on a card with a short brief, as with every other agent action.
enum SecurityPolicy {
    struct Rule: Sendable {
        var question: String
        var risk: String
    }

    /// Outside tools (MCP) reading personal content need the matching grant.
    static let readScopes: [String: (scope: String, action: String)] = [
        "notes.list": ("notes:read", "read your notes"),
        "notes.get": ("notes:read", "read your notes"),
        "notes.folders": ("notes:read", "read your notes"),
        "search.query": ("search:read", "search your notes, chats and activity"),
        "context.recent": ("context:read", "read your recent activity"),
        "context.reports": ("context:read", "read your weekly reports"),
    ]

    static let userOnly: [String: Rule] = {
        var rules: [String: Rule] = [:]
        func add(_ methods: [String], _ question: String, _ risk: String = "access") {
            for method in methods { rules[method] = Rule(question: question, risk: risk) }
        }
        add(["storage.exportRecoveryKey"], "export the recovery key for your encrypted Lima data", "system")
        add(["capture.take", "capture.list", "capture.ocr", "capture.discard"], "capture or read screenshots of your screen")
        add(["companionMemory.get", "companionMemory.update", "companionMemory.run"], "read or change what the Companion remembers about you")
        add(["context.deleteAll", "context.settings.set"], "change or delete your activity history", "system")
        add(["context.settings.get"], "read your activity-tracking settings")
        add(["chat.list", "chat.get", "chat.create", "chat.record", "chat.configure", "chat.mascot", "chat.send", "chat.attach", "chat.attachment", "chat.media",
             "chat.interrupt", "chat.unqueue", "chat.retry", "chat.edit", "chat.cancel", "chat.delete", "chat.resources"],
            "read or change your AI chats")
        add(["quickAsk"], "ask your AI provider a question on your account")
        add(["system.openApp", "system.openSettings"], "open apps or System Settings", "system")
        add(["integrations.messages.compose"], "write a message in Messages for you", "account")
        add(["integrations.grammar.configure", "integrations.google.configure", "integrations.google.refresh", "integrations.setup.start"],
            "change Lima's integrations", "system")
        add(["update.install", "update.rollback", "update.check", "update.moveToApplications"], "install, check or roll back Lima updates", "system")
        add(["agents.failover"], "change provider failover", "system")
        add(["search.select", "search.resetLearning", "search.rebuild", "search.indexTabs"], "change Lima Search's index", "system")
        add(["notes.migrateLegacy"], "import your Lima 4 notes", "system")
        add(["mcp.grants.set"], "change what outside AI tools may do", "system")
        add(["audio.setOutput"], "switch your audio output", "system")
        return rules
    }()

    /// Workspace agents talk to their own conversation through workspace
    /// methods; their chat tools never touch other chats.
    static func check(_ method: String, context: CallContext, runtime: Runtime) async throws {
        guard context.origin != .browser else { return }
        if context.origin == .mcp, let read = readScopes[method] {
            try await runtime.requireMCPScope(read.scope, context: context, action: read.action)
        }
        if let rule = userOnly[method] {
            let caller = Runtime.callerName(context.origin)
            var asker = caller
            if let id = context.workspaceID, let workspace = try? await runtime.workspaces.get(id) { asker = workspace.name }
            try await runtime.approveAction(context, question: "Let \(asker) \(rule.question)?",
                facts: [.init(label: "Asked by", value: asker), .init(label: "Lima method", value: method)],
                detail: "Only you can do this from Lima's own windows. Allow it once if you asked for it.", risk: rule.risk)
        }
    }
}
