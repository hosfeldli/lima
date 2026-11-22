import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaContext
import LimaNotes
import LimaProtocol
import LimaSearch
import LimaStorage
import LimaTerminal

public let limaRuntimeVersion = "5.0.1"

public struct RuntimePaths: Sendable {
    public var data: URL
    public var socket: String
    public var lock: String

    public static func resolve(environment: [String: String] = ProcessInfo.processInfo.environment) -> RuntimePaths {
        let data = environment["LIMA_DATA_DIR"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lima Browser/Runtime")
        var socket = data.appendingPathComponent("run/runtime.sock").path
        if socket.utf8.count > 100 { socket = "/tmp/lima-\(getuid())/runtime.sock" }
        return RuntimePaths(data: data, socket: socket, lock: data.appendingPathComponent("runtime.lock").path)
    }
}

/// Context for one call: which client, and on whose behalf.
public struct CallContext: Sendable {
    public var client: ClientConnection?
    public var origin: ActionOrigin
    /// Set when the caller is a workspace's agent (token-authenticated);
    /// such callers can act only on that workspace.
    public var workspaceID: String? = nil
}

public typealias MethodHandler = @Sendable (JSONValue?, CallContext) async throws -> JSONValue

/// Composes every native service behind one method table (spec v2 §13).
/// All mutating requests from every origin pass through the same
/// AuthorizationBroker (spec rule 4).
public final class Runtime: @unchecked Sendable {
    public let paths: RuntimePaths
    public let store: EncryptedStore
    public let notes: NotesService
    public let conversations: ConversationService
    public let terminals: TerminalService
    public let search: SearchService
    public let context: ContextService
    public let workspaces: WorkspaceService
    public let capabilities: CapabilityRegistry
    public let orchestrator: Orchestrator
    public let discovery = CLIDiscovery()
    public let focus = WorkspaceFocus()
    let browserCalls = BrowserCalls()
    let workspacePrompts = WorkspacePrompts()
    let googleWorkspace = GoogleWorkspace()
    let setup = SetupSessions()
    let grammar = GrammarProcess()
    let dictation = DictationService()
    let updates = UpdateService()
    public let startedAt = Date()

    private static let conversationMethods: Set<String> = [
        "chat.get", "chat.resources", "chat.configure", "chat.mascot", "chat.send", "chat.retry", "chat.edit", "chat.cancel", "chat.delete"
    ]
    private var handlers: [String: MethodHandler] = [:]
    private let clientsLock = NSLock()
    private var clients: Set<ClientConnection> = []
    var activity: ActivityRecorder?

    public static func open(paths: RuntimePaths = .resolve()) async throws -> Runtime {
        let keyProvider: KeyProvider = ProcessInfo.processInfo.environment["LIMA_KEY_FILE"].map { FileKeyProvider(url: URL(fileURLWithPath: $0)) }
            ?? KeychainKeyProvider()
        let store = try EncryptedStore(directory: paths.data.appendingPathComponent("store"), keyProvider: keyProvider)
        let sink = EventSink()
        let notes = try await NotesService(store: store)
        let conversations = try await ConversationService(store: store) { event in sink.conversation(event) }
        let terminals = TerminalService(integrationDirectory: paths.data.appendingPathComponent("shell-integration")) { event in sink.terminal(event) }
        let selections = try await store.get([String: Int].self, collection: "settings", id: "search.selections") ?? [:]
        let search = SearchService(selections: selections)
        let context = try await ContextService(store: store)
        let workspaces = try await WorkspaceService(store: store)
        let executor = RuntimeTaskExecutor()
        let saved = try await store.all(OrchestratedTask.self, collection: Orchestrator.collection)
        let budget = try await store.get(Int.self, collection: "settings", id: "orchestrator.maxAgents") ?? Orchestrator.defaultMaxActive
        let orchestrator = Orchestrator(tasks: saved, executor: executor, maxActive: budget,
            persist: { task in try await store.put(task, collection: Orchestrator.collection, id: task.id) },
            emit: { task in sink.task(task) })
        let runtime = try await Runtime(paths: paths, store: store, notes: notes, conversations: conversations,
                                        terminals: terminals, search: search, context: context, workspaces: workspaces,
                                        orchestrator: orchestrator, sink: sink)
        executor.runtime = runtime
        // Report turns a restart interrupted, and pick up queued work.
        Task { await orchestrator.recover() }
        return runtime
    }

