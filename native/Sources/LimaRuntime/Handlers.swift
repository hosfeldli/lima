import AppKit
import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaContext
import LimaNotes
import LimaProtocol
import LimaSearch
import LimaStorage
import LimaTerminal

extension Runtime {
    // MARK: Core

    func registerCore() {
        register("host.hello") { [unowned self] _, _ in
            .object([
                "protocol": .number(Double(limaBridgeProtocolVersion)),
                "hostVersion": .string(limaRuntimeVersion),
                "buildID": .string(RuntimeBuild.id),
                "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
                "startedAt": .number(self.startedAt.timeIntervalSince1970 * 1000),
                "methods": .array(self.methods.map(JSONValue.string))
            ])
        }
        register("host.ping") { _, _ in .object(["pong": .bool(true), "time": .number(Date().timeIntervalSince1970)]) }
        register("host.shutdown") { [unowned self] _, context in
            // Build replacement and updates come from lima-host itself; agents can't stop the runtime.
            guard context.origin == .browser, context.workspaceID == nil else {
                throw BridgeError(.notAuthorized, "Only Lima can stop its runtime.")
            }
            let activeChats = await self.conversations.list()
            let shells = await self.terminals.list()
            guard !activeChats.contains(where: \.running),
                  !shells.contains(where: { $0.state == .running || $0.userEditing == true }) else {
                throw BridgeError(.badRequest, "A Lima agent or terminal is still active. Finish the work before replacing the runtime.")
            }
            await self.terminals.closeAll()
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
            return .bool(true)
        }
        register("agents.discover") { [unowned self] _, _ in try JSONValue.from(await self.discovery.discoverAll()) }
        register("agents.models") { params, _ in
            let provider = CLIProvider(rawValue: try params.string("provider")) ?? .claude
            return try JSONValue.from(ModelCatalog.models(for: provider))
        }
        register("auth.evaluate") { params, context in
            let operation = try params.decode("operation", as: ActionOperation.self)
            let roots = (params?["projectRoots"]?.arrayValue ?? []).compactMap(\.stringValue).map { URL(fileURLWithPath: $0) }
            return try JSONValue.from(await AuthorizationBroker(projectRoots: roots).evaluate(operation))
        }
        register("storage.status") { [unowned self] _, _ in
            .object([
                "encrypted": .bool(true),
                "location": .string(self.paths.data.path),
                "notes": .number(Double(try await self.store.count(collection: NotesService.collection))),
                "conversations": .number(Double(try await self.store.count(collection: ConversationService.collection))),
                "events": .number(Double(try await self.store.count(collection: ContextService.eventsCollection))),
                "legacyNotesMigration": (try await self.store.meta(LegacyNotesMigration.metaKey)).map(JSONValue.string) ?? .null,
                "legacyPlaintext": .array(LegacyAudit.plaintextFiles().map(JSONValue.string))
            ])
        }
        register("storage.exportRecoveryKey") { [unowned self] params, _ in
            let passphrase = try params.string("passphrase")
            let destination = params.optionalString("path")
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/Lima Recovery Key.limakey").path
            let key = try (ProcessInfo.processInfo.environment["LIMA_KEY_FILE"].map { FileKeyProvider(url: URL(fileURLWithPath: $0)) as KeyProvider } ?? KeychainKeyProvider()).loadOrCreateKey()
            let envelope = try RecoveryKey.wrap(key, passphrase: passphrase)
            try JSONEncoder().encode(envelope).write(to: URL(fileURLWithPath: destination), options: [.atomic, .withoutOverwriting])
            _ = self
            return .object(["path": .string(destination)])
        }
    }

    // MARK: Terminal

