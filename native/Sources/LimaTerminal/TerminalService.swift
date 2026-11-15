import CLimaPTY
import Darwin
import Foundation

public struct TerminalInfo: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var cwd: String
    public var pid: Int32
    public var cols: Int
    public var rows: Int
    public var state: TerminalProcessState
    public var owner: String
    public var pendingRequests: [String]
    public var lastExitStatus: Int?
    public var exitCode: Int?
}

public struct TerminalCommand: Codable, Equatable, Sendable {
    public var command: String
    public var startedAt: Double
    public var exitStatus: Int?
}

public enum TerminalServiceError: Error, CustomStringConvertible, Equatable {
    case notFound(String)
    case spawnFailed(Int32)
    case leaseRejected(String)
    case exited(String)

    public var description: String {
        switch self {
        case .notFound(let id): "terminal \(id) not found"
        case .spawnFailed(let code): "could not start shell: \(String(cString: strerror(code)))"
        case .leaseRejected(let agent): "agent \(agent) does not hold the keyboard lease"
        case .exited(let id): "terminal \(id) has exited"
        }
    }
}

/// Terminal events delivered to subscribers (browser, agents, MCP).
public enum TerminalEvent: Sendable {
    case output(id: String, data: Data)
    case state(TerminalInfo)
    case command(id: String, TerminalCommand)
}

/// One PTY-backed shell. Lives in the runtime daemon, independent of any
/// window: UI attach/detach never touches the process (spec rule 5).
final class TerminalSession: @unchecked Sendable {
    let id: String
    let pid: pid_t
    let master: Int32
    let title: String
    private(set) var cwd: String
    private(set) var cols: Int
    private(set) var rows: Int

    // Guarded by `lock`.
    private let lock = NSLock()
    private var scanner = ShellMarkerScanner()
    private var scrollback = Data()
    private var lease = InputLease()
    private var state: TerminalProcessState
    private var lastExitStatus: Int?
    private var exitCode: Int?
    private var integrated: Bool
    private var history: [TerminalCommand] = []
    private var promptWaiters: [(token: UUID, continuation: CheckedContinuation<Int?, Never>)] = []

    private var readSource: DispatchSourceRead?
    private var exitSource: DispatchSourceProcess?
    private let emit: @Sendable (TerminalEvent) -> Void

    static let scrollbackLimit = 1024 * 1024
    static let historyLimit = 1000

    init(id: String, shell: String, arguments: [String], environment: [String: String], cwd: String,
         cols: Int, rows: Int, integrated: Bool, emit: @escaping @Sendable (TerminalEvent) -> Void) throws {
        self.id = id
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.integrated = integrated
        self.emit = emit
        self.title = URL(fileURLWithPath: shell).lastPathComponent
        self.state = integrated ? .running : .uncertain

        let argv = ([shell] + arguments).map { strdup($0) } + [nil]
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }

