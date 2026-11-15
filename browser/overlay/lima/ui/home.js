/* Home dashboard, Activity timeline and the universal Run page — all
 * projections of the capability manifest. */
import { bar, bridge, call, el, errorText, icon, onEvent, relativeTime, setPage } from "./lib.js";
import { renderContext } from "./views.js";
import { capabilities, empty, hueFor, onCapabilityRun, openPalette, resultView, runCapability, skeleton, tile, toast } from "./components.js";

const page = (...children) => el("div", { class: "page narrow" }, ...children);
const card = (title, ...children) => el("section", { class: "card" }, title ? el("h2", {}, ...[].concat(title)) : null, ...children);

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// MARK: Home — search, continue, act. Nothing decorative.

export async function renderHome(app) {
  setPage("Lima", "home", 225);
  const playing = el("span");
  const recents = el("div", { class: "continue" }, skeleton(2));
  const actions = el("div", { class: "actions" });
  app.replaceChildren(
    bar("Home", playing),
    page(
      el("h2", { style: { font: "700 24px/1.2 var(--font-display)", margin: "8px 0 0", letterSpacing: "-.015em" }, text: `${greeting()}.` }),
      el("button", { class: "home-search", onclick: () => openPalette() }, icon("search"), "Search notes, chats, workspaces — or run a command", el("kbd", { text: "⌘K" })),
      el("div", { class: "section-title" }, "Continue"), recents,
      el("div", { class: "section-title" }, "New"), actions));

  // Typing anywhere on Home starts a search.
  document.addEventListener("keydown", event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1 || /input|textarea/i.test(document.activeElement?.tagName ?? "")) return;
    event.preventDefault();
    openPalette(event.key);
  });

  const all = await capabilities();
  actions.replaceChildren(...all.filter(c => c.surfaces.home).map(c => tile(c, cap => activate(cap))));

  async function activate(capability) {
    try {
      if (capability.input?.required) { openPalette(capability.title); return; }
      const result = await runCapability(capability.id, "");
      if (result) bridge.openTab(`about:lima?run=${encodeURIComponent(capability.id)}`);
    } catch (error) {
      toast(errorText(error), "bad");
    }
  }

  try {
    const [workspaces, notes, chats, terminals] = await Promise.all([
      call("workspace.list"), call("notes.list"), call("chat.list"), call("terminal.list")]);
    const inWorkspace = new Set(workspaces.flatMap(w => [w.conversationID, w.terminalID]));
    const items = [
      ...workspaces.map(w => ({ icon: "workspace", label: `✦ ${w.name}`, when: w.createdAt, url: `about:lima?workspace=${w.id}` })),
      ...notes.filter(n => !n.trashed).map(n => ({ icon: n.kind === "canvas" ? "canvas" : "note", label: n.title, when: n.modifiedAt, url: `about:lima?note=${n.id}` })),
      ...chats.filter(c => !inWorkspace.has(c.id)).map(c => ({ icon: "chat", label: c.title, when: c.updatedAt, url: `about:lima?chat=${c.id}`, live: c.running })),
      ...terminals.filter(t => t.state !== "exited" && !inWorkspace.has(t.id)).map(t => ({ icon: "terminal", label: t.cwd.replace(/^\/Users\/[^/]+/, "~"), when: Date.now(), url: `about:lima?terminal=${t.id}`, live: t.state === "running" })),
    ].sort((a, b) => b.when - a.when).slice(0, 9);
    recents.replaceChildren(...(items.length ? items.map(item => el("button", { onclick: () => bridge.openTab(item.url) },
      item.live ? el("span", { class: "dot live", style: { color: "var(--warn)" } }) : icon(item.icon),
      el("span", { class: "label", text: item.label }), el("span", { class: "when", text: relativeTime(item.when) })))
      : [el("p", { class: "muted", text: "Nothing yet — start with a workspace or a note below." })]));
  } catch (error) {
    recents.replaceChildren(el("p", { class: "error", text: errorText(error) }));
  }

  const drawPlaying = item => playing.replaceChildren(item?.title && item.state === "Playing"
    ? el("button", { class: "ghost", title: "Play / pause", onclick: () => runCapability("media.playpause").catch(e => toast(errorText(e), "bad")) },
        icon("audio"), el("span", { text: `${item.title} — ${item.artist}`, style: { maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }))
    : "");
  call("media.nowPlaying").then(drawPlaying).catch(() => {});
  onEvent(m => { if (m.event === "media.nowPlaying") drawPlaying(m.data); });
}

