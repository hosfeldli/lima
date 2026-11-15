/* Lima Search: ⌘T, Zen's New Tab, and ＋ → New Tab open this floating panel
 * over the current page instead of an empty tab. Layout follows the 4.x
 * launcher (Lima mark, 46 px field, 28 px rows, accent "↩ Open" pill, key
 * hints). Every source runs in parallel with its own deadline and paints as
 * it arrives; selection is kept by key so late results don't move it.
 *
 * Sources: navigation (URL-like input), Lima's index (notes, chats, apps,
 * commands), open tabs, history & bookmarks, web suggestions from the
 * default engine (only if the browser's suggestion pref is on), and "Search
 * the web". The Lima mark (or ⌘↩) starts an AI chat tab with the query. */

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
    this.input = el(doc, "input", { id: "lima-search-input", type: "text", placeholder: "Search the web, tabs, notes, apps — or ask Lima", "aria-label": "Lima Search",
      autocomplete: "off", spellcheck: "false" });
    this.mark = el(doc, "button", { id: "lima-search-mark", title: "Ask AI in a new chat (⌘↩)", "aria-label": "Ask AI", onclick: () => this.ask() });
    this.spinner = el(doc, "span", { id: "lima-search-spinner", hidden: true });
    this.results = el(doc, "div", { id: "lima-search-results", role: "listbox" });
    const hint = (keys, label) => el(doc, "span", { class: "lima-s-hint" }, el(doc, "kbd", { text: keys }), label);
    this.panel = el(doc, "div", { id: "lima-search", role: "dialog", "aria-label": "Lima Search" },
      el(doc, "div", { id: "lima-search-field" }, this.mark, this.input, this.spinner, el(doc, "kbd", { id: "lima-search-esc", text: "esc" })),
      this.results,
      el(doc, "div", { id: "lima-search-footer" }, hint("↑↓", "Navigate"), hint("↩", "Open"), hint("⌘↩", "Ask AI"), el(doc, "span", { class: "lima-s-flex" }), hint("esc", "Close")));
    this.scrim = el(doc, "div", { id: "lima-search-scrim", hidden: true, onmousedown: event => { if (event.target === this.scrim) this.close(); } }, this.panel);
    doc.documentElement.append(this.scrim);

    this.input.addEventListener("input", () => this.query());
    this.input.addEventListener("keydown", event => this.onKey(event));
  }

  get isOpen() { return !this.scrim.hidden; }

  open(initial = "") {
    lazy.SearchService.getDefault().then(engine => { this.engineName = engine?.name; }).catch(() => {});
    this.previousFocus = this.doc.activeElement;
    this.scrim.hidden = false;
    this.input.value = initial;
    this.selectedKey = null;
    this.input.focus();
    this.input.select();
    this.query();
  }

  close() {
    if (!this.isOpen) return;
    this.scrim.hidden = true;
    this.generation++;
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
      const url = /^[a-z][\w+.-]*:/i.test(text) && !/^localhost:/i.test(text) ? text : `https://${text}`;
      rows.push({ key: `nav:${url}`, icon: "external", title: text, subtitle: "Open website", action: "Open", run: () => this.openURL(url) });
    }
    rows.push({ key: "web", icon: "search", title: text, subtitle: `Search with ${this.engineName ?? "your search engine"}`, action: "Search", run: () => this.webSearch(text) });
    if (/\?$|^(what|who|why|how|when|where|is|are|can|does|do|should|explain|summarize|write)\b/i.test(text)) {
      rows.splice(rows.length - 1, 0, { key: "ask", icon: "star", title: text, subtitle: "Ask Lima AI", action: "Ask", run: () => this.ask(text) });
    }
    return rows;
  }

  async limaRows(text) {
    const response = await lazy.LimaBridge.request("search.query", { query: text, limit: 12 });
    return response.results
      .filter(r => !["web", "tab"].includes(r.source) && !["agentAsk", "quickAsk", "webSearch", "navigate", "switchTab"].includes(r.action.type))
      .map(r => ({
        key: `lima:${r.key}`, icon: r.action.type === "runCapability" ? "bolt" : SOURCE_ICONS[r.source] ?? "search",
        title: r.title, subtitle: r.subtitle, action: r.action.type === "openApp" ? "Launch" : r.action.type === "runCapability" ? "Run" : "Open",
        run: () => this.runLima(r),
      }));
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
        const run = await lazy.LimaBridge.request("capabilities.run", { id: p.id, input: this.input.value.trim().split(/\s+/).slice(1).join(" ") });
        if (run?.type === "open") return lazy.LimaTabs.openOrFocus(this.win, run.url);
        return lazy.LimaTabs.openOrFocus(this.win, `about:lima?run=${q(p.id)}`);
      }
    }
    return null;
  }

  activate(item, { ask = false } = {}) {
    if (ask) return this.ask();
    this.close();
    Promise.resolve().then(() => item.run()).catch(error => dump(`[lima] search action failed: ${error}\n`));
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
    if (!nodes.length) nodes.push(el(doc, "div", { class: "lima-s-empty", text: "Search the web, your tabs and Lima. Press ⌘↩ or click ✦ to ask AI instead." }));
    this.results.replaceChildren(...nodes);
    this.results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  onKey(event) {
    const index = this.items.findIndex(item => item.key === this.selectedKey);
    if (event.key === "Escape") { event.preventDefault(); this.close(); }
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
  open(win, initial = "") {
    if (!panels.has(win)) panels.set(win, new Panel(win));
    panels.get(win).open(initial);
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
