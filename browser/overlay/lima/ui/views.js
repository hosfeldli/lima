/* Smaller Lima surfaces, each its own tab. */
import { bar, bridge, call, el, errorText, icon, markdown, onEvent, prefs, relativeTime, setPage, permissionSheet } from "./lib.js";
import { resultView } from "./components.js";
import { agentControls, PROVIDERS } from "./composer.js";
import { companion, setCompanionState } from "./companion.js";
import { generationSettings } from "./studio-production.js";
import { companionMemorySettings, locationSettings, personalMemoryForm } from "./personal-memory.js";

const page = (...children) => el("div", { class: "page narrow" }, ...children);
const card = (title, ...children) => el("section", { class: "card" }, title ? el("h2", { text: title }) : null, ...children);
const fail = (node, error) => node.replaceChildren(el("p", { class: "error", text: errorText(error) }));

// MARK: Quick Ask (spec v1 §3.4): no tools, no page access, lowest effort.

export async function renderAsk(app, prompt) {
  setPage(`Ask: ${prompt}`, "chat");
  const provider = prefs.get("provider", "claude");
  const answer = el("div", { class: "typing" });
  const meta = el("p", { class: "muted", text: `Quick Ask via ${provider} · no tools, no page or file access` });
  const actions = el("div", { class: "row", hidden: true });
  app.replaceChildren(bar("Quick Ask"), el("div", { class: "prism-rule" }),
    page(el("h2", { text: prompt, style: { marginTop: 0 } }), meta, answer, actions));

  const requestId = crypto.randomUUID();
  let text = "";
  const off = onEvent(message => {
    if (message.event === "quickAsk.delta" && message.data.requestId === requestId) {
      text += message.data.text;
      answer.replaceChildren(markdown(text));
    }
  });
  const started = performance.now();
  try {
    const result = await call("quickAsk", { requestId, prompt, provider });
    off();
    answer.classList.remove("typing");
    if (result.error) {
      answer.replaceChildren(el("div", { class: "notice bad" }, el("strong", { text: `${result.error.kind}: ` }), result.error.message));
      actions.replaceChildren(el("button", { onclick: () => bridge.replaceURL(location.href) }, "Retry"));
    } else {
      text = result.text;
      answer.replaceChildren(markdown(text));
      actions.replaceChildren(
        el("button", { onclick: () => bridge.copy(text) }, "Copy"),
        el("button", { onclick: () => bridge.openTab(`about:lima?chat=new&prompt=${encodeURIComponent(prompt)}`) }, "Continue in chat"));
    }
    actions.hidden = false;
    // Lima overhead is measured apart from model latency (spec v1 §3.4).
    meta.textContent += ` · ${Math.round(result.elapsedMs)} ms in CLI, ${Math.round(performance.now() - started - result.elapsedMs)} ms Lima overhead`;
  } catch (error) {
    off();
    answer.classList.remove("typing");
    fail(answer, error);
  }
}

// MARK: Context Shelf

/** Activity history, weekly reports and privacy settings. Embedded as the
 * "Activity" / "Reports" tabs of the Activity page. */
export async function renderContext(app, reportId, { embedded = false, section = "activity" } = {}) {
  const reportsNode = el("div"), eventsNode = el("div"), settingsNode = el("div"), viewer = el("div");
  const generate = el("button", { onclick: async () => { const r = await call("context.generateReport"); showReport(r); drawReports(); } }, icon("bolt"), "Generate report now");
  const sections = section === "reports"
    ? [el("div", { class: "row", style: { justifyContent: "flex-end", marginBottom: "12px" } }, generate), viewer, card("Weekly reports · Fridays 3:00 PM", reportsNode)]
    : [card("Recent activity", eventsNode), card("Privacy & retention", settingsNode)];
  if (embedded) {
    app.replaceChildren(...sections);
  } else {
    setPage("Activity", "activity");
    app.replaceChildren(bar("Activity"), page(...sections));
  }

  let reports = [];
  function showReport(report) {
    viewer.replaceChildren(card(null, el("div", { class: "row" }, el("span", { class: "grow muted", text: `Generated ${new Date(report.generatedAt).toLocaleString()}` }),
      el("button", { class: "ghost", onclick: () => viewer.replaceChildren() }, "Close")), markdown(report.markdown)));
    if (!embedded) setPage(`Report ${report.id}`, "context");
  }

  async function drawReports() {
    try {
      reports = await call("context.reports");
      reportsNode.replaceChildren(reports.length ? el("ul", { class: "list" }, reports.map(r => el("li", { class: "clickable", onclick: () => showReport(r) },
        el("span", { class: "grow", text: `Week of ${r.id.replace("-draft", "")}` }), r.id.endsWith("-draft") ? el("span", { class: "badge", text: "draft" }) : null,
        el("span", { class: "muted", text: `${r.stats.events ?? 0} events` })))) : el("p", { class: "muted", text: "No reports yet. The first one is generated on Friday at 3 PM (or when your Mac is next awake)." }));
      if (reportId) { const match = reports.find(r => r.id === reportId); if (match) showReport(match); reportId = null; }
    } catch (error) { fail(reportsNode, error); }
  }

  async function drawEvents() {
    try {
      const events = await call("context.recent", { limit: 150 });
      const icons = { app: "app", browser: "web", terminal: "terminal", git: "github", agent: "star", note: "note", media: "audio", meeting: "calendar", task: "check", report: "context" };
      eventsNode.replaceChildren(events.length ? el("ul", { class: "list" }, events.map(e => el("li", {},
        icon(icons[e.kind] ?? "activity"),
        el("span", { class: "grow" }, e.title, e.detail ? el("span", { class: "muted", text: ` — ${e.detail}` }) : null),
        el("span", { class: "muted", text: relativeTime(e.timestamp) })))) : el("p", { class: "muted", text: "No activity recorded yet." }));
    } catch (error) { fail(eventsNode, error); }
  }

  async function drawSettings() {
    try {
      const [settings, background] = await Promise.all([call("context.settings.get"), call("background.status")]);
      const save = async patch => { await call("context.settings.set", { settings: { ...settings, ...patch } }); drawSettings(); drawEvents(); };
      const retention = el("select", {}, [7, 30, 90, 180, 365].map(d => el("option", { value: d, text: `${d} days`, selected: d === settings.retentionDays })));
      retention.addEventListener("change", () => save({ retentionDays: Number(retention.value) }));
      const excluded = el("input", { type: "text", value: settings.excludedApps.join(", "), style: { width: "100%" } });
      excluded.addEventListener("change", () => save({ excludedApps: excluded.value.split(",").map(s => s.trim()).filter(Boolean) }));
      settingsNode.replaceChildren(
        toggle("Record activity metadata (apps, commands, notes, agents, browsing, music titles)", settings.collectActivity, v => save({ collectActivity: v })),
        toggle("Generate weekly reports", settings.generateReports, v => save({ generateReports: v })),
        el("div", { class: "toggle" }, "Keep activity for ", retention),
        el("label", { class: "muted", text: "Excluded apps (bundle IDs)" }), excluded,
        el("p", { class: "muted", text: "Never recorded: keystrokes, passwords, field contents, screen images, audio, and private browsing windows." }),
        el("div", { class: "row" },
          el("span", { class: "grow", text: background.loaded ? "Lima runs in the background, so reports are generated even with the browser closed." : "Reports currently run only while Lima is open." }),
          background.installed
            ? el("button", { onclick: async () => { await call("background.uninstall"); drawSettings(); } }, "Stop running in background")
            : el("button", { class: "primary", onclick: async () => { await call("background.install"); drawSettings(); } }, "Run in background")),
        el("div", { class: "row", style: { marginTop: "10px" } }, el("button", { class: "danger", onclick: async () => {
          if (confirm("Delete all recorded activity? Reports are kept.")) { await call("context.deleteAll"); drawEvents(); }
        } }, "Delete all activity")));
    } catch (error) { fail(settingsNode, error); }
  }

  if (section === "reports") drawReports(); else { drawEvents(); drawSettings(); }
  onEvent(m => { if (m.event === "context.event") drawEvents(); if (m.event === "context.report") drawReports(); });
}

