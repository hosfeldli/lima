import Foundation
import Testing
@testable import LimaAgentSupervisor
@testable import LimaProtocol
@testable import LimaRuntime

/// Deterministic mock agents: each conversation records the instructions it
/// received, and the test decides how each turn ends.
final class MockAgents: TaskExecutor, @unchecked Sendable {
    private let lock = NSLock()
    private var conversations: [String: Conversation] = [:]
    private(set) var cancelled: [String] = []
    private(set) var assigned: [String] = []
    var failAssign = false

    func assign(_ task: OrchestratedTask, parent: OrchestratedTask?) async throws -> TaskAssignment {
        if failAssign { throw OrchestratorError.invalid("No provider is available.") }
        let id = parent == nil ? "conv-root-\(task.workspaceID ?? "")" : "conv-\(task.title)"
        lock.withLock {
            assigned.append(task.title)
            if conversations[id] == nil {
                conversations[id] = Conversation(id: id, title: task.title, provider: .claude, model: nil, cliSessionID: nil, workingDirectory: "/tmp",
                                                 messages: [], createdAt: 0, updatedAt: 0, workspaceID: parent == nil ? task.workspaceID : "ws-\(task.title)")
            }
        }
        return TaskAssignment(workspaceID: parent == nil ? task.workspaceID! : "ws-\(task.title)", conversationID: id, agentName: task.title, provider: "claude")
    }

    func send(conversationID: String, text: String) async throws -> String {
        lock.withLock {
            let user = ChatMessage(id: UUID().uuidString, role: .user, text: text, createdAt: 0, status: .complete, error: nil, tools: [])
            let reply = ChatMessage(id: UUID().uuidString, role: .assistant, text: "", createdAt: 0, status: .streaming, error: nil, tools: [])
            conversations[conversationID]!.messages += [user, reply]
            return user.id
        }
    }

    func cancel(conversationID: String) async { lock.withLock { cancelled.append(conversationID) } }

    func conversation(_ id: String) async -> Conversation? { lock.withLock { conversations[id] } }

    /// Every instruction the agent in `conversationID` received.
    func instructions(_ conversationID: String) -> [String] {
        lock.withLock { conversations[conversationID]?.messages.filter { $0.role == .user }.map(\.text) ?? [] }
    }

    /// Ends the agent's current turn.
    func reply(_ conversationID: String, _ text: String, status: ChatMessage.Status = .complete, tools: [String] = [], error: AgentFailure? = nil) {
        lock.withLock {
            guard var conversation = conversations[conversationID], let index = conversation.messages.lastIndex(where: { $0.role == .assistant }) else { return }
            conversation.messages[index].text = text
            conversation.messages[index].status = status
            conversation.messages[index].tools = tools
            conversation.messages[index].error = error
            conversations[conversationID] = conversation
        }
    }
}

