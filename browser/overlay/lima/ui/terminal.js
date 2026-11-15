/* A terminal tab, Orca-style: the file tree of its folder beside a shared
 * shell. The URL carries the session ID, so closing and restoring the tab
 * (or restarting the browser) reattaches to the same shell, which keeps
 * running in the Lima runtime. */
import { b64, bridge, call, el, errorText, icon, onEvent, prefs, setPage } from "./lib.js";

const home = path => path.replace(/^\/Users\/[^/]+/, "~");

export async function renderTerminal(app, sessionId) {
  let info;
  try {
    if (!sessionId) {
      // Give the tab a permanent URL for this session so restore and
      // bookmarks reattach to the same shell.
      info = await call("terminal.create", { cols: 100, rows: 30 });
      bridge.replaceURL(`about:lima?terminal=${encodeURIComponent(info.id)}`);
      return;
    }
    const attached = await call("terminal.attach", { id: sessionId });
    info = attached.info;
    mountTerminal(app, info, attached.scrollback);
  } catch (error) {
    // A workspace's terminal heals itself (the runtime restarted, or the shell exited).
    const workspaces = await call("workspace.list").catch(() => []);
    const owner = workspaces.find(w => w.terminalID === sessionId);
    if (owner) {
      const healed = await call("workspace.ensureTerminal", { id: owner.id }).catch(() => null);
      if (healed?.terminalID && healed.terminalID !== sessionId) { bridge.replaceURL(`about:lima?terminal=${encodeURIComponent(healed.terminalID)}`); return; }
    }
    setPage("Terminal ended", "terminal");
    app.replaceChildren(el("div", { class: "ended" },
      icon("terminal"),
      el("p", { text: `This shell is no longer running (${errorText(error)}).` }),
      el("button", { class: "primary", onclick: () => bridge.replaceURL("about:lima?view=terminal") }, "Start a new shell")));
  }
}

