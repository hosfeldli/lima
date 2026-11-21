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
    public var shellReady: Bool?
    public var userEditing: Bool?
    public var activeCommand: String?
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
    case busy
    case inputTimedOut
    case shellNotReady
    case directoryAccess(String)

    public var description: String {
        switch self {
        case .notFound(let id): "terminal \(id) not found"
        case .spawnFailed(let code): "could not start shell: \(String(cString: strerror(code)))"
        case .leaseRejected(let agent): "agent \(agent) does not hold the keyboard lease"
        case .exited(let id): "terminal \(id) has exited"
        case .busy: "The shell is busy or has unfinished input. Run the command when its prompt is clear."
        case .inputTimedOut: "The shell stopped accepting keyboard input. Check the Terminal before retrying."
        case .shellNotReady: "The shell did not reach its first prompt. Open the terminal to check for a startup prompt or error."
        case .directoryAccess(let path): "macOS denied access to \(path). Check Lima’s Files & Folders access in Privacy & Security."
        }
    }
}

/// Terminal events delivered to subscribers (browser, agents, MCP).
public enum TerminalEvent: Sendable {
    case output(id: String, data: Data, offset: Int)
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
    private var outputOffset = 0
    private var userEditing = false
    private var awaitingPrompt = false
    private var lastInputOffset = 0
    private var lease = InputLease()
    private var state: TerminalProcessState
    private var lastExitStatus: Int?
    private var exitCode: Int?
    private var integrated: Bool
    private var hasPrompt = false
    private var history: [TerminalCommand] = []
    private var promptWaiters: [(token: UUID, afterCommand: Int, continuation: CheckedContinuation<Int?, Never>)] = []
    /// Incremented on every preexec; lets a waiter ignore prompts that
    /// belong to earlier (or startup) prompts rather than its own command.
    private var commandSequence = 0

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
        let status = lima_pty_spawn(shell, argv, envp, cwd, UInt16(clamping: cols), UInt16(clamping: rows), &master, &pid)
        guard status == 0 else {
            if status == EPERM || status == EACCES { throw TerminalServiceError.directoryAccess(cwd) }
            if status == ETIMEDOUT { throw TerminalServiceError.shellNotReady }
            throw TerminalServiceError.spawnFailed(status)
        }
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
        let offset = outputOffset
        outputOffset += output.count
        if !output.isEmpty {
            scrollback.append(contentsOf: output)
            if scrollback.count > Self.scrollbackLimit { scrollback.removeFirst(scrollback.count - Self.scrollbackLimit) }
        }
        var stateChanged = false
        var commands: [TerminalCommand] = []
        var waiters: [CheckedContinuation<Int?, Never>] = []
        for event in events {
            switch event {
            case .workingDirectory(let path):
                updateDirectory(path)
            case .promptReady(let status):
                integrated = true
                hasPrompt = true
                userEditing = false
                awaitingPrompt = false
                if let index = history.indices.last, history[index].exitStatus == nil, state == .running {
                    history[index].exitStatus = status
                }
                lastExitStatus = status
                state = .idle
                stateChanged = true
                let ready = promptWaiters.filter { commandSequence >= $0.afterCommand }
                promptWaiters.removeAll { commandSequence >= $0.afterCommand }
                waiters += ready.map(\.continuation)
            case .commandStarted(let command):
                commandSequence += 1
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

        if !output.isEmpty { emit(.output(id: id, data: Data(output), offset: offset)) }
        for command in commands { emit(.command(id: id, command)) }
        if stateChanged { emit(.state(info())) }
        for waiter in waiters { waiter.resume(returning: status) }
    }

    private func updateDirectory(_ path: String) {
        if path.hasPrefix("/private/"), String(path.dropFirst("/private".count)) == cwd { return }
        cwd = path
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
            var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
            let capacity = buffer.count
            if !integrated, lima_pty_cwd(pid, &buffer, capacity) != 0 {
                let actual = String(decoding: buffer.prefix(while: { $0 != 0 }).map(UInt8.init(bitPattern:)), as: UTF8.self)
                updateDirectory(actual)
            }
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
                            owner: owner, pendingRequests: lease.pendingRequests, lastExitStatus: lastExitStatus, exitCode: exitCode,
                            shellReady: integrated ? hasPrompt : nil, userEditing: integrated ? userEditing : nil,
                            activeCommand: state == .running ? history.last?.command : nil)
    }

