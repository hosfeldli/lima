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
    // A helper starting another agent asks; declined, nothing starts.
    let (nested, card) = try await answeringApproval(runtime, approve: false) {
        await call(runtime, "agent.spawn", ["name": .string("x"), "task": .string("y")], origin: .chat, workspace: helper.id)
    }
    #expect(card?["question"]?.stringValue == "Let pricing-scout start another agent?")
    #expect(nested.error?.code == .notAuthorized)

    // Its preamble says it's a helper with a task.
    let conversation = try await runtime.conversations.get(helper.conversationID!)
    let config = await runtime.workspaceAgentConfiguration(conversation)
    #expect(config.arguments.joined(separator: " ").contains("helper agent"))

    // Removing the workspace removes its helpers.
    _ = await call(runtime, "workspace.delete", ["id": .string(parentID)])
    #expect(await runtime.workspaces.list().isEmpty)
}

@Test(.timeLimit(.minutes(1))) func focusFollowsTheAgentAcrossTabChatAndIdle() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Focus")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(id)
    #expect(runtime.focus.state(id).surface == .idle)

    _ = await call(runtime, "workspace.openTab", ["url": .string("https://swift.org")], origin: .chat, workspace: id)
    #expect(runtime.focus.state(id) == .init(surface: .tab, url: "https://swift.org"))

    // Streamed text brings it back to chat; whitespace alone doesn't.
    runtime.trackConversation(.delta(conversationID: workspace.conversationID!, messageID: "m", text: "  "))
    #expect(runtime.focus.state(id) == .init(surface: .tab, url: "https://swift.org"))
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
}

@Test(.timeLimit(.minutes(1))) func webInteractionRequiresAnApprovedSessionForTheBoundWorkspace() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Browser Approval")]).result?["id"]?.stringValue)
    let url = JSONValue.string("http://localhost:3000/")
    _ = await call(runtime, "workspace.openTab", ["url": url], origin: .chat, workspace: id)
    let click = await call(runtime, "workspace.browserAction", ["url": url, "action": .string("click")], origin: .chat, workspace: id)
    #expect(click.error?.code == .confirmationRequired)
    let waiting = Task { await call(runtime, "workspace.browserPlan", [
        "url": url, "goal": .string("Try the controls"), "plan": .string("Click the button to download a sample."), "actions": .string("click"), "paths": .string("/details, /search"),
    ], origin: .chat, workspace: id) }
    var prompt: JSONValue?
    for _ in 0..<40 {
        prompt = await runtime.workspacePrompts.list().arrayValue?.first
        if prompt != nil { break }
        try await Task.sleep(for: .milliseconds(15))
    }
    let request = try #require(prompt?["id"]?.stringValue)
    #expect(prompt?["approval"]?.boolValue == true)
    let fromAgent = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(true)], origin: .chat, workspace: id)
    #expect(fromAgent.error?.code == .notAuthorized)
    let fromUser = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(true)])
    #expect(fromUser.ok)
    let token = try #require(await waiting.value.result?["session"]?.stringValue)
    #expect(await runtime.workspacePrompts.permittedPaths(token, family: id, url: "http://localhost:3000/", action: "click") == Set(["/", "/details", "/search"]))
    #expect(await runtime.workspacePrompts.permittedPaths(token, family: id, url: "http://localhost:3000/", action: "type") == nil)
    #expect(await runtime.workspacePrompts.permittedPaths(token, family: "another", url: "http://localhost:3000/", action: "click") == nil)
    await runtime.terminals.closeAll()
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
    #expect(runtime.focus.state(id) == .init(surface: .tab, url: "https://example.com"))
    let notBrowser = await call(runtime, "workspace.browserReply", ["requestId": .string(pending), "result": .string("x")], origin: .chat, workspace: id)
    #expect(notBrowser.error?.code == .notAuthorized)
    _ = await call(runtime, "workspace.browserReply", ["requestId": .string(pending), "result": .object(["text": .string("Example Domain")])])
    let answered = await request.value
    #expect(answered.result?["text"]?.stringValue == "Example Domain")
    #expect(runtime.focus.state(id) == .init(surface: .chat))
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

