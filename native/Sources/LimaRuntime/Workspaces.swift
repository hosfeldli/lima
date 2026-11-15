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
        let host = (CommandLine.arguments[0] as NSString).resolvingSymlinksInPath
        var env: [String: String] = ["LIMA_WORKSPACE_TOKEN": workspace.token]
        for key in ["LIMA_DATA_DIR", "LIMA_KEY_FILE"] { if let value = ProcessInfo.processInfo.environment[key] { env[key] = value } }
        let preamble = """
        You are the agent for the Lima workspace “\(workspace.name)”. Your working directory is \(workspace.directory).
        Work visibly through the `lima` MCP tools: open web pages as tabs in this workspace (workspace_open_tab), \
        file useful links as bookmarks (workspace_bookmark, use folder paths like "Research/Docs"), and run shell commands \
        in the workspace terminal the user can watch (workspace_run). Create another workspace only if the user asks (workspace_new).
        """
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
            if let terminal = workspace.terminalID { try? await self.terminals.close(terminal) }
            try await self.workspaces.remove(workspace.id)
            self.broadcast("workspace.deleted", .object(["id": .string(workspace.id)]))
            return .object(["directoryKept": .string(workspace.directory)])
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
            let workspace = try await self.workspaces.get(try target(params, context))
            guard let terminalID = workspace.terminalID, (try? await self.terminals.info(terminalID))?.state != .exited else {
                throw BridgeError(.badRequest, "the workspace terminal has ended; ask the user to reopen the workspace")
            }
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
            let url = URL(fileURLWithPath: workspace.directory)
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

    func createWorkspace(name: String, directory: String?, provider: CLIProvider, parentID: String?, task: String?) async throws -> Workspace {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Workspace" : String(name.prefix(60))
        let folder: URL
        do { folder = try WorkspaceService.resolveDirectory(name: cleanName, requested: directory) }
        catch let error as WorkspaceError { throw BridgeError(.badRequest, error.description) }

        var tokenBytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &tokenBytes)
        var workspace = Workspace(
            id: UUID().uuidString, name: cleanName, directory: folder.path, hue: Int.random(in: 0..<360), provider: provider,
            terminalID: nil, conversationID: nil, tabs: [], bookmarks: [], createdAt: Date().timeIntervalSince1970 * 1000,
            parentID: parentID, token: tokenBytes.map { String(format: "%02x", $0) }.joined()
        )

        // Terminal in the workspace directory, keyboard leased to the agent.
        // Creating the workspace is the user's handoff; typing takes it back.
        let terminal = try await terminals.create(cwd: folder.path)
        workspace.terminalID = terminal.id
        try await terminals.requestLease(terminal.id, agentID: workspace.agentID)
        _ = try await terminals.grantLease(terminal.id, agentID: workspace.agentID)

        let conversation = try await conversations.create(provider: provider, model: nil, workingDirectory: folder.path, workspaceID: workspace.id,
                                                          title: "✦ \(cleanName)")
        workspace.conversationID = conversation.id
        try await workspaces.save(workspace)
        broadcast("workspace.created", workspace.publicView)
        recordActivity(.init(kind: .agent, title: "Workspace “\(cleanName)” created", detail: folder.path, project: folder.path,
                             metadata: ["workspace": workspace.id]))
        if let task, !task.isEmpty { _ = try await conversations.send(conversation.id, text: task) }
        return workspace
    }
}
