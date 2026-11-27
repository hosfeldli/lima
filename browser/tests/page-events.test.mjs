import assert from "node:assert/strict";
import test from "node:test";
import { chatAudience, chatPageEvent, chatSummary } from "../overlay/lima/LimaPageEvents.sys.mjs";

test("only the mounted chat receives its transcript and streaming deltas", () => {
  const data = { id: "extra", workspaceID: "project", title: "Chat 2", mascot: "builder",
    messages: [{ status: "streaming", text: "sample transcript" }] };
  const message = { event: "chat.updated", data };
  const summary = { event: "chat.updated", data: chatSummary(data) };
  const delta = { event: "chat.delta", data: { conversationId: "extra" } };
  const switched = chatAudience("about:lima?chat=main", "extra");
  assert.equal(chatPageEvent(message, switched, summary), message);
  assert.equal(chatPageEvent(delta, switched), delta);
  const anotherChat = chatAudience("about:lima?chat=unrelated");
  assert.equal(chatPageEvent(message, anotherChat, summary), summary);
  assert.equal(summary.data.running, true);
  assert.ok(!("messages" in summary.data));
  assert.equal(chatPageEvent(delta, anotherChat), null);
});

test("notes and Settings skip chat events while workspaces and the Companion stay current", () => {
  const data = { id: "companion", title: "Later", companion: true, messages: [{ status: "complete" }] };
  const message = { event: "chat.updated", data };
  const summary = { event: "chat.updated", data: chatSummary(data) };
  for (const route of ["note=abc", "view=integrations", "view=media&chat=companion"]) {
    assert.equal(chatPageEvent(message, chatAudience(`about:lima?${route}`), summary), null);
  }
  assert.equal(chatPageEvent(message, chatAudience("about:lima?workspace=project"), summary), summary);
  assert.equal(chatPageEvent(message, chatAudience("about:lima?view=assistant"), summary), message);
  assert.equal(chatPageEvent(message, chatAudience("about:lima"), summary), message);
});