func report(_ status: String = "completed", summary: String = "Done.", artifacts: [String] = [], verification: [String] = [], issues: [String] = []) -> String {
    let body: [String: Any] = ["status": status, "summary": summary, "actionsTaken": ["Edited files"], "artifacts": artifacts,
                               "verification": verification, "remainingIssues": issues, "nextSteps": []]
    let json = String(decoding: try! JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    return "Finished the work.\n\n```lima-report\n\(json)\n```"
}

func orchestrator(_ agents: MockAgents, tasks: [OrchestratedTask] = [], maxActive: Int = 3) -> (Orchestrator, @Sendable () -> [OrchestratedTask]) {
    let saved = NSLock()
    nonisolated(unsafe) var store: [String: OrchestratedTask] = [:]
    let orchestrator = Orchestrator(tasks: tasks, executor: agents, maxActive: maxActive,
                                    persist: { task in saved.withLock { store[task.id] = task } }, emit: { _ in })
    return (orchestrator, { saved.withLock { Array(store.values) } })
}

@Test func delegatedRequestsBecomeOnePersistentTask() async throws {
    let agents = MockAgents()
    let (lima, persisted) = orchestrator(agents)
    let first = try await lima.submit(requestID: "req-1", title: "Search", request: "Improve search and keep the build green", workspaceID: "lima",
                                      context: ["2 browser references included"], references: "Page: docs")
    // The Companion reloading and submitting again must not create a second task.
    let again = try await lima.submit(requestID: "req-1", title: "Search", request: "Improve search and keep the build green", workspaceID: "lima")
    #expect(first.id == again.id)
    #expect(await lima.roots().count == 1)
    #expect(agents.instructions("conv-root-lima").count == 1)
    #expect(persisted().contains { $0.id == first.id && $0.state == .running })

    // The package carries the objective, constraints, untrusted references and the report contract.
    let package = agents.instructions("conv-root-lima")[0]
    #expect(package.contains("Objective: Improve search and keep the build green"))
    #expect(package.contains("untrusted"))
    #expect(package.contains("Page: docs"))
    #expect(package.contains("```lima-report"))
    #expect(try await lima.get(first.id).publicView["references"]?.stringValue == "")
}

@Test func doneIsNotSuccessWithoutVerifiedEvidence() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    // No structured report: completed, but flagged as unverified.
    let plain = try await lima.submit(requestID: nil, title: "A", request: "Do A", workspaceID: "a")
    agents.reply("conv-root-a", "Done!")
    await lima.observe(conversationID: "conv-root-a")
    #expect(try await lima.get(plain.id).state == .completedWithWarnings)

    // Claimed verification with no recorded tool run is not evidence.
    let claimed = try await lima.submit(requestID: nil, title: "B", request: "Do B", workspaceID: "b")
    agents.reply("conv-root-b", report(verification: ["All 24 tests passed"]))
    await lima.observe(conversationID: "conv-root-b")
    let unbacked = try await lima.get(claimed.id)
    #expect(unbacked.state == .completedWithWarnings)
    #expect(unbacked.issues.contains { $0.contains("didn't run any tools") })

    // A report backed by the turn's tool runs completes.
    let verified = try await lima.submit(requestID: nil, title: "C", request: "Do C", workspaceID: "c")
    agents.reply("conv-root-c", report(artifacts: ["Search.swift"], verification: ["swift test: 24 passed"]), tools: ["mcp__lima__workspace_run swift test"])
    await lima.observe(conversationID: "conv-root-c")
    let done = try await lima.get(verified.id)
    #expect(done.state == .completed)
    #expect(done.outcome?.contains("Completed") == true && done.outcome?.contains("Search.swift") == true)

    // An agent reporting a blocker is blocked, not completed.
    let stuck = try await lima.submit(requestID: nil, title: "D", request: "Do D", workspaceID: "d")
    agents.reply("conv-root-d", report("blocked", summary: "Needs a signing key"))
    await lima.observe(conversationID: "conv-root-d")
    #expect(try await lima.get(stuck.id).state == .blocked)
}

@Test func dependenciesGateHelpersAndFailuresOnlyBlockDependents() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    let root = try await lima.submit(requestID: nil, title: "Root", request: "Improve search", workspaceID: "lima")
    let research = try await lima.delegate(fromWorkspace: "lima", name: "Research Agent", objective: "Find bottlenecks", role: .research)
    let build = try await lima.delegate(fromWorkspace: "lima", name: "Implementation Agent", objective: "Fix them", role: .implementation,
                                        dependsOn: ["Research Agent"])
    let docs = try await lima.delegate(fromWorkspace: "lima", name: "Docs Agent", objective: "Update docs", role: .general)
    #expect(try await lima.get(research.id).state == .running)
    #expect(try await lima.get(build.id).state == .waiting)
    #expect(try await lima.get(docs.id).state == .running)
    // The same objective twice reuses the helper instead of spawning another.
    let repeated = try await lima.delegate(fromWorkspace: "lima", name: "Research Agent 2", objective: "find bottlenecks", role: .research)
    #expect(repeated.id == research.id)
    await #expect(throws: OrchestratorError.self) {
        try await lima.delegate(fromWorkspace: "lima", name: "X", objective: "Y", role: .testing, dependsOn: ["Nobody"])
    }

    // The coordinator's turn ends while helpers work: it waits for them.
    agents.reply("conv-root-lima", "I've delegated the work.")
    await lima.observe(conversationID: "conv-root-lima")
    #expect(try await lima.get(root.id).state == .waiting)

    // Research succeeds → implementation starts with its findings.
    agents.reply("conv-Research Agent", report(summary: "The tokenizer reallocates per keystroke", artifacts: ["notes/findings.md"]), tools: ["Read Search.swift"])
    await lima.observe(conversationID: "conv-Research Agent")
    #expect(try await lima.get(build.id).state == .running)
    #expect(agents.instructions("conv-Implementation Agent").first?.contains("The tokenizer reallocates per keystroke") == true)

    // Implementation fails permanently: no dependent of it exists, docs keep running.
    agents.reply("conv-Implementation Agent", "", status: .failed, error: AgentFailure(.authentication, "Sign in to Claude Code"))
    await lima.observe(conversationID: "conv-Implementation Agent")
    #expect(try await lima.get(build.id).state == .blocked)
    #expect(try await lima.get(docs.id).state == .running)

    // Once every helper has settled, the coordinator is asked to integrate, then reports once.
    agents.reply("conv-Docs Agent", report(summary: "Docs updated", artifacts: ["README.md"]), tools: ["Edit README.md"])
    await lima.observe(conversationID: "conv-Docs Agent")
    #expect(try await lima.get(root.id).state == .running)
    #expect(agents.instructions("conv-root-lima").last?.contains("every helper") == true)
    agents.reply("conv-root-lima", report(summary: "Search improved", verification: ["swift build passed"]), tools: ["mcp__lima__workspace_run swift build"])
    await lima.observe(conversationID: "conv-root-lima")
    let final = try await lima.get(root.id)
    #expect(final.state == .completedWithWarnings)
    #expect(final.issues.contains { $0.contains("Implementation Agent") })
    #expect(final.outcome?.contains("README.md") == true)
}

