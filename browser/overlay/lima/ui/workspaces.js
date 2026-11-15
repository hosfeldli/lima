/* AI workspaces: index + per-workspace dashboard. A workspace is a folder on
 * disk, a terminal bound to it, an agent bound to it, and the tabs and
 * bookmarks the agent builds — shown together so the user can watch. */
import { b64, bar, bridge, call, el, errorText, icon, markdown, onEvent, relativeTime, setPage } from "./lib.js";
import { empty, skeleton, toast } from "./components.js";

const page = (...children) => el("div", { class: "page" , style: { maxWidth: "1280px", margin: "0 auto", width: "100%" } }, ...children);
const card = (title, iconName, ...children) => el("section", { class: "card" }, el("h2", {}, icon(iconName), title), ...children);
const short = path => path.replace(/^\/Users\/[^/]+/, "~");

function swatch(workspace) {
  return `linear-gradient(135deg, hsl(${workspace.hue} 85% 62%), hsl(${(workspace.hue + 50) % 360} 85% 56%))`;
}

// MARK: Index

export async function renderWorkspaces(app, showNew) {
  setPage("Workspaces", "workspace", 268);
  const grid = el("div", { class: "grid" }, skeleton(3));
  const form = newWorkspaceForm();
  const clis = el("div", { class: "row", style: { margin: "0 0 16px" } });
  form.hidden = !showNew;
  app.replaceChildren(
    bar("Workspaces", el("button", { class: "primary", onclick: () => { form.hidden = false; form.querySelector("input").focus(); } }, icon("plus"), "New AI Workspace")),
    page(
      el("section", { class: "hero" },
        el("h2", {}, "AI ", el("span", { class: "prism-text", text: "workspaces" })),
        el("p", { text: "Each workspace is a folder on your Mac, a terminal and an agent bound to it, and a Zen tab folder where the agent opens pages and files bookmarks — all visible as it works." })),
      form, clis, grid));
  call("agents.discover").then(list => clis.replaceChildren(...list.map(a => el("span", { class: `badge ${a.status === "available" ? "ok" : "warn"}`, title: a.executablePath ?? a.diagnostic ?? "" },
    el("span", { class: "dot" }), a.version ? `${a.provider} ${a.version}` : `${a.provider} not installed`)))).catch(() => {});

  async function load() {
    const [workspaces, chats] = await Promise.all([call("workspace.list"), call("chat.list")]);
    const running = new Set(chats.filter(c => c.running).map(c => c.id));
    grid.replaceChildren(...(workspaces.length ? workspaces.map(w => workspaceCard(w, running.has(w.conversationID))) : [empty("workspace", "No workspaces yet — create one to give an agent its own folder, terminal and tabs.")]));
  }
  onEvent(m => { if (m.event.startsWith("workspace.") || m.event === "chat.updated") load().catch(() => {}); });
  load().catch(error => grid.replaceChildren(el("p", { class: "error", text: errorText(error) })));
}

function workspaceCard(workspace, running) {
  return el("button", { class: "tile", style: { minHeight: "170px", padding: 0, overflow: "hidden", alignItems: "stretch" },
    onclick: () => bridge.openTab(`about:lima?workspace=${encodeURIComponent(workspace.id)}`) },
    el("div", { style: { height: "64px", background: swatch(workspace), display: "flex", alignItems: "flex-end", padding: "12px 16px", color: "white" } },
      el("strong", { style: { font: "700 18px/1.2 var(--font-display)" }, text: `✦ ${workspace.name}` })),
    el("div", { style: { padding: "12px 16px", display: "flex", flexDirection: "column", gap: "8px", width: "100%" } },
      el("code", { style: { fontSize: "12px", color: "var(--muted)" }, text: short(workspace.directory) }),
      el("div", { class: "row" },
        el("span", { class: `badge ${running ? "warn" : "ok"}` }, el("span", { class: `dot ${running ? "live" : ""}` }), running ? "agent working" : "agent idle"),
        el("span", { class: "badge", text: `${workspace.tabs.length} tabs` }),
        el("span", { class: "badge", text: `${workspace.bookmarks.length} bookmarks` }),
        el("span", { class: "badge", text: workspace.provider }))));
}

