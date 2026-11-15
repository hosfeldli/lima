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
    func set(_ workspaceID: String, _ surface: Surface, url: String? = nil) -> State? {
        lock.lock(); defer { lock.unlock() }
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
    func setFocus(_ workspaceID: String, _ surface: WorkspaceFocus.Surface, url: String? = nil) {
        guard let state = focus.set(workspaceID, surface, url: url) else { return }
        broadcast("workspace.activity", .object(["id": .string(workspaceID), "surface": .string(state.surface.rawValue),
                                                 "url": state.url.map(JSONValue.string) ?? .null]))
    }

    /// Conversation events drive chat/idle focus for workspace agents.
    func trackConversation(_ event: ConversationEvent) {
        switch event {
        case .updated(let conversation):
            guard let workspaceID = conversation.workspaceID else { return }
            focus.bind(conversation: conversation.id, to: workspaceID)
            let streaming = conversation.messages.last.map { $0.role == .assistant && $0.status == .streaming } ?? false
            if !streaming { setFocus(workspaceID, .idle) }
            else if focus.state(workspaceID).surface == .idle { setFocus(workspaceID, .chat) }
        case .delta(let conversationID, _, let text):
            guard let workspaceID = focus.workspace(for: conversationID),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            setFocus(workspaceID, .chat)
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

    /// The user's file tree: folders inside the home directory (or any
    /// workspace directory), never Library or credential folders. Browser only.
    private func readableURL(_ path: String) async throws -> URL {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
        let home = FileManager.default.homeDirectoryForCurrentUser.standardizedFileURL.resolvingSymlinksInPath().path
        let roots = [home] + (await workspaces.list().map { URL(fileURLWithPath: $0.directory).resolvingSymlinksInPath().path })
        guard let root = roots.first(where: { url.path == $0 || url.path.hasPrefix($0 + "/") }) else {
            throw BridgeError(.notAuthorized, "only folders in your home directory or a workspace can be browsed")
        }
        if root == home {
            let first = url.path.dropFirst(home.count + 1).split(separator: "/").first.map(String.init) ?? ""
            guard !["Library", ".ssh", ".gnupg", ".aws"].contains(first) else { throw BridgeError(.notAuthorized, "\(first) is private") }
        }
        return url
    }

    private func registerFiles() {
        register("fs.list") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "the file tree is for the user") }
            let url = try await self.readableURL(try params.string("path"))
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
        register("fs.read") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "the file tree is for the user") }
            let url = try await self.readableURL(try params.string("path"))
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let limit = 256 * 1024
            let data = try handle.read(upToCount: limit + 1) ?? Data()
            let binary = data.prefix(4096).contains(0)
            return .object(["path": .string(url.path), "truncated": .bool(data.count > limit), "binary": .bool(binary),
                            "text": .string(binary ? "" : String(decoding: data.prefix(limit), as: UTF8.self))])
        }
    }
}
