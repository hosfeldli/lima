/* Prism components shared by every Lima surface. */
import { bridge, call, CATEGORY_HUES, el, errorText, icon, markdown, onEvent } from "./lib.js";

let manifest = null;
/** The capability manifest — the single source for tiles, palette and tools. */
export function capabilities() {
  manifest ??= call("capabilities.list").catch(() => []);
  return manifest;
}

export function aurora() {
  return el("div", { class: "aurora", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
}

export function hueFor(category) {
  return CATEGORY_HUES[category] ?? 225;
}

export function tile(capability, onActivate) {
  return el("button", {
    class: "tile", "data-category": capability.category, title: capability.summary,
    onclick: () => onActivate(capability),
  }, el("span", { class: "chip" }, icon(capability.icon)), el("strong", { text: capability.title }), el("span", { text: capability.summary }));
}

export function empty(iconName, message, ...actions) {
  return el("div", { class: "empty" }, icon(iconName), el("p", { text: message }), actions.length ? el("div", { class: "row", style: { justifyContent: "center" } }, ...actions) : null);
}

export function skeleton(lines = 3) {
  return el("div", {}, Array.from({ length: lines }, (_, i) => el("div", { class: "skeleton", style: { width: `${90 - i * 15}%` } })));
}

let toastHost = null;
export function toast(message, tone = "ok", iconName = tone === "bad" ? "warning" : "check") {
  toastHost ??= document.body.appendChild(el("div", { class: "toasts", role: "status" }));
  const node = el("div", { class: `toast ${tone}` }, icon(iconName), el("span", { text: message }));
  toastHost.append(node);
  setTimeout(() => node.remove(), 3200);
}

/** Runs a capability through the single runtime entry point. `open` results
 * navigate (same tab or new tab); everything else is returned for display.
 * Each invocation has its own execution ID, so a repeated request returns
 * the stored result instead of running the command again. */
export async function runCapability(id, input = "", { inPlace = false, executionId = crypto.randomUUID() } = {}) {
  const result = await call("capabilities.run", { id, input, executionId });
  if (result?.type === "open") {
    if (inPlace) bridge.replaceURL(result.url);
    else bridge.openTab(result.url);
    return null;
  }
  return result;
}

/** Renders every capability result shape identically everywhere. */
export function resultView(result) {
  const root = el("div", { class: "result" });
  if (!result) return root;
  switch (result.type) {
    case "text":
      root.append(el("pre", { text: result.text }), el("div", { class: "row" },
        el("button", { class: "primary", onclick: () => { bridge.copy(result.text); toast("Copied"); } }, icon("copy"), "Copy")));
      break;
    case "list":
      root.append(result.items.length ? el("ul", { class: "list" }, result.items.map(item => el("li", {
        class: "clickable",
        onclick: () => { if (/^https?:/.test(item.value)) bridge.openTab(item.value); else { bridge.copy(item.value); toast(`Copied ${item.title}`); } },
      }, el("strong", { text: item.title, style: { minWidth: "48px" } }), el("span", { class: "grow muted", text: item.subtitle }),
        /^https?:/.test(item.value) ? icon("external") : icon("copy"))))
        : empty("search", "No results"));
      break;
    case "markdown":
      root.append(markdown(result.markdown));
      break;
    case "notice":
      root.append(el("div", { class: `notice ${result.tone ?? "ok"}` }, icon(result.tone === "bad" ? "warning" : "check"), result.message));
      break;
    case "image":
      root.append(el("img", { class: "capture", src: `data:image/png;base64,${result.png}`, alt: "Capture" }),
        el("div", { class: "row", style: { marginTop: "12px" } },
          el("button", { class: "primary", onclick: () => bridge.openTab("about:lima?view=studio") }, icon("studio"), "Open in Studio"),
          el("span", { class: "muted", text: `${result.width} × ${result.height}` })));
      break;
    case "devices": {
      const draw = items => root.replaceChildren(el("ul", { class: "list" }, items.map(d => el("li", {
        class: "clickable", "aria-selected": String(d.isDefault),
        onclick: async () => { draw(await call("audio.setOutput", { id: d.id })); toast(`Output: ${d.name}`); },
      }, el("span", { class: "dot", style: { color: d.isDefault ? "var(--ok)" : "var(--muted)" } }), el("span", { class: "grow", text: d.name }), el("span", { class: "badge", text: d.transport })))));
      draw(result.items);
      break;
    }
    default:
      root.append(el("pre", { text: JSON.stringify(result, null, 2) }));
  }
  return root;
}

// ── Command palette ──────────────────────────────────────────────────────
// ⌘K in any Lima tab: capabilities (the manifest), Lima content, and a
// Quick Ask row. Capabilities that need input take it inline.

let paletteOpen = false;

export function installPalette() {
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (!paletteOpen) openPalette();
    }
  });
}

