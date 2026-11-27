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
    /// When a usage limit resets (seconds since 1970), if the provider said.
    public var resetsAt: Double? = nil
    public var recoverable: Bool { kind != .missingExecutable && kind != .incompatibleVersion }

    public init(_ kind: AgentFailureKind, _ message: String, resetsAt: Double? = nil) {
        self.kind = kind
        self.message = String(message.prefix(600))
        self.resetsAt = resetsAt
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
        if has("rate limit", "429", "usage limit", "quota", "limit reached", "-hour limit", "weekly limit", "opus limit")
            || (has("hit your") && has("limit")) {
            return AgentFailure(.rateLimited, summary, resetsAt: usageReset(in: text)?.timeIntervalSince1970)
        }
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

extension AgentFailure {
    /// Reads when a usage limit resets from provider text such as
    /// "resets 12:20pm (America/New_York)", "resets Nov 25, 3pm",
    /// "try again at 3:20 PM" or "try again in 2 hours 5 minutes".
    public static func usageReset(in text: String, now: Date = Date()) -> Date? {
        let lower = text.lowercased()
        func groups(_ pattern: String) -> [String?]? {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)) else { return nil }
            return (0..<match.numberOfRanges).map { Range(match.range(at: $0), in: lower).map { String(lower[$0]) } }
        }
        if let relative = groups(#"(?:try again|resets?|retry|available)(?: again)? in\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,and]*)+)"#)?[1] {
            let units: [(String, Double)] = [("d", 86_400), ("h", 3_600), ("m", 60), ("s", 1)]
            var seconds = 0.0
            let regex = try! NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)\s*([a-z]+)"#)
            for match in regex.matches(in: relative, range: NSRange(relative.startIndex..., in: relative)) {
                guard let amount = Range(match.range(at: 1), in: relative).flatMap({ Double(relative[$0]) }),
                      let unit = Range(match.range(at: 2), in: relative).map({ String(relative[$0]) }),
                      let scale = units.first(where: { unit.hasPrefix($0.0) })?.1 else { continue }
                seconds += amount * scale
            }
            if seconds > 0 { return now.addingTimeInterval(seconds) }
        }
        guard let parts = groups(#"(?:resets?(?:\s+at)?|try again at|available (?:again )?at)\s+(?:on\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s*\(([^)]+)\))?"#),
              var hour = parts[3].flatMap({ Int($0) }) else { return nil }
        let minute = parts[4].flatMap { Int($0) } ?? 0
        let meridiem = parts[5]?.replacingOccurrences(of: ".", with: "")
        guard meridiem != nil || parts[4] != nil, minute < 60 else { return nil }
        if let meridiem {
            guard (1...12).contains(hour) else { return nil }
            hour = hour % 12 + (meridiem == "pm" ? 12 : 0)
        }
        guard hour < 24 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        // Time zone identifiers are case-sensitive; read it from the original text.
        if let zone = text.range(of: #"\(([A-Za-z_]+(?:/[A-Za-z_+\-0-9]+)*)\)"#, options: .regularExpression)
            .flatMap({ TimeZone(identifier: String(text[$0].dropFirst().dropLast())) }) {
            calendar.timeZone = zone
        }
        var components = calendar.dateComponents([.year, .month, .day], from: now)
        components.hour = hour
        components.minute = minute
        if let monthName = parts[1] {
            let months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
            guard let month = months.firstIndex(of: String(monthName.prefix(3))), let day = parts[2].flatMap({ Int($0) }) else { return nil }
            components.month = month + 1
            components.day = day
            guard var date = calendar.date(from: components) else { return nil }
            if date < now.addingTimeInterval(-86_400) { date = calendar.date(byAdding: .year, value: 1, to: date) ?? date }
            return date
        }
        guard var date = calendar.date(from: components) else { return nil }
        // A time that just passed was rounded down; a time well past means tomorrow.
        if date < now.addingTimeInterval(-600) { date = calendar.date(byAdding: .day, value: 1, to: date) ?? date }
        return max(date, now)
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
    /// How hard the model thinks: low, medium or high (nil = the CLI's default).
    public var effort: String?
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
    case model(String)
    case progress(AgentProgress)
    case delta(String)
    case tool(name: String, detail: String)
    /// Lines the latest tool added and removed (file edits).
    case change(added: Int, removed: Int)
    /// An image a tool returned (a screenshot, a picture it read).
    case image(data: Data, type: String)
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
    /// The effort levels Claude Code and Codex both accept. OpenCode has no
    /// such setting, so it ignores the choice.
    /// Every effort a CLI accepts; the chat offers only those its model lists.
    public static let efforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    static func effort(_ value: String?) -> String? { value.flatMap { efforts.contains($0) ? $0 : nil } }

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
                if let effort = AgentCommandLine.effort(request.effort) { args += ["--effort", effort] }
                if let session = request.cliSessionID { args += ["--resume", session] }
            }
            return args + request.extraArguments
        case .codex:
            var args = ["exec", "--json", "--skip-git-repo-check"]
            if !request.extraArguments.contains("--dangerously-bypass-approvals-and-sandbox") {
                args += ["-c", "sandbox_mode=\"read-only\""]
            }
            if let model { args += ["-m", model] }
            if request.mode == .chat, let effort = AgentCommandLine.effort(request.effort) {
                args += ["-c", "model_reasoning_effort=\"\(effort)\""]
            }
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
            if object["subtype"] as? String == "init", let id = object["session_id"] as? String {
                return [.session(id)] + ((object["model"] as? String).map { [.model($0)] } ?? [])
            }
        case "stream_event":
            let event = object["event"] as? [String: Any]
            if event?["type"] as? String == "message_start" { return [.progress(.thinking)] }
            // Text after a tool call starts a new block: a new paragraph, not
            // a run-on ("Let me check.Now I'll…").
            if event?["type"] as? String == "content_block_start",
               (event?["content_block"] as? [String: Any])?["type"] as? String == "text", let gap = paragraphGap() {
                finalText += gap
                return [.delta(gap)]
            }
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
                    if let change = Self.lineChange(tool: name, input: block["input"] as? [String: Any]) { events.append(change) }
                } else if !sawDelta, block["type"] as? String == "text", let text = block["text"] as? String {
                    let piece = (paragraphGap() ?? "") + text
                    finalText += piece
                    events.append(.delta(piece))
                }
            }
            return events
        case "user":
            // Tool results: keep the images (screenshots, pictures read).
            let content = (object["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            return content.filter { $0["type"] as? String == "tool_result" }.flatMap { result in
                (result["content"] as? [[String: Any]] ?? []).compactMap(Self.image)
            }
        case "result":
            let text = object["result"] as? String ?? finalText
            if object["is_error"] as? Bool == true || (object["subtype"] as? String).map({ $0 != "success" }) == true {
                return [.failed(AgentFailure.classify(text.isEmpty ? (object["subtype"] as? String ?? "error") : text))]
            }
            // "result" is only the last text block; keep the whole reply the
            // user watched stream in when it ends with that block.
            let whole = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
            let last = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return [.completed(text: last.isEmpty || (!whole.isEmpty && whole.hasSuffix(last)) ? whole : text)]
        default:
            break
        }
        return []
    }

    private mutating func parseCodex(_ object: [String: Any]) -> [AgentStreamEvent] {
        switch object["type"] as? String {
        case "thread.started":
            if let id = object["thread_id"] as? String {
                return [.session(id)] + ((object["model"] as? String).map { [.model($0)] } ?? [])
            }
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
                let changes = item["changes"] as? [[String: Any]] ?? []
                let paths = changes.compactMap { $0["path"] as? String }
                var events: [AgentStreamEvent] = [.tool(name: type, detail: paths.joined(separator: ", "))]
                let diffs = changes.compactMap { $0["diff"] as? String ?? $0["unified_diff"] as? String }
                if !diffs.isEmpty {
                    let counts = diffs.map(Self.diffCounts).reduce((0, 0)) { ($0.0 + $1.0, $0.1 + $1.1) }
                    events.append(.change(added: counts.0, removed: counts.1))
                }
                return events
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
            if let model = (object["part"] as? [String: Any])?["modelID"] as? String ?? object["model"] as? String {
                events.append(.model(model))
            }
            events.append(.progress(.thinking))
        case "text":
            if let part = object["part"] as? [String: Any], let text = part["text"] as? String {
                let piece = (paragraphGap() ?? "") + text
                finalText += piece
                events.append(.delta(piece))
            }
        case "tool_use", "tool":
            let part = object["part"] as? [String: Any]
            let state = part?["state"] as? [String: Any]
            if let id = part?["callID"] as? String ?? part?["id"] as? String,
               !startedTools.insert(id).inserted { break }
            let tool = part?["tool"] as? String ?? "tool"
            events.append(.tool(name: tool, detail: Self.toolDetail(state?["input"] ?? part?["input"])))
            if let change = Self.lineChange(tool: tool, input: (state?["input"] ?? part?["input"]) as? [String: Any]) { events.append(change) }
        case "error":
            let error = object["error"] as? [String: Any]
            let message = (error?["data"] as? [String: Any])?["message"] as? String ?? error?["name"] as? String ?? "OpenCode reported an error"
            events.append(.failed(AgentFailure.classify(message)))
        default:
            break
        }
        return events
    }

    static func lines(_ text: String?) -> Int {
        guard let text, !text.isEmpty else { return 0 }
        return text.split(separator: "\n", omittingEmptySubsequences: false).count - (text.hasSuffix("\n") ? 1 : 0)
    }

    /// +/- lines for edit tools (Claude Edit/MultiEdit/Write, OpenCode edit/write).
    static func lineChange(tool: String, input: [String: Any]?) -> AgentStreamEvent? {
        guard let input else { return nil }
        switch tool.lowercased() {
        case "edit", "str_replace_editor":
            let old = input["old_string"] as? String ?? input["oldString"] as? String
            let new = input["new_string"] as? String ?? input["newString"] as? String
            guard old != nil || new != nil else { return nil }
            return .change(added: lines(new), removed: lines(old))
        case "multiedit":
            let edits = input["edits"] as? [[String: Any]] ?? []
            guard !edits.isEmpty else { return nil }
            return .change(added: edits.reduce(0) { $0 + lines($1["new_string"] as? String) },
                           removed: edits.reduce(0) { $0 + lines($1["old_string"] as? String) })
        case "write":
            guard let content = input["content"] as? String else { return nil }
            return .change(added: lines(content), removed: 0)
        default:
            return nil
        }
    }

    /// Counts +/- lines in a unified diff (headers excluded).
    static func diffCounts(_ diff: String) -> (Int, Int) {
        var added = 0, removed = 0
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
            if line.hasPrefix("+") { added += 1 } else if line.hasPrefix("-") { removed += 1 }
        }
        return (added, removed)
    }

    static func image(_ block: [String: Any]) -> AgentStreamEvent? {
        guard block["type"] as? String == "image", let source = block["source"] as? [String: Any],
              source["type"] as? String == "base64", let text = source["data"] as? String,
              let type = source["media_type"] as? String, ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(type),
              text.count < 16_000_000, let data = Data(base64Encoded: text) else { return nil }
        return .image(data: data, type: type)
    }

    /// The break that starts a new paragraph after earlier text, if needed.
    private func paragraphGap() -> String? {
        guard let tail = finalText.last(where: { $0 != " " && $0 != "\t" }) else { return nil }
        if finalText.hasSuffix("\n\n") { return nil }
        return tail == "\n" || finalText.hasSuffix("\n") ? "\n" : "\n\n"
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
                // A CLI that exits (or is cancelled) before reading its prompt
                // must not take this process down with SIGPIPE.
                _ = fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
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
