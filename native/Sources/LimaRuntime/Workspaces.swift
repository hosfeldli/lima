import Foundation
import LimaAgentSupervisor
import LimaAuthorization
import LimaProtocol
import LimaStorage
import LimaTerminal

/// An AI workspace: a self-contained unit an agent works in.
///
/// - a directory on disk (where its terminal and agent operate)
/// - a terminal session bound to that directory, keyboard-leased to the agent
/// - an AI conversation bound to that directory, with Lima's MCP tools
/// - desired tabs and bookmarks, which the browser reconciles into a Zen
///   tab folder and a bookmark folder so the work is visible
///
/// Agents authenticate with a per-workspace token and can act only on their
/// own workspace (plus create new workspaces on request).
public struct Workspace: Codable, Sendable, Equatable {
    public struct Tab: Codable, Sendable, Equatable { public var url: String; public var title: String }
    public struct Bookmark: Codable, Sendable, Equatable { public var url: String; public var title: String; public var folder: String }

    public var id: String
    public var name: String
    public var directory: String
    public var hue: Int
    public var provider: CLIProvider
    public var terminalID: String?
    public var conversationID: String?
    public var tabs: [Tab]
    public var bookmarks: [Bookmark]
    public var createdAt: Double
    public var parentID: String?
    /// A helper agent spawned by another workspace's agent: shares its
    /// parent's directory, gets a terminal only when it first needs one, and
    /// is dismissed when done (its conversation is kept).
    public var temporary: Bool?
    /// The task it was spawned for.
    public var task: String?
    /// Secret for the workspace's MCP server; never sent to the browser.
    var token: String

    public var agentID: String { "workspace-\(id.prefix(8))" }

    /// Browser-safe view (no token).
    var publicView: JSONValue {
        var copy = self
        copy.token = ""
        return (try? JSONValue.from(copy)) ?? .null
    }
}

public enum WorkspaceError: Error, CustomStringConvertible {
    case notFound(String)
    case outsideWorkspace
    case invalidDirectory(String)

    public var description: String {
        switch self {
        case .notFound(let id): "workspace \(id) not found"
        case .outsideWorkspace: "this agent can only act on its own workspace"
        case .invalidDirectory(let reason): reason
        }
    }
}

public actor WorkspaceService {
    public static let collection = "workspaces"
    static var root: URL {
        ProcessInfo.processInfo.environment["LIMA_WORKSPACES_ROOT"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Lima Workspaces")
    }

    private let store: EncryptedStore
    private var workspaces: [String: Workspace] = [:]

    init(store: EncryptedStore) async throws {
        self.store = store
        for workspace in try await store.all(Workspace.self, collection: Self.collection) { workspaces[workspace.id] = workspace }
    }

    func list() -> [Workspace] { workspaces.values.sorted { $0.createdAt > $1.createdAt } }

    func get(_ id: String) throws -> Workspace {
        guard let workspace = workspaces[id] else { throw WorkspaceError.notFound(id) }
        return workspace
    }

    func id(forToken token: String) -> String? {
        guard !token.isEmpty else { return nil }
        return workspaces.values.first { $0.token == token }?.id
    }

    func save(_ workspace: Workspace) async throws {
        workspaces[workspace.id] = workspace
        try await store.put(workspace, collection: Self.collection, id: workspace.id)
    }

    func remove(_ id: String) async throws {
        workspaces[id] = nil
        try await store.delete(collection: Self.collection, id: id)
    }

    /// Resolves a directory: an explicit existing folder inside the home
    /// directory, or a new folder under ~/Lima Workspaces. Never initializes
    /// Git (spec §4.5: only for projects the user designates).
    static func resolveDirectory(name: String, requested: String?) throws -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.resolvingSymlinksInPath()
        if let requested, !requested.isEmpty {
            let expanded = (requested as NSString).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded).standardizedFileURL.resolvingSymlinksInPath()
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
                throw WorkspaceError.invalidDirectory("\(url.path) is not an existing folder")
            }
            guard url.path.hasPrefix(home.path + "/"), url.path != home.path,
                  !["Library", ".ssh", ".gnupg"].contains(url.path.dropFirst(home.path.count + 1).split(separator: "/").first.map(String.init) ?? "") else {
                throw WorkspaceError.invalidDirectory("Workspaces must be a folder inside your home directory (not Library or credential folders)")
            }
            return url
        }
        let slug = name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }.reduce(into: "") { result, c in
            if !(c == "-" && result.last == "-") { result.append(c) }
        }.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        var url = root.appendingPathComponent(slug.isEmpty ? "workspace" : slug)
        var suffix = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = root.appendingPathComponent("\(slug.isEmpty ? "workspace" : slug)-\(suffix)")
            suffix += 1
        }
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}