function mountTerminal(app, info, scrollback) {
  const stateBadge = el("span", { class: "chip-state" });
  const ownerBadge = el("span", { class: "chip-owner", hidden: true });
  const leaseBar = el("div", { class: "lease", hidden: true });
  const host = el("div", { class: "terminal-host" });
  const tree = el("div", { class: "tree", role: "tree" });
  const rootLabel = el("span", { class: "explorer-root" });
  const explorer = el("aside", { class: "explorer" },
    el("div", { class: "explorer-head" }, el("span", { text: "Files" }), rootLabel,
      el("button", { class: "ghost icon-only", title: "Refresh", onclick: () => refreshTree() }, icon("redo"))),
    tree);
  const preview = el("section", { class: "file-preview", hidden: true });
  const historyList = el("div", { class: "history", hidden: true });
  const toggleTree = el("button", { class: "ghost icon-only", title: "Toggle file tree", onclick: () => setTree(explorer.hidden) }, icon("folder"));
  const path = el("span", { class: "term-path" });
  // Inside a workspace folder the tab keeps the name "Terminal".
  let inWorkspace = false;
  bridge.browser("workspaceOf", {}).then(id => { inWorkspace = !!id; update(info); }).catch(() => {});

  app.replaceChildren(el("div", { class: "orca" },
    explorer,
    el("main", { class: "term-main" },
      el("header", { class: "term-bar" }, el("span", { class: "tab" }, "Terminal"), toggleTree, path, stateBadge, ownerBadge, el("span", { class: "spacer" }),
        el("button", { class: "ghost", onclick: toggleHistory }, "History"),
        el("button", { class: "ghost danger", title: "End this shell", onclick: closeSession }, "End shell")),
      leaseBar, historyList,
      el("div", { class: "term-split" }, host, preview))));

  function setTree(show) {
    explorer.hidden = !show;
    prefs.set("terminal.tree", show ? "1" : "0");
  }
  setTree(prefs.get("terminal.tree", "1") === "1");

  const term = new window.Terminal({
    cursorBlink: true, fontFamily: "SF Mono, Menlo, monospace", fontSize: 13, lineHeight: 1.15, scrollback: 10000, allowProposedApi: false,
    theme: matchMedia("(prefers-color-scheme: light)").matches
      ? { background: "#ffffff", foreground: "#111111", cursor: "#e60012", cursorAccent: "#ffffff", selectionBackground: "#f9c9cd", red: "#c4000f", brightRed: "#e60012" }
      : { background: "#141414", foreground: "#f2f2f2", cursor: "#ff2a3a", cursorAccent: "#141414", selectionBackground: "#5a1d22", red: "#ff5a66", brightRed: "#ff2a3a" },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (scrollback) term.write(b64.bytes(scrollback));
  const resize = () => {
    try { fit.fit(); } catch { return; }
    call("terminal.resize", { id: info.id, cols: term.cols, rows: term.rows }).catch(() => {});
  };
  new ResizeObserver(resize).observe(host);
  resize();
  term.focus();

  term.onData(data => call("terminal.write", { id: info.id, data: b64.encode(data) }).catch(error => term.write(`\r\n[lima] ${errorText(error)}\r\n`)));
  term.onBinary(data => {
    const bytes = Uint8Array.from(data, c => c.charCodeAt(0) & 255);
    call("terminal.write", { id: info.id, data: btoa(String.fromCharCode(...bytes)) }).catch(() => {});
  });

  // MARK: File tree

  let root = null;
  const open = new Set(JSON.parse(prefs.get(`tree.${info.id}`, "[]")));
  async function refreshTree() {
    if (!root) return;
    const scroll = tree.scrollTop;
    tree.replaceChildren(...await branch(root, 0));
    tree.scrollTop = scroll;
  }
  async function branch(dir, depth) {
    let entries;
    try { entries = await call("fs.list", { path: dir }); }
    catch (error) { return [el("div", { class: "tree-note", text: errorText(error) })]; }
    if (!entries.length && depth === 0) return [el("div", { class: "tree-note", text: "Empty folder" })];
    const rows = [];
    for (const entry of entries) {
      const expanded = entry.directory && open.has(entry.path);
      const row = el("div", { class: `tree-row${entry.directory ? " dir" : ""}${expanded ? " open" : ""}`, role: "treeitem", title: home(entry.path),
        style: { paddingLeft: `${8 + depth * 14}px` },
        onclick: async () => {
          if (entry.directory) {
            if (open.has(entry.path)) open.delete(entry.path); else open.add(entry.path);
            prefs.set(`tree.${info.id}`, JSON.stringify([...open]));
            refreshTree();
          } else showFile(entry);
        } },
        entry.directory ? icon("chevron", "icon twisty") : el("span", { class: "twisty-space" }),
        icon(entry.directory ? "folder" : "file"),
        el("span", { class: "tree-name", text: entry.name }));
      rows.push(row);
      if (expanded) rows.push(...await branch(entry.path, depth + 1));
    }
    return rows;
  }
  async function showFile(entry) {
    preview.hidden = false;
    preview.replaceChildren(el("div", { class: "preview-head" }, icon("file"), el("span", { class: "grow", text: entry.name }),
      el("button", { class: "ghost", title: "Type this path into the terminal", onclick: () => call("terminal.write", { id: info.id, data: b64.encode(shellQuote(entry.path) + " ") }) }, "Insert path"),
      el("button", { class: "ghost icon-only", title: "Close", onclick: () => { preview.hidden = true; resize(); } }, icon("close"))),
      el("div", { class: "muted", style: { padding: "12px" }, text: "Loading…" }));
    resize();
    try {
      const file = await call("fs.read", { path: entry.path });
      const body = file.binary ? el("div", { class: "muted", style: { padding: "12px" }, text: "Binary file — not shown." })
        : el("pre", { class: "code" }, ...file.text.split("\n").map((line, i) => el("div", { class: "line" }, el("span", { class: "ln", text: String(i + 1) }), el("span", { text: line || " " }))));
      preview.replaceChildren(preview.firstChild, body, file.truncated ? el("div", { class: "muted", style: { padding: "6px 12px" }, text: "Showing the first 256 KB." }) : "");
    } catch (error) {
      preview.lastChild.textContent = errorText(error);
    }
  }
  const shellQuote = s => /^[\w./~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

  // Files change as commands run (and as the agent works): refresh after
  // each command and every few seconds while visible.
  setInterval(() => { if (!document.hidden && !explorer.hidden) refreshTree(); }, 4000);

  // MARK: State

  function update(next) {
    info = next;
    const label = { idle: "idle", running: "running", waitingForInput: "waiting for input", exited: `exited ${info.exitCode ?? ""}`, uncertain: "", disconnected: "disconnected" }[info.state] ?? info.state;
    const agentHasKeyboard = info.owner.startsWith("agent:");
    stateBadge.textContent = label;
    stateBadge.hidden = !label || agentHasKeyboard;
    stateBadge.dataset.state = info.state;
    const agent = info.owner.startsWith("agent:") ? info.owner.slice(6) : null;
    ownerBadge.hidden = !agent;
    ownerBadge.replaceChildren(...(agent ? [el("i", { class: "live" }), "agent typing"] : []));
    path.textContent = home(info.cwd);
    if (root !== info.cwd) {
      root = info.cwd;
      rootLabel.textContent = info.cwd.split("/").filter(Boolean).pop() ?? "/";
      refreshTree();
    }
    setPage(`${info.state === "running" ? "▶ " : ""}${inWorkspace ? "Terminal" : home(info.cwd).split("/").pop() || "Terminal"}`, "terminal");

    leaseBar.replaceChildren();
    if (agent) {
      leaseBar.hidden = false;
      leaseBar.append(el("span", { class: "grow", text: "The agent is typing here. Type anything to take the keyboard back." }),
        el("button", { onclick: () => call("terminal.lease.reclaim", { id: info.id }) }, "Take back"));
    } else if (info.pendingRequests.length) {
      leaseBar.hidden = false;
      leaseBar.append(el("span", { class: "grow", text: "The agent is asking to type in this terminal." }),
        el("button", { class: "primary", onclick: () => call("terminal.lease.grant", { id: info.id, agentId: info.pendingRequests[0] }) }, "Allow"),
        el("button", { onclick: () => call("terminal.lease.deny", { id: info.id, agentId: info.pendingRequests[0] }) }, "Deny"));
    } else {
      leaseBar.hidden = true;
    }
  }
  update(info);

  async function toggleHistory() {
    historyList.hidden = !historyList.hidden;
    if (historyList.hidden) return;
    const commands = await call("terminal.history", { id: info.id });
    historyList.replaceChildren(...commands.slice().reverse().slice(0, 50).map(c => el("button", { class: "history-row", title: "Insert into terminal",
      onclick: () => { call("terminal.write", { id: info.id, data: b64.encode(c.command) }); historyList.hidden = true; term.focus(); } },
      el("code", { text: c.command }),
      c.exitStatus === null || c.exitStatus === undefined ? null : el("span", { class: `exit ${c.exitStatus === 0 ? "ok" : "bad"}`, text: String(c.exitStatus) }))));
    if (!commands.length) historyList.append(el("div", { class: "muted", style: { padding: "8px 12px" }, text: "No commands yet." }));
  }

  async function closeSession() {
    if (info.state !== "exited" && !confirm("End this shell? Running programs will be stopped.")) return;
    await call("terminal.close", { id: info.id }).catch(() => {});
    window.close();
  }

  onEvent(message => {
    if (message.event === "terminal.output" && message.data.id === info.id) term.write(b64.bytes(message.data.data));
    else if (message.event === "terminal.state" && message.data.id === info.id) update(message.data);
    else if (message.event === "terminal.command" && message.data.id === info.id) setTimeout(refreshTree, 600);
  });
}
