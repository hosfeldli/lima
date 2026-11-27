import assert from "node:assert/strict";
import test from "node:test";
import { beats, madeThings, storyChapters } from "../overlay/lima/ui/agent-story.sys.mjs";

test("steps group into a few readable beats", () => {
  const steps = ["mcp__lima__workspace_open_tab: {\"url\":\"https://hotels.example/a\"}", "mcp__lima__workspace_read_tab: https://hotels.example/a",
    "mcp__lima__workspace_read_tab: https://hotels.example/b", "Bash: {\"command\":\"ls\"}", "Bash: {\"command\":\"pwd\"}", "TodoWrite: x",
    "Edit: {\"file_path\":\"/w/notes.md\"}"];
  const story = beats(steps, { cwd: "/w" });
  assert.deepEqual(story.map(beat => [beat.kind, beat.count]), [["tabs", 1], ["read", 2], ["terminal", 2], ["write", 1]]);
  assert.equal(story[2].sentence, "Ran 2 commands");
  assert.deepEqual(story[2].examples, ["ls", "pwd"]);
  const live = beats(steps, { cwd: "/w", live: true });
  assert.equal(live.at(-1).live, true);
  assert.equal(live.at(-1).sentence, "Writing");
});

test("each request becomes a chapter with its outcome", () => {
  const messages = [
    { id: "u1", role: "user", text: "Find hotels" },
    { id: "a1", role: "assistant", status: "complete", tools: [], text: "Done.\n```lima-report\n{\"summary\":\"Saved three hotels.\"}\n```" },
    { id: "u2", role: "user", text: "Lima orchestrator: keep going" },
    { id: "a2", role: "assistant", status: "failed", tools: [], text: "", error: { kind: "cancelled", message: "Interrupted by your next message." } },
    { id: "u3", role: "user", text: "Book the second" },
    { id: "a3", role: "assistant", status: "streaming", tools: ["Bash: {\"command\":\"open\"}"], text: "" },
  ];
  const chapters = storyChapters(messages);
  assert.deepEqual(chapters.map(chapter => chapter.ask), ["Find hotels", "keep going", "Book the second"]);
  assert.deepEqual(chapters[0].outcome, { state: "done", text: "Saved three hotels." });
  assert.equal(chapters[1].outcome.state, "stopped");
  assert.equal(chapters[2].live, true);
  assert.equal(storyChapters(messages, { limit: 1 }).length, 1);
});

test("what the agent made lists pages, notes and changed files", () => {
  const workspace = { tabs: [{ url: "https://a.example/", title: "A" }, { url: "about:lima?note=1", title: "Plan" }] };
  const made = madeThings(workspace, [{ tools: ["Edit: {\"file_path\":\"/w/src/app.js\"}", "Read: {\"file_path\":\"/w/README.md\"}"] }], { cwd: "/w" });
  assert.equal(made.pages.length, 1);
  assert.equal(made.notes[0].title, "Plan");
  assert.deepEqual(made.files, [{ path: "src/app.js", name: "app.js" }], "reading a file isn't making it");
});

test("a reply's steps read as phases of work", async () => {
  const { stepPhases } = await import("../overlay/lima/ui/agent-story.sys.mjs");
  const step = tool => ({ tool });
  const phases = stepPhases([
    step('mcp__lima__workspace_browser: {"url":"https://www.opentable.com/r/la-grotta","action":"inspect"}'),
    step('mcp__lima__workspace_browser: {"url":"https://www.opentable.com/r/la-grotta","action":"click"}'),
    step('Read: {"file_path":"/w/notes.md"}'),
    step('Read: {"file_path":"/w/plan.md"}'),
    step('Read: {"file_path":"/w/plan.md"}'),
    step('Edit: {"file_path":"/w/plan.md"}'),
    step('Bash: {"command":"npm test"}'),
  ], { cwd: "/w" });
  assert.deepEqual(phases.map(phase => phase.title), ["Worked on opentable.com", "Read 2 files", "Edited 1 file", "Ran 1 command"]);
  assert.deepEqual(phases.map(phase => phase.steps.length), [2, 3, 1, 1]);
});
