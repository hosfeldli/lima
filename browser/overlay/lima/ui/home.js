/* Activity timeline and the universal Run page — projections of the
 * capability manifest. */
import { bar, bridge, call, el, errorText, icon, onEvent, relativeTime, setPage } from "./lib.js";
import { renderContext } from "./views.js";
import { capabilities, empty, hueFor, onCapabilityRun, openPalette, resultView, runCapability, skeleton, tile, toast } from "./components.js";

const page = (...children) => el("div", { class: "page narrow" }, ...children);
const card = (title, ...children) => el("section", { class: "card" }, title ? el("h2", {}, ...[].concat(title)) : null, ...children);

// MARK: Activity timeline (every capability run, every surface)

export async function renderActivity(app, tab = "commands", reportId = null) {
  setPage("Activity", "activity", 150);
  const list = el("div", { class: "timeline" });
  const listTab = el("span", { class: "tab" }, "Commands");
  const listModule = el("section", { class: "mod" }, el("div", { class: "mod-head" }, listTab), list);
  const body = el("div");
  const filter = el("select", { "aria-label": "Origin" }, ["all", "browser", "mcp", "chat", "automation"].map(o => el("option", { value: o, text: o === "all" ? "All surfaces" : o })));
  const tabs = el("div", { class: "segmented", role: "tablist" });
  const show = name => {
    tab = name;
    for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.tab === name));
    filter.hidden = name !== "commands";
    if (name === "commands") body.replaceChildren(listModule);
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
    return el("div", { class: `event${run.ok === false ? " failed" : ""}` },
      el("span", { class: "ico" }, icon(run.icon)),
      el("span", { class: "grow" }, el("strong", { text: run.title }), run.input ? el("span", { class: "muted", text: ` ${run.input}` }) : null,
        run.error ? el("div", { class: "error", text: run.error }) : null),
      el("span", { class: run.origin === "browser" ? "badge" : "badge ink", text: run.origin }),
      el("span", { class: "num", text: run.durationMs !== undefined ? `${Math.round(run.durationMs)} ms` : "…" }),
      el("span", { class: "num", text: relativeTime(run.startedAt) }));
  }

  function draw() {
    const shown = runs.filter(r => filter.value === "all" || r.origin === filter.value);
    listTab.replaceChildren("Commands", shown.length ? el("span", { class: "count", text: String(shown.length) }) : "");
    list.replaceChildren(...(shown.length ? shown.map(eventNode) : [empty("activity", "No commands have run yet. Run one from ⌘T.")]));
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
