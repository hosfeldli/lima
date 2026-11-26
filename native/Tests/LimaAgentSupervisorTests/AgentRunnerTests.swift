import Foundation
import Testing
@testable import LimaAgentSupervisor
@testable import LimaStorage

@Test func claudeStreamParses() {
    var parser = AgentEventParser(provider: .claude)
    let lines = [
        #"{"type":"system","subtype":"init","session_id":"S1"}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ng"}}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}"#,
        #"{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"S1"}"#
    ]
    let events = lines.flatMap { parser.parse(line: $0) }
    #expect(events == [.session("S1"), .delta("po"), .delta("ng"), .completed(text: "pong")])
}

@Test func codexStreamParses() {
    var parser = AgentEventParser(provider: .codex)
    let lines = [
        #"{"type":"thread.started","thread_id":"T1"}"#,
        #"{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}"#,
        #"{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}"#,
        #"{"type":"turn.completed","usage":{}}"#
    ]
    #expect(lines.flatMap { parser.parse(line: $0) } == [.session("T1"), .delta("pong"), .completed(text: "pong")])
}

@Test func failuresAreClassified() {
    #expect(AgentFailure.classify("Error: Invalid API key · Please run /login").kind == .authentication)
    #expect(AgentFailure.classify("model 'gpt-9' not found").kind == .modelRejected)
    #expect(AgentFailure.classify("error: unexpected argument '--include-partial-messages'").kind == .incompatibleVersion)
    #expect(AgentFailure.classify("getaddrinfo ENOTFOUND api.anthropic.com").kind == .connection)
    #expect(AgentFailure.classify("boom", exitCode: 139).kind == .processCrashed)
}

@Test func quickAskArgumentsDisableToolsAndPersistence() {
    let request = AgentRunRequest(provider: .claude, prompt: "hi", model: "haiku", workingDirectory: URL(fileURLWithPath: "/tmp"), mode: .quickAsk)
    let args = AgentCommandLine.arguments(for: request)
    #expect(args.contains("--no-session-persistence"))
    #expect(args.firstIndex(of: "--tools").map { args[$0 + 1] } == "")
    let codex = AgentCommandLine.arguments(for: AgentRunRequest(provider: .codex, prompt: "hi", cliSessionID: "T1", workingDirectory: URL(fileURLWithPath: "/tmp"), mode: .chat))
    #expect(Array(codex.suffix(3)) == ["resume", "T1", "-"])
}

// MARK: Conversation service with fake CLIs

func fakeCLI(_ name: String, script: String) throws -> URL {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-fakecli-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent(name)
    try ("#!/bin/sh\n" + script).write(to: file, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    return dir
}

func makeConversations(cliDir: URL) async throws -> (ConversationService, URL) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-conv-\(UUID().uuidString)")
    let store = try EncryptedStore(directory: dir, keyProvider: FileKeyProvider(url: dir.appendingPathComponent("key")))
    let service = try await ConversationService(store: store, discovery: CLIDiscovery(searchPaths: [cliDir.path, "/usr/bin", "/bin"])) { _ in }
    return (service, dir)
}

func waitIdle(_ service: ConversationService, _ id: String) async throws -> Conversation {
    for _ in 0..<100 {
        let conversation = try await service.get(id)
        let running = await service.list().first { $0.id == id }?.running ?? false
        if conversation.messages.last?.status != .streaming && !running { return conversation }
        try await Task.sleep(for: .milliseconds(50))
    }
    return try await service.get(id)
}

