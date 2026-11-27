import Foundation
import Testing
@testable import LimaAuthorization
@testable import LimaProtocol
@testable import LimaRuntime
@testable import LimaSearch

func openRuntime() async throws -> (Runtime, URL) {
    let dir = TestEnvironment.freshDirectory()
    let runtime = try await Runtime.open(paths: RuntimePaths(data: dir, socket: dir.appendingPathComponent("s").path, lock: dir.appendingPathComponent("l").path))
    return (runtime, dir)
}

// H1: one manifest drives every entry point.
@Test func manifestIsTheOnlySourceForSearchRailAndMCP() async throws {
    let (runtime, dir) = try await openRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let ids = runtime.capabilities.definitions.map(\.id)
    #expect(Set(ids).count == ids.count, "capability IDs must be unique")
    for capability in runtime.capabilities.definitions where capability.surfaces.search {
        let response = await runtime.search.search(capability.title, mode: .tools)
        #expect(response.results.contains { $0.key == "tool:\(capability.id)" }, "\(capability.id) not reachable from Search")
    }
    let mcp = await runtime.handle(BridgeRequest(id: "1", method: "capabilities.list"), context: CallContext(client: nil, origin: .mcp))
    let exposed = (mcp.result?.arrayValue ?? []).compactMap { $0["id"]?.stringValue }
    #expect(Set(exposed) == Set(runtime.capabilities.definitions.filter { $0.mcpScope != nil }.map(\.id)))
    // The sidebar replaced the rail: nothing points at a dashboard any more.
    #expect(runtime.capabilities.definitions.filter(\.surfaces.rail).isEmpty)
    #expect(!runtime.capabilities.definitions.contains { ["open.home", "open.workspaces", "open.agents"].contains($0.id) })
}

// H2: identical policy regardless of origin; a UI gesture is the
// confirmation, and agents and outside tools get an approval card in Lima
// instead of a refusal.
@Test(.timeLimit(.minutes(1))) func capabilityAuthorizationIsUniformAcrossOrigins() async throws {
    let (runtime, dir) = try await openRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let registry = runtime.capabilities
    let capture = registry.definition("screenshot.region")!
    let authorize: @Sendable (CapabilityDefinition, ActionOrigin, String?) async -> BridgeResponse = { definition, origin, digest in
        do {
            try await registry.authorize(definition, input: "", runtime: runtime, context: CallContext(client: nil, origin: origin), approvalDigest: digest)
            return .success(id: "a", .null)
        } catch let error as BridgeError { return .failure(id: "a", error) }
        catch { return .failure(id: "a", BridgeError(.internalError, "\(error)")) }
    }
    #expect(await authorize(capture, .browser, nil).ok)
    // An agent asks; declined, it fails; allowed, it runs.
    let (declined, card) = try await answeringApproval(runtime, approve: false) { await authorize(capture, .chat, nil) }
    #expect(card?["question"]?.stringValue == "\(capture.title)?")
    #expect(declined.error?.code == .notAuthorized)
    #expect(try await answeringApproval(runtime, approve: true) { await authorize(capture, .chat, nil) }.0.ok)
    // An outside tool without the scope asks once for the scope.
    MCPGrants.shared.scopes = []
    let (scoped, scopeCard) = try await answeringApproval(runtime, approve: true) { await authorize(capture, .mcp, nil) }
    #expect(scoped.ok)
    #expect(scopeCard?["question"]?.stringValue?.hasPrefix("Let outside AI tool use") == true)
    // With the scope granted, the risky capability still asks.
    MCPGrants.shared.scopes = ["screen:capture"]
    let (risky, riskyCard) = try await answeringApproval(runtime, approve: false) { await authorize(capture, .mcp, nil) }
    #expect(riskyCard != nil)
    #expect(risky.error?.code == .notAuthorized)
    // A recorded approval digest still works without a card.
    let operation = ActionOperation(kind: capture.risk, origin: .mcp, targets: [capture.id], arguments: [""])
    let digest = try ApprovalLedger.shared.approve(operation)
    #expect(await authorize(capture, .mcp, digest).ok)
    // Not exposed to outside tools by default: it asks rather than refusing.
    let (hidden, hiddenCard) = try await answeringApproval(runtime, approve: false) { await authorize(registry.definition("password.generate")!, .mcp, nil) }
    #expect(hiddenCard != nil)
    #expect(hidden.error?.code == .notAuthorized)
    MCPGrants.shared.scopes = ["notes:read", "search:read", "context:read"]
}

// H3: every run is observable.
@Test func runsAreRecorded() async throws {
    let (runtime, dir) = try await openRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let result = try await runtime.capabilities.run("calc", input: "6*7", runtime: runtime, context: CallContext(client: nil, origin: .browser))
    #expect(result["text"]?.stringValue == "42")
    await #expect(throws: BridgeError.self) {
        try await runtime.capabilities.run("json.format", input: "{nope", runtime: runtime, context: CallContext(client: nil, origin: .browser))
    }
    let runs = runtime.capabilities.recentRuns()
    #expect(runs.map(\.capability) == ["json.format", "calc"])
    #expect(runs[0].ok == false && runs[1].ok == true)
    let created = try await runtime.capabilities.run("note.new", input: "From a capability", runtime: runtime, context: CallContext(client: nil, origin: .browser))
    #expect(created["url"]?.stringValue?.hasPrefix("about:lima?note=") == true)
}

