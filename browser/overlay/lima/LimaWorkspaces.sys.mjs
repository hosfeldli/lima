/* AI workspaces in Zen.
 *
 * The runtime holds each workspace's desired state (directory, terminal,
 * agent conversation, tabs, bookmarks). This module makes it visible:
 *   - a Zen tab folder "✦ <name>" holding the workspace dashboard, its
 *     terminal, its agent chat, and every tab the agent opened
 *   - a bookmark folder Lima Workspaces/<name> with the bookmarks the
 *     agent filed, in the sub-folders it chose
 * Reconciliation is idempotent and re-runs on every workspace change. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const FOLDER_MAP_PREF = "lima.workspaces.zenFolders";
const BOOKMARK_ROOT_PREF = "lima.workspaces.bookmarkRoot";
const ICON = "resource://lima-ui/icons/workspace.svg";

function log(message) {
  dump(`[lima] workspaces: ${message}\n`);
}

function coreTabs(workspace) {
  const tabs = [{ url: `about:lima?workspace=${workspace.id}`, title: `✦ ${workspace.name}` }];
  if (workspace.terminalID) tabs.push({ url: `about:lima?terminal=${workspace.terminalID}`, title: "Terminal" });
  if (workspace.conversationID) tabs.push({ url: `about:lima?chat=${workspace.conversationID}`, title: "Agent" });
  return tabs;
}

class Workspaces {
  #started = false;
  #queue = Promise.resolve();

  start() {
    if (this.#started) return;
    this.#started = true;
    lazy.LimaBridge.onEvent(message => {
      if (["workspace.created", "workspace.updated"].includes(message.event)) this.#enqueue(() => this.reconcile(message.data));
      if (message.event === "workspace.deleted") this.#enqueue(() => this.remove(message.data.id));
    });
    this.#enqueue(async () => {
      for (const workspace of await lazy.LimaBridge.request("workspace.list")) await this.reconcile(workspace);
    });
  }

  /** Serialize reconciliation so concurrent events can't double-create. */
  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch(error => log(`${error}\n${error.stack ?? ""}`));
    return this.#queue;
  }

  #folderMap() {
    try { return JSON.parse(Services.prefs.getStringPref(FOLDER_MAP_PREF, "{}")); } catch { return {}; }
  }

  #saveFolderMap(map) {
    Services.prefs.setStringPref(FOLDER_MAP_PREF, JSON.stringify(map));
  }

  async reconcile(workspace) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (win?.gZenFolders) this.#reconcileTabs(win, workspace);
    await this.#reconcileBookmarks(workspace);
  }

  // MARK: Zen tab folder

  #reconcileTabs(win, workspace) {
    const map = this.#folderMap();
    let folder = map[workspace.id] ? win.document.getElementById(map[workspace.id]) : null;
    const desired = [...coreTabs(workspace), ...workspace.tabs];
    // Lazy tabs read "New Tab" until loaded, and Zen re-labels tabs as they
    // join a folder, so titles are applied after insertion.
    const label = tabs => {
      for (const tab of tabs) {
        const title = tab.getAttribute("lima-title");
        if (!title) continue;
        try { win.gBrowser._setTabLabel(tab, title); } catch { tab.label = title; }
      }
    };
    const labelSoon = tabs => { label(tabs); win.setTimeout(() => label(tabs), 600); };
    const makeTab = entry => {
      const tab = win.gBrowser.addTab(entry.url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground: true,
        createLazyBrowser: true,
        lazyTabTitle: entry.title,
        skipAnimation: true,
      });
      tab.setAttribute("lima-workspace", workspace.id);
      tab.setAttribute("lima-url", entry.url);
      tab.setAttribute("lima-title", entry.title);
      return tab;
    };

    if (!folder) {
      const tabs = desired.map(makeTab);
      folder = win.gZenFolders.createFolder(tabs, { label: `✦ ${workspace.name}` });
      labelSoon(tabs);
      try { win.gZenFolders.setFolderUserIcon(folder, ICON); } catch {}
      map[workspace.id] = folder.id;
      this.#saveFolderMap(map);
      log(`folder created for “${workspace.name}” with ${tabs.length} tabs`);
      return;
    }

    folder.label = `✦ ${workspace.name}`;
    // Drop core tabs that point at a terminal/agent the workspace replaced.
    const wanted = new Set(desired.map(entry => entry.url));
    for (const tab of folder.tabs) {
      const url = tab.getAttribute("lima-url");
      if (url && /^about:lima\?(terminal|chat)=/.test(url) && !wanted.has(url)) win.gBrowser.removeTab(tab, { animate: false });
    }
    label(folder.tabs.filter(tab => tab.hasAttribute("pending")));
    const present = new Set(folder.tabs.map(tab => tab.getAttribute("lima-url") || tab.linkedBrowser?.currentURI?.spec));
    const missing = desired.filter(entry => !present.has(entry.url));
    if (missing.length) {
      const added = missing.map(makeTab);
      folder.addTabs(added);
      labelSoon(added);
      log(`${missing.length} tab(s) added to “${workspace.name}”`);
    }
  }

  /** User closed a tab the agent had opened: drop it from desired state. */
  onTabClose(tab) {
    const id = tab.getAttribute("lima-workspace");
    const url = tab.getAttribute("lima-url");
    if (!id || !url || url.startsWith("about:lima")) return;
    lazy.LimaBridge.request("workspace.closeTab", { id, url }).catch(() => {});
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
    const root = await this.#bookmarkRoot();
    const folder = await this.#childFolder(root, `✦ ${workspace.name}`);
    await this.#ensureBookmark(folder, `about:lima?workspace=${workspace.id}`, `✦ ${workspace.name} — workspace`);
    for (const bookmark of workspace.bookmarks) {
      let parent = folder;
      for (const part of bookmark.folder.split("/").filter(Boolean)) parent = await this.#childFolder(parent, part);
      await this.#ensureBookmark(parent, bookmark.url, bookmark.title);
    }
  }

  async remove(id) {
    const map = this.#folderMap();
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const folder = map[id] && win?.document.getElementById(map[id]);
    if (folder) await folder.delete();
    delete map[id];
    this.#saveFolderMap(map);
  }

  /** Data for the workspace dashboard page. */
  async browserState(id) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const folder = win?.document.getElementById(this.#folderMap()[id] ?? "");
    const tabs = folder ? folder.tabs.filter(t => !t.hasAttribute("zen-empty-tab")).map(t => ({
      title: t.label, url: t.getAttribute("lima-url") || t.linkedBrowser?.currentURI?.spec, selected: t.selected,
    })) : [];
    return { tabs, hasFolder: !!folder };
  }

  /** Focus a tab of the workspace by URL (or open it into the folder). */
  focusTab(id, url) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const folder = win?.document.getElementById(this.#folderMap()[id] ?? "");
    const tab = folder?.tabs.find(t => (t.getAttribute("lima-url") || t.linkedBrowser?.currentURI?.spec) === url);
    if (tab) win.gBrowser.selectedTab = tab;
    return !!tab;
  }
}