@Test(.timeLimit(.minutes(1))) func shortProviderOutputArrivesWhileProcessIsStillRunning() async throws {
    let cli = try fakeCLI("codex", script: """
    cat >/dev/null
    echo '{"type":"thread.started","thread_id":"LIVE"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"First reply"}}'
    for try in 1 2 3 4 5; do
      [ -f "$(dirname "$0")/finish" ] && break
      sleep 1
    done
    echo '{"type":"turn.completed"}'
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    let conversation = try await service.create(provider: .codex, model: nil, workingDirectory: nil)
    _ = try await service.send(conversation.id, text: "hello")
    for _ in 0..<50 {
        if try await service.get(conversation.id).messages.last?.text == "First reply" { break }
        try await Task.sleep(for: .milliseconds(40))
    }
    let live = try await service.get(conversation.id)
    #expect(live.messages.last?.status == .streaming)
    #expect(live.messages.last?.progress == .thinking)
    #expect(live.messages.last?.text == "First reply")
    try Data().write(to: cli.appendingPathComponent("finish"))
    let finished = try await waitIdle(service, conversation.id)
    #expect(finished.messages.last?.status == .complete)
}

@Test(.timeLimit(.minutes(1))) func conversationStreamsAndResumesSession() async throws {
    // Echoes the prompt and records the args it was called with.
    let cli = try fakeCLI("claude", script: """
    prompt=$(cat)
    echo "$@" >> "$(dirname "$0")/calls"
    echo '{"type":"system","subtype":"init","session_id":"SESSION-1"}'
    echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"echo: '"$prompt"'"}}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"echo: '"$prompt"'"}'
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer { try? FileManager.default.removeItem(at: dir) }
    let conversation = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory())
    _ = try await service.send(conversation.id, text: "hello")
    var result = try await waitIdle(service, conversation.id)
    #expect(result.messages.map(\.text) == ["hello", "echo: hello"])
    #expect(result.cliSessionID == "SESSION-1")

    _ = try await service.send(conversation.id, text: "again")
    result = try await waitIdle(service, conversation.id)
    #expect(result.messages.last?.text == "echo: again")
    let calls = try String(contentsOf: cli.appendingPathComponent("calls"), encoding: .utf8)
    #expect(calls.contains("--resume SESSION-1"))
}

