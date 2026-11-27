/* Chat metadata for pages that show badges and workspace status. Only the
 * mounted transcript and Companion threads need the full message history. */
export function chatAudience(url, mountedChat) {
  const params = new URLSearchParams(url.split("?", 2)[1]?.split("#", 1)[0]);
  const view = params.get("view");
  if (["media", "attachment", "image"].includes(view)) return {};
  if (view === "assistant") return { summary: true, companion: true };
  if (params.has("workspace")) return { summary: true };
  if (["welcome", "whats-new", "mini", "notes-help", "notes"].includes(view) || params.has("note")) return {};
  if (params.has("terminal") || ["workspaces", "agents", "terminal"].includes(view)) return { summary: true, companion: true };
  if (params.has("chat") || view === "chat") return { summary: true, chat: mountedChat ?? params.get("chat") };
  if (!params.has("ask") && !params.has("run") && !params.has("tool") && (view === null || view === "home")) {
    return { summary: true, companion: true };
  }
  return {};
}

export function chatSummary({ id, title, workspaceID, mascot, updatedAt, messages }) {
  return { id, title, workspaceID, mascot, updatedAt, running: messages?.some(message => message.status === "streaming") ?? false };
}

export function chatPageEvent(message, audience, summary) {
  const { event, data } = message;
  if (event === "chat.delta") {
    return audience.companion || (audience.chat && audience.chat === data.conversationId) ? message : null;
  }
  if (!audience.summary) return null;
  if (audience.chat === data.id || (audience.companion && data.companion)) return message;
  return summary;
}