function toggle(label, value, onChange) {
  const box = el("input", { type: "checkbox", checked: value });
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { class: "toggle" }, box, label);
}

// MARK: Audio (spec v2 §10): compact output switching, one volume control.

export async function renderAudio(app) {
  setPage("Audio", "audio");
  const outputs = el("div"), nowPlaying = el("div");
  const volume = el("input", { type: "range", min: 0, max: 100, step: 1, style: { width: "min(360px, 100%)", marginTop: "8px" }, "aria-label": "Volume" });
  app.replaceChildren(bar("Audio"), el("div", { class: "prism-rule" }), page(el("div", { class: "pack" }, card("Output", outputs, volume), card("Now playing", nowPlaying))));

  const drawOutputs = () => call("audio.outputs").then(items => renderAudioOutputs(outputs, items)).catch(e => fail(outputs, e));
  call("audio.volume").then(v => { volume.value = Math.round(v * 100); });
  volume.addEventListener("input", () => call("audio.volume", { value: volume.value / 100 }).catch(e => fail(outputs, e)));

  function drawNowPlaying(item) {
    const control = action => el("button", { onclick: () => call("media.control", { action }).catch(e => nowPlaying.append(el("p", { class: "error", text: errorText(e) }))) });
    nowPlaying.replaceChildren(
      item?.title ? el("p", {}, el("strong", { text: item.title }), el("span", { class: "muted", text: ` — ${item.artist} · ${item.player} (${item.state})` })) : el("p", { class: "muted", text: "Nothing playing in Spotify or Music." }),
      el("div", { class: "row" },
        Object.assign(control("previous"), { title: "Previous" }), Object.assign(control("playpause"), { title: "Play / pause" }),
        Object.assign(control("next"), { title: "Next" }), Object.assign(control("dj"), { textContent: "Spotify DJ" })));
    const glyphs = { Previous: "previous", "Play / pause": "play", Next: "next" };
    for (const button of nowPlaying.querySelectorAll("button[title]")) { button.classList.add("icon-only"); button.append(icon(glyphs[button.title])); }
  }
  call("media.nowPlaying").then(drawNowPlaying).catch(() => drawNowPlaying(null));
  onEvent(m => { if (m.event === "media.nowPlaying") drawNowPlaying(m.data); });
  drawOutputs();
}

export function renderAudioOutputs(node, items) {
  node.replaceChildren(el("ul", { class: "list" }, items.map(d => el("li", {
    class: "clickable", onclick: async () => renderAudioOutputs(node, await call("audio.setOutput", { id: d.id })),
  }, el("span", { text: d.isDefault ? "●" : "○" }), el("span", { class: "grow", text: d.name }), el("span", { class: "badge", text: d.transport })))));
  if (items.some(d => d.isDefault && d.transport === "bluetooth")) {
    node.append(el("p", { class: "muted", text: "Bluetooth headsets may switch to lower-quality audio while their microphone is in use. Pick a different input to keep full playback quality." }));
  }
}

// MARK: Integrations & settings

