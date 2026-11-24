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

/// Runs a call that should stop at an approval card, answers the card, and
/// returns the call's result with the card that was shown.
func answeringApproval(_ runtime: Runtime, approve: Bool, scope: String? = nil,
                       _ body: @escaping @Sendable () async -> BridgeResponse) async throws -> (BridgeResponse, JSONValue?) {
    let task = Task { await body() }
    var card: JSONValue?
    for _ in 0..<200 {
        if let first = await runtime.workspacePrompts.list().arrayValue?.first { card = first; break }
        try await Task.sleep(for: .milliseconds(20))
    }
    if let id = card?["id"]?.stringValue {
        try await runtime.workspacePrompts.answer(runtime, id: id, approved: approve, text: nil, scope: scope)
    }
    return (await task.value, card)
}

func call(_ runtime: Runtime, _ method: String, _ params: [String: JSONValue] = [:], origin: ActionOrigin = .browser, workspace: String? = nil) async -> BridgeResponse {
    await runtime.handle(BridgeRequest(id: "t", method: method, params: .object(params)), context: CallContext(client: nil, origin: origin, workspaceID: workspace))
}

@Test(.timeLimit(.minutes(1))) func workspaceBindsFolderAndAgent() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let created = await call(runtime, "workspace.create", ["name": .string("Launch Research")])
    let id = try #require(created.result?["id"]?.stringValue)
    let directory = try #require(created.result?["directory"]?.stringValue)
    #expect(directory.hasSuffix("/launch-research"))
    #expect(FileManager.default.fileExists(atPath: directory))
    #expect(created.result?["token"]?.stringValue == "", "token must never reach the browser")

    let workspace = try await runtime.workspaces.get(id)
    #expect(workspace.terminalID == nil, "agents use their own shell tools")
    let conversation = try await runtime.conversations.get(workspace.conversationID!)
    #expect(conversation.workspaceID == id && conversation.workingDirectory == directory)

    // The agent's CLI gets tools bound by workspace token.
    let config = await runtime.workspaceAgentConfiguration(conversation)
    let mcp = try #require(config.arguments.firstIndex(of: "--mcp-config").map { config.arguments[$0 + 1] })
    #expect(mcp.contains(workspace.token) && mcp.contains("\"mcp\""))
    #expect(config.arguments.contains("bypassPermissions"))
    #expect(await runtime.workspaces.id(forToken: workspace.token) == id)
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

@Test(.timeLimit(.minutes(1))) func workspaceNamingAndDeletionStayInSyncWithChat() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = await call(runtime, "workspace.create", ["name": .string("New Workspace")])
    let id = try #require(workspace.result?["id"]?.stringValue)
    let chat = try #require(workspace.result?["conversationID"]?.stringValue)
    #expect(try await runtime.workspaces.get(id).isUnnamed)
    let named = await call(runtime, "workspace.rename", ["name": .string("Release Notes")], origin: .chat, workspace: id)
    #expect(named.result?["name"]?.stringValue == "Release Notes")
    #expect(try await runtime.conversations.get(chat).title == "✦ Release Notes")
    let unchanged = await call(runtime, "workspace.rename", ["name": .string("Another Name")], origin: .chat, workspace: id)
    #expect(unchanged.result?["name"]?.stringValue == "Release Notes")
    let original = URL(fileURLWithPath: try await runtime.conversations.get(chat).workingDirectory)
    try Data("archive test content".utf8).write(to: original.appendingPathComponent("draft.txt"))
    let deletion = await call(runtime, "workspace.delete", ["id": .string(id)])
    #expect(deletion.ok, "\(String(describing: deletion.error))")
    let archive = URL(fileURLWithPath: try #require(deletion.result?["archivePath"]?.stringValue))
    defer { try? FileManager.default.removeItem(at: archive) }
    #expect(await runtime.visibleConversations().allSatisfy { $0.id != chat })
    #expect((await call(runtime, "workspace.list")).result?.arrayValue?.allSatisfy { $0["id"]?.stringValue != id } == true)
    #expect(!FileManager.default.fileExists(atPath: original.path))
    #expect(archive.pathExtension == "zip")
    #expect(try archivedText(archive, "\(original.lastPathComponent)/draft.txt") == "archive test content")
}

@Test func companionRecognizesExplicitWorkspaceCreation() {
    let request = Runtime.workspaceRequest(in: "Create a new AI Workspace called **Escape Room Experiment**.\n\nBuild a game.")
    #expect(request.requested)
    #expect(request.name == "Escape Room Experiment")
    #expect(Runtime.workspaceRequest(in: "Please create a workspace named “Research notes”.").name == "Research notes")
    #expect(!Runtime.workspaceRequest(in: "Build a game in the current workspace.").requested)
}

@Test func browserTestHelperIsConfinedToItsAssignedTab() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let parent = try await runtime.createWorkspace(name: "Builder", directory: nil, provider: .claude, parentID: nil, task: nil, startTask: false)
    let scope = "http://127.0.0.1:3000/"
    let browserDir = dir.appendingPathComponent("browser")
    try FileManager.default.createDirectory(at: browserDir, withIntermediateDirectories: true)
    let helper = try await runtime.createWorkspace(name: "Tester", directory: nil, provider: .claude, parentID: parent.id, task: nil,
        existingDirectory: browserDir, temporary: true, startTask: false, browserTestURL: scope)
    #expect(helper.terminalID == nil)
    #expect(helper.directory != parent.directory)
    #expect(helper.tabs.map(\.url) == [scope])
    // Reaching beyond its tab asks the user; declined, the call fails.
    for method in ["workspace.files", "workspace.readTab", "workspace.openTab", "notes.list", "capabilities.list"] {
        let (result, card) = try await answeringApproval(runtime, approve: false) { await call(runtime, method, origin: .chat, workspace: helper.id) }
        #expect(card?["question"]?.stringValue == "Let Tester go beyond its browser tab?")
        #expect(result.error?.code == .notAuthorized)
    }
    let conversation = try await runtime.conversations.get(helper.conversationID!)
    let config = await runtime.workspaceAgentConfiguration(conversation)
    #expect(config.arguments.contains("--strict-mcp-config"))
    #expect(config.arguments.contains("--tools"))
    #expect(config.arguments.contains(""))
}

