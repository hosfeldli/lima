import AppKit
import Darwin
import Foundation
import LimaAuthorization
import LimaProtocol
import LimaTerminal

/// The long-lived runtime process.
public enum Daemon {
    public static func run(paths: RuntimePaths = .resolve()) async -> Never {
        try? FileManager.default.createDirectory(at: paths.data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard RuntimeLock.acquire(at: paths.lock) != nil else {
            // Another runtime owns the socket. Exit 0 so launchd's
            // KeepAlive(SuccessfulExit=false) doesn't restart-loop.
            FileHandle.standardError.write(Data("lima-host: runtime already running\n".utf8))
            exit(0)
        }
        signal(SIGPIPE, SIG_IGN)

        let runtime: Runtime
        do {
            runtime = try await Runtime.open(paths: paths)
        } catch {
            FileHandle.standardError.write(Data("lima-host: cannot open runtime: \(error)\n".utf8))
            exit(1)
        }
        if let scopes = try? await runtime.store.get([String].self, collection: "settings", id: "mcp.grants") {
            MCPGrants.shared.scopes = Set(scopes)
        }

        let origins = OriginTable()
        runtime.register("host.identify") { [unowned runtime] params, context in
            guard let client = context.client else { return .null }
            var requested = ActionOrigin(rawValue: params.optionalString("origin") ?? "mcp") ?? .mcp
            var workspaceID: String?
            if let token = params.optionalString("workspaceToken") {
                // A workspace agent: bound to exactly one workspace.
                guard let id = await runtime.workspaces.id(forToken: token) else { throw BridgeError(.notAuthorized, "unknown workspace token") }
                workspaceID = id
                requested = .chat
            } else if requested == .chat {
                requested = .mcp // "chat" is reserved for token-bound workspace agents
            }
            origins.set(client, requested, workspaceID: workspaceID)
            return .object(["origin": .string(requested.rawValue), "workspace": workspaceID.map(JSONValue.string) ?? .null])
        }
        runtime.register("terminal.lease.handle") { [unowned runtime] params, _ in
            let id = try params.string("id")
            let agent = try params.string("agentId")
            guard let handle = try await runtime.terminals.currentHandle(id, agentID: agent) else {
                throw BridgeError(.notAuthorized, "the user has not granted keyboard control to \(agent)")
            }
            return try JSONValue.from(handle)
        }

        let server = SocketServer(path: paths.socket,
            onConnect: { runtime.connect($0) },
            onDisconnect: { client in runtime.disconnect(client); origins.remove(client) },
            handler: { client, payload in
                guard let request = try? JSONDecoder().decode(BridgeRequest.self, from: payload) else {
                    if let data = try? JSONEncoder().encode(BridgeResponse.failure(id: "", BridgeError(.badRequest, "malformed request"))) { client.send(data) }
                    return
                }
                Task {
                    let (origin, workspaceID) = origins.binding(client)
                    if origin == .mcp, request.method == "terminal.agentRun", !MCPGrants.shared.allows(scope: "terminal:control") {
                        let denied = BridgeResponse.failure(id: request.id, BridgeError(.confirmationRequired, "Allow terminal:control for MCP clients in Lima → Integrations first"))
                        if let data = try? JSONEncoder().encode(denied) { client.send(data) }
                        return
                    }
                    let response = await runtime.handle(request, context: CallContext(client: client, origin: origin, workspaceID: workspaceID))
                    if let data = try? JSONEncoder().encode(response) { client.send(data) }
                }
            })
        do {
            try server.start()
        } catch {
            FileHandle.standardError.write(Data("lima-host: cannot listen on \(paths.socket): \(error)\n".utf8))
            exit(1)
        }

        await MainActor.run { runtime.activity = ActivityRecorder(runtime: runtime) }

        // Weekly report: check at startup, every 15 minutes, and on wake, so
        // a Mac asleep at Friday 3 PM catches up once (dedupe by week ID).
        let checkReports: @Sendable () -> Void = {
            Task {
                if let report = try? await runtime.context.runScheduledReportIfDue() {
                    runtime.search.index.upsert(Runtime.document(for: report))
                    runtime.broadcast("context.report", (try? JSONValue.from(report)) ?? .null)
                }
            }
        }
        checkReports()
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 900, repeating: 900)
        timer.setEventHandler(handler: checkReports)
        timer.resume()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in checkReports() }

        // Return idle keyboard leases to the user (spec §4.2 step 5).
        let leaseTimer = DispatchSource.makeTimerSource(queue: .global())
        leaseTimer.schedule(deadline: .now() + 30, repeating: 30)
        leaseTimer.setEventHandler { Task { await runtime.terminals.expireIdleLeases(timeout: 300) } }
        leaseTimer.resume()

        withExtendedLifetime((server, timer, leaseTimer)) {
            FileHandle.standardError.write(Data("lima-host: runtime \(limaRuntimeVersion) listening on \(paths.socket)\n".utf8))
            // A port keeps the run loop alive; it services the main dispatch
            // queue plus NSWorkspace and distributed notifications.
            RunLoop.main.add(Port(), forMode: .default)
            while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
        }
        exit(0)
    }
}

final class OriginTable: @unchecked Sendable {
    private let lock = NSLock()
    private var origins: [UUID: (ActionOrigin, String?)] = [:]
    func set(_ client: ClientConnection, _ origin: ActionOrigin, workspaceID: String? = nil) { lock.lock(); origins[client.id] = (origin, workspaceID); lock.unlock() }
    /// Unidentified clients get the least-privileged origin.
    func binding(_ client: ClientConnection) -> (ActionOrigin, String?) { lock.lock(); defer { lock.unlock() }; return origins[client.id] ?? (.mcp, nil) }
    func remove(_ client: ClientConnection) { lock.lock(); origins[client.id] = nil; lock.unlock() }
}