function newWorkspaceForm() {
  const name = el("input", { type: "text", placeholder: "Name — e.g. “Launch research”", style: { flex: 2, minWidth: "220px" } });
  const folder = el("input", { type: "text", placeholder: "Existing folder (optional) — e.g. ~/code/app", style: { flex: 2, minWidth: "220px" } });
  const provider = el("select", { "aria-label": "Agent CLI" }, ["claude", "codex", "opencode"].map(p => el("option", { value: p, text: p })));
  const task = el("textarea", { rows: 2, placeholder: "First task for the agent (optional) — e.g. “Research competitors, open their pricing pages, file them under Research/Pricing”", style: { width: "100%" } });
  const create = el("button", { class: "primary", onclick: submit }, icon("workspace"), "Create workspace");
  const form = el("section", { class: "card" },
    el("h2", {}, icon("plus"), "New AI workspace"),
    el("div", { class: "row", style: { marginBottom: "10px" } }, name, folder, provider),
    task,
    el("div", { class: "row", style: { marginTop: "10px", justifyContent: "space-between" } },
      el("span", { class: "muted", text: "Without a folder, Lima creates one in ~/Lima Workspaces. The agent may edit files only inside it." }), create));
  async function submit() {
    create.disabled = true;
    try {
      const workspace = await call("workspace.create", { name: name.value || "Workspace", directory: folder.value || null, provider: provider.value, task: task.value || null });
      toast(`Workspace “${workspace.name}” created`);
      bridge.openTab(`about:lima?workspace=${encodeURIComponent(workspace.id)}`);
      form.hidden = true;
      name.value = folder.value = task.value = "";
    } catch (error) {
      toast(errorText(error), "bad");
    } finally {
      create.disabled = false;
    }
  }
  name.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
  return form;
}

// MARK: Dashboard

