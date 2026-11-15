import Foundation
import Testing
@testable import LimaTerminal

@Test func agentCannotWriteWithoutGrant() throws {
    var lease = InputLease()
    lease.request(agentID: "a")
    #expect(lease.owner == .user)
    let handle = try lease.grant(agentID: "a")
    let r1 = lease.authorizeAgentWrite(handle)
    #expect(r1)
}

@Test func grantRequiresPendingRequest() {
    var lease = InputLease()
    #expect(throws: InputLeaseError.noPendingRequest("a")) { try lease.grant(agentID: "a") }
}

@Test func revokedLeaseRejectsQueuedWrites() throws {
    var lease = InputLease()
    lease.request(agentID: "a")
    let handle = try lease.grant(agentID: "a")
    lease.userTakeover()
    #expect(lease.owner == .user)
    let r2 = lease.authorizeAgentWrite(handle)
    #expect(r2 == false)
}

@Test func staleHandleRejectedAfterRegrant() throws {
    var lease = InputLease()
    lease.request(agentID: "a")
    let old = try lease.grant(agentID: "a")
    lease.release(old)
    lease.request(agentID: "a")
    let fresh = try lease.grant(agentID: "a")
    let r3 = lease.authorizeAgentWrite(old)
    #expect(r3 == false)
    let r4 = lease.authorizeAgentWrite(fresh)
    #expect(r4)
}

@Test func secondAgentCannotStealLease() throws {
    var lease = InputLease()
    lease.request(agentID: "a")
    _ = try lease.grant(agentID: "a")
    lease.request(agentID: "b")
    #expect(throws: InputLeaseError.anotherAgentHoldsLease("a")) { try lease.grant(agentID: "b") }
}

@Test func idleLeaseReturnsToUser() throws {
    var lease = InputLease()
    let start = Date()
    lease.request(agentID: "a")
    let handle = try lease.grant(agentID: "a", now: start)
    let r5 = lease.expireIfIdle(timeout: 30, now: start.addingTimeInterval(10))
    #expect(r5 == false)
    let r6 = lease.expireIfIdle(timeout: 30, now: start.addingTimeInterval(31))
    #expect(r6)
    let r7 = lease.authorizeAgentWrite(handle)
    #expect(r7 == false)
}
