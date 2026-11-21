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