@Test(.timeLimit(.minutes(1))) func workspaceQuestionReturnsTypedReservationFields() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let created = await call(runtime, "workspace.create", ["name": .string("Reservation form")])
    let id = try #require(created.result?["id"]?.stringValue)
    let fields: JSONValue = .array([
        .object(["id": .string("date"), "label": .string("Date"), "type": .string("date")]),
        .object(["id": .string("time"), "label": .string("Time"), "type": .string("time")]),
        .object(["id": .string("partySize"), "label": .string("Guests"), "type": .string("number"), "min": .number(1)]),
    ])
    let waiting = Task { await call(runtime, "workspace.askUser", ["question": .string("Reservation details"), "fields": fields], origin: .chat, workspace: id) }
    var prompt: JSONValue?
    for _ in 0..<40 {
        prompt = await runtime.workspacePrompts.list().arrayValue?.first
        if prompt != nil { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    let request = try #require(prompt?["id"]?.stringValue)
    #expect(prompt?["fields"] == fields)
    var answers: [String: JSONValue] = ["date": .string("2028-02-30"), "time": .string("19:00"), "partySize": .number(4)]
    let badDate = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(true), "values": .object(answers)])
    #expect(badDate.error?.code == .badRequest)
    #expect(await runtime.workspacePrompts.list().arrayValue?.count == 1)
    answers["date"] = .string("2028-02-29")
    let sent = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(true), "values": .object(answers)])
    #expect(sent.ok)
    #expect(await waiting.value.result?["values"] == .object(answers))
    #expect(await runtime.workspacePrompts.list().arrayValue?.isEmpty == true)
    if let terminal = created.result?["terminalID"]?.stringValue { try await runtime.terminals.close(terminal) }
}

@Test(.timeLimit(.minutes(1))) func locationRequestDoesNotQueryTheBrowserWithoutApproval() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let created = await call(runtime, "workspace.create", ["name": .string("Location consent")])
    let id = try #require(created.result?["id"]?.stringValue)
    let waiting = Task { await call(runtime, "workspace.location", ["purpose": .string("Find nearby cafés")], origin: .chat, workspace: id) }
    var prompt: JSONValue?
    for _ in 0..<40 {
        prompt = await runtime.workspacePrompts.list().arrayValue?.first
        if prompt != nil { break }
        try await Task.sleep(for: .milliseconds(10))
    }
    let request = try #require(prompt?["id"]?.stringValue)
    #expect(prompt?["actionLabel"] == .string("Share once"))
    #expect(runtime.browserCalls.pendingIDs.isEmpty)
    let declined = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(false)])
    #expect(declined.ok)
    #expect(await waiting.value.result == .object(["approved": .bool(false)]))
    #expect(runtime.browserCalls.pendingIDs.isEmpty)
    if let terminal = created.result?["terminalID"]?.stringValue { try await runtime.terminals.close(terminal) }
}

@Test func routineBrowserPlansSkipThePromptAndRealMoneyPlansAlwaysAsk() async throws {
    let (runtime, directory) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: directory) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Routine plan")]).result?["id"]?.stringValue)
    let url = "https://chatgpt.com/"
    let params: [String: JSONValue] = ["url": .string(url), "goal": .string("Open a conversation"),
                                      "plan": .string("Click the requested sidebar item."), "actions": .string("click")]
    let routine = await call(runtime, "workspace.browserPlan", params, origin: .chat, workspace: id)
    #expect(routine.result?["approved"]?.boolValue == true)
    #expect(try await runtime.workspaces.get(id).tabs.contains { $0.url == url })
    #expect(await runtime.workspacePrompts.list().arrayValue?.isEmpty == true)
    // A real-money plan asks every time, with the full request, and never remembers the answer.
    for answer in [false, true, false] {
        let wager = Task { await call(runtime, "workspace.browserPlan", params.merging(["plan": .string("Place a bet of 0.30 SC.")]) { _, new in new },
                                      origin: .chat, workspace: id) }
        var prompt: JSONValue?
        for _ in 0..<80 {
            prompt = await runtime.workspacePrompts.list().arrayValue?.first
            if prompt != nil { break }
            try await Task.sleep(for: .milliseconds(15))
        }
        let request = try #require(prompt?["id"]?.stringValue)
        #expect(prompt?["approval"]?.boolValue == true)
        #expect(prompt?["question"]?.stringValue == "Open a conversation")
        #expect(prompt?["detail"]?.stringValue?.contains("Place a bet of 0.30 SC.") == true)
        #expect(prompt?["risk"]?.stringValue == "money")
        _ = await call(runtime, "workspace.promptReply", ["id": .string(request), "approved": .bool(answer)])
        let result = await wager.value
        #expect(result.result?["approved"]?.boolValue == answer)
    }
    await runtime.terminals.closeAll()
}

