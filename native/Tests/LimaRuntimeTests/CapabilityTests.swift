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

// H2: identical policy regardless of origin; UI gesture = confirmation, agents need approval.
@Test func capabilityAuthorizationIsUniformAcrossOrigins() async throws {
    let (runtime, dir) = try await openRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let registry = runtime.capabilities
    let capture = registry.definition("screenshot.region")!
    #expect(throws: Never.self) { try registry.authorize(capture, input: "", context: CallContext(client: nil, origin: .browser), approvalDigest: nil) }
    #expect(throws: BridgeError.self) { try registry.authorize(capture, input: "", context: CallContext(client: nil, origin: .chat), approvalDigest: nil) }
    MCPGrants.shared.scopes = []
    #expect(throws: BridgeError.self) { try registry.authorize(capture, input: "", context: CallContext(client: nil, origin: .mcp), approvalDigest: nil) }
    MCPGrants.shared.scopes = ["screen:capture"]
    // Granted scope still doesn't bypass the confirm-level policy for agents.
    #expect(throws: BridgeError.self) { try registry.authorize(capture, input: "", context: CallContext(client: nil, origin: .mcp), approvalDigest: nil) }
    let operation = ActionOperation(kind: capture.risk, origin: .mcp, targets: [capture.id], arguments: [""])
    let digest = try ApprovalLedger.shared.approve(operation)
    #expect(throws: Never.self) { try registry.authorize(capture, input: "", context: CallContext(client: nil, origin: .mcp), approvalDigest: digest) }
    // Not exposed to agents at all:
    #expect(throws: BridgeError.self) { try registry.authorize(registry.definition("password.generate")!, input: "", context: CallContext(client: nil, origin: .mcp), approvalDigest: nil) }
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
