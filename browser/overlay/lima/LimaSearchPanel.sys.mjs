/* Lima Universal Search (docs/spec/universal-search.md). ⌘T, Zen's New Tab
 * and ＋ → New Tab open one floating panel over the current page: an input,
 * a short list of results and a footer of key hints. The page underneath is
 * never resized.
 *
 * Best Match is decided synchronously from the query (open the URL, or search
 * with the selected engine), so Enter is predictable. Tabs, bookmarks,
 * history, Lima's index (notes, chats, apps, commands, files) and workspaces
 * run in parallel, each with its own deadline, and merge into "Your Browser &
 * Lima". Web suggestions arrive last, below everything. Selection is kept by
 * key, and once the user moves it the visible rows are frozen (see
 * ui/search-ranking.sys.mjs).
 *
 * AI is only ever offered: Ask Lima answers in place (Quick Ask: no tools, no
 * page or file access unless the context chip says so), Delegate Task puts
 * the query in the Companion's draft, ⌘↩ opens it in AI Chat. Commands run
 * once per invocation: the result tab reads the stored result by execution
 * ID. Failures stay in the panel with the query. */

import { INITIAL_LIMIT, ResultSet, TARGETS, aiSuggestion, navigationURL, parseQuery, recentDestinations } from "resource://lima/ui/search-ranking.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaAppearance: "resource://lima/LimaAppearance.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  LimaUsage: "resource://lima/LimaUsage.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SearchSuggestionController: "moz-src:///toolkit/components/search/SearchSuggestionController.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const SOURCE = {
  note: { kind: "note", icon: "note" }, conversation: { kind: "chat", icon: "chat" }, report: { kind: "other", icon: "context" },
  terminal: { kind: "other", icon: "terminal" }, context: { kind: "other", icon: "activity" }, ai: { kind: "other", icon: "spark" },
  app: { kind: "app", icon: "app" }, tool: { kind: "command", icon: "bolt" }, file: { kind: "file", icon: "file" },
};
const TARGET_LABEL = { page: "This page", tabs: "Tabs", workspace: "Workspaces", notes: "Notes", files: "Files" };
// The scope bar under the input, in order (⌘1–⌘6).
const SCOPES = [[null, "All", "search"], ["tabs", "Tabs", "tab"], ["notes", "Notes", "note"], ["files", "Files", "file"],
  ["workspace", "Workspaces", "workspace"], ["page", "This page", "web"]];
const clipboard = () => Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper);

