import { bridge, call, el, errorText, filesPrivacyButton, icon, onEvent, setPage } from "./lib.js";
import { companion, setCompanionState, watchVisualActivity } from "./companion.js";
import { isFolderPermissionError } from "./tool-activity.sys.mjs";

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
  const active = el("span", { class: "badge" });
  app.replaceChildren(el("header", { class: "bar" }, character, title, active), page);
  page.append(error, meta, objective, sections, agents);
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
      workspace.terminalID ? open("terminal", "Terminal · Files · Changes", () => bridge.openTab("about:lima?terminal=" + workspace.terminalID)) : null,
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

  function updateActivity() {
    if (!workspace) return;
    const own = visuals[workspace.conversationID];
    active.textContent = own?.label ?? "Ready";
    character.dataset.variant = chats.get(workspace.conversationID)?.mascot ?? "classic";
    setCompanionState(character, own?.motion ?? "idle");
    for (const row of agents.children) {
      const { label, detail, state, motion } = visuals[row.dataset.chat] ?? {};
      const badge = row.lastElementChild;
      badge.dataset.state = state ?? "idle";
      badge.textContent = label ?? "Ready";
      badge.title = detail ?? "";
      setCompanionState(row.firstElementChild, motion ?? "idle");
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
