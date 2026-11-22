import Foundation
import LimaAgentSupervisor
import LimaProtocol

/// Drives real agents for the Orchestrator: a root task runs in its
/// workspace's agent; a subtask gets its own helper agent, in a separate Git
/// worktree when another agent is already changing the same project.
final class RuntimeTaskExecutor: TaskExecutor, @unchecked Sendable {
    weak var runtime: Runtime?

    func assign(_ task: OrchestratedTask, parent: OrchestratedTask?) async throws -> TaskAssignment {
        guard let runtime else { throw BridgeError(.internalError, "Lima's runtime stopped.") }
        guard let parent else {
            guard let id = task.workspaceID else { throw BridgeError(.badRequest, "The task has no workspace.") }
            let workspace = try await runtime.workspaces.get(id)
            guard let conversation = workspace.conversationID else { throw BridgeError(.badRequest, "This workspace has no agent.") }
            return TaskAssignment(workspaceID: id, conversationID: conversation, agentName: workspace.name, provider: workspace.provider.rawValue)
        }
        guard let parentWorkspaceID = parent.workspaceID else { throw BridgeError(.badRequest, "The coordinating task has no workspace.") }
        let owner = try await runtime.workspaces.get(parentWorkspaceID)

        // Keep the user's provider unless it can't start.
        var provider = task.provider.flatMap(CLIProvider.init(rawValue:)) ?? owner.provider
        var notes: [String] = []
        if runtime.discovery.locate(provider) == nil, task.browserURL == nil,
           let fallback = ([owner.provider] + CLIProvider.allCases).first(where: { runtime.discovery.locate($0) != nil }) {
            notes.append("Selected provider is unavailable. Using \(Self.name(fallback)).")
            provider = fallback
        }

        var directory: URL?
        if task.role == .implementation, await runtime.orchestrator.otherWriters(than: task) > 0 {
            if let worktree = Self.worktree(for: task, project: URL(fileURLWithPath: owner.directory), root: runtime.paths.data) {
                directory = worktree.url
                notes.append("Another agent is editing this project, so this agent works on branch \(worktree.branch) in its own worktree.")
            } else {
                notes.append("Another agent is editing this project and no separate worktree was possible; edits share one folder.")
            }
        }
        let helper = try await runtime.spawnAgent(parent: owner, name: task.title, task: task.objective, provider: provider,
                                                  browserURL: task.browserURL, startTask: false, directory: directory)
        guard let conversation = helper.conversationID else { throw BridgeError(.internalError, "The helper agent has no conversation.") }
        return TaskAssignment(workspaceID: helper.id, conversationID: conversation, agentName: helper.name,
                              provider: helper.provider.rawValue, note: notes.isEmpty ? nil : notes.joined(separator: " "))
    }

    func send(conversationID: String, text: String) async throws -> String {
        guard let runtime else { throw BridgeError(.internalError, "Lima's runtime stopped.") }
        let conversation = try await runtime.conversations.send(conversationID, text: text)
        guard let message = conversation.messages.last(where: { $0.role == .user && $0.text == text }) else {
            throw BridgeError(.internalError, "The instruction wasn't recorded.")
        }
        return message.id
    }

    func cancel(conversationID: String) async {
        await runtime?.conversations.cancel(conversationID)
    }

    func conversation(_ id: String) async -> Conversation? {
        try? await runtime?.conversations.get(id)
    }

    static func name(_ provider: CLIProvider) -> String {
        switch provider { case .claude: "Claude Code"; case .codex: "Codex"; case .opencode: "OpenCode" }
    }

