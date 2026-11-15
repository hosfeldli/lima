/* Home dashboard, Activity timeline and the universal Run page — all
 * projections of the capability manifest. */
import { bar, bridge, call, CATEGORY_HUES, el, errorText, icon, markdown, onEvent, relativeTime, setPage } from "./lib.js";
import { capabilities, empty, hueFor, onCapabilityRun, openPalette, resultView, runCapability, skeleton, tile, toast } from "./components.js";

const page = (...children) => el("div", { class: "page narrow" }, ...children);
const card = (title, ...children) => el("section", { class: "card" }, title ? el("h2", {}, ...[].concat(title)) : null, ...children);

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

// MARK: Home

export async function renderHome(app) {
  setPage("Lima", "home", 225);
  const stats = el("div", { class: "stats" }, skeleton(2));
  const chart = el("div");
  const nowPlaying = el("div", {}, skeleton(2));
  const recentNotes = el("div", {}, skeleton(3));
  const live = el("div", {}, skeleton(2));
  const actions = el("div", { class: "grid tiles" });

  app.replaceChildren(
    bar("Home", el("button", { class: "ghost", onclick: () => openPalette() }, icon("search"), "Search & commands", el("kbd", { text: "⌘K" }))),
    page(
      el("section", { class: "hero" },
        el("h2", {}, `${greeting()}. `, el("span", { class: "prism-text", text: "What's next?" })),
        el("p", { text: "Everything Lima can do lives in one place — open it from here, the rail, the address bar, or ⌘K." })),
      el("div", { class: "grid", style: { gridTemplateColumns: "2fr 1fr" } },
        card(["This week"], stats, el("div", { style: { marginTop: "16px" } }, chart)),
        card(["Now playing"], nowPlaying)),
      el("div", { class: "section-title" }, icon("bolt"), "Quick actions"),
      actions,
      el("div", { class: "grid", style: { marginTop: "16px" } },
        card(["Recent notes"], recentNotes),
        card(["Live sessions"], live)))
  );

  const all = await capabilities();
  actions.replaceChildren(...all.filter(c => c.surfaces.home).map(c => tile(c, cap => activate(cap))));

  async function activate(capability) {
    try {
      if (capability.input?.required) { bridge.openTab(`about:lima?run=${encodeURIComponent(capability.id)}`); return; }
      const result = await runCapability(capability.id, "");
      if (result) bridge.openTab(`about:lima?run=${encodeURIComponent(capability.id)}`);
    } catch (error) {
      toast(errorText(error), "bad");
    }
  }

  // Stats + 7-day activity bars
  try {
    const [notes, chats, events, terminals] = await Promise.all([call("notes.list"), call("chat.list"), call("context.recent", { limit: 2000 }), call("terminal.list")]);
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = events.filter(e => e.timestamp >= weekAgo);
    const stat = (value, label) => el("div", { class: "stat" }, el("b", { text: String(value) }), el("span", { text: label }));
    stats.replaceChildren(
      stat(notes.filter(n => !n.trashed).length, "notes"),
      stat(chats.length, "conversations"),
      stat(thisWeek.length, "events this week"),
      stat(terminals.filter(t => t.state !== "exited").length, "live terminals"));
    const days = Array.from({ length: 7 }, (_, i) => {
      const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (6 - i));
      return { label: start.toLocaleDateString(undefined, { weekday: "narrow" }), from: start.getTime(), to: start.getTime() + 86400000 };
    });
    const counts = days.map(d => thisWeek.filter(e => e.timestamp >= d.from && e.timestamp < d.to).length);
    const max = Math.max(1, ...counts);
    chart.replaceChildren(
      el("div", { class: "bars", role: "img", "aria-label": `Activity per day: ${counts.join(", ")}` },
        counts.map((count, i) => el("i", { title: `${count} events`, style: { height: `${Math.max(4, (count / max) * 100)}%`, backgroundPosition: `${i * 15}% 0` } }))),
      el("div", { class: "row", style: { justifyContent: "space-between", fontSize: "11px", color: "var(--muted)", marginTop: "4px" } }, days.map(d => el("span", { text: d.label }))));
    const recent = notes.filter(n => !n.trashed).slice(0, 6);
    recentNotes.replaceChildren(recent.length ? el("ul", { class: "list" }, recent.map(n => el("li", {
      class: "clickable", onclick: () => bridge.openTab(`about:lima?note=${encodeURIComponent(n.id)}`) },
      icon(n.kind === "canvas" ? "canvas" : "note"), el("span", { class: "grow", text: n.title }), el("span", { class: "muted", text: relativeTime(n.modifiedAt) }))))
      : empty("note", "No notes yet"));
    const running = chats.filter(c => c.running);
    const liveTerminals = terminals.filter(t => t.state !== "exited");
    live.replaceChildren(liveTerminals.length || running.length ? el("ul", { class: "list" },
      liveTerminals.map(t => el("li", { class: "clickable", onclick: () => bridge.openTab(`about:lima?terminal=${encodeURIComponent(t.id)}`) },
        el("span", { class: "dot live", style: { color: t.state === "running" ? "var(--warn)" : "var(--ok)" } }), icon("terminal"),
        el("code", { class: "grow", text: t.cwd.replace(/^\/Users\/[^/]+/, "~") }), el("span", { class: "badge", text: t.state }))),
      running.map(c => el("li", { class: "clickable", onclick: () => bridge.openTab(`about:lima?chat=${encodeURIComponent(c.id)}`) },
        el("span", { class: "dot live", style: { color: "var(--accent)" } }), icon("chat"), el("span", { class: "grow", text: c.title }), el("span", { class: "badge", text: "replying" }))))
      : empty("terminal", "Nothing running"));
  } catch (error) {
    stats.replaceChildren(el("p", { class: "error", text: errorText(error) }));
  }

  const drawNowPlaying = item => nowPlaying.replaceChildren(item?.title
    ? el("div", {},
        el("div", { style: { font: "650 18px/1.25 var(--font-display)" }, text: item.title }),
        el("div", { class: "muted", text: `${item.artist} · ${item.player}` }),
        el("div", { class: "row", style: { marginTop: "12px" } },
          ...[["media.previous", "previous"], ["media.playpause", "play"], ["media.next", "next"]].map(([id, glyph]) =>
            el("button", { class: "icon-only", "aria-label": id, onclick: () => runCapability(id).catch(e => toast(errorText(e), "bad")) }, icon(glyph)))))
    : empty("audio", "Nothing playing", el("button", { onclick: () => runCapability("media.dj").catch(() => {}) }, icon("spark"), "Spotify DJ")));
  call("media.nowPlaying").then(drawNowPlaying).catch(() => drawNowPlaying(null));
  onEvent(m => { if (m.event === "media.nowPlaying") drawNowPlaying(m.data); });
}

