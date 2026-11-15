import Foundation
import Testing
@testable import LimaAgentSupervisor
import LimaAuthorization
@testable import LimaProtocol
@testable import LimaRuntime

@Test(.timeLimit(.minutes(1))) func helperAgentsShareTheDirectoryAndStartWithoutATerminal() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let parentID = try #require(await call(runtime, "workspace.create", ["name": .string("Research")]).result?["id"]?.stringValue)
    let parent = try await runtime.workspaces.get(parentID)
    let helper = try await runtime.spawnAgent(parent: parent, name: "pricing-scout", task: "Find pricing pages", provider: nil, startTask: false)

    #expect(helper.parentID == parentID && helper.temporary == true && helper.task == "Find pricing pages")
    #expect(helper.directory == parent.directory)
    #expect(helper.terminalID == nil)
    #expect(try await runtime.conversations.get(helper.conversationID!).workspaceID == helper.id)

    // The parent's agent sees its helpers; a helper can't spawn more.
    let status = await call(runtime, "agents.status", [:], origin: .chat, workspace: parentID)
    #expect(status.result?.arrayValue?.first?["name"]?.stringValue == "pricing-scout")
    #expect(status.result?.arrayValue?.first?["state"]?.stringValue == "starting")
    let nested = await call(runtime, "agent.spawn", ["name": .string("x"), "task": .string("y")], origin: .chat, workspace: helper.id)
    #expect(nested.error?.code == .notAuthorized)

    // Its preamble says it's a helper with a task.
    let conversation = try await runtime.conversations.get(helper.conversationID!)
    let config = await runtime.workspaceAgentConfiguration(conversation)
    #expect(config.arguments.joined(separator: " ").contains("helper agent"))

    // First command creates its terminal in the shared directory.
    let ran = await call(runtime, "workspace.run", ["command": .string("pwd")], origin: .chat, workspace: helper.id)
    #expect(ran.result?["output"]?.stringValue?.contains(parent.directory) == true)
    let withTerminal = try await runtime.workspaces.get(helper.id)
    #expect(withTerminal.terminalID != nil)

    // Removing the workspace removes its helpers.
    _ = await call(runtime, "workspace.delete", ["id": .string(parentID)])
    #expect(await runtime.workspaces.list().isEmpty)
}

@Test(.timeLimit(.minutes(1))) func focusFollowsTheAgentAcrossTabTerminalChatAndIdle() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Focus")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(id)
    #expect(runtime.focus.state(id).surface == .idle)

    _ = await call(runtime, "workspace.openTab", ["url": .string("https://swift.org")], origin: .chat, workspace: id)
    #expect(runtime.focus.state(id) == .init(surface: .tab, url: "https://swift.org"))

    _ = try await runtime.terminals.waitForPrompt(workspace.terminalID!, timeout: 15)
    _ = await call(runtime, "workspace.run", ["command": .string("true")], origin: .chat, workspace: id)
    #expect(runtime.focus.state(id).surface == .terminal)

    // Streamed text brings it back to chat; whitespace alone doesn't.
    runtime.trackConversation(.delta(conversationID: workspace.conversationID!, messageID: "m", text: "  "))
    #expect(runtime.focus.state(id).surface == .terminal)
    runtime.trackConversation(.delta(conversationID: workspace.conversationID!, messageID: "m", text: "Here is what I found"))
    #expect(runtime.focus.state(id).surface == .chat)

    // A finished turn is idle.
    var conversation = try await runtime.conversations.get(workspace.conversationID!)
    conversation.messages = [ChatMessage(id: "m", role: .assistant, text: "done", createdAt: 0, status: .complete, error: nil, tools: [])]
    runtime.trackConversation(.updated(conversation))
    #expect(runtime.focus.state(id).surface == .idle)

    // Notes the agent writes land in its folder and take focus.
    let note = await call(runtime, "workspace.note", ["title": .string("Summary"), "markdown": .string("# Findings\n- one")], origin: .chat, workspace: id)
    let noteID = try #require(note.result?["note"]?.stringValue)
    #expect(try await runtime.workspaces.get(id).tabs.contains { $0.url == "about:lima?note=\(noteID)" })
    #expect(runtime.focus.state(id).surface == .tab)
    #expect(try await runtime.notes.get(noteID).markdown.contains("Findings"))
    try await runtime.terminals.close(workspace.terminalID!)
}

@Test(.timeLimit(.minutes(1))) func browserAnswersTabRequestsForTheAgent() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Tabs")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(id)

    // Stand-in for the browser: answer the request it broadcasts.
    let request = Task { await call(runtime, "workspace.readTab", ["url": .string("https://example.com")], origin: .chat, workspace: id) }
    var requestID: String?
    for _ in 0..<50 where requestID == nil {
        try await Task.sleep(for: .milliseconds(20))
        requestID = runtime.browserCalls.pendingIDs.first
    }
    let pending = try #require(requestID)
    let notBrowser = await call(runtime, "workspace.browserReply", ["requestId": .string(pending), "result": .string("x")], origin: .chat, workspace: id)
    #expect(notBrowser.error?.code == .notAuthorized)
    _ = await call(runtime, "workspace.browserReply", ["requestId": .string(pending), "result": .object(["text": .string("Example Domain")])])
    let answered = await request.value
    #expect(answered.result?["text"]?.stringValue == "Example Domain")
    #expect(runtime.focus.state(id) == .init(surface: .tab, url: "https://example.com"))
    try await runtime.terminals.close(workspace.terminalID!)
}

@Test func fileTreeIsLimitedToHomeAndWorkspaces() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Files")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(id)
    try FileManager.default.createDirectory(atPath: workspace.directory + "/src", withIntermediateDirectories: true)
    try "print(1)".write(toFile: workspace.directory + "/src/main.py", atomically: true, encoding: .utf8)

    let listing = await call(runtime, "fs.list", ["path": .string(workspace.directory)])
    #expect(listing.result?.arrayValue?.first?["name"]?.stringValue == "src")
    let read = await call(runtime, "fs.read", ["path": .string(workspace.directory + "/src/main.py")])
    #expect(read.result?["text"]?.stringValue == "print(1)")
    #expect(await call(runtime, "fs.list", ["path": .string("/etc")]).error?.code == .notAuthorized)
    #expect(await call(runtime, "fs.list", ["path": .string("~/Library")]).error?.code == .notAuthorized)
    #expect(await call(runtime, "fs.read", ["path": .string(workspace.directory + "/src/main.py")], origin: .mcp).error?.code == .notAuthorized)
    if let t = workspace.terminalID { try await runtime.terminals.close(t) }
}

@Test func whisperMarkersAreRemovedFromDictation() {
    #expect(DictationService.clean(" [BLANK_AUDIO]\n Hello there. [SPEAKER_TURN]\n  How are you? (music)\n") == "Hello there. How are you?")
}

/// Real on-device transcription with the 4.x engine, when it's installed.
@Test(.timeLimit(.minutes(2))) func whisperTranscribesSpeech() async throws {
    guard DictationService.engine() != nil else { return }
    let wav = TestEnvironment.freshDirectory().appendingPathExtension("wav")
    let say = Process()
    say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    say.arguments = ["-o", wav.path, "--data-format=LEI16@16000", "Lima dictation works on this Mac."]
    try say.run(); say.waitUntilExit()
    defer { try? FileManager.default.removeItem(at: wav) }
    let text = try await DictationService().transcribe(wav)
    #expect(text.lowercased().contains("dictation"))
}
