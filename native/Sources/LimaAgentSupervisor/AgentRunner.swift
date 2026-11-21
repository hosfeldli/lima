import Foundation

/// Specific, user-actionable failure classes (spec v2 §5.5).
public enum AgentFailureKind: String, Codable, Sendable {
    case missingExecutable = "missing_executable"
    case permissionDenied = "permission_denied"
    case authentication
    case modelRejected = "model_rejected"
    case incompatibleVersion = "incompatible_version"
    case connection
    case rateLimited = "rate_limited"
    case processCrashed = "process_crashed"
    case cancelled
    case unknown
}

public struct AgentFailure: Codable, Equatable, Sendable, Error {
    public var kind: AgentFailureKind
    public var message: String
    public var recoverable: Bool { kind != .missingExecutable && kind != .incompatibleVersion }

    public init(_ kind: AgentFailureKind, _ message: String) {
        self.kind = kind
        self.message = String(message.prefix(600))
    }

    /// Classifies CLI stderr / error-event text. Order matters: the most
    /// specific signals are checked first.
    public static func classify(_ text: String, exitCode: Int32? = nil, signaled: Bool = false) -> AgentFailure {
        let lower = text.lowercased()
        func has(_ needles: String...) -> Bool { needles.contains { lower.contains($0) } }
        let summary = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n").last.map(String.init) ?? text
        if signaled { return AgentFailure(.processCrashed, "CLI terminated by signal. \(summary)") }
        if has("not logged in", "please log in", "login required", "/login", "authenticate", "unauthorized", "401", "invalid api key", "auth login") {
            return AgentFailure(.authentication, summary)
        }
        if has("operation not permitted", "permission denied", "sandbox denied", "access to this folder", "denied access to") {
            return AgentFailure(.permissionDenied, summary)
        }
        if has("rate limit", "429", "usage limit", "quota") { return AgentFailure(.rateLimited, summary) }
        if has("model") && has("not found", "not supported", "does not exist", "invalid", "not available", "access", "unknown model") {
            return AgentFailure(.modelRejected, summary)
        }
        if has("unknown option", "unexpected argument", "unrecognized", "unknown flag", "error: unexpected") {
            return AgentFailure(.incompatibleVersion, summary)
        }
        if has("enotfound", "econnrefused", "econnreset", "network", "timed out", "timeout", "getaddrinfo", "connection", "offline", "dns") {
            return AgentFailure(.connection, summary)
        }
        if let exitCode, exitCode > 128 { return AgentFailure(.processCrashed, summary) }
        return AgentFailure(.unknown, summary.isEmpty ? "CLI exited with status \(exitCode ?? -1)" : summary)
    }
}

public enum AgentMode: String, Codable, Sendable {
    /// Full chat: read-only tools, persisted CLI session.
    case chat
    /// Quick Ask: no tools, lowest effort, no persisted CLI session (spec v1 §3.4).
    case quickAsk
}

public struct AgentRunRequest: Sendable {
    public var provider: CLIProvider
    public var prompt: String
    public var model: String?
    public var cliSessionID: String?
    public var workingDirectory: URL
    public var mode: AgentMode
    /// Provider-specific extras (e.g. a workspace's MCP config), inserted
    /// before positional arguments.
    public var extraArguments: [String] = []
    public var extraEnvironment: [String: String] = [:]

    public init(provider: CLIProvider, prompt: String, model: String? = nil, cliSessionID: String? = nil, workingDirectory: URL, mode: AgentMode) {
        self.provider = provider
        self.prompt = prompt
        self.model = model
        self.cliSessionID = cliSessionID
        self.workingDirectory = workingDirectory
        self.mode = mode
    }
}

public enum AgentStreamEvent: Equatable, Sendable {
    case session(String)
    case progress(AgentProgress)
    case delta(String)
    case tool(name: String, detail: String)
    case completed(text: String)
    case failed(AgentFailure)
}

public enum AgentProgress: String, Codable, Sendable {
    case connected
    case thinking
    case reconnecting
}