@Test func workspaceArchivePreservesLinkedFolderAndHidesItsHelper() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let linked = dir.appendingPathComponent("linked", isDirectory: true)
    try FileManager.default.createDirectory(at: linked, withIntermediateDirectories: true)
    try Data("shared source".utf8).write(to: linked.appendingPathComponent("example.txt"))
    let workspace = try await runtime.createWorkspace(name: "Linked", directory: nil, provider: .claude,
        parentID: nil, task: nil, existingDirectory: linked, startTask: false)
    let helper = try await runtime.spawnAgent(parent: workspace, name: "Helper", task: "Test", provider: nil, startTask: false)
    let deletion = await call(runtime, "workspace.delete", ["id": .string(workspace.id)])
    #expect(deletion.ok, "\(String(describing: deletion.error))")
    let archive = URL(fileURLWithPath: try #require(deletion.result?["archivePath"]?.stringValue))
    defer { try? FileManager.default.removeItem(at: archive) }
    #expect(deletion.result?["directoryKept"]?.stringValue == linked.path)
    #expect(FileManager.default.fileExists(atPath: linked.appendingPathComponent("example.txt").path))
    #expect(await runtime.workspaces.list().allSatisfy { $0.id != workspace.id && $0.id != helper.id })
    #expect(await runtime.visibleConversations().allSatisfy { $0.id != workspace.conversationID && $0.id != helper.conversationID })
    #expect(try archivedText(archive, "linked/example.txt") == "shared source")
}

@Test func failedWorkspaceArchiveKeepsTheWorkspaceVisible() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try await runtime.createWorkspace(name: "Archive Failure", directory: nil, provider: .claude,
        parentID: nil, task: nil, startTask: false)
    try FileManager.default.removeItem(atPath: workspace.directory) // isolated test folder
    let deletion = await call(runtime, "workspace.delete", ["id": .string(workspace.id)])
    #expect(!deletion.ok)
    #expect(await runtime.workspaces.list().contains { $0.id == workspace.id })
    try await runtime.workspaces.requireActive(workspace.id)
}

@Test func anotherTerminalProtectsTheWorkspaceFolderFromArchive() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try await runtime.createWorkspace(name: "Terminal Archive Guard", directory: nil, provider: .claude,
        parentID: nil, task: nil, startTask: false)
    let other = try await runtime.terminals.create(cwd: workspace.directory, shell: "/bin/zsh")
    let blocked = await call(runtime, "workspace.delete", ["id": .string(workspace.id)])
    #expect(blocked.error?.code == .badRequest)
    #expect(FileManager.default.fileExists(atPath: workspace.directory))
    try await runtime.workspaces.requireActive(workspace.id)

    try await runtime.terminals.close(other.id)
    let deletion = await call(runtime, "workspace.delete", ["id": .string(workspace.id)])
    let archive = URL(fileURLWithPath: try #require(deletion.result?["archivePath"]?.stringValue))
    defer { try? FileManager.default.removeItem(at: archive) }
    #expect(!FileManager.default.fileExists(atPath: workspace.directory))
}

@Test func archiveReservesTheOriginalPathWhileTheFolderIsStaged() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let workspace = try await runtime.createWorkspace(name: "Archive Reservation", directory: nil, provider: .claude,
        parentID: nil, task: nil, startTask: false)
    let original = URL(fileURLWithPath: workspace.directory, isDirectory: true)
    let staging = WorkspaceArchive.stagingDirectory(for: workspace)
    let staged = staging.appendingPathComponent(original.lastPathComponent, isDirectory: true)
    _ = try await runtime.workspaces.beginRemoval(workspace.id)
    await #expect(throws: BridgeError.self) { try await runtime.workspaces.requireDirectoryAvailable(workspace.directory) }
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
    try FileManager.default.moveItem(at: original, to: staged)

    let created = try await runtime.workspaces.resolveDirectory(name: workspace.name, requested: nil)
    defer { try? FileManager.default.removeItem(at: created) }
    #expect(created.path != original.path)
    #expect(!FileManager.default.fileExists(atPath: original.path))
    WorkspaceArchive.recover(workspace)
    #expect(FileManager.default.fileExists(atPath: original.path))
    await runtime.workspaces.cancelRemoval([workspace.id])
}

private func archivedText(_ archive: URL, _ entry: String) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    process.arguments = ["-p", archive.path, entry]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let data = output.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    return String(decoding: data, as: UTF8.self)
}

@Test func consequentialBrowserPlansAskTheUserInsteadOfRefusing() {
    #expect(WorkspacePrompts.browserReview(goal: "Play 20 rounds of blackjack", plan: "Switch to Stake Cash and place bets of 0.30 SC") == .highRisk)
    #expect(WorkspacePrompts.browserReview(goal: "Buy the book", plan: "Go to checkout") == .needsUser)
    #expect(WorkspacePrompts.browserReview(goal: "Read the docs", plan: "Scroll the page") == .routine)
}