@Test(.timeLimit(.minutes(1))) func failureStaysOnMessageAndRetryRecovers() async throws {
    let cli = try fakeCLI("codex", script: """
    cat >/dev/null
    marker="$(dirname "$0")/ok"
    if [ -f "$marker" ]; then
      echo '{"type":"thread.started","thread_id":"T9"}'
      echo '{"type":"item.completed","item":{"type":"agent_message","text":"recovered"}}'
      echo '{"type":"turn.completed"}'
    else
      echo "Error: Not logged in. Run codex login" >&2
      exit 1
    fi
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer { try? FileManager.default.removeItem(at: dir) }
    let conversation = try await service.create(provider: .codex, model: nil, workingDirectory: nil)
    _ = try await service.send(conversation.id, text: "status?")
    let failed = try await waitIdle(service, conversation.id)
    #expect(failed.messages.count == 2)
    #expect(failed.messages[0].text == "status?")
    #expect(failed.messages[1].status == .failed)
    #expect(failed.messages[1].error?.kind == .authentication)

    try Data().write(to: cli.appendingPathComponent("ok"))
    _ = try await service.retry(conversation.id, assistantMessageID: failed.messages[1].id)
    let recovered = try await waitIdle(service, conversation.id)
    #expect(recovered.messages.map(\.text) == ["status?", "recovered"])
    #expect(recovered.messages[1].status == .complete)
}

@Test(.timeLimit(.minutes(1))) func missingCLIFailsGracefully() async throws {
    let empty = try fakeCLI("unrelated", script: "exit 0")
    let (service, dir) = try await makeConversations(cliDir: empty)
    defer { try? FileManager.default.removeItem(at: dir) }
    let conversation = try await service.create(provider: .opencode, model: nil, workingDirectory: nil)
    _ = try await service.send(conversation.id, text: "hi")
    let result = try await waitIdle(service, conversation.id)
    #expect(result.messages.last?.error?.kind == .missingExecutable)
}


@Test func codexReportsAnMCPToolAtStartWithoutRepeatingItAtCompletion() {
    var parser = AgentEventParser(provider: .codex)
    let events = parser.parse(line: #"{"type":"item.started","item":{"id":"tool1","type":"mcp_tool_call","server":"lima","tool":"workspace_open_tab","arguments":{"url":"https://example.com"}}}"#)
    #expect(events == [.tool(name: "mcp__lima__workspace_open_tab", detail: #"{"url":"https://example.com"}"#)])
    let completion = parser.parse(line: #"{"type":"item.completed","item":{"id":"tool1","type":"mcp_tool_call","server":"lima","tool":"workspace_open_tab"}}"#)
    #expect(completion.isEmpty)
}

@Test func usageLimitsAreRateLimitsWithTheirResetTime() throws {
    let zone = TimeZone(identifier: "America/New_York")!
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 23, hour: 9, minute: 5))!
    let message = "You've hit your 5-hour limit · resets 12:20pm (America/New_York)"
    let failure = AgentFailure.classify(message)
    #expect(failure.kind == .rateLimited)
    #expect(failure.resetsAt != nil)
    let reset = try #require(AgentFailure.usageReset(in: message, now: now))
    #expect(reset == calendar.date(from: DateComponents(year: 2026, month: 11, day: 23, hour: 12, minute: 20)))
    // A time earlier in the day means tomorrow.
    let tomorrow = try #require(AgentFailure.usageReset(in: "Limit reached · resets 3am (America/New_York)", now: now))
    #expect(tomorrow == calendar.date(from: DateComponents(year: 2026, month: 11, day: 24, hour: 3)))
    let weekly = try #require(AgentFailure.usageReset(in: "Weekly limit reached ∙ resets Nov 27, 1am (America/New_York)", now: now))
    #expect(weekly == calendar.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 1)))
    #expect(AgentFailure.classify("Weekly limit reached ∙ resets Nov 27, 1am").kind == .rateLimited)
    let relative = try #require(AgentFailure.usageReset(in: "You've hit your usage limit. Try again in 2 hours 5 minutes.", now: now))
    #expect(relative == now.addingTimeInterval(7_500))
    #expect(AgentFailure.usageReset(in: "Rate limit exceeded", now: now) == nil)
}

@Test(.timeLimit(.minutes(1))) func usageLimitSwitchesToAnotherReadyProvider() async throws {
    let cli = try fakeCLI("claude", script: """
    cat >/dev/null
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude AI usage limit reached"}'
    exit 1
    """)
    let codex = cli.appendingPathComponent("codex")
    try """
    #!/bin/sh
    cat >/dev/null
    echo '{"type":"thread.started","thread_id":"T2"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"Codex here"}}'
    echo '{"type":"turn.completed"}'
    """.write(to: codex, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: codex.path)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    await service.setFailover { failed, tried in
        [.codex, .opencode].first { $0 != failed && !tried.contains($0) }
    }
    let conversation = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory())
    _ = try await service.send(conversation.id, text: "hello")
    let result = try await waitIdle(service, conversation.id)
    #expect(result.provider == .codex)
    #expect(result.messages.map(\.text) == ["hello", "Codex here"])
    #expect(result.messages.last?.status == .complete)
    #expect(result.messages.last?.notice == "Claude Code reached its usage limit, so Lima switched to Codex.")

    let quick = await service.quickAsk(provider: .claude, model: nil, prompt: "hi") { _ in }
    #expect((try? quick.get()) == "Codex here")
}

@Test(.timeLimit(.minutes(1))) func usageLimitWithoutAnotherProviderStaysOnTheMessage() async throws {
    let cli = try fakeCLI("claude", script: """
    cat >/dev/null
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude AI usage limit reached"}'
    exit 1
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    await service.setFailover { _, _ in nil }
    let conversation = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory())
    _ = try await service.send(conversation.id, text: "hello")
    let result = try await waitIdle(service, conversation.id)
    #expect(result.provider == .claude)
    #expect(result.messages.last?.status == .failed)
    #expect(result.messages.last?.error?.kind == .rateLimited)
}