/// Builds argv for each CLI. Kept pure so it is unit-testable.
public enum AgentCommandLine {
    public static func arguments(for request: AgentRunRequest) -> [String] {
        let model = request.model.flatMap { $0.isEmpty || $0 == "default" ? nil : $0 }
        switch request.provider {
        case .claude:
            var args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
            if let model { args += ["--model", model] }
            switch request.mode {
            case .quickAsk:
                args += ["--tools", "", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--no-session-persistence", "--effort", "low"]
            case .chat:
                if let session = request.cliSessionID { args += ["--resume", session] }
            }
            return args + request.extraArguments
        case .codex:
            var args = ["exec", "--json", "--skip-git-repo-check"]
            if !request.extraArguments.contains("--dangerously-bypass-approvals-and-sandbox") {
                args += ["-c", "sandbox_mode=\"read-only\""]
            }
            if let model { args += ["-m", model] }
            if request.mode == .quickAsk {
                args += ["-c", "model_reasoning_effort=\"low\"", "-c", "mcp_servers={}", "--disable", "shell_tool", "--ephemeral"]
            }
            args += request.extraArguments
            if request.mode == .chat, let session = request.cliSessionID { args += ["resume", session] }
            return args + ["-"]
        case .opencode:
            var args = ["run", "--format", "json"]
            if let model { args += ["--model", model] }
            if request.mode == .chat, let session = request.cliSessionID { args += ["--session", session] }
            return args + request.extraArguments
        }
    }
}

/// Incremental JSONL parsers for each CLI's structured output.
public struct AgentEventParser: Sendable {
    public let provider: CLIProvider
    private var finalText = ""
    private var sawDelta = false
    private var startedTools = Set<String>()

    public init(provider: CLIProvider) { self.provider = provider }

    public mutating func parse(line: String) -> [AgentStreamEvent] {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        switch provider {
        case .claude: return parseClaude(object)
        case .codex: return parseCodex(object)
        case .opencode: return parseOpenCode(object)
        }
    }

    private mutating func parseClaude(_ object: [String: Any]) -> [AgentStreamEvent] {
        switch object["type"] as? String {
        case "system":
            if object["subtype"] as? String == "init", let id = object["session_id"] as? String { return [.session(id)] }
        case "stream_event":
            let event = object["event"] as? [String: Any]
            if event?["type"] as? String == "message_start" { return [.progress(.thinking)] }
            let delta = event?["delta"] as? [String: Any]
            if event?["type"] as? String == "content_block_delta", delta?["type"] as? String == "text_delta", let text = delta?["text"] as? String {
                sawDelta = true
                finalText += text
                return [.delta(text)]
            }
        case "assistant":
            let content = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            var events: [AgentStreamEvent] = []
            for block in content {
                if block["type"] as? String == "tool_use", let name = block["name"] as? String {
                    events.append(.tool(name: name, detail: Self.toolDetail(block["input"])))
                } else if !sawDelta, block["type"] as? String == "text", let text = block["text"] as? String {
                    finalText += text
                    events.append(.delta(text))
                }
            }
            return events
        case "result":
            let text = object["result"] as? String ?? finalText
            if object["is_error"] as? Bool == true || (object["subtype"] as? String).map({ $0 != "success" }) == true {
                return [.failed(AgentFailure.classify(text.isEmpty ? (object["subtype"] as? String ?? "error") : text))]
            }
            return [.completed(text: text.isEmpty ? finalText : text)]
        default:
            break
        }
        return []
    }

