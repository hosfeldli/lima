/* Lima Search: ⌘T, Zen's New Tab, and ＋ → New Tab open this floating panel
 * over the current page instead of an empty tab. Layout follows the 4.x
 * launcher (Lima mark, 46 px field, 28 px rows, accent "↩ Open" pill, key
 * hints). Every source runs in parallel with its own deadline and paints as
 * it arrives; selection is kept by key so late results don't move it.
 *
 * Sources: navigation (URL-like input), Lima's index (notes, chats, apps,
 * commands), open tabs, history & bookmarks, web suggestions from the
 * default engine (only if the browser's suggestion pref is on), and "Search
 * the web". The Lima mark (or ⌘↩) starts an AI chat tab with the query.
 *
 * Ask Lima answers in place (Quick Ask: no tools, no page or file access).
 * Delegate Task hands the query to the Companion. Commands run once per
 * invocation: the result tab reads the stored result by execution ID.
 * Failures stay in the panel with the query, so nothing fails silently. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SearchSuggestionController: "moz-src:///toolkit/components/search/SearchSuggestionController.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const SOURCE_ICONS = { note: "note", conversation: "chat", report: "context", terminal: "terminal", context: "activity", ai: "spark", app: "app", tool: "bolt", file: "file" };
const GROUP_ORDER = ["Top", "Lima", "Tabs", "Web", "History"];
const MAX_PER_GROUP = { Top: 2, Lima: 6, Tabs: 4, Web: 5, History: 4 };

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function glyph(doc, name, className = "lima-s-glyph") {
  const node = el(doc, "span", { class: className });
  node.style.maskImage = `url("${ICON(name)}")`;
  return node;
}

function looksLikeURL(text) {
  if (/\s/.test(text)) return false;
  return /^[a-z][\w+.-]*:\/\//i.test(text) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text);
}

class Panel {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.items = [];
    this.selectedKey = null;
    this.generation = 0;
    this.suggester = null;
    this.build();
  }

  build() {
    const doc = this.doc;
    this.input = el(doc, "input", { id: "lima-search-input", type: "text", placeholder: "Search the web, find anything, or ask Lima…", "aria-label": "Lima Search",
      autocomplete: "off", spellcheck: "false" });
    this.mark = el(doc, "button", { id: "lima-search-mark", title: "Ask AI in a new chat (⌘↩)", "aria-label": "Ask AI", onclick: () => this.ask() });
    this.spinner = el(doc, "span", { id: "lima-search-spinner", hidden: true });
    // What a Quick Ask shares beyond the question (a page or a selection).
    this.contextChip = el(doc, "div", { id: "lima-search-context", hidden: true });
    this.results = el(doc, "div", { id: "lima-search-results", role: "listbox" });
    this.status = el(doc, "div", { id: "lima-search-status", role: "status", hidden: true });
    const hint = (key, label) => el(doc, "span", {}, el(doc, "kbd", { text: key }), ` ${label}`);
    this.panel = el(doc, "div", { id: "lima-search", role: "dialog", "aria-label": "Lima Search" },
      el(doc, "div", { id: "lima-search-field" }, this.mark, this.input, this.spinner,
        el(doc, "button", { id: "lima-search-esc", title: "Close search (Esc)", "aria-label": "Close search", onclick: () => this.close() }, "×")),
      this.contextChip, this.status, this.results,
      el(doc, "div", { id: "lima-search-foot", "aria-hidden": "true" }, hint("↩", "Select"), hint("⌘↩", "AI Chat"), hint("esc", "Close")));
    this.scrim = el(doc, "div", { id: "lima-search-scrim", hidden: true, onpointerdown: event => { if (event.target === this.scrim) this.close(); } }, this.panel);
    doc.documentElement.append(this.scrim);

    this.input.addEventListener("input", () => { this.answering = null; this.clearStatus(); this.query(); });
    this.input.addEventListener("keydown", event => this.onKey(event));
  }

  get isOpen() { return !this.scrim.hidden; }

  /** `context` (optional): { kind: "page" | "selection", title, url, text }.
   * The chip says exactly what Quick Ask will share. */
  open(initial = "", { context = null, ask = null } = {}) {
    lazy.SearchService.getDefault().then(engine => { this.engineName = engine?.name; }).catch(() => {});
    this.previousFocus = this.doc.activeElement;
    this.scrim.hidden = false;
    this.input.value = initial;
    this.selectedKey = null;
    this.answering = null;
    this.running = false;
    this.clearStatus();
    this.setContext(context);
    this.input.focus();
    this.input.select();
    if (ask) this.quickAsk(ask);
    else this.query();
  }

  setContext(context) {
    this.context = context;
    const doc = this.doc;
    this.contextChip.hidden = !context;
    if (!context) { this.contextChip.replaceChildren(); return; }
    const what = context.kind === "selection" ? "the selected text, the page title and its URL" : "this page's title and URL";
    this.contextChip.replaceChildren(el(doc, "span", { text: `Sharing ${what}: ` }), el(doc, "strong", { text: context.title || context.url }),
      el(doc, "button", { class: "lima-s-chip-remove", title: "Don't share", "aria-label": "Don't share", onmousedown: event => event.preventDefault(),
        onclick: () => { this.setContext(null); this.input.focus(); this.query(); } }, "×"));
  }

  /** The question as sent, with only the context the chip names. */
  prompt(text) {
    const context = this.context;
    if (!context) return text;
    const page = `Page: ${context.title || "(untitled)"}\nURL: ${context.url}`;
    if (context.kind === "selection") return `${page}\n\nSelected text:\n"""\n${context.text.slice(0, 12000)}\n"""\n\n${text}`;
    return `${page}\n\n${text}`;
  }

  close() {
    if (!this.isOpen) return;
    this.scrim.hidden = true;
    this.generation++;
    this.answering = null;
    this.setContext(null);
    this.suggester?.stop();
    try { this.win.gBrowser.selectedBrowser.focus(); } catch {}
  }

  // MARK: Sources

  query() {
    const text = this.input.value.trim();
    const generation = ++this.generation;
    this.groups = new Map();
    this.pending = 0;
    const add = (group, rows) => {
      if (generation !== this.generation) return;
      this.groups.set(group, [...(this.groups.get(group) ?? []), ...rows].slice(0, MAX_PER_GROUP[group]));
      this.paint();
    };
    const run = (fn, timeout = 1500) => {
      this.pending++;
      this.spinner.hidden = false;
      const deadline = new Promise(resolve => this.win.setTimeout(resolve, timeout));
      Promise.race([Promise.resolve().then(fn), deadline]).catch(() => {}).finally(() => {
        if (generation !== this.generation) return;
        if (--this.pending === 0) this.spinner.hidden = true;
      });
    };

    if (!text) {
      this.recent(add);
      this.paint();
      return;
    }
    add("Top", this.topRows(text));
    run(() => this.limaRows(text).then(rows => add("Lima", rows)));
    run(() => add("Tabs", this.tabRows(text)));
    run(() => this.webRows(text).then(rows => add("Web", rows)), 2500);
    run(() => this.historyRows(text).then(rows => add("History", rows)));
  }

  topRows(text) {
    const rows = [];
    if (looksLikeURL(text)) {
      const url = /^https?:\/\//i.test(text) ? text : /^(localhost|127\.0\.0\.1)(?=[:/]|$)/i.test(text) ? `http://${text}` : `https://${text}`;
      rows.push({ key: `nav:${url}`, icon: "external", title: text, subtitle: url, action: "Open Website", run: () => this.openURL(url) });
    }
    rows.push({ key: "web", icon: "search", title: text, subtitle: `Search with ${this.engineName ?? "your search engine"}`, action: "Search Web", run: () => this.webSearch(text) });
    if (this.context) return [{ key: "ask", icon: "star", title: text, subtitle: "Ask Lima about what you're sharing", action: "Ask Lima", inline: true, run: () => this.quickAsk(text) }, ...rows];
    if (looksLikeURL(text) || lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) return rows;
    const words = text.split(/\s+/).length;
    const question = /\?$|^(what|who|why|how|when|where|which|is|are|can|could|does|do|did|should|would|explain|define|summarize|compare)\b/i.test(text);
    const task = /^(fix|build|create|make|add|implement|refactor|research|plan|draft|write|update|organize|review|set up|debug|find and|clean up|migrate|prepare)\b/i.test(text);
    const ask = { key: "ask", icon: "star", title: text, subtitle: "Quick answer, no page or file access", action: "Ask Lima", inline: true, run: () => this.quickAsk(text) };
    const delegate = { key: "delegate", icon: "workspace", title: text, subtitle: "Hand off to an agent in a workspace", action: "Delegate Task", run: () => this.delegate(text) };
    if (task) rows.splice(0, 0, delegate, ask);
    else if (question) rows.splice(rows.length - 1, 0, ask, ...(words > 6 ? [delegate] : []));
    else if (words > 3) rows.push(ask, delegate);
    return rows;
  }

  async limaRows(text) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) return [];
    const [response, workspaces] = await Promise.all([
      lazy.LimaBridge.request("search.query", { query: text, limit: 18 }),
      lazy.LimaBridge.request("workspace.list").catch(() => []),
    ]);
    const query = text.toLowerCase();
    const projects = workspaces.filter(workspace => !workspace.parentID && workspace.conversationID && workspace.name.toLowerCase().includes(query))
      .map(workspace => ({ key: `workspace:${workspace.id}`, icon: "workspace", title: workspace.name, subtitle: "Workspace",
        action: "Open Workspace", run: () => lazy.LimaTabs.openOrFocus(this.win, `about:lima?chat=${encodeURIComponent(workspace.conversationID)}`) }));
    return [...projects, ...response.results
      .filter(r => !["web", "tab"].includes(r.source) && !["agentAsk", "quickAsk", "webSearch", "navigate", "switchTab"].includes(r.action.type))
      .map(r => ({
        key: `lima:${r.key}`, icon: r.action.type === "runCapability" ? "bolt" : SOURCE_ICONS[r.source] ?? "search",
        title: r.title, subtitle: r.subtitle, action: r.action.type === "openApp" ? "Launch" : r.action.type === "runCapability" ? "Run Command" : "Open",
        command: r.action.type === "runCapability", run: () => this.runLima(r),
      }))];
  }

  tabRows(text) {
    const lower = text.toLowerCase();
    return [...this.win.gBrowser.tabs]
      .filter(tab => !tab.hasAttribute("zen-empty-tab") && !tab.selected)
      .filter(tab => tab.label.toLowerCase().includes(lower) || (tab.linkedBrowser?.currentURI?.spec ?? "").toLowerCase().includes(lower))
      .map(tab => ({ key: `tab:${tab.linkedPanel ?? tab.label}`, icon: "tab", title: tab.label, subtitle: tab.group?.label ? `Tab in ${tab.group.label}` : "Open tab",
        action: "Switch", run: () => { this.win.gBrowser.selectedTab = tab; } }));
  }

  async webRows(text) {
    if (!Services.prefs.getBoolPref("browser.search.suggest.enabled", true)) return [];
    const engine = await lazy.SearchService.getDefault();
    this.engineName = engine?.name;
    if (!engine?.supportsResponseType?.("application/x-suggestions+json")) return [];
    this.suggester?.stop();
    this.suggester = new lazy.SearchSuggestionController();
    const result = await this.suggester.fetch({ searchString: text, inPrivateBrowsing: lazy.PrivateBrowsingUtils.isWindowPrivate(this.win), engine,
      maxLocalResults: 0, maxRemoteResults: 6 });
    return (result?.remote ?? []).filter(entry => entry.value && entry.value.toLowerCase() !== text.toLowerCase())
      .map(entry => ({ key: `sugg:${entry.value}`, icon: "web", title: entry.value, subtitle: engine.name, action: "Search", run: () => this.webSearch(entry.value) }));
  }

  async historyRows(text) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) return [];
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const like = `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    const rows = await db.executeCached(
      `SELECT h.url, h.title, (SELECT 1 FROM moz_bookmarks b WHERE b.fk = h.id LIMIT 1) AS bookmarked
         FROM moz_places h
        WHERE h.hidden = 0 AND h.url NOT LIKE 'about:lima%' AND (h.title LIKE :like ESCAPE '\\' OR h.url LIKE :like ESCAPE '\\')
        ORDER BY bookmarked DESC, h.frecency DESC LIMIT 6`, { like });
    return rows.map(row => {
      const url = row.getResultByName("url");
      const bookmarked = !!row.getResultByName("bookmarked");
      return { key: `hist:${url}`, icon: bookmarked ? "bookmark" : "history", title: row.getResultByName("title") || url, subtitle: url,
        action: "Open", run: () => this.openURL(url) };
    });
  }

  /** Empty query: what you were last doing in Lima. */
  recent(add) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)) return;
    Promise.all([lazy.LimaBridge.request("notes.list"), lazy.LimaBridge.request("chat.list")]).then(([notes, chats]) => {
      const rows = [
        ...notes.filter(n => !n.trashed).map(n => ({ when: n.modifiedAt, key: `note:${n.id}`, icon: n.kind === "canvas" ? "canvas" : "note", title: n.title || "Untitled",
          subtitle: "Note", url: `about:lima?note=${encodeURIComponent(n.id)}` })),
        ...chats.map(c => ({ when: c.updatedAt, key: `chat:${c.id}`, icon: "chat", title: c.title, subtitle: c.running ? "AI chat · working" : "AI chat",
          url: `about:lima?chat=${encodeURIComponent(c.id)}` })),
      ].sort((a, b) => b.when - a.when).slice(0, 6);
      add("Lima", rows.map(row => ({ ...row, action: "Open", run: () => lazy.LimaTabs.openOrFocus(this.win, row.url) })));
    }).catch(() => {});
  }

  // MARK: Actions

  openURL(url) {
    if (!/^https?:\/\//i.test(url)) return;
    const gBrowser = this.win.gBrowser;
    const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    gBrowser.selectedTab = tab;
  }

  async webSearch(text) {
    const engine = await lazy.SearchService.getDefault();
    const submission = engine.getSubmission(text);
    this.openURL(submission.uri.spec);
  }

  ask(text = this.input.value.trim()) {
    this.close();
    const url = text ? `about:lima?chat=new&prompt=${encodeURIComponent(text)}` : "about:lima?chat=new";
    lazy.LimaTabs.openOrFocus(this.win, url);
  }

  async runLima(result) {
    lazy.LimaBridge.request("search.select", { key: result.key }).catch(() => {});
    const p = result.action.payload ?? {};
    const q = encodeURIComponent;
    switch (result.action.type) {
      case "openNote": return lazy.LimaTabs.openOrFocus(this.win, `about:lima?note=${q(p.id)}`);
      case "openConversation": return lazy.LimaTabs.openOrFocus(this.win, `about:lima?chat=${q(p.id)}`);
      case "openReport": return lazy.LimaTabs.openOrFocus(this.win, `about:lima?view=context&report=${q(p.id)}`);
      case "openContext": return lazy.LimaTabs.openOrFocus(this.win, "about:lima?view=activity");
      case "openApp": return lazy.LimaBridge.request("system.openApp", { path: p.path });
      case "copyText": return Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(p.text ?? result.title);
      case "runCapability": {
        const input = this.input.value.trim().split(/\s+/).slice(1).join(" ");
        const capability = (await this.manifest()).find(item => item.id === p.id);
        // A command that needs input it wasn't given opens its form instead.
        if (capability?.input?.required && !input) return lazy.LimaTabs.openOrFocus(this.win, `about:lima?run=${q(p.id)}`);
        const executionId = Services.uuid.generateUUID().toString().slice(1, -1);
        const run = await lazy.LimaBridge.request("capabilities.run", { id: p.id, input, executionId });
        if (run?.type === "open") return lazy.LimaTabs.openOrFocus(this.win, run.url);
        // The result tab shows this execution; opening or refreshing it never runs the command again.
        return lazy.LimaTabs.openOrFocus(this.win, `about:lima?run=${q(p.id)}&execution=${q(executionId)}${input ? `&input=${q(input)}` : ""}`);
      }
    }
    return null;
  }

  manifest() {
    this.capabilities ??= lazy.LimaBridge.request("capabilities.list").catch(() => { this.capabilities = null; return []; });
    return this.capabilities;
  }

  /** One activation per gesture. Inline actions keep the panel; commands
   * keep it until they finish so a failure can be shown where it started. */
  async activate(item, { ask = false } = {}) {
    if (ask) return this.ask();
    if (this.running) return;
    if (item.inline) return item.run();
    this.running = true;
    const generation = this.generation;
    if (item.command) this.setStatus("busy", "Running command…");
    else this.close();
    try {
      await item.run();
      if (item.command && generation === this.generation) this.close();
    } catch (error) {
      dump(`[lima] search action failed: ${error.message ?? error}\n`);
      this.fail(item, error);
    } finally {
      this.running = false;
    }
  }

  // MARK: Inline status, Quick Ask and delegation

  clearStatus() {
    this.status.hidden = true;
    this.status.replaceChildren();
    delete this.status.dataset.tone;
  }

  setStatus(tone, title, detail = "", ...actions) {
    const doc = this.doc;
    this.status.dataset.tone = tone;
    this.status.replaceChildren(el(doc, "div", { class: "lima-s-status-copy" }, el(doc, "strong", { text: title }), detail ? el(doc, "span", { text: detail }) : null),
      actions.length ? el(doc, "div", { class: "lima-s-status-actions" }, ...actions) : null);
    this.status.hidden = false;
  }

  button(label, onclick, primary = false) {
    return el(this.doc, "button", { class: primary ? "lima-s-button primary" : "lima-s-button", onclick, onmousedown: event => event.preventDefault() }, label);
  }

  /** Reopens the panel if needed and explains the failure next to the query. */
  fail(item, error) {
    if (!this.isOpen) {
      const query = this.input.value;
      this.scrim.hidden = false;
      this.input.value = query;
      this.query();
    }
    this.setStatus("bad", item.command ? "Command failed" : "Couldn't complete this action.", String(error?.message ?? error),
      this.button("Retry", () => { this.clearStatus(); this.activate(item); }, true),
      item.command ? this.button("View Details", () => { this.close(); lazy.LimaTabs.openOrFocus(this.win, "about:lima?view=activity&tab=commands"); }) : null);
    this.input.focus();
  }

  /** Streams a Quick Ask answer into the panel. Closing ignores the rest. */
  async quickAsk(text) {
    const doc = this.doc;
    const generation = ++this.generation;
    const requestId = Services.uuid.generateUUID().toString().slice(1, -1);
    const provider = Services.prefs.getStringPref("lima.agent.provider", "claude");
    const model = Services.prefs.getStringPref(`lima.agent.model.${provider}`, "default");
    this.answering = { text, requestId };
    this.items = [];
    this.spinner.hidden = false;
    const answer = el(doc, "div", { class: "lima-s-answer-text", "aria-live": "polite" });
    const actions = el(doc, "div", { class: "lima-s-answer-actions", hidden: true });
    const meta = el(doc, "span", { class: "lima-s-answer-meta", text: "Asking Lima…" });
    this.clearStatus();
    this.results.replaceChildren(el(doc, "div", { class: "lima-s-answer", role: "region", "aria-label": "Lima's answer" },
      el(doc, "div", { class: "lima-s-answer-question", text: text }), answer, el(doc, "div", { class: "lima-s-answer-foot" }, meta, actions)));
    let streamed = "";
    const current = () => generation === this.generation && this.answering?.requestId === requestId;
    const off = lazy.LimaBridge.onEvent(message => {
      if (message.event !== "quickAsk.delta" || message.data?.requestId !== requestId || !current()) return;
      streamed += message.data.text;
      answer.textContent = streamed;
    });
    const done = (final, ...buttons) => {
      off();
      if (!current()) return;
      this.spinner.hidden = true;
      if (final !== undefined) answer.textContent = final;
      actions.replaceChildren(...buttons);
      actions.hidden = false;
    };
    const asked = this.prompt(text);
    const chat = () => this.button("Continue in Chat", () => this.ask(asked));
    try {
      const result = await lazy.LimaBridge.request("quickAsk", { requestId, prompt: this.prompt(text), provider, ...(model !== "default" ? { model } : {}) });
      if (result?.error) {
        meta.textContent = "Couldn't complete this action.";
        done(undefined, this.button("Retry", () => this.quickAsk(text), true), chat(),
          this.button("Open Settings", () => { this.close(); lazy.LimaTabs.openOrFocus(this.win, "about:lima?view=integrations&section=agents"); }));
        answer.textContent = result.error.message || "Lima couldn't get an answer from the AI provider.";
        answer.dataset.tone = "bad";
        return;
      }
      meta.textContent = "Quick Ask · no page or file access";
      const final = result?.text ?? streamed;
      done(final, this.button("Copy", () => {
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(final);
        meta.textContent = "Copied";
      }, true), chat(), this.button("Close", () => this.close()));
    } catch (error) {
      meta.textContent = "Couldn't complete this action.";
      answer.textContent = String(error?.message ?? error);
      answer.dataset.tone = "bad";
      done(undefined, this.button("Retry", () => this.quickAsk(text), true), chat());
    }
  }

  /** Delegate Task: the Companion receives the query as its draft. */
  delegate(text) {
    this.win.dispatchEvent(new this.win.CustomEvent("LimaAssistantOpen", { detail: { draft: text } }));
  }

  // MARK: View

  paint() {
    const doc = this.doc;
    this.items = GROUP_ORDER.flatMap(group => (this.groups?.get(group) ?? []).map(item => ({ ...item, group })));
    if (!this.items.some(item => item.key === this.selectedKey)) this.selectedKey = this.items[0]?.key ?? null;
    const nodes = [];
    let group = null;
    for (const item of this.items) {
      if (item.group !== group) {
        group = item.group;
        if (group !== "Top") nodes.push(el(doc, "div", { class: "lima-s-group", text: group === "Lima" ? (this.input.value.trim() ? "In Lima" : "Recent") : group === "Web" ? "Suggestions" : group }));
      }
      const selected = item.key === this.selectedKey;
      nodes.push(el(doc, "div", { class: "lima-s-row", role: "option", "aria-selected": String(selected), "data-key": item.key,
        onmousemove: () => { if (this.selectedKey !== item.key) { this.selectedKey = item.key; this.paint(); } },
        onmousedown: event => { event.preventDefault(); this.activate(item); } },
        el(doc, "span", { class: "lima-s-icon" }, glyph(doc, item.icon)),
        el(doc, "span", { class: "lima-s-text" }, el(doc, "span", { class: "lima-s-title", text: item.title }), item.subtitle ? el(doc, "span", { class: "lima-s-sub", text: item.subtitle }) : null),
        selected ? el(doc, "span", { class: "lima-s-action", text: `↩ ${item.action}` }) : null));
    }
    if (!nodes.length) nodes.push(el(doc, "div", { class: "lima-s-empty", text: this.input.value.trim() ? "No matches" : "Search tabs, notes, workspaces, and the web" }));
    this.results.replaceChildren(...nodes);
    this.results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  onKey(event) {
    const index = this.items.findIndex(item => item.key === this.selectedKey);
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.answering) { this.answering = null; this.generation++; this.spinner.hidden = true; this.query(); }
      else this.close();
    }
    else if (this.answering && event.key === "Enter" && !event.metaKey) { event.preventDefault(); }
    else if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      this.selectedKey = this.items[Math.min(this.items.length - 1, index + 1)]?.key ?? this.selectedKey;
      this.paint();
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      this.selectedKey = this.items[Math.max(0, index - 1)]?.key ?? this.selectedKey;
      this.paint();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey) this.ask();
      else if (this.items[index]) this.activate(this.items[index]);
    }
  }
}

const panels = new WeakMap();

export const LimaSearchPanel = {
  open(win, initial = "", options = {}) {
    if (!panels.has(win)) panels.set(win, new Panel(win));
    panels.get(win).open(initial, options);
  },

  toggle(win) {
    const panel = panels.get(win);
    if (panel?.isOpen) panel.close();
    else this.open(win);
  },

  /** ⌘T and Zen's "New Tab" become Lima Search. */
  install(win) {
    const ui = win.gZenUIManager;
    if (!ui?.handleNewTab || ui.limaWrapped) return;
    const original = ui.handleNewTab.bind(ui);
    ui.handleNewTab = (werePassedURL, searchClipboard, where) => {
      if (!werePassedURL && !searchClipboard && where === "tab" && Services.prefs.getBoolPref("lima.search.replaceNewTab", true)) {
        LimaSearchPanel.open(win);
        return true;
      }
      return original(werePassedURL, searchClipboard, where);
    };
    ui.limaWrapped = true;
  },
};