export const LimaWorkspaces = new Workspaces();

/** Lima's creation actions in Zen's own new-tab command bar. */
export function registerZenActions() {
  let globalActions;
  try {
    ({ globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs"));
  } catch (error) {
    log(`Zen actions unavailable: ${error}`);
    return;
  }
  const run = (id, input = "") => win =>
    lazy.LimaBridge.request("capabilities.run", { id, input })
      .then(result => { if (result?.type === "open") win.gBrowser.selectedTab = win.gBrowser.addTab(result.url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); })
      .catch(error => log(`${id}: ${error.message}`));
  const actions = [
    { label: "New AI Workspace", commandId: "lima:workspace-new", icon: "resource://lima-ui/icons/workspace.svg", command: run("workspace.new") },
    { label: "New Note", commandId: "lima:note-new", icon: "resource://lima-ui/icons/note.svg", command: run("note.new") },
    { label: "New Canvas", commandId: "lima:canvas-new", icon: "resource://lima-ui/icons/canvas.svg", command: run("canvas.new") },
    { label: "New Terminal", commandId: "lima:terminal-new", icon: "resource://lima-ui/icons/terminal.svg", command: run("terminal.new") },
    { label: "New AI Chat", commandId: "lima:chat-new", icon: "resource://lima-ui/icons/chat.svg", command: run("chat.new") },
  ];
  for (const action of actions) {
    if (globalActions.some(a => a.commandId === action.commandId)) continue;
    globalActions.push({ isAvailable: () => true, extraPayload: {}, ...action });
  }
  log(`added ${actions.length} actions to Zen's command bar`);
}
