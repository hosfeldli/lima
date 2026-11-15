import CryptoKit
import Foundation

/// Where an action request came from. Policy is identical for every origin
/// (spec §1 rule 4); the origin is recorded for audit only.
public enum ActionOrigin: String, Codable, Sendable {
    case chat, terminal, search, mcp, automation, browser
}

/// Action classes from spec §4.6, ordered roughly by impact.
public enum ActionKind: String, Codable, Sendable, CaseIterable {
    /// Self-contained utilities with no side effects (UUID, JSON format…).
    case localUtility
    /// Reversible local device controls (audio output, volume, playback).
    case systemControl
    /// Capturing screen contents.
    case captureScreen
    case readProjectFile
    case writeProjectFile
    case runBuildOrTest
    case createBranchOrLocalCommit
    case installProjectDependencies
    case modifyOutsideProjectRoots
    case deleteLargeOrOverwriteImportant
    case remotePublish
    case sendExternalMessage
    case accessCredentials
    case modifyProtectedOSSettings
    case destructiveSystemOperation
}

/// Ordered by strictness so escalation can take the maximum.
public enum AuthorizationDecision: Int, Codable, Sendable, Comparable {
    case allow = 0
    case requestAuthorization = 1
    case confirm = 2
    case separatePermission = 3
    case block = 4

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// The concrete operation being authorized. Approval binds to every field,
/// so a different target cannot be substituted after approval.
public struct ActionOperation: Codable, Equatable, Sendable {
    public var kind: ActionKind
    public var origin: ActionOrigin
    public var targets: [String]
    public var executable: String?
    public var arguments: [String]
    public var destination: String?

    public init(
        kind: ActionKind,
        origin: ActionOrigin,
        targets: [String] = [],
        executable: String? = nil,
        arguments: [String] = [],
        destination: String? = nil
    ) {
        self.kind = kind
        self.origin = origin
        self.targets = targets
        self.executable = executable
        self.arguments = arguments
        self.destination = destination
    }
}

public struct AuthorizationResult: Codable, Equatable, Sendable {
    public var decision: AuthorizationDecision
    /// The kind after command classification (may be stricter than declared).
    public var effectiveKind: ActionKind
    public var reasons: [String]
}

public struct ApprovalToken: Codable, Equatable, Sendable {
    public var operationDigest: String
    public var expiresAt: Date
}

public actor AuthorizationBroker {
    public static let defaultPolicy: [ActionKind: AuthorizationDecision] = [
        .localUtility: .allow,
        .systemControl: .allow,
        .captureScreen: .confirm,
        .readProjectFile: .allow,
        .writeProjectFile: .allow,
        .runBuildOrTest: .allow,
        .createBranchOrLocalCommit: .allow,
        .installProjectDependencies: .allow,
        .modifyOutsideProjectRoots: .requestAuthorization,
        .deleteLargeOrOverwriteImportant: .confirm,
        .remotePublish: .confirm,
        .sendExternalMessage: .confirm,
        .accessCredentials: .separatePermission,
        .modifyProtectedOSSettings: .block,
        .destructiveSystemOperation: .block
    ]

    private let projectRoots: [URL]
    private let policy: [ActionKind: AuthorizationDecision]
    private var outstandingApprovals: Set<String> = []

    public init(projectRoots: [URL], policy: [ActionKind: AuthorizationDecision] = AuthorizationBroker.defaultPolicy) {
        self.projectRoots = projectRoots.map { $0.standardizedFileURL.resolvingSymlinksInPath() }
        self.policy = policy
    }

    public func evaluate(_ operation: ActionOperation) -> AuthorizationResult {
        var reasons: [String] = []
        var kind = operation.kind

        // Classification can only escalate: what the model *says* it is
        // doing is never evidence that it is safe (spec §4.6).
        if let classified = CommandClassifier.classify(executable: operation.executable, arguments: operation.arguments),
           decision(for: classified) > decision(for: kind) {
            reasons.append("command classified as \(classified.rawValue), stricter than declared \(kind.rawValue)")
            kind = classified
        }

        var decision = decision(for: kind)

        let outside = operation.targets.filter { !isInsideProjectRoots($0) }
        if !outside.isEmpty, kind == .readProjectFile || kind == .writeProjectFile {
            reasons.append("targets outside authorized roots: \(outside.joined(separator: ", "))")
            decision = max(decision, self.decision(for: .modifyOutsideProjectRoots))
        }

        if reasons.isEmpty { reasons.append("policy for \(kind.rawValue)") }
        return AuthorizationResult(decision: decision, effectiveKind: kind, reasons: reasons)
    }

    /// Issue a single-use approval bound to this exact operation.
    public func approve(_ operation: ActionOperation, validFor seconds: TimeInterval = 120) throws -> ApprovalToken {
        let digest = try Self.digest(operation)
        outstandingApprovals.insert(digest)
        return ApprovalToken(operationDigest: digest, expiresAt: Date().addingTimeInterval(seconds))
    }

    /// Consume an approval. Fails if expired, already used, or if any field
    /// of the operation differs from what was approved.
    public func consume(_ token: ApprovalToken, for operation: ActionOperation, now: Date = Date()) throws -> Bool {
        guard now < token.expiresAt else { return false }
        guard try Self.digest(operation) == token.operationDigest else { return false }
        return outstandingApprovals.remove(token.operationDigest) != nil
    }

    private func decision(for kind: ActionKind) -> AuthorizationDecision {
        policy[kind] ?? .block
    }

    private func isInsideProjectRoots(_ path: String) -> Bool {
        let target = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        return projectRoots.contains { root in
            target == root.path || target.hasPrefix(root.path.hasSuffix("/") ? root.path : root.path + "/")
        }
    }

    static func digest(_ operation: ActionOperation) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let hash = SHA256.hash(data: try encoder.encode(operation))
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
