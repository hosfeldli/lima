import Foundation
import LimaStorage

public struct ChatMessage: Codable, Equatable, Sendable {
    public enum Role: String, Codable, Sendable { case user, assistant }
    public enum Status: String, Codable, Sendable { case complete, streaming, failed, queued }

    public var id: String
    public var role: Role
    public var text: String
    public var createdAt: Double
    public var status: Status
    public var error: AgentFailure?
    public var tools: [String]
    public var progress: AgentProgress? = nil
    /// A short note shown above the reply, e.g. that Lima switched providers.
    public var notice: String? = nil
}

public struct Conversation: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var provider: CLIProvider
    public var model: String?
    public var cliSessionID: String?
    public var workingDirectory: String
    public var messages: [ChatMessage]
    public var createdAt: Double
    public var updatedAt: Double
    /// Set for a workspace's agent conversation.
    public var workspaceID: String?
    public var mascot: ChatMascot? = nil
}

public enum ChatMascot: String, Codable, Sendable {
    case classic, builder, explorer, artist, analyst, chef, traveler

    public static func suggested(for text: String) -> Self {
        let words = Set(text.lowercased().split { !$0.isLetter }.map(String.init))
        if !words.isDisjoint(with: ["recipe", "recipes", "cook", "cooking", "bake", "baking", "meal", "ingredients"]) { return .chef }
        if !words.isDisjoint(with: ["travel", "trip", "itinerary", "flight", "flights", "vacation", "hotel", "hotels"]) { return .traveler }
        if !words.isDisjoint(with: ["research", "sources", "compare", "investigate", "browse"]) { return .explorer }
        if !words.isDisjoint(with: ["chart", "data", "analyze", "report", "statistics"]) { return .analyst }
        if !words.isDisjoint(with: ["design", "art", "draw", "write", "story"]) { return .artist }
        if !words.isDisjoint(with: ["build", "code", "fix", "debug", "terminal", "test"]) { return .builder }
        return .classic
    }
}

public struct ConversationSummary: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var provider: CLIProvider
    public var updatedAt: Double
    public var running: Bool
    public var workspaceID: String?
    public var lastStatus: ChatMessage.Status?
    public var lastMessageID: String? = nil
    public var lastCreatedAt: Double? = nil
    public var lastErrorKind: AgentFailureKind?
    public var lastProgress: AgentProgress?
    public var mascot: ChatMascot? = nil
}

public enum ConversationEvent: Sendable {
    case updated(Conversation)
    case delta(conversationID: String, messageID: String, text: String)
}

public enum ConversationError: Error, CustomStringConvertible {
    case notFound(String)
    case messageNotFound(String)
    case notEditable(String)

    public var description: String {
        switch self {
        case .notFound(let id): "conversation \(id) not found"
        case .messageNotFound(let id): "message \(id) not found"
        case .notEditable(let reason): reason
        }
    }
}