        var master: Int32 = -1
        var pid: pid_t = 0
        let status = lima_pty_spawn(shell, argv, envp, cwd, UInt16(cols), UInt16(rows), &master, &pid)
        guard status == 0 else { throw TerminalServiceError.spawnFailed(status) }
        self.master = master
        self.pid = pid
        startIO()
    }

    private func startIO() {
        let queue = DispatchQueue(label: "lima.terminal.\(id)")
        let read = DispatchSource.makeReadSource(fileDescriptor: master, queue: queue)
        read.setEventHandler { [weak self] in self?.drain() }
        read.resume()
        readSource = read

        let exit = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        exit.setEventHandler { [weak self] in self?.reap() }
        exit.resume()
        exitSource = exit
    }

    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(master, &buffer, buffer.count)
            if count > 0 {
                process(Array(buffer[0..<count]))
            } else if count == 0 || (errno != EAGAIN && errno != EINTR) {
                readSource?.cancel()
                return
            } else {
                return
            }
        }
    }

    private func process(_ bytes: [UInt8]) {
        lock.lock()
        let (output, events) = scanner.feed(bytes)
        if !output.isEmpty {
            scrollback.append(contentsOf: output)
            if scrollback.count > Self.scrollbackLimit { scrollback.removeFirst(scrollback.count - Self.scrollbackLimit) }
        }
        var stateChanged = false
        var commands: [TerminalCommand] = []
        var waiters: [CheckedContinuation<Int?, Never>] = []
        for event in events {
            switch event {
            case .promptReady(let status):
                integrated = true
                if let index = history.indices.last, history[index].exitStatus == nil, state == .running {
                    history[index].exitStatus = status
                }
                lastExitStatus = status
                state = .idle
                stateChanged = true
                waiters += promptWaiters.map(\.continuation)
                promptWaiters.removeAll()
            case .commandStarted(let command):
                state = .running
                stateChanged = true
                if let command, !command.isEmpty {
                    let entry = TerminalCommand(command: command, startedAt: Date().timeIntervalSince1970 * 1000, exitStatus: nil)
                    history.append(entry)
                    if history.count > Self.historyLimit { history.removeFirst() }
                    commands.append(entry)
                }
            }
        }
        let status = lastExitStatus
        lock.unlock()

        if !output.isEmpty { emit(.output(id: id, data: Data(output))) }
        for command in commands { emit(.command(id: id, command)) }
        if stateChanged { emit(.state(info())) }
        for waiter in waiters { waiter.resume(returning: status) }
    }

    private func reap() {
        var status: Int32 = 0
        waitpid(pid, &status, 0)
        drain()
        lock.lock()
        state = .exited
        exitCode = (status & 0x7f) == 0 ? Int((status >> 8) & 0xff) : 128 + Int(status & 0x7f)
        let waiters = promptWaiters.map(\.continuation)
        promptWaiters.removeAll()
        lock.unlock()
        exitSource?.cancel()
        readSource?.cancel()
        close(master)
        emit(.state(info()))
        for waiter in waiters { waiter.resume(returning: nil) }
    }

    // MARK: Queries

    func info() -> TerminalInfo {
        lock.lock(); defer { lock.unlock() }
        var current = state
        // The shell's own markers are authoritative when present; otherwise
        // ask the kernel whether a foreground job other than the shell runs.
        if current != .exited {
            let foreground = lima_pty_foreground(master)
            if foreground > 0, foreground != pid { current = .running }
            else if !integrated { current = .uncertain }
        }
        let owner: String
        switch lease.owner {
        case .user: owner = "user"
        case .agent(let agent): owner = "agent:\(agent)"
        }
        return TerminalInfo(id: id, title: title, cwd: cwd, pid: pid, cols: cols, rows: rows, state: current,
                            owner: owner, pendingRequests: lease.pendingRequests, lastExitStatus: lastExitStatus, exitCode: exitCode)
    }

    func snapshot() -> Data {
        lock.lock(); defer { lock.unlock() }
        return scrollback
    }

    func commandHistory() -> [TerminalCommand] {
        lock.lock(); defer { lock.unlock() }
        return history
    }

    // MARK: Input

    /// User keystrokes always win: typing while an agent holds the lease
    /// revokes it immediately, and the agent's queued writes are rejected.
    func userWrite(_ data: Data) throws {
        lock.lock()
        let hadAgent = lease.owner != .user
        lease.userTakeover()
        lock.unlock()
        try writeRaw(data)
        if hadAgent { emit(.state(info())) }
    }

    func agentWrite(_ data: Data, handle: InputLeaseHandle) throws {
        lock.lock()
        let allowed = lease.authorizeAgentWrite(handle)
        lock.unlock()
        guard allowed else { throw TerminalServiceError.leaseRejected(handle.agentID) }
        try writeRaw(data)
    }

    private func writeRaw(_ data: Data) throws {
        guard info().state != .exited else { throw TerminalServiceError.exited(id) }
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = Darwin.write(master, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if written < 0 {
                    if errno == EAGAIN || errno == EINTR { usleep(1000); continue }
                    throw TerminalServiceError.exited(id)
                }
                offset += written
            }
        }
    }

    func resize(cols: Int, rows: Int) {
        lock.lock()
        self.cols = max(2, cols); self.rows = max(1, rows)
        lock.unlock()
        _ = lima_pty_resize(master, UInt16(self.cols), UInt16(self.rows))
    }

    // MARK: Lease

    func withLease<T>(_ body: (inout InputLease) throws -> T) rethrows -> T {
        lock.lock()
        let result = try body(&lease)
        lock.unlock()
        emit(.state(info()))
        return result
    }

    /// Suspends until the shell reports its next prompt (or exits/timeout).
    func waitForPrompt(timeout: TimeInterval) async -> (timedOut: Bool, exitStatus: Int?) {
        let race = PromptRace()
        let token = UUID()
        let status: Int? = await withCheckedContinuation { continuation in
            lock.lock()
            if state == .exited {
                lock.unlock()
                continuation.resume(returning: nil)
                return
            }
            promptWaiters.append((token, continuation))
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self else { return }
                self.lock.lock()
                guard let index = self.promptWaiters.firstIndex(where: { $0.token == token }) else {
                    self.lock.unlock()
                    return
                }
                let waiter = self.promptWaiters.remove(at: index)
                self.lock.unlock()
                race.timedOut = true
                waiter.continuation.resume(returning: nil)
            }
        }
        return (race.timedOut, status)
    }

    func terminate() {
        kill(-pid, SIGHUP)
        kill(pid, SIGHUP)
    }
}