    /// Explicit user approvals for exact operations (the Lima terminal is gone;
    /// agents run commands with their own tools).
    func registerTerminal() {
        register("auth.approve") { params, context in
            // The browser UI records an explicit user approval for one exact operation.
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "approvals come from the user interface") }
            let operation = try params.decode("operation", as: ActionOperation.self)
            return .object(["digest": .string(try ApprovalLedger.shared.approve(operation))])
        }
    }

    // MARK: Chat

    static func terminalCommandResult(_ result: (timedOut: Bool, exitStatus: Int?, output: Data)) -> JSONValue {
        .object([
            "timedOut": .bool(result.timedOut),
            "exitStatus": result.exitStatus.map { .number(Double($0)) } ?? .null,
            "output": .string(String(decoding: result.output.suffix(64 * 1024), as: UTF8.self))
        ])
    }

    /// `mode: "interrupt"` stops a reply in progress; anything else queues.
    static func sendMode(_ params: JSONValue?) -> ConversationService.SendMode {
        params.optionalString("mode").flatMap(ConversationService.SendMode.init(rawValue:)) ?? .queue
    }

    static let attachmentLimit = 50 * 1024 * 1024

    func receiveAttachment(_ params: JSONValue?) async throws -> JSONValue {
        let id = try params.string("id")
        guard let chunk = Data(base64Encoded: try params.string("data")), chunk.count <= 2 * 1024 * 1024 else {
            throw BridgeError(.badRequest, "Send attachments in base64 chunks of up to 2 MB.")
        }
        let folder = try await conversations.attachmentDirectory(id)
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // A partial upload lives under a random token until it's complete.
        let token = params.optionalString("upload") ?? UUID().uuidString
        guard token.range(of: #"^[0-9A-F-]{36}$"#, options: .regularExpression) != nil else { throw BridgeError(.badRequest, "Unknown upload.") }
        let partial = folder.appendingPathComponent(".\(token).part")
        if params.optionalString("upload") == nil {
            guard fm.createFile(atPath: partial.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw BridgeError(.internalError, "Lima couldn't save the attachment.")
            }
        }
        guard let handle = try? FileHandle(forWritingTo: partial) else { throw BridgeError(.badRequest, "That upload expired. Attach the file again.") }
        defer { try? handle.close() }
        let size = Int(try handle.seekToEnd())
        guard size + chunk.count <= Self.attachmentLimit else {
            try? fm.removeItem(at: partial)
            throw BridgeError(.badRequest, "Attachments can be up to 50 MB.")
        }
        try handle.write(contentsOf: chunk)
        guard params?["done"]?.boolValue == true else { return .object(["upload": .string(token)]) }
        // Done: a safe, unique name the agent can read.
        let raw = (params.optionalString("name") ?? "attachment").components(separatedBy: CharacterSet(charactersIn: "/\\:\0\n\r")).joined(separator: "-")
        let name = String(raw.trimmingCharacters(in: CharacterSet(charactersIn: ". ")).prefix(120)).isEmpty ? "attachment" : String(raw.trimmingCharacters(in: CharacterSet(charactersIn: ". ")).prefix(120))
        var target = folder.appendingPathComponent(name)
        var counter = 2
        while fm.fileExists(atPath: target.path) {
            let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)")
            counter += 1
        }
        try fm.moveItem(at: partial, to: target)
        let type = String((params.optionalString("type") ?? "application/octet-stream").prefix(100))
        return try JSONValue.from(ChatAttachment(name: target.lastPathComponent, path: target.path, size: size + chunk.count, type: type))
    }

    /// Attachments named in a send: only files Lima saved for this conversation.
    func attachments(_ params: JSONValue?, conversationID: String) async throws -> [ChatAttachment] {
        let listed = params?["attachments"]?.arrayValue ?? []
        guard !listed.isEmpty else { return [] }
        let folder = try await conversations.attachmentDirectory(conversationID).resolvingSymlinksInPath().path + "/"
        return try listed.prefix(20).map { item in
            guard let path = item["path"]?.stringValue,
                  URL(fileURLWithPath: path).resolvingSymlinksInPath().path.hasPrefix(folder),
                  let attributes = try? FileManager.default.attributesOfItem(atPath: path) else {
                throw BridgeError(.badRequest, "An attachment is missing. Attach it again.")
            }
            return ChatAttachment(name: URL(fileURLWithPath: path).lastPathComponent, path: path,
                                  size: (attributes[.size] as? NSNumber)?.intValue ?? 0,
                                  type: String((item["type"]?.stringValue ?? "application/octet-stream").prefix(100)))
        }
    }

    func registerChat() {
        register("chat.list") { [unowned self] params, _ in
            // Companion threads stay in the Companion window: listed only when asked for.
            if params?["companion"]?.boolValue == true {
                return try JSONValue.from(await self.conversations.list().filter { $0.companion == true })
            }
            return try JSONValue.from(await self.visibleConversations())
        }
        register("chat.record") { [unowned self] params, context in
            try Self.requireLocalSettings(context)
            let id = try params.string("id")
            guard try await self.conversations.get(id).companion == true else { throw BridgeError(.badRequest, "Only Companion threads record messages.") }
            guard let role = ChatMessage.Role(rawValue: try params.string("role")) else { throw BridgeError(.badRequest, "Use role user or assistant.") }
            let tasks = (params?["taskIds"]?.arrayValue ?? []).compactMap(\.stringValue).prefix(8)
            return try JSONValue.from(try await self.conversations.record(id, role: role, text: params.optionalString("text") ?? "", taskIDs: Array(tasks)))
        }
        register("chat.get") { [unowned self] params, _ in try JSONValue.from(try await self.conversations.get(try params.string("id"))) }
        register("chat.mascot") { [unowned self] params, context in
            guard context.origin == .browser, let mascot = ChatMascot(rawValue: try params.string("mascot")) else {
                throw BridgeError(.badRequest, "Choose an available mascot.")
            }
            return try JSONValue.from(await self.conversations.setMascot(try params.string("id"), to: mascot))
        }
        register("chat.create") { [unowned self] params, _ in
            let provider = CLIProvider(rawValue: params.optionalString("provider") ?? "claude") ?? .claude
            return try JSONValue.from(try await self.conversations.create(provider: provider, model: params.optionalString("model"), workingDirectory: params.optionalString("cwd"),
                                                                          companion: params?["companion"]?.boolValue == true))
        }
        register("chat.configure") { [unowned self] params, _ in
            let provider = CLIProvider(rawValue: try params.string("provider")) ?? .claude
            let id = try params.string("id")
            if let workspaceID = try await self.conversations.get(id).workspaceID,
               try await self.workspaces.get(workspaceID).browserTestURL != nil, provider != .claude {
                throw BridgeError(.notAuthorized, "Browser-only helpers use Claude with built-in tools disabled.")
            }
            return try JSONValue.from(try await self.conversations.configure(id, provider: provider, model: params.optionalString("model")))
        }
        register("chat.send") { [unowned self] params, _ in
            let id = try params.string("id")
            Task { await self.usage.count("chat.sent") }
            if !(params?["attachments"]?.arrayValue ?? []).isEmpty { Task { await self.usage.count("chat.attachment") } }
            return try JSONValue.from(try await self.conversations.send(id, text: try params.string("text"), mode: Self.sendMode(params),
                                                                        attachments: try await self.attachments(params, conversationID: id)))
        }
        // Files dropped or pasted into a composer, uploaded in chunks of up
        // to 2 MB (base64) so each frame stays under the bridge limit.
        register("chat.attach") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only Lima's composer attaches files.") }
            return try await self.receiveAttachment(params)
        }
        register("chat.media") { [unowned self] params, _ in
            let media = try await self.conversations.media(try params.string("id"), id: try params.string("mediaId"))
            return .object(["type": .string(media.type), "data": .string(media.data.base64EncodedString())])
        }
        register("chat.interrupt") { [unowned self] params, _ in
            try JSONValue.from(try await self.conversations.interrupt(try params.string("id"), messageID: try params.string("messageId")))
        }
        register("chat.unqueue") { [unowned self] params, _ in
            try JSONValue.from(try await self.conversations.unqueue(try params.string("id"), messageID: try params.string("messageId")))
        }
        register("chat.retry") { [unowned self] params, _ in try JSONValue.from(try await self.conversations.retry(try params.string("id"), assistantMessageID: try params.string("messageId"))) }
        register("chat.edit") { [unowned self] params, _ in
            try JSONValue.from(try await self.conversations.edit(try params.string("id"), messageID: try params.string("messageId"), text: try params.string("text")))
        }
        register("chat.cancel") { [unowned self] params, _ in
            let id = try params.string("id")
            let unsent = await self.conversations.cancel(id)
            if let workspace = try await self.conversations.get(id).workspaceID {
                await self.workspacePrompts.clear(self, workspace: workspace)
            }
            // Queued messages that never ran, for the composer to restore.
            return .object(["unsent": .array(unsent.map(JSONValue.string))])
        }
        register("chat.delete") { [unowned self] params, _ in
            let id = try params.string("id")
            try await self.conversations.delete(id)
            self.search.index.remove(source: "conversation", id: id)
            return .null
        }
        register("quickAsk") { [unowned self] params, _ in
            Task { await self.usage.count("search.quickAsk") }
            let requestID = try params.string("requestId")
            let provider = CLIProvider(rawValue: params.optionalString("provider") ?? "claude") ?? .claude
            let started = Date()
            let result = await self.conversations.quickAsk(provider: provider, model: params.optionalString("model"), prompt: try params.string("prompt")) { [weak self] chunk in
                self?.broadcast("quickAsk.delta", .object(["requestId": .string(requestID), "text": .string(chunk)]))
            }
            let elapsed = Date().timeIntervalSince(started) * 1000
            switch result {
            case .success(let text): return .object(["text": .string(text), "elapsedMs": .number(elapsed)])
            case .failure(let failure): return .object(["error": try JSONValue.from(failure), "elapsedMs": .number(elapsed)])
            }
        }
    }

    // MARK: Notes

    func registerNotes() {
        register("notes.list") { [unowned self] _, _ in try JSONValue.from(await self.notes.list()) }
        // Embeds in Notes show a natively fetched preview; most sites refuse to be framed.
        register("notes.linkPreview") { params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Link previews are for the Lima interface.") }
            return try await LinkPreviews.shared.preview(try params.string("url"))
        }
        register("notes.get") { [unowned self] params, _ in try JSONValue.from(try await self.notes.get(try params.string("id"))) }
        register("notes.create") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            let kind = Note.Kind(rawValue: params.optionalString("kind") ?? "classic") ?? .classic
            let note = try await self.notes.create(title: params.optionalString("title") ?? "", kind: kind, markdown: params.optionalString("markdown") ?? "")
            self.recordActivity(ActivityEvent(kind: .note, title: note.title, detail: "created"))
            return try JSONValue.from(note)
        }
        register("notes.trash") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            try await self.notes.trash(try params.string("id")); return .null
        }
        register("notes.restore") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            return try JSONValue.from(try await self.notes.restore(try params.string("id")))
        }
        register("notes.purge") { [unowned self] params, context in
            // Permanent deletion only from the user interface, only from trash.
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can permanently delete notes") }
            let id = try params.string("id")
            guard try await self.notes.get(id).trashedAt != nil else { throw BridgeError(.badRequest, "move the note to trash first") }
            try await self.notes.delete(id); return .null
        }
        register("notes.apply") { [unowned self] params, context in
            try await self.requireNotesWrite(context)
            let edits = try params.decode("edits", as: [NoteEdit].self)
            let author = EditAuthor(label: params.optionalString("author") ?? (context.origin == .browser ? "user" : "agent:\(context.origin.rawValue)"))
            let base = params?["baseRevision"]?.intValue
            do {
                let note = try await self.notes.apply(edits, to: try params.string("id"), author: author, baseRevision: base)
                self.recordActivity(ActivityEvent(kind: .note, title: note.title, detail: "edited"))
                return try JSONValue.from(note)
            } catch let error as NoteEditError {
                throw BridgeError(.badRequest, error.description)
            }
        }
        register("notes.undo") { [unowned self] params, _ in
            do { return try JSONValue.from(try await self.notes.undo(try params.string("id"), author: EditAuthor(label: params.optionalString("author") ?? "user"))) }
            catch let error as NoteEditError { throw BridgeError(.badRequest, error.description) }
        }
        register("notes.redo") { [unowned self] params, _ in
            do { return try JSONValue.from(try await self.notes.redo(try params.string("id"), author: EditAuthor(label: params.optionalString("author") ?? "user"))) }
            catch let error as NoteEditError { throw BridgeError(.badRequest, error.description) }
        }
        register("notes.cleanupLayout") { [unowned self] params, _ in
            try JSONValue.from(CanvasTools.cleanupLayout(try await self.notes.get(try params.string("id"))))
        }
        register("notes.generateDiagram") { [unowned self] params, _ in
            try JSONValue.from(CanvasTools.generateDiagram(try params.string("spec"), below: try await self.notes.get(try params.string("id"))))
        }
        register("notes.migrateLegacy") { [unowned self] _, _ in
            try JSONValue.from(try await LegacyNotesMigration.run(notes: self.notes, store: self.store))
        }
        register("notes.attachment.put") { [unowned self] params, _ in
            guard let data = Data(base64Encoded: try params.string("data")) else { throw BridgeError(.badRequest, "data must be base64") }
            let id = UUID().uuidString
            try await self.store.putAttachment(data, id: id)
            return .object(["id": .string(id)])
        }
        register("notes.attachment.get") { [unowned self] params, _ in
            guard let data = try await self.store.attachment(id: try params.string("id")) else { throw BridgeError(.badRequest, "attachment not found") }
            return .object(["data": .string(data.base64EncodedString())])
        }
    }

    /// MCP clients changing notes need the notes-write grant, or the user's
    /// approval in Lima at the time.
    func requireNotesWrite(_ context: CallContext) async throws {
        try await requireMCPScope("notes:write", context: context, action: "change your notes")
    }

    // MARK: Search & tools

    func registerSearch() {
        register("search.query") { [unowned self] params, _ in
            let mode = params.optionalString("mode").flatMap(SearchIntent.Mode.init(rawValue:))
            var response = await self.search.search(try params.string("query"), mode: mode, limit: params.int("limit", default: 30))
            if let instant = InstantAnswers.answer(for: response.intent.query) {
                response.results.insert(instant, at: 0)
            }
            return try JSONValue.from(response)
        }
        register("search.select") { [unowned self] params, _ in
            let selections = await self.search.recordSelection(try params.string("key"))
            try await self.store.put(selections, collection: "settings", id: "search.selections")
            return .null
        }
        register("search.resetLearning") { [unowned self] _, _ in
            await self.search.resetLearning()
            try await self.store.delete(collection: "settings", id: "search.selections")
            return .null
        }
        register("search.indexTabs") { [unowned self] params, _ in
            // Open tabs from the browser (never private windows).
            let tabs = params?["tabs"]?.arrayValue ?? []
            self.search.index.removeAll(source: "tab")
            for (offset, tab) in tabs.enumerated() {
                guard let title = tab["title"]?.stringValue, let url = tab["url"]?.stringValue else { continue }
                self.search.index.upsert(SearchDocument(source: "tab", id: "\(offset):\(url)", title: title.isEmpty ? url : title, body: url,
                                                        subtitle: "Open tab · \(URL(string: url)?.host ?? url)",
                                                        timestamp: Date().timeIntervalSince1970 * 1000,
                                                        action: SearchAction("switchTab", ["url": url, "index": tab["index"]?.intValue.map(String.init) ?? ""])))
            }
            return .number(Double(tabs.count))
        }
        register("search.rebuild") { [unowned self] params, _ in
            if let source = params.optionalString("source") { self.search.index.removeAll(source: source) }
            if params.optionalString("source") == "app" || params.optionalString("source") == nil {
                for app in AppCatalog.scan() { self.search.index.upsert(app) }
            }
            return .number(Double(self.search.index.count))
        }
        // Unified capabilities: the only way any surface runs a Lima function.
        register("capabilities.list") { [unowned self] _, context in
            let all = self.capabilities.definitions.sorted { $0.rank < $1.rank }
            // External agents only see what they could run.
            return try JSONValue.from(context.origin == .mcp ? all.filter { $0.mcpScope != nil } : all)
        }
        register("capabilities.run") { [unowned self] params, context in
            Task { await self.usage.count("capability.ran") }
            return try await self.capabilities.run(try params.string("id"), input: params.optionalString("input") ?? "", runtime: self,
                                            context: context, approvalDigest: params.optionalString("approvalDigest"),
                                            executionID: params.optionalString("executionId"))
        }
        register("capabilities.execution") { [unowned self] params, context in
            await self.capabilities.execution(try params.string("executionId"), origin: context.origin) ?? .null
        }
        register("capabilities.runs") { [unowned self] params, _ in
            try JSONValue.from(self.capabilities.recentRuns(limit: params.int("limit", default: 100)))
        }
        register("system.openApp") { params, _ in
            let path = try params.string("path")
            guard path.hasSuffix(".app"), FileManager.default.fileExists(atPath: path) else { throw BridgeError(.badRequest, "not an application") }
            let configuration = NSWorkspace.OpenConfiguration()
            try await NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: configuration)
            return .null
        }
    }

    // MARK: Context

    func registerContext() {
        register("context.recent") { [unowned self] params, _ in
            try JSONValue.from(await self.context.recent(limit: params.int("limit", default: 200)))
        }
        register("context.record") { [unowned self] params, context in
            // Browser navigation metadata from non-private windows.
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the browser records navigation") }
            var event = ActivityEvent(kind: .browser, title: try params.string("title"), detail: try params.string("url"))
            event.metadata["host"] = URL(string: event.detail)?.host
            self.recordActivity(event)
            return .null
        }
        register("context.settings.get") { [unowned self] _, _ in try JSONValue.from(await self.context.settings) }
        register("context.settings.set") { [unowned self] params, _ in
            try await self.context.updateSettings(try params.decode("settings", as: ContextSettings.self))
            return try JSONValue.from(await self.context.settings)
        }
        register("context.deleteAll") { [unowned self] _, _ in
            let count = try await self.context.deleteAllActivity()
            self.search.index.removeAll(source: "context")
            self.search.index.removeAll(source: "terminal")
            return .number(Double(count))
        }
        register("context.reports") { [unowned self] _, _ in try JSONValue.from(try await self.context.reports()) }
        register("context.generateReport") { [unowned self] _, _ in
            let report = try await self.context.generateReportNow()
            self.search.index.upsert(Self.document(for: report))
            return try JSONValue.from(report)
        }
    }

    // MARK: System

    func registerSystem() {
        register("agents.configured") { [unowned self] _, context in
            try Self.requireLocalSettings(context)
            return try JSONValue.from(await self.discovery.configuredProviders())
        }
        register("background.status") { _, _ in try JSONValue.from(BackgroundAgent.status()) }
        register("background.install") { _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "installing the background agent requires the user") }
            // Always this lima-host: launchd runs whatever path is written here at every login.
            return try JSONValue.from(try BackgroundAgent.install(executable: CodeTrust.selfExecutable))
        }
        register("background.uninstall") { _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "requires the user") }
            try BackgroundAgent.uninstall()
            return .null
        }
        register("integrations.messages.compose") { params, context in
            try Self.requireLocalSettings(context)
            let recipient = (params.optionalString("recipient") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let message = try params.string("message")
            guard recipient.count <= 160, (1...5000).contains(message.count),
                  !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw BridgeError(.badRequest, "Enter a message and an optional phone number or email address.")
            }
            try await MainActor.run {
                guard let service = NSSharingService(named: .composeMessage), service.canPerform(withItems: [message]) else {
                    throw BridgeError(.badRequest, "Messages is unavailable. Check Messages on this Mac.")
                }
                if !recipient.isEmpty { service.recipients = [recipient] }
                service.perform(withItems: [message])
            }
            return .null
        }
        register("integrations.status") { _, _ in try JSONValue.from(await Integrations.status()) }
        register("integrations.github.summary") { _, _ in try await Integrations.githubSummary() }
        register("mcp.grants.get") { _, _ in try JSONValue.from(MCPGrants.shared.scopes) }
        register("mcp.grants.set") { [unowned self] params, context in
            // Non-browser callers reach this only after the user approved it (SecurityPolicy).
            let scopes = (params?["scopes"]?.arrayValue ?? []).compactMap(\.stringValue)
            MCPGrants.shared.scopes = Set(scopes)
            try await self.store.put(scopes, collection: "settings", id: "mcp.grants")
            return .null
        }
        registerMedia()
    }
}