// MARK: Activity timeline (every capability run, every surface)

export async function renderActivity(app, tab = "commands", reportId = null) {
  setPage("Activity", "activity", 150);
  const list = el("div", { class: "timeline" });
  const body = el("div");
  const filter = el("select", { "aria-label": "Origin" }, ["all", "browser", "mcp", "chat", "automation"].map(o => el("option", { value: o, text: o === "all" ? "All surfaces" : o })));
  const tabs = el("div", { class: "segmented", role: "tablist" });
  const show = name => {
    tab = name;
    for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.tab === name));
    filter.hidden = name !== "commands";
    if (name === "commands") body.replaceChildren(list);
    else renderContext(body, name === "reports" ? reportId : null, { embedded: true, section: name });
  };
  for (const [name, label] of [["commands", "Commands"], ["activity", "Activity"], ["reports", "Reports"]]) {
    tabs.append(el("button", { "data-tab": name, onclick: () => show(name) }, label));
  }
  app.replaceChildren(bar("Activity", filter, tabs), page(body));

  const defs = new Map((await capabilities()).map(c => [c.id, c]));
  let runs = await call("capabilities.runs", { limit: 150 }).catch(() => []);

  function eventNode(run) {
    const def = defs.get(run.capability);
    return el("div", { class: `event${run.ok === false ? " failed" : ""}`, style: { "--hue": hueFor(def?.category) } },
      el("span", { class: "chip", style: { width: "28px", height: "28px", borderRadius: "9px", display: "grid", placeItems: "center", color: "white", flex: "none",
        background: `linear-gradient(135deg, hsl(${hueFor(def?.category)} 82% 62%), hsl(${hueFor(def?.category) + 38} 82% 56%))` } }, icon(run.icon)),
      el("span", { class: "grow" }, el("strong", { text: run.title }), run.input ? el("span", { class: "muted", text: ` · ${run.input}` }) : null,
        run.error ? el("div", { class: "error", style: { fontSize: "12px" }, text: run.error }) : null),
      el("span", { class: "badge", text: run.origin }),
      el("span", { class: "muted", style: { fontSize: "12px", minWidth: "54px", textAlign: "right" }, text: run.durationMs !== undefined ? `${Math.round(run.durationMs)} ms` : "…" }),
      el("span", { class: "muted", style: { fontSize: "12px", minWidth: "64px", textAlign: "right" }, text: relativeTime(run.startedAt) }));
  }

  function draw() {
    const shown = runs.filter(r => filter.value === "all" || r.origin === filter.value);
    list.replaceChildren(...(shown.length ? shown.map(eventNode) : [empty("activity", "No commands have run yet. Try ⌘K.")]));
  }
  filter.addEventListener("change", draw);
  onCapabilityRun(run => { runs = [run, ...runs].slice(0, 300); if (tab === "commands") draw(); });
  draw();
  show(tab);
}

// MARK: Run — one input, one result

export async function renderRun(app, id, initialInput) {
  const capability = (await capabilities()).find(c => c.id === id);
  if (!capability) {
    setPage("Unknown command", "warning");
    app.replaceChildren(bar("Unknown command"), page(empty("warning", `Lima has no command “${id}”.`)));
    return;
  }
  setPage(capability.title, capability.icon, hueFor(capability.category));
  const output = el("div", { style: { marginTop: "16px" } });
  const field = capability.input ? el("input", { type: "text", placeholder: capability.input.placeholder, value: initialInput ?? "", style: { flex: 1, minWidth: "240px", fontSize: "15px", padding: "10px 12px" } }) : null;
  app.replaceChildren(
    bar(capability.title),
    page(el("p", { class: "muted", style: { margin: "0 0 12px" }, text: capability.summary }),
      field ? el("div", { class: "row" }, field, el("button", { class: "primary", onclick: run }, "Run")) : null,
      output));

  async function run() {
    output.replaceChildren(skeleton(2));
    try {
      const result = await runCapability(capability.id, field?.value ?? "", { inPlace: true });
      if (result) output.replaceChildren(resultView(result));
    } catch (error) {
      output.replaceChildren(el("div", { class: "notice bad" }, icon("warning"), errorText(error)));
    }
  }
  if (field) {
    field.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
    field.focus();
    if (initialInput || !capability.input.required) run(); else output.replaceChildren();
  } else {
    run();
  }
}