private final class PromptRace: @unchecked Sendable { var timedOut = false }

/// Owns every terminal session in the runtime.
public actor TerminalService {
    private var sessions: [String: TerminalSession] = [:]
    private let integrationDirectory: URL
    private let emit: @Sendable (TerminalEvent) -> Void

    public init(integrationDirectory: URL, emit: @escaping @Sendable (TerminalEvent) -> Void) {
        self.integrationDirectory = integrationDirectory
        self.emit = emit
    }

    public func create(cwd: String?, cols: Int = 100, rows: Int = 30, shell: String? = nil) throws -> TerminalInfo {
        let environment = ProcessInfo.processInfo.environment
        let shellPath = shell ?? environment["SHELL"] ?? "/bin/zsh"
        let directory = cwd.flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil } ?? NSHomeDirectory()

        var env = environment.filter { !$0.key.hasPrefix("LIMA_") && $0.key != "ZDOTDIR" }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Lima"
        env["LANG"] = env["LANG"] ?? "en_US.UTF-8"
        env["PWD"] = directory

        let integrated = URL(fileURLWithPath: shellPath).lastPathComponent == "zsh"
        if integrated {
            try ShellIntegration.install(in: integrationDirectory)
            if let userZdotdir = environment["ZDOTDIR"] { env["LIMA_USER_ZDOTDIR"] = userZdotdir }
            env["ZDOTDIR"] = integrationDirectory.path
        }

        let id = UUID().uuidString
        let session = try TerminalSession(id: id, shell: shellPath, arguments: ["-l"], environment: env, cwd: directory,
                                          cols: cols, rows: rows, integrated: integrated, emit: emit)
        sessions[id] = session
        return session.info()
    }

    public func list() -> [TerminalInfo] {
        sessions.values.map { $0.info() }.sorted { $0.id < $1.id }
    }

    public func info(_ id: String) throws -> TerminalInfo { try session(id).info() }

    /// Attach returns the scrollback so a new view (pop-out, reopened
    /// sidebar, restarted browser) can render the session as it was.
    public func attach(_ id: String) throws -> (TerminalInfo, Data) {
        let session = try session(id)
        return (session.info(), session.snapshot())
    }

    public func history(_ id: String) throws -> [TerminalCommand] { try session(id).commandHistory() }

    public func allHistory() -> [(String, TerminalCommand)] {
        sessions.flatMap { id, session in session.commandHistory().map { (id, $0) } }
    }

    public func userWrite(_ id: String, data: Data) throws { try session(id).userWrite(data) }

    public func agentWrite(_ id: String, data: Data, handle: InputLeaseHandle) throws {
        try session(id).agentWrite(data, handle: handle)
    }

    public func resize(_ id: String, cols: Int, rows: Int) throws { try session(id).resize(cols: cols, rows: rows) }

    public func requestLease(_ id: String, agentID: String) throws {
        try session(id).withLease { $0.request(agentID: agentID) }
    }

    public func grantLease(_ id: String, agentID: String) throws -> InputLeaseHandle {
        try session(id).withLease { try $0.grant(agentID: agentID) }
    }

    public func denyLease(_ id: String, agentID: String) throws {
        try session(id).withLease { $0.deny(agentID: agentID) }
    }

    public func releaseLease(_ id: String, handle: InputLeaseHandle) throws {
        try session(id).withLease { $0.release(handle) }
    }

    public func reclaim(_ id: String) throws {
        try session(id).withLease { $0.userTakeover() }
    }

    public func expireIdleLeases(timeout: TimeInterval) {
        for session in sessions.values { _ = session.withLease { $0.expireIfIdle(timeout: timeout) } }
    }

    public func waitForPrompt(_ id: String, timeout: TimeInterval) async throws -> (timedOut: Bool, exitStatus: Int?, output: Data) {
        let session = try session(id)
        let before = session.snapshot().count
        let result = await session.waitForPrompt(timeout: timeout)
        let after = session.snapshot()
        let output = after.count >= before ? after.suffix(from: after.startIndex + min(before, after.count)) : after
        return (result.timedOut, result.exitStatus, Data(output))
    }

    public func close(_ id: String) throws {
        let session = try session(id)
        session.terminate()
        sessions[id] = nil
    }

    public func closeAll() {
        for session in sessions.values { session.terminate() }
        sessions.removeAll()
    }

    private func session(_ id: String) throws -> TerminalSession {
        guard let session = sessions[id] else { throw TerminalServiceError.notFound(id) }
        return session
    }
}
