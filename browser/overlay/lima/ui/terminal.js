/* A terminal tab. The URL carries the session ID, so closing and restoring
 * the tab (or restarting the browser) reattaches to the same shell, which
 * keeps running in the Lima runtime. */
import { b64, bar, bridge, call, el, errorText, onEvent, setPage } from "./lib.js";

export async function renderTerminal(app, sessionId) {
  let info;
  try {
    if (!sessionId) {
      // Give the tab a permanent URL for this session so restore and
      // bookmarks reattach to the same shell. (about: pages can't use
      // history.replaceState.)
      info = await call("terminal.create", { cols: 100, rows: 30 });
      bridge.replaceURL(`about:lima?terminal=${encodeURIComponent(info.id)}`);
      return;
    }
    const attached = await call("terminal.attach", { id: sessionId ?? info.id });
    info = attached.info;
    mountTerminal(app, info, attached.scrollback);
  } catch (error) {
    setPage("Terminal ended", "terminal");
    app.replaceChildren(
      bar("Terminal"),
      el("div", { class: "page narrow" },
        el("p", { class: "muted", text: `This terminal session is no longer running (${errorText(error)}).` }),
        el("button", { class: "primary", onclick: () => bridge.replaceURL("about:lima?view=terminal") }, "Start a new terminal"))
    );
  }
}

function mountTerminal(app, info, scrollback) {
  const stateBadge = el("span", { class: "badge" });
  const ownerBadge = el("span", { class: "badge" });
  const leaseBar = el("div", { class: "lease", hidden: true });
  const host = el("div", { class: "terminal-host" });
  const historyList = el("ul", { class: "list", style: { maxHeight: "240px", overflow: "auto" } });
  const historyPanel = el("div", { class: "card", hidden: true, style: { margin: "8px 16px" } }, el("h2", { text: "Command history" }), historyList);

  app.replaceChildren(
    bar("Terminal", stateBadge, ownerBadge,
      el("button", { class: "ghost", onclick: toggleHistory }, "History"),
      el("button", { onclick: () => bridge.openTab("about:lima?view=terminal") }, "New Terminal"),
      el("button", { class: "ghost danger", onclick: closeSession }, "End Session")),
    leaseBar, historyPanel, host
  );

  const term = new window.Terminal({
    cursorBlink: true, fontFamily: "SF Mono, Menlo, monospace", fontSize: 13, scrollback: 10000, allowProposedApi: false,
    theme: { background: "#111317", foreground: "#e8e9ee", cursor: "#7aa2ff", selectionBackground: "#3a4a7a" },
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

  function update(next) {
    info = next;
    const label = { idle: "idle", running: "running", waitingForInput: "waiting for input", exited: `exited ${info.exitCode ?? ""}`, uncertain: "state unknown", disconnected: "disconnected" }[info.state] ?? info.state;
    stateBadge.textContent = label;
    stateBadge.className = `badge ${info.state === "exited" ? "bad" : info.state === "running" ? "warn" : "ok"}`;
    const agent = info.owner.startsWith("agent:") ? info.owner.slice(6) : null;
    ownerBadge.textContent = agent ? `⌨ ${agent} has control` : "⌨ you";
    ownerBadge.className = `badge ${agent ? "warn" : ""}`;
    setPage(`${info.state === "running" ? "▶ " : ""}${info.title} — ${info.cwd.replace(/^\/Users\/[^/]+/, "~")}`, "terminal");

    leaseBar.replaceChildren();
    if (agent) {
      leaseBar.hidden = false;
      leaseBar.append(el("span", { class: "grow", text: `${agent} is typing in this terminal. Typing anything takes control back immediately.` }),
        el("button", { onclick: () => call("terminal.lease.reclaim", { id: info.id }) }, "Take back control"));
    } else if (info.pendingRequests.length) {
      const requester = info.pendingRequests[0];
      leaseBar.hidden = false;
      leaseBar.append(el("span", { class: "grow", text: `${requester} is asking to type in this terminal.` }),
        el("button", { class: "primary", onclick: () => call("terminal.lease.grant", { id: info.id, agentId: requester }) }, "Allow"),
        el("button", { onclick: () => call("terminal.lease.deny", { id: info.id, agentId: requester }) }, "Deny"));
    } else {
      leaseBar.hidden = true;
    }
  }
  update(info);

  async function toggleHistory() {
    historyPanel.hidden = !historyPanel.hidden;
    if (historyPanel.hidden) return;
    const commands = await call("terminal.history", { id: info.id });
    historyList.replaceChildren(...commands.slice().reverse().map(c => el("li", { class: "clickable", title: "Insert into terminal",
      onclick: () => call("terminal.write", { id: info.id, data: b64.encode(c.command) }) },
      el("code", { class: "grow", text: c.command }),
      c.exitStatus === null || c.exitStatus === undefined ? null : el("span", { class: `badge ${c.exitStatus === 0 ? "ok" : "bad"}`, text: String(c.exitStatus) }))));
    if (!commands.length) historyList.append(el("li", { class: "muted", text: "No commands yet (history needs zsh)." }));
  }

  async function closeSession() {
    if (info.state !== "exited" && !confirm("End this shell session? Running programs will be stopped.")) return;
    await call("terminal.close", { id: info.id }).catch(() => {});
    window.close();
  }

  onEvent(message => {
    if (message.event === "terminal.output" && message.data.id === info.id) term.write(b64.bytes(message.data.data));
    else if (message.event === "terminal.state" && message.data.id === info.id) update(message.data);
  });
}