// Search runs a command, then its result tab shows it: one execution only.
@Test func commandsExecuteOncePerInvocation() async throws {
    let (runtime, dir) = try await openRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let browser = CallContext(client: nil, origin: .browser)
    let first = try await runtime.capabilities.run("uuid.generate", input: "", runtime: runtime, context: browser, executionID: "exec-1")
    let again = try await runtime.capabilities.run("uuid.generate", input: "", runtime: runtime, context: browser, executionID: "exec-1")
    #expect(first == again)
    #expect(runtime.capabilities.recentRuns().filter { $0.capability == "uuid.generate" }.count == 1)

    let shown = await runtime.capabilities.execution("exec-1", origin: .browser)
    #expect(shown?["status"]?.stringValue == "completed")
    #expect(shown?["result"] == first)
    #expect(runtime.capabilities.recentRuns().filter { $0.capability == "uuid.generate" }.count == 1)
    // Other origins can't read it, and an ID can't be reused for another command.
    #expect(await runtime.capabilities.execution("exec-1", origin: .mcp) == nil)
    await #expect(throws: BridgeError.self) {
        try await runtime.capabilities.run("calc", input: "1+1", runtime: runtime, context: browser, executionID: "exec-1")
    }

    await #expect(throws: BridgeError.self) {
        try await runtime.capabilities.run("json.format", input: "{nope", runtime: runtime, context: browser, executionID: "exec-2")
    }
    let failed = await runtime.capabilities.execution("exec-2", origin: .browser)
    #expect(failed?["status"]?.stringValue == "failed")
    #expect(failed?["error"]?.stringValue?.isEmpty == false)
    #expect(runtime.capabilities.recentRuns().filter { $0.capability == "json.format" }.count == 1)
    #expect(await runtime.capabilities.execution("unknown", origin: .browser) == nil)
}

// H5: local search stays within the spec's interactive budget.
@Test func searchStaysFastAtScale() async {
    let service = SearchService()
    for i in 0..<2000 {
        service.index.upsert(SearchDocument(source: "note", id: "\(i)", title: "Note \(i) about project \(i % 37)",
                                            body: String(repeating: "lorem ipsum planning roadmap ", count: 20), action: SearchAction("openNote")))
    }
    var timings: [Double] = []
    for query in ["proj", "roadmap", "note 1", "planning", "xyz"] + Array(repeating: "lorem", count: 15) {
        let start = Date()
        _ = await service.search(query)
        timings.append(Date().timeIntervalSince(start) * 1000)
    }
    let p95 = timings.sorted()[Int(Double(timings.count) * 0.95) - 1]
    #expect(p95 < 75, "p95 \(p95) ms")
}

@Test func linkPreviewsReadPageMetadata() {
    let html = """
    <html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Lima &#8211; Notes">
    <meta name='description' content='A browser &quot;first&quot;'>
    <META property=og:site_name content=Example></head><body>ignored</body></html>
    """
    let meta = LinkPreviews.metadata(html)
    #expect(meta["og:title"] == "Lima – Notes")
    #expect(meta["title"] == "Fallback & title")
    #expect(meta["description"] == "A browser \"first\"")
    #expect(meta["og:site_name"] == "Example")
    #expect(LinkPreviews.allowed(URL(string: "https://example.com")!))
    #expect(LinkPreviews.allowed(URL(string: "http://localhost:3000")!))
    #expect(!LinkPreviews.allowed(URL(string: "http://example.com")!))
    #expect(!LinkPreviews.allowed(URL(string: "file:///etc/passwd")!))
}

@Test func claudeModelsAndTheirEffortsComeFromClaudeCodesCatalog() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let folder = home.appendingPathComponent(".claude/cache/model-catalog")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }
    // Before Claude Code has written a catalog: the aliases, with its efforts.
    #expect(ModelCatalog.claudeModels(home: home).map(\.id) == ["opus", "sonnet", "fable", "haiku"])
    let catalog = #"{"catalog":{"config":{"models":[{"id":"claude-old-1","name":"Old 1","section":"overflow","thinking":{"effort_options":[{"id":"low"},{"id":"high"}]},"runtime":{"default_effort":"high"}},{"id":"claude-new-2","name":"New 2","section":"main","thinking":{"effort_options":[{"id":"low"},{"id":"medium"},{"id":"xhigh"},{"id":"max"}]},"runtime":{"default_effort":"medium"}},{"id":"claude-plain","name":"Plain","section":"overflow"}]}}}"#
    try Data(catalog.utf8).write(to: folder.appendingPathComponent("account-cc.json"))
    let models = ModelCatalog.claudeModels(home: home)
    #expect(models.map(\.id) == ["claude-new-2", "claude-old-1", "claude-plain"], "current models first, older ones after")
    #expect(models[0].efforts?.map(\.id) == ["low", "medium", "xhigh", "max"] && models[0].defaultEffort == "medium")
    #expect(models[0].efforts?[2].label == "Extra high" && models[2].efforts == [])
}