// MARK: Activity timeline (every capability run, every surface)

export async function renderActivity(app) {
  setPage("Activity", "activity", 150);
  const list = el("div", { class: "timeline" });
  const filter = el("select", { "aria-label": "Origin" }, ["all", "browser", "mcp", "chat", "automation"].map(o => el("option", { value: o, text: o === "all" ? "All surfaces" : o })));
  app.replaceChildren(bar("Activity", filter, el("button", { onclick: () => bridge.openTab("about:lima?view=context") }, icon("context"), "Context Shelf")),
    page(el("p", { class: "muted", text: "Every command Lima ran — from the rail, address bar, ⌘K, Home, chat agents and MCP clients — through one authorization point." }), list));

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
  onCapabilityRun(run => { runs = [run, ...runs].slice(0, 300); draw(); });
  draw();
}

// MARK: Run — the one page that executes any capability

export async function renderRun(app, id, initialInput) {
  const capability = (await capabilities()).find(c => c.id === id);
  if (!capability) {
    setPage("Unknown command", "warning");
    app.replaceChildren(bar("Unknown command"), page(empty("warning", `Lima has no command “${id}”.`)));
    return;
  }
  setPage(capability.title, capability.icon, hueFor(capability.category));
  const output = el("div");
  const field = capability.input ? el("input", { type: "text", placeholder: capability.input.placeholder, value: initialInput ?? "", style: { flex: 1, minWidth: "240px", fontSize: "15px", padding: "10px 12px" } }) : null;
  const runButton = el("button", { class: "primary", onclick: run }, icon("bolt"), "Run");

  app.replaceChildren(
    bar(capability.title, el("span", { class: "badge", text: capability.category })),
    page(
      el("section", { class: "hero", style: { paddingTop: "24px" } },
        el("div", { class: "row" }, el("span", { class: "tile", "data-category": capability.category, style: { minHeight: 0, padding: "10px", pointerEvents: "none" } },
          el("span", { class: "chip" }, icon(capability.icon))),
          el("div", {}, el("h2", { text: capability.title, style: { fontSize: "28px", margin: 0 } }), el("p", { text: capability.summary })))),
      field ? el("div", { class: "row", style: { marginBottom: "16px" } }, field, runButton) : null,
      card(null, output)));

  async function run() {
    output.replaceChildren(skeleton(3));
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
    if (initialInput || !capability.input.required) run();
    else output.replaceChildren(el("p", { class: "muted", text: `Enter ${capability.input.placeholder.toLowerCase()} and press Return.` }));
  } else {
    run();
  }
  void CATEGORY_HUES; void markdown;
}