    private mutating func parseCodex(_ object: [String: Any]) -> [AgentStreamEvent] {
        switch object["type"] as? String {
        case "thread.started":
            if let id = object["thread_id"] as? String { return [.session(id)] }
        case "turn.started":
            return [.progress(.thinking)]
        case "item.started", "item.completed":
            let completed = object["type"] as? String == "item.completed"
            let item = object["item"] as? [String: Any] ?? [:]
            guard let type = item["type"] as? String else { break }
            if type == "reasoning" { return completed ? [] : [.progress(.thinking)] }
            if type == "agent_message" {
                guard completed, let text = item["text"] as? String else { break }
                let delta = finalText.isEmpty ? text : "\n\n" + text
                finalText += delta
                return [.delta(delta)]
            }
            if let id = item["id"] as? String {
                if completed, startedTools.remove(id) != nil { break }
                if !completed, !startedTools.insert(id).inserted { break }
            }
            switch type {
            case "mcp_tool_call":
                let name = item["tool"] as? String ?? item["name"] as? String ?? "MCP tool"
                let server = item["server"] as? String
                let qualified = server.map { "mcp__\($0)__\(name)" } ?? name
                return [.tool(name: qualified, detail: Self.toolDetail(item["arguments"] ?? item["input"]))]
            case "command_execution":
                return [.tool(name: "shell", detail: item["command"] as? String ?? "")]
            case "file_change":
                let paths = (item["changes"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
                return [.tool(name: type, detail: paths.joined(separator: ", "))]
            case "web_search":
                return [.tool(name: type, detail: item["query"] as? String ?? "")]
            default:
                return [.tool(name: type, detail: "")]
            }
        case "turn.completed":
            return [.completed(text: finalText)]
        case "turn.failed", "error":
            let message = (object["error"] as? [String: Any])?["message"] as? String ?? object["message"] as? String ?? "Codex reported an error"
            if object["type"] as? String == "error", message.lowercased().hasPrefix("reconnecting") {
                return [.progress(.reconnecting)]
            }
            return [.failed(AgentFailure.classify(message))]
        default:
            break
        }
        return []
    }

    private mutating func parseOpenCode(_ object: [String: Any]) -> [AgentStreamEvent] {
        var events: [AgentStreamEvent] = []
        if let session = object["sessionID"] as? String, !sawDelta {
            sawDelta = true // reuse flag: session announced once
            events.append(.session(session))
        }
        switch object["type"] as? String {
        case "step_start":
            events.append(.progress(.thinking))
        case "text":
            if let part = object["part"] as? [String: Any], let text = part["text"] as? String {
                finalText += text
                events.append(.delta(text))
            }
        case "tool_use", "tool":
            let part = object["part"] as? [String: Any]
            let state = part?["state"] as? [String: Any]
            if let id = part?["callID"] as? String ?? part?["id"] as? String,
               !startedTools.insert(id).inserted { break }
            events.append(.tool(name: part?["tool"] as? String ?? "tool", detail: Self.toolDetail(state?["input"] ?? part?["input"])))
        case "error":
            let error = object["error"] as? [String: Any]
            let message = (error?["data"] as? [String: Any])?["message"] as? String ?? error?["name"] as? String ?? "OpenCode reported an error"
            events.append(.failed(AgentFailure.classify(message)))
        default:
            break
        }
        return events
    }

    private static func toolDetail(_ value: Any?) -> String {
        if let text = value as? String { return String(text.prefix(300)) }
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { return "" }
        return String(String(decoding: data, as: UTF8.self).prefix(300))
    }

    /// OpenCode has no explicit completion event; the stream ends at exit.
    public func completionAtExit() -> AgentStreamEvent? {
        provider == .opencode ? .completed(text: finalText) : nil
    }
}

/// Runs one CLI request as a supervised subprocess.
public final class AgentRun: @unchecked Sendable {
    public let events: AsyncStream<AgentStreamEvent>
    private let process = Process()
    private let lock = NSLock()
    private var cancelled = false

    public init(request: AgentRunRequest, executable: String, searchPath: [String]) {
        var continuation: AsyncStream<AgentStreamEvent>.Continuation!
        events = AsyncStream { continuation = $0 }
        let stream = continuation!

        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = AgentCommandLine.arguments(for: request)
        process.currentDirectoryURL = request.workingDirectory
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = searchPath.joined(separator: ":")
        environment["NO_COLOR"] = "1"
        environment.removeValue(forKey: "CLAUDECODE")
        environment.merge(request.extraEnvironment) { _, new in new }
        if request.provider == .opencode, request.mode == .quickAsk {
            environment["OPENCODE_CONFIG_CONTENT"] = #"{"permissions":[{"action":"*","resource":"*","effect":"deny"}]}"#
        }
        process.environment = environment

        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let state = RunState(provider: request.provider)
        let readers = DispatchGroup()
        readers.enter()
        readers.enter()
        process.terminationHandler = { [weak self] finished in
            readers.notify(queue: .global(qos: .utility)) { [weak self] in
                let wasCancelled = self?.isCancelled ?? false
                if let terminal = state.finish(status: finished.terminationStatus,
                                               signaled: finished.terminationReason == .uncaughtSignal,
                                               cancelled: wasCancelled) {
                    stream.yield(terminal)
                }
                stream.finish()
            }
        }

        do {
            try process.run()
            DispatchQueue.global(qos: .utility).async {
                defer { readers.leave() }
                Self.readChunks(stdout.fileHandleForReading) { data in
                    for event in state.consume(data) { stream.yield(event) }
                }
                for event in state.consume(Data([0x0A])) { stream.yield(event) }
            }
            DispatchQueue.global(qos: .utility).async {
                defer { readers.leave() }
                Self.readChunks(stderr.fileHandleForReading) { data in
                    state.appendStderr(data)
                }
            }
            DispatchQueue.global(qos: .utility).async {
                defer { try? stdin.fileHandleForWriting.close() }
                try? stdin.fileHandleForWriting.write(contentsOf: Data(request.prompt.utf8))
            }
        } catch {
            let failure = error as NSError
            let cause = (failure.userInfo[NSUnderlyingErrorKey] as? NSError) ?? failure
            let denied = (cause.domain == NSPOSIXErrorDomain && [Int(EACCES), Int(EPERM)].contains(cause.code))
                || (failure.domain == NSCocoaErrorDomain && failure.code == NSFileReadNoPermissionError)
            let kind: AgentFailureKind = denied ? .permissionDenied : .missingExecutable
            stream.yield(.failed(AgentFailure(kind, "Could not start \(request.provider.rawValue): \(error.localizedDescription)")))
            stream.finish()
        }
    }

    private static func readChunks(_ handle: FileHandle, consume: (Data) -> Void) {
        // Read the bytes currently in the pipe so short JSONL events arrive before EOF.
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { read(handle.fileDescriptor, $0.baseAddress, $0.count) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return }
            consume(Data(buffer.prefix(count)))
        }
    }

    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    /// Graceful termination, then forced after a grace period.
    public func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [process] in
            if process.isRunning { kill(pid, SIGKILL) }
        }
    }
}

