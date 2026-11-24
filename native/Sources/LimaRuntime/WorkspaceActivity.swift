import Foundation
import LimaAgentSupervisor
import LimaProtocol

/// Where each workspace's agent is working right now, so the sidebar can put
/// the prism on that tab (docs/architecture/sidebar-workspaces.md).
///
/// - a tool call moves focus to its surface (`tab` + url, or `terminal`)
/// - streamed reply text moves it back to `chat`
/// - the end of a turn makes it `idle`
public final class WorkspaceFocus: @unchecked Sendable {
    public enum Surface: String, Codable, Sendable { case idle, chat, tab, terminal }
    public struct State: Codable, Sendable, Equatable {
        public var surface: Surface
        public var url: String?
    }

    private let lock = NSLock()
    private var states: [String: State] = [:]
    /// conversation → workspace, learned from conversation events.
    private var owners: [String: String] = [:]

    /// Returns the new state if it changed (so callers broadcast only changes).
    func set(_ workspaceID: String, _ surface: Surface, url: String? = nil, replacing expected: State? = nil) -> State? {
        lock.lock(); defer { lock.unlock() }
        if let expected, states[workspaceID] != expected { return nil }
        let next = State(surface: surface, url: surface == .tab ? url : nil)
        guard states[workspaceID] != next else { return nil }
        states[workspaceID] = next
        return next
    }

    public func state(_ workspaceID: String) -> State {
        lock.lock(); defer { lock.unlock() }
        return states[workspaceID] ?? State(surface: .idle)
    }

    func bind(conversation: String, to workspace: String) {
        lock.lock(); owners[conversation] = workspace; lock.unlock()
    }

    func workspace(for conversation: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return owners[conversation]
    }

    var all: [String: State] {
        lock.lock(); defer { lock.unlock() }
        return states
    }
}

/// Requests the runtime makes of the browser (list or read the tabs in a
/// workspace folder). The runtime broadcasts `workspace.browserRequest`; the
/// browser chrome answers with `workspace.browserReply`.
final class BrowserCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [String: CheckedContinuation<JSONValue, Error>] = [:]

    func call(_ runtime: Runtime, kind: String, workspaceID: String, payload: [String: JSONValue], timeout: Double = 20) async throws -> JSONValue {
        let requestID = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock(); pending[requestID] = continuation; lock.unlock()
            var data = payload
            data["requestId"] = .string(requestID)
            data["workspaceId"] = .string(workspaceID)
            data["kind"] = .string(kind)
            runtime.broadcast("workspace.browserRequest", .object(data))
            Task {
                try? await Task.sleep(for: .seconds(timeout))
                self.finish(requestID, .failure(BridgeError(.deadlineExceeded, "Lima Browser didn't answer (is a Lima window open?)")))
            }
        }
    }

    var pendingIDs: [String] { lock.lock(); defer { lock.unlock() }; return Array(pending.keys) }

    /// Resolves a pending request; later replies for the same ID are ignored.
    func finish(_ requestID: String, _ result: Result<JSONValue, Error>) {
        lock.lock(); let continuation = pending.removeValue(forKey: requestID); lock.unlock()
        continuation?.resume(with: result)
    }
}

extension Runtime {
    func setFocus(_ workspaceID: String, _ surface: WorkspaceFocus.Surface, url: String? = nil, replacing expected: WorkspaceFocus.State? = nil) {
        guard let state = focus.set(workspaceID, surface, url: url, replacing: expected) else { return }
        broadcast("workspace.activity", .object(["id": .string(workspaceID), "surface": .string(state.surface.rawValue),
                                                 "url": state.url.map(JSONValue.string) ?? .null]))
    }

    /// Conversation events drive chat/idle focus for workspace agents.
    func trackConversation(_ event: ConversationEvent) {
        switch event {
        case .updated(let conversation):
            guard let workspaceID = conversation.workspaceID else { return }
            focus.bind(conversation: conversation.id, to: workspaceID)
            // Provider failover moved the agent's chat; keep the workspace in step.
            if conversation.messages.last?.notice != nil {
                let provider = conversation.provider
                Task {
                    guard let workspace = try? await workspaces.get(workspaceID), workspace.provider != provider else { return }
                    _ = try? await workspaces.update(workspaceID) { workspace in workspace.provider = provider }
                }
            }
            let streaming = conversation.messages.last.map { $0.role == .assistant && $0.status == .streaming } ?? false
            if !streaming {
                let wasActive = focus.state(workspaceID).surface != .idle
                setFocus(workspaceID, .idle)
                if wasActive, let reply = conversation.messages.last, reply.role == .assistant, reply.status == .complete {
                    Task { await completeCompanionTask(workspaceID, summary: reply.text) }
                }
            }
            else if focus.state(workspaceID).surface == .idle { setFocus(workspaceID, .chat) }
        case .delta(let conversationID, _, let text):
            guard let workspaceID = focus.workspace(for: conversationID),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            setFocus(workspaceID, .chat)
        }
    }

