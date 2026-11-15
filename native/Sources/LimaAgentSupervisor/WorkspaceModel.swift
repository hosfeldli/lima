import Foundation

// The four independent objects from spec §4.1. A project owns many
// terminals; a terminal may be observed by many agents but written by one
// lease holder; tasks reference everything by ID so UI teardown never
// destroys the underlying state (spec §1 rule 5).

public struct ProjectID: Hashable, Codable, Sendable { public let raw: String; public init(_ raw: String) { self.raw = raw } }
public struct TerminalSessionID: Hashable, Codable, Sendable { public let raw: String; public init(_ raw: String) { self.raw = raw } }
public struct AgentSessionID: Hashable, Codable, Sendable { public let raw: String; public init(_ raw: String) { self.raw = raw } }
public struct TaskID: Hashable, Codable, Sendable { public let raw: String; public init(_ raw: String) { self.raw = raw } }

public struct Project: Codable, Sendable, Equatable {
    public var id: ProjectID
    public var root: URL
    public var repositoryRoot: URL?
    public var authorizedRoots: [URL]
}

public struct TerminalSessionRecord: Codable, Sendable, Equatable {
    public var id: TerminalSessionID
    public var project: ProjectID
    public var workingDirectory: URL
    public var observers: Set<AgentSessionID>
}

public enum AgentExecutionState: String, Codable, Sendable {
    case starting, observing, controlling, waiting, running, paused, blocked, disconnected, finished, failed
}

public struct AgentSessionRecord: Codable, Sendable, Equatable {
    public var id: AgentSessionID
    public var provider: CLIProvider
    public var project: ProjectID
    /// Isolated git worktree when the agent writes concurrently with others
    /// (Orca's one-worktree-per-agent model).
    public var worktree: URL?
    public var terminal: TerminalSessionID?
    public var state: AgentExecutionState
}

public struct AgentTaskRecord: Codable, Sendable, Equatable {
    public var id: TaskID
    public var objective: String
    public var assignedAgent: AgentSessionID?
    public var dependsOn: [TaskID]
    public var baselineCommit: String?
    public var modifiedFiles: [String]
}