private final class RunState: @unchecked Sendable {
    private let lock = NSLock()
    private var parser: AgentEventParser
    private var buffer = Data()
    private var stderr = Data()
    private var finished = false

    init(provider: CLIProvider) { parser = AgentEventParser(provider: provider) }

    func consume(_ data: Data) -> [AgentStreamEvent] {
        lock.lock(); defer { lock.unlock() }
        buffer.append(data)
        var events: [AgentStreamEvent] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...newline)
            for event in parser.parse(line: line) {
                if case .completed = event { finished = true }
                if case .failed = event { finished = true }
                events.append(event)
            }
        }
        return events
    }

    func appendStderr(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        if stderr.count < 64 * 1024 { stderr.append(data) }
    }

    /// Produces the terminal event if the stream itself did not.
    func finish(status: Int32, signaled: Bool, cancelled: Bool) -> AgentStreamEvent? {
        lock.lock(); defer { lock.unlock() }
        if cancelled { return finished ? nil : .failed(AgentFailure(.cancelled, "Stopped")) }
        if finished { return nil }
        let errText = String(decoding: stderr, as: UTF8.self)
        if status == 0, !signaled, let completion = parser.completionAtExit() { return completion }
        if status == 0, !signaled { return .failed(AgentFailure(.unknown, "CLI exited without a response. \(errText.suffix(300))")) }
        return .failed(AgentFailure.classify(errText, exitCode: status, signaled: signaled))
    }
}