/// Splits a command line into words for classification (quotes and
/// backslashes; not a full shell parser — unknown shapes stay "declared").
enum ShellWords {
    static func split(_ line: String) -> [String] {
        var words: [String] = [], current = "", quote: Character?, escaped = false
        for char in line {
            if escaped { current.append(char); escaped = false; continue }
            if char == "\\" && quote != "'" { escaped = true; continue }
            if let q = quote { if char == q { quote = nil } else { current.append(char) }; continue }
            if char == "'" || char == "\"" { quote = char; continue }
            if char == " " || char == "\t" { if !current.isEmpty { words.append(current); current = "" }; continue }
            if char == ";" || char == "|" || char == "&" { if !current.isEmpty { words.append(current); current = "" }; break }
            current.append(char)
        }
        if !current.isEmpty { words.append(current) }
        return words
    }
}

/// Single-use approvals recorded by the user interface for exact operations.
final class ApprovalLedger: @unchecked Sendable {
    static let shared = ApprovalLedger()
    private let lock = NSLock()
    private var approved: [String: Date] = [:]

    func digest(_ operation: ActionOperation) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var normalized = operation
        normalized.origin = .chat // approval binds to what runs, not who asked
        return try encoder.encode(normalized).base64EncodedString()
    }

    func approve(_ operation: ActionOperation) throws -> String {
        let key = try digest(operation)
        lock.lock(); approved[key] = Date().addingTimeInterval(120); lock.unlock()
        return key
    }

    func consume(_ operation: ActionOperation) -> Bool {
        guard let key = try? digest(operation) else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let expiry = approved.removeValue(forKey: key) else { return false }
        return expiry > Date()
    }
}