    func snapshot() -> (data: Data, offset: Int) {
        lock.lock(); defer { lock.unlock() }
        return (scrollback, outputOffset)
    }

    func inputOffset() -> Int { lock.withLock { lastInputOffset } }

    func commandHistory() -> [TerminalCommand] {
        lock.lock(); defer { lock.unlock() }
        return history
    }

    // MARK: Input

    /// User keystrokes always win: typing while an agent holds the lease
    /// revokes it immediately, and the agent's queued writes are rejected.
    func userWrite(_ data: Data) throws {
        if Self.isTerminalReport(data) {
            try lock.withLock { try writeUnlocked(data) }
            return
        }
        let changed = try lock.withLock {
            let hadAgent = lease.owner != .user
            let oldEditing = userEditing
            lease.userTakeover()
            if !data.isEmpty { userEditing = !(data == Data([0x03]) && state == .idle) && state == .idle }
            try writeUnlocked(data, interruptsInput: oldEditing && data == Data([0x03]))
            return hadAgent || oldEditing != userEditing
        }
        if changed { emit(.state(info())) }
    }

    private static func isTerminalReport(_ data: Data) -> Bool {
        guard data.first == 0x1b else { return false }
        let text = String(decoding: data, as: UTF8.self)
        return text.range(of: #"^\x1b\[(?:[IO]|\??\d+(?:;\d+)*[Rnc]|>\d+(?:;\d+)*c|[48];\d+;\d+t|<\d+;\d+;\d+[Mm])$"#,
                          options: .regularExpression) != nil
    }

    func agentWrite(_ data: Data, handle: InputLeaseHandle) throws {
        try lock.withLock {
            guard lease.authorizeAgentWrite(handle) else { throw TerminalServiceError.leaseRejected(handle.agentID) }
            try writeUnlocked(data)
        }
    }

    func writeWorkspaceCommand(_ data: Data, agentID: String) throws -> InputLeaseHandle {
        let handle = try lock.withLock {
            guard state == .idle, !userEditing, !awaitingPrompt else { throw TerminalServiceError.busy }
            let handle: InputLeaseHandle
            if lease.owner == .agent(agentID) {
                handle = InputLeaseHandle(agentID: agentID, generation: lease.generation)
            } else {
                lease.request(agentID: agentID)
                handle = try lease.grant(agentID: agentID)
            }
            do { try writeUnlocked(data) }
            catch { lease.release(handle); throw error }
            return handle
        }
        emit(.state(info()))
        return handle
    }