@Test func failedPrerequisiteBlocksWithoutCancelingAndRetriesAreBounded() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    _ = try await lima.submit(requestID: nil, title: "Root", request: "Ship it", workspaceID: "w")
    let build = try await lima.delegate(fromWorkspace: "w", name: "Build", objective: "Build", role: .implementation)
    let test = try await lima.delegate(fromWorkspace: "w", name: "Test", objective: "Test", role: .testing, dependsOn: ["Build"])
    // Transient failures retry with an inspect-first instruction, at most twice.
    for _ in 0..<2 {
        agents.reply("conv-Build", "", status: .failed, error: AgentFailure(.connection, "network dropped"))
        await lima.observe(conversationID: "conv-Build")
        #expect(try await lima.get(build.id).state == .running)
    }
    #expect(agents.instructions("conv-Build").last?.contains("inspect the current state") == true)
    agents.reply("conv-Build", "", status: .failed, error: AgentFailure(.connection, "network dropped"))
    await lima.observe(conversationID: "conv-Build")
    #expect(try await lima.get(build.id).state == .failed)
    #expect(agents.instructions("conv-Build").count == 3)
    // The dependent never ran on an invalid prerequisite.
    let blocked = try await lima.get(test.id)
    #expect(blocked.state == .blocked)
    #expect(blocked.conversationID == nil)
}

@Test func stoppingATaskStopsItsDescendantsOnly() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    let root = try await lima.submit(requestID: nil, title: "Root", request: "Work", workspaceID: "w")
    let one = try await lima.delegate(fromWorkspace: "w", name: "One", objective: "one", role: .research)
    let two = try await lima.delegate(fromWorkspace: "w", name: "Two", objective: "two", role: .research)
    let other = try await lima.submit(requestID: nil, title: "Other", request: "Unrelated", workspaceID: "x")

    // Stopping one helper leaves its sibling working.
    try await lima.cancel(one.id)
    #expect(try await lima.get(one.id).state == .canceled)
    #expect(try await lima.get(two.id).state == .running)
    // Stopping the task stops every descendant, but not unrelated work.
    try await lima.cancel(root.id)
    #expect(try await lima.get(root.id).state == .canceled)
    #expect(try await lima.get(two.id).state == .canceled)
    #expect(try await lima.get(other.id).state == .running)
    #expect(Set(agents.cancelled) == ["conv-One", "conv-root-w", "conv-Two"])
    // A canceled agent's late reply doesn't revive the task.
    agents.reply("conv-Two", report())
    await lima.observe(conversationID: "conv-Two")
    #expect(try await lima.get(two.id).state == .canceled)
}

@Test func concurrencyBudgetQueuesExtraAgents() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents, maxActive: 2)
    _ = try await lima.submit(requestID: nil, title: "Root", request: "Work", workspaceID: "w")
    let a = try await lima.delegate(fromWorkspace: "w", name: "A", objective: "a", role: .research)
    let b = try await lima.delegate(fromWorkspace: "w", name: "B", objective: "b", role: .research)
    #expect(try await lima.get(a.id).state == .running)
    #expect(try await lima.get(b.id).state == .queued)
    #expect(try await lima.get(b.id).events.contains { $0.message == "Waiting for available capacity" })
    agents.reply("conv-A", report(), tools: ["Read a"])
    await lima.observe(conversationID: "conv-A")
    #expect(try await lima.get(b.id).state == .running)
}