    /// A Git worktree for a concurrent writer, or nil when the project isn't a Git repository.
    static func worktree(for task: OrchestratedTask, project: URL, root: URL) -> (url: URL, branch: String)? {
        func git(_ arguments: [String]) -> Bool {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", project.path] + arguments
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do { try process.run() } catch { return false }
            process.waitUntilExit()
            return process.terminationStatus == 0
        }
        guard git(["rev-parse", "--verify", "HEAD"]) else { return nil }
        let short = String(task.id.prefix(8)).lowercased()
        let branch = "lima/\(short)"
        let url = root.appendingPathComponent("worktrees/\(short)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard git(["worktree", "add", "-b", branch, url.path, "HEAD"]) else { return nil }
        return (url, branch)
    }
}

extension Orchestrator {
    /// Implementation agents, other than `task`, that may be changing files now.
    func otherWriters(than task: OrchestratedTask) -> Int {
        guard let parent = task.parentID else { return 0 }
        return children(of: parent).filter { $0.id != task.id && $0.role == .implementation && $0.conversationID != nil && !$0.state.isTerminal }.count
    }

    /// A task with its helpers, for the browser.
    func tree(_ id: String) throws -> JSONValue {
        let task = try get(id)
        return .object(["task": task.publicView, "children": .array(children(of: id).map(\.publicView))])
    }
}

extension Runtime {
    func registerOrchestrator() {

        // Companion → Orchestrator: one persistent task per delegated request.
        register("task.submit") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the Lima interface can submit a task.") }
            let text = try params.string("text").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw BridgeError(.badRequest, "Describe the work to delegate.") }
            let requestID = params.optionalString("requestId").map { String($0.prefix(64)) }
            if let requestID, let existing = await self.orchestrator.existing(requestID: requestID) {
                return .object(["task": existing.publicView, "workspace": (try? await self.workspaces.get(existing.workspaceID ?? ""))?.publicView ?? .null])
            }
            let workspace = try await self.handoffWorkspace(params, text: text)
            let references = String((params.optionalString("references") ?? "").prefix(36_000))
            let count = params.int("referenceCount", default: 0)
            let task = try await Self.bridged {
                try await self.orchestrator.submit(requestID: requestID, title: Self.taskTitle(text), request: text, workspaceID: workspace.id,
                    context: count > 0 ? ["\(count) browser reference\(count == 1 ? "" : "s") included"] : [], references: references)
            }
            return .object(["task": task.publicView, "workspace": workspace.publicView])
        }
        register("task.list") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the Lima interface can list tasks.") }
            let roots = await self.orchestrator.roots(limit: params.int("limit", default: 20), workspaceID: params.optionalString("workspaceId"))
            var rows: [JSONValue] = []
            for root in roots { rows.append(try await self.orchestrator.tree(root.id)) }
            return .array(rows)
        }
        register("task.visualState") { [unowned self] _, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only Lima can read visual task state.") }
            return .array(await self.orchestrator.visualTasks())
        }
        register("task.get") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the Lima interface can read a task.") }
            return try await Self.bridged { try await self.orchestrator.tree(try params.string("id")) }
        }
        register("task.cancel") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the user can stop a task.") }
            try await Self.bridged { try await self.orchestrator.cancel(try params.string("id")) }
            return try await self.orchestrator.tree(try params.string("id"))
        }
        register("task.pause") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the user can pause a task.") }
            try await Self.bridged { try await self.orchestrator.pause(try params.string("id")) }
            return try await self.orchestrator.tree(try params.string("id"))
        }
        register("task.resume") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the user can resume a task.") }
            _ = try await Self.bridged { try await self.orchestrator.resume(try params.string("id")) }
            return try await self.orchestrator.tree(try params.string("id"))
        }
        register("task.concurrency") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only the user can change agent concurrency.") }
            let value = params.int("maxAgents", default: 0)
            if value > 0 {
                await self.orchestrator.setMaxActive(value)
                try await self.store.put(value, collection: "settings", id: "orchestrator.maxAgents")
            }
            return .number(Double(await self.orchestrator.maxActive))
        }

        // Agent → Orchestrator. The workspace is implied by the agent's token.
        register("task.delegate") { [unowned self] params, context in
            guard let workspace = context.workspaceID else { throw BridgeError(.notAuthorized, "Only a workspace agent can delegate.") }
            let role = OrchestratedTask.Role(rawValue: params.optionalString("role") ?? "general") ?? .general
            let dependencies: [String] = params?["dependsOn"]?.arrayValue?.compactMap(\.stringValue)
                ?? (params.optionalString("dependsOn") ?? "").split(separator: ",").map(String.init)
            let criteria = (params.optionalString("successCriteria") ?? "").split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            let task = try await Self.bridged {
                try await self.orchestrator.delegate(fromWorkspace: workspace, name: try params.string("name"), objective: try params.string("objective"),
                    role: role, dependsOn: dependencies, successCriteria: criteria, provider: params.optionalString("provider"),
                    browserURL: params.optionalString("browserUrl"))
            }
            return .object(["taskId": .string(task.id), "name": .string(task.title), "state": .string(task.state.rawValue),
                            "helperWorkspaceId": task.workspaceID.map(JSONValue.string) ?? .null])
        }
        register("task.status") { [unowned self] _, context in
            guard let workspace = context.workspaceID else { throw BridgeError(.notAuthorized, "Only a workspace agent can read its task.") }
            guard let task = await self.orchestrator.activeTask(forWorkspace: workspace) else { return .null }
            let root = task.parentID ?? task.id
            let children = await self.orchestrator.children(of: root)
            return .object([
                "taskId": .string(root), "state": .string((try? await self.orchestrator.get(root).state.rawValue) ?? task.state.rawValue),
                "helpers": .array(children.map { child in
                    .object(["taskId": .string(child.id), "name": .string(child.title), "role": .string(child.role.rawValue),
                             "state": .string(child.state.rawValue), "dependsOn": .array(child.dependsOn.map(JSONValue.string)),
                             "summary": .string(child.report?.summary ?? child.issues.first ?? ""),
                             "artifacts": .array((child.report?.artifacts ?? []).map(JSONValue.string))])
                }),
            ])
        }
        register("task.message") { [unowned self] params, context in
            guard let workspace = context.workspaceID else { throw BridgeError(.notAuthorized, "Only a workspace agent can send task messages.") }
            let recipients = try await Self.bridged {
                try await self.orchestrator.message(fromWorkspace: workspace, kind: try params.string("kind"), text: try params.string("text"))
            }
            return .object(["deliveredTo": .array(recipients.map(JSONValue.string))])
        }
        register("task.inbox") { [unowned self] _, context in
            guard let workspace = context.workspaceID else { throw BridgeError(.notAuthorized, "Only a workspace agent can read task messages.") }
            return try JSONValue.from(await self.orchestrator.inbox(forWorkspace: workspace))
        }
    }

    /// Orchestrator errors are the agent's or user's to fix: bad requests.
    static func bridged<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        do { return try await body() }
        catch let error as OrchestratorError { throw BridgeError(.badRequest, error.description) }
    }

    /// The workspace a Companion handoff goes to: the selected one, or a new
    /// one when the user asked for it or nothing fits.
    func handoffWorkspace(_ params: JSONValue?, text: String) async throws -> Workspace {
        let creation = Self.workspaceRequest(in: text)
        let workspace: Workspace
        if !creation.requested, let id = params.optionalString("id"), !id.isEmpty {
            workspace = try await workspaces.get(id)
            guard workspace.parentID == nil else { throw BridgeError(.badRequest, "Choose a top-level workspace.") }
        } else {
            let provider = CLIProvider(rawValue: params.optionalString("provider") ?? "") ?? .claude
            let proposed = params.optionalString("name")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            workspace = try await createWorkspace(name: creation.name ?? (proposed.isEmpty ? "New Workspace" : String(proposed.prefix(60))), directory: nil,
                provider: provider, parentID: nil, task: text, startTask: false, model: params.optionalString("model"))
        }
        try await workspaces.requireActive(workspace.id)
        if let conversation = workspace.conversationID {
            let style = params.optionalString("mascot").flatMap(ChatMascot.init(rawValue:)) ?? .suggested(for: text)
            _ = try? await conversations.setMascot(conversation, to: style)
        }
        return workspace
    }

    static func taskTitle(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        return line.count > 60 ? String(line.prefix(57)).trimmingCharacters(in: .whitespaces) + "…" : line
    }
}

extension Orchestrator {
    func existing(requestID: String) -> OrchestratedTask? {
        roots(limit: .max).first { $0.requestID == requestID }
    }
}
