import Foundation
import Testing
@testable import LimaRuntime
@testable import LimaProtocol

@Test func calculatorHandlesPrecedenceAndRejectsGarbage() {
    #expect(Calculator.evaluate("12*(3+4)") == 84)
    #expect(Calculator.evaluate("2^3^2") == 512)
    #expect(Calculator.evaluate("-4+10/4") == -1.5)
    #expect(Calculator.evaluate("2+") == nil)
}

@Test func shellWordsSplitQuotesAndStopAtOperators() {
    #expect(ShellWords.split(#"git push --force "origin" main; rm -rf /"#) == ["git", "push", "--force", "origin", "main"])
    #expect(ShellWords.split(#"echo 'a b' c\ d"#) == ["echo", "a b", "c d"])
}

@Test func ansiIsStripped() {
    #expect(ANSI.strip("\u{1B}[31mred\u{1B}[0m\r\n\u{1B}]0;title\u{07}ok") == "red\nok")
}

@Test(.timeLimit(.minutes(1))) func runtimeRoutesAndEnforcesOrigins() async throws {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-rt-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    setenv("LIMA_KEY_FILE", dir.appendingPathComponent("key").path, 1)
    let runtime = try await Runtime.open(paths: RuntimePaths(data: dir, socket: dir.appendingPathComponent("s").path, lock: dir.appendingPathComponent("l").path))
    let browser = CallContext(client: nil, origin: .browser)
    let mcp = CallContext(client: nil, origin: .mcp)

    let created = await runtime.handle(BridgeRequest(id: "1", method: "notes.create", params: .object(["title": .string("Quarterly zebra plan")])), context: browser)
    #expect(created.ok)
    let denied = await runtime.handle(BridgeRequest(id: "2", method: "notes.create", params: .object(["title": .string("x")])), context: mcp)
    #expect(denied.error?.code == .confirmationRequired)
    let grant = await runtime.handle(BridgeRequest(id: "3", method: "terminal.lease.grant", params: .object(["id": .string("t"), "agentId": .string("a")])), context: mcp)
    #expect(grant.error?.code == .notAuthorized)
    let search = await runtime.handle(BridgeRequest(id: "4", method: "search.query", params: .object(["query": .string("zebra")])), context: mcp)
    #expect(search.result?["results"]?.arrayValue?.first?["source"]?.stringValue == "note")
    let unknown = await runtime.handle(BridgeRequest(id: "5", method: "nope"), context: browser)
    #expect(unknown.error?.code == .unknownMethod)
}