export async function openPalette(initial = "") {
  paletteOpen = true;
  const previousFocus = document.activeElement;
  const input = el("input", { type: "text", placeholder: "Search Lima or run a command…", "aria-label": "Command", value: initial, autocomplete: "off" });
  const results = el("div", { class: "palette-results", role: "listbox" });
  const timing = el("span");
  const palette = el("div", { class: "palette", role: "dialog", "aria-label": "Command palette" },
    el("div", { class: "palette-input" }, icon("search"), input, el("kbd", { text: "esc" })),
    results,
    el("div", { class: "palette-foot" }, el("span", {}, el("kbd", { text: "↑↓" }), " navigate"), el("span", {}, el("kbd", { text: "↵" }), " run"),
      el("span", {}, el("kbd", { text: "⇥" }), " add input"), el("span", { style: { flex: 1 } }), timing));
  const scrim = el("div", { class: "palette-scrim", onclick: e => { if (e.target === scrim) close(); } }, palette);
  document.body.append(scrim);
  input.focus();

  let items = [];
  let selected = 0;
  let pending = null; // capability awaiting input
  const all = await capabilities();

  function close() {
    scrim.remove();
    paletteOpen = false;
    previousFocus?.focus?.();
  }

  function row(item, index) {
    const node = el("div", {
      class: "palette-item", role: "option", "aria-selected": String(index === selected), style: { "--hue": item.hue },
      onmousemove: () => { if (selected !== index) { selected = index; paint(); } },
      onclick: () => activate(item),
    }, el("span", { class: "chip" }, icon(item.icon)), el("span", { class: "text" }, el("b", { text: item.title }), el("span", { text: item.subtitle })), el("kbd", { text: "↵" }));
    return node;
  }

  function paint() {
    results.replaceChildren();
    let group = null;
    items.forEach((item, index) => {
      if (item.group !== group) { group = item.group; results.append(el("div", { class: "group", text: group })); }
      results.append(row(item, index));
    });
    if (!items.length) results.append(empty("search", "Nothing found"));
    results.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }

  async function refresh() {
    const text = input.value.trim();
    if (pending) {
      items = [{ group: pending.title, title: text ? `Run with “${text}”` : `Run ${pending.title}`, subtitle: pending.input?.placeholder ?? "", icon: pending.icon, hue: hueFor(pending.category), capability: pending, input: text }];
      selected = 0;
      paint();
      return;
    }
    const started = performance.now();
    const lower = text.toLowerCase();
    const matches = all
      .filter(c => c.surfaces.palette && (!lower || c.title.toLowerCase().includes(lower) || c.keywords.some(k => k.includes(lower)) || c.id.includes(lower)))
      .sort((a, b) => (a.title.toLowerCase().startsWith(lower) ? -1 : 0) - (b.title.toLowerCase().startsWith(lower) ? -1 : 0) || a.rank - b.rank)
      .slice(0, text ? 8 : 12)
      .map(c => ({ group: "Commands", title: c.title, subtitle: c.summary, icon: c.icon, hue: hueFor(c.category), capability: c }));
    let content = [];
    if (text.length >= 2) {
      try {
        const response = await call("search.query", { query: text, limit: 10 });
        content = response.results
          .filter(r => !["tool", "web", "tab", "app"].includes(r.source) && r.action.type !== "agentAsk")
          .slice(0, 8)
          .map(r => ({ group: r.source === "ai" ? "Ask" : "Lima", title: r.title, subtitle: r.subtitle, icon: SOURCE_ICONS[r.source] ?? "search", hue: 268, action: r.action, key: r.key }));
      } catch {}
    }
    if (input.value.trim() !== text) return; // a newer keystroke won
    items = [...matches, ...content];
    selected = Math.min(selected, Math.max(0, items.length - 1));
    timing.textContent = `${Math.round(performance.now() - started)} ms`;
    paint();
  }

  async function activate(item, { withInput = false } = {}) {
    if (item.capability) {
      const capability = item.capability;
      if (!pending && capability.input && (capability.input.required || withInput)) {
        pending = capability;
        input.value = "";
        input.placeholder = capability.input.placeholder;
        refresh();
        return;
      }
      try {
        const result = await runCapability(capability.id, item.input ?? "");
        if (!result) { close(); return; }
        results.replaceChildren(el("div", { class: "group", text: capability.title }), el("div", { class: "palette-result" }, resultView(result)));
        pending = null;
      } catch (error) {
        results.replaceChildren(el("div", { class: "palette-result" }, el("div", { class: "notice bad" }, icon("warning"), errorText(error))));
      }
      return;
    }
    if (item.action) {
      call("search.select", { key: item.key, query: input.value.trim() }).catch(() => {});
      const url = urlForAction(item.action);
      if (url) bridge.openTab(url);
      close();
    }
  }

  input.addEventListener("input", () => { selected = 0; refresh(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); if (pending) { pending = null; input.value = ""; input.placeholder = "Search Lima or run a command…"; refresh(); } else close(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(items.length - 1, selected + 1); paint(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); paint(); }
    else if (event.key === "Enter" && items[selected]) { event.preventDefault(); activate(items[selected]); }
    else if (event.key === "Tab" && items[selected]?.capability?.input) { event.preventDefault(); activate(items[selected], { withInput: true }); }
  });
  refresh();
}

const SOURCE_ICONS = { note: "note", conversation: "chat", report: "context", terminal: "terminal", context: "activity", ai: "spark" };

export function urlForAction(action) {
  const p = action.payload ?? {};
  const q = encodeURIComponent;
  switch (action.type) {
    case "openNote": return `about:lima?note=${q(p.id)}`;
    case "openConversation": return `about:lima?chat=${q(p.id)}`;
    case "openReport": return `about:lima?view=context&report=${q(p.id)}`;
    case "openContext": return "about:lima?view=activity";
    case "quickAsk": return `about:lima?ask=${q(p.prompt)}`;
    case "runCapability": return `about:lima?run=${q(p.id)}`;
    default: return null;
  }
}

/** Live counter of capability runs from every surface, for headers. */
export function onCapabilityRun(fn) {
  return onEvent(message => { if (message.event === "capability.finished") fn(message.data); });
}