extension Runtime {
    /// MCP configuration that gives a workspace's agent Lima's tools, bound
    /// to that workspace by token.
    func workspaceAgentConfiguration(_ conversation: Conversation) async -> (arguments: [String], environment: [String: String], preamble: String?) {
        guard let workspaceID = conversation.workspaceID, let workspace = try? await workspaces.get(workspaceID) else { return ([], [:], nil) }
        // Absolute path: the agent's CLI runs in the workspace directory, so a
        // relative argv[0] would not resolve there.
        let host = Bundle.main.executableURL?.resolvingSymlinksInPath().path
            ?? URL(fileURLWithPath: CommandLine.arguments[0], relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardizedFileURL.path
        var env: [String: String] = ["LIMA_WORKSPACE_TOKEN": workspace.token]
        for key in ["LIMA_DATA_DIR", "LIMA_KEY_FILE"] { if let value = ProcessInfo.processInfo.environment[key] { env[key] = value } }
        let tools = """
        Work visibly through the `lima` MCP tools, which the user watches in Lima's sidebar: open web pages as tabs \
        (workspace_open_tab), see and read the pages in your Tabs folder (workspace_list_tabs, workspace_read_tab), run shell \
        commands in your terminal (workspace_run), file links (workspace_bookmark, folder paths like "Research/Docs") and \
        write summaries or findings as notes (workspace_note).
        """
        let preamble: String
        if workspace.temporary == true {
            preamble = """
            You are “\(workspace.name)”, a helper agent in Lima, spawned for this task: \(workspace.task ?? "see the first message").
            Your working directory is \(workspace.directory), shared with the agent that spawned you; don't undo its work. \(tools)
            Finish with a short report of what you did and found.
            """
        } else {
            preamble = """
            You are the agent for the Lima workspace “\(workspace.name)”. Your working directory is \(workspace.directory). \(tools)
            For parallel subtasks, spawn helper agents (agent_spawn) and check on them (agents_status); each gets its own chat, \
            tabs and terminal in this workspace. Create a separate workspace only if the user asks (workspace_new).
            """
        }
        switch conversation.provider {
        case .claude:
            let config: [String: Any] = ["mcpServers": ["lima": ["command": host, "args": ["mcp"], "env": env]]]
            let json = String(decoding: (try? JSONSerialization.data(withJSONObject: config)) ?? Data(), as: UTF8.self)
            // Edits are confined to the workspace directory (acceptEdits applies to the cwd).
            return (["--mcp-config", json, "--allowedTools", "mcp__lima", "--permission-mode", "acceptEdits", "--append-system-prompt", preamble], [:], nil)
        case .codex:
            let envToml = env.map { "\($0.key)=\"\($0.value)\"" }.joined(separator: ",")
            return (["-c", "sandbox_mode=\"workspace-write\"", "-c", "mcp_servers.lima.command=\"\(host)\"", "-c", "mcp_servers.lima.args=[\"mcp\"]",
                     "-c", "mcp_servers.lima.env={\(envToml)}"], [:], preamble)
        case .opencode:
            return ([], [:], preamble)
        }
    }

    func registerWorkspaces() {
        /// For workspace-bound agents, the workspace is implied and enforced.
        @Sendable func target(_ params: JSONValue?, _ context: CallContext) throws -> String {
            if let bound = context.workspaceID {
                if let requested = params.optionalString("id"), requested != bound { throw BridgeError(.notAuthorized, WorkspaceError.outsideWorkspace.description) }
                return bound
            }
            guard context.origin == .browser || context.origin == .chat else { throw BridgeError(.notAuthorized, "workspace actions need the user or the workspace's agent") }
            return try params.string("id")
        }
        @Sendable func changed(_ workspace: Workspace) {
            broadcast("workspace.updated", workspace.publicView)
        }

        register("workspace.list") { [unowned self] _, context in
            let all = await self.workspaces.list()
            return .array((context.workspaceID.map { id in all.filter { $0.id == id || $0.parentID == id } } ?? all).map(\.publicView))
        }
        register("workspace.get") { [unowned self] params, context in
            try await self.workspaces.get(try target(params, context)).publicView
        }
        /// Opening a workspace heals its terminal if the runtime restarted.
        register("workspace.ensureTerminal") { [unowned self] params, context in
            try await self.ensureTerminal(try await self.workspaces.get(try target(params, context))).publicView
        }
        register("workspace.create") { [unowned self] params, context in
            guard context.origin == .browser || context.workspaceID != nil || MCPGrants.shared.allows(scope: "workspaces:create") else {
                throw BridgeError(.confirmationRequired, "Allow workspaces:create for MCP clients in Lima → Integrations first")
            }
            let workspace = try await self.createWorkspace(name: params.optionalString("name") ?? "Workspace", directory: params.optionalString("directory"),
                                                           provider: CLIProvider(rawValue: params.optionalString("provider") ?? "claude") ?? .claude,
                                                           parentID: context.workspaceID, task: params.optionalString("task"))
            return workspace.publicView
        }
        register("workspace.delete") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user can remove a workspace") }
            let workspace = try await self.workspaces.get(try params.string("id"))
            // Helper agents go with their workspace.
            for child in await self.workspaces.list() where child.parentID == workspace.id { try await self.removeWorkspace(child) }
            try await self.removeWorkspace(workspace)
            return .object(["directoryKept": .string(workspace.directory)])
        }
        register("workspace.rename") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the user renames workspaces") }
            var workspace = try await self.workspaces.get(try params.string("id"))
            let name = try params.string("name").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name != workspace.name else { return workspace.publicView }
            workspace.name = String(name.prefix(60))
            try await self.workspaces.save(workspace)
            if let conversation = workspace.conversationID { _ = try? await self.conversations.rename(conversation, title: workspace.temporary == true ? workspace.name : "✦ \(workspace.name)") }
            changed(workspace)
            return workspace.publicView
        }
        register("agent.spawn") { [unowned self] params, context in
            let parent = try await self.workspaces.get(try target(params, context))
            let agent = try await self.spawnAgent(parent: parent, name: try params.string("name"), task: try params.string("task"),
                                                  provider: params.optionalString("provider").flatMap(CLIProvider.init(rawValue:)))
            return agent.publicView
        }
        register("agents.status") { [unowned self] params, context in
            let parent = try await self.workspaces.get(try target(params, context))
            var rows: [JSONValue] = []
            for agent in await self.workspaces.list() where agent.parentID == parent.id {
                let conversation = try? await self.conversations.get(agent.conversationID ?? "")
                let reply = conversation?.messages.last { $0.role == .assistant }
                let focus = self.focus.state(agent.id)
                rows.append(.object([
                    "id": .string(agent.id), "name": .string(agent.name), "task": .string(agent.task ?? ""),
                    "state": .string(reply?.status == .streaming ? "working" : reply?.status == .failed ? "failed" : reply == nil ? "starting" : "done"),
                    "now": .string(focus.surface == .tab ? "reading \(focus.url ?? "a tab")" : focus.surface.rawValue),
                    "lastReply": .string(String((reply?.text ?? "").suffix(1200))),
                    "recentTools": .array((reply?.tools ?? []).suffix(5).map(JSONValue.string)),
                    "tabs": .array(agent.tabs.map { .string($0.url) }),
                ]))
            }
            return .array(rows)
        }
        register("workspace.listTabs") { [unowned self] params, context in
            let workspace = try await self.workspaces.get(try target(params, context))
            return try await self.browserCalls.call(self, kind: "listTabs", workspaceID: workspace.id, payload: [:])
        }
        register("workspace.readTab") { [unowned self] params, context in
            let workspace = try await self.workspaces.get(try target(params, context))
            let url = try params.string("url")
            self.setFocus(workspace.id, .tab, url: url)
            return try await self.browserCalls.call(self, kind: "readTab", workspaceID: workspace.id, payload: ["url": .string(url)], timeout: 30)
        }
        register("workspace.note") { [unowned self] params, context in
            var workspace = try await self.workspaces.get(try target(params, context))
            let title = params.optionalString("title") ?? "Summary"
            let note = try await self.notes.create(title: title, kind: .classic, markdown: try params.string("markdown"))
            let url = "about:lima?note=\(note.id)"
            if !workspace.tabs.contains(where: { $0.url == url }) {
                workspace.tabs.append(.init(url: url, title: title))
                try await self.workspaces.save(workspace)
            }
            self.setFocus(workspace.id, .tab, url: url)
            changed(workspace)
            return .object(["note": .string(note.id), "title": .string(title)])
        }
        register("workspace.openTab") { [unowned self] params, context in
            var workspace = try await self.workspaces.get(try target(params, context))
            let url = try params.string("url")
            guard let scheme = URL(string: url)?.scheme, ["http", "https", "about"].contains(scheme), !url.hasPrefix("about:") || url.hasPrefix("about:lima") else {
                throw BridgeError(.badRequest, "only http(s) and Lima pages can be opened")
            }
            if !workspace.tabs.contains(where: { $0.url == url }) {
                workspace.tabs.append(.init(url: url, title: params.optionalString("title") ?? url))
                try await self.workspaces.save(workspace)
            }
            self.setFocus(workspace.id, .tab, url: url)
            changed(workspace)
            return .object(["opened": .string(url), "tabs": .number(Double(workspace.tabs.count))])
        }
        register("workspace.closeTab") { [unowned self] params, context in
            var workspace = try await self.workspaces.get(try target(params, context))
            let url = try params.string("url")
            workspace.tabs.removeAll { $0.url == url }
            try await self.workspaces.save(workspace)
            changed(workspace)
            return .null
        }
        register("workspace.bookmark") { [unowned self] params, context in
            var workspace = try await self.workspaces.get(try target(params, context))
            let url = try params.string("url")
            guard URL(string: url)?.scheme.map({ ["http", "https", "about"].contains($0) }) == true else { throw BridgeError(.badRequest, "invalid URL") }
            let folder = (params.optionalString("folder") ?? "").split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "/")
            workspace.bookmarks.removeAll { $0.url == url && $0.folder == folder }
            workspace.bookmarks.append(.init(url: url, title: params.optionalString("title") ?? url, folder: folder))
            try await self.workspaces.save(workspace)
            changed(workspace)
            return .object(["filed": .string(folder.isEmpty ? workspace.name : "\(workspace.name)/\(folder)")])
        }
        register("workspace.run") { [unowned self] params, context in
            let workspace = try await self.ensureTerminal(try await self.workspaces.get(try target(params, context)))
            self.setFocus(workspace.id, .terminal)
            let terminalID = workspace.terminalID!
            guard let handle = try await self.terminals.currentHandle(terminalID, agentID: workspace.agentID) else {
                try? await self.terminals.requestLease(terminalID, agentID: workspace.agentID)
                throw BridgeError(.confirmationRequired, "The user has the keyboard in this workspace's terminal. Ask them to hand control back (Allow in the terminal tab).")
            }
            var forwarded: [String: JSONValue] = ["id": .string(terminalID), "handle": try JSONValue.from(handle), "command": .string(try params.string("command")),
                                                  "timeout": .number(params.double("timeout", default: 120))]
            if let digest = params.optionalString("approvalDigest") { forwarded["approvalDigest"] = .string(digest) }
            let response = await self.handle(BridgeRequest(id: "ws", method: "terminal.agentRun", params: .object(forwarded)), context: context)
            if let error = response.error { throw error }
            return response.result ?? .null
        }
        register("workspace.files") { [unowned self] params, context in
            let workspace = try await self.workspaces.get(try target(params, context))
            let root = URL(fileURLWithPath: workspace.directory).standardizedFileURL
            let url = root.appendingPathComponent(params.optionalString("path") ?? "").standardizedFileURL
            guard url.path == root.path || url.path.hasPrefix(root.path + "/") else { throw BridgeError(.notAuthorized, WorkspaceError.outsideWorkspace.description) }
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            let entries = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
            return .array(entries.prefix(300).map { entry in
                let values = try? entry.resourceValues(forKeys: Set(keys))
                return .object(["name": .string(entry.lastPathComponent), "directory": .bool(values?.isDirectory ?? false),
                                "size": .number(Double(values?.fileSize ?? 0)),
                                "modified": .number((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)])
            }.sorted { ($0["directory"]?.boolValue == true ? 0 : 1, $0["name"]?.stringValue ?? "") < ($1["directory"]?.boolValue == true ? 0 : 1, $1["name"]?.stringValue ?? "") })
        }
        register("workspace.instruct") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "instructions come from the user") }
            let workspace = try await self.workspaces.get(try params.string("id"))
            guard let conversationID = workspace.conversationID else { throw BridgeError(.badRequest, "workspace has no agent") }
            return try JSONValue.from(try await self.conversations.send(conversationID, text: try params.string("text")))
        }
    }

    /// Terminals live in the runtime's memory; after a runtime restart (or if
    /// the shell exited) a workspace gets a fresh one in the same folder,
    /// keyboard-leased to its agent, and the browser shows the new tab.
    func ensureTerminal(_ workspace: Workspace) async throws -> Workspace {
        if let id = workspace.terminalID, let info = try? await terminals.info(id), info.state != .exited { return workspace }
        var updated = workspace
        let terminal = try await terminals.create(cwd: workspace.directory)
        try await terminals.requestLease(terminal.id, agentID: workspace.agentID)
        _ = try await terminals.grantLease(terminal.id, agentID: workspace.agentID)
        _ = try await terminals.waitForPrompt(terminal.id, timeout: 10)
        updated.terminalID = terminal.id
        try await workspaces.save(updated)
        broadcast("workspace.updated", updated.publicView)
        return updated
    }

    func removeWorkspace(_ workspace: Workspace) async throws {
        if let terminal = workspace.terminalID { try? await terminals.close(terminal) }
        try await workspaces.remove(workspace.id)
        broadcast("workspace.deleted", .object(["id": .string(workspace.id), "parentId": workspace.parentID.map(JSONValue.string) ?? .null]))
    }

    /// A temporary helper agent inside `parent`: same directory, own chat;
    /// its terminal is created the first time it runs a command.
    func spawnAgent(parent: Workspace, name: String, task: String, provider: CLIProvider?, startTask: Bool = true) async throws -> Workspace {
        guard parent.temporary != true else { throw BridgeError(.notAuthorized, "helper agents can't spawn more agents") }
        let siblings = await workspaces.list().filter { $0.parentID == parent.id }
        guard siblings.count < 8 else { throw BridgeError(.badRequest, "a workspace can run at most 8 helper agents; dismiss finished ones first") }
        return try await createWorkspace(name: name, directory: nil, provider: provider ?? parent.provider, parentID: parent.id, task: task,
                                         existingDirectory: URL(fileURLWithPath: parent.directory), temporary: true, startTask: startTask)
    }

    func createWorkspace(name: String, directory: String?, provider: CLIProvider, parentID: String?, task: String?,
                         existingDirectory: URL? = nil, temporary: Bool = false, startTask: Bool = true) async throws -> Workspace {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Workspace" : String(name.prefix(60))
        let folder: URL
        if let existingDirectory { folder = existingDirectory }
        else {
            do { folder = try WorkspaceService.resolveDirectory(name: cleanName, requested: directory) }
            catch let error as WorkspaceError { throw BridgeError(.badRequest, error.description) }
        }

        var tokenBytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &tokenBytes)
        var workspace = Workspace(
            id: UUID().uuidString, name: cleanName, directory: folder.path, hue: Int.random(in: 0..<360), provider: provider,
            terminalID: nil, conversationID: nil, tabs: [], bookmarks: [], createdAt: Date().timeIntervalSince1970 * 1000,
            parentID: parentID, temporary: temporary ? true : nil, task: task, token: tokenBytes.map { String(format: "%02x", $0) }.joined()
        )

        // Terminal in the workspace directory, keyboard leased to the agent.
        // Creating the workspace is the user's handoff; typing takes it back.
        // Helper agents get theirs on first use (ensureTerminal).
        if !temporary {
            let terminal = try await terminals.create(cwd: folder.path)
            workspace.terminalID = terminal.id
            try await terminals.requestLease(terminal.id, agentID: workspace.agentID)
            _ = try await terminals.grantLease(terminal.id, agentID: workspace.agentID)
        }

        let conversation = try await conversations.create(provider: provider, model: nil, workingDirectory: folder.path, workspaceID: workspace.id,
                                                          title: temporary ? cleanName : "✦ \(cleanName)")
        workspace.conversationID = conversation.id
        focus.bind(conversation: conversation.id, to: workspace.id)
        try await workspaces.save(workspace)
        broadcast("workspace.created", workspace.publicView)
        recordActivity(.init(kind: .agent, title: "Workspace “\(cleanName)” created", detail: folder.path, project: folder.path,
                             metadata: ["workspace": workspace.id]))
        if startTask, let task, !task.isEmpty { _ = try await conversations.send(conversation.id, text: task) }
        return workspace
    }
}
