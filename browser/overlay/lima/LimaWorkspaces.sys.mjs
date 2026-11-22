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
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

import { lastVisibleTool, replyActivity } from "resource://lima/ui/tool-activity.sys.mjs";

const MAP_PREF = "lima.workspaces.sidebar";
const BOOKMARK_ROOT_PREF = "lima.workspaces.bookmarkRoot";
const MASCOT = "resource://lima-ui/marks/companion.svg";
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
  #deleting = new Set();
  #archived = new Set();
  #prompts = new Map();
  #chatMotion = new Map();
  #mascots = new Map();

  start() {
    if (this.#started) return;
    this.#started = true;
    lazy.LimaBridge.onEvent(message => {
      const data = message.data;
      switch (message.event) {
        case "workspace.created":
        case "workspace.updated":
          if (this.#archived.has(data.id)) break;
          this.#workspaces.set(data.id, data);
          this.#enqueue(() => this.reconcile(this.#workspaces.get(data.id)));
          break;
        case "workspace.deleted": {
          const workspace = this.#workspaces.get(data.id);
          this.#archived.add(data.id);
          this.#workspaces.delete(data.id);
          this.#focus.delete(data.id);
          this.#chatMotion.delete(data.id);
          this.#mascots.delete(workspace?.conversationID);
          this.#enqueue(() => this.remove(data.id, data.parentId, workspace));
          break;
        }
        case "chat.updated": {
          this.#mascots.set(data.id, data.mascot ?? "classic");
          const workspace = this.workspaces.find(item => item.conversationID === data.id);
          if (!workspace) break;
          const message = data.messages?.findLast(item => item.role === "assistant");
          const motion = replyActivity(message, { tool: lastVisibleTool(message?.tools), provider: data.provider })?.motion;
          this.#chatMotion.set(workspace.id, motion);
          this.#paintFocus(workspace.id);
          break;
        }
        case "workspace.tabClosed":
          this.#enqueue(() => {
            const win = this.#win();
            const folder = this.folderFor(data.id, "folder", win);
            const tab = folder && this.#allTabs(folder).find(item => this.workspaceForTab(item) === data.id && sameURL(tabURL(item), data.url));
            if (tab) win.gBrowser.removeTab(tab, { animate: true });
          });
          break;
        case "workspace.activity":
          this.#focus.set(data.id, data);
          this.#paintFocus(data.id);
          break;
        case "prompt.opened":
          this.#prompts.set(data.id, data.workspaceId);
          this.#paintFocus(data.workspaceId);
          this.#paintFocus(this.#workspaces.get(data.workspaceId)?.parentID);
          break;
        case "prompt.closed":
          this.#prompts.delete(data.id);
          this.#paintFocus(data.workspaceId);
          this.#paintFocus(this.#workspaces.get(data.workspaceId)?.parentID);
          break;
        case "workspace.browserRequest":
          this.#answer(data);
          break;
      }
    });
    this.#enqueue(async () => {
      for (const prompt of await lazy.LimaBridge.request("workspace.prompts").catch(() => [])) this.#prompts.set(prompt.id, prompt.workspaceId);
      const all = (await lazy.LimaBridge.request("workspace.list")).filter(workspace => !this.#archived.has(workspace.id));
      const chats = await lazy.LimaBridge.request("chat.list").catch(() => []);
      for (const chat of chats) {
        if (chat.workspaceID && !this.#mascots.has(chat.id)) this.#mascots.set(chat.id, chat.mascot ?? "classic");
      }
      for (const workspace of all) if (!this.#workspaces.has(workspace.id)) this.#workspaces.set(workspace.id, workspace);
      // Parents before helpers, so Agents folders have somewhere to go.
      for (const workspace of all.filter(w => !w.parentID)) await this.reconcile(this.#workspaces.get(workspace.id));
      for (const workspace of all.filter(w => w.parentID)) await this.reconcile(this.#workspaces.get(workspace.id));
      await this.#prune();
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
    const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    return win?.gZenFolders ? win : null;
  }

  folderFor(id, part = "folder", win = this.#win()) {
    const entryId = this.#map()[id]?.[part];
    const node = entryId ? win?.document.getElementById(entryId) : null;
    return node?.isZenFolder ? node : null;
  }

  /** The workspace a tab belongs to (nearest workspace folder). */
  workspaceForTab(tab) {
    if (tab?.hasAttribute?.("lima-helper-chat")) return tab.getAttribute("lima-helper-chat");
    const folder = tab?.closest?.("zen-folder[lima-workspace]");
    return folder ? folder.getAttribute("lima-workspace") : null;
  }

  // MARK: Reconcile

  async reconcile(workspace) {
    if (!workspace || this.#deleting.has(workspace.id)) return;
    const win = lazy.BrowserWindowTracker.orderedWindows.find(window => this.folderFor(workspace.id, "folder", window)) ?? this.#win();
    if (win) this.#reconcileFolder(win, workspace);
    if (!workspace.parentID) await this.#reconcileBookmarks(workspace);
  }

  #makeTab(win, workspace, entry) {
    const live = entry.url.startsWith("about:lima?");
    const tab = win.gBrowser.addTab(entry.url, {
      triggeringPrincipal: system(), inBackground: true, lazyTabTitle: entry.title, skipAnimation: true,
    });
    if (live) tab.setAttribute("undiscardable", "true");
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

  #createFolder(win, tabs, label, parent = null, collapsed = false) {
    const options = { label, collapsed };
    if (parent) options.insertAfter = parent.groupContainer.lastElementChild;
    return win.gZenFolders.createFolder(tabs, options);
  }

  #coreEntries(workspace) {
    const entries = [];
    if (workspace.conversationID) entries.push({ url: `about:lima?chat=${workspace.conversationID}`, title: "Chat", icon: MASCOT });
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

    const agentsWereCollapsed = parentFolder?.collapsed;
    let folder = this.folderFor(workspace.id, "folder", win);
    const core = this.#coreEntries(workspace);
    const web = workspace.tabs.filter(t => !t.url.startsWith("about:lima")).map(t => ({ url: t.url, title: t.title }));

    if (!folder) {
      const tabs = core.filter(e => !helper || !parentFolder.tabs.some(tab => tabURL(tab) === e.url)).map(e => this.#makeTab(win, workspace, e));
      folder = this.#createFolder(win, tabs, workspace.name, parentFolder, helper);
      this.#label(win, tabs);
      entry.folder = folder.id;
      map[workspace.id] = entry;
      this.#saveMap(map);
      log(`folder for “${workspace.name}”${helper ? " (agent)" : ""}`);
    }
    folder.setAttribute("lima-workspace", workspace.id);
    if (workspace.companionTask && !folder.hasAttribute("lima-companion-task")) {
      folder.setAttribute("lima-companion-task", "");
      const first = [...folder.parentElement.children].find(node => node !== folder && (node.isZenFolder || node.localName === "tab"));
      if (first) first.before(folder);
      win.gBrowser.tabContainer._invalidateCachedTabs();
    }
    if (helper) folder.setAttribute("lima-agent", "true");
    if (folder.label !== workspace.name) folder.label = workspace.name;

    const chatURL = workspace.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const detached = helper && [...parentFolder.tabs].find(tab => tab.group === parentFolder && tabURL(tab) === chatURL);
    if (detached) {
      folder.addTabs([detached]);
      detached.removeAttribute("lima-helper-chat");
      if (agentsWereCollapsed) parentFolder.collapsed = true;
    }
    const label = folder.querySelector(":scope > .tab-group-label-container");
    if (label && !label.querySelector(".lima-workspace-disclosure")) {
      const disclosure = win.document.createElementNS("http://www.w3.org/1999/xhtml", "button");
      disclosure.className = "lima-workspace-disclosure";
      disclosure.title = "Toggle workspace items";
      disclosure.setAttribute("aria-label", disclosure.title);
      for (const type of ["mousedown", "mouseup", "click"]) disclosure.addEventListener(type, event => {
        event.stopPropagation();
        if (event.type === "click") folder.collapsed = !folder.collapsed;
      });
      label.append(disclosure);
    }

    // Core tabs: add missing ones, drop terminals/chats the workspace replaced.
    const wanted = new Set([...core, ...web].map(e => e.url));
    let replaceSelectedTerminal = false;
    for (const tab of folder.tabs) {
      if (tab.group !== folder) continue;
      const url = tabURL(tab);
      if (/^about:lima\?(terminal|chat|workspace)=/.test(url) && !wanted.has(url)) {
        replaceSelectedTerminal ||= tab.selected && url.startsWith("about:lima?terminal=");
        win.gBrowser.removeTab(tab, { animate: false });
      }
    }
    const allTabs = () => this.#allTabs(folder).filter(tab => this.workspaceForTab(tab) === workspace.id);
    const present = () => new Set(allTabs().map(tabURL));
    const missingCore = core.filter(e => !present().has(e.url));
    if (missingCore.length) {
      const added = missingCore.map(e => this.#makeTab(win, workspace, e));
      folder.addTabs(added);
      const terminal = replaceSelectedTerminal && added.find(tab => tabURL(tab).startsWith("about:lima?terminal="));
      if (terminal) win.gBrowser.selectedTab = terminal;
      // Chat first, then Terminal, then notes, then sub-folders.
      this.#orderCore(win, folder);
      win.setTimeout(() => this.#orderCore(win, folder), 700);
      this.#label(win, added);
      added.filter(tab => tabURL(tab).startsWith("about:lima?note=")).forEach(tab => this.#animateTab(tab));
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
      added.forEach(tab => this.#animateTab(tab));
    }
    this.folderFor(workspace.id, "tabs", win)?.setAttribute("lima-tabs", workspace.id);
    this.#orderCore(win, folder);
    // Restored lazy tabs come back without our icons.
    for (const tab of allTabs()) {
      const url = tabURL(tab);
      tab.toggleAttribute("lima-workspace-chat", url === chatURL);
      if (url?.startsWith("about:lima?")) {
        tab.setAttribute("undiscardable", "true");
        if (tab.hasAttribute("pending") && !tab.hasAttribute("lima-reactivating")) {
          tab.setAttribute("lima-reactivating", "true");
          win.gBrowser.insertBrowser(tab);
          tab.linkedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: system(), loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY });
        }
      }
      if (!tab.hasAttribute("pending") || tab.getAttribute("image")) continue;
      const icon = url?.startsWith("about:lima?chat=") ? MASCOT : url?.startsWith("about:lima?terminal=") ? TERMINAL_ICON : url?.startsWith("about:lima?note=") ? NOTE_ICON : null;
      if (icon) { tab.setAttribute("lima-icon", icon); try { win.gBrowser.setIcon(tab, icon); } catch {} }
    }
    this.#paintFocus(workspace.id);
  }

  /** Chat, Terminal, notes first; sub-folders (Tabs, Agents) after them. */
  #orderCore(win, folder) {
    const rank = tab => {
      const url = tabURL(tab);
      return url?.startsWith("about:lima?chat=") ? 1 : url?.startsWith("about:lima?terminal=") ? 2 : url?.startsWith("about:lima?note=") ? 3 : 4;
    };
    const children = [...folder.groupContainer.children].filter(node => !node.hasAttribute?.("zen-empty-tab") && (node.isZenFolder || node.localName === "tab"));
    const firstFolder = children.find(node => node.isZenFolder);
    if (!firstFolder) return;
    const core = children.filter(node => node.localName === "tab" && rank(node) < 4);
    const sorted = [...core].sort((a, b) => rank(a) - rank(b));
    const inOrder = sorted.every((tab, i) => tab === core[i]) && core.every(tab => children.indexOf(tab) < children.indexOf(firstFolder));
    if (inOrder) return;
    for (const tab of sorted) {
      try { win.gBrowser.moveTabBefore(tab, firstFolder); } catch (error) { log(`reorder: ${error}`); }
    }
  }

  #allTabs(folder) {
    return folder.allItemsRecursive.filter(item => !item.isZenFolder && !item.hasAttribute("zen-empty-tab") && item.localName === "tab");
  }

  #agentsFolder(win, parentID, map) {
    const parent = this.folderFor(parentID, "folder", win);
    if (!parent) return null;
    let agents = this.folderFor(parentID, "agents", win);
    if (agents && agents.group === parent) {
      agents.setAttribute("lima-agents", parentID);
      return agents;
    }
    agents = this.#createFolder(win, [], "Agents", parent, true);
    agents.setAttribute("lima-agents", parentID);
    map[parentID] = { ...(map[parentID] ?? {}), agents: agents.id };
    this.#saveMap(map);
    return agents;
  }

  /** Forget folders of workspaces that no longer exist. */
  async #prune() {
    for (const id of Object.keys(this.#map())) {
      if (!this.#workspaces.has(id)) await this.remove(id);
    }
  }

  async remove(id, parentID, workspace) {
    const map = this.#map();
    const urls = new Set([`about:lima?workspace=${id}`]);
    if (workspace?.conversationID) urls.add(`about:lima?chat=${workspace.conversationID}`);
    if (workspace?.terminalID) urls.add(`about:lima?terminal=${workspace.terminalID}`);
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      if (!win.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) continue;
      const folder = this.folderFor(id, "folder", win);
      if (folder) {
        // Sidebar nesting is organizational. Keep any independently owned
        // workspace folders when deleting their surrounding folder.
        for (const child of folder.querySelectorAll("zen-folder[lima-workspace]:not([lima-agent])")) {
          if (child.parentElement.closest("zen-folder[lima-workspace]") !== folder) continue;
          folder.before(child);
        }
        win.gBrowser.tabContainer._invalidateCachedTabs();
        await folder.delete();
      }
      // A workspace tab may have been detached before its folder was removed.
      // Close Lima's own surfaces while leaving detached web pages independent.
      const tabs = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)];
      for (const tab of tabs) {
        const owner = lazy.SessionStore.getCustomTabValue(tab, "lima-workspace");
        const current = tab.linkedBrowser?.currentURI?.spec;
        const url = current && current !== "about:blank" ? current : tabURL(tab);
        if (urls.has(url) || (owner === id && /^about:lima\?(workspace|chat|terminal)=/.test(url))) {
          win.gBrowser.removeTab(tab, { animate: true });
        }
      }
      if (parentID) {
        const agents = this.folderFor(parentID, "agents", win);
        if (agents && !agents.allItems.some(item => item.isZenFolder)) {
          await agents.delete();
          delete map[parentID]?.agents;
        }
      }
    }
    delete map[id];
    this.#saveMap(map);
  }

  onFolderRemoved(event) {
    const folder = event.target;
    const id = folder.getAttribute?.("lima-workspace");
    if (!id || event.detail?.adopting || this.#deleting.has(id)) return;
    const workspace = this.#workspaces.get(id);
    if (!workspace || this.#deleting.has(workspace.parentID)) return;
    const win = folder.ownerDocument.defaultView;
    if (!win || win.closed) return;
    // Zen emits this before closing. The same group can be reinserted or
    // adopted as part of a move. Check after the DOM removal animation.
    const check = () => win.setTimeout(() => {
      if (this.#deleting.has(id) || !this.#workspaces.has(id)) return;
      if (lazy.BrowserWindowTracker.orderedWindows.some(window => this.folderFor(id, "folder", window))) return;
      this.archive(win, id, { removedFolder: folder });
    }, 0);
    folder.addEventListener("TabGroupRemovedFromDOM", check, { once: true });
  }

  async archive(win, id, { removedFolder } = {}) {
    const workspace = this.#workspaces.get(id);
    if (!workspace || this.#deleting.has(id)) return;
    this.#deleting.add(id);
    const folder = this.folderFor(id, "folder", win);
    let archived = false;
    const perform = async () => {
      folder?.setAttribute("lima-archiving", "true");
      try {
        const result = await lazy.LimaBridge.request("workspace.delete", { id });
        archived = true;
        return result;
      } finally { folder?.removeAttribute("lima-archiving"); }
    };
    try {
      await this.#archivePanel(win, workspace, folder, perform);
    } finally {
      this.#deleting.delete(id);
      if (!archived && removedFolder) this.#enqueue(() => this.reconcile(this.#workspaces.get(id)));
    }
  }

  #archivePanel(win, workspace, folder, perform) {
    const doc = win.document;
    const panel = doc.createXULElement("panel");
    panel.className = "lima-archive-panel";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautohide", "true");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", workspace.parentID ? "Dismiss agent" : "Archive workspace");
    const element = (tag, className, text) => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const heading = element("strong", "", workspace.parentID ? "Dismiss agent" : "Archive workspace");
    const description = element("p", "lima-archive-description", workspace.parentID
      ? `Close ${workspace.name} and its tabs?`
      : `Close ${workspace.name} and verify a ZIP of its files. Linked or shared folders keep their originals.`);
    const path = element("p", "lima-archive-path", workspace.parentID ? "" : workspace.directory);
    const status = element("p", "lima-archive-status");
    status.setAttribute("role", "status");
    const cancel = element("button", "", "Cancel");
    const action = element("button", "lima-archive-action", workspace.parentID ? "Dismiss" : "Archive");
    const controls = element("div", "lima-archive-actions");
    controls.append(cancel, action);
    const content = element("div", "lima-archive-content");
    content.append(heading, description, path, status, controls);
    panel.append(content);
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(panel);
    let busy = false;
    cancel.onclick = () => panel.hidePopup();
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) panel.hidePopup();
      }
    });
    action.onclick = async () => {
      if (busy) return;
      busy = action.disabled = cancel.disabled = true;
      status.textContent = workspace.parentID ? "Dismissing agent…" : "Creating and verifying the ZIP…";
      try {
        const result = await perform();
        heading.textContent = workspace.parentID ? "Agent dismissed" : "Workspace archived";
        description.textContent = result?.recoveryPath ? `A recovery copy remains at ${result.recoveryPath}` : "";
        path.textContent = result?.archivePath ?? "";
        status.textContent = result?.directoryKept && !workspace.parentID ? "The original folder is still available." : "";
        action.hidden = true;
        cancel.textContent = "Done";
      } catch (error) {
        status.textContent = error.message;
        action.textContent = "Retry";
      } finally {
        busy = action.disabled = cancel.disabled = false;
        (action.hidden ? cancel : action).focus();
      }
    };
    return new Promise(resolve => {
      const finish = () => { win.removeEventListener("unload", finish); panel.remove(); resolve(); };
      panel.addEventListener("popuphidden", finish, { once: true });
      win.addEventListener("unload", finish, { once: true });
      panel.addEventListener("popupshown", () => cancel.focus(), { once: true });
      // Use a stable toolbar anchor so closing the folder doesn't close the confirmation.
      const anchor = doc.getElementById("lima-settings-button") ?? folder ?? doc.getElementById("navigator-toolbox");
      panel.openPopup(anchor, "before_start");
    });
  }

  #animateTab(tab) {
    if (tab.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    tab.querySelector(".tab-content")?.animate(
      [{ opacity: 0.55, transform: "translateX(-5px)" }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
    );
  }

  /** User closed a page the agent had opened: drop it from desired state. */
  onTabClose(tab) {
    const id = this.workspaceForTab(tab);
    const url = tabURL(tab);
    const folder = tab.closest("zen-folder[lima-workspace]");
    if (!id || !url || url.startsWith("about:lima")) return;
    tab.ownerDocument.defaultView.setTimeout(() => {
      const workspace = this.#workspaces.get(id);
      if (!workspace || this.#deleting.has(id) || this.#deleting.has(workspace.parentID) || !folder?.isConnected) return;
      lazy.LimaBridge.request("workspace.closeTab", { id, url }).catch(() => {});
    }, 0);
  }

  onTabSelect(win) {
    const selected = win.gBrowser.selectedTab;
    const id = this.workspaceForTab(selected);
    for (const folder of win.document.querySelectorAll("zen-folder[lima-workspace]")) {
      folder.toggleAttribute("lima-chat-selected", folder.getAttribute("lima-workspace") === id && selected.hasAttribute("lima-workspace-chat"));
    }
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

  /** Tab menu → Add Tab to Workspace: the page joins the workspace's Tabs
   * folder, where its agent can read and act on it. */
  addTab(win, id, tab) {
    const workspace = this.#workspaces.get(id);
    const folder = this.folderFor(id, "folder", win);
    if (!workspace || !folder) throw new Error("This workspace isn't in the sidebar of this window.");
    const url = tabURL(tab);
    if (!/^https?:/.test(url)) throw new Error("Only web pages can be added to a workspace.");
    if (tab.pinned) win.gBrowser.unpinTab(tab);
    let tabs = this.folderFor(id, "tabs", win);
    if (tabs && tabs.group === folder) tabs.addTabs([tab]);
    else {
      tabs = this.#createFolder(win, [tab], "Tabs", folder);
      tabs.setAttribute("lima-tabs", id);
      const map = this.#map();
      map[id] = { ...(map[id] ?? {}), tabs: tabs.id };
      this.#saveMap(map);
    }
    try { lazy.SessionStore.setCustomTabValue(tab, "lima-workspace", id); } catch {}
    tabs.collapsed = false;
    this.#animateTab(tab);
    return workspace;
  }

  /** Top-level workspaces shown in this window's sidebar, for menus. */
  roots(win) {
    return this.workspaces.filter(workspace => !workspace.parentID && this.folderFor(workspace.id, "folder", win));
  }

  /** Called when the user renames a workspace folder inline. */
  onFolderRenamed(folder) {
    const id = folder.getAttribute("lima-workspace");
    if (!id || folder.label === this.#workspaces.get(id)?.name) return;
    lazy.LimaBridge.request("workspace.rename", { id, name: folder.label }).catch(error => log(`rename: ${error.message}`));
  }

  // MARK: Prism: where the agent is

  #paintFocus(id) {
    if (!id) return;
    const win = this.#win();
    const folder = win && this.folderFor(id, "folder", win);
    if (!folder) return;
    const state = this.#focus.get(id) ?? { surface: "idle" };
    const workspace = this.#workspaces.get(id);
    const own = this.#allTabs(workspace?.parentID && folder.group?.isZenFolder ? folder.group : folder).filter(tab => this.workspaceForTab(tab) === id);
    folder.setAttribute("lima-mascot", this.#mascots.get(workspace?.conversationID) ?? "classic");
    const chatURL = workspace?.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const activeURL = { chat: chatURL, tab: state.url, terminal: `about:lima?terminal=${workspace?.terminalID}` }[state.surface];
    folder.toggleAttribute("lima-chat-selected", own.some(tab => tab.selected && tabURL(tab) === chatURL));
    for (const tab of own) {
      const next = sameURL(tabURL(tab), activeURL) ? (state.surface === "chat" ? "thinking" : "here") : "";
      if (!next) tab.removeAttribute("lima-ai");
      else if (tab.getAttribute("lima-ai") !== next) {
        tab.setAttribute("lima-ai", next);
        if (next === "here") this.#animateTab(tab);
      }
    }
    const motion = { terminal: "terminal", tab: "tabs", chat: this.#chatMotion.get(id) || "think" }[state.surface];
    if (motion) folder.setAttribute("lima-motion", motion); else folder.removeAttribute("lima-motion");
    const nextFolder = { chat: "thinking", tab: "working", terminal: "working" }[state.surface];
    if (nextFolder) folder.setAttribute("lima-ai", nextFolder);
    else folder.removeAttribute("lima-ai");
    folder.toggleAttribute("lima-attention", [...this.#prompts.values()].some(owner => owner === id || this.#workspaces.get(owner)?.parentID === id));
    const tabs = this.folderFor(id, "tabs", win);
    if (tabs && state.surface === "tab") {
      tabs.collapsed = false;
      tabs.setAttribute("lima-ai-opened", "true");
    } else if (tabs?.hasAttribute("lima-ai-opened")) {
      tabs.removeAttribute("lima-ai-opened");
      tabs.collapsed = true;
    }
  }

  // MARK: Requests from the runtime

  async #answer(request) {
    const reply = (result, error) => lazy.LimaBridge.request("workspace.browserReply", error ? { requestId: request.requestId, error } : { requestId: request.requestId, result }).catch(() => {});
    try {
      const win = this.#win();
      if (!win || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) throw new Error("Open a regular Lima window.");
      if (request.kind === "finishCompanionTask") {
        await this.#queue;
        const folder = this.folderFor(request.workspaceId, "folder", win);
        if (!folder) throw new Error("The Companion task is unavailable.");
        const keep = this.#allTabs(folder).filter(tab => {
          const url = tabURL(tab);
          return url.startsWith("about:lima?note=") || (request.keepWebTabs && /^https?:/.test(url));
        });
        for (const tab of keep) {
          while (tab.group?.isZenFolder && folder.contains(tab)) {
            const previous = tab.group;
            win.gBrowser.ungroupTab(tab);
            if (tab.group === previous) throw new Error("A result tab couldn’t be moved.");
          }
          lazy.SessionStore.deleteCustomTabValue(tab, "lima-workspace");
        }
        return reply({ kept: keep.length });
      }
      if (request.kind === "location") return reply(await this.#approximateLocation(win));
      if (request.kind === "listTabs") return reply(this.#pages(win, request.workspaceId).map(tab => ({ url: tabURL(tab), title: tab.label, selected: tab.selected })));
      if (request.kind === "action") return reply(await this.#act(win, request));
      if (request.kind === "readTab") return reply(await this.#read(win, request.workspaceId, request.url));
      throw new Error(`unknown request ${request.kind}`);
    } catch (error) {
      reply(null, String(error.message ?? error));
    }
  }

  #approximateLocation(win) {
    return new Promise((resolve, reject) => {
      const service = win.navigator.geolocation;
      if (!service) { reject(new Error("Location Services are unavailable.")); return; }
      service.getCurrentPosition(({ coords }) => {
        const round = value => Math.round(value * 100) / 100;
        resolve({ latitude: round(coords.latitude), longitude: round(coords.longitude),
          accuracyMeters: Math.max(1500, Math.ceil(coords.accuracy / 100) * 100) });
      }, failure => reject(new Error(failure.code === 1 ? "Location access is off for Lima." : "Lima couldn’t get a location estimate.")),
      { enableHighAccuracy: false, maximumAge: 0, timeout: 16000 });
    });
  }

  /** Web pages the agent may work in: its Tabs folder, or a helper's own folder. */
  #pages(win, id) {
    const workspace = this.#workspaces.get(id);
    const container = workspace?.parentID ? this.folderFor(id, "folder", win) : this.folderFor(id, "tabs", win);
    if (!container) return [];
    return this.#allTabs(container).filter(tab => /^https?:/.test(tabURL(tab)) && (!workspace?.parentID || tab.group === container));
  }

  async #act(win, request) {
    let tab = this.#pages(win, request.workspaceId).find(item => sameURL(tabURL(item), request.url));
    for (let retry = 0; !tab && retry < 30; retry++) {
      await new Promise(resolve => win.setTimeout(resolve, 100));
      tab = this.#pages(win, request.workspaceId).find(item => sameURL(tabURL(item), request.url));
    }
    if (!tab) throw new Error("The workspace tab is unavailable. Reopen its original URL with workspace_open_tab, then inspect it.");
    const browser = await this.#loaded(win, tab, request.url, false);
    const origin = new URL(request.url).origin;
    const global = browser.browsingContext?.currentWindowGlobal;
    if (!global || global.documentURI.spec === "about:blank") {
      throw new Error("The page has not loaded. Inspect again after it opens.");
    }
    if (new URL(global.documentURI.spec).origin !== origin) {
      throw new Error(`The page is now on ${new URL(global.documentURI.spec).origin}. Open that site as a workspace tab and request a separate plan if it is within the task.`);
    }
    if (request.paths && !request.paths.includes(new URL(browser.currentURI.spec).pathname)) {
      throw new Error("This path is outside the approved plan. Inspect the current page and request approval if the new path is needed.");
    }
    if (request.action === "screenshot") {
      const width = Math.max(1, browser.clientWidth), height = Math.max(1, browser.clientHeight);
      const image = await global.drawSnapshot(new win.DOMRect(0, 0, width, height), Math.min(1, 960 / width, 780 / height), "#0d0e10");
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d").drawImage(image, 0, 0);
      image.close();
      return { jpeg: canvas.toDataURL("image/jpeg", 0.76).split(",")[1] };
    }
    const data = { origin, paths: request.paths, action: request.action, options: request.options };
    let result;
    try {
      result = await global.getActor("LimaPage").sendQuery("action", data);
    } catch (error) {
      const live = browser.browsingContext?.currentWindowGlobal;
      if (live === global) throw error;
      if (!live || request.action !== "inspect") {
        throw new Error("The page changed during the action. Inspect again to see whether the action took effect before attempting it again.");
      }
      result = await live.getActor("LimaPage").sendQuery("action", data);
    }
    if (result.pointer) this.#showAction(win, browser, result.pointer, request.action);
    return result;
  }

  #showAction(win, browser, pointer, action) {
    if (!["click", "type"].includes(action) || win.gBrowser.selectedBrowser !== browser) return;
    const { x, y } = pointer;
    const bounds = browser.getBoundingClientRect();
    const zoom = browser.fullZoom || 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x * zoom > bounds.width || y * zoom > bounds.height) return;
    const doc = win.document;
    doc.getElementById("lima-agent-pointer")?.remove();
    const marker = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    marker.id = "lima-agent-pointer";
    marker.dataset.action = action;
    marker.setAttribute("aria-hidden", "true");
    marker.style.left = `${bounds.left + x * zoom}px`;
    marker.style.top = `${bounds.top + y * zoom}px`;
    marker.textContent = action === "type" ? "Typing" : "";
    (doc.getElementById("browser") ?? doc.documentElement).append(marker);
    const clear = () => { marker.remove(); win.gBrowser.tabContainer.removeEventListener("TabSelect", clear); };
    win.gBrowser.tabContainer.addEventListener("TabSelect", clear, { once: true });
    win.setTimeout(clear, action === "type" ? 1450 : 760);
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
  async #loaded(win, tab, url, settle = true) {
    const gBrowser = win.gBrowser;
    const pending = tab.hasAttribute("pending");
    if (!tab.linkedPanel) gBrowser.insertBrowser(tab);
    const browser = tab.linkedBrowser;
    if (pending || !browser.currentURI || browser.currentURI.spec === "about:blank") {
      browser.loadURI(Services.io.newURI(tabURL(tab) || url), { triggeringPrincipal: system() });
    }
    for (let i = 0; i < 150; i++) {
      const doc = browser.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? "";
      if (/^https?:/.test(doc) && (!settle || !browser.webProgress?.isLoadingDocument)) break;
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