/// Client side of the daemon socket, used by the browser relay, the MCP
/// server and CLI subcommands.
public final class RuntimeClient: @unchecked Sendable {
    public let fd: Int32
    private var decoder = BridgeFrame.Decoder()
    /// Events received while waiting for a response (not re-read by call).
    public private(set) var events: [Data] = []
    private var nextID = 1

    init(fd: Int32) { self.fd = fd }

    /// Connects, starting the daemon if needed and replacing a daemon left
    /// running from a different build.
    public static func connect(paths: RuntimePaths = .resolve(), executable: String = CommandLine.arguments[0], origin: ActionOrigin, workspaceToken: String? = nil) throws -> RuntimeClient {
        var client = try connectOrSpawn(paths: paths, executable: executable)
        if let hello = try? client.call("host.hello"), hello["buildID"]?.stringValue != RuntimeBuild.id,
           ProcessInfo.processInfo.environment["LIMA_KEEP_DAEMON"] == nil,
           BackgroundAgent.status().executable.map({ ($0 as NSString).resolvingSymlinksInPath == (executable as NSString).resolvingSymlinksInPath }) ?? true {
            _ = try? client.call("host.shutdown")
            close(client.fd)
            for _ in 0..<50 where SocketServer.connect(path: paths.socket).map({ close($0); return true }) ?? false { usleep(100_000) }
            client = try connectOrSpawn(paths: paths, executable: executable)
        }
        var identity: [String: JSONValue] = ["origin": .string(origin.rawValue)]
        if let workspaceToken { identity["workspaceToken"] = .string(workspaceToken) }
        _ = try client.call("host.identify", params: .object(identity))
        return client
    }

    private static func connectOrSpawn(paths: RuntimePaths, executable: String) throws -> RuntimeClient {
        if let fd = SocketServer.connect(path: paths.socket) { return RuntimeClient(fd: fd) }
        if BackgroundAgent.status().installed {
            BackgroundAgent.launchctl(["kickstart", "gui/\(getuid())/\(BackgroundAgent.label)"])
        } else {
            try spawnDaemon(executable: executable)
        }
        for _ in 0..<100 {
            if let fd = SocketServer.connect(path: paths.socket) { return RuntimeClient(fd: fd) }
            usleep(50_000)
        }
        throw BridgeError(.internalError, "Lima runtime did not start (socket \(paths.socket))")
    }

    static func spawnDaemon(executable: String) throws {
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Lima")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, logDir.appendingPathComponent("runtime.log").path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        defer { posix_spawnattr_destroy(&attributes); posix_spawn_file_actions_destroy(&actions) }
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup(executable), strdup("daemon"), nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        let status = posix_spawn(&pid, executable, &actions, &attributes, argv, environ)
        guard status == 0 else { throw BridgeError(.internalError, "could not start runtime: \(String(cString: strerror(status)))") }
    }

    /// Synchronous request/response; events received meanwhile are queued.
    public func call(_ method: String, params: JSONValue? = nil) throws -> JSONValue {
        let id = "c\(nextID)"
        nextID += 1
        try sendRaw(JSONEncoder().encode(BridgeRequest(id: id, method: method, params: params)))
        while true {
            for payload in try readPayloads() {
                if let response = try? JSONDecoder().decode(BridgeResponse.self, from: payload), response.id == id {
                    if response.ok { return response.result ?? .null }
                    throw response.error ?? BridgeError(.internalError, "request failed")
                }
                if events.count < 1000 { events.append(payload) }
            }
        }
    }

    func sendRaw(_ payload: Data) throws {
        let frame = BridgeFrame.encode(payload)
        try frame.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written < 0 { if errno == EINTR { continue }; throw BridgeError(.internalError, "runtime connection closed") }
                offset += written
            }
        }
    }

    func readPayloads() throws -> [Data] {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw BridgeError(.internalError, "runtime connection closed") }
            let payloads = try decoder.append(Data(buffer[0..<count]))
            if !payloads.isEmpty { return payloads }
        }
    }
}

/// `lima-host --stdio`: pumps frames between the browser's pipes and the
/// daemon socket. When the browser exits, only the relay exits; terminals
/// and jobs continue in the daemon.
public enum StdioRelay {
    public static func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        let client: RuntimeClient
        do {
            client = try RuntimeClient.connect(origin: .browser)
        } catch {
            let event = BridgeEvent(event: "host.unavailable", data: .string(String(describing: error)))
            if let data = try? JSONEncoder().encode(event) { FileHandle.standardOutput.write(BridgeFrame.encode(data)) }
            exit(1)
        }
        let socketFD = client.fd
        Thread.detachNewThread { pump(from: socketFD, to: STDOUT_FILENO) }
        pump(from: STDIN_FILENO, to: socketFD)
    }

    /// Copies bytes until EOF on either side, then exits: the browser going
    /// away ends only the relay, never the runtime.
    static func pump(from source: Int32, to destination: Int32) -> Never {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(source, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { exit(0) }
            let delivered = buffer.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < count {
                    let written = write(destination, raw.baseAddress!.advanced(by: offset), count - offset)
                    if written < 0 { if errno == EINTR { continue }; return false }
                    offset += written
                }
                return true
            }
            if !delivered { exit(0) }
        }
    }
}