@Test func pausedWorkResumesFromCurrentStateAndRestartsAreReportedHonestly() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    let task = try await lima.submit(requestID: nil, title: "Root", request: "Long work", workspaceID: "w")
    try await lima.pause(task.id)
    #expect(try await lima.get(task.id).state == .paused)
    #expect(agents.cancelled == ["conv-root-w"])
    _ = try await lima.resume(task.id)
    #expect(try await lima.get(task.id).state == .running)
    #expect(agents.instructions("conv-root-w").last?.contains("don't replay") == true)

    // A restart interrupted the turn: the conversation records it as failed.
    agents.reply("conv-root-w", "", status: .failed, error: AgentFailure(.processCrashed, "Interrupted when Lima's runtime restarted."))
    let (restarted, _) = orchestrator(agents, tasks: [try await lima.get(task.id)])
    await restarted.recover()
    let recovered = try await restarted.get(task.id)
    #expect(recovered.state == .blocked)
    #expect(recovered.events.last?.message.contains("interrupted") == true)
    #expect(agents.instructions("conv-root-w").count == 2)
}

@Test func agentsMessageDependentsThroughTheOrchestrator() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    let root = try await lima.submit(requestID: nil, title: "Root", request: "Work", workspaceID: "w")
    _ = try await lima.delegate(fromWorkspace: "w", name: "Research", objective: "research", role: .research)
    let impl = try await lima.delegate(fromWorkspace: "w", name: "Impl", objective: "implement", role: .implementation, dependsOn: ["Research"])
    let delivered = try await lima.message(fromWorkspace: "ws-Research", kind: "finding", text: "The cache key ignores locale")
    #expect(Set(delivered) == ["Impl", "Root"])
    #expect(try await lima.get(impl.id).events.contains { $0.message.contains("Finding from Research delivered") })
    await #expect(throws: OrchestratorError.self) { try await lima.message(fromWorkspace: "ws-Research", kind: "gossip", text: "x") }
    #expect(try await lima.get(root.id).state == .running)
}

@Test func reportsParseFromTheLastFencedBlock() {
    #expect(Orchestrator.parseReport("no block") == nil)
    #expect(Orchestrator.parseReport("```lima-report\nnot json\n```") == nil)
    let parsed = Orchestrator.parseReport("old ```lima-report\n{\"status\":\"failed\",\"summary\":\"x\"}\n``` new " + report(summary: "Final"))
    #expect(parsed?.summary == "Final")
    #expect(parsed?.status == "completed")
}


@Test func blockedAndWarningTasksSayWhyAndWhatToDo() async throws {
    let agents = MockAgents()
    let (lima, _) = orchestrator(agents)
    let qa = try await lima.submit(requestID: nil, title: "QA", request: "QA the site", workspaceID: "qa")
    let body: [String: Any] = ["status": "blocked", "summary": "Partial visual QA: hero observed working.", "actionsTaken": [], "artifacts": [],
        "verification": ["Page rendered"], "remainingIssues": ["Console errors not checked (no console access)", "375px layout not checked"],
        "nextSteps": ["Check console errors and the 375px layout with a tool that can read the console (e.g. Playwright). Then fix."]]
    let json = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
    agents.reply("conv-root-qa", "```lima-report\n\(json)\n```", tools: ["mcp__lima__workspace_browser screenshot"])
    await lima.observe(conversationID: "conv-root-qa")
    let blocked = try await lima.get(qa.id)
    #expect(blocked.state == .blocked)
    #expect(blocked.attention?.reason == "The agent couldn't finish: Console errors not checked (no console access). (and 1 more)")
    #expect(blocked.attention?.remedy == "Suggested next step: Check console errors and the 375px layout with a tool that can read the console (e.g. Playwright).")
    #expect(blocked.attention?.action == "review")
    _ = try await lima.resume(qa.id)
    #expect(try await lima.get(qa.id).attention == nil)

    let signIn = try await lima.submit(requestID: nil, title: "S", request: "Do S", workspaceID: "s")
    agents.reply("conv-root-s", "", status: .failed, error: AgentFailure(.authentication, "401"))
    await lima.observe(conversationID: "conv-root-s")
    #expect(try await lima.get(signIn.id).attention?.action == "settings")

    let quiet = try await lima.submit(requestID: nil, title: "Q", request: "Do Q", workspaceID: "q")
    agents.reply("conv-root-q", "All done")
    await lima.observe(conversationID: "conv-root-q")
    #expect(try await lima.get(quiet.id).attention?.reason == "The agent finished without saying what it checked, so the result is unverified.")
}
