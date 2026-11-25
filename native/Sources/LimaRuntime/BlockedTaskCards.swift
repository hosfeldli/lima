import Foundation
import LimaAgentSupervisor
import LimaProtocol

/// Approval cards for tasks that ended their turn blocked on the user.
///
/// An agent that asks for approval in its reply (a `lima-report` with
/// status "blocked" and `needsUser`) has no tool call waiting, so nothing
/// would show a card. Lima opens one with the agent's request (a sign-in
/// request gets "I've signed in"). It stays until the user answers: Approve
/// sends the approval back and the task runs again; Deny tells the agent not
/// to go ahead. Replying in the chat answers it too: the task continues and
/// the card closes.
actor BlockedTaskCards {
    /// Task ID → the open card's prompt ID.
    private var open: [String: String] = [:]
    /// Task ID → the finish time already carded, so one block gets one card.
    private var shown: [String: Double] = [:]

    func claim(_ task: OrchestratedTask) -> String? {
        let finished = task.finishedAt ?? task.updatedAt
        guard open[task.id] == nil, shown[task.id] != finished else { return nil }
        shown[task.id] = finished
        let id = UUID().uuidString
        open[task.id] = id
        return id
    }

    func prompt(for taskID: String) -> String? { open[taskID] }

    func release(_ taskID: String, prompt: String) {
        if open[taskID] == prompt { open[taskID] = nil }
    }
}

extension Runtime {
    /// Called for every task update. A task that ended its turn waiting on
    /// the user gets a card, which stays until the user answers it there or
    /// in the chat.
    func cardBlockedTask(_ task: OrchestratedTask) {
        let blockedOnUser = task.state == .blocked && task.report?.status.lowercased() == "blocked" && task.report?.needsUser != nil
        guard blockedOnUser, let workspaceID = task.workspaceID, let need = task.report?.needsUser else { return }
        Task {
            // The agent already left a card it asked for; that one carries on.
            guard !(await workspacePrompts.hasCard(workspace: workspaceID)),
                  let prompt = await blockedCards.claim(task), let workspace = try? await workspaces.get(workspaceID) else { return }
            defer { Task { await blockedCards.release(task.id, prompt: prompt) } }
            let summary = task.report?.summary.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let login = Self.isSignIn(need)
            let response: JSONValue
            do {
                response = try await workspacePrompts.ask(self, workspace: workspace, question: String(need.prefix(1200)),
                    detail: summary.isEmpty ? nil : summary, approval: true, actionLabel: login ? "I've signed in" : "Approve",
                    facts: [.init(label: "Task", value: task.title)], risk: login ? "login" : nil, id: prompt, expires: false)
            } catch { return } // closed with the workspace
            await resumeAfterAnswer(.init(workspace: workspaceID, question: need, approval: true, result: response))
        }
    }

    static func isSignIn(_ text: String) -> Bool {
        text.range(of: #"\b(sign(ed)?[ -]?in|log(ged)?[ -]?in|login|authenticat\w*|two-factor|2fa|verification code|credentials)\b"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The message an answered card sends the agent.
    static func answerMessage(_ late: WorkspacePrompts.LateAnswer) -> String {
        let question = "“\(late.question.prefix(600))”"
        let approved = late.result["approved"]?.boolValue == true
        guard approved else {
            return late.approval
                ? "Lima: the user declined your request \(question). Don't do it or look for a workaround. Wrap up what you can without it."
                : "Lima: the user dismissed your question \(question) without answering. Continue with what you have, or stop if you can't."
        }
        if let values = late.result["values"]?.objectValue, !values.isEmpty,
           let json = try? JSONEncoder().encode(JSONValue.object(values)) {
            return "Lima: the user answered your question \(question) with \(String(decoding: json, as: UTF8.self)). Continue the task."
        }
        if let answer = late.result["answer"]?.stringValue, !answer.isEmpty {
            return "Lima: the user answered your question \(question): \(answer)\nContinue the task."
        }
        if isSignIn(late.question) { return "Lima: the user has signed in as you asked (\(question)). Continue the task where you left off." }
        return "Lima: the user approved your request \(question) in Lima. Go ahead and continue the task."
    }

    /// An answer to a card from an earlier turn resumes that workspace's chat
    /// (and its task, if one was blocked on the user).
    func resumeAfterAnswer(_ late: WorkspacePrompts.LateAnswer) async {
        guard let workspace = try? await workspaces.get(late.workspace), let conversationID = workspace.conversationID else { return }
        let text = Self.answerMessage(late)
        guard let conversation = try? await conversations.send(conversationID, text: text, mode: .queue) else { return }
        await userSent(conversation, text: text)
    }

    /// A message the user sent in a chat continues a task there that was
    /// blocked on them.
    func userSent(_ conversation: Conversation, text: String) async {
        guard let message = conversation.messages.last(where: { $0.role == .user && $0.text == text }) else { return }
        // The reply answers the task's card, so the card closes.
        if let task = await orchestrator.userReplied(conversationID: conversation.id, messageID: message.id),
           let prompt = await blockedCards.prompt(for: task.id) {
            await workspacePrompts.close(self, id: prompt)
        }
    }
}
