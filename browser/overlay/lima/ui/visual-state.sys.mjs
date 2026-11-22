import { lastVisibleTool, replyActivity } from "./tool-activity.sys.mjs";

const READY = { state: "idle", label: "Ready", motion: "idle" };
const DISCONNECTED = { state: "disconnected", label: "Reconnecting to Lima…", motion: "paused", icon: "warning" };
const TASK_PHASES = {
  accepted: ["starting", "Planning task…", "planning", "notebook"],
  planned: ["starting", "Assigning work…", "delegate", "note"],
  queued: ["waiting", "Waiting for available capacity", "waiting", "note"],
  waiting: ["waiting", "Waiting for other agents", "waiting", "note"],
  paused: ["waiting", "Paused", "paused", "pause"],
  blocked: ["blocked", "Blocked", "waiting", "warning"],
  verifying: ["working", "Verifying results…", "test", "checkbox"],
  completed: ["complete", "Task completed", "idle", "check"],
  completed_with_warnings: ["complete", "Completed with warnings", "idle", "warning"],
  failed: ["failed", "Task failed", "failed", "warning"],
  canceled: ["idle", "Stopped", "paused", "pause"],
};
const SETTLED_TASK = new Set(["completed", "completed_with_warnings", "failed", "canceled"]);
export const VISUAL_EVENTS = new Set([
  "workspace.created", "workspace.updated", "workspace.deleted", "chat.updated", "chat.delta", "chat.deleted",
  "workspace.activity", "terminal.state", "prompt.opened", "prompt.closed", "task.updated",
]);

export class VisualState {
  workspaces = new Map();
  chats = new Map();
  tasks = new Map();
  prompts = new Map();
  focus = new Map();
  terminals = new Map();
  celebrations = new Map();
  connected = false;

  ingest({ event, data }, now = Date.now()) {
    switch (event) {
      case "workspace.created":
      case "workspace.updated":
        this.workspaces.set(data.id, data);
        break;
      case "workspace.deleted": {
        const previous = this.workspaces.get(data.id);
        if (previous) {
          this.chats.delete(previous.conversationID);
          this.terminals.delete(previous.terminalID);
        }
        this.workspaces.delete(data.id);
        this.focus.delete(data.id);
        for (const [id, task] of this.tasks) if (task.workspaceID === data.id) this.tasks.delete(id);
        for (const [id, prompt] of this.prompts) if (prompt.workspaceId === data.id) this.prompts.delete(id);
        break;
      }
      case "chat.updated": {
        const prior = this.chats.get(data.id);
        if (prior?.updatedAt > data.updatedAt) return false;
        const reply = data.messages?.findLast(item => item.role === "assistant");
        const message = reply && { id: reply.id, status: reply.status, hasText: !!reply.text?.trim(),
          progress: reply.progress, error: reply.error, createdAt: reply.createdAt, startedAt: reply.startedAt, toolCount: reply.tools?.length };
        const tool = message?.status !== "streaming" ? undefined
          : (prior?.message?.id !== message.id || prior.message.toolCount !== message.toolCount)
            ? lastVisibleTool(reply.tools) : prior.tool;
        this.chats.set(data.id, { id: data.id, workspaceID: data.workspaceID, provider: data.provider, updatedAt: data.updatedAt, message, tool });
        break;
      }
      case "chat.delta": {
        const chat = this.chats.get(data.conversationId);
        if (chat?.message?.status !== "streaming" || (chat.message.id && chat.message.id !== data.messageId) ||
            !data.text?.trim() || (!chat.tool && chat.message.hasText)) return false;
        chat.message = { ...chat.message, id: data.messageId, hasText: true };
        chat.tool = undefined;
        break;
      }
      case "chat.deleted":
        this.chats.delete(data.id);
        break;
      case "workspace.activity":
        this.focus.set(data.id, data);
        if (data.surface === "chat") {
          const chat = this.chats.get(this.workspaces.get(data.id)?.conversationID);
          if (chat) chat.tool = undefined;
        }
        break;
      case "terminal.state": {
        const terminal = data.info ?? data;
        if (!terminal.id) return false;
        this.terminals.set(terminal.id, terminal);
        break;
      }
      case "prompt.opened":
        this.prompts.set(data.id, data);
        break;
      case "prompt.closed":
        this.prompts.delete(data.id);
        break;
      case "task.updated": {
        const { id, workspaceID, state, role, updatedAt, startedAt } = data;
        if (!workspaceID) return false;
        const prior = this.tasks.get(id);
        if (prior && prior.updatedAt > updatedAt) return false;
        if (SETTLED_TASK.has(state)) {
          for (const [otherID, other] of this.tasks) {
            if (otherID === id || other.workspaceID !== workspaceID || !SETTLED_TASK.has(other.state)) continue;
            if (other.updatedAt > updatedAt) return false;
            this.tasks.delete(otherID);
            this.celebrations.delete(otherID);
          }
        }
        this.tasks.set(id, { id, workspaceID, state, role, updatedAt, startedAt, attention: data.attention ?? null,
          recovering: state === "running" && data.events?.at(-1)?.kind === "retry" });
        if (prior && prior.state !== state && state === "completed") this.celebrations.set(id, now + 900);
        else if (state !== "completed") this.celebrations.delete(id);
        break;
      }
      default: return false;
    }
    return true;
  }

