import Foundation
import LimaAuthorization
import LimaProtocol

/// No AI action is refused outright. Whatever Lima's policy would otherwise
/// stop (a flagged shell command, a capability marked risky, a scope an
/// outside AI tool hasn't been granted, a helper stepping outside its role)
/// becomes an approval card in Lima with a short brief, and goes ahead only if
/// the user allows it. Identity checks (who may answer approvals, which
/// workspace an agent belongs to) are not actions and still apply.
extension Runtime {
    enum ApprovalScope: String { case once, task }

    /// Asks the user and returns how far the approval reaches; throws a
    /// "declined" error the agent can report if the user says no.
    @discardableResult
    func approveAction(_ context: CallContext, question: String, facts: [WorkspacePrompts.Fact], detail: String? = nil,
                       risk: String = "system", allowTask: Bool = false) async throws -> ApprovalScope {
        // The user acting in Lima's own interface is the approval.
        if context.origin == .browser { return .once }
        let response: JSONValue
        if let id = context.workspaceID, let workspace = try? await workspaces.get(id) {
            response = try await workspacePrompts.ask(self, workspace: workspace, question: question, detail: detail, approval: true,
                                                      actionLabel: "Allow once", facts: facts, risk: risk, allowTask: allowTask)
        } else {
            response = try await workspacePrompts.ask(self, ownerID: "external-\(UUID().uuidString)", ownerName: Self.callerName(context.origin),
                                                      question: question, detail: detail, approval: true, actionLabel: "Allow once",
                                                      facts: facts, risk: risk, allowTask: allowTask)
        }
        guard response["approved"]?.boolValue == true else {
            throw BridgeError(.notAuthorized, "The user declined “\(question)” Don't retry it; report back or continue without it.")
        }
        return ApprovalScope(rawValue: response["scope"]?.stringValue ?? "") ?? .once
    }

    static func callerName(_ origin: ActionOrigin) -> String {
        switch origin {
        case .mcp: "Outside AI tool"
        case .automation: "Automation"
        case .terminal: "Terminal"
        default: "AI agent"
        }
    }

    /// An outside AI tool (MCP) using a scope the user hasn't granted asks
    /// instead of failing. "Allow for this task" grants it until Lima quits.
    /// `unbound`: also ask callers that are neither MCP nor a workspace agent.
    func requireMCPScope(_ scope: String, context: CallContext, unbound: Bool = false, action: String) async throws {
        let applies = context.origin == .mcp || (unbound && context.origin != .browser && context.workspaceID == nil)
        guard applies, !(context.origin == .mcp && MCPGrants.shared.allows(scope: scope)) else { return }
        let reach = try await approveAction(context, question: "Let \(Self.callerName(context.origin).lowercased().replacingOccurrences(of: "ai", with: "AI")) \(action)?",
            facts: [.init(label: "Permission", value: scope), .init(label: "Always allow", value: "Lima → Integrations → MCP")],
            risk: "access", allowTask: true)
        if reach == .task, context.origin == .mcp { MCPGrants.shared.grant(scope) }
    }

    /// Shell commands an agent runs: routine ones go straight through;
    /// anything the policy flags asks first, with the command and why.
    func authorizeTerminalCommand(_ command: String, cwd: String, context: CallContext, approvalDigest: String?) async throws {
        let words = ShellWords.split(command)
        let operation = ActionOperation(kind: .runBuildOrTest, origin: context.origin, targets: [cwd],
                                        executable: words.first, arguments: Array(words.dropFirst()))
        let broker = AuthorizationBroker(projectRoots: [URL(fileURLWithPath: cwd)])
        let verdict = await broker.evaluate(operation)
        guard verdict.decision != .allow else { return }
        if let approvalDigest, approvalDigest == (try? ApprovalLedger.shared.digest(operation)), ApprovalLedger.shared.consume(operation) { return }
        try await approveAction(context, question: "Run this command?",
            facts: [.init(label: "Command", value: command), .init(label: "Folder", value: cwd),
                    .init(label: "Why it asks", value: Self.brief(verdict.effectiveKind, reasons: verdict.reasons))],
            risk: verdict.decision == .block ? "system" : "access")
    }

    /// One plain sentence for an approval card.
    static func brief(_ kind: ActionKind, reasons: [String]) -> String {
        let summary: String = switch kind {
        case .destructiveSystemOperation: "It could delete or overwrite things outside this project."
        case .modifyProtectedOSSettings: "It changes protected macOS settings."
        case .modifyOutsideProjectRoots: "It changes files outside this workspace's folder."
        case .deleteLargeOrOverwriteImportant: "It deletes or overwrites important files."
        case .installProjectDependencies: "It installs software."
        case .remotePublish: "It publishes or pushes to a remote service."
        case .sendExternalMessage: "It sends a message on your behalf."
        case .accessCredentials: "It reads passwords, keys or other credentials."
        case .systemControl: "It controls your Mac."
        default: "Lima's safety policy flags it."
        }
        let detail = reasons.first.map { " (\($0))" } ?? ""
        return summary + detail
    }
}
