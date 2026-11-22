/* A terminal tab, Orca-style: the file tree of its folder beside a shared
 * shell. The URL carries the session ID, so closing and restoring the tab
 * (or restarting the browser) reattaches to the same shell, which keeps
 * running in the Lima runtime. */
import { activityStatus, b64, bridge, call, el, errorText, filesPrivacyButton, icon, onEvent, prefs, setPage } from "./lib.js";
import { failureActivity, isFolderPermissionError } from "./tool-activity.sys.mjs";
import { companion, setCompanionState, watchVisualActivity } from "./companion.js";

const home = path => path.replace(/^\/Users\/[^/]+/, "~");

export async function renderTerminal(app, sessionId) {
  setPage("Terminal", "terminal");
  const status = activityStatus();
  const actions = el("div", { class: "row" });
  app.replaceChildren(el("div", { class: "terminal-recovery" }, status.node, actions));
  status.update({ state: "starting", label: sessionId ? "Attaching to shell" : "Starting shell", icon: "terminal", motion: "terminal", startedAt: Date.now() });
  const pending = [];
  const unsubscribe = onEvent(message => {
    if (message.data?.id === sessionId && message.event.startsWith("terminal.")) pending.push(message);
  });
  try {
    if (!sessionId) {
      // Give the tab a permanent URL for this session so restore and
      // bookmarks reattach to the same shell.
      const info = await call("terminal.create", { cols: 100, rows: 30 });
      bridge.replaceURL(`about:lima?terminal=${encodeURIComponent(info.id)}`);
      return;
    }
    const attached = await call("terminal.attach", { id: sessionId });
    if (attached.info.state === "exited") throw new Error(`terminal ${sessionId} has exited`);
    mountTerminal(app, attached, pending);
  } catch (error) {
    if (!status.node.isConnected) app.replaceChildren(el("div", { class: "terminal-recovery" }, status.node, actions));
    if (sessionId && terminalEnded(error)) {
      try {
        const workspaceId = await bridge.browser("workspaceOf", {});
        if (workspaceId) {
          await restartTerminal(sessionId, workspaceId);
          return;
        }
      } catch (restartError) {
        showFailure(restartError, true);
        return;
      }
    }
    showFailure(error);
  } finally { unsubscribe(); }

  function showFailure(error, restarting = false) {
    const missing = terminalEnded(error);
    status.update(failureActivity(error, missing ? "Shell ended" : "Terminal unavailable"));
    actions.replaceChildren(el("button", { class: "primary", onclick: async () => {
      if (!missing && !restarting) { renderTerminal(app, sessionId); return; }
      actions.replaceChildren();
      status.update({ state: "starting", label: "Starting shell", icon: "terminal", motion: "terminal", startedAt: Date.now() });
      try { await restartTerminal(sessionId); }
      catch (restartError) { showFailure(restartError, true); }
    } }, missing ? "Start a new shell" : "Retry"),
    isFolderPermissionError(error) ? filesPrivacyButton(next => showFailure(next, restarting || missing)) : null);
  }
}

function terminalEnded(error) {
  return /\bterminal .+ (?:not found|has exited)\b/i.test(errorText(error));
}

async function restartTerminal(sessionId, context = null) {
  context ||= await bridge.browser("workspaceOf", {});
  const workspaceId = context || (await call("workspace.list")).find(item => item.terminalID === sessionId)?.id;
  if (workspaceId) {
    const workspace = await call("workspace.ensureTerminal", { id: workspaceId });
    if (!workspace.terminalID) throw new Error("The workspace did not return a shell");
    // Workspace reconciliation opens the new member tab if it replaces the old one.
    if (!context || workspace.terminalID === sessionId) bridge.replaceURL(`about:lima?terminal=${encodeURIComponent(workspace.terminalID)}`);
  } else {
    bridge.replaceURL("about:lima?view=terminal");
  }
}