export async function renderIntegrations(app, section) {
  setPage("Integrations & Settings", "integrations");
  const services = el("div"), mcp = el("div"), storage = el("div");
  const personality = el("select", { "aria-label": "Companion Animations", onchange: event => {
    prefs.set("personality", event.target.value);
    bridge.browser("personalityChanged", { value: event.target.value }).catch(() => {});
  } }, ["Full", "Subtle", "Off"].map(label => el("option", { value: label.toLowerCase(), text: label })));
  personality.value = prefs.get("personality", "full");
  bridge.browser("agentPreferences", {}).then(data => { if (data?.personality) personality.value = data.personality; }).catch(() => {});
  const theme = el("select", { "aria-label": "Theme", onchange: event =>
    bridge.browser("themeChanged", { value: event.target.value }).catch(() => {}) },
    [["system", "Match macOS"], ["light", "Light"], ["dark", "Dark"]].map(([value, text]) => el("option", { value, text })));
  bridge.browser("agentPreferences", {}).then(data => { if (data?.themeSetting) theme.value = data.themeSetting; }).catch(() => {});
  const overlay = el("input", { type: "checkbox", onchange: event =>
    bridge.browser("browserActionOverlayChanged", { value: event.target.checked }).catch(() => {}) });
  bridge.browser("agentPreferences", {}).then(data => { overlay.checked = data?.browserActionOverlay === true; }).catch(() => {});
  const groups = [
    ["general", "General", "appearance theme dark light mode animation preferences tabs size height compact large", [
      card("Appearance", el("label", { class: "row" }, "Theme", theme),
        el("label", { class: "row" }, "Companion Animations", personality),
        el("p", { class: "muted", text: "Off keeps the mascot still. Lima also respects macOS Reduce Motion." }),
        el("label", { class: "row appearance-checkbox" }, overlay, "Show agent click and typing markers on webpages")),
      card("Tabs", tabSizeSettings()),
    ]],
    ["search", "Search", "search address bar ai overview answers copilot sponsored ads google bing duckduckgo yahoo brave results youtube shorts ranking index", searchSettings()],
    ["sidebar", "Sidebar", "dock shortcuts edit order spotify music calendar mail dictation", [card("Sidebar shortcuts", sidebarSettings())]],
    ["personal", "Personal Memory", "profile name email phone home address location privacy context companion memory learned daily", [
      card("Your information", personalMemoryForm()), card("What the Companion remembers", companionMemorySettings()),
      card("Location Services", locationSettings()),
    ]],
    ["agents", "AI providers", "claude codex opencode sign in install default model setup", [card("AI providers", providerSettings())]],
    ["image-generation", "Image Generation", "local ComfyUI checkpoints model artwork generator", [card("Local provider", generationSettings())]],
    ["writing", "Writing tools", "grammar accessibility global shortcut ai replace", [card("Grammar checker", grammarSettings())]],
    ["connections", "Integrations", "gmail google calendar oauth github reminders login spotify automation", [
      card("Gmail & Google Calendar", googleSettings()), card("GitHub", services),
      card("Messages", messagesSettings()),
    ]],
    ["privacy", "Privacy", "privacy usage statistics analytics telemetry anonymous share data delete tracking", [
      card("Your data stays on your Mac", privacySummary()), card("Anonymous usage statistics", usageSettings()),
    ]],
    ["data", "Data & permissions", "backup recovery encryption MCP storage grants permission", [
      card("MCP for external agents", mcp), card("Encrypted storage", storage),
    ]],
    ["updates", "Updates", "version download release restart stable check", [card(null, updateSettings())]],
  ];
  const aliases = { google: "connections", grammar: "writing", usage: "privacy", browsing: "search" };
  let active = aliases[section] ?? (groups.some(([id]) => id === section) ? section : "general");
  const search = el("input", { type: "search", placeholder: "Search settings", "aria-label": "Search settings" });
  const nav = el("nav", { class: "settings-nav", "aria-label": "Settings categories" });
  const empty = el("p", { class: "muted", hidden: true, text: "No settings match your search." });
  const panes = groups.map(([id, label, words, cards]) => {
    const pane = el("section", { class: "settings-pane", "aria-label": label }, el("h1", { text: label }), cards);
    const button = el("button", { class: "ghost", onclick: () => { active = id; search.value = ""; paint(); } }, label);
    nav.append(button);
    return { id, label, words, pane, button };
  });
  function paint() {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const { id, label, words, pane, button } of panes) {
      const index = `${label} ${words} ${pane.textContent}`.toLowerCase();
      pane.hidden = terms.length ? !terms.every(term => index.includes(term)) : id !== active;
      button.setAttribute("aria-current", String(id === active && !terms.length));
    }
    empty.hidden = panes.some(item => !item.pane.hidden);
  }
  search.addEventListener("input", paint);
  app.replaceChildren(el("header", { class: "settings-header" }, el("strong", { text: "Settings" }), search),
    el("div", { class: "settings-layout" }, nav, el("div", { class: "settings-content" }, ...panes.map(item => item.pane), empty)));
  paint();

  call("integrations.status").then(list => {
    const github = list.find(service => service.id === "github");
    const connected = github?.state === "connected";
    services.replaceChildren(
      el("div", { class: "integration-service row" },
        el("div", { class: "grow" }, el("strong", { text: connected ? "Connected" : "Sign-in required" }),
          el("p", { class: "muted", text: "Review pull requests using the GitHub CLI account on this Mac." })),
        connected ? el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?tool=github.inbox") }, "Open inbox") : null),
      connected ? null : el("details", {}, el("summary", {}, "Set up GitHub"), el("code", { text: "gh auth login" }),
        el("button", { class: "ghost", onclick: () => bridge.copy("gh auth login") }, "Copy command")));
  }).catch(error => fail(services, error));

  async function drawMCP() {
    const scopes = new Set(await call("mcp.grants.get"));
    const all = [["notes:read", "Read notes"], ["search:read", "Search Lima"], ["context:read", "Read activity & reports"],
      ["notes:write", "Create and edit notes (undoable agent edits)"]];
    const save = async () => { await call("mcp.grants.set", { scopes: [...scopes] }); };
    mcp.replaceChildren(
      el("p", { class: "muted", text: "Add Lima to Codex, Claude Code or OpenCode as a stdio MCP server:" }),
      el("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: "12px" }, text: `claude mcp add lima -- "/Applications/Lima.app/Contents/MacOS/lima-host" mcp` }),
      ...all.map(([scope, label]) => toggle(`${label} (${scope})`, scopes.has(scope), v => { v ? scopes.add(scope) : scopes.delete(scope); save(); })));
  }
  drawMCP().catch(e => fail(mcp, e));

  async function drawStorage() {
    const s = await call("storage.status");
    const passphrase = el("input", { type: "password", placeholder: "Recovery passphrase (12+ characters)", style: { minWidth: "280px" } });
    storage.replaceChildren(
      el("p", { text: `Encrypted locally with a key in your Keychain. ${s.notes} notes · ${s.conversations} conversations · ${s.events} activity events. Works offline.` }),
      el("p", { class: "muted", text: s.location }),
      s.legacyNotesMigration ? el("p", { class: "muted", text: `Lima 4.x notes imported and verified (${s.legacyNotesMigration}).` })
        : el("button", { onclick: async () => { const r = await call("notes.migrateLegacy"); alert(`Imported ${r.imported} of ${r.found} notes${r.verified ? " (verified)" : " — verification failed, originals untouched"}.`); drawStorage(); } }, "Import Lima 4.x notes"),
      s.legacyPlaintext.length ? el("div", { class: "notice warn" }, "Lima 4.x plaintext data still on disk (not deleted automatically): ", el("code", { text: s.legacyPlaintext.join(", ") })) : null,
      el("div", { class: "row-label", text: "Recovery key" }),
      el("p", { class: "muted", text: "Without a recovery key, losing this Mac's Keychain makes your Lima data unrecoverable." }),
      el("div", { class: "row" }, passphrase, el("button", { onclick: async () => {
        try { const r = await call("storage.exportRecoveryKey", { passphrase: passphrase.value }); passphrase.value = ""; alert(`Recovery key saved to ${r.path}. Keep it and the passphrase somewhere safe.`); }
        catch (error) { alert(errorText(error)); }
      } }, "Export recovery key")));
  }
  drawStorage().catch(e => fail(storage, e));
}

/** Tab height with a preview of sidebar tabs at that size. */
function tabSizeSettings() {
  const PRESETS = [["Compact", 22], ["Default", 26], ["Comfortable", 32], ["Large", 38]];
  const slider = el("input", { type: "range", min: 22, max: 40, step: 1, value: 26, "aria-label": "Tab height" });
  const readout = el("span", { class: "muted tab-size-readout" });
  const sample = [["web", "Lima — Release notes"], ["note", "Trip ideas"], ["globe", "Weather · San Francisco"], ["chat", "Plan the launch"]];
  const preview = el("div", { class: "tab-size-preview", "aria-hidden": "true" },
    sample.map(([glyph, label], index) => el("div", { class: index === 1 ? "tab-size-row selected" : "tab-size-row" }, icon(glyph), el("span", { text: label }))));
  const presets = el("div", { class: "row tab-size-presets" }, PRESETS.map(([label, value]) =>
    el("button", { class: "ghost", "data-height": String(value), onclick: () => apply(value, true) }, label)));
  function paint(height) {
    slider.value = String(height);
    preview.style.setProperty("--preview-height", `${height}px`);
    preview.style.setProperty("--preview-font", `${(11.5 + (height - 26) * 0.2).toFixed(2)}px`);
    readout.textContent = `${height} px`;
    for (const button of presets.children) button.setAttribute("aria-pressed", String(Number(button.dataset.height) === height));
  }
  function apply(height, save) {
    paint(height);
    if (save) bridge.browser("browsingPrefs", { key: "tabHeight", value: height }).catch(() => {});
  }
  slider.addEventListener("input", () => apply(Number(slider.value), false));
  slider.addEventListener("change", () => apply(Number(slider.value), true));
  bridge.browser("browsingPrefs", {}).then(prefs => paint(prefs?.tabHeight ?? 26)).catch(() => paint(26));
  return el("div", { class: "tab-size-settings" },
    el("label", { class: "row" }, "Tab size", slider, readout), presets, preview,
    el("p", { class: "muted", text: "Changes every window's sidebar tabs as you drag." }));
}

/** Settings → Search: Lima Search, result-page filters per engine, YouTube. */
function searchSettings() {
  const save = (key, value) => bridge.browser("browsingPrefs", { key, value }).catch(() => {});
  const box = (key, label, detail) => {
    const input = el("input", { type: "checkbox", onchange: () => { save(key, input.checked); paintEngines(); } });
    return [input, el("label", { class: "row appearance-checkbox setting-check" }, input,
      el("span", {}, el("strong", { text: label }), detail ? el("small", { class: "muted", text: detail }) : null))];
  };
  const [address, addressRow] = box("searchAsAddressBar", "Use Lima Search as the address bar", "⌘L opens it with the current address; pages open in this tab.");
  const [ai, aiRow] = box("hideSearchAI", "Hide AI answers", "Google AI Overviews, Bing Copilot answers, DuckDuckGo Assist, Brave and Yahoo AI answers.");
  const [ads, adsRow] = box("hideSearchAds", "Hide sponsored results", "Ads at the top and bottom of results, and shopping ads.");
  const [shorts, shortsRow] = box("hideShorts", "Hide YouTube Shorts", "Shelves and the Shorts tab disappear; Shorts links play as normal videos.");
  const ENGINES = [["google", "Google"], ["bing", "Bing"], ["duckduckgo", "DuckDuckGo"], ["yahoo", "Yahoo"], ["brave", "Brave Search"]];
  const engines = el("div", { class: "engine-switches", role: "group", "aria-label": "Search engines to filter" });
  let enabled = new Set(ENGINES.map(([id]) => id));
  function paintEngines() {
    const off = !ai.checked && !ads.checked;
    engines.replaceChildren(...ENGINES.map(([id, name]) => {
      const input = el("input", { type: "checkbox", checked: enabled.has(id), disabled: off, onchange: () => {
        if (input.checked) enabled.add(id); else enabled.delete(id);
        save("cleanEngines", [...enabled]);
      } });
      return el("label", { class: "engine-switch" }, input, name);
    }));
  }
  bridge.browser("browsingPrefs", {}).then(prefs => {
    ai.checked = prefs?.hideSearchAI !== false; ads.checked = prefs?.hideSearchAds !== false;
    address.checked = prefs?.searchAsAddressBar !== false; shorts.checked = prefs?.hideShorts !== false;
    if (Array.isArray(prefs?.cleanEngines)) enabled = new Set(prefs.cleanEngines);
    paintEngines();
  }).catch(() => paintEngines());
  return [
    card("Lima Search", addressRow,
      el("div", { class: "row" },
        el("button", { onclick: async () => { await call("search.resetLearning"); alert("Learned ranking reset."); } }, "Reset learned ranking"),
        el("button", { onclick: async () => { const n = await call("search.rebuild", { source: "app" }); alert(`Index rebuilt (${n} items).`); } }, "Rebuild app index"))),
    card("Search result pages", aiRow, adsRow,
      el("p", { class: "settings-subhead", text: "Filter results on" }), engines,
      el("p", { class: "muted", text: "Lima only hides these blocks on your Mac. Your searches and results are unchanged and nothing is sent anywhere. If a results page ever looks wrong, turn its engine off here and reload the page." })),
    card("YouTube", shortsRow),
  ];
}

/** What Lima keeps and where: plain facts, first. */
function privacySummary() {
  const facts = [
    "Notes, chats, activity and memory are encrypted on this Mac with a key in your Keychain. Lima has no account and no cloud copy.",
    "Your AI provider (Claude, Codex or OpenCode) receives what you send and what its agents read while working for you, under that provider's own terms. Lima keeps no copy on any server.",
    "Once a day, Companion memory sends your recent requests and activity to your default AI to update its notes. Turn it off in Personal Memory.",
    "Agents and outside AI tools ask before they read your chats, take screenshots, open apps or touch your settings.",
    "Private windows are never recorded, counted or shown to agents.",
    "Page cleanup (hiding AI answers, ads and Shorts) runs on your Mac and sends nothing anywhere.",
  ];
  return el("ul", { class: "privacy-facts" }, facts.map(text => el("li", {}, icon("check"), el("span", { text }))));
}

/** Anonymous usage statistics: on by default, previewable, deletable, and off with one click. */
function usageSettings() {
  const box = el("input", { type: "checkbox" });
  const status = el("p", { class: "muted", role: "status" });
  const preview = el("pre", { class: "usage-preview", hidden: true });
  const paint = state => {
    box.checked = state?.enabled === true;
    status.textContent = !state?.enabled ? "Off. Nothing is counted or sent."
      : state.lastSent ? `On. Last report sent ${new Date(state.lastSent).toLocaleDateString()}.` : "On. The first report goes out tomorrow.";
  };
  box.addEventListener("change", async () => {
    try { paint(await call("usage.set", { enabled: box.checked })); } catch (error) { status.textContent = errorText(error); }
  });
  const show = el("button", { class: "ghost", onclick: async () => {
    if (!preview.hidden) { preview.hidden = true; return; }
    try { preview.textContent = JSON.stringify(await call("usage.preview"), null, 2); preview.hidden = false; }
    catch (error) { status.textContent = errorText(error); }
  } }, "See exactly what's sent");
  const remove = el("button", { class: "ghost", onclick: async () => {
    if (!confirm("Delete every report sent from this Mac and start over with a new anonymous ID?")) return;
    try { paint(await call("usage.delete")); status.textContent = "Deleted. Lima's server no longer has any report from this Mac."; }
    catch (error) { status.textContent = errorText(error); }
  } }, "Delete my data");
  call("usage.get").then(paint).catch(error => { status.textContent = errorText(error); });
  return el("div", { class: "usage-settings" },
    el("label", { class: "row appearance-checkbox" }, box, "Share anonymous usage statistics"),
    el("p", { class: "muted", text: "Helps decide what to build next. Once a day Lima sends how many times each feature was used (for example: searches opened, chats sent, workspaces created), the Lima and macOS versions, your region from macOS's language settings, and a few settings such as light or dark mode." }),
    el("p", { class: "muted", text: "Never sent: web pages, searches, chat or note text, file names, accounts, contacts or your IP address (the server doesn't keep it). Reports use a random ID that changes every month and are deleted after 13 months." }),
    status, el("div", { class: "row" }, show, remove), preview);
}

function updateSettings() {
  const mascot = companion("chat-avatar");
  const installed = el("span", { class: "muted" });
  const heading = el("h2", { text: "Checking update status…" });
  const detail = el("p", { class: "muted" });
  const outcome = el("p", { class: "update-outcome", role: "status", hidden: true });
  const progress = el("progress", { "aria-label": "Update in progress", hidden: true });
  const check = el("button", { class: "ghost", disabled: true, onclick: () => run("checkForUpdate") }, "Check for Updates");
  const install = el("button", { class: "primary", hidden: true, onclick: () => run("installUpdate") }, "Restart to Update");
  const whatsNew = el("button", { class: "ghost", onclick: () => bridge.openTab("https://github.com/hosfeldli/lima/releases") }, "View What's New");
  const checked = el("small", { class: "muted" });
  const node = el("div", { class: "update-settings" },
    el("div", { class: "update-summary" }, mascot, el("div", { class: "grow", role: "status" }, installed, heading, detail)),
    progress, outcome, el("div", { class: "row update-actions" }, check, install, whatsNew, checked));
  let state;
  let working;
  let revision = 0;
  const phases = {
    disabled: ["Automatic updates are off", "This build is outside the stable update channel."],
    idle: ["Lima is up to date", ""],
    checking: ["Checking for updates…", "Contacting the Lima release server."],
    available: ["Downloading update…", "Preparing the download."],
    downloading: ["Downloading update…", "Lima verifies the update’s signature before offering to install it."],
    verifying: ["Verifying update…", "Checking the signature and code signing before offering to install it."],
    ready: ["Ready to Restart", "Restart now, or it installs when you quit Lima. Lima reopens with this browser profile, tabs, folders and settings."],
    installing: ["Restarting Lima…", "Saving the browser session before replacing the app."],
    failed: ["Update Failed", "Your current version keeps working. Try again."],
  };
  function paint() {
    if (!state) return;
    const { phase, version, currentVersion, checkedAt, lastInstall, error } = state;
    const [label, explanation] = phases[phase] ?? phases.idle;
    const busy = working || ["checking", "available", "downloading", "verifying", "installing"].includes(phase);
    installed.textContent = currentVersion ? `Lima ${currentVersion} · ${phase === "disabled" ? "Development" : "Stable"}` : "Lima";
    heading.textContent = phase === "ready" && version ? `Lima ${version} · Ready to Restart`
      : phase === "idle" && !checkedAt ? "Check for a new version" : label;
    detail.textContent = phase === "idle" && !checkedAt ? "Check for the latest stable release." : explanation;
    outcome.hidden = !(error || lastInstall?.ok === false);
    outcome.textContent = error || lastInstall?.error || "";
    progress.hidden = !busy;
    // Real download progress when lima-host reports it; indeterminate otherwise.
    if (phase === "downloading" && state.progress != null) { progress.max = 1; progress.value = state.progress; }
    else progress.removeAttribute("value");
    if (phase === "downloading" && state.progress != null) detail.textContent = `${Math.round(state.progress * 100)}% · ${explanation}`;
    check.disabled = Boolean(busy);
    check.hidden = ["disabled", "ready", "installing"].includes(phase);
    check.textContent = phase === "failed" ? "Retry" : "Check for Updates";
    install.hidden = phase !== "ready";
    install.disabled = Boolean(busy);
    checked.textContent = checkedAt ? `Last checked ${new Date(checkedAt).toLocaleString()}` : "";
    setCompanionState(mascot, busy ? "think" : phase === "ready" ? "complete" : phase === "failed" ? "failed" : "idle");
  }
  async function run(kind) {
    const ticket = revision;
    working = kind !== "updateStatus";
    if (kind === "checkForUpdate") state = { ...state, phase: "checking", error: null };
    paint();
    try {
      const result = await bridge.browser(kind, {});
      if (result && revision === ticket && !(kind === "checkForUpdate" && result.phase === "idle")) state = result;
    } catch (error) {
      state = { ...state, phase: kind === "installUpdate" ? "ready" : "failed", error: errorText(error) };
    } finally { working = false; paint(); }
  }
  const unsubscribe = onEvent(({ event, data }) => {
    if (event !== "update.status" || !data) return;
    revision++;
    state = data;
    paint();
  });
  window.addEventListener("pagehide", unsubscribe, { once: true });
  run("updateStatus");
  return node;
}

function sidebarSettings() {
  const node = el("div", { class: "settings-shortcuts" });
  const names = { inbox: "Gmail", calendar: "Calendar", spotify: "Music (Spotify, Apple Music, tabs)", downloads: "Downloads", mic: "Dictation", grammar: "Grammar settings" };
  async function draw() {
    const saved = await bridge.browser("sidebarShortcuts", {});
    const order = [...new Set([...(saved.order ?? []), ...Object.keys(names)])].filter(id => Object.hasOwn(names, id));
    const hidden = new Set(saved.hidden ?? ["grammar"]);
    async function save(next) {
      await bridge.browser("saveSidebarShortcuts", { order: next, hidden: [...hidden] });
      await draw();
    }
    node.replaceChildren(...order.map((id, index) => {
      const move = delta => {
        const next = [...order];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        save(next);
      };
      return el("div", { class: "row" }, toggle(names[id], !hidden.has(id), visible => {
        if (visible) hidden.delete(id); else hidden.add(id);
        save(order);
      }), el("span", { class: "spacer" }),
      el("button", { class: "ghost icon-only", disabled: index === 0, "aria-label": "Move up " + names[id], onclick: () => move(-1) }, "↑"),
      el("button", { class: "ghost icon-only", disabled: index === order.length - 1, "aria-label": "Move down " + names[id], onclick: () => move(1) }, "↓"));
    }));
  }
  draw().catch(error => fail(node, error));
  return node;
}

export function setupAction(id, label, approval, finished) {
  const row = el("div", { class: "settings-setup" });
  const start = el("button", { class: "primary", onclick: () => { confirm.hidden = false; } }, label);
  const feedback = el("span", { class: "muted", role: "status" });
  const open = el("button", { class: "primary", hidden: true }, "Continue in browser");
  const confirm = el("div", { class: "notice", hidden: true }, el("p", { text: approval }),
    el("div", { class: "row" }, el("button", { class: "primary", onclick: run }, "Approve"),
      el("button", { class: "ghost", onclick: () => { confirm.hidden = true; } }, "Cancel")));
  let previous;
  function show(state) {
    if (state?.id !== id) return;
    start.disabled = ["running", "consent"].includes(state.phase);
    feedback.textContent = state.message ?? ({ running: "Working…", consent: "Waiting for your sign-in.", done: "Completed." }[state.phase] ?? "");
    open.hidden = state.phase !== "consent" || !state.url;
    open.onclick = () => bridge.openTab(state.url);
    if (state.phase === "done" && previous && previous !== "done") finished?.();
    previous = state.phase;
  }
  async function run() {
    confirm.hidden = true;
    start.disabled = true;
    try { show(await call("integrations.setup.start", { id })); }
    catch (error) { feedback.textContent = errorText(error); start.disabled = false; }
  }
  const off = onEvent(({ event, data }) => {
    if (!row.isConnected) { off(); return; }
    if (event === "integrations.setup.updated") show(data);
  });
  window.addEventListener("pagehide", off, { once: true });
  call("integrations.setup.status", { id }).then(show).catch(() => {});
  row.append(el("div", { class: "row" }, start, open, feedback), confirm);
  return row;
}

function providerSettings() {
  const node = el("div");
  const items = el("div");
  const controls = agentControls();
  const mappings = {
    claude: ["brew install --cask claude-code", "https://code.claude.com/docs/en/setup"],
    codex: ["npm install -g @openai/codex", "https://github.com/openai/codex#quickstart"],
    opencode: ["brew install anomalyco/tap/opencode-v2", "https://opencode.ai/docs/providers"],
  };
  // One row per provider. The state separates a missing CLI, a CLI that
  // won't report its version, and an installed CLI that isn't signed in.
  const STATES = {
    ready: ["Ready", name => `${name} is installed and signed in.`],
    notInstalled: ["Not Installed", name => `${name} isn't installed on this Mac. Install it, then check again.`],
    signIn: ["Sign-In Required", name => `${name} is installed, but Lima couldn't verify its sign-in. Sign in and check again.`],
    unavailable: ["Unavailable", name => `${name} was found, but it didn't respond to Lima's version check. Reinstall it or view the details.`],
  };
  async function draw() {
    items.replaceChildren(el("p", { class: "muted", role: "status", text: "Checking…" }));
    let providers, configured;
    try {
      [providers, configured] = await Promise.all([call("agents.discover"), call("agents.configured")]);
    } catch (error) {
      items.replaceChildren(el("div", { class: "notice bad" }, icon("warning"),
        el("span", { class: "grow" }, el("strong", { text: "Disconnected. " }), "Lima's runtime didn't answer, so provider status is unknown. ", errorText(error)),
        el("button", { class: "ghost", onclick: () => draw() }, "Check Again")));
      return;
    }
    await controls.refresh();
    items.replaceChildren(...providers.map(provider => {
      const id = provider.provider;
      const name = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" }[id] ?? PROVIDERS[id];
      const [command, docs] = mappings[id];
      const installed = provider.status === "available";
      const ready = configured.includes(id);
      const state = ready ? "ready" : provider.status === "not_installed" ? "notInstalled" : provider.status === "version_probe_failed" ? "unavailable" : "signIn";
      const [label, explain] = STATES[state];
      return el("article", { class: "settings-provider", "data-state": state },
        el("div", { class: "row" }, el("strong", { text: name }), el("span", { class: "spacer" }), el("span", { class: "badge", text: label })),
        el("p", { class: "muted", text: explain(name) }),
        provider.executablePath ? el("code", { text: provider.executablePath, title: provider.installations?.[0]?.resolvedPath }) : null,
        state === "notInstalled" ? setupAction("install." + id, "Install", "Run " + command + " on this Mac?", draw) : null,
        installed && !ready && id !== "opencode" ? setupAction(id, "Sign In", "Start " + name + " sign-in?", draw) : null,
        !ready ? el("div", { class: "row" },
          el("button", { class: "ghost", onclick: () => bridge.openTab(docs) }, "Open Setup"),
          el("button", { class: "ghost", onclick: () => draw() }, "Check Again")) : null,
        provider.diagnostic || provider.version ? el("details", {}, el("summary", { text: "View Details" }),
          el("pre", { class: "muted", text: [provider.version && `Version: ${provider.version}`, provider.diagnostic].filter(Boolean).join("\n") })) : null);
    }));
  }
  const failover = el("input", { type: "checkbox", disabled: true, onchange: async () => {
    failover.disabled = true;
    try { failover.checked = await call("agents.failover", { enabled: failover.checked }); }
    catch { failover.checked = !failover.checked; }
    finally { failover.disabled = false; }
  } });
  call("agents.failover").then(enabled => { failover.checked = enabled !== false; failover.disabled = false; }).catch(() => {});
  node.append(el("div", { class: "row" }, el("strong", { text: "Default AI" }), controls.provider, controls.model,
    el("button", { class: "ghost", onclick: () => draw().catch(error => fail(items, error)) }, "Check Again")),
  el("label", { class: "personal-check" }, failover, "When a provider hits its usage limit, continue with another signed-in provider"), items);
  draw().catch(error => fail(items, error));
  return node;
}

function messagesSettings() {
  const recipient = el("input", { maxlength: 160, placeholder: "Phone number or email" });
  const message = el("textarea", { maxlength: 5000, rows: 3, required: true });
  const status = el("p", { class: "muted", role: "status" });
  const send = el("button", { class: "primary", type: "submit" }, "Open draft in Messages");
  return el("form", { class: "messages-settings", onsubmit: async event => {
    event.preventDefault();
    send.disabled = true;
    status.textContent = "";
    try { await call("integrations.messages.compose", { recipient: recipient.value, message: message.value }); }
    catch (error) { status.textContent = errorText(error); }
    finally { send.disabled = false; }
  } }, el("label", {}, "Recipient (optional)", recipient),
  el("label", {}, "Message", message), send, status);
}

function googleSettings() {
  const node = el("div", { id: "google-settings" });
  const detail = el("div");
  const progress = el("p", { class: "muted", role: "status" });
  node.append(detail, progress);
  const install = "npm install -g @googleworkspace/cli";
  function action(label, handler, primary = false) {
    return el("button", { class: primary ? "primary" : "ghost", onclick: async event => {
      event.currentTarget.disabled = true;
      const button = event.currentTarget;
      progress.textContent = "";
      try { await handler(); }
      catch (error) { progress.textContent = errorText(error); }
      finally { button.disabled = false; }
    } }, label);
  }
  async function refresh() {
    progress.textContent = "Checking Google Workspace…";
    try { draw(await call("integrations.google.refresh", { force: true })); }
    finally { progress.textContent = ""; }
  }
  let displayed, current;
  let essentials = {};
  function draw(value) {
    current = value;
    const state = JSON.stringify([value.installed, value.enabled, value.mail, value.calendar, value.mailReconnect,
      value.calendarReconnect, value.mailIssue, value.calendarIssue, essentials.mail, essentials.calendar]);
    if (state === displayed) return;
    displayed = state;
    const connected = value.mail === "connected" && value.calendar === "connected";
    function row(title, service, api) {
      const state = value[service];
      const issue = value[`${service}Issue`];
      const status = state === "connected" ? "Connected"
        : issue === "apiDisabled" ? "API disabled"
        : value[`${service}Reconnect`] ? "Reconnect needed"
        : state === "unavailable" ? "Couldn’t verify" : "Not connected";
      return el("div", { class: "integration-service google-service" },
        el("strong", { class: "grow", text: title }),
        essentials[service] && state !== "connected" ? el("span", { class: "badge", text: "Via Essentials" }) : null,
        el("span", { class: `badge ${state === "connected" ? "ok" : issue ? "warn" : ""}`, text: status }),
        issue === "apiDisabled" ? el("div", { class: "google-service-help" },
          action("Open API settings", () => bridge.openTab(`https://console.cloud.google.com/apis/library/${api}.googleapis.com`))) : null);
    }
    const needsSignIn = ["mail", "calendar"].some(service => value[service] === "setup" && value[`${service}Issue`] !== "apiDisabled");
    const firstStep = !value.installed
      ? setupAction("install.google", "Install Google Workspace CLI", "Install the Google Workspace CLI on this Mac?", () => call("integrations.google.status").then(draw))
      : !value.enabled ? action("Connect Google Workspace", async () => {
        await call("integrations.google.configure", { enabled: true });
        await refresh();
      }, true)
      : needsSignIn ? setupAction("google", value.mailReconnect || value.calendarReconnect ? "Sign in again" : "Sign in with Google",
        "Allow read-only Google sign-in for unread mail and upcoming meetings?", refresh)
      : !connected ? action("Check connection", refresh, true) : null;
    detail.replaceChildren(
      el("p", { class: "muted", text: "Summary counts and upcoming meetings appear in the sidebar. Gmail and Calendar tabs in Essentials can also supply reminders." }),
      row("Gmail", "mail", "gmail"), row("Google Calendar", "calendar", "calendar"),
      firstStep,
      el("details", { class: "integration-help" }, el("summary", {}, connected ? "Connection options" : "Setup help"),
        el("p", { class: "muted", text: value.installed
          ? "Lima checks for an existing Google Workspace CLI login first. If Google asks for an OAuth client, use the setup guide."
          : "The Google Workspace CLI is required for account access outside Essentials." }),
        el("div", { class: "row" },
          action("Check connection", refresh),
          value.installed ? action("Google sign-in guide", () => bridge.openTab("https://github.com/googleworkspace/cli#authentication"))
            : action("Copy install command", () => bridge.copy(install)),
          value.enabled ? action("Turn off account access", async () => draw(await call("integrations.google.configure", { enabled: false }))) : null)));
  }
  function readEssentials() {
    bridge.browser("googleEssentialStatus", {}).then(result => {
      essentials = result ?? {};
      if (current) draw(current);
    }).catch(() => {});
  }
  call("integrations.google.status").then(value => {
    draw(value);
    if (value.enabled) return call("integrations.google.refresh").then(draw);
  }).catch(error => { progress.textContent = errorText(error); });
  readEssentials();
  window.addEventListener("focus", readEssentials);
  const off = onEvent(({ event, data }) => { if (event === "integrations.google.updated" && data) draw(data); });
  window.addEventListener("pagehide", off, { once: true });
  return node;
}

function grammarSettings() {
  const node = el("div", { id: "grammar-settings" });
  const status = el("p", { class: "muted", role: "status" });
  const control = el("input", { type: "checkbox", disabled: true });
  function draw(value) {
    control.checked = value.enabled;
    status.textContent = !value.enabled ? "" : value.running ? "Global shortcut is enabled." : "Lima could not register ⌘G. Turn it off and on to retry.";
  }
  control.addEventListener("change", async () => {
    const enabled = control.checked;
    control.disabled = true;
    try {
      await call("integrations.grammar.configure", { enabled });
      await new Promise(resolve => setTimeout(resolve, 350));
      draw(await call("integrations.grammar.status"));
    } catch (error) { status.textContent = errorText(error); control.checked = !enabled; }
    finally { control.disabled = false; }
  });
  node.append(el("p", { class: "muted", text: "Select text and press ⌘G to check it with your default AI. Lima sends only the selection when you use the shortcut. Lima fixes it in place, and Undo in the popup puts your original back." }),
    el("label", { class: "toggle" }, control, "Enable ⌘G"),
    el("button", { class: "ghost", onclick: () => permissionSheet("accessibility", { onGranted: () => call("integrations.grammar.status").then(draw).catch(() => {}) }) }, "Allow Accessibility…"),
    el("p", { class: "muted", text: "Allow Lima’s grammar helper in macOS Accessibility to read and replace your selection." }), status);
  call("integrations.grammar.status").then(draw).catch(error => { status.textContent = errorText(error); })
    .finally(() => { control.disabled = false; });
  return node;
}