/// Persistent, encrypted AI conversations over the CLI adapters.
///
/// A CLI failure becomes an error on the affected assistant message only;
/// the conversation, drafts and earlier messages stay intact and the turn
/// can be retried or edited (spec v1 §3.5, v2 §5.5). Messages sent while a
/// turn is running are queued rather than interrupting it.
public actor ConversationService {
    public static let collection = "conversations"

    private let store: EncryptedStore
    private let discovery: CLIDiscovery
    private var conversations: [String: Conversation] = [:]
    private var running: [String: AgentRun] = [:]
    private var queues: [String: [String]] = [:] // conversationID → queued user message IDs
    private let emit: @Sendable (ConversationEvent) -> Void
    /// Supplies per-conversation CLI extras (workspace MCP config, preamble).
    public typealias RunConfigurator = @Sendable (Conversation) async -> (arguments: [String], environment: [String: String], preamble: String?)
    private var configurator: RunConfigurator?
    /// Picks the provider to continue with when one hits its usage limit:
    /// given the provider that failed and those already tried this turn,
    /// returns a ready provider, or nil to surface the failure as usual.
    public typealias Failover = @Sendable (_ failed: CLIProvider, _ tried: Set<CLIProvider>) async -> CLIProvider?
    private var failover: Failover?
    private var tried: [String: Set<CLIProvider>] = [:] // conversationID → providers that hit a limit this turn

    public func setRunConfigurator(_ configurator: @escaping RunConfigurator) { self.configurator = configurator }
    public func setFailover(_ failover: Failover?) { self.failover = failover }

    public init(store: EncryptedStore, discovery: CLIDiscovery = CLIDiscovery(), emit: @escaping @Sendable (ConversationEvent) -> Void) async throws {
        self.store = store
        self.discovery = discovery
        self.emit = emit
        for var conversation in try await store.all(Conversation.self, collection: Self.collection) {
            // A runtime restart interrupts streaming turns; surface that as a
            // recoverable failure instead of a message stuck "streaming".
            for index in conversation.messages.indices where conversation.messages[index].status == .streaming {
                conversation.messages[index].status = .failed
                conversation.messages[index].error = AgentFailure(.processCrashed, "Interrupted when Lima's runtime restarted. Retry to continue.")
            }
            conversations[conversation.id] = conversation
        }
    }

    public func list() -> [ConversationSummary] {
        conversations.values.sorted { $0.updatedAt > $1.updatedAt }.map { conversation in
            let reply = conversation.messages.last { $0.role == .assistant }
            return ConversationSummary(id: conversation.id, title: conversation.title, provider: conversation.provider,
                updatedAt: conversation.updatedAt, running: running[conversation.id] != nil, workspaceID: conversation.workspaceID,
                lastStatus: reply?.status, lastMessageID: reply?.id, lastCreatedAt: reply?.createdAt,
                lastErrorKind: reply?.error?.kind, lastProgress: reply?.progress, mascot: conversation.mascot)
        }
    }

    public func get(_ id: String) throws -> Conversation {
        guard let conversation = conversations[id] else { throw ConversationError.notFound(id) }
        return conversation
    }

    public func create(provider: CLIProvider, model: String?, workingDirectory: String?, workspaceID: String? = nil, title: String? = nil) async throws -> Conversation {
        let now = Self.now()
        let conversation = Conversation(
            id: UUID().uuidString, title: title ?? "New conversation", provider: provider, model: model, cliSessionID: nil,
            workingDirectory: workingDirectory ?? NSHomeDirectory(), messages: [], createdAt: now, updatedAt: now, workspaceID: workspaceID
        )
        try await save(conversation)
        return conversation
    }

    public func delete(_ id: String) async throws {
        running[id]?.cancel()
        conversations[id] = nil
        try await store.delete(collection: Self.collection, id: id)
    }

    /// Changing provider or model never breaks the conversation: the next
    /// turn starts a fresh CLI session with the transcript as context.
    public func rename(_ id: String, title: String) async throws -> Conversation {
        var conversation = try get(id)
        conversation.title = title
        try await save(conversation)
        return conversation
    }

    public func configure(_ id: String, provider: CLIProvider, model: String?) async throws -> Conversation {
        var conversation = try get(id)
        if conversation.provider != provider || conversation.model != model { conversation.cliSessionID = nil }
        conversation.provider = provider
        conversation.model = model
        try await save(conversation)
        return conversation
    }

    public func setMascot(_ id: String, to mascot: ChatMascot) async throws -> Conversation {
        var conversation = try get(id)
        guard conversation.mascot != mascot else { return conversation }
        conversation.mascot = mascot
        try await save(conversation)
        return conversation
    }

    public func send(_ id: String, text: String) async throws -> Conversation {
        var conversation = try get(id)
        if conversation.mascot == nil { conversation.mascot = ChatMascot.suggested(for: text) }
        let message = ChatMessage(id: UUID().uuidString, role: .user, text: text, createdAt: Self.now(),
                                  status: running[id] == nil ? .complete : .queued, error: nil, tools: [])
        conversation.messages.append(message)
        if conversation.title == "New conversation" { conversation.title = Self.title(from: text) }
        try await save(conversation)
        if running[id] == nil { try await startTurn(id, userMessageID: message.id) } else { queues[id, default: []].append(message.id) }
        return try get(id)
    }

    /// Retry the turn that produced a failed assistant message.
    public func retry(_ id: String, assistantMessageID: String) async throws -> Conversation {
        var conversation = try get(id)
        guard let index = conversation.messages.firstIndex(where: { $0.id == assistantMessageID }) else { throw ConversationError.messageNotFound(assistantMessageID) }
        guard let userIndex = conversation.messages[..<index].lastIndex(where: { $0.role == .user }) else {
            throw ConversationError.notEditable("no user message precedes this reply")
        }
        let userID = conversation.messages[userIndex].id
        conversation.messages.remove(at: index)
        try await save(conversation)
        if running[id] == nil { try await startTurn(id, userMessageID: userID) }
        return try get(id)
    }

    /// Edit a user message: later turns are discarded and the conversation
    /// continues from the edited message in a fresh CLI session.
    public func edit(_ id: String, messageID: String, text: String) async throws -> Conversation {
        guard running[id] == nil else { throw ConversationError.notEditable("Stop the running reply before editing") }
        var conversation = try get(id)
        guard let index = conversation.messages.firstIndex(where: { $0.id == messageID && $0.role == .user }) else {
            throw ConversationError.messageNotFound(messageID)
        }
        conversation.messages[index].text = text
        conversation.messages.removeSubrange((index + 1)...)
        conversation.cliSessionID = nil
        try await save(conversation)
        try await startTurn(id, userMessageID: messageID)
        return try get(id)
    }

    public func cancel(_ id: String) {
        queues[id] = nil
        running[id]?.cancel()
    }

    /// One-shot Quick Ask: no conversation, no tools, low effort.
    public func quickAsk(provider: CLIProvider, model: String?, prompt: String, onDelta: @escaping @Sendable (String) -> Void) async -> Result<String, AgentFailure> {
        var provider = provider
        var model = model
        var tried: Set<CLIProvider> = []
        while true {
            let result = await quickAskOnce(provider: provider, model: model, prompt: prompt, onDelta: onDelta)
            guard case .failure(let failure) = result, failure.kind == .rateLimited, let failover else { return result }
            tried.insert(provider)
            guard let next = await failover(provider, tried), !tried.contains(next) else { return result }
            provider = next
            model = nil
        }
    }

    private func quickAskOnce(provider: CLIProvider, model: String?, prompt: String, onDelta: @escaping @Sendable (String) -> Void) async -> Result<String, AgentFailure> {
        guard let executable = await executable(for: provider) else {
            return .failure(AgentFailure(.missingExecutable, "\(provider.rawValue) CLI is not installed"))
        }
        let request = AgentRunRequest(provider: provider, prompt: prompt, model: model, workingDirectory: FileManager.default.temporaryDirectory, mode: .quickAsk)
        let run = AgentRun(request: request, executable: executable, searchPath: discovery.searchPaths)
        let deadline = Task {
            try? await Task.sleep(for: .seconds(45))
            if !Task.isCancelled { run.cancel() }
        }
        defer { deadline.cancel() }
        var text = ""
        for await event in run.events {
            switch event {
            case .delta(let chunk): text += chunk; onDelta(chunk)
            case .completed(let final): return .success(final.isEmpty ? text : final)
            case .failed(let failure): return .failure(failure)
            default: break
            }
        }
        return text.isEmpty ? .failure(AgentFailure(.unknown, "no response")) : .success(text)
    }

    // MARK: Turn execution

    private func startTurn(_ id: String, userMessageID: String, notice: String? = nil) async throws {
        if notice == nil { tried[id] = nil }
        var conversation = try get(id)
        guard let userIndex = conversation.messages.firstIndex(where: { $0.id == userMessageID }) else { return }
        conversation.messages[userIndex].status = .complete
        var reply = ChatMessage(id: UUID().uuidString, role: .assistant, text: "", createdAt: Self.now(), status: .streaming, error: nil, tools: [])
        reply.notice = notice
        conversation.messages.insert(reply, at: userIndex + 1)
        try await save(conversation)

        guard let executable = await executable(for: conversation.provider) else {
            try await finishTurn(id, replyID: reply.id, result: .failed(AgentFailure(.missingExecutable,
                "\(conversation.provider.rawValue) CLI is not installed or not on PATH. Install it, then retry.")))
            return
        }

        // Without a resumable CLI session, give the CLI the transcript.
        let requestText = Self.providerPrompt(conversation.messages[userIndex].text)
        let prompt: String
        if conversation.cliSessionID == nil, userIndex > 0 {
            let transcript = conversation.messages[..<userIndex]
                .filter { $0.status == .complete && !$0.text.isEmpty }
                .map { "\($0.role == .user ? "User" : "Assistant"): \($0.text)" }
                .joined(separator: "\n\n")
            prompt = "Conversation so far:\n\n\(transcript)\n\nUser: \(requestText)"
        } else {
            prompt = requestText
        }

        var request = AgentRunRequest(
            provider: conversation.provider, prompt: prompt, model: conversation.model,
            cliSessionID: conversation.provider == .opencode ? nil : conversation.cliSessionID,
            workingDirectory: URL(fileURLWithPath: conversation.workingDirectory), mode: .chat
        )
        if let configurator {
            let extras = await configurator(conversation)
            request.extraArguments = extras.arguments
            request.extraEnvironment = extras.environment
            if let preamble = extras.preamble { request.prompt = preamble + "\n\n" + request.prompt }
        }
        let run = AgentRun(request: request, executable: executable, searchPath: discovery.searchPaths)
        running[id] = run

        Task { [weak self] in
            for await event in run.events { await self?.handle(event, conversationID: id, replyID: reply.id) }
        }
    }

    private func handle(_ event: AgentStreamEvent, conversationID id: String, replyID: String) async {
        guard var conversation = conversations[id], let index = conversation.messages.firstIndex(where: { $0.id == replyID }) else { return }
        switch event {
        case .session(let session):
            conversation.cliSessionID = session
            conversation.messages[index].progress = .connected
            conversations[id] = conversation
            emit(.updated(conversation))
        case .progress(let progress):
            guard conversation.messages[index].progress != progress else { return }
            conversation.messages[index].progress = progress
            conversations[id] = conversation
            emit(.updated(conversation))
        case .delta(let text):
            conversation.messages[index].text += text
            conversations[id] = conversation
            emit(.delta(conversationID: id, messageID: replyID, text: text))
        case .tool(let name, let detail):
            conversation.messages[index].tools.append(detail.isEmpty ? name : "\(name): \(detail)")
            conversations[id] = conversation
            emit(.updated(conversation))
        case .completed, .failed:
            try? await finishTurn(id, replyID: replyID, result: event)
        }
    }

    private func finishTurn(_ id: String, replyID: String, result: AgentStreamEvent) async throws {
        guard var conversation = conversations[id], let index = conversation.messages.firstIndex(where: { $0.id == replyID }) else { return }
        switch result {
        case .completed(let text):
            if !text.isEmpty { conversation.messages[index].text = text }
            conversation.messages[index].status = .complete
        case .failed(let failure):
            if failure.kind == .rateLimited, try await switchProvider(&conversation, replyIndex: index, failure: failure) { return }
            conversation.messages[index].status = .failed
            conversation.messages[index].error = failure
            // A rejected resume shouldn't poison the next turn.
            if failure.kind == .unknown || failure.kind == .modelRejected { conversation.cliSessionID = nil }
        default:
            break
        }
        running[id] = nil
        conversation.messages[index].progress = nil
        try await save(conversation)

        if var queue = queues[id], !queue.isEmpty {
            let next = queue.removeFirst()
            queues[id] = queue
            try await startTurn(id, userMessageID: next)
        }
    }

    /// A usage limit on one provider: continue the same turn on another ready
    /// provider, with the transcript as context. The failed reply is replaced
    /// and the new one carries a notice saying what happened.
    private func switchProvider(_ conversation: inout Conversation, replyIndex index: Int, failure: AgentFailure) async throws -> Bool {
        let id = conversation.id
        let failed = conversation.provider
        let replyID = conversation.messages[index].id
        guard let failover, conversation.messages[index].text.isEmpty,
              let userID = conversation.messages[..<index].last(where: { $0.role == .user })?.id else { return false }
        var attempted = tried[id] ?? []
        attempted.insert(failed)
        guard let next = await failover(failed, attempted), !attempted.contains(next) else { return false }
        tried[id] = attempted
        conversation = conversations[id] ?? conversation
        guard let current = conversation.messages.firstIndex(where: { $0.id == replyID }) else { return false }
        conversation.messages.remove(at: current)
        conversation.provider = next
        conversation.model = nil
        conversation.cliSessionID = nil
        running[id] = nil
        try await save(conversation)
        try await startTurn(id, userMessageID: userID,
                            notice: "\(Self.providerName(failed)) reached its usage limit, so Lima switched to \(Self.providerName(next)).")
        return true
    }

    public static func providerName(_ provider: CLIProvider) -> String {
        switch provider {
        case .claude: "Claude Code"
        case .codex: "Codex"
        case .opencode: "OpenCode"
        }
    }

    private func executable(for provider: CLIProvider) async -> String? {
        discovery.locate(provider)
    }

    private func save(_ conversation: Conversation) async throws {
        var updated = conversation
        updated.updatedAt = Self.now()
        conversations[updated.id] = updated
        try await store.put(updated, collection: Self.collection, id: updated.id)
        emit(.updated(updated))
    }

    static func now() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

    static func providerPrompt(_ text: String) -> String {
        guard let first = text.split(whereSeparator: \.isWhitespace).first,
              first.first == "/", first.count > 1,
              first.dropFirst().allSatisfy({ $0.isLetter || $0.isNumber || "-_:.".contains($0) }),
              !["/skills", "/mcp", "/settings"].contains(first) else { return text }
        return "Invoke your \(first) skill or command for the following request. If this provider cannot load it, report that directly.\n\n\(text)"
    }

    static func title(from text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 60 ? String(line.prefix(57)) + "…" : line
    }
}