    private init(paths: RuntimePaths, store: EncryptedStore, notes: NotesService, conversations: ConversationService,
                 terminals: TerminalService, search: SearchService, context: ContextService, workspaces: WorkspaceService,
                 orchestrator: Orchestrator, sink: EventSink) async throws {
        self.paths = paths
        self.store = store
        self.notes = notes
        self.conversations = conversations
        self.terminals = terminals
        self.search = search
        self.context = context
        self.workspaces = workspaces
        self.orchestrator = orchestrator
        self.capabilities = CapabilityRegistry()
        sink.runtime = self

        registerCore()
        registerTerminal()
        registerChat()
        registerChatResources()
        registerNotes()
        registerSearch()
        registerContext()
        registerSystem()
        registerGoogleWorkspace()
        registerSetup()
        registerGrammar()
        if let settings = try await store.get(GoogleWorkspace.Settings.self, collection: "settings", id: "google.workspace") {
            await googleWorkspace.restore(settings)
        }
        if try await store.get(Bool.self, collection: "settings", id: "grammar.shortcut") == true {
            try? await grammar.configure(true)
        }
        registerWorkspaces()
        registerAssistant()
        registerOrchestrator()
        registerWorkspaceActivity()
        registerDictation()
        registerUpdates()
        await conversations.setRunConfigurator { [weak self] conversation in
            var configuration = await self?.workspaceAgentConfiguration(conversation) ?? (arguments: [], environment: [:], preamble: nil)
            let richContent = """
            Lima renders standard Markdown tables and supports optional interactive fenced JSON blocks in chat and Notes. Use chart with {"title":"…","type":"bar","values":[{"label":"…","value":3}]} (type bar or line), checklist with {"title":"…","items":["…"]}, quiz with {"title":"…","options":["…"],"correct":0}, or details with {"title":"…","text":"…"} when useful. Use the block name as the fence language and valid JSON as the entire body. Use a map block for an offline world map: {"title":"Trip","markers":[{"label":"New York","latitude":40.71,"longitude":-74.01}],"routes":[{"label":"Route","points":[[40.71,-74.01],[42.36,-71.06]],"durationMinutes":255,"mode":"train"}]}. Coordinates are latitude then longitude. Provide intermediate waypoints for the route shape. The map displays the supplied route and does not compute directions. Leave Markdown tables outside code fences. Notes support ::embed URL for external widgets.
            """
            if conversation.provider == .claude {
                if let index = configuration.arguments.firstIndex(of: "--append-system-prompt") {
                    configuration.arguments[index + 1] += "\n\n" + richContent
                } else {
                    configuration.arguments += ["--append-system-prompt", richContent]
                }
            } else {
                configuration.preamble = [configuration.preamble, richContent].compactMap { $0 }.joined(separator: "\n\n")
            }
            return configuration
        }
        await buildSearchIndex()
        await notes.onChange { [weak self] note, id in self?.noteChanged(note, id: id) }
    }

    // MARK: Routing

    public func register(_ method: String, _ handler: @escaping MethodHandler) { handlers[method] = handler }
    public var methods: [String] { handlers.keys.sorted() }

