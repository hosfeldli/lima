/* AI workspaces in Zen's sidebar (docs/architecture/sidebar-workspaces.md).
 *
 *   ✦ Name            zen-folder[lima-workspace]; the ✦ icon opens Chat
 *     Chat            about:lima?chat=<conversation>
 *     Terminal        about:lima?terminal=<id>  (files | terminal)
 *     <notes>         notes the agent wrote
 *     ▸ Tabs          web pages the agent works in (and any you drop in)
 *     ▸ Agents        helper agents, each a folder: Chat, Terminal, pages
 *
 * The runtime holds desired state; this module reconciles it into folders
 * (idempotent, serialized), answers the runtime's tab requests, and moves
 * the prism to wherever the agent is working. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const MAP_PREF = "lima.workspaces.sidebar";
const BOOKMARK_ROOT_PREF = "lima.workspaces.bookmarkRoot";
const STAR = "resource://lima-ui/marks/star-prism.svg";
const TERMINAL_ICON = "resource://lima-ui/icons/terminal.svg";
const NOTE_ICON = "resource://lima-ui/icons/note.svg";

function log(message) {
  dump(`[lima] workspaces: ${message}\n`);
}

const system = () => Services.scriptSecurityManager.getSystemPrincipal();

/** The URL a tab stands for, even while it's lazy or after a restart. */
export function tabURL(tab) {
  let url = "";
  try { url = lazy.SessionStore.getCustomTabValue(tab, "lima-url"); } catch {}
  url ||= tab.getAttribute("lima-url");
  const current = tab.linkedBrowser?.currentURI?.spec;
  if (!url && current && current !== "about:blank") url = current;
  if (!url) {
    try { url = JSON.parse(lazy.SessionStore.getTabState(tab)).entries?.at(-1)?.url ?? ""; } catch {}
  }
  return url;
}