@Test(.timeLimit(.minutes(1))) func companionThreadsRecordContextAndContinueAsChats() async throws {
    // Echoes its prompt so the test can see the context the follow-up carried.
    let cli = try fakeCLI("claude", script: """
    prompt=$(cat)
    printf '%s' "$prompt" > "$(dirname "$0")/prompt"
    echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    let thread = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory(), companion: true)
    _ = try await service.record(thread.id, role: .user, text: "Plan a Tokyo trip")
    let handed = try await service.record(thread.id, role: .assistant, text: "Handed off to Tokyo trip.", taskIDs: ["t1"])
    #expect(handed.title == "Plan a Tokyo trip")
    #expect(handed.taskIDs == ["t1"])
    #expect(await service.list().first { $0.id == thread.id }?.companion == true)
    #expect(await service.list().first { $0.id == thread.id }?.preview == "Handed off to Tokyo trip.")

    _ = try await service.send(thread.id, text: "Add a day in Kyoto")
    let result = try await waitIdle(service, thread.id)
    #expect(result.messages.map(\.text) == ["Plan a Tokyo trip", "Handed off to Tokyo trip.", "Add a day in Kyoto", "ok"])
    let prompt = try String(contentsOf: cli.appendingPathComponent("prompt"), encoding: .utf8)
    #expect(prompt.contains("User: Plan a Tokyo trip") && prompt.contains("Assistant: Handed off to Tokyo trip."))
}

@Test(.timeLimit(.minutes(1))) func switchingProviderMidReplyRestartsTheReplyOnTheNewProvider() async throws {
    // Claude never finishes; Codex answers at once.
    let cli = try fakeCLI("claude", script: """
    cat >/dev/null
    sleep 30
    """)
    let codex = cli.appendingPathComponent("codex")
    try """
    #!/bin/sh
    cat >/dev/null
    echo '{"type":"thread.started","thread_id":"C1"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"from codex"}}'
    echo '{"type":"turn.completed"}'
    """.write(to: codex, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: codex.path)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    let conversation = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory())
    _ = try await service.send(conversation.id, text: "Hello")
    #expect(try await service.get(conversation.id).messages.last?.status == .streaming)

    let switched = try await service.configure(conversation.id, provider: .codex, model: nil)
    #expect(switched.provider == .codex)
    #expect(switched.messages.filter { $0.role == .assistant }.count == 1)
    let result = try await waitIdle(service, conversation.id)
    #expect(result.messages.map(\.text) == ["Hello", "from codex"])
    #expect(result.messages.last?.notice == "Restarted this reply on Codex.")
}

@Test(.timeLimit(.minutes(1))) func messagesSentDuringAReplyQueueOrInterrupt() async throws {
    // A request ending in "slow" writes a little and then hangs; others
    // answer at once. (Earlier turns arrive as transcript above it.)
    let cli = try fakeCLI("claude", script: """
    prompt=$(cat | tail -n 1)
    case "$prompt" in
      *slow)
        echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}'
        sleep 30 ;;
      *) echo '{"type":"result","subtype":"success","is_error":false,"result":"done"}' ;;
    esac
    """)
    let (service, dir) = try await makeConversations(cliDir: cli)
    defer {
        try? FileManager.default.removeItem(at: cli)
        try? FileManager.default.removeItem(at: dir)
    }
    let conversation = try await service.create(provider: .claude, model: nil, workingDirectory: NSTemporaryDirectory())
    let id = conversation.id
    _ = try await service.send(id, text: "one slow")
    for _ in 0..<100 where try await service.get(id).messages.last?.text.isEmpty != false { try await Task.sleep(for: .milliseconds(20)) }

    // Queued: waits behind the reply; can be taken back.
    let queued = try await service.send(id, text: "later")
    #expect(queued.messages.last?.status == .queued)
    let taken = try await service.unqueue(id, messageID: try #require(queued.messages.last?.id))
    #expect(!taken.messages.contains { $0.text == "later" })

    // Queued, then a second message interrupts: the reply stops and keeps
    // its text, the interrupting message runs first, the queued one after.
    _ = try await service.send(id, text: "afterwards")
    _ = try await service.send(id, text: "now please", mode: .interrupt)
    let result = try await waitIdle(service, id)
    #expect(result.messages.map(\.text) == ["one slow", "partial", "now please", "done", "afterwards", "done"])
    #expect(result.messages[1].error?.kind == .cancelled)
    #expect(result.messages.allSatisfy { $0.status != .queued })

    // Stopping hands back what never ran.
    _ = try await service.send(id, text: "again slow")
    _ = try await service.send(id, text: "never sent")
    #expect(await service.cancel(id) == ["never sent"])
    #expect(try await waitIdle(service, id).messages.contains { $0.text == "never sent" } == false)
}

@Test func stepsCountChangedLinesAndKeepToolImages() throws {
    var parser = AgentEventParser(provider: .claude)
    let edit = #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/w/a.swift","old_string":"a\nb","new_string":"a\nb\nc\nd"}}]}}"#
    #expect(parser.parse(line: edit).last == .change(added: 4, removed: 2))
    let write = #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/w/b.txt","content":"one\ntwo\n"}}]}}"#
    #expect(parser.parse(line: write).last == .change(added: 2, removed: 0))
    let png = Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
    let shot = #"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"\#(png)"}}]}]}}"#
    #expect(parser.parse(line: shot) == [.image(data: Data([0x89, 0x50, 0x4E, 0x47]), type: "image/png")])
    #expect(AgentEventParser.diffCounts("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more\n context") == (2, 1))
}

@Test func claudeTextAroundToolCallsStaysInParagraphs() {
    var parser = AgentEventParser(provider: .claude)
    let lines = [
        #"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me check."}}}"#,
        #"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}"#,
        #"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"All done."}}}"#,
        #"{"type":"result","subtype":"success","result":"All done."}"#,
    ]
    let events = lines.flatMap { parser.parse(line: $0) }
    let streamed = events.compactMap { if case .delta(let text) = $0 { text } else { nil } }.joined()
    #expect(streamed == "Let me check.\n\nAll done.")
    #expect(events.last == .completed(text: "Let me check.\n\nAll done."), "the whole reply stays, not just its last block")
}

@Test func chosenEffortReachesClaudeAndCodexButNotOpenCode() {
    var request = AgentRunRequest(provider: .claude, prompt: "hi", workingDirectory: URL(fileURLWithPath: "/tmp"), mode: .chat)
    request.effort = "high"
    let claude = AgentCommandLine.arguments(for: request)
    #expect(claude.contains("--effort") && claude[claude.firstIndex(of: "--effort")! + 1] == "high")
    request.provider = .codex
    #expect(AgentCommandLine.arguments(for: request).contains("model_reasoning_effort=\"high\""))
    request.provider = .opencode
    #expect(!AgentCommandLine.arguments(for: request).joined().contains("high"))
    request.provider = .claude
    request.effort = "ludicrous"
    #expect(!AgentCommandLine.arguments(for: request).contains("--effort"), "unknown levels are dropped")
}

@Test func replyPreviewShowsAReportsSummaryNotItsJSON() {
    let reply = "Done.\n\n```lima-report\n{\"status\":\"completed\",\"summary\":\"Booked three hotels.\"}\n```"
    #expect(ConversationService.preview(reply) == "Booked three hotels.")
    #expect(ConversationService.preview("Here:\n```swift\nlet x = 1\n```\n**Ready** to ship") == "Here: Ready to ship")
    #expect(ConversationService.preview("```lima-report\n{broken\n```").isEmpty)
}

@Test func editsOutsideTheWorkingFolderAreListed() {
    let tools = ["Edit: /Users/me/project/src/a.swift", "Write: /Users/me/.zshrc", "Read: /etc/hosts",
                 "Bash: rm -rf /Users/me/other", "apply_patch: /Users/me/other/b.txt", "Write: /tmp/scratch.txt",
                 "Edit: /Users/me/project/../secrets.txt"]
    #expect(changesOutside(tools, folder: "/Users/me/project") == ["/Users/me/.zshrc", "/Users/me/other/b.txt", "/Users/me/secrets.txt"])
    #expect(RunLimits(maxSteps: 1, maxMinutes: 99_999) == RunLimits(maxSteps: 10, maxMinutes: 600))
}
