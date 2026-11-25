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
    #expect(grant.error?.code == .unknownMethod, "Lima no longer has a terminal to control")
    // Reading needs the search:read grant (on by default; asks when another test turned it off).
    let (search, _) = try await answeringApproval(runtime, approve: true) {
        await runtime.handle(BridgeRequest(id: "4", method: "search.query", params: .object(["query": .string("zebra")])), context: mcp)
    }
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

@Test(.timeLimit(.minutes(1))) func attachmentsUploadInChunksAndOnlyLimaFilesCanBeSent() async throws {
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    let chat = try #require(await call(runtime, "chat.create", ["provider": .string("claude")]).result?["id"]?.stringValue)
    let first = await call(runtime, "chat.attach", ["id": .string(chat), "name": .string("../notes.txt"), "type": .string("text/plain"),
                                                    "data": .string(Data("hello ".utf8).base64EncodedString())])
    let upload = try #require(first.result?["upload"]?.stringValue, "\(String(describing: first.error))")
    let done = await call(runtime, "chat.attach", ["id": .string(chat), "name": .string("../notes.txt"), "type": .string("text/plain"), "upload": .string(upload),
                                                   "data": .string(Data("world".utf8).base64EncodedString()), "done": .bool(true)])
    let path = try #require(done.result?["path"]?.stringValue)
    #expect(URL(fileURLWithPath: path).lastPathComponent == "-notes.txt", "names can't climb out of the folder")
    #expect(try String(contentsOfFile: path, encoding: .utf8) == "hello world")
    #expect(done.result?["size"]?.doubleValue == 11)
    // Outside tools can't attach; a path Lima didn't save can't be sent.
    let (outside, card) = try await answeringApproval(runtime, approve: false) {
        await call(runtime, "chat.attach", ["id": .string(chat), "data": .string("")], origin: .mcp)
    }
    #expect(outside.error?.code == .notAuthorized)
    #expect(card?["question"]?.stringValue == "Let Outside AI tool read or change your AI chats?")
    let forged = await call(runtime, "chat.send", ["id": .string(chat), "text": .string("read this"), "attachments": .array([.object(["path": .string("/etc/hosts")])])])
    #expect(forged.error?.code == .badRequest)
    let sent = await call(runtime, "chat.send", ["id": .string(chat), "text": .string("read this"),
                                                 "attachments": .array([.object(["path": .string(path), "type": .string("text/plain")])])])
    #expect(sent.result?["messages"]?.arrayValue?.first?["attachments"]?.arrayValue?.first?["name"]?.stringValue == "-notes.txt")
    _ = await call(runtime, "chat.cancel", ["id": .string(chat)])
}

@Test func calculatorReadsExactlyWhatWasWritten() {
    #expect(Calculator.evaluate("1 2") == nil, "spaces never join numbers")
    #expect(Calculator.evaluate("-2^2") == -4, "^ binds tighter than a leading minus")
    #expect(Calculator.evaluate("(-2)^2") == 4)
    #expect(Calculator.evaluate("5 − 3") == 2, "the Unicode minus sign the tool advertises")
    #expect(Calculator.evaluate("6 × 7 ÷ 2") == 21)
    #expect(Calculator.evaluate("2^-1") == 0.5)
    #expect(Calculator.evaluate("1/0") == nil && Calculator.evaluate("5 % 0") == nil)
    #expect(Calculator.evaluate("1.2.3") == nil && Calculator.evaluate("2+") == nil && Calculator.evaluate("(1") == nil)
    #expect(Calculator.evaluate(String(repeating: "-", count: 10_000) + "1") == nil, "deep nesting is refused, not a stack overflow")
}

@Test(.timeLimit(.minutes(1))) func outOfRangeLimitsNeverCrashTheRuntime() async throws {
    #expect(JSONValue.number(1e300).intValue == nil)
    #expect(JSONValue.number(-.infinity).intValue == nil)
    #expect(JSONValue.number(42.9).intValue == 42)
    let (runtime, dir) = try await workspaceRuntime()
    defer { try? FileManager.default.removeItem(at: dir) }
    for limit in [JSONValue.number(-5), .number(1e300), .number(-1e300), .string("x")] {
        let response = await call(runtime, "context.recent", ["limit": limit])
        #expect(response.ok, "limit \(limit)")
    }
}

@Test func mcpChecksArgumentsAndNegotiatesVersions() throws {
    let search = try #require(MCPServer.contentTools.first { $0.name == "lima_search" })
    #expect(MCPServer.validate(nil, for: search) != nil, "query is required")
    #expect(MCPServer.validate(.object(["query": .string("  ")]), for: search) != nil)
    #expect(MCPServer.validate(.object(["query": .number(3)]), for: search) != nil)
    #expect(MCPServer.validate(.object(["query": .string("notes")]), for: search) == nil)
    let recent = try #require(MCPServer.contentTools.first { $0.name == "context_recent" })
    #expect(MCPServer.validate(.object(["limit": .number(-1)]), for: recent) != nil)
    #expect(MCPServer.validate(.object(["limit": .number(1e300)]), for: recent) != nil)
    #expect(MCPServer.validate(.object(["limit": .number(2.5)]), for: recent) != nil)
    #expect(MCPServer.validate(.object(["limit": .number(20)]), for: recent) == nil)
    #expect(MCPServer.negotiate("2025-06-18") == "2025-06-18")
    #expect(MCPServer.negotiate("2024-11-05") == "2024-11-05")
    #expect(MCPServer.negotiate("1999-01-01") == "2025-06-18", "an unsupported version isn't echoed back")
}

@Test func mcpTaskGrantsCoverOnlyTheirSession() {
    let grants = MCPGrants()
    #expect(!grants.allows(scope: "notes:read"), "fresh installs grant nothing")
    grants.grant("notes:read", session: "A")
    #expect(grants.allows(scope: "notes:read", session: "A"))
    #expect(!grants.allows(scope: "notes:read", session: "B") && !grants.allows(scope: "notes:read"))
}