export async function renderWorkspace(app, id) {
  let workspace;
  try {
    workspace = await call("workspace.ensureTerminal", { id });
  } catch (error) {
    setPage("Workspace unavailable", "workspace");
    app.replaceChildren(bar("Workspace"), page(empty("workspace", `This workspace is no longer available (${errorText(error)}).`)));
    return;
  }
  setPage(`✦ ${workspace.name}`, "workspace", workspace.hue);

  const agentStatus = el("span", { class: "badge ok" }, el("span", { class: "dot" }), "agent idle");
  const keyboard = el("span", { class: "badge", hidden: true });
  const messages = el("div", { style: { maxHeight: "420px", overflow: "auto", paddingRight: "6px" } }, skeleton(3));
  const instruction = el("textarea", { rows: 2, placeholder: "Tell the agent what to do in this workspace…", style: { width: "100%" } });
  const termHost = el("div", { style: { height: "300px", borderRadius: "12px", background: "#0b0c10", padding: "8px", overflow: "hidden", cursor: "pointer" },
    title: "Open the terminal tab", onclick: () => focusTab(`about:lima?terminal=${workspace.terminalID}`) });
  const tabsNode = el("div");
  const bookmarksNode = el("div");
  const filesNode = el("div", {}, skeleton(3));
  const feed = el("div", { class: "timeline" });

  app.replaceChildren(
    bar(`✦ ${workspace.name}`, agentStatus, keyboard,
      el("button", { onclick: () => focusTab(`about:lima?chat=${workspace.conversationID}`) }, icon("chat"), "Agent"),
      el("button", { onclick: () => focusTab(`about:lima?terminal=${workspace.terminalID}`) }, icon("terminal"), "Terminal"),
      el("button", { class: "ghost danger", onclick: removeWorkspace }, icon("trash"))),
    page(
      el("section", { style: { borderRadius: "var(--r-xl)", padding: "28px 32px", margin: "4px 0 20px", color: "white", background: swatch(workspace), boxShadow: "var(--shadow-2)", position: "relative", overflow: "hidden" } },
        el("div", { style: { font: "700 34px/1.1 var(--font-display)", letterSpacing: "-.02em" }, text: workspace.name }),
        el("div", { class: "row", style: { marginTop: "10px", opacity: .92 } }, icon("folder"), el("code", { text: short(workspace.directory) }),
          el("span", { text: "·" }), el("span", { text: `${workspace.provider} agent` }), el("span", { text: "·" }), el("span", { text: `created ${relativeTime(workspace.createdAt)}` }))),
      el("div", { class: "grid", style: { gridTemplateColumns: "minmax(0, 1.25fr) minmax(0, 1fr)" } },
        card("Agent", "spark", messages,
          el("div", { class: "composer-box", style: { marginTop: "12px" } }, instruction,
            el("div", { class: "row", style: { justifyContent: "flex-end" } }, el("button", { class: "primary", onclick: instruct }, icon("send"), "Send")))),
        el("div", {},
          card("Terminal", "terminal", termHost),
          card("Live actions", "activity", feed))),
      el("div", { class: "grid", style: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" } },
        card("Tabs", "tab", tabsNode),
        card("Bookmarks", "bookmark", bookmarksNode),
        card("Files", "file", filesNode))));

  function focusTab(url) {
    bridge.browser("workspaceFocusTab", { id: workspace.id, url }).then(found => { if (!found) bridge.openTab(url); });
  }

  async function removeWorkspace() {
    if (!confirm(`Remove workspace “${workspace.name}”? Its tabs folder and terminal close; the folder on disk (${short(workspace.directory)}) is kept.`)) return;
    await call("workspace.delete", { id: workspace.id });
    window.close();
  }

  async function instruct() {
    const text = instruction.value.trim();
    if (!text) return;
    instruction.value = "";
    try { await call("workspace.instruct", { id: workspace.id, text }); }
    catch (error) { instruction.value = text; toast(errorText(error), "bad"); }
  }
  instruction.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); instruct(); } });

  // Agent conversation
  let conversation = null;
  function drawConversation() {
    if (!conversation) return;
    const running = conversation.messages.some(m => m.status === "streaming");
    agentStatus.className = `badge ${running ? "warn" : "ok"}`;
    agentStatus.replaceChildren(el("span", { class: `dot ${running ? "live" : ""}` }), running ? "agent working" : "agent idle");
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    messages.replaceChildren(...(conversation.messages.length ? conversation.messages.slice(-12).map(m => el("div", { class: `msg ${m.role}`, style: { maxWidth: "none" } },
      el("div", { class: "meta" }, m.role === "user" ? "You" : `${conversation.provider} agent`),
      m.role === "user" ? el("div", { class: "bubble", text: m.text }) : el("div", {},
        m.tools.length ? el("div", { class: "tools" }, m.tools.slice(-6).map(t => el("div", { text: `↳ ${t.replace(/^mcp__lima__/, "")}` }))) : null,
        Object.assign(markdown(m.text || ""), { className: `md${m.status === "streaming" ? " typing" : ""}` }),
        m.error ? el("div", { class: "failure" }, el("strong", { text: m.error.kind }), el("span", { class: "grow", text: m.error.message })) : null)))
      : [empty("spark", "Give the agent its first task below.")]));
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
  call("chat.get", { id: workspace.conversationID }).then(c => { conversation = c; drawConversation(); }).catch(() => messages.replaceChildren(empty("chat", "Agent conversation unavailable")));

  // Live terminal mirror (read-only; typing happens in the terminal tab)
  let term = null;
  if (window.Terminal && workspace.terminalID) {
    term = new window.Terminal({ disableStdin: true, fontSize: 11, fontFamily: "SF Mono, Menlo, monospace", cursorBlink: false,
      theme: { background: "#0b0c10", foreground: "#d8dbe6" }, scrollback: 2000 });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    try { fit.fit(); } catch {}
    call("terminal.attach", { id: workspace.terminalID }).then(r => { term.write(b64.bytes(r.scrollback)); updateKeyboard(r.info); })
      .catch(() => termHost.replaceChildren(empty("terminal", "Terminal ended")));
  }
  function updateKeyboard(info) {
    const agent = info.owner.startsWith("agent:");
    keyboard.hidden = false;
    keyboard.className = `badge ${agent ? "warn" : ""}`;
    keyboard.replaceChildren(icon("terminal"), agent ? "agent has the keyboard" : info.pendingRequests.length ? "agent is asking for the keyboard" : "you have the keyboard");
  }

  // Tabs, bookmarks, files
  async function drawTabs() {
    const state = await bridge.browser("workspaceState", { id: workspace.id }).catch(() => ({ tabs: [] }));
    const tabs = state.tabs.length ? state.tabs : workspace.tabs;
    tabsNode.replaceChildren(tabs.length ? el("ul", { class: "list" }, tabs.map(t => el("li", { class: "clickable", "aria-selected": String(!!t.selected), onclick: () => focusTab(t.url) },
      icon(t.url?.startsWith("about:lima?terminal") ? "terminal" : t.url?.startsWith("about:lima?chat") ? "chat" : t.url?.startsWith("about:lima") ? "workspace" : "tab"),
      el("span", { class: "grow", text: t.title || t.url })))) : empty("tab", "No tabs yet"));
  }
  function drawBookmarks() {
    const groups = new Map();
    for (const b of workspace.bookmarks) {
      const key = b.folder || "(top level)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    bookmarksNode.replaceChildren(groups.size ? el("div", {}, [...groups].map(([folder, items]) => el("div", { style: { marginBottom: "10px" } },
      el("div", { class: "row muted", style: { fontSize: "12px", fontWeight: 600 } }, icon("folder"), folder),
      el("ul", { class: "list" }, items.map(b => el("li", { class: "clickable", onclick: () => bridge.openTab(b.url) }, icon("bookmark"), el("span", { class: "grow", text: b.title }))))))) : empty("bookmark", "The agent hasn't filed bookmarks yet"));
  }
  async function drawFiles() {
    const files = await call("workspace.files", { id: workspace.id }).catch(() => []);
    filesNode.replaceChildren(files.length ? el("ul", { class: "list", style: { maxHeight: "260px", overflow: "auto" } }, files.map(f => el("li", {},
      icon(f.directory ? "folder" : "file"), el("span", { class: "grow", text: f.name }), el("span", { class: "muted", style: { fontSize: "11px" }, text: f.directory ? "" : `${Math.max(1, Math.round(f.size / 1024))} KB` })))) : empty("file", "Empty folder"));
  }

  function logAction(iconName, text, hue = workspace.hue) {
    feed.prepend(el("div", { class: "event", style: { "--hue": hue } }, icon(iconName), el("span", { class: "grow", text }), el("span", { class: "muted", style: { fontSize: "11px" }, text: "now" })));
    while (feed.children.length > 40) feed.lastChild.remove();
  }
  feed.append(empty("activity", "Agent actions appear here as they happen"));

  onEvent(message => {
    const data = message.data;
    switch (message.event) {
      case "terminal.output":
        if (term && data.id === workspace.terminalID) term.write(b64.bytes(data.data));
        break;
      case "terminal.state":
        if (data.id === workspace.terminalID) updateKeyboard(data);
        break;
      case "terminal.command":
        if (data.id === workspace.terminalID) { feed.querySelector(".empty")?.remove(); logAction("terminal", `ran ${data.command}`); drawFiles(); }
        break;
      case "chat.delta":
      case "chat.updated":
        if ((data.conversationId ?? data.id) === workspace.conversationID) {
          if (message.event === "chat.updated") conversation = data;
          else { const m = conversation?.messages.find(x => x.id === data.messageId); if (m) m.text += data.text; }
          drawConversation();
        }
        break;
      case "workspace.updated":
        if (data.id === workspace.id) {
          feed.querySelector(".empty")?.remove();
          const newTabs = data.tabs.filter(t => !workspace.tabs.some(o => o.url === t.url));
          const newMarks = data.bookmarks.filter(b => !workspace.bookmarks.some(o => o.url === b.url && o.folder === b.folder));
          for (const t of newTabs) logAction("tab", `opened ${t.title}`);
          for (const b of newMarks) logAction("bookmark", `filed ${b.title} → ${b.folder || "top level"}`);
          workspace = data;
          drawBookmarks();
          setTimeout(drawTabs, 400);
        }
        break;
    }
  });

  drawTabs();
  drawBookmarks();
  drawFiles();
}
