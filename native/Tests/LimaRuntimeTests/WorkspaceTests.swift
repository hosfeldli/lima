import Foundation
import Testing
@testable import LimaAgentSupervisor
import LimaAuthorization
@testable import LimaProtocol
@testable import LimaRuntime

func workspaceRuntime() async throws -> (Runtime, URL) {
    let dir = TestEnvironment.freshDirectory()
    let runtime = try await Runtime.open(paths: RuntimePaths(data: dir, socket: dir.appendingPathComponent("s").path, lock: dir.appendingPathComponent("l").path))
    return (runtime, dir)
}

func call(_ runtime: Runtime, _ method: String, _ params: [String: JSONValue] = [:], origin: ActionOrigin = .browser, workspace: String? = nil) async -> BridgeResponse {
    await runtime.handle(BridgeRequest(id: "t", method: method, params: .object(params)), context: CallContext(client: nil, origin: origin, workspaceID: workspace))
}

@Test(.timeLimit(.minutes(1))) func workspaceBindsFolderTerminalAndAgent() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let created = await call(runtime, "workspace.create", ["name": .string("Launch Research")])
    let id = try #require(created.result?["id"]?.stringValue)
    let directory = try #require(created.result?["directory"]?.stringValue)
    #expect(directory.hasSuffix("/launch-research"))
    #expect(FileManager.default.fileExists(atPath: directory))
    #expect(created.result?["token"]?.stringValue == "", "token must never reach the browser")

    let workspace = try await runtime.workspaces.get(id)
    let terminal = try await runtime.terminals.info(workspace.terminalID!)
    #expect(terminal.cwd == directory)
    #expect(terminal.owner == "agent:\(workspace.agentID)")
    let conversation = try await runtime.conversations.get(workspace.conversationID!)
    #expect(conversation.workspaceID == id && conversation.workingDirectory == directory)

    // The agent's CLI gets Lima's MCP tools bound by token, edits confined to cwd.
    let config = await runtime.workspaceAgentConfiguration(conversation)
    let mcp = try #require(config.arguments.firstIndex(of: "--mcp-config").map { config.arguments[$0 + 1] })
    #expect(mcp.contains(workspace.token) && mcp.contains("\"mcp\""))
    #expect(config.arguments.contains("acceptEdits"))
    #expect(await runtime.workspaces.id(forToken: workspace.token) == id)
    try await runtime.terminals.close(workspace.terminalID!)
}

@Test(.timeLimit(.minutes(1))) func agentIsConfinedToItsWorkspace() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let a = try #require(await call(runtime, "workspace.create", ["name": .string("A")]).result?["id"]?.stringValue)
    let b = try #require(await call(runtime, "workspace.create", ["name": .string("B")]).result?["id"]?.stringValue)

    let opened = await call(runtime, "workspace.openTab", ["url": .string("https://developer.apple.com"), "title": .string("Apple Docs")], origin: .chat, workspace: a)
    #expect(opened.ok)
    let filed = await call(runtime, "workspace.bookmark", ["url": .string("https://swift.org"), "title": .string("Swift"), "folder": .string(" Research / Lang ")], origin: .chat, workspace: a)
    #expect(filed.result?["filed"]?.stringValue == "A/Research/Lang")
    let crossed = await call(runtime, "workspace.openTab", ["id": .string(b), "url": .string("https://example.com")], origin: .chat, workspace: a)
    #expect(crossed.error?.code == .notAuthorized)
    let badScheme = await call(runtime, "workspace.openTab", ["url": .string("file:///etc/passwd")], origin: .chat, workspace: a)
    #expect(badScheme.error?.code == .badRequest)
    let unbound = await call(runtime, "workspace.openTab", ["id": .string(a), "url": .string("https://example.com")], origin: .mcp)
    #expect(unbound.error?.code == .notAuthorized)

    let stored = try await runtime.workspaces.get(a)
    #expect(stored.tabs.map(\.url) == ["https://developer.apple.com"])
    #expect(stored.bookmarks.first?.folder == "Research/Lang")
    let deleteByAgent = await call(runtime, "workspace.delete", ["id": .string(a)], origin: .chat, workspace: a)
    #expect(deleteByAgent.error?.code == .notAuthorized)
    for id in [a, b] { if let t = try await runtime.workspaces.get(id).terminalID { try? await runtime.terminals.close(t) } }
}

@Test(.timeLimit(.minutes(1))) func agentRunsVisiblyInWorkspaceTerminalUntilUserTakesOver() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Build")]).result?["id"]?.stringValue)
    let workspace = try await runtime.workspaces.get(id)
    _ = try await runtime.terminals.waitForPrompt(workspace.terminalID!, timeout: 15)

    let ran = await call(runtime, "workspace.run", ["command": .string("pwd && echo built > out.txt")], origin: .chat, workspace: id)
    #expect(ran.ok, "\(String(describing: ran.error))")
    #expect(ran.result?["output"]?.stringValue?.contains(workspace.directory) == true)
    #expect(FileManager.default.fileExists(atPath: workspace.directory + "/out.txt"))
    let files = await call(runtime, "workspace.files", [:], origin: .chat, workspace: id)
    #expect(files.result?.arrayValue?.contains { $0["name"]?.stringValue == "out.txt" } == true)

    let risky = await call(runtime, "workspace.run", ["command": .string("git push --force origin main")], origin: .chat, workspace: id)
    #expect(risky.error?.code == .confirmationRequired)

    try await runtime.terminals.userWrite(workspace.terminalID!, data: Data(" ".utf8))
    let afterTakeover = await call(runtime, "workspace.run", ["command": .string("ls")], origin: .chat, workspace: id)
    #expect(afterTakeover.error?.code == .confirmationRequired)
    #expect(try await runtime.terminals.info(workspace.terminalID!).pendingRequests == [workspace.agentID])
    try await runtime.terminals.close(workspace.terminalID!)
}

@Test(.timeLimit(.minutes(1))) func workspaceTerminalIsRecreatedAfterItEnds() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let id = try #require(await call(runtime, "workspace.create", ["name": .string("Heal")]).result?["id"]?.stringValue)
    let original = try await runtime.workspaces.get(id).terminalID!
    try await runtime.terminals.close(original) // simulate a runtime restart losing the shell
    let ran = await call(runtime, "workspace.run", ["command": .string("echo healed")], origin: .chat, workspace: id)
    #expect(ran.ok, "\(String(describing: ran.error))")
    #expect(ran.result?["output"]?.stringValue?.contains("healed") == true)
    let replacement = try await runtime.workspaces.get(id).terminalID!
    #expect(replacement != original)
    #expect(try await runtime.terminals.info(replacement).cwd == (try await runtime.workspaces.get(id).directory))
    try await runtime.terminals.close(replacement)
}
