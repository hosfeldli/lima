import { activityStatus, bridge, call, el, errorText, filesPrivacyButton, icon, onEvent, setPage } from "./lib.js";
import { companion, setCompanionSeed, setCompanionState, watchVisualActivity } from "./companion.js";
import { isFolderPermissionError } from "./tool-activity.sys.mjs";
import { madeThings, storyChapters } from "./agent-story.sys.mjs";

export async function renderWorkspace(app, id) {
  setPage("Overview", "workspace");
  const page = el("div", { class: "page narrow workspace-overview" });
  const title = el("h1");
  const character = companion("workspace-avatar");
  const error = el("div", { class: "error", role: "status", hidden: true });
  const meta = el("div", { class: "workspace-meta" });
  const objective = el("p", { class: "workspace-objective" });
  const sections = el("div", { class: "workspace-sections" });
  const agents = el("div", { class: "workspace-agents" });
  const active = activityStatus();
  // The story: what the agent is doing now, how the work unfolded, and what it made.
  const heroPip = companion("chat-avatar");
  const nowLine = el("p", { class: "story-now-line" });
  const nowDetail = el("p", { class: "story-now-detail muted" });
  const hero = el("section", { class: "story-now", "aria-live": "polite" }, heroPip, el("div", {}, nowLine, nowDetail));
  const story = el("ol", { class: "story", "aria-label": "How the work unfolded" });
  const made = el("section", { class: "story-made", "aria-label": "What the agent made", hidden: true });
  let conversation = null;
  // The story's own Pip (below) leads the page, so the bar carries just the name.
  app.replaceChildren(el("header", { class: "bar" }, title, active.node), page);
  page.append(error, hero, meta, objective, sections,
    el("h2", { class: "story-heading", text: "The story so far" }), story, made, agents);
  let workspace;
  let branch;
  let sequence = 0;
  const chats = new Map();
  let visuals = {};

  function draw() {
    if (!workspace) return;
    title.textContent = workspace.name;
    meta.replaceChildren(el("code", { text: workspace.directory }), branch ? el("span", { class: "badge", text: branch }) : null);
    objective.hidden = !workspace.task;
    objective.textContent = workspace.task ?? "";
    const open = (glyph, label, fn) => el("button", { class: "ghost", onclick: fn }, icon(glyph), label);
    sections.replaceChildren(
      open("chat", "Agent", () => bridge.browser("openChat", { id })),
      ...workspace.tabs.map(tab => open(tab.url.startsWith("about:lima?note=") ? "note" : "tab", tab.title, () => {
        if (tab.url.startsWith("about:lima?")) bridge.openTab(tab.url);
        else bridge.browser("openWorkspacePage", { id, url: tab.url });
      })));
    agents.replaceChildren(...[...chats.entries()].map(([chatID, chat]) => {
      const avatar = companion("agent-avatar");
      avatar.dataset.variant = chat.mascot ?? "classic";
      return el("div", { class: "workspace-agent-row", "data-chat": chatID }, avatar,
        el("span", { class: "grow", text: chat.title }), el("span", { class: "handoff-state" }));
    }));
    updateActivity();
  }

  function drawStory() {
    if (!workspace) return;
    const cwd = workspace.directory ?? "";
    const chapters = storyChapters(conversation?.messages ?? [], { cwd, limit: 3 });
    if (!chapters.length) {
      story.replaceChildren(el("li", { class: "story-empty muted", text: "Ask this workspace’s agent for something, and the story of how it works on it appears here." }));
    } else {
      story.replaceChildren(...chapters.map(chapter => el("li", { class: "story-chapter", "data-live": chapter.live ? "true" : null },
        el("p", { class: "story-ask" }, el("span", { class: "story-you", text: "You asked" }), el("q", { text: chapter.ask })),
        el("ol", { class: "story-beats" }, chapter.beats.map((beat, index) => el("li", {
          class: "story-beat", "data-kind": beat.kind, "data-live": beat.live ? "true" : null, style: `--n:${index}` },
          el("span", { class: "story-dot" }, icon(beat.icon)),
          el("span", { class: "story-beat-text" }, el("strong", { text: beat.sentence }),
            beat.examples.length ? el("span", { class: "story-examples" }, beat.examples.map(example => el("code", { text: example }))) : null))),
          chapter.outcome ? el("li", { class: "story-beat story-outcome", "data-state": chapter.outcome.state },
            el("span", { class: "story-dot" }, icon(chapter.outcome.state === "done" ? "check" : chapter.outcome.state === "stopped" ? "pause" : "warning")),
            el("span", { class: "story-beat-text" }, el("strong", { text: chapter.outcome.state === "done" ? "Finished" : chapter.outcome.state === "stopped" ? "Stopped" : "Couldn’t finish" }),
              el("span", { class: "story-result", text: chapter.outcome.text }))) : null))));
    }
    const things = madeThings(workspace, conversation?.messages ?? [], { cwd });
    const chip = (glyph, label, fn) => el("button", { class: "story-thing", onclick: fn }, icon(glyph), el("span", { text: label }));
    made.hidden = !(things.pages.length || things.notes.length || things.files.length);
    made.replaceChildren(el("h2", { class: "story-heading", text: "What it made" }),
      el("div", { class: "story-things" },
        things.notes.map(note => chip("note", note.label ?? note.title, () => bridge.openTab(note.url))),
        things.pages.map(page => chip("globe", page.label ?? page.title, () => bridge.browser("openWorkspacePage", { id, url: page.url }))),
        things.files.map(file => el("span", { class: "story-thing file", title: file.path }, icon("file"), el("span", { text: file.name })))));
  }
  let storyTimer = 0;
  async function loadStory() {
    clearTimeout(storyTimer);
    storyTimer = setTimeout(async () => {
      if (!workspace?.conversationID) return;
      conversation = await call("chat.get", { id: workspace.conversationID }).catch(() => conversation);
      drawStory();
    }, 250);
  }

  function updateActivity() {
    if (!workspace) return;
    const own = visuals[workspace.conversationID];
    setCompanionSeed(heroPip, id);
    heroPip.dataset.variant = chats.get(workspace.conversationID)?.mascot ?? "classic";
    setCompanionState(heroPip, own?.motion ?? "idle", own?.label);
    nowLine.textContent = own?.state && own.state !== "idle"
      ? `${workspace.name}: ${(own.label ?? "Working").replace(/…$/, "")}`
      : `${workspace.name} is ready for its next task`;
    nowDetail.textContent = own?.detail ?? (workspace.task ? `Working toward: ${workspace.task}` : "Ask the agent in its chat, or hand it work from the Companion.");
    active.update(own ?? { state: "idle", label: "Ready" });
    setCompanionSeed(character, id);
    character.dataset.variant = chats.get(workspace.conversationID)?.mascot ?? "classic";
    setCompanionState(character, own?.motion ?? "idle", own?.label);
    for (const row of agents.children) {
      const { label, detail, state, motion } = visuals[row.dataset.chat] ?? {};
      const badge = row.lastElementChild;
      badge.dataset.state = state ?? "idle";
      badge.textContent = label ?? "Ready";
      badge.title = detail ?? "";
      setCompanionState(row.firstElementChild, motion ?? "idle", label);
    }
  }

  async function refresh() {
    const revision = ++sequence;
    try {
      const [all, summaries] = await Promise.all([call("workspace.list"), call("chat.list")]);
      if (revision !== sequence) return;
      workspace = all.find(item => item.id === id);
      if (!workspace) throw new Error("This workspace is no longer available.");
      const own = all.filter(item => item.id === id || item.parentID === id);
      const valid = new Set(own.map(item => item.conversationID));
      for (const [chatID] of chats) if (!valid.has(chatID)) chats.delete(chatID);
      for (const member of own) {
        const summary = summaries.find(chat => chat.id === member.conversationID);
        chats.set(member.conversationID, { title: member.name, mascot: summary?.mascot });
      }
      error.hidden = true;
      draw();
      loadStory();
      const currentBranch = await call("fs.gitBranch", { path: workspace.directory });
      if (revision === sequence) { branch = currentBranch; draw(); }
    } catch (failure) {
      if (revision !== sequence) return;
      error.replaceChildren(el("span", { text: errorText(failure) }),
        isFolderPermissionError(failure) ? filesPrivacyButton(next => {
          error.replaceChildren(el("span", { text: errorText(next) }));
        }) : null);
      error.hidden = false;
    }
  }
  const unsubscribe = onEvent(({ event, data }) => {
    if (event === "chat.updated" && data.id === workspace?.conversationID) loadStory();
    if (event === "chat.updated" && chats.has(data.id)) {
      const prior = chats.get(data.id);
      if (prior.mascot !== data.mascot) { prior.mascot = data.mascot; draw(); }
    } else if (["workspace.created", "workspace.updated", "workspace.deleted"].includes(event) &&
      (data.id === id || data.parentID === id || data.parentId === id)) { refresh(); }
    else if (event === "terminal.state" && data.id === workspace?.terminalID && data.state === "idle") refresh();
  });
  const unwatch = watchVisualActivity(snapshot => snapshot.chats, next => { visuals = next; updateActivity(); });
  window.addEventListener("pagehide", () => { unsubscribe(); unwatch(); }, { once: true });
  return refresh();
}