    private func completeCompanionTask(_ id: String, summary: String) async {
        guard let workspace = try? await workspaces.get(id), let kind = workspace.companionTask else { return }
        do {
            _ = try await browserCalls.call(self, kind: "finishCompanionTask", workspaceID: id,
                                            payload: ["keepWebTabs": .bool(kind == "tabs")])
            _ = try await archiveWorkspace(id)
            broadcast("assistant.taskFinished", .object(["title": .string(workspace.name), "summary": .string(String(summary.prefix(4000)))]))
        } catch {
            // Keep the workspace visible if its results cannot be moved safely.
            broadcast("assistant.taskFinished", .object(["title": .string(workspace.name),
                "summary": .string("The task completed. Its workspace is still open with its results.")]))
        }
    }

    func registerWorkspaceActivity() {
        register("workspace.activity") { [unowned self] _, _ in
            .object(self.focus.all.mapValues { state in
                .object(["surface": .string(state.surface.rawValue), "url": state.url.map(JSONValue.string) ?? .null])
            })
        }
        register("workspace.browserReply") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "only the browser answers browser requests") }
            let id = try params.string("requestId")
            if let message = params.optionalString("error") {
                self.browserCalls.finish(id, .failure(BridgeError(.badRequest, message)))
            } else {
                self.browserCalls.finish(id, .success(params?["result"] ?? .null))
            }
            return .null
        }
        registerFiles()
    }

    // MARK: File tree (Orca-style explorer beside the terminal)

    /// Browser-only paths within home, a workspace, or the attached shell’s current directory.
    private func readableURL(_ path: String, terminalID: String?) async throws -> URL {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.resolvingSymlinksInPath().path
        let roots = [home] + (await workspaces.list().map { URL(fileURLWithPath: $0.directory).resolvingSymlinksInPath().path })
        func contains(_ root: String) -> Bool {
            root == "/" || url.path == root || url.path.hasPrefix(root + "/")
        }
        if contains(home) {
            let first = url.path.dropFirst(home.count + 1).split(separator: "/").first.map(String.init) ?? ""
            guard !["Library", ".ssh", ".gnupg", ".aws"].contains(first) else { throw BridgeError(.notAuthorized, "\(first) is private") }
        }
        if roots.contains(where: contains) { return url }
        if let terminalID, let terminal = try? await terminals.info(terminalID),
           contains(URL(fileURLWithPath: terminal.cwd).resolvingSymlinksInPath().path) { return url }
        throw BridgeError(.notAuthorized, "the path is outside your home, workspace, or current terminal directory")
    }

    private func registerFiles() {
        register("fs.list") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "the file tree is for the user") }
            let url = try await self.readableURL(try params.string("path"), terminalID: params.optionalString("terminalId"))
            let keys: [URLResourceKey] = [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]
            let entries = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [])) ?? []
            let hidden: Set<String> = [".git", ".DS_Store", "node_modules", ".build", "__pycache__"]
            return .array(entries.filter { !hidden.contains($0.lastPathComponent) }.prefix(500).map { entry in
                let values = try? entry.resourceValues(forKeys: Set(keys))
                return .object(["name": .string(entry.lastPathComponent), "path": .string(entry.path),
                                "directory": .bool(values?.isDirectory ?? false), "size": .number(Double(values?.fileSize ?? 0)),
                                "modified": .number((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)])
            }.sorted { a, b in
                let ad = a["directory"]?.boolValue == true, bd = b["directory"]?.boolValue == true
                if ad != bd { return ad }
                return (a["name"]?.stringValue ?? "").localizedStandardCompare(b["name"]?.stringValue ?? "") == .orderedAscending
            })
        }
        register("fs.gitBranch") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Git branch is shown in the workspace interface.") }
            let directory = try await self.readableURL(try params.string("path"), terminalID: nil)
            return try await Task.detached(priority: .utility) {
                guard let data = try Self.git(["branch", "--show-current"], in: directory) else { return .null as JSONValue }
                let branch = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)
                return branch.isEmpty ? .null : .string(branch)
            }.value
        }
        register("fs.read") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "the file tree is for the user") }
            let url = try await self.readableURL(try params.string("path"), terminalID: params.optionalString("terminalId"))
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let limit = 256 * 1024
            let data = try handle.read(upToCount: limit + 1) ?? Data()
            let binary = data.prefix(4096).contains(0)
            return .object(["path": .string(url.path), "truncated": .bool(data.count > limit), "binary": .bool(binary),
                            "text": .string(binary ? "" : String(decoding: data.prefix(limit), as: UTF8.self))])
        }
    }

    private static func git(_ arguments: [String], in directory: URL, diffStatus: Bool = false) throws -> Data? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["--no-optional-locks", "--literal-pathspecs", "-C", directory.path] + arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 || (diffStatus && process.terminationStatus == 1) ? result : nil
    }

    private static func gitFile(at directory: URL, path: String, previous: String?, action: String) throws -> JSONValue {
        guard let data = try git(["rev-parse", "--show-toplevel"], in: directory) else {
            throw BridgeError(.badRequest, "This terminal is outside a Git repository.")
        }
        let root = String(decoding: data.dropLast(data.last == 10 ? 1 : 0), as: UTF8.self)
        let repository = URL(fileURLWithPath: root, isDirectory: true)
        func normalized(_ value: String) -> String {
            let path = URL(fileURLWithPath: value).standardizedFileURL.path
            return path.replacingOccurrences(of: #"^/private(?=/(?:var|tmp|etc)(?:/|$))"#, with: "", options: .regularExpression)
        }
        let rootPrefix = normalized(root) + "/"
        func relative(_ value: String) throws -> String {
            let path = normalized(value)
            guard path.hasPrefix(rootPrefix), path.count > rootPrefix.count else {
                throw BridgeError(.notAuthorized, "The selected file is outside this repository.")
            }
            return String(path.dropFirst(rootPrefix.count))
        }
        let file = try relative(path)
        let paths = try [file] + (previous.map { [try relative($0)] } ?? [])
        switch action {
        case "stage", "unstage":
            let hasHead = try git(["rev-parse", "--verify", "HEAD"], in: repository) != nil
            let command = action == "stage" ? ["add"] : hasHead ? ["restore", "--staged"] : ["rm", "--cached"]
            guard try git(command + ["--"] + paths, in: repository) != nil else {
                throw BridgeError(.badRequest, "Git could not update the index for this file.")
            }
            return .null
        case "diff":
            let flags = ["--no-ext-diff", "--no-textconv", "--no-color"]
            var unstaged = try git(["diff"] + flags + ["--"] + paths, in: repository) ?? Data()
            let staged = try git(["diff", "--cached"] + flags + ["--"] + paths, in: repository) ?? Data()
            if unstaged.isEmpty, staged.isEmpty,
               let status = try git(["status", "--short", "--", file], in: repository),
               status.starts(with: Data("?? ".utf8)) {
                unstaged = try git(["diff", "--no-index"] + flags + ["--", "/dev/null", file], in: repository, diffStatus: true) ?? Data()
            }
            let limit = 96 * 1024
            return .object(["staged": .string(String(decoding: staged.prefix(limit), as: UTF8.self)),
                            "unstaged": .string(String(decoding: unstaged.prefix(limit), as: UTF8.self)),
                            "truncated": .bool(staged.count > limit || unstaged.count > limit)])
        default:
            throw BridgeError(.badRequest, "Unknown Git action.")
        }
    }

    private static func gitChanges(at directory: URL) throws -> JSONValue {
        guard let root = try git(["rev-parse", "--show-toplevel"], in: directory) else { return .null }
        let rootPath = String(decoding: root.dropLast(root.last == 10 ? 1 : 0), as: UTF8.self)
        guard let status = try git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], in: directory) else {
            throw BridgeError(.badRequest, "Git could not read changes for this folder")
        }
        let fields = status.split(separator: 0)
        var changes: [JSONValue] = []
        var index = 0
        while index < fields.count, changes.count < 500 {
            let record = fields[index]
            index += 1
            guard record.count >= 4 else { continue }
            let state = String(decoding: record.prefix(2), as: UTF8.self)
            let path = rootPath + "/" + String(decoding: record.dropFirst(3), as: UTF8.self)
            let previous: JSONValue
            if (state.contains("R") || state.contains("C")), index < fields.count {
                previous = .string(rootPath + "/" + String(decoding: fields[index], as: UTF8.self))
                index += 1
            } else { previous = .null }
            changes.append(.object(["path": .string(path), "status": .string(state), "previous": previous]))
        }
        return .object(["files": .array(changes), "directory": .string(directory.path), "truncated": .bool(index < fields.count)])
    }
}
