import { bridge, call, el, errorText, filesPrivacyButton, icon, onEvent, setPage } from "./lib.js";
import { companion, setCompanionState } from "./companion.js";
import { isFolderPermissionError, lastVisibleTool, replyActivity } from "./tool-activity.sys.mjs";

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
    const working = [...chats.values()].filter(chat => chat.status === "streaming").length;
    active.textContent = working ? working + " working" : "Ready";
    const latest = [...chats.values()].findLast(chat => chat.status === "streaming") ?? chats.get(workspace.conversationID);
    character.dataset.variant = latest?.mascot ?? "classic";
    const describe = chat => replyActivity(chat, { provider: chat?.provider, tool: chat?.tool });
    setCompanionState(character, describe(latest).motion ?? "idle");
    agents.replaceChildren(...[...chats.values()].map(chat => {
      const { label, detail, state } = describe(chat);
      return el("div", { class: "workspace-agent-row" }, icon("agents"), el("span", { class: "grow", text: chat.title }),
        el("span", { class: "handoff-state", "data-state": state, text: label, title: detail }));
    }));
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
        if (chats.has(member.conversationID)) continue;
        const summary = summaries.find(chat => chat.id === member.conversationID);
        chats.set(member.conversationID, { title: member.name, provider: summary?.provider, mascot: summary?.mascot,
          status: summary?.running ? "streaming" : summary?.lastStatus ?? "idle", error: { kind: summary?.lastErrorKind }, progress: summary?.lastProgress });
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
      const reply = data.messages?.findLast(message => message.role === "assistant");
      const prior = chats.get(data.id);
      const tool = prior.id === reply?.id && prior.tools?.length === reply?.tools?.length ? prior.tool : lastVisibleTool(reply?.tools);
      chats.set(data.id, { title: prior.title, provider: data.provider, mascot: data.mascot, ...reply, tool });
      draw();
    } else if (event === "chat.delta") {
      const chat = chats.get(data.conversationId);
      if (chat?.id === data.messageId && (chat.tool || !chat.text?.trim()) && data.text?.trim()) {
        chat.tool = undefined;
        chat.text = data.text;
        draw();
      }
    } else if (["workspace.created", "workspace.updated", "workspace.deleted"].includes(event) &&
      (data.id === id || data.parentID === id || data.parentId === id)) { refresh(); }
    else if (event === "terminal.state" && data.id === workspace?.terminalID && data.state === "idle") refresh();
  });
  window.addEventListener("pagehide", unsubscribe, { once: true });
  return refresh();
}