/** "now", "5m", "3h", "2d", "Nov 3": how long ago, compactly. */
function ago(when, now = Date.now()) {
  if (!when) return "";
  const minutes = Math.round((now - when) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / 1440)}d`;
  return new Date(when).toLocaleDateString([], { month: "short", day: "numeric" });
}
const EMPTY_HINT = "Search the web, open something, or ask Lima.";
const MORE = "more";
const ms = value => (value && value < 1e12 ? value * 1000 : value) || 0;

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
  node.style.maskImage = `url("${name.startsWith("resource:") ? name : ICON(name)}")`;
  return node;
}

/** A site or engine icon in full colour; the monochrome glyph stays as the
 * fallback when the image is missing or fails to load. */
function picture(doc, src, fallback) {
  const image = el(doc, "img", { class: "lima-s-favicon", src, alt: "", referrerpolicy: "no-referrer" });
  image.addEventListener("error", () => image.replaceWith(glyph(doc, fallback)), { once: true });
  return image;
}

/** A failure the user can act on: one sentence, never JSON or a stack. */
function friendlyError(error) {
  const raw = String(error?.message ?? error ?? "").trim();
  if (!raw || /^[[{]/.test(raw)) return "Lima couldn't complete this action.";
  const line = raw.split("\n").find(part => part.trim() && !/^\s*at\s|@\S+:\d+/.test(part)) ?? raw;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

class Panel {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.private = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    this.items = [];
    this.selectedKey = null;
    this.generation = 0;
    this.suggester = null;
    this.metrics = {};
    this.build();
  }

  build() {
    const doc = this.doc;
    this.input = el(doc, "input", { id: "lima-search-input", type: "text", role: "combobox", "aria-label": "Lima Search",
      "aria-controls": "lima-search-results", "aria-expanded": "false", "aria-autocomplete": "list",
      placeholder: this.private ? "Search the web or enter an address" : "Search, open, or ask Lima",
      autocomplete: "off", spellcheck: "false" });
    this.mark = el(doc, "span", { id: "lima-search-mark", "aria-hidden": "true" }, glyph(doc, "search")); // a plain magnifier, not the old Lima mark
    this.scope = el(doc, "span", { id: "lima-search-scope", hidden: true });
    // Where a page opens: "This tab" when Search stands in for the address
    // bar (⌘L), "New tab" for ⌘T. ⌥↩ or a click on the chip switches.
    this.where = el(doc, "button", { id: "lima-search-where", type: "button", hidden: true, title: "Switch where the page opens (⌥↩ opens the other way)",
      onmousedown: event => event.preventDefault(), onclick: () => { this.setMode(this.mode === "here" ? "new" : "here"); this.input.focus(); } });
    this.spinner = el(doc, "span", { id: "lima-search-spinner", hidden: true, "aria-hidden": "true" });
    // What a Quick Ask shares beyond the question (a page or a selection).
    this.contextChip = el(doc, "div", { id: "lima-search-context", hidden: true });
    this.results = el(doc, "div", { id: "lima-search-results", role: "listbox", "aria-label": "Results" });
    this.status = el(doc, "div", { id: "lima-search-status", role: "status", hidden: true });
    this.live = el(doc, "div", { id: "lima-search-live", class: "lima-s-visually-hidden", "aria-live": "polite" });
    const hint = (key, label) => el(doc, "span", {}, el(doc, "kbd", { text: key }), ` ${label}`);
    // Where to look: everything, or one kind of thing. Same as typing @tabs.
    this.scopeBar = el(doc, "div", { id: "lima-search-scopes", role: "toolbar", "aria-label": "Search in" },
      SCOPES.filter(([target]) => !this.private || !target || target === "tabs").map(([target, label, icon], index) =>
        el(doc, "button", { type: "button", class: "lima-s-scope", "data-target": target ?? "", title: `${label} (⌘${index + 1})`,
          onmousedown: event => event.preventDefault(), onclick: () => this.setTarget(target) }, glyph(doc, icon), el(doc, "span", { text: label }))));
    this.panel = el(doc, "div", { id: "lima-search", role: "dialog", "aria-label": "Lima Search" },
      el(doc, "div", { id: "lima-search-field" }, this.mark, this.scope, this.input, this.spinner, this.where),
      this.scopeBar, this.contextChip, this.status, this.results, this.live,
      el(doc, "div", { id: "lima-search-foot", "aria-hidden": "true" },
        hint("↑↓", "Select"), this.openHint = hint("↩", "Open"), hint("⇥", "Complete"), hint("⌥↩", "Other tab"),
        this.private ? null : hint("⌘↩", "AI Chat"), this.tabHint = hint("⌘⌫", "Close tab"), hint("esc", "Close")));
    this.scrim = el(doc, "div", { id: "lima-search-scrim", hidden: true, onpointerdown: event => { if (event.target === this.scrim) this.close(); } }, this.panel);
    doc.documentElement.append(this.scrim);

    this.input.addEventListener("input", () => {
      this.answering = null;
      this.selectedKey = null;
      this.clearStatus();
      this.query();
    });
    this.panel.addEventListener("keydown", event => {
      if (event.target === this.input || event.key === "Escape") this.onKey(event);
    });
  }

  get isOpen() { return !this.scrim.hidden; }

  async selectedEngine() {
    const search = lazy.SearchService;
    const engine = await (this.private ? search.getDefaultPrivate() : search.getDefault());
    return engine ?? search.getEngineByName("Google");
  }

  applyTheme() {
    // Follow macOS live while the panel is open (default "system").
    if (!this.unwatchAppearance) {
      this.unwatchAppearance = lazy.LimaAppearance.subscribe(() => { if (this.isOpen) this.applyTheme(); });
      this.win.addEventListener("unload", () => this.unwatchAppearance(), { once: true });
    }
    this.scrim.setAttribute("lima-theme", lazy.LimaAppearance.theme());
  }

  /** `context` (optional): { kind: "page" | "selection", title, url, text }.
   * The chip says exactly what Quick Ask will share. Opening again while
   * open keeps the query and returns focus to the input. */
  open(initial = "", { context = null, ask = null, mode = "new" } = {}) {
    if (this.isOpen && !initial && !context && !ask) {
      this.input.focus();
      return;
    }
    this.setMode(mode);
    lazy.LimaUsage.count(mode === "here" ? "search.addressBar" : "search.opened", this.win);
    const started = this.win.performance.now();
    this.selectedEngine().then(async engine => {
      this.engineName = engine?.name;
      this.engineIcon = await Promise.resolve(engine?.getIconURL?.(16)).catch(() => null) || null;
      const web = this.set?.best.find(item => item.key === "web");
      if (web && this.isOpen && !this.answering) {
        web.subtitle = `Search with ${this.engineName ?? "your search engine"}`;
        web.image = this.engineIcon;
        for (const item of this.set.web) item.image ??= this.engineIcon;
        this.paint();
      }
    }).catch(() => {});
    this.applyTheme();
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
    this.metrics.open = this.win.performance.now() - started;
  }

  setMode(mode) {
    this.mode = mode === "here" ? "here" : "new";
    const here = this.mode === "here";
    this.where.hidden = false;
    this.where.dataset.mode = this.mode;
    this.where.replaceChildren(glyph(this.doc, here ? "tab" : "plus"), el(this.doc, "span", { text: here ? "This tab" : "New tab" }));
    this.where.setAttribute("aria-label", here ? "Opens in this tab. Switch to a new tab" : "Opens in a new tab. Switch to this tab");
    this.input.placeholder = here ? "Edit the address, search, or ask Lima" : this.private ? "Search the web or enter an address" : "Search, open, or ask Lima";
    if (this.openHint) this.openHint.lastChild.textContent = here ? " Open here" : " Open";
  }

  /** Searches one scope (or all): rewrites the @target in the query. */
  setTarget(target) {
    const { text } = parseQuery(this.input.value);
    this.input.value = target ? `@${target} ${text}` : text;
    if (target !== "page") this.setContext(null);
    this.selectedKey = null;
    this.answering = null;
    this.clearStatus();
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.query();
  }

  paintScopes(target) {
    for (const button of this.scopeBar.children) button.setAttribute("aria-pressed", String((button.dataset.target || null) === target));
  }

  currentPage() {
    const browser = this.win.gBrowser.selectedBrowser;
    const url = browser?.currentURI?.spec ?? "";
    if (!/^https?:/i.test(url)) return null;
    return { kind: "page", title: browser.contentTitle || this.win.gBrowser.selectedTab.label, url };
  }

  setContext(context) {
    this.context = context;
    const doc = this.doc;
    this.contextChip.hidden = !context;
    if (!context) { this.contextChip.replaceChildren(); return; }
    const what = context.kind === "selection" ? "Selected text" : context.kind === "tabs" ? `${context.count} selected tabs` : "Current page";
    const shares = context.kind === "selection" ? "Shares the selected text, page title and URL" : "Shares the page title and URL";
    this.contextChip.replaceChildren(glyph(doc, context.kind === "selection" ? "paragraph" : "web"),
      el(doc, "span", { text: what }), el(doc, "strong", { text: context.title || context.url, title: shares }),
      el(doc, "button", { class: "lima-s-chip-remove", title: "Don't share", "aria-label": `Don't share ${what.toLowerCase()}`,
        onmousedown: event => event.preventDefault(),
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

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.scrim.hidden = true;
    this.win.clearTimeout(this.holdTimer);
    this.results.style.removeProperty("min-height");
    this.generation++;
    this.answering = null;
    this.spinner.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.setContext(null);
    this.suggester?.stop();
    if (restoreFocus) try { this.win.gBrowser.selectedBrowser.focus(); } catch {}
  }

  // MARK: Sources

  query() {
    const { text, target } = parseQuery(this.input.value);
    const generation = ++this.generation;
    const started = this.win.performance.now();
    if (target === "page" && !this.context) this.setContext(this.currentPage());
    this.scope.hidden = !target;
    this.scope.textContent = target ? TARGET_LABEL[target] : "";
    this.paintScopes(target);
    const suggest = !target && !this.private && Services.prefs.getBoolPref("browser.search.suggest.enabled", true);
    this.set = new ResultSet(text, { webExpected: !!text && suggest });
    this.pending = 0;
    this.holdHeight();
    const local = rows => {
      if (generation !== this.generation) return;
      this.set.addLocal(rows);
      this.metrics.local ??= this.win.performance.now() - started;
      this.paint();
    };
    const run = (fn, timeout = 1500, onTimeout = null) => {
      this.pending++;
      this.spinner.hidden = false;
      const deadline = new Promise(resolve => this.win.setTimeout(resolve, timeout));
      Promise.race([Promise.resolve().then(fn), deadline]).catch(() => {}).finally(() => {
        if (generation !== this.generation) return;
        onTimeout?.();
        if (--this.pending === 0) { this.spinner.hidden = true; if (this.win.performance.now() - this.typedAt > 350) this.releaseHeight(); }
      });
    };

    if (!text) {
      if (!target) this.set.setBest(this.private ? [] : this.quickActions());
      this.set.titles = ["Start", "Recent"];
      this.empty(target, generation);
      return;
    }
    this.set.setBest(this.bestRows(text, target));
    if (!target || target === "tabs") local(this.tabRows());
    if (!target || target === "notes" || target === "files") run(() => this.limaRows(text, target).then(local));
    if (!target || target === "workspace") run(() => this.workspaceRows().then(local));
    if (!target) run(() => this.historyRows(text).then(local));
    if (suggest) run(() => this.webRows(text).then(rows => {
      if (generation !== this.generation) return;
      this.set.setWeb(rows);
      this.paint();
    }), 2500, () => { if (this.set.webExpected) { this.set.webDone(); this.paint(); } });
    this.paint();
  }

  /** The icon Places saved for a page or its site, from the local favicon
   * store only: typing an address never contacts the site. */
  async pageIcon(url) {
    if (this.private) return null;
    const favicons = lazy.PlacesUtils.favicons;
    for (const candidate of new Set([url, `${new URL(url).origin}/`])) {
      try {
        const uri = Services.io.newURI(candidate);
        const found = await favicons.getFaviconForPage?.(uri, 32);
        if (found) return found.dataURI?.spec ?? `page-icon:${candidate}`;
      } catch {}
    }
    return null;
  }

  /** Synchronous, so row one never changes while sources load. */
  bestRows(text, target) {
    const rows = [];
    const url = navigationURL(text);
    if (url) {
      const row = { key: `nav:${url}`, icon: "globe", title: text, subtitle: url, action: "Open Website", run: () => this.openURL(url) };
      rows.push(row);
      const generation = this.generation;
      this.pageIcon(url).then(src => {
        if (!src || generation !== this.generation || !this.isOpen) return;
        row.image = src;
        this.paint();
      });
    }
    if (this.context && !this.private) rows.push({ key: "ask", icon: "spark", title: text, subtitle: `Ask Lima about ${this.context.kind === "selection" ? "the selected text" : "this page"}`,
      action: "Ask Lima", inline: true, run: () => this.quickAsk(text) });
    if (target === "page" && this.context) return rows;
    rows.push({ key: "web", icon: "search", image: this.engineIcon, title: text, subtitle: `Search with ${this.engineName ?? "your search engine"}`, action: "Search", run: () => this.webSearch(text) });
    if (this.private || this.context || url) return rows;
    const suggestion = aiSuggestion(text);
    if (suggestion === "ask") rows.push({ key: "ask", icon: "spark", title: text, subtitle: "Quick answer, no page or file access", action: "Ask Lima", inline: true, run: () => this.quickAsk(text) });
    if (suggestion === "delegate") rows.push({ key: "delegate", icon: "workspace", title: text, subtitle: "Hand off to the Companion as a draft", action: "Delegate", run: () => this.delegate(text) });
    return rows;
  }

  tabRows() {
    const active = this.win.gZenWorkspaces?.activeWorkspace;
    return [...this.win.gBrowser.tabs]
      .filter(tab => !tab.hasAttribute("zen-empty-tab") && !tab.selected && !tab.closing)
      .map(tab => {
        const url = tab.linkedBrowser?.currentURI?.spec ?? "";
        const group = tab.group?.label;
        const image = tab.image && /^(data|https?|page-icon|moz-remote-image|chrome|resource):/.test(tab.image) ? tab.image : null;
        let host = "";
        try { host = /^https?:/.test(url) ? new URL(url).host.replace(/^www\./, "") : ""; } catch {}
        return { key: `tab:${tab.linkedPanel ?? url}`, kind: "tab", icon: "tab", image, title: tab.label, url, group,
          subtitle: [group ? `Tab in ${group}` : "Open tab", host].filter(Boolean).join(" · "), action: "Switch to Tab", lastUsed: tab.lastAccessed,
          inCurrentWorkspace: !!active && tab.getAttribute("zen-workspace-id") === active,
          closeTab: () => this.win.gBrowser.removeTab(tab, { animate: false }),
          run: () => { this.win.gBrowser.selectedTab = tab; } };
      });
  }

  async limaRows(text, target) {
    if (this.private) return [];
    const response = await lazy.LimaBridge.request("search.query", { query: text, limit: 18 });
    const wanted = target === "notes" ? "note" : target === "files" ? "file" : null;
    const results = response.results
      .filter(r => !["web", "tab"].includes(r.source) && !["agentAsk", "quickAsk", "webSearch", "navigate", "switchTab"].includes(r.action.type))
      .filter(r => !wanted || r.source === wanted);
    // An activity record of opening a note or chat repeats that note or chat.
    const named = new Set(results.filter(r => r.source !== "context").map(r => r.title?.trim().toLowerCase()));
    return results
      .filter(r => r.source !== "context" || !named.has(r.title?.trim().toLowerCase()))
      .map(r => {
        const command = r.action.type === "runCapability";
        const source = SOURCE[r.source] ?? { kind: "other", icon: "search" };
        return { key: `lima:${r.key}`, kind: command ? "command" : source.kind, icon: command ? "bolt" : source.icon, title: r.title,
          subtitle: r.subtitle, score: r.score, command,
          action: r.action.type === "openApp" ? "Launch" : command ? "Run" : r.action.type === "copyText" ? "Copy" : "Open",
          run: () => this.runLima(r) };
      });
  }

  async workspaceRows() {
    if (this.private) return [];
    const workspaces = await lazy.LimaBridge.request("workspace.list");
    return workspaces.filter(workspace => !workspace.parentID && workspace.conversationID).map(workspace => ({
      key: `workspace:${workspace.id}`, kind: "workspace", icon: "workspace", title: workspace.name, subtitle: "Workspace",
      action: "Open Workspace", run: () => lazy.LimaTabs.openOrFocus(this.win, `about:lima?chat=${encodeURIComponent(workspace.conversationID)}`),
    }));
  }

  async webRows(text) {
    const engine = await this.selectedEngine();
    if (!engine?.supportsResponseType?.("application/x-suggestions+json")) return [];
    this.suggester?.stop();
    this.suggester = new lazy.SearchSuggestionController();
    const result = await this.suggester.fetch({ searchString: text, inPrivateBrowsing: this.private, engine,
      maxLocalResults: 0, maxRemoteResults: 6 });
    return (result?.remote ?? []).filter(entry => entry.value && entry.value.toLowerCase() !== text.toLowerCase())
      .map(entry => ({ key: `sugg:${entry.value}`, icon: "search", image: this.engineIcon, title: entry.value, subtitle: engine.name, action: "Search", run: () => this.webSearch(entry.value) }));
  }

  async historyRows(text) {
    if (this.private) return [];
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const like = `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
    const rows = await db.executeCached(
      `SELECT h.url, h.title, h.frecency, h.last_visit_date, (SELECT 1 FROM moz_bookmarks b WHERE b.fk = h.id LIMIT 1) AS bookmarked
         FROM moz_places h
        WHERE h.hidden = 0 AND h.url NOT LIKE 'about:lima%' AND (h.title LIKE :like ESCAPE '\\' OR h.url LIKE :like ESCAPE '\\')
        ORDER BY bookmarked DESC, h.frecency DESC LIMIT 12`, { like });
    return rows.map(row => {
      const url = row.getResultByName("url");
      const bookmarked = !!row.getResultByName("bookmarked");
      return { key: `hist:${url}`, kind: bookmarked ? "bookmark" : "history", icon: bookmarked ? "bookmark" : "history",
        title: row.getResultByName("title") || url, url, subtitle: url, action: "Open",
        frecency: row.getResultByName("frecency"), lastUsed: (row.getResultByName("last_visit_date") ?? 0) / 1000,
        run: () => this.openURL(url) };
    });
  }

  /** Empty query: up to four recent destinations, or one hint. With an
   * @target and no text, that target's recent items. */
  async empty(target, generation) {
    this.set.loading = !this.private;
    this.paint();
    if (this.private) return;
    const tabs = this.tabRows().filter(tab => /^(https?:|about:lima\?)/.test(tab.url)).map(tab => ({ ...tab, when: tab.lastUsed }));
    let rows = [];
    try {
      if (target === "tabs") rows = tabs;
      else {
        const [notes, chats, workspaces] = await Promise.all([
          lazy.LimaBridge.request("notes.list").catch(() => []),
          lazy.LimaBridge.request("chat.list").catch(() => []),
          lazy.LimaBridge.request("workspace.list").catch(() => []),
        ]);
        const chatsByID = new Map(chats.map(chat => [chat.id, chat]));
        const open = url => () => lazy.LimaTabs.openOrFocus(this.win, url);
        const workspaceRows = workspaces.filter(w => !w.parentID && w.conversationID).map(w => {
          const chat = chatsByID.get(w.conversationID);
          const url = `about:lima?chat=${encodeURIComponent(w.conversationID)}`;
          return { key: `workspace:${w.id}`, kind: "workspace", icon: "workspace", title: w.name, url, when: ms(chat?.updatedAt ?? w.createdAt),
            unfinished: !!chat?.running, subtitle: chat?.running ? "Workspace · agent working" : "Workspace", action: "Open Workspace", run: open(url) };
        });
        const inWorkspace = new Set(workspaces.map(w => w.conversationID));
        const noteRows = notes.filter(n => !n.trashed).map(n => {
          const url = `about:lima?note=${encodeURIComponent(n.id)}`;
          return { key: `note:${n.id}`, kind: "note", icon: n.kind === "canvas" ? "canvas" : "note", title: n.title || "Untitled", url, when: ms(n.modifiedAt),
            subtitle: "Note", action: "Open", run: open(url) };
        });
        const chatRows = chats.filter(c => !inWorkspace.has(c.id)).map(c => {
          const url = `about:lima?chat=${encodeURIComponent(c.id)}`;
          return { key: `chat:${c.id}`, kind: "chat", icon: "chat", title: c.title, url, when: ms(c.updatedAt), unfinished: !!c.running,
            subtitle: c.running ? "AI chat · working" : "AI chat", action: "Open", run: open(url) };
        });
        rows = target === "notes" ? noteRows : target === "workspace" ? workspaceRows : [...workspaceRows, ...tabs, ...noteRows, ...chatRows];
      }
    } catch {}
    if (generation !== this.generation || this.answering) return;
    this.set.loading = false;
    this.set.local = recentDestinations(rows, target ? INITIAL_LIMIT : undefined);
    this.paint();
  }

  /** Empty query: things to start, above the recent destinations. */
  quickActions() {
    const open = url => () => lazy.LimaTabs.openOrFocus(this.win, url);
    return [
      { key: "qa:note", icon: "note", title: "New Note", subtitle: "Blank note", action: "Create", run: async () => {
        const note = await lazy.LimaBridge.request("notes.create", { title: "Untitled", markdown: "" });
        lazy.LimaTabs.openOrFocus(this.win, `about:lima?note=${encodeURIComponent(note.id)}`);
      } },
      { key: "qa:chat", icon: "chat", title: "New AI Chat", subtitle: "Chat with your AI provider", action: "Open", run: open("about:lima?chat=new") },
      { key: "qa:companion", icon: "spark", title: "Ask the Companion", subtitle: "Hand off work to an agent", action: "Open",
        run: () => this.win.dispatchEvent(new this.win.CustomEvent("LimaAssistantOpen", { detail: {} })) },
    ];
  }

  // MARK: Actions

  openURL(url, postData = null) {
    if (!/^https?:\/\//i.test(url)) throw new Error("Lima only opens web addresses from Search.");
    // Typed in the address bar's stead: the browser's trusted-load path,
    // in this tab or a new one as the chip says (⌥↩ flips it once).
    const here = (this.mode === "here") !== !!this.flipWhere;
    this.flipWhere = false;
    const current = this.win.gBrowser.selectedTab;
    const where = here && !current.pinned && !current.hasAttribute("zen-essential") ? "current" : "tab";
    this.win.openTrustedLinkIn(url, where, { postData, inBackground: false });
  }

  async webSearch(text) {
    const engine = await this.selectedEngine();
    const submission = engine?.getSubmission(text);
    if (!submission?.uri) throw new Error("Choose a default search engine in Settings.");
    this.openURL(submission.uri.spec, submission.postData);
  }

  /** ⌘↩ and Continue in Chat: a new AI Chat tab with the query. */
  ask(text = this.prompt(parseQuery(this.input.value).text)) {
    if (this.private) return;
    this.close({ restoreFocus: false });
    lazy.LimaTabs.openOrFocus(this.win, text ? `about:lima?chat=new&prompt=${encodeURIComponent(text)}` : "about:lima?chat=new");
  }

  /** Delegate Task: the Companion receives the query as an unsent draft. */
  delegate(text = parseQuery(this.input.value).text) {
    if (this.private) return;
    this.close({ restoreFocus: false });
    this.win.dispatchEvent(new this.win.CustomEvent("LimaAssistantOpen", { detail: { draft: text } }));
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
      case "copyText": return clipboard().copyString(p.text ?? result.title);
      case "runCapability": {
        const input = parseQuery(this.input.value).text.split(/\s+/).slice(1).join(" ");
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
   * keep it until they finish so a failure can be shown where it started;
   * everything else closes first and hands focus to the destination. */
  async activate(item) {
    if (item.key === MORE) return this.showMore();
    if (this.running) return;
    if (item.inline) return item.run();
    this.running = true;
    const generation = this.generation;
    if (item.command) this.setStatus("busy", "Running command…");
    else this.close({ restoreFocus: false });
    try {
      await item.run();
      if (item.command && generation === this.generation) this.close({ restoreFocus: false });
      try { this.win.gBrowser.selectedBrowser.focus(); } catch {}
    } catch (error) {
      dump(`[lima] search action failed: ${error?.message ?? error}\n`);
      this.fail(item, error);
    } finally {
      this.running = false;
    }
  }

  showMore() {
    const index = this.items.findIndex(item => item.key === MORE);
    this.set.expand();
    this.paint();
    this.selectedKey = this.items[Math.max(0, index)]?.key ?? this.selectedKey;
    this.paint();
  }

  // MARK: Inline status, Quick Ask

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
    return el(this.doc, "button", { type: "button", class: primary ? "lima-s-button primary" : "lima-s-button", onclick, onmousedown: event => event.preventDefault() }, label);
  }

  /** Reopens the panel if needed and explains the failure next to the query. */
  fail(item, error) {
    if (!this.isOpen) {
      const query = this.input.value;
      this.applyTheme();
      this.scrim.hidden = false;
      this.input.value = query;
      this.query();
    }
    this.setStatus("bad", item.command ? "Command failed" : "Couldn't complete this action.", friendlyError(error),
      this.button("Retry", () => { this.clearStatus(); this.activate(item); }, true),
      item.command ? this.button("View Details", () => { this.close(); lazy.LimaTabs.openOrFocus(this.win, "about:lima?view=activity&tab=commands"); }) : null);
    this.input.focus();
  }

  /** Streams a Quick Ask answer in place of the results. Escape returns to
   * them; closing ignores the rest of the stream. */
  async quickAsk(text) {
    if (this.private) return;
    const doc = this.doc;
    const generation = ++this.generation;
    const requestId = Services.uuid.generateUUID().toString().slice(1, -1);
    const provider = Services.prefs.getStringPref("lima.agent.provider", "claude");
    const model = Services.prefs.getStringPref(`lima.agent.model.${provider}`, "default");
    this.answering = { text, requestId };
    this.items = [];
    this.input.removeAttribute("aria-activedescendant");
    this.spinner.hidden = false;
    const answer = el(doc, "div", { class: "lima-s-answer-text", "aria-live": "polite", tabindex: "0" });
    const actions = el(doc, "div", { class: "lima-s-answer-actions", hidden: true });
    const meta = el(doc, "span", { class: "lima-s-answer-meta", text: "Asking Lima…" });
    this.clearStatus();
    this.results.replaceChildren(el(doc, "div", { class: "lima-s-answer", role: "region", "aria-label": "Lima's answer" },
      el(doc, "div", { class: "lima-s-answer-question", text }), answer, el(doc, "div", { class: "lima-s-answer-foot" }, meta, actions),
      el(doc, "p", { class: "lima-s-disclaimer", text: "AI can make mistakes. Check important details." })));
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
    const back = () => this.button("Close", () => this.close());
    try {
      const result = await lazy.LimaBridge.request("quickAsk", { requestId, prompt: asked, provider, ...(model !== "default" ? { model } : {}) });
      if (result?.error) {
        meta.textContent = "Couldn't get an answer.";
        answer.textContent = friendlyError(result.error.message || "The AI provider didn't answer.");
        answer.dataset.tone = "bad";
        done(undefined, this.button("Retry", () => this.quickAsk(text), true), chat(),
          this.button("Open Settings", () => { this.close(); lazy.LimaTabs.openOrFocus(this.win, "about:lima?view=integrations&section=agents"); }));
        return;
      }
      meta.textContent = this.context ? "Quick Ask · shared what the chip shows" : "Quick Ask · no page or file access";
      const final = result?.text ?? streamed;
      done(final, this.button("Copy", () => {
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(final);
        meta.textContent = "Copied";
      }, true), chat(), back());
    } catch (error) {
      meta.textContent = "Couldn't get an answer.";
      answer.textContent = friendlyError(error);
      answer.dataset.tone = "bad";
      done(undefined, this.button("Retry", () => this.quickAsk(text), true), chat(), back());
    }
  }

  // MARK: View

  /* Typing starts each query with only the first rows; tabs, notes, history
   * and web suggestions follow over the next few hundred milliseconds. So
   * the list doesn't collapse and regrow on every keystroke, it only grows
   * while you type, shrinks once you pause (and its sources have settled),
   * and every change in the panel's height eases instead of jumping. */
  holdHeight() {
    this.typedAt = this.win.performance.now();
    const height = this.results.getBoundingClientRect().height;
    const held = parseFloat(this.results.style.minHeight) || 0;
    if (height > held) this.results.style.minHeight = `${height}px`;
    this.win.clearTimeout(this.holdTimer);
    this.holdTimer = this.win.setTimeout(() => { if (!this.pending) this.releaseHeight(); else this.holdTimer = this.win.setTimeout(() => this.releaseHeight(), 600); }, 420);
  }

  releaseHeight() {
    this.win.clearTimeout(this.holdTimer);
    if (!this.results.style.minHeight) return;
    this.resize(() => this.results.style.removeProperty("min-height"));
  }

  /** Runs `change`, then eases the panel from its old height to the new one. */
  resize(change) {
    const before = this.panel.getBoundingClientRect().height;
    change();
    const after = this.panel.getBoundingClientRect().height;
    if (!this.isOpen || Math.abs(before - after) < 2 || this.win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.heightAnimation?.cancel();
    this.heightAnimation = this.panel.animate([{ height: `${before}px` }, { height: `${after}px` }],
      { duration: Math.min(260, 140 + Math.abs(before - after) / 3), easing: "cubic-bezier(.2, .8, .25, 1)" });
  }

  paint() {
    if (this.answering) return;
    this.resize(() => this.paintRows());
  }

  paintRows() {
    const doc = this.doc;
    const text = parseQuery(this.input.value).text;
    const { sections, headings, hidden } = this.set.layout();
    this.items = sections.flatMap(section => section.items);
    if (hidden) this.items.push({ key: MORE, icon: "chevron", title: `Show ${hidden} more result${hidden === 1 ? "" : "s"}`, action: "Show" });
    if (!this.items.some(item => item.key === this.selectedKey)) this.selectedKey = this.items[0]?.key ?? null;

    const row = (item, index) => {
      const selected = item.key === this.selectedKey;
      return el(doc, "div", { id: `lima-s-option-${index}`, class: item.key === MORE ? "lima-s-row lima-s-more" : "lima-s-row",
        role: "option", "aria-selected": String(selected), "data-key": item.key,
        onmousemove: () => { if (this.selectedKey !== item.key) this.select(item.key); },
        onmousedown: event => { event.preventDefault(); this.activate(item); } },
        el(doc, "span", { class: "lima-s-icon", "data-kind": item.kind ?? item.key.split(":")[0] }, item.image ? picture(doc, item.image, item.icon) : glyph(doc, item.icon)),
        el(doc, "span", { class: "lima-s-text" }, el(doc, "span", { class: "lima-s-title", text: item.title }),
          item.subtitle ? el(doc, "span", { class: "lima-s-sub", text: item.subtitle }) : null),
        selected ? el(doc, "span", { class: "lima-s-action", "aria-hidden": "true" }, el(doc, "kbd", { text: "↩" }), ` ${item.action}`)
          : (item.when ?? item.lastUsed) ? el(doc, "span", { class: "lima-s-when", text: ago(item.when ?? item.lastUsed) }) : null,
        item.closeTab ? el(doc, "button", { type: "button", class: "lima-s-close", title: "Close tab (⌘⌫)", "aria-label": `Close ${item.title}`,
          onmousedown: event => { event.preventDefault(); event.stopPropagation(); this.closeTab(item); } }, "×") : null);
    };
    const nodes = [];
    let index = 0;
    for (const section of sections) {
      const label = `lima-s-group-${section.id}`;
      nodes.push(el(doc, "div", { role: "group", "aria-labelledby": headings ? label : null, "aria-label": headings ? null : section.title, class: "lima-s-section" },
        headings ? el(doc, "div", { id: label, class: "lima-s-group", role: "presentation", text: section.title }) : null,
        section.items.map(item => row(item, index++))));
    }
    if (hidden) nodes.push(row(this.items.at(-1), index));
    if (!nodes.length && !this.set.loading) nodes.push(el(doc, "div", { class: "lima-s-empty", text: text ? "No matches yet" : EMPTY_HINT }));
    this.results.replaceChildren(...nodes);

    const selectedIndex = this.items.findIndex(item => item.key === this.selectedKey);
    this.input.setAttribute("aria-expanded", String(this.items.length > 0));
    if (selectedIndex >= 0) this.input.setAttribute("aria-activedescendant", `lima-s-option-${selectedIndex}`);
    else this.input.removeAttribute("aria-activedescendant");
    this.results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    this.tabHint.hidden = !this.items.find(item => item.key === this.selectedKey)?.closeTab;
    this.announce(text);
  }

  /** One polite announcement after results settle, not one per source. */
  announce(text) {
    this.win.clearTimeout(this.announceTimer);
    this.announceTimer = this.win.setTimeout(() => {
      if (!this.isOpen || this.answering) return;
      const count = this.items.filter(item => item.key !== MORE).length;
      this.live.textContent = text ? `${count} result${count === 1 ? "" : "s"}` : count ? `${count} recent` : EMPTY_HINT;
    }, 450);
  }

  /** Closes a tab from its row and keeps the panel and selection near it. */
  closeTab(item) {
    const index = this.items.findIndex(entry => entry.key === item.key);
    try { item.closeTab(); } catch {}
    this.set.pool = this.set.pool.filter(entry => entry.key !== item.key);
    this.set.local = this.set.local.filter(entry => entry.key !== item.key);
    if (this.set.frozen) this.set.frozen = this.set.frozen.filter(key => key !== item.key);
    this.selectedKey = this.items[index + 1]?.key ?? this.items[index - 1]?.key ?? null;
    this.paint();
    this.input.focus();
  }

  /** Tab: puts the selected row's text in the input to refine it. */
  complete() {
    const item = this.items.find(entry => entry.key === this.selectedKey);
    if (!item || item.key === MORE || item.key.startsWith("qa:")) return false;
    const { target } = parseQuery(this.input.value);
    const text = item.key.startsWith("nav:") || item.kind === "history" || item.kind === "bookmark" ? (item.url ?? item.title) : item.title;
    if (!text) return false;
    this.input.value = target ? `@${target} ${text}` : text;
    this.selectedKey = null;
    this.query();
    return true;
  }

  select(key) {
    this.set.freeze();
    this.selectedKey = key;
    this.paint();
  }

  onKey(event) {
    const index = this.items.findIndex(item => item.key === this.selectedKey);
    if (event.key === "Escape") {
      event.preventDefault();
      if (this.answering) { this.answering = null; this.generation++; this.spinner.hidden = true; this.query(); }
      else this.close();
    } else if (event.metaKey && !event.shiftKey && !event.altKey && /^[1-6]$/.test(event.key) && !this.answering) {
      event.preventDefault();
      const scope = this.scopeBar.children[Number(event.key) - 1];
      if (scope) this.setTarget(scope.dataset.target || null);
    } else if (event.key === "Backspace" && event.metaKey && !this.answering && this.items[index]?.closeTab
               && this.input.selectionStart === this.input.selectionEnd && this.input.selectionStart === this.input.value.length) {
      event.preventDefault();
      this.closeTab(this.items[index]);
    } else if (event.key === "c" && event.metaKey && event.shiftKey && !this.answering && this.items[index]?.url) {
      event.preventDefault();
      clipboard().copyString(this.items[index].url);
      this.setStatus("ok", "Link copied", this.items[index].url);
      this.win.setTimeout(() => { if (this.status.dataset.tone === "ok") this.clearStatus(); }, 1600);
    } else if (event.key === "Tab" && !event.shiftKey && !this.answering) {
      if (this.complete()) event.preventDefault();
    } else if (event.key === "Enter" && event.metaKey && event.shiftKey) {
      event.preventDefault();
      if (parseQuery(this.input.value).text) this.delegate();
    } else if (event.key === "Enter" && event.metaKey) {
      event.preventDefault();
      this.ask();
    } else if (this.answering && event.key === "Enter") {
      event.preventDefault();
    } else if (this.answering) {
      // Typing a new query leaves the answer; arrows stay in the text field.
    } else if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      const next = this.items[Math.min(this.items.length - 1, index + 1)]?.key;
      if (next) this.select(next);
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      const previous = this.items[Math.max(0, index - 1)]?.key;
      if (previous) this.select(previous);
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.flipWhere = event.altKey;
      if (this.items[index]) this.activate(this.items[index]);
    }
  }
}

const panels = new WeakMap();

export const LimaSearchPanel = {
  TARGETS,

  open(win, initial = "", options = {}) {
    if (!panels.has(win)) panels.set(win, new Panel(win));
    panels.get(win).open(initial, options);
  },

  toggle(win) {
    const panel = panels.get(win);
    if (panel?.isOpen) panel.close();
    else this.open(win);
  },

  /** Timings from the last open and query, for tests and benchmarks. */
  metrics(win) { return { ...(panels.get(win)?.metrics ?? {}) }; },

  /** Lima Search as the address bar: ⌘L and clicks on Zen's URL bar open it
   * with the current address selected, opening pages in this tab. */
  openAddress(win) {
    const url = win.gBrowser.selectedBrowser?.currentURI?.spec ?? "";
    this.open(win, /^https?:/i.test(url) ? url : "", { mode: "here" });
  },

  installAddressBar(win) {
    if (win.limaAddressBar || !Services.prefs.getBoolPref("lima.search.replaceAddressBar", true)) return;
    win.limaAddressBar = true;
    const original = win.openLocation?.bind(win);
    win.openLocation = (...args) => {
      if (!Services.prefs.getBoolPref("lima.search.replaceAddressBar", true)) return original?.(...args);
      LimaSearchPanel.openAddress(win);
      return undefined;
    };
    const urlbar = win.document.getElementById("urlbar");
    const take = event => {
      if (!Services.prefs.getBoolPref("lima.search.replaceAddressBar", true) || event.button > 0) return;
      event.preventDefault();
      event.stopPropagation();
      LimaSearchPanel.openAddress(win);
    };
    urlbar?.addEventListener("mousedown", take, true);
    // Anything else that focuses the address bar (Tab, extensions) lands in Search.
    win.gURLBar?.inputField?.addEventListener("focus", () => {
      if (!Services.prefs.getBoolPref("lima.search.replaceAddressBar", true)) return;
      win.gURLBar.blur();
      LimaSearchPanel.openAddress(win);
    });
  },

  /** ⌘T and Zen's "New Tab" become Lima Search. Pressing ⌘T again while it
   * is open keeps the query and focuses the input. */
  install(win) {
    this.installAddressBar(win);
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