    public func handle(_ request: BridgeRequest, context: CallContext) async -> BridgeResponse {
        guard request.v == limaBridgeProtocolVersion else {
            return .failure(id: request.id, BridgeError(.unsupportedProtocolVersion, "runtime speaks v\(limaBridgeProtocolVersion), got v\(request.v)"))
        }
        guard let handler = handlers[request.method] else {
            return .failure(id: request.id, BridgeError(.unknownMethod, request.method))
        }
        do {
            if let workspaceID = context.workspaceID {
                let workspace = try await workspaces.get(workspaceID)
                try await workspaces.requireActive(workspaceID)
                if workspace.browserTestURL != nil, !["workspace.browserAction", "workspace.browserPlan"].contains(request.method) {
                    throw BridgeError(.notAuthorized, "This helper may only interact with its assigned browser tab.")
                }
            }
            if Self.conversationMethods.contains(request.method) {
                let conversation = try await conversations.get(try request.params.string("id"))
                if let workspaceID = conversation.workspaceID {
                    guard (try? await workspaces.get(workspaceID)) != nil else {
                        throw BridgeError(.notAuthorized, "This conversation belongs to an archived workspace.")
                    }
                    if request.method != "chat.get", request.method != "chat.cancel" {
                        try await workspaces.requireActive(workspaceID)
                    }
                }
            }
            return .success(id: request.id, try await handler(request.params, context))
        } catch let error as BridgeError {
            return .failure(id: request.id, error)
        } catch TerminalServiceError.directoryAccess(let path) {
            return .failure(id: request.id, BridgeError(.notAuthorized, TerminalServiceError.directoryAccess(path).description))
        } catch TerminalServiceError.shellNotReady {
            return .failure(id: request.id, BridgeError(.deadlineExceeded, TerminalServiceError.shellNotReady.description))
        } catch {
            return .failure(id: request.id, BridgeError(.internalError, String(describing: error)))
        }
    }

    // MARK: Clients & events

    public func connect(_ client: ClientConnection) {
        clientsLock.lock(); clients.insert(client); clientsLock.unlock()
    }

    public func disconnect(_ client: ClientConnection) {
        clientsLock.lock(); clients.remove(client); clientsLock.unlock()
    }

    public func broadcast(_ event: String, _ data: JSONValue) {
        guard let payload = try? JSONEncoder().encode(BridgeEvent(event: event, data: data)) else { return }
        clientsLock.lock(); let targets = clients; clientsLock.unlock()
        for client in targets { client.send(payload) }
    }

    // MARK: Search index maintenance

    func visibleConversations() async -> [ConversationSummary] {
        let live = Set(await workspaces.list().map(\.id))
        return await conversations.list().filter { $0.workspaceID.map { live.contains($0) } ?? true }
    }

    private func buildSearchIndex() async {
        let index = search.index
        for note in await notes.all() { index.upsert(Self.document(for: note)) }
        for summary in await visibleConversations() {
            index.upsert(SearchDocument(source: "conversation", id: summary.id, title: summary.title, subtitle: "AI conversation · \(summary.provider.rawValue)",
                                        timestamp: summary.updatedAt, action: SearchAction("openConversation", ["id": summary.id])))
        }
        for capability in capabilities.definitions where capability.surfaces.search { index.upsert(capability.searchDocument) }
        if let reports = try? await context.reports() {
            for report in reports { index.upsert(Self.document(for: report)) }
        }
        for event in await context.recent(limit: 2000) { if let doc = Self.document(for: event) { index.upsert(doc) } }
        Task.detached { for app in AppCatalog.scan() { index.upsert(app) } }
    }

    static func document(for note: Note) -> SearchDocument {
        SearchDocument(source: "note", id: note.id, title: note.title, body: note.searchableText + " " + note.tags.joined(separator: " "),
                       subtitle: note.kind == .canvas ? "Canvas note" : "Note", timestamp: note.modifiedAt,
                       action: SearchAction("openNote", ["id": note.id]))
    }

    static func document(for report: WeeklyReport) -> SearchDocument {
        SearchDocument(source: "report", id: report.id, title: "Weekly report · \(report.id)", body: report.markdown,
                       subtitle: "Weekly report", timestamp: report.generatedAt, action: SearchAction("openReport", ["id": report.id]))
    }

