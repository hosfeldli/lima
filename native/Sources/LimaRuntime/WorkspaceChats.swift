import Foundation
import LimaAgentSupervisor
import LimaProtocol

/// More than one chat in a workspace. The workspace's own chat stays its
/// main one (the sidebar, tasks and the Companion talk to it); the user can
/// open more beside it, each with the same agent, folder and tools, and
/// close them again. They show as tabs at the top of the workspace's chat.
extension Runtime {
    func registerWorkspaceChats() {
        register("workspace.chats") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Workspace chats are listed for the Lima interface.") }
            let workspace = try await self.workspaces.get(try params.string("id"))
            return await self.workspaceChats(workspace)
        }
        register("workspace.newChat") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only you can open a chat in a workspace.") }
            let workspace = try await self.workspaces.get(try params.string("id"))
            guard workspace.parentID == nil, workspace.browserTestURL == nil else {
                throw BridgeError(.badRequest, "Helpers have one chat. Open another chat in the workspace that started them.")
            }
            let count = await self.conversations.list().filter { $0.workspaceID == workspace.id }.count
            guard count < 12 else { throw BridgeError(.badRequest, "Close a chat in this workspace before opening another.") }
            var main: Conversation?
            if let id = workspace.conversationID { main = try? await self.conversations.get(id) }
            let conversation = try await self.conversations.create(provider: main?.provider ?? workspace.provider, model: main?.model,
                                                                   workingDirectory: workspace.directory, workspaceID: workspace.id,
                                                                   title: "Chat \(count + 1)", inherit: main)
            self.focus.bind(conversation: conversation.id, to: workspace.id)
            self.broadcast("workspace.chats", .object(["id": .string(workspace.id)]))
            return try JSONValue.from(conversation)
        }
        register("workspace.closeChat") { [unowned self] params, context in
            guard context.origin == .browser else { throw BridgeError(.notAuthorized, "Only you can close a workspace chat.") }
            let workspace = try await self.workspaces.get(try params.string("id"))
            let chatID = try params.string("chatId")
            guard chatID != workspace.conversationID else { throw BridgeError(.badRequest, "The workspace's main chat stays open.") }
            guard try await self.conversations.get(chatID).workspaceID == workspace.id else {
                throw BridgeError(.badRequest, "That chat belongs to a different workspace.")
            }
            try await self.conversations.delete(chatID)
            self.search.index.remove(source: "conversation", id: chatID)
            self.broadcast("workspace.chats", .object(["id": .string(workspace.id)]))
            return await self.workspaceChats(workspace)
        }
    }

    /// The main chat first, then the others in the order they were opened.
    func workspaceChats(_ workspace: Workspace) async -> JSONValue {
        let chats = await conversations.list().filter { $0.workspaceID == workspace.id }
            .sorted { ($0.id == workspace.conversationID ? 0 : 1, $0.createdAt ?? 0) < ($1.id == workspace.conversationID ? 0 : 1, $1.createdAt ?? 0) }
        return .array(chats.map { chat in
            .object(["id": .string(chat.id), "title": .string(chat.id == workspace.conversationID ? "Main" : chat.title),
                     "main": .bool(chat.id == workspace.conversationID), "running": .bool(chat.running)])
        })
    }
}
