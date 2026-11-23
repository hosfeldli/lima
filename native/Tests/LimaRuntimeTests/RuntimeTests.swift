import Darwin
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
    let dir = TestEnvironment.freshDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let runtime = try await Runtime.open(paths: RuntimePaths(data: dir, socket: dir.appendingPathComponent("s").path, lock: dir.appendingPathComponent("l").path))
    let browser = CallContext(client: nil, origin: .browser)
    let mcp = CallContext(client: nil, origin: .mcp)

    let created = await runtime.handle(BridgeRequest(id: "1", method: "notes.create", params: .object(["title": .string("Quarterly zebra plan")])), context: browser)
    #expect(created.ok)
    // An ungranted scope asks the user instead of failing outright.
    let (denied, card) = try await answeringApproval(runtime, approve: false) {
        await runtime.handle(BridgeRequest(id: "2", method: "notes.create", params: .object(["title": .string("x")])), context: mcp)
    }
    #expect(card?["question"]?.stringValue == "Let outside AI tool change your notes?")
    #expect(card?["risk"]?.stringValue == "access")
    #expect(denied.error?.code == .notAuthorized)
    let (allowed, _) = try await answeringApproval(runtime, approve: true) {
        await runtime.handle(BridgeRequest(id: "2b", method: "notes.create", params: .object(["title": .string("x")])), context: mcp)
    }
    #expect(allowed.ok)
    let grant = await runtime.handle(BridgeRequest(id: "3", method: "terminal.lease.grant", params: .object(["id": .string("t"), "agentId": .string("a")])), context: mcp)
    #expect(grant.error?.code == .notAuthorized)
    let search = await runtime.handle(BridgeRequest(id: "4", method: "search.query", params: .object(["query": .string("zebra")])), context: mcp)
    #expect(search.result?["results"]?.arrayValue?.first?["source"]?.stringValue == "note")
    let unknown = await runtime.handle(BridgeRequest(id: "5", method: "nope"), context: browser)
    #expect(unknown.error?.code == .unknownMethod)
}


@Test func aSlowSocketPeerDoesNotBlockRuntimeEventDelivery() throws {
    var pair = [Int32](repeating: -1, count: 2)
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
    guard pair.allSatisfy({ $0 >= 0 }) else { return }
    // This peer never reads. The first multi-megabyte frame fills its socket.
    var noSigPipe: Int32 = 1
    setsockopt(pair[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    let slowPeer = ClientConnection(fd: pair[0])
    let unreadReceiver = pair[1]
    defer {
        slowPeer.close()
        Darwin.close(unreadReceiver)
    }
    let finished = DispatchSemaphore(value: 0)
    let frame = Data(repeating: 1, count: BridgeFrame.maximumPayloadBytes)
    DispatchQueue.global().async {
        slowPeer.send(frame)
        slowPeer.send(frame)
        slowPeer.send(frame)
        finished.signal()
    }
    // A blocking send never returns; the margin only absorbs copying the
    // frames on a loaded CI runner.
    #expect(finished.wait(timeout: .now() + .seconds(10)) == .success)
}
