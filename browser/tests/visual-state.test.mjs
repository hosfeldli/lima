import assert from "node:assert/strict";
import test from "node:test";
import { VisualState } from "../overlay/lima/ui/visual-state.sys.mjs";

const parent = { id: "main", conversationID: "chat-main", terminalID: "shell" };
const helper = { id: "helper", conversationID: "chat-helper", parentID: parent.id };
const setup = (overrides = {}) => {
  const state = new VisualState();
  state.restore({ workspaces: [parent, helper], chats: [], tasks: [], prompts: [], focus: {}, terminals: [], ...overrides });
  return state;
};
const task = (state, updatedAt, workspaceID = parent.id) => ({ id: `task-${workspaceID}`, workspaceID, state, updatedAt });
const update = (state, event, data, now) => state.ingest({ event, data }, now);
const chat = (workspace, status, fields = {}) => ({ id: workspace.conversationID, workspaceID: workspace.id, provider: "codex",
  updatedAt: 10, messages: [{ id: "reply", role: "assistant", status, ...fields }] });

test("streaming updates the intended agent without disturbing another workspace", () => {
  const state = setup();
  update(state, "chat.updated", chat(parent, "queued"));
  update(state, "chat.updated", chat(helper, "streaming", { tools: ["Read: result.txt"] }));
  assert.equal(state.snapshot().chats["chat-main"].state, "waiting");
  assert.equal(state.snapshot().workspaces.helper.motion, "read");
  assert.equal(update(state, "chat.delta", { conversationId: helper.conversationID, messageId: "other", text: "Wrong reply" }), false);
  assert.equal(update(state, "chat.delta", { conversationId: helper.conversationID, messageId: "reply", text: "Found it" }), true);
  assert.equal(state.snapshot().workspaces.helper.motion, "write");
  assert.equal(update(state, "chat.delta", { conversationId: helper.conversationID, messageId: "reply", text: " More text" }), false);
});

test("approvals outrank activity and flag the parent while a child waits", () => {
  const state = setup({ tasks: [task("running", 1), task("queued", 2, helper.id)] });
  update(state, "chat.updated", chat(helper, "streaming"));
  assert.equal(state.snapshot().workspaces.helper.motion, "waiting");
  update(state, "prompt.opened", { id: "approval", workspaceId: helper.id, approval: true });
  assert.equal(state.snapshot().workspaces.main.attention, true);
  assert.equal(state.snapshot().workspaces.main.state, "working");
  assert.equal(state.snapshot().companion.label, "Needs approval");
  update(state, "prompt.closed", { id: "approval" });
  assert.equal(state.snapshot().workspaces.helper.state, "waiting");
  assert.equal(state.snapshot().workspaces.main.attention, undefined);
});

test("celebration follows verified transition once and never plays when rehydrated", () => {
  const state = setup({ tasks: [task("running", 1)] });
  update(state, "chat.updated", chat(parent, "complete", { text: "Done" }));
  assert.notEqual(state.snapshot(10).workspaces.main.motion, "complete");
  update(state, "task.updated", task("verifying", 20), 20);
  assert.equal(state.snapshot(20).workspaces.main.motion, "test");
  update(state, "task.updated", task("completed", 30), 30);
  assert.equal(state.snapshot(30).workspaces.main.motion, "complete");
  update(state, "task.updated", task("completed", 40), 500);
  assert.equal(state.snapshot(930).workspaces.main.motion, "idle");
  assert.equal(setup({ tasks: [task("completed", 40)] }).snapshot(30).workspaces.main.motion, "idle");
  update(state, "task.updated", task("completed_with_warnings", 50), 50);
  assert.equal(state.snapshot(50).workspaces.main.label, "Done, with notes");
  assert.equal(state.snapshot(50).workspaces.main.motion, "idle");
});

