import { bridge, call, el, errorText, icon, onEvent, prefs, setPage } from "./lib.js";
import { renderTerminal } from "./terminal.js";

export function renderQuickTerminal(app, preferredWorkspace) {
  setPage("Quick Terminal", "terminal");
  let tabs;
  try { tabs = JSON.parse(prefs.get("quickTerminal.tabs", "[]")); } catch { tabs = []; }
  if (!Array.isArray(tabs)) tabs = [];
  tabs = tabs.filter(id => typeof id === "string");
  let owned;
  try { owned = new Set(JSON.parse(prefs.get("quickTerminal.owned", "[]"))); } catch { owned = new Set(); }
  let selected = prefs.get("quickTerminal.selected", "");
  let sessions = new Map();
  let workspaces = new Map();
  let mounted;
  let shown = true;
  let version = 0;
  let initialized = false;
  const strip = el("div", { class: "quick-shell-tabs", role: "tablist", "aria-label": "Shell sessions" });
  const status = el("span", { class: "quick-shell-status", role: "status" });
  const body = el("div", { class: "quick-shell-content", role: "tabpanel", id: "quick-shell-content" });
  const picker = el("select", { "aria-label": "Resume an existing shell",
    onchange: () => { if (picker.value) activate(picker.value); } });
  const add = el("button", { class: "ghost icon-only", title: "New shell", "aria-label": "New shell", onclick: create }, icon("plus"));
  const close = el("button", { class: "ghost icon-only", title: "Hide Quick Terminal", "aria-label": "Hide Quick Terminal",
    onclick: () => bridge.browser("closeQuickTerminal", {}) }, icon("close"));
  app.replaceChildren(el("div", { class: "quick-shell" },
    el("header", { class: "quick-shell-head" }, strip, picker, add, close), status, body));

  function title(id) {
    const shell = sessions.get(id);
    const workspace = workspaces.get(id);
    if (workspace) return workspace.name;
    if (owned.has(id)) return `Shell ${[...owned].indexOf(id) + 1}`;
    return shell?.cwd?.split("/").filter(Boolean).pop() || "Shell";
  }

  function draw(focus = false) {
    prefs.set("quickTerminal.tabs", JSON.stringify(tabs));
    prefs.set("quickTerminal.selected", selected);
    prefs.set("quickTerminal.owned", JSON.stringify([...owned]));
    strip.replaceChildren(...tabs.map((id, index) => {
      const shared = workspaces.has(id) || !owned.has(id);
      const name = title(id);
      return el("div", { class: "quick-shell-tab", "data-selected": String(id === selected) },
        el("button", { id: `quick-shell-tab-${index}`, type: "button", role: "tab", "aria-controls": body.id,
          "aria-selected": String(id === selected), tabindex: id === selected ? 0 : -1, title: name,
          onclick: () => activate(id), onkeydown: event => {
            const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
            if (!direction) return;
            event.preventDefault();
            const next = (index + direction + tabs.length) % tabs.length;
            activate(tabs[next], true);
          } }, el("span", { text: name })),
        el("button", { class: "ghost icon-only", title: shared ? "Detach shared shell" : "End shell",
          "aria-label": `${shared ? "Detach" : "Close"} ${name}`, onclick: () => closeTab(id) }, icon("close")));
    }));
    if (focus) strip.querySelector('[aria-selected="true"]')?.focus();
    const available = [...sessions.values()].filter(shell => shell.state !== "exited" && !tabs.includes(shell.id));
    picker.replaceChildren(el("option", { value: "", text: "Resume" }), ...available.map(shell => el("option", { value: shell.id, text: title(shell.id) })));
    picker.disabled = !available.length;
    const selectedIndex = tabs.indexOf(selected);
    if (selectedIndex >= 0) body.setAttribute("aria-labelledby", `quick-shell-tab-${selectedIndex}`);
    else body.removeAttribute("aria-labelledby");
    if (!shown || mounted?.id === selected) return;
    mounted?.controller.abort();
    mounted = null;
    if (!selected) {
      body.replaceChildren(el("p", { class: "quick-shell-empty muted", text: "Start a shell with + or resume one already running in Lima." }));
      return;
    }
    const controller = new AbortController();
    mounted = { id: selected, controller };
    renderTerminal(body, selected, { compact: true, signal: controller.signal, workspaceId: workspaces.get(selected)?.id, focus: !focus });
  }

  function activate(id, focus = false) {
    if (!tabs.includes(id)) tabs.push(id);
    selected = id;
    draw(focus);
  }

  async function refresh() {
    const ticket = ++version;
    try {
      const [shells, projects] = await Promise.all([call("terminal.list"), call("workspace.list")]);
      if (ticket !== version || !shown) return;
      sessions = new Map(shells.map(shell => [shell.id, shell]));
      workspaces = new Map(projects.filter(project => project.terminalID).map(project => [project.terminalID, project]));
      tabs = tabs.filter(id => sessions.has(id));
      owned = new Set([...owned].filter(id => sessions.has(id)));
      const preferred = projects.find(project => project.id === preferredWorkspace)?.terminalID;
      if (!initialized && !tabs.length && sessions.get(preferred)?.state !== "exited" && sessions.has(preferred)) tabs.push(preferred);
      initialized = true;
      if (!tabs.includes(selected)) selected = tabs[0] ?? "";
      status.textContent = "";
      draw();
    } catch (error) { if (ticket === version) status.textContent = errorText(error); }
  }

  async function create() {
    add.disabled = true;
    status.textContent = "Starting shell…";
    try {
      const shell = await call("terminal.create", { cols: 100, rows: 24 });
      sessions.set(shell.id, shell);
      owned.add(shell.id);
      activate(shell.id);
      status.textContent = "";
    } catch (error) { status.textContent = errorText(error); }
    finally { add.disabled = false; }
  }

  const closing = new Set();
  async function closeTab(id) {
    if (closing.has(id)) return;
    closing.add(id);
    try {
      if (owned.has(id) && !workspaces.has(id) && sessions.get(id)?.state !== "exited") {
        if (!confirm("End this shell? Any programs running in it will stop.")) return;
        await call("terminal.close", { id });
        sessions.delete(id);
      }
      owned.delete(id);
      const index = tabs.indexOf(id);
      tabs = tabs.filter(item => item !== id);
      if (selected === id) selected = tabs[Math.min(index, tabs.length - 1)] ?? "";
      draw();
    } catch (error) { status.textContent = errorText(error); }
    finally { closing.delete(id); }
  }

  const stop = onEvent(message => {
    if (message.event === "ui.quickTerminalVisible") {
      shown = message.data === true;
      if (shown) refresh();
      else { mounted?.controller.abort(); mounted = null; body.replaceChildren(); }
    } else if (shown && message.event === "terminal.state") {
      const shell = message.data;
      if (!sessions.has(shell.id) || shell.state === "exited") refresh();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && !event.target.closest(".xterm")) bridge.browser("closeQuickTerminal", {});
  });
  window.addEventListener("pagehide", () => { stop(); mounted?.controller.abort(); }, { once: true });
  refresh();
}
