/* Smaller Lima surfaces, each its own tab. */
import { bar, bridge, call, el, errorText, markdown, onEvent, prefs, relativeTime, setPage } from "./lib.js";

const page = (...children) => el("div", { class: "page narrow" }, ...children);
const card = (title, ...children) => el("section", { class: "card" }, title ? el("h2", { text: title }) : null, ...children);
const fail = (node, error) => node.replaceChildren(el("p", { class: "error", text: errorText(error) }));

// MARK: Home

export function renderHome(app) {
  setPage("Lima");
  const links = [
    ["Notes", "about:lima?view=notes", "note"], ["AI Chat", "about:lima?view=chat", "chat"], ["Terminal", "about:lima?view=terminal", "terminal"],
    ["Agents", "about:lima?view=agents", "agents"], ["Context Shelf", "about:lima?view=context", "context"],
    ["Screenshot Studio", "about:lima?view=studio", "studio"], ["Audio", "about:lima?view=audio", "audio"],
    ["Integrations & Settings", "about:lima?view=integrations", "integrations"],
  ];
  app.replaceChildren(bar("Lima"), el("div", { class: "prism-rule" }), page(
    el("p", { class: "muted", text: "Type in the address bar to search notes, chats, terminal history, reports and Lima tools. Every Lima surface opens as a tab." }),
    el("ul", { class: "list" }, links.map(([label, url, icon]) => el("li", { class: "clickable", onclick: () => bridge.openTab(url) },
      el("img", { src: `resource://lima-ui/icons/${icon}.svg`, width: 18, height: 18, alt: "" }), el("span", { class: "grow", text: label }))))));
}

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

// MARK: Tool results

export async function renderTool(app, tool, input) {
  setPage("Lima command", "tool");
  const out = el("div");
  app.replaceChildren(bar(tool), el("div", { class: "prism-rule" }), page(out));
  if (tool === "copy") { bridge.copy(input); out.replaceChildren(el("p", { text: "Copied to clipboard." }), el("pre", { text: input })); return; }
  if (tool === "app.open") {
    try { await call("system.openApp", { path: input }); out.replaceChildren(el("p", { text: `Opened ${input.split("/").pop()}` })); } catch (error) { fail(out, error); }
    return;
  }
  out.replaceChildren(el("p", { class: "muted", text: "Running…" }));
  try {
    const result = await call("tools.run", { tool, input });
    setPage(tool, "tool");
    renderToolResult(out, result, { tool, input });
  } catch (error) {
    fail(out, error);
  }
}