  restore({ workspaces, chats, tasks, prompts, focus, terminals }) {
    this.workspaces = new Map(workspaces.map(item => [item.id, item]));
    this.chats = new Map(chats.map(item => [item.id, {
      ...item, message: { id: item.lastMessageID, createdAt: item.lastCreatedAt, status: item.lastStatus ?? (item.running ? "streaming" : undefined),
        error: { kind: item.lastErrorKind }, progress: item.lastProgress },
    }]));
    this.tasks = new Map(tasks.map(item => [item.id, item]));
    this.prompts = new Map(prompts.map(item => [item.id, item]));
    this.focus = new Map(Object.entries(focus));
    this.terminals = new Map(terminals.map(item => [item.id, item]));
    this.celebrations.clear();
    this.connected = true;
  }

  snapshot(now = Date.now()) {
    const workspaces = Object.create(null), chats = Object.create(null);
    const tasksByWorkspace = new Map();
    const promptsByWorkspace = new Map();
    for (const task of this.tasks.values()) {
      if (!task.workspaceID) continue;
      const last = tasksByWorkspace.get(task.workspaceID);
      const settled = SETTLED_TASK.has(task.state);
      if (!last || (SETTLED_TASK.has(last.state) && !settled) ||
          (SETTLED_TASK.has(last.state) === settled && task.updatedAt >= last.updatedAt)) tasksByWorkspace.set(task.workspaceID, task);
    }
    for (const prompt of this.prompts.values()) promptsByWorkspace.set(prompt.workspaceId, prompt);
    for (const [id, expires] of this.celebrations) if (expires <= now) this.celebrations.delete(id);
    for (const workspace of this.workspaces.values()) {
      const id = workspace.id;
      const chat = this.chats.get(workspace.conversationID);
      let task = tasksByWorkspace.get(id);
      if (task && SETTLED_TASK.has(task.state) && chat?.message?.createdAt > task.updatedAt) task = undefined;
      const prompt = promptsByWorkspace.get(id);
      const target = this.focus.get(id);
      const terminal = this.terminals.get(workspace.terminalID);
      const agentAtTerminal = target?.surface === "terminal" && terminal?.owner?.startsWith("agent:") && terminal.state === "running";
      let activity = READY;
      if (!this.connected) activity = DISCONNECTED;
      else if (prompt) activity = { state: "blocked", label: prompt.approval ? "Needs approval" : "Waiting for input", motion: "waiting", icon: "note" };
      else if (task && TASK_PHASES[task.state]) {
        const [state, label, motion, icon] = TASK_PHASES[task.state];
        // A notice says why and what to do, not just that something is wrong.
        activity = { state, label, motion: this.celebrations.has(task.id) ? "complete" : motion, icon, startedAt: task.startedAt,
          taskId: task.id, detail: task.attention?.reason ?? "", attention: task.attention ?? undefined };
      } else if (task?.recovering && chat?.message?.status !== "streaming") {
        activity = { state: "starting", label: "Recovering…", motion: "recover", icon: "redo" };
      } else if (target?.surface === "terminal" && terminal?.state === "waitingForInput") {
        activity = { state: "waiting", label: "Command waiting for input", motion: "waiting", icon: "terminal" };
      } else if (target?.surface === "terminal" && terminal?.pendingRequests?.length && !terminal.owner?.startsWith("agent:")) {
        activity = { state: "blocked", label: "Needs terminal access", motion: "waiting", icon: "terminal" };
      } else if (chat?.message?.status === "streaming" || chat?.message?.status === "queued" || chat?.message?.status === "failed") {
        const terminalInactive = target?.surface === "terminal" && !agentAtTerminal;
        activity = replyActivity(chat.message, { provider: chat.provider, tool: terminalInactive ? undefined : chat.tool,
          surface: terminalInactive ? "chat" : target?.surface });
      } else if (task?.state === "running") {
        activity = { state: "working", label: "Working on task…", motion: "think", icon: "notebook", startedAt: task.startedAt };
      }
      workspaces[id] = { ...activity,
        target: ["working", "starting"].includes(activity.state) && (target?.surface !== "terminal" || agentAtTerminal) ? target : undefined,
        role: task?.role };
    }
    for (const workspace of this.workspaces.values()) {
      if (workspaces[workspace.id].state !== "blocked") continue;
      let parent = workspace.parentID;
      const visited = new Set([workspace.id]);
      while (parent && workspaces[parent] && !visited.has(parent)) {
        visited.add(parent);
        workspaces[parent].attention = true;
        parent = this.workspaces.get(parent)?.parentID;
      }
    }
    const companionStates = Object.values(workspaces);
    for (const [id, chat] of this.chats) {
      if (chat.workspaceID && workspaces[chat.workspaceID]) chats[id] = workspaces[chat.workspaceID];
      else if (!this.connected) chats[id] = DISCONNECTED;
      else chats[id] = replyActivity(chat.message, { provider: chat.provider, tool: chat.tool });
    }
    const companion = !this.connected ? DISCONNECTED
      : companionStates.find(item => item.state === "blocked") ??
        companionStates.find(item => item.motion === "complete") ??
        companionStates.find(item => ["working", "starting"].includes(item.state)) ??
        companionStates.find(item => item.state === "waiting") ??
        companionStates.find(item => item.state === "failed") ?? READY;
    return { workspaces, chats, companion };
  }
}