test("tab and terminal markers stop promptly when work ends or the user takes over", () => {
  const state = setup({ tasks: [task("running", 1)] });
  update(state, "chat.updated", chat(parent, "streaming", { tools: ["workspace_run: make test"] }));
  update(state, "workspace.activity", { id: parent.id, surface: "terminal" });
  update(state, "terminal.state", { id: parent.terminalID, owner: "agent:main", state: "running" });
  assert.equal(state.snapshot().workspaces.main.target.surface, "terminal");
  update(state, "terminal.state", { id: parent.terminalID, owner: "user", state: "running" });
  assert.equal(state.snapshot().workspaces.main.target, undefined);
  assert.notEqual(state.snapshot().workspaces.main.motion, "terminal");
  update(state, "workspace.activity", { id: parent.id, surface: "tab", url: "https://example.com/" });
  assert.equal(state.snapshot().workspaces.main.target.surface, "tab");
  update(state, "task.updated", task("canceled", 30));
  assert.equal(state.snapshot().workspaces.main.target, undefined);
  assert.equal(state.snapshot().workspaces.main.label, "Stopped");
});

test("reconnect preserves settled status and archive clears attention and chat", () => {
  const state = setup({ chats: [{ id: helper.conversationID, workspaceID: helper.id, lastStatus: "streaming" }],
    prompts: [{ id: "request", workspaceId: helper.id }], tasks: [task("failed", 30)] });
  assert.equal(state.snapshot().companion.label, "Waiting for input");
  state.connected = false;
  assert.equal(state.snapshot().workspaces.main.state, "disconnected");
  update(state, "workspace.deleted", { id: helper.id });
  state.connected = true;
  assert.equal(state.snapshot().companion.state, "failed");
  assert.equal(state.snapshot().chats[helper.conversationID], undefined);
});

test("recovering and stopped states survive reconnect and unrelated chat updates", () => {
  const state = setup({ tasks: [{ ...task("running", 20), recovering: true }] });
  update(state, "chat.updated", chat(parent, "failed", { createdAt: 10 }));
  assert.equal(state.snapshot().workspaces.main.label, "Recovering…");
  update(state, "task.updated", task("canceled", 30));
  update(state, "chat.updated", { ...chat(parent, "streaming", { createdAt: 10 }), updatedAt: 40 });
  assert.equal(state.snapshot().workspaces.main.label, "Stopped");
  update(state, "chat.updated", { ...chat(parent, "streaming", { createdAt: 50 }), updatedAt: 50 });
  assert.equal(state.snapshot().workspaces.main.state, "starting");
});

test("only what the user must do raises attention, and notices dismiss", () => {
  const blocked = (attention, updatedAt = 1) => ({ ...task("blocked", updatedAt, helper.id), attention });
  const partial = { reason: "Partly done. Not checked: console errors.", remedy: "Nothing is needed from you.", action: "review", needsUser: false };
  const state = setup({ tasks: [task("running", 1)] });
  // A helper whose tools couldn't finish: information, not an alarm.
  update(state, "task.updated", blocked(partial, 2));
  assert.equal(state.snapshot().workspaces.helper.state, "waiting");
  assert.equal(state.snapshot().workspaces.main.attention, undefined);
  // A real blocker names what's needed and flags the parent.
  const signIn = { reason: "Claude Code isn't signed in.", remedy: "Sign in, then Retry.", action: "settings", needsUser: true };
  update(state, "task.updated", blocked(signIn, 3));
  assert.equal(state.snapshot().workspaces.helper.state, "blocked");
  assert.equal(state.snapshot().workspaces.helper.label, "Needs you");
  assert.equal(state.snapshot().workspaces.helper.detail, "Claude Code isn't signed in.");
  assert.equal(state.snapshot().workspaces.main.attention, true);
  // Dismissed: the mark and notice go away; the task is unchanged.
  update(state, "task.updated", blocked({ ...signIn, dismissed: true }, 4));
  assert.equal(state.snapshot().workspaces.helper.state, "idle");
  assert.equal(state.snapshot().workspaces.helper.notice, undefined);
  assert.equal(state.snapshot().workspaces.main.attention, undefined);
});