    static func document(for event: ActivityEvent) -> SearchDocument? {
        switch event.kind {
        case .terminal:
            return SearchDocument(source: "terminal", id: event.id, title: event.title, body: event.detail,
                                  subtitle: "Command · \(event.project.map { ($0 as NSString).lastPathComponent } ?? "terminal")",
                                  timestamp: event.timestamp, action: SearchAction("copyText", ["text": event.title]))
        case .browser, .app, .media:
            return nil
        default:
            return SearchDocument(source: "context", id: event.id, title: event.title, body: event.detail,
                                  subtitle: "Activity · \(event.kind.rawValue)", timestamp: event.timestamp,
                                  action: SearchAction("openContext", ["id": event.id]))
        }
    }

    private func noteChanged(_ note: Note?, id: String) {
        if let note {
            search.index.upsert(Self.document(for: note))
            broadcast("notes.changed", (try? JSONValue.from(note)) ?? .null)
        } else {
            search.index.remove(source: "note", id: id)
            broadcast("notes.deleted", .object(["id": .string(id)]))
        }
    }

    func recordActivity(_ event: ActivityEvent) {
        Task {
            guard (try? await context.record(event)) == true else { return }
            if let document = Self.document(for: event) { search.index.upsert(document) }
            broadcast("context.event", (try? JSONValue.from(event)) ?? .null)
        }
    }
}

/// Bridges service callbacks (created before Runtime exists) to broadcasts.
final class EventSink: @unchecked Sendable {
    weak var runtime: Runtime?

    func task(_ task: OrchestratedTask) {
        runtime?.broadcast("task.updated", task.publicView)
    }

    func terminal(_ event: TerminalEvent) {
        guard let runtime else { return }
        switch event {
        case .output(let id, let data, let offset):
            runtime.broadcast("terminal.output", .object(["id": .string(id), "data": .string(data.base64EncodedString()), "offset": .number(Double(offset))]))
        case .state(let info):
            runtime.broadcast("terminal.state", (try? JSONValue.from(info)) ?? .null)
        case .command(let id, let command):
            runtime.broadcast("terminal.command", .object(["id": .string(id), "command": .string(command.command)]))
            Task {
                let cwd = (try? await runtime.terminals.info(id))?.cwd
                runtime.recordActivity(ActivityEvent(kind: .terminal, title: command.command, project: cwd,
                                                     metadata: ["terminal": id]))
            }
        }
    }

    func conversation(_ event: ConversationEvent) {
        guard let runtime else { return }
        runtime.trackConversation(event)
        switch event {
        case .updated(let conversation):
            runtime.broadcast("chat.updated", (try? JSONValue.from(conversation)) ?? .null)
            let id = conversation.id
            Task { await runtime.orchestrator.observe(conversationID: id) }
            Task {
                if let id = conversation.workspaceID, (try? await runtime.workspaces.get(id)) == nil { return }
                runtime.search.index.upsert(SearchDocument(
                source: "conversation", id: conversation.id, title: conversation.title,
                body: conversation.messages.suffix(20).map(\.text).joined(separator: "\n"),
                subtitle: "AI conversation · \(conversation.provider.rawValue)", timestamp: conversation.updatedAt,
                action: SearchAction("openConversation", ["id": conversation.id])))
                if let id = conversation.workspaceID, (try? await runtime.workspaces.get(id)) == nil {
                    runtime.search.index.remove(source: "conversation", id: conversation.id)
                }
            }
            if let last = conversation.messages.last, last.role == .assistant, last.status != .streaming {
                runtime.recordActivity(ActivityEvent(kind: .agent, title: conversation.title, detail: last.status.rawValue,
                                                     project: conversation.workingDirectory,
                                                     metadata: ["provider": conversation.provider.rawValue, "status": last.status.rawValue]))
            }
        case .delta(let conversationID, let messageID, let text):
            runtime.broadcast("chat.delta", .object(["conversationId": .string(conversationID), "messageId": .string(messageID), "text": .string(text)]))
        }
    }
}