function mountTerminal(app, attached, pending) {
  let { info } = attached;
  let offset = attached.offset ?? 0;
  let resyncing = false;
  const status = activityStatus();
  const mascot = companion("workspace-avatar");
  const notice = el("div", { class: "terminal-notice", hidden: true });
  const leaseBar = el("div", { class: "lease", hidden: true });
  let hadAgent = false;
  let returnedTimer;
  const host = el("div", { class: "terminal-host" });
  const tree = el("div", { class: "tree", role: "tree" });
  const rootLabel = el("span", { class: "explorer-root" });
  const filesButton = el("button", { class: "ghost", "aria-pressed": "true", onclick: () => setMode("files") }, "Files");
  const changesButton = el("button", { class: "ghost", "aria-pressed": "false", onclick: () => setMode("changes") }, "Changes");
  const explorer = el("aside", { class: "explorer" },
    el("div", { class: "explorer-head" }, filesButton, changesButton,
      el("span", { class: "spacer" }),
      el("button", { class: "ghost icon-only", title: "Refresh", "aria-label": "Refresh files", onclick: () => refreshInfo() }, icon("redo"))),
    rootLabel, tree);
  const preview = el("section", { class: "file-preview", hidden: true });
  const historyList = el("div", { class: "history", hidden: true });
  const toggleTree = el("button", { class: "ghost icon-only", title: "Toggle file tree", onclick: () => setTree(explorer.hidden) }, icon("folder"));
  const path = el("span", { class: "term-path" });
  // Inside a workspace folder the tab keeps the name "Terminal".
  let inWorkspace = false;
  let visual;
  bridge.browser("workspaceOf", {}).then(id => {
    inWorkspace = !!id;
    if (id && !document.hidden) update(info);
    if (id) {
      const stop = watchVisualActivity(snapshot => snapshot.workspaces[id], activity => {
        visual = activity;
        paintStatus();
      });
      window.addEventListener("pagehide", stop, { once: true });
    }
  }).catch(() => {});

  app.replaceChildren(el("div", { class: "orca" },
    explorer,
    el("main", { class: "term-main" },
      el("header", { class: "term-bar" }, mascot, el("span", { class: "tab" }, "Terminal"), toggleTree, path, el("span", { class: "spacer" }),
        el("button", { class: "ghost", onclick: toggleHistory }, "History"),
        el("button", { class: "ghost danger", title: "End this shell", onclick: closeSession }, "End shell")),
      status.node, notice, leaseBar, historyList,
      el("div", { class: "term-split" }, host, preview))));

  function setTree(show) {
    explorer.hidden = !show;
    if (show) refreshTree();
    prefs.set("terminal.tree", show ? "1" : "0");
  }
  explorer.hidden = prefs.get("terminal.tree", "1") !== "1";

  const theme = getComputedStyle(document.documentElement);
  const color = key => theme.getPropertyValue("--lima-" + key).trim();
  const term = new window.Terminal({
    cursorBlink: true, fontFamily: "SF Mono, Menlo, monospace", fontSize: 13, lineHeight: 1.15, scrollback: 10000, allowProposedApi: false,
    theme: { background: color("bg"), foreground: color("fg"), cursor: color("accent"), cursorAccent: color("bg"),
      selectionBackground: color("accent-fill"), red: color("error"), brightRed: color("error"), green: color("success"),
      yellow: color("warning"), blue: color("info") },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (attached.scrollback) term.write(b64.bytes(attached.scrollback));
  let reportedSize = `${attached.info.cols}x${attached.info.rows}`;
  const resize = () => {
    try { fit.fit(); } catch { return; }
    const size = `${term.cols}x${term.rows}`;
    if (size === reportedSize || info.state === "exited") return;
    reportedSize = size;
    call("terminal.resize", { id: info.id, cols: term.cols, rows: term.rows }).catch(() => {
      if (reportedSize === size) reportedSize = "";
    });
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  resize();
  term.focus();

  let writes = Promise.resolve();
  function sendInput(data) {
    if (info.state === "exited") return writes;
    writes = writes.then(() => call("terminal.write", { id: info.id, data }))
      .catch(error => showNotice(error, "Input could not be delivered"));
    return writes;
  }
  term.onData(data => sendInput(b64.encode(data)));
  term.onBinary(data => sendInput(btoa(data)));

  let root = null;
  let mode = "files";
  let requested = 0;
  let rendered = "";
  let previewRequest = 0;
  let stateRevision = 0;
  let refreshing = false;
  let connectionError;
  let workingSince;
  const open = new Set(JSON.parse(prefs.get(`tree.${info.id}`, "[]")));
  const collapsedChanges = new Set();

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    filesButton.setAttribute("aria-pressed", String(mode === "files"));
    changesButton.setAttribute("aria-pressed", String(mode === "changes"));
    tree.scrollTop = 0;
    refreshTree();
  }

  async function refreshTree() {
    if (!root || explorer.hidden) return;
    const request = ++requested;
    const directory = root;
    let rows;
    try {
      rows = mode === "files" ? await branch(directory, 0) : await changes(directory);
    } catch (error) {
      rows = [treeError(error)];
    }
    if (request !== requested) return;
    const signature = rows.map(row => row.outerHTML).join("");
    if (signature === rendered) return;
    rendered = signature;
    const scroll = tree.scrollTop;
    tree.replaceChildren(...rows);
    tree.scrollTop = scroll;
  }

  async function changes(directory) {
    const result = await call("fs.changes", { path: directory, terminalId: info.id });
    const message = !result ? "This folder is outside a Git repository" : !result.files.length ? "No changes" : "";
    if (message) return [el("div", { class: "tree-note", text: message })];
    const hierarchy = new Map();
    const normalize = path => path.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "").replace(/\/$/, "");
    const parent = normalize(result.directory ?? directory);
    for (const change of result.files) {
      const normalized = normalize(change.path);
      const parts = normalized.startsWith(parent + "/") ? normalized.slice(parent.length + 1).split("/") : [change.path];
      const name = parts.pop();
      let level = hierarchy;
      let prefix = parent;
      for (const part of parts) {
        prefix += "/" + part;
        if (!level.has(part)) level.set(part, { path: prefix, children: new Map() });
        level = level.get(part).children;
      }
      level.set(name, change);
    }

    function changeRows(level, depth) {
      const rows = [];
      for (const [name, change] of level) {
        const folder = !!change.children;
        const expanded = folder && !collapsedChanges.has(change.path);
        const status = change.status?.trim();
        rows.push(el("button", { class: `tree-row change-row${folder ? " dir" : ""}${expanded ? " open" : ""}`,
          role: "treeitem", "aria-expanded": folder ? String(expanded) : null, title: change.previous ? `${home(change.previous)} → ${home(change.path)}` : home(change.path),
          style: { paddingLeft: `${8 + depth * 14}px` },
          onclick: () => {
            if (folder) {
              if (expanded) collapsedChanges.add(change.path); else collapsedChanges.delete(change.path);
              refreshTree();
            } else showDiff({ ...change, name });
          } },
          folder ? icon("chevron", "icon twisty") : el("span", { class: "twisty-space" }),
          icon(folder ? "folder" : "file"), el("span", { class: "tree-name grow", text: name }),
          status ? el("span", { class: "change-status", "data-status": status, text: status, title: "Git status (index and worktree)" }) : null));
        if (expanded) rows.push(...changeRows(change.children, depth + 1));
      }
      return rows;
    }
    const rows = changeRows(hierarchy, 0);
    if (result.truncated) rows.push(el("div", { class: "tree-note", text: "Showing the first 500 changes" }));
    return rows;
  }

  async function refreshInfo() {
    if (refreshing || info.state === "exited") return;
    refreshing = true;
    const revision = stateRevision;
    try {
      const latest = await call("terminal.info", { id: info.id });
      if (revision === stateRevision) {
        const recovered = !!connectionError;
        connectionError = undefined;
        update(latest);
        if (recovered) resync();
      }
      refreshTree();
    } catch (error) {
      if (revision === stateRevision) {
        if (terminalEnded(error) && !connectionError) showNotice(error, "Shell ended", restart);
        connectionError = error;
        paintStatus();
      }
    } finally { refreshing = false; }
  }

  function treeError(error) {
    return el("div", { class: "tree-note" }, el("div", { text: errorText(error) }),
      isFolderPermissionError(error) ? filesPrivacyButton(next => showNotice(next, "Could not open settings")) : null);
  }

  async function branch(dir, depth) {
    let entries;
    try { entries = await call("fs.list", { path: dir, terminalId: info.id }); }
    catch (error) { return [treeError(error)]; }
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
  async function showDiff(entry) {
    const request = ++previewRequest;
    const args = { path: entry.path, previous: entry.previous, terminalId: info.id };
    const content = el("div", { class: "diff-body", text: "Loading diff…" });
    const control = (action, label) => el("button", { class: "ghost", onclick: async () => {
      try {
        await call("fs.gitFile", { ...args, action });
        refreshTree();
        showDiff(entry);
      } catch (error) { content.prepend(el("p", { class: "error", text: errorText(error) })); }
    } }, label);
    const stage = control("stage", "Stage");
    const unstage = control("unstage", "Unstage");
    stage.hidden = unstage.hidden = true;
    preview.hidden = false;
    preview.replaceChildren(el("div", { class: "preview-head" }, icon("file"),
      el("span", { class: "grow", text: entry.name }), stage, unstage,
      el("button", { class: "ghost icon-only", title: "Close diff", onclick: () => { preview.hidden = true; resize(); } }, icon("close"))), content);
    resize();
    try {
      const diff = await call("fs.gitFile", args);
      if (request !== previewRequest) return;
      const chunk = (label, text) => el("section", { class: "diff-chunk" }, el("h3", { text: label }),
        el("pre", {}, ...text.trimEnd().split("\n").map(line => el("div", {
          class: line.startsWith("+") && !line.startsWith("+++") ? "addition"
            : line.startsWith("-") && !line.startsWith("---") ? "deletion" : line.startsWith("@@") ? "hunk" : "",
          text: line || " ",
        }))));
      stage.hidden = !diff.unstaged;
      unstage.hidden = !diff.staged;
      content.replaceChildren(diff.staged ? chunk("Staged", diff.staged) : null, diff.unstaged ? chunk("Working tree", diff.unstaged) : null,
        !diff.staged && !diff.unstaged ? el("p", { text: "No diff for this file." }) : null,
        diff.truncated ? el("p", { class: "muted", text: "Preview truncated." }) : null);
    } catch (error) { if (request === previewRequest) content.textContent = errorText(error); }
  }

  async function showFile(entry) {
    const request = ++previewRequest;
    preview.hidden = false;
    preview.replaceChildren(el("div", { class: "preview-head" }, icon("file"), el("span", { class: "grow", text: entry.name }),
      el("button", { class: "ghost", title: "Type this path into the terminal", onclick: () => { sendInput(b64.encode(shellQuote(entry.path) + " ")); term.focus(); } }, "Insert path"),
      el("button", { class: "ghost icon-only", title: "Close", onclick: () => { preview.hidden = true; resize(); } }, icon("close"))),
      el("div", { class: "muted", style: { padding: "12px" }, text: "Loading…" }));
    resize();
    try {
      const file = await call("fs.read", { path: entry.path, terminalId: info.id });
      if (request !== previewRequest) return;
      const body = file.binary ? el("div", { class: "muted", style: { padding: "12px" }, text: "Binary file — not shown." })
        : el("pre", { class: "code" }, ...file.text.split("\n").map((line, i) => el("div", { class: "line" }, el("span", { class: "ln", text: String(i + 1) }), el("span", { text: line || " " }))));
      preview.replaceChildren(preview.firstChild, body, file.truncated ? el("div", { class: "muted", style: { padding: "6px 12px" }, text: "Showing the first 256 KB." }) : "");
    } catch (error) {
      if (request === previewRequest) preview.lastChild.textContent = errorText(error);
    }
  }
  const shellQuote = s => /^[\w./~-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

  // Files change as commands run (and as the agent works): refresh after
  // each command and every few seconds while visible.
  const polling = setInterval(() => { if (!document.hidden) refreshInfo(); }, 2500);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshInfo(); });

  // MARK: State

  function paintStatus() {
    if (connectionError) {
      const result = failureActivity(connectionError, "Terminal disconnected");
      status.update({ ...result, state: result.state === "failed" ? "disconnected" : result.state });
      setCompanionState(mascot, "paused");
      return;
    }
    const terminalMotion = { icon: "terminal", motion: "terminal", startedAt: workingSince };
    const agent = info.owner.startsWith("agent:");
    let next;
    if (info.state === "exited") next = { state: "disconnected", label: "Shell ended", detail: info.exitCode != null ? `Exit status ${info.exitCode}` : "", icon: "terminal" };
    else if (info.state === "disconnected") next = { state: "disconnected", label: "Shell disconnected", icon: "warning" };
    else if (info.shellReady === false) next = { ...terminalMotion, state: "starting", label: "Waiting for the first shell prompt" };
    else if (info.pendingRequests.length && !agent) next = { state: "blocked", label: "Agent is requesting keyboard access", icon: "warning" };
    else if (info.state === "waitingForInput") next = { state: "blocked", label: "Command waiting for input", icon: "terminal" };
    else if (info.state === "running") next = { ...terminalMotion, state: "working", label: agent ? "Agent running a command" : "Command running" };
    else if (agent) next = { state: "idle", label: "Agent has terminal control", icon: "terminal" };
    else if (info.userEditing) next = { state: "idle", label: "Editing at the prompt", icon: "terminal" };
    else if (info.state === "uncertain") next = { state: "idle", label: "Terminal connected", detail: "Waiting for a shell status update", icon: "terminal" };
    else next = { state: "idle", label: "Prompt ready", icon: "terminal" };
    status.update(next);
    const attention = ["blocked", "waiting"].includes(next.state);
    const active = agent && info.state === "running" && visual?.motion === "terminal";
    setCompanionState(mascot, active ? "terminal" : attention ? "waiting" : next.state === "disconnected" ? "paused" : "idle");
  }

  function showNotice(error, label, recover) {
    notice.hidden = false;
    notice.replaceChildren(el("span", { class: "grow", text: error ? `${label} · ${errorText(error)}` : label }),
      isFolderPermissionError(error) ? filesPrivacyButton(next => showNotice(next, "Could not open settings", recover)) : null,
      recover ? el("button", { class: "ghost", onclick: recover }, "Start a new shell") : null,
      el("button", { class: "ghost icon-only", "aria-label": "Dismiss notice", onclick: () => { notice.hidden = true; } }, icon("close")));
  }

  async function restart() {
    notice.hidden = true;
    status.update({ state: "starting", label: "Starting shell", icon: "terminal", motion: "terminal", startedAt: Date.now() });
    try { await restartTerminal(info.id); }
    catch (error) {
      status.update(failureActivity(error, "Could not start shell"));
      showNotice(error, "Could not start shell", restart);
    }
  }

  function update(next) {
    info = next;
    if (info.state === "running" || info.shellReady === false) workingSince ??= Date.now();
    else workingSince = undefined;
    const agent = info.owner.startsWith("agent:") ? info.owner.slice(6) : null;
    paintStatus();
    if (info.state === "exited") showNotice(null, "Scrollback is still available", restart);
    path.textContent = home(info.cwd);
    if (root !== info.cwd) {
      root = info.cwd;
      rootLabel.textContent = rootLabel.title = home(info.cwd);
      tree.scrollTop = 0;
      refreshTree();
    }
    setPage(`${info.state === "running" ? "▶ " : ""}${inWorkspace ? "Terminal" : home(info.cwd).split("/").pop() || "Terminal"}`, "terminal");

    // Ownership bar: visible only while a handoff is active, plus a brief
    // confirmation when control comes back to the user.
    leaseBar.replaceChildren();
    clearTimeout(returnedTimer);
    if (agent) {
      leaseBar.hidden = false;
      leaseBar.dataset.state = "agent";
      leaseBar.append(el("span", { class: "grow", text: "Agent has terminal control. Typing anything also takes it back." }),
        el("button", { class: "primary", onclick: () => keyboard("reclaim") }, "Take Back Control"));
    } else if (info.pendingRequests.length) {
      leaseBar.hidden = false;
      leaseBar.dataset.state = "request";
      leaseBar.append(el("span", { class: "grow", text: "Agent is requesting keyboard access" }),
        el("button", { class: "primary", onclick: () => keyboard("grant") }, "Allow"),
        el("button", { onclick: () => keyboard("deny") }, "Deny"));
    } else if (hadAgent) {
      leaseBar.hidden = false;
      leaseBar.dataset.state = "returned";
      leaseBar.append(el("span", { class: "grow", text: "Terminal control returned to you" }));
      returnedTimer = setTimeout(() => { if (leaseBar.dataset.state === "returned") leaseBar.hidden = true; }, 3000);
    } else {
      leaseBar.hidden = true;
    }
    hadAgent = !!agent;
  }
  update(info);

  async function keyboard(action) {
    try { await call(`terminal.lease.${action}`, { id: info.id, agentId: info.pendingRequests[0] }); }
    catch (error) { showNotice(error, "Could not change keyboard access"); }
  }

  async function toggleHistory() {
    historyList.hidden = !historyList.hidden;
    if (historyList.hidden) return;
    const commands = await call("terminal.history", { id: info.id }).catch(error => {
      historyList.replaceChildren(el("p", { class: "error", text: errorText(error) }));
      return null;
    });
    if (!commands) return;
    historyList.replaceChildren(...commands.slice().reverse().slice(0, 50).map(c => el("button", { class: "history-row", title: "Insert into terminal",
      onclick: () => { sendInput(b64.encode(c.command)); historyList.hidden = true; term.focus(); } },
      el("code", { text: c.command }),
      c.exitStatus === null || c.exitStatus === undefined ? null : el("span", { class: `exit ${c.exitStatus === 0 ? "ok" : "bad"}`, text: String(c.exitStatus) }))));
    if (!commands.length) historyList.append(el("div", { class: "muted", style: { padding: "8px 12px" }, text: "No commands yet." }));
  }

  async function closeSession() {
    if (info.state !== "exited" && !confirm("End this shell? Running programs will be stopped.")) return;
    try {
      if (info.state !== "exited") await call("terminal.close", { id: info.id });
      await bridge.browser("closeTerminalTab", {});
    } catch (error) { showNotice(error, "Could not close terminal"); }
  }

  const buffered = [];
  async function resync() {
    if (resyncing) return;
    resyncing = true;
    try {
      const snapshot = await call("terminal.attach", { id: info.id });
      term.reset();
      term.write(b64.bytes(snapshot.scrollback));
      offset = snapshot.offset;
      connectionError = undefined;
      paintStatus();
    } catch (error) {
      buffered.length = 0;
      connectionError = error;
      paintStatus();
    } finally {
      resyncing = false;
    }
    buffered.splice(0).forEach(receive);
  }

  function receive(message) {
    const data = message.data;
    if (data?.id !== info.id) return;
    if (message.event === "terminal.output") {
      if (resyncing || data.offset > offset) {
        buffered.push(message);
        resync();
        return;
      }
      const bytes = b64.bytes(data.data);
      const shift = Math.max(0, offset - data.offset);
      if (shift < bytes.length) {
        term.write(bytes.subarray(shift));
        offset = data.offset + bytes.length;
      }
    } else if (message.event === "terminal.state") {
      stateRevision++;
      connectionError = undefined;
      const changed = info.state !== data.state;
      update(data);
      if (changed && data.state === "idle") refreshTree();
    } else if (message.event === "terminal.command") {
      refreshTree();
    }
  }
  const unsubscribe = onEvent(receive);
  window.addEventListener("pagehide", unsubscribe, { once: true });
  pending.forEach(receive);
}