    /// Called with the state lock held. The PTY reader must be able to
    /// drain echoed input and output while the writer waits for room.
    private func writeUnlocked(_ data: Data, interruptsInput: Bool = false) throws {
        guard state != .exited else { throw TerminalServiceError.exited(id) }
        let descriptor = fcntl(master, F_DUPFD_CLOEXEC, 0)
        guard descriptor >= 0 else { throw TerminalServiceError.exited(id) }
        defer { close(descriptor) }
        let previousAwaiting = awaitingPrompt
        let previousOffset = lastInputOffset
        if interruptsInput || data.contains(0x0D) || data.contains(0x0A) || (data.contains(0x03) && state != .idle) {
            awaitingPrompt = true
            lastInputOffset = outputOffset
        }
        let deadline = DispatchTime.now() + .seconds(2)
        var offset = 0
        lock.unlock()
        defer { lock.lock() }
        do {
            try data.withUnsafeBytes { raw in
                while offset < raw.count {
                    let written = Darwin.write(descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                    if written > 0 {
                        offset += written
                        continue
                    }
                    if written < 0, errno != EAGAIN, errno != EINTR { throw TerminalServiceError.exited(id) }
                    guard DispatchTime.now() < deadline else { throw TerminalServiceError.inputTimedOut }
                    usleep(1000)
                }
            }
        } catch {
            lock.lock()
            if offset == 0 {
                awaitingPrompt = previousAwaiting
                lastInputOffset = previousOffset
            } else if state == .idle, !data.prefix(offset).contains(0x0D), !data.prefix(offset).contains(0x0A) {
                userEditing = true
                awaitingPrompt = previousAwaiting
            }
            lock.unlock()
            throw error
        }
    }

    func resize(cols: Int, rows: Int) {
        lock.lock()
        self.cols = min(Int(UInt16.max), max(2, cols)); self.rows = min(Int(UInt16.max), max(1, rows))
        lock.unlock()
        _ = lima_pty_resize(master, UInt16(self.cols), UInt16(self.rows))
    }

    // MARK: Lease

    func withLease<T>(_ body: (inout InputLease) throws -> T) rethrows -> T {
        let result = try lock.withLock { try body(&lease) }
        emit(.state(info()))
        return result
    }

    /// Suspends until the shell reports its next prompt (or exits/timeout).
    /// Current preexec count, captured before typing a command.
    func currentCommandSequence() -> Int {
        lock.lock(); defer { lock.unlock() }
        return commandSequence
    }

    /// Suspends until the shell reports a prompt. With `afterCommand`, only a
    /// prompt that follows at least that many preexecs counts — i.e. the
    /// prompt after the command that was just typed, not a stale one.
    func waitForPrompt(timeout: TimeInterval, afterCommand: Int = 0) async -> (timedOut: Bool, exitStatus: Int?) {
        let race = PromptRace()
        let token = UUID()
        let status: Int? = await withCheckedContinuation { continuation in
            lock.lock()
            if state == .exited {
                lock.unlock()
                continuation.resume(returning: nil)
                return
            }
            if state == .idle, !awaitingPrompt, commandSequence >= afterCommand {
                let status = lastExitStatus
                lock.unlock()
                continuation.resume(returning: status)
                return
            }
            promptWaiters.append((token, afterCommand, continuation))
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
    private var commandsInFlight = Set<String>()
    private let integrationDirectory: URL
    private let emit: @Sendable (TerminalEvent) -> Void

    public init(integrationDirectory: URL, emit: @escaping @Sendable (TerminalEvent) -> Void) {
        self.integrationDirectory = integrationDirectory
        self.emit = emit
    }

    public func create(cwd: String?, cols: Int = 100, rows: Int = 30, shell: String? = nil) throws -> TerminalInfo {
        let environment = ProcessInfo.processInfo.environment
        let shellPath = shell ?? environment["SHELL"] ?? "/bin/zsh"
        let directory = cwd ?? NSHomeDirectory()

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
        return (session.info(), session.snapshot().data)
    }

    public func attachWithOffset(_ id: String) throws -> (info: TerminalInfo, data: Data, offset: Int) {
        let session = try session(id)
        let snapshot = session.snapshot()
        return (session.info(), snapshot.data, snapshot.offset)
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

    /// The handle for an agent that currently holds the lease, if any.
    public func currentHandle(_ id: String, agentID: String) throws -> InputLeaseHandle? {
        try session(id).withLease { lease in
            lease.owner == .agent(agentID) ? InputLeaseHandle(agentID: agentID, generation: lease.generation) : nil
        }
    }

    public func commandSequence(_ id: String) throws -> Int { try session(id).currentCommandSequence() }

    /// Agent command: type it under the lease, then wait for the prompt that
    /// follows this command's own preexec.
    public func agentRunCommand(_ id: String, command: String, handle: InputLeaseHandle, timeout: TimeInterval) async throws -> (timedOut: Bool, exitStatus: Int?, output: Data) {
        guard commandsInFlight.insert(id).inserted else { throw TerminalServiceError.busy }
        defer { commandsInFlight.remove(id) }
        let session = try session(id)
        let sequence = session.currentCommandSequence()
        let before = session.snapshot().offset
        try session.agentWrite(Self.commandInput(command), handle: handle)
        let result = await session.waitForPrompt(timeout: timeout, afterCommand: sequence + 1)
        return (result.timedOut, result.exitStatus, Self.output(from: session, after: before))
    }

    public func runWorkspaceCommand(_ id: String, command: String, agentID: String, timeout: TimeInterval) async throws -> (timedOut: Bool, exitStatus: Int?, output: Data) {
        guard commandsInFlight.insert(id).inserted else { throw TerminalServiceError.busy }
        defer { commandsInFlight.remove(id) }
        let session = try session(id)
        if session.currentCommandSequence() == 0 {
            let ready = await session.waitForPrompt(timeout: min(10, timeout))
            if ready.timedOut { throw TerminalServiceError.shellNotReady }
        }
        let sequence = session.currentCommandSequence()
        let before = session.snapshot().offset
        let handle = try session.writeWorkspaceCommand(Self.commandInput(command), agentID: agentID)
        defer { session.withLease { $0.release(handle) } }
        let result = await session.waitForPrompt(timeout: timeout, afterCommand: sequence + 1)
        return (result.timedOut, result.exitStatus, Self.output(from: session, after: before))
    }

    private static func output(from session: TerminalSession, after offset: Int) -> Data {
        let after = session.snapshot()
        return after.data.suffix(min(after.data.count, after.offset - offset))
    }

    private static func commandInput(_ command: String) -> Data {
        // Submit a complete shell input line even when the script contains
        // newlines or unbalanced syntax. Eval reports syntax errors at the prompt.
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        return Data(("builtin eval $'\(escaped)'\r").utf8)
    }

    public func reclaim(_ id: String) throws {
        try session(id).withLease { $0.userTakeover() }
    }

    public func expireIdleLeases(timeout: TimeInterval) {
        for session in sessions.values { _ = session.withLease { $0.expireIfIdle(timeout: timeout) } }
    }

    public func waitForPrompt(_ id: String, timeout: TimeInterval, afterCommand: Int = 0) async throws -> (timedOut: Bool, exitStatus: Int?, output: Data) {
        let session = try session(id)
        let before = afterCommand == 0 ? session.inputOffset() : session.snapshot().offset
        let result = await session.waitForPrompt(timeout: timeout, afterCommand: afterCommand)
        return (result.timedOut, result.exitStatus, Self.output(from: session, after: before))
    }

    public func close(_ id: String) throws {
        let session = try session(id)
        session.terminate()
        sessions[id] = nil
    }

    public func closeForArchive(_ ids: [String], managedDirectory: String? = nil) throws {
        let active = ids.compactMap { sessions[$0] }
        if let managedDirectory {
            let root = URL(fileURLWithPath: managedDirectory).resolvingSymlinksInPath().path
            let own = Set(ids)
            for session in sessions.values where !own.contains(session.id) {
                let info = session.info()
                let cwd = URL(fileURLWithPath: info.cwd).resolvingSymlinksInPath().path
                if info.state != .exited, cwd == root || cwd.hasPrefix(root + "/") {
                    throw TerminalServiceError.busy
                }
            }
        }
        for session in active {
            let info = session.info()
            guard !commandsInFlight.contains(session.id), info.owner == "user",
                  info.userEditing != true, info.state != .running || info.shellReady == false else {
                throw TerminalServiceError.busy
            }
        }
        for session in active {
            session.terminate()
            sessions[session.id] = nil
        }
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
