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
//
// `execution` names a run that already happened (Search ran it). The page
// shows that stored result; opening, refreshing or restoring the tab never
// runs the command again. A run started here records its execution in the
// URL for the same reason. Run Again is the only way to repeat it.

export async function renderRun(app, id, initialInput, executionId = null) {
  const capability = (await capabilities()).find(c => c.id === id);
  if (!capability) {
    setPage("Unknown command", "warning");
    app.replaceChildren(bar("Unknown command"), page(empty("warning", `Lima has no command “${id}”.`)));
    return;
  }
  setPage(capability.title, capability.icon, hueFor(capability.category));
  const status = el("div", { class: "run-status", role: "status" });
  const output = el("div", { style: { marginTop: "12px" } });
  const actions = el("div", { class: "row run-actions", hidden: true });
  const field = capability.input ? el("input", { type: "text", placeholder: capability.input.placeholder, value: initialInput ?? "", "aria-label": capability.input.placeholder,
    style: { flex: 1, minWidth: "240px", fontSize: "15px", padding: "10px 12px" } }) : null;
  const runButton = el("button", { class: "primary", onclick: () => run() }, "Run");
  app.replaceChildren(
    bar(capability.title),
    page(el("p", { class: "muted", style: { margin: "0 0 12px" }, text: capability.summary }),
      field ? el("div", { class: "row" }, field, runButton) : null,
      status, output, actions));

  let running = false;
  const details = () => el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=activity&tab=commands") }, "View Details");
  const again = () => el("button", { class: "ghost", onclick: () => run() }, "Run Again");

  function setStatus(text, tone = "") {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function show(result) {
    setStatus("Command completed", "ok");
    output.replaceChildren(resultView(result));
    const copyable = result?.type === "text" ? result.text : result?.type === "markdown" ? result.markdown
      : result?.type === "list" ? result.items.map(item => `${item.title}\t${item.subtitle}`).join("\n") : null;
    actions.replaceChildren(again(),
      copyable ? el("button", { class: "ghost", onclick: () => { bridge.copy(copyable); toast("Copied"); } }, icon("copy"), "Copy Result") : null,
      details());
    actions.hidden = false;
  }

  function showFailure(message) {
    setStatus("Command failed", "bad");
    output.replaceChildren(el("div", { class: "notice bad" }, icon("warning"),
      el("span", {}, el("strong", { text: "Couldn't complete this action. " }), message)));
    actions.replaceChildren(el("button", { class: "primary", onclick: () => run() }, "Retry"), details());
    actions.hidden = false;
  }

  /** Records which execution this tab shows, without a new history entry.
   * about: pages may only change the fragment, so it goes there; a reload
   * or a restored session then displays it instead of running again. */
  function remember(execution, input) {
    const fragment = new URLSearchParams({ execution, ...(input ? { input } : {}) });
    try { history.replaceState(null, "", `#${fragment}`); }
    catch { try { location.hash = fragment.toString(); } catch {} }
  }

  async function run() {
    if (running) return;
    const input = field?.value ?? "";
    if (capability.input?.required && !input.trim()) { field?.focus(); return; }
    running = true;
    runButton.disabled = true;
    actions.hidden = true;
    setStatus("Running command…", "busy");
    output.replaceChildren(skeleton(2));
    const execution = crypto.randomUUID();
    remember(execution, input);
    try {
      const result = await runCapability(capability.id, input, { inPlace: true, executionId: execution });
      if (result) show(result);
    } catch (error) {
      showFailure(errorText(error));
    } finally {
      running = false;
      runButton.disabled = false;
    }
  }

  async function display(execution) {
    setStatus("Running command…", "busy");
    output.replaceChildren(skeleton(2));
    const stored = await call("capabilities.execution", { executionId: execution }).catch(() => null);
    if (stored?.status === "completed") {
      if (stored.result?.type === "open") { bridge.replaceURL(stored.result.url); return; }
      show(stored.result);
    } else if (stored?.status === "failed") {
      showFailure(stored.error ?? "The command failed.");
    } else {
      // Lima restarted or the result aged out. Don't recreate it silently.
      setStatus("");
      output.replaceChildren(empty("activity", "This result is no longer available. Run the command again to get a new result."));
      actions.replaceChildren(again(), details());
      actions.hidden = false;
    }
  }

  field?.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
  field?.focus();
  const fragment = new URLSearchParams(location.hash.slice(1));
  executionId ??= fragment.get("execution");
  if (field && fragment.has("input") && !initialInput) field.value = fragment.get("input");
  if (executionId) await display(executionId);
  else if (!field || initialInput || !capability.input.required) await run();
}
