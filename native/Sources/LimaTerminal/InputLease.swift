import Foundation

/// Who may write to a shared terminal's PTY (spec §4.2 / §5.2).
public enum TerminalInputOwner: Equatable, Sendable, Codable {
    case user
    case agent(String)
}

/// Proof that an agent held the lease at a given generation. Every write
/// presents one; revoking the lease bumps the generation, so bytes queued
/// under an old handle are rejected rather than delivered late.
public struct InputLeaseHandle: Equatable, Sendable, Codable {
    public let agentID: String
    public let generation: UInt64

    public init(agentID: String, generation: UInt64) {
        self.agentID = agentID
        self.generation = generation
    }
}

public enum InputLeaseError: Error, Equatable, Sendable {
    case anotherAgentHoldsLease(String)
    case noPendingRequest(String)
}

public struct InputLease: Sendable {
    public private(set) var owner: TerminalInputOwner = .user
    public private(set) var generation: UInt64 = 0
    public private(set) var pendingRequests: [String] = []
    private var lastAgentInput: Date?

    public init() {}

    /// Step 2 of the lifecycle: an observing agent asks for the keyboard.
    /// The user (or a policy acting for them) must then call `grant`.
    public mutating func request(agentID: String) {
        if owner == .agent(agentID) || pendingRequests.contains(agentID) { return }
        pendingRequests.append(agentID)
    }

    public mutating func deny(agentID: String) {
        pendingRequests.removeAll { $0 == agentID }
    }

    /// Step 3: user handoff. Only a pending request can be granted, and only
    /// while the user (not another agent) owns input.
    public mutating func grant(agentID: String, now: Date = Date()) throws -> InputLeaseHandle {
        guard pendingRequests.contains(agentID) else { throw InputLeaseError.noPendingRequest(agentID) }
        if case .agent(let other) = owner, other != agentID { throw InputLeaseError.anotherAgentHoldsLease(other) }
        pendingRequests.removeAll { $0 == agentID }
        generation &+= 1
        owner = .agent(agentID)
        lastAgentInput = now
        return InputLeaseHandle(agentID: agentID, generation: generation)
    }

    /// Step 4: an agent write is accepted only under the current generation.
    public mutating func authorizeAgentWrite(_ handle: InputLeaseHandle, now: Date = Date()) -> Bool {
        guard handle.generation == generation, owner == .agent(handle.agentID) else { return false }
        lastAgentInput = now
        return true
    }

    /// Step 5: voluntary release.
    public mutating func release(_ handle: InputLeaseHandle) {
        guard handle.generation == generation, owner == .agent(handle.agentID) else { return }
        returnToUser()
    }

    /// The user can always reclaim control immediately; any keystroke from
    /// the user while an agent holds the lease is a takeover.
    public mutating func userTakeover() {
        if owner != .user { returnToUser() }
    }

    /// Release after inactivity. Returns true if the lease was reclaimed.
    @discardableResult
    public mutating func expireIfIdle(timeout: TimeInterval, now: Date = Date()) -> Bool {
        guard case .agent = owner, let lastAgentInput, now.timeIntervalSince(lastAgentInput) >= timeout else { return false }
        returnToUser()
        return true
    }

    private mutating func returnToUser() {
        generation &+= 1
        owner = .user
        lastAgentInput = nil
    }
}