private func pendingPrompt(_ runtime: Runtime) async throws -> JSONValue {
    for _ in 0..<80 {
        if let prompt = await runtime.workspacePrompts.list().arrayValue?.first { return prompt }
        try await Task.sleep(for: .milliseconds(15))
    }
    throw BridgeError(.deadlineExceeded, "no prompt")
}

@Test(.timeLimit(.minutes(1))) func moneyPlansAskWithOnceOrTaskAndTaskApprovalCoversHelpers() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let leadID = try #require(await call(runtime, "workspace.create", ["name": .string("Challenge")]).result?["id"]?.stringValue)
    let helper = try await runtime.spawnAgent(parent: try await runtime.workspaces.get(leadID), name: "dealer", task: "Play", provider: nil, startTask: false)
    let url = JSONValue.string("https://stake.example/casino/games/blackjack")
    let plan: [String: JSONValue] = ["url": url, "goal": .string("Place a bet of 0.15 Stake Cash per hand"),
                                     "plan": .string("Set the bet and click Play."), "actions": .string("click,type")]

    let lead = Task { await call(runtime, "workspace.browserPlan", plan, origin: .chat, workspace: leadID) }
    let prompt = try await pendingPrompt(runtime)
    #expect(prompt["risk"]?.stringValue == "money")
    #expect(prompt["allowTask"]?.boolValue == true)
    #expect(prompt["facts"]?.arrayValue?.first?["value"]?.stringValue == "stake.example")
    #expect(await call(runtime, "workspace.promptReply", ["id": prompt["id"]!, "approved": .bool(true), "scope": .string("task")]).ok)
    let token = try #require(await lead.value.result?["session"]?.stringValue)
    #expect(await runtime.workspacePrompts.isTrusted(token))

    // The helper's identical plan is covered by the lead's approval: no prompt.
    let shared = await call(runtime, "workspace.browserPlan", plan, origin: .chat, workspace: helper.id)
    #expect(shared.result?["session"]?.stringValue == token)
    #expect(await runtime.workspacePrompts.permittedPaths(token, family: leadID, url: "https://stake.example/casino/games/blackjack", action: "click") != nil)
    await runtime.terminals.closeAll()
}

@Test func onceApprovalsDontCoverMoneyStepsButTaskApprovalsDo() async {
    let prompts = WorkspacePrompts()
    let now = Date()
    let token = await prompts.authorize(family: "lead", url: "https://stake.example/play", paths: ["/play"], actions: ["click"], now: now)
    #expect(await !prompts.isTrusted(token))
    #expect(await prompts.covering(family: "lead", url: "https://stake.example/x", paths: ["/play"], actions: ["click"], highRisk: true, now: now) == nil)
    #expect(await prompts.covering(family: "lead", url: "https://stake.example/x", paths: ["/play"], actions: ["click"], highRisk: false, now: now) == token)
    #expect(await prompts.covering(family: "other", url: "https://stake.example/x", paths: ["/play"], actions: ["click"], highRisk: false, now: now) == nil)
    let paths = await prompts.grant(token, trust: true, path: "/cashier", now: now)
    #expect(paths == ["/play", "/cashier"])
    #expect(await prompts.isTrusted(token))
    // Each use renews an idle session, but never past its limit.
    #expect(await prompts.permittedPaths(token, family: "lead", url: "https://stake.example/play", action: "click", now: now.addingTimeInterval(240)) != nil)
    #expect(await prompts.permittedPaths(token, family: "lead", url: "https://stake.example/play", action: "click", now: now.addingTimeInterval(500)) != nil)
    #expect(await prompts.permittedPaths(token, family: "lead", url: "https://stake.example/play", action: "click", now: now.addingTimeInterval(900)) == nil)
}