function sameURL(a, b) {
  const norm = u => String(u ?? "").replace(/#.*$/, "").replace(/\/$/, "");
  return !!a && norm(a) === norm(b);
}

class Workspaces {
  #started = false;
  #queue = Promise.resolve();
  #workspaces = new Map();
  #focus = new Map();

  start() {
    if (this.#started) return;
    this.#started = true;
    lazy.LimaBridge.onEvent(message => {
      const data = message.data;
      switch (message.event) {
        case "workspace.created":
        case "workspace.updated":
          this.#workspaces.set(data.id, data);
          this.#enqueue(() => this.reconcile(data));
          break;
        case "workspace.deleted":
          this.#workspaces.delete(data.id);
          this.#enqueue(() => this.remove(data.id, data.parentId));
          break;
        case "workspace.activity":
          this.#focus.set(data.id, data);
          this.#paintFocus(data.id);
          break;
        case "workspace.browserRequest":
          this.#answer(data);
          break;
      }
    });
    this.#enqueue(async () => {
      const all = await lazy.LimaBridge.request("workspace.list");
      for (const workspace of all) this.#workspaces.set(workspace.id, workspace);
      // Parents before helpers, so Agents folders have somewhere to go.
      for (const workspace of all.filter(w => !w.parentID)) await this.reconcile(workspace);
      for (const workspace of all.filter(w => w.parentID)) await this.reconcile(workspace);
      this.#prune(all);
      const activity = await lazy.LimaBridge.request("workspace.activity").catch(() => ({}));
      for (const [id, state] of Object.entries(activity)) { this.#focus.set(id, { id, ...state }); this.#paintFocus(id); }
    });
  }

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch(error => log(`${error}\n${error.stack ?? ""}`));
    return this.#queue;
  }

  get workspaces() { return [...this.#workspaces.values()]; }
  workspace(id) { return this.#workspaces.get(id); }

  // MARK: Folder map (folder ids persist with Zen's session)

  #map() {
    try { return JSON.parse(Services.prefs.getStringPref(MAP_PREF, "{}")); } catch { return {}; }
  }

  #saveMap(map) {
    Services.prefs.setStringPref(MAP_PREF, JSON.stringify(map));
  }

  #win() {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    return win?.gZenFolders ? win : null;
  }

  folderFor(id, part = "folder", win = this.#win()) {
    const entryId = this.#map()[id]?.[part];
    const node = entryId ? win?.document.getElementById(entryId) : null;
    return node?.isZenFolder ? node : null;
  }

  /** The workspace a tab belongs to (nearest workspace folder). */
  workspaceForTab(tab) {
    const folder = tab?.closest?.("zen-folder[lima-workspace]");
    return folder ? folder.getAttribute("lima-workspace") : null;
  }

  // MARK: Reconcile

  async reconcile(workspace) {
    const win = this.#win();
    if (win) this.#reconcileFolder(win, workspace);
    if (!workspace.parentID) await this.#reconcileBookmarks(workspace);
  }

  #makeTab(win, workspace, entry) {
    const tab = win.gBrowser.addTab(entry.url, {
      triggeringPrincipal: system(), inBackground: true, createLazyBrowser: true, lazyTabTitle: entry.title, skipAnimation: true,
    });
    tab.setAttribute("lima-url", entry.url);
    tab.setAttribute("lima-title", entry.title);
    try {
      lazy.SessionStore.setCustomTabValue(tab, "lima-url", entry.url);
      lazy.SessionStore.setCustomTabValue(tab, "lima-workspace", workspace.id);
    } catch {}
    if (entry.icon) {
      tab.setAttribute("lima-icon", entry.icon);
      try { win.gBrowser.setIcon(tab, entry.icon); } catch {}
    }
    return tab;
  }

  /** Zen relabels lazy tabs as they join a folder; apply ours after. */
  #label(win, tabs) {
    const apply = () => {
      for (const tab of tabs) {
        const icon = tab.getAttribute("lima-icon");
        if (icon && tab.hasAttribute("pending") && tab.getAttribute("image") !== icon) { try { win.gBrowser.setIcon(tab, icon); } catch {} }
        const title = tab.getAttribute("lima-title");
        if (!title || !tab.hasAttribute("pending")) continue;
        try { win.gBrowser._setTabLabel(tab, title); } catch { tab.label = title; }
      }
    };
    apply();
    win.setTimeout(apply, 600);
    win.setTimeout(apply, 2000);
  }

  #createFolder(win, tabs, label, parent = null) {
    const options = { label, collapsed: false };
    if (parent) options.insertAfter = parent.groupContainer.lastElementChild;
    return win.gZenFolders.createFolder(tabs, options);
  }

  #coreEntries(workspace) {
    const entries = [];
    if (workspace.conversationID) entries.push({ url: `about:lima?chat=${workspace.conversationID}`, title: "Chat", icon: STAR });
    if (workspace.terminalID) entries.push({ url: `about:lima?terminal=${workspace.terminalID}`, title: "Terminal", icon: TERMINAL_ICON });
    for (const tab of workspace.tabs.filter(t => t.url.startsWith("about:lima"))) entries.push({ url: tab.url, title: tab.title, icon: NOTE_ICON });
    return entries;
  }

  #reconcileFolder(win, workspace) {
    const map = this.#map();
    const entry = map[workspace.id] ?? {};
    const helper = !!workspace.parentID;
    let parentFolder = null;
    if (helper) {
      parentFolder = this.#agentsFolder(win, workspace.parentID, map);
      if (!parentFolder) return; // parent not shown yet; reconciled again with it
    }

    let folder = this.folderFor(workspace.id, "folder", win);
    const core = this.#coreEntries(workspace);
    const web = workspace.tabs.filter(t => !t.url.startsWith("about:lima")).map(t => ({ url: t.url, title: t.title }));

    if (!folder) {
      const tabs = core.map(e => this.#makeTab(win, workspace, e));
      folder = this.#createFolder(win, tabs, workspace.name, parentFolder);
      this.#label(win, tabs);
      entry.folder = folder.id;
      map[workspace.id] = entry;
      this.#saveMap(map);
      log(`folder for “${workspace.name}”${helper ? " (agent)" : ""}`);
    }
    folder.setAttribute("lima-workspace", workspace.id);
    if (helper) folder.setAttribute("lima-agent", "true");
    if (folder.label !== workspace.name) folder.label = workspace.name;

    // Core tabs: add missing ones, drop terminals/chats the workspace replaced.
    const wanted = new Set([...core, ...web].map(e => e.url));
    for (const tab of folder.tabs) {
      if (tab.group !== folder) continue;
      const url = tabURL(tab);
      if (/^about:lima\?(terminal|chat)=/.test(url) && !wanted.has(url)) win.gBrowser.removeTab(tab, { animate: false });
    }
    const allTabs = () => this.#allTabs(folder);
    const present = () => new Set(allTabs().map(tabURL));
    const missingCore = core.filter(e => !present().has(e.url));
    if (missingCore.length) {
      const added = missingCore.map(e => this.#makeTab(win, workspace, e));
      folder.addTabs(added);
      // Chat first, then Terminal, then notes, then sub-folders.
      this.#orderCore(win, folder);
      win.setTimeout(() => this.#orderCore(win, folder), 700);
      this.#label(win, added);
    }

    // Web pages: helpers keep theirs directly; workspaces use a Tabs folder.
    const missingWeb = web.filter(e => ![...present()].some(url => sameURL(url, e.url)));
    if (missingWeb.length) {
      const added = missingWeb.map(e => this.#makeTab(win, workspace, e));
      if (helper) folder.addTabs(added);
      else {
        let tabsFolder = this.folderFor(workspace.id, "tabs", win);
        if (!tabsFolder || tabsFolder.group !== folder) {
          tabsFolder = this.#createFolder(win, added, "Tabs", folder);
          tabsFolder.setAttribute("lima-tabs", workspace.id);
          entry.tabs = tabsFolder.id;
          map[workspace.id] = entry;
          this.#saveMap(map);
        } else tabsFolder.addTabs(added);
      }
      this.#label(win, added);
    }
    this.folderFor(workspace.id, "tabs", win)?.setAttribute("lima-tabs", workspace.id);
    this.#orderCore(win, folder);
    // Restored lazy tabs come back without our icons.
    for (const tab of this.#allTabs(folder)) {
      if (!tab.hasAttribute("pending") || tab.getAttribute("image")) continue;
      const url = tabURL(tab);
      const icon = url.startsWith("about:lima?chat=") ? STAR : url.startsWith("about:lima?terminal=") ? TERMINAL_ICON : url.startsWith("about:lima?note=") ? NOTE_ICON : null;
      if (icon) { tab.setAttribute("lima-icon", icon); try { win.gBrowser.setIcon(tab, icon); } catch {} }
    }
    this.#paintFocus(workspace.id);
  }

  /** Chat, Terminal, notes first; sub-folders (Tabs, Agents) after them. */
  #orderCore(win, folder) {
    const rank = tab => {
      const url = tabURL(tab);
      return url.startsWith("about:lima?chat=") ? 0 : url.startsWith("about:lima?terminal=") ? 1 : url.startsWith("about:lima?note=") ? 2 : 3;
    };
    const children = [...folder.groupContainer.children].filter(node => !node.hasAttribute?.("zen-empty-tab") && (node.isZenFolder || node.localName === "tab"));
    const firstFolder = children.find(node => node.isZenFolder);
    if (!firstFolder) return;
    const core = children.filter(node => node.localName === "tab" && rank(node) < 3).sort((a, b) => rank(a) - rank(b));
    for (const tab of core) {
      const index = children.indexOf(tab);
      if (index > children.indexOf(firstFolder)) {
        try { win.gBrowser.moveTabBefore(tab, firstFolder); } catch (error) { log(`reorder: ${error}`); }
      }
    }
  }

  #allTabs(folder) {
    return folder.allItemsRecursive.filter(item => !item.isZenFolder && !item.hasAttribute("zen-empty-tab") && item.localName === "tab");
  }

  #agentsFolder(win, parentID, map) {
    const parent = this.folderFor(parentID, "folder", win);
    if (!parent) return null;
    let agents = this.folderFor(parentID, "agents", win);
    if (agents && agents.group === parent) return agents;
    agents = this.#createFolder(win, [], "Agents", parent);
    agents.setAttribute("lima-agents", parentID);
    map[parentID] = { ...(map[parentID] ?? {}), agents: agents.id };
    this.#saveMap(map);
    return agents;
  }

  /** Forget folders of workspaces that no longer exist. */
  #prune(all) {
    const ids = new Set(all.map(w => w.id));
    const map = this.#map();
    for (const id of Object.keys(map)) {
      if (!ids.has(id)) { this.folderFor(id)?.delete(); delete map[id]; }
    }
    this.#saveMap(map);
  }

  async remove(id, parentID) {
    const map = this.#map();
    this.folderFor(id)?.delete();
    delete map[id];
    this.#saveMap(map);
    if (parentID) {
      const agents = this.folderFor(parentID, "agents");
      if (agents && !agents.allItems.some(item => item.isZenFolder)) {
        await agents.delete();
        delete map[parentID]?.agents;
        this.#saveMap(map);
      }
    }
  }

  /** User closed a page the agent had opened: drop it from desired state. */
  onTabClose(tab) {
    const id = this.workspaceForTab(tab);
    const url = tabURL(tab);
    if (!id || !url || url.startsWith("about:lima")) return;
    lazy.LimaBridge.request("workspace.closeTab", { id, url }).catch(() => {});
  }

  /** The folder's ✦ opens its chat. */
  openChat(win, id) {
    const workspace = this.#workspaces.get(id);
    const folder = this.folderFor(id, "folder", win);
    const url = workspace?.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const tab = folder && url && folder.tabs.find(t => tabURL(t) === url);
    if (tab) { win.gBrowser.selectedTab = tab; return; }
    if (url) win.gBrowser.selectedTab = win.gBrowser.addTab(url, { triggeringPrincipal: system() });
  }

  /** Called when the user renames a workspace folder inline. */
  onFolderRenamed(folder) {
    const id = folder.getAttribute("lima-workspace");
    if (!id || folder.label === this.#workspaces.get(id)?.name) return;
    lazy.LimaBridge.request("workspace.rename", { id, name: folder.label }).catch(error => log(`rename: ${error.message}`));
  }

  // MARK: Prism: where the agent is

  #paintFocus(id) {
    const win = this.#win();
    const folder = win && this.folderFor(id, "folder", win);
    if (!folder) return;
    const state = this.#focus.get(id) ?? { surface: "idle" };
    const workspace = this.#workspaces.get(id);
    const own = this.#allTabs(folder).filter(tab => this.workspaceForTab(tab) === id);
    for (const tab of own) tab.removeAttribute("lima-ai");
    folder.removeAttribute("lima-ai");
    const chatURL = workspace?.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const find = url => own.find(tab => sameURL(tabURL(tab), url));
    switch (state.surface) {
      case "chat":
        folder.setAttribute("lima-ai", "thinking");
        find(chatURL)?.setAttribute("lima-ai", "thinking");
        break;
      case "tab":
        find(state.url)?.setAttribute("lima-ai", "here");
        folder.setAttribute("lima-ai", "working");
        break;
      case "terminal":
        find(`about:lima?terminal=${workspace?.terminalID}`)?.setAttribute("lima-ai", "here");
        folder.setAttribute("lima-ai", "working");
        break;
    }
  }

  // MARK: Requests from the runtime

  async #answer(request) {
    const reply = (result, error) => lazy.LimaBridge.request("workspace.browserReply", error ? { requestId: request.requestId, error } : { requestId: request.requestId, result }).catch(() => {});
    try {
      const win = this.#win();
      if (!win) throw new Error("no Lima window is open");
      if (request.kind === "listTabs") return reply(this.#pages(win, request.workspaceId).map(tab => ({ url: tabURL(tab), title: tab.label, selected: tab.selected })));
      if (request.kind === "readTab") return reply(await this.#read(win, request.workspaceId, request.url));
      throw new Error(`unknown request ${request.kind}`);
    } catch (error) {
      reply(null, String(error.message ?? error));
    }
  }

  /** Web pages the agent may work in: its Tabs folder, or a helper's own folder. */
  #pages(win, id) {
    const workspace = this.#workspaces.get(id);
    const container = workspace?.parentID ? this.folderFor(id, "folder", win) : this.folderFor(id, "tabs", win);
    if (!container) return [];
    return this.#allTabs(container).filter(tab => /^https?:/.test(tabURL(tab)) && (!workspace?.parentID || tab.group === container));
  }

  async #read(win, id, url) {
    let tab = this.#pages(win, id).find(t => sameURL(tabURL(t), url));
    if (!tab) {
      await lazy.LimaBridge.request("workspace.openTab", { id, url });
      for (let i = 0; i < 30 && !tab; i++) {
        await new Promise(resolve => win.setTimeout(resolve, 100));
        tab = this.#pages(win, id).find(t => sameURL(tabURL(t), url));
      }
      if (!tab) throw new Error("the tab couldn't be opened");
    }
    const browser = await this.#loaded(win, tab, url);
    // Firefox's own extractor (also reads PDFs); runs only when asked.
    const actor = browser.browsingContext?.currentWindowGlobal?.getActor("PageExtractor");
    const page = await actor?.getText();
    if (!page) throw new Error("this page can't be read (not a web page)");
    const limit = 60000;
    const links = (page.links ?? []).slice(0, 80).map(link => typeof link === "string" ? link : link.url ?? link.href).filter(Boolean);
    return { url: browser.currentURI.spec, title: tab.label, text: page.text.slice(0, limit), truncated: page.text.length > limit, links };
  }

  /** Make sure a (possibly lazy) tab has loaded its page, without selecting it. */
  async #loaded(win, tab, url) {
    const gBrowser = win.gBrowser;
    if (!tab.linkedPanel) (gBrowser.insertBrowser ?? gBrowser._insertBrowser).call(gBrowser, tab);
    const browser = tab.linkedBrowser;
    if (!browser.currentURI || browser.currentURI.spec === "about:blank") {
      browser.loadURI(Services.io.newURI(tabURL(tab) || url), { triggeringPrincipal: system() });
    }
    for (let i = 0; i < 150; i++) {
      const doc = browser.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? "";
      if (/^https?:/.test(doc) && !browser.webProgress?.isLoadingDocument) break;
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
    return browser;
  }

  // MARK: Bookmarks

  async #bookmarkRoot() {
    const saved = Services.prefs.getStringPref(BOOKMARK_ROOT_PREF, "");
    if (saved && (await lazy.PlacesUtils.bookmarks.fetch(saved))) return saved;
    const folder = await lazy.PlacesUtils.bookmarks.insert({
      parentGuid: lazy.PlacesUtils.bookmarks.menuGuid, type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER, title: "Lima Workspaces",
    });
    Services.prefs.setStringPref(BOOKMARK_ROOT_PREF, folder.guid);
    return folder.guid;
  }

  async #childFolder(parentGuid, title) {
    let found = null;
    await lazy.PlacesUtils.bookmarks.fetch({ parentGuid }, child => {
      if (!found && child.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER && child.title === title) found = child.guid;
    });
    if (found) return found;
    return (await lazy.PlacesUtils.bookmarks.insert({ parentGuid, type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER, title })).guid;
  }

  async #ensureBookmark(parentGuid, url, title) {
    let exists = false;
    await lazy.PlacesUtils.bookmarks.fetch({ parentGuid }, child => { if (child.url?.href === url) exists = true; });
    if (!exists) await lazy.PlacesUtils.bookmarks.insert({ parentGuid, url, title });
  }

  async #reconcileBookmarks(workspace) {
    if (!workspace.bookmarks.length) return;
    const root = await this.#bookmarkRoot();
    const folder = await this.#childFolder(root, workspace.name);
    for (const bookmark of workspace.bookmarks) {
      let parent = folder;
      for (const part of bookmark.folder.split("/").filter(Boolean)) parent = await this.#childFolder(parent, part);
      await this.#ensureBookmark(parent, bookmark.url, bookmark.title);
    }
  }
}

export const LimaWorkspaces = new Workspaces();