final class MCPGrants: @unchecked Sendable {
    static let shared = MCPGrants()
    private let lock = NSLock()
    private var _scopes: Set<String> = ["notes:read", "search:read", "context:read"]
    var scopes: Set<String> {
        get { lock.lock(); defer { lock.unlock() }; return _scopes }
        set { lock.lock(); _scopes = newValue; lock.unlock() }
    }
    func allows(scope: String) -> Bool { scopes.contains(scope) }
    func grant(_ scope: String) { lock.lock(); _scopes.insert(scope); lock.unlock() }
}

enum LegacyAudit {
    /// Lima 4.x files that still hold plaintext personal data.
    static func plaintextFiles() -> [String] {
        let base = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Lima")
        return ["notes.json", "context-shelf.json", "dictation-conversations.json", "terminal-sessions.json", "AI"]
            .map { base.appendingPathComponent($0).path }
            .filter { FileManager.default.fileExists(atPath: $0) }
    }
}

enum RuntimeBuild {
    /// Identifies the executable build so a browser relay can replace a
    /// daemon left running from an older build.
    static let id: String = {
        let path = CommandLine.arguments[0]
        let attributes = try? FileManager.default.attributesOfItem(atPath: (path as NSString).resolvingSymlinksInPath)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return "\(size)-\(Int(modified))"
    }()
}
