import Foundation
import Testing
@testable import LimaAuthorization

let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("lima-auth-tests/project")

@Test func writesInsideProjectAreAllowed() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let result = await broker.evaluate(.init(kind: .writeProjectFile, origin: .chat, targets: [root.appendingPathComponent("src/main.swift").path]))
    #expect(result.decision == .allow)
}

@Test func writesOutsideProjectRequireAuthorization() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let escape = root.appendingPathComponent("../../elsewhere/file").path
    let result = await broker.evaluate(.init(kind: .writeProjectFile, origin: .mcp, targets: [escape]))
    #expect(result.decision == .requestAuthorization)
}

@Test func siblingPrefixIsNotInsideRoot() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let sibling = root.path + "-evil/file"
    let result = await broker.evaluate(.init(kind: .writeProjectFile, origin: .chat, targets: [sibling]))
    #expect(result.decision == .requestAuthorization)
}

@Test func declaredKindCannotHideForcePush() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let op = ActionOperation(kind: .runBuildOrTest, origin: .terminal, executable: "/usr/bin/git", arguments: ["push", "--force", "origin", "main"])
    let result = await broker.evaluate(op)
    #expect(result.effectiveKind == .remotePublish)
    #expect(result.decision == .confirm)
}

@Test func sudoWrappedSecurityChangeIsBlocked() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let op = ActionOperation(kind: .runBuildOrTest, origin: .automation, executable: "sudo", arguments: ["spctl", "--master-disable"])
    #expect(await broker.evaluate(op).decision == .block)
}

@Test func recursiveDeleteOfHomeIsBlocked() async {
    let broker = AuthorizationBroker(projectRoots: [root])
    let op = ActionOperation(kind: .writeProjectFile, origin: .chat, targets: [], executable: "rm", arguments: ["-rf", "~"])
    #expect(await broker.evaluate(op).decision == .block)
}

@Test func approvalIsBoundToExactOperationAndSingleUse() async throws {
    let broker = AuthorizationBroker(projectRoots: [root])
    let approved = ActionOperation(kind: .sendExternalMessage, origin: .chat, destination: "team@example.com")
    let token = try await broker.approve(approved)
    var substituted = approved
    substituted.destination = "someone-else@example.com"
    #expect(try await broker.consume(token, for: substituted) == false)
    #expect(try await broker.consume(token, for: approved) == true)
    #expect(try await broker.consume(token, for: approved) == false)
}

@Test func expiredApprovalIsRejected() async throws {
    let broker = AuthorizationBroker(projectRoots: [root])
    let op = ActionOperation(kind: .remotePublish, origin: .search)
    let token = try await broker.approve(op, validFor: 10)
    #expect(try await broker.consume(token, for: op, now: Date().addingTimeInterval(11)) == false)
}