function renderToolResult(out, result, { tool }) {
  switch (result.type) {
    case "text":
      out.replaceChildren(el("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "var(--mono)" }, text: result.text }),
        result.copy ? el("button", { class: "primary", onclick: () => bridge.copy(result.text) }, "Copy") : null);
      if (result.copy) bridge.copy(result.text);
      break;
    case "list":
      out.replaceChildren(el("ul", { class: "list" }, result.items.map(item => el("li", {
        class: "clickable", onclick: () => /^https?:/.test(item.value) ? bridge.openTab(item.value) : bridge.copy(item.value),
      }, el("strong", { text: item.title }), el("span", { class: "grow muted", text: item.subtitle })))));
      if (!result.items.length) out.append(el("p", { class: "muted", text: "No results." }));
      break;
    case "audioOutputs":
      renderAudioOutputs(out, result.items);
      break;
    case "volume":
      out.replaceChildren(el("p", { text: `Volume ${Math.round(result.value)}%` }));
      break;
    case "capture":
      bridge.openTab("about:lima?view=studio");
      out.replaceChildren(el("p", { text: "Captured — opened in Screenshot Studio." }));
      break;
    case "report":
      out.replaceChildren(markdown(result.markdown));
      break;
    case "browser":
      handleBrowserTool(result.tool, result.input, out).catch(error => fail(out, error));
      break;
    default:
      out.replaceChildren(el("pre", { text: JSON.stringify(result, null, 2) }));
  }
  void tool;
}

async function handleBrowserTool(tool, input, out) {
  switch (tool) {
    case "notes.new":
    case "notes.newCanvas": {
      const note = await bridge.browser("createNote", { kind: tool === "notes.new" ? "classic" : "canvas", title: input });
      bridge.replaceURL(`about:lima?note=${encodeURIComponent(note.id)}`);
      break;
    }
    case "terminal.new": bridge.replaceURL("about:lima?view=terminal"); break;
    case "chat.new": bridge.replaceURL(`about:lima?chat=new${input ? `&prompt=${encodeURIComponent(input)}` : ""}`); break;
    default: out.replaceChildren(el("p", { class: "error", text: `Unknown command ${tool}` }));
  }
}

// MARK: Agents

export async function renderAgents(app) {
  setPage("Agents", "agents");
  const clis = el("div"), sessions = el("div"), terminals = el("div");
  app.replaceChildren(bar("Agents", el("button", { onclick: () => bridge.openTab("about:lima?chat=new") }, "New Chat")),
    el("div", { class: "prism-rule" }), page(card("Installed CLIs", clis), card("Conversations", sessions), card("Terminals", terminals),
      el("p", { class: "muted", text: "External agents (Codex, Claude Code, OpenCode) can use Lima through its MCP server — see Integrations." })));

  call("agents.discover").then(list => clis.replaceChildren(el("ul", { class: "list" }, list.map(a => el("li", {},
    el("strong", { text: a.provider, style: { textTransform: "capitalize", minWidth: "80px" } }),
    el("span", { class: "grow muted", text: a.executablePath ?? a.diagnostic ?? "" }),
    el("span", { class: `badge ${a.status === "available" ? "ok" : "warn"}`, text: a.version ? `v${a.version}` : a.status.replaceAll("_", " ") })))))).catch(e => fail(clis, e));

  const drawSessions = () => call("chat.list").then(list => sessions.replaceChildren(list.length ? el("ul", { class: "list" }, list.slice(0, 20).map(c => el("li", {
    class: "clickable", onclick: () => bridge.openTab(`about:lima?chat=${encodeURIComponent(c.id)}`) },
    el("span", { class: "grow", text: c.title }), el("span", { class: "badge", text: c.provider }),
    c.running ? el("span", { class: "badge warn", text: "running" }) : el("span", { class: "muted", text: relativeTime(c.updatedAt) })))) : el("p", { class: "muted", text: "No conversations yet." }))).catch(e => fail(sessions, e));

  const drawTerminals = () => call("terminal.list").then(list => terminals.replaceChildren(list.length ? el("ul", { class: "list" }, list.map(t => el("li", {
    class: "clickable", onclick: () => bridge.openTab(`about:lima?terminal=${encodeURIComponent(t.id)}`) },
    el("code", { class: "grow", text: t.cwd }), el("span", { class: "badge", text: t.state }),
    t.owner !== "user" ? el("span", { class: "badge warn", text: t.owner }) : null,
    t.pendingRequests.length ? el("span", { class: "badge warn", text: `${t.pendingRequests.length} request` }) : null))) : el("p", { class: "muted", text: "No running terminals." }))).catch(e => fail(terminals, e));

  drawSessions(); drawTerminals();
  onEvent(m => { if (m.event === "chat.updated") drawSessions(); if (m.event === "terminal.state") drawTerminals(); });
}

// MARK: Context Shelf

export async function renderContext(app, reportId) {
  setPage("Context Shelf", "context");
  const reportsNode = el("div"), eventsNode = el("div"), settingsNode = el("div"), viewer = el("div");
  app.replaceChildren(bar("Context Shelf",
    el("button", { onclick: async () => { const r = await call("context.generateReport"); showReport(r); drawReports(); } }, "Generate report now")),
    el("div", { class: "prism-rule" }),
    page(viewer, card("Weekly reports · Fridays 3:00 PM", reportsNode), card("Recent activity", eventsNode), card("Privacy & retention", settingsNode)));

  let reports = [];
  function showReport(report) {
    viewer.replaceChildren(card(null, el("div", { class: "row" }, el("span", { class: "grow muted", text: `Generated ${new Date(report.generatedAt).toLocaleString()}` }),
      el("button", { class: "ghost", onclick: () => viewer.replaceChildren() }, "Close")), markdown(report.markdown)));
    setPage(`Report ${report.id}`, "context");
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
      const icons = { app: "▣", browser: "◍", terminal: "›", git: "⑂", agent: "✦", note: "✎", media: "♪", meeting: "◷", task: "✓", report: "▤" };
      eventsNode.replaceChildren(events.length ? el("ul", { class: "list" }, events.map(e => el("li", {},
        el("span", { text: icons[e.kind] ?? "•", style: { width: "16px", textAlign: "center" } }),
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

  drawReports(); drawEvents(); drawSettings();
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
  const volume = el("input", { type: "range", min: 0, max: 100, step: 1, style: { width: "100%" }, "aria-label": "Volume" });
  app.replaceChildren(bar("Audio"), el("div", { class: "prism-rule" }), page(card("Output", outputs, volume), card("Now playing", nowPlaying)));

  const drawOutputs = () => call("audio.outputs").then(items => renderAudioOutputs(outputs, items)).catch(e => fail(outputs, e));
  call("audio.volume").then(v => { volume.value = Math.round(v * 100); });
  volume.addEventListener("input", () => call("audio.volume", { value: volume.value / 100 }).catch(e => fail(outputs, e)));

  function drawNowPlaying(item) {
    const control = action => el("button", { onclick: () => call("media.control", { action }).catch(e => nowPlaying.append(el("p", { class: "error", text: errorText(e) }))) });
    nowPlaying.replaceChildren(
      item?.title ? el("p", {}, el("strong", { text: item.title }), el("span", { class: "muted", text: ` — ${item.artist} · ${item.player} (${item.state})` })) : el("p", { class: "muted", text: "Nothing playing in Spotify or Music." }),
      el("div", { class: "row" }, Object.assign(control("previous"), { textContent: "⏮" }), Object.assign(control("playpause"), { textContent: "⏯" }),
        Object.assign(control("next"), { textContent: "⏭" }), Object.assign(control("dj"), { textContent: "Spotify DJ" })));
  }
  call("media.nowPlaying").then(drawNowPlaying).catch(() => drawNowPlaying(null));
  onEvent(m => { if (m.event === "media.nowPlaying") drawNowPlaying(m.data); });
  drawOutputs();
}

function renderAudioOutputs(node, items) {
  node.replaceChildren(el("ul", { class: "list" }, items.map(d => el("li", {
    class: "clickable", onclick: async () => renderAudioOutputs(node, await call("audio.setOutput", { id: d.id })),
  }, el("span", { text: d.isDefault ? "●" : "○" }), el("span", { class: "grow", text: d.name }), el("span", { class: "badge", text: d.transport })))));
  if (items.some(d => d.isDefault && d.transport === "bluetooth")) {
    node.append(el("p", { class: "muted", text: "Bluetooth headsets may switch to lower-quality audio while their microphone is in use. Pick a different input to keep full playback quality." }));
  }
}

// MARK: Integrations & settings

export async function renderIntegrations(app) {
  setPage("Integrations & Settings", "integrations");
  const services = el("div"), mcp = el("div"), storage = el("div"), github = el("div");
  app.replaceChildren(bar("Integrations & Settings"), el("div", { class: "prism-rule" }),
    page(card("Services", services, github), card("MCP server for external agents", mcp), card("Encrypted storage", storage),
      card("Search", el("button", { onclick: async () => { await call("search.resetLearning"); alert("Learned ranking reset."); } }, "Reset learned ranking"),
        " ", el("button", { onclick: async () => { const n = await call("search.rebuild", { source: "app" }); alert(`Index rebuilt (${n} items).`); } }, "Rebuild app index"))));

  call("integrations.status").then(list => services.replaceChildren(el("ul", { class: "list" }, list.map(s => el("li", {},
    el("strong", { text: s.name, style: { minWidth: "220px" } }), el("span", { class: "grow muted", text: s.detail }),
    el("span", { class: `badge ${s.state === "connected" ? "ok" : s.state === "needs_setup" ? "warn" : ""}`, text: s.state.replaceAll("_", " ") }),
    s.id === "github" && s.state === "connected" ? el("button", { onclick: () => bridge.openTab("about:lima?tool=github.inbox") }, "Open inbox") : null))))).catch(e => fail(services, e));

  async function drawMCP() {
    const scopes = new Set(await call("mcp.grants.get"));
    const all = [["notes:read", "Read notes"], ["search:read", "Search Lima"], ["context:read", "Read activity & reports"],
      ["notes:write", "Create and edit notes (undoable agent edits)"], ["terminal:control", "Type in terminals after you grant keyboard control"]];
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
      el("h2", { text: "Recovery key", style: { marginTop: "14px" } }),
      el("p", { class: "muted", text: "Without a recovery key, losing this Mac's Keychain makes your Lima data unrecoverable." }),
      el("div", { class: "row" }, passphrase, el("button", { onclick: async () => {
        try { const r = await call("storage.exportRecoveryKey", { passphrase: passphrase.value }); passphrase.value = ""; alert(`Recovery key saved to ${r.path}. Keep it and the passphrase somewhere safe.`); }
        catch (error) { alert(errorText(error)); }
      } }, "Export recovery key")));
  }
  drawStorage().catch(e => fail(storage, e));
  void github;
}
