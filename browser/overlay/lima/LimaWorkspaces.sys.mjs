import { SETTLE } from "resource://lima/LimaMotion.sys.mjs";
import { characterArt, generateMascot, mascotColors } from "resource://lima/ui/mascot-look.sys.mjs";
/* AI workspaces in Zen's sidebar (docs/architecture/sidebar-workspaces.md).
 *
 *   ✦ Name            zen-folder[lima-workspace]; the ✦ icon opens Chat
 *     Chat            about:lima?chat=<conversation>
 *     Terminal        about:lima?terminal=<id>  (files | terminal)
 *     <notes>         notes the agent wrote
 *     ▸ Tabs          web pages the agent works in (and any you drop in)
 *     ▸ Images        raster, vector, and animation Studio tabs
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
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  broadcastToLimaPages: "resource://lima/actors/LimaParent.sys.mjs",
});

import { LimaVisualActivity } from "resource://lima/LimaVisualActivity.sys.mjs";
import { preserveFolderDisclosure } from "resource://lima/LimaFolderDisclosure.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const MAP_PREF = "lima.workspaces.sidebar";
const BOOKMARK_ROOT_PREF = "lima.workspaces.bookmarkRoot";
const MASCOT = "resource://lima-ui/marks/companion.svg";
const TERMINAL_ICON = "resource://lima-ui/icons/terminal.svg";
const NOTE_ICON = "resource://lima-ui/icons/note.svg";
const IMAGE_ICON = "resource://lima-ui/icons/image.svg";

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

export function imageWorkspaceForURL(url) {
  if (!url?.startsWith("about:lima?")) return null;
  const params = new URL(url).searchParams;
  return params.get("view") === "image" ? params.get("imageWorkspace") : null;
}

export function approximateLocation(win) {
  return new Promise((resolve, reject) => {
    if (!Services.prefs.getBoolPref("lima.location.enabled", false)) {
      reject(new Error("Allow location in Lima Settings → Personal Memory first."));
      return;
    }
    const service = win.navigator.geolocation;
    if (!service) { reject(new Error("Location Services are unavailable.")); return; }
    service.getCurrentPosition(({ coords }) => {
      if (!Services.prefs.getBoolPref("lima.location.enabled", false)) {
        reject(new Error("Location access was turned off."));
        return;
      }
      const round = value => Math.round(value * 100) / 100;
      resolve({ latitude: round(coords.latitude), longitude: round(coords.longitude),
        accuracyMeters: Math.max(1500, Math.ceil(coords.accuracy / 100) * 100) });
    }, failure => reject(new Error(failure.code === 1 ? "Allow Lima under macOS Location Services, then try again." : "Lima couldn’t get a location estimate.")),
    { enableHighAccuracy: false, maximumAge: 0, timeout: 16000 });
  });
}

class Workspaces {
  #started = false;
  #queue = Promise.resolve();
  #mapValue = null;
  #renaming = new Set();
  #mapRaw = null;
  #workspaces = new Map();
  #visuals = {};
  #observed = new WeakSet();
  #mascotTemplates = new WeakMap();
  #observers = new WeakMap();
  #deleting = new Set();
  #archived = new Set();
  #mascots = new Map();
  #seenWorkspaceNotes = new Set();
  #finishedHelpers = new Set();
  /** Workspace ID → its scheduled tasks (id → next run, ms) still to come. */
  #schedules = new Map();

  #noteSchedule(task) {
    for (const [workspaceID, tasks] of this.#schedules) {
      if (tasks.delete(task.id) && !tasks.size) this.#schedules.delete(workspaceID);
      if (workspaceID !== task.workspaceID) this.#paintFocus(workspaceID);
    }
    if (task.workspaceID && task.state === "scheduled" && task.nextRunAt) {
      if (!this.#schedules.has(task.workspaceID)) this.#schedules.set(task.workspaceID, new Map());
      this.#schedules.get(task.workspaceID).set(task.id, { at: task.nextRunAt, label: task.nextRunLabel, title: task.title });
    }
    if (task.workspaceID) this.#paintFocus(task.workspaceID);
  }

  start() {
    if (this.#started) return;
    this.#started = true;
    lazy.LimaBridge.request("schedule.list").then(tasks => { for (const task of tasks ?? []) this.#noteSchedule(task); }).catch(() => {});
    lazy.LimaBridge.onEvent(message => {
      const data = message.data;
      switch (message.event) {
        case "schedule.updated":
          this.#noteSchedule(data);
          break;
        case "schedule.deleted":
          this.#noteSchedule({ id: data.id });
          break;
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
          this.#finishedHelpers.delete(data.id);
          this.#mascots.delete(workspace?.conversationID);
          this.#enqueue(() => this.remove(data.id, data.parentId, workspace));
          break;
        }
        case "chat.updated": {
          if (!data.workspaceID) break;
          if (this.#workspaces.get(data.workspaceID)?.parentID) {
            const reply = data.messages?.findLast(message => message.role === "assistant");
            const finished = reply?.status === "complete" && !data.messages.some(message => ["streaming", "queued"].includes(message.status));
            const changed = this.#finishedHelpers.has(data.workspaceID) !== finished;
            if (finished) this.#finishedHelpers.add(data.workspaceID); else this.#finishedHelpers.delete(data.workspaceID);
            if (changed) this.#enqueue(() => this.reconcile(this.#workspaces.get(data.workspaceID)));
          }
          const mascot = data.mascot ?? "classic";
          if (this.#mascots.get(data.id) !== mascot) {
            this.#mascots.set(data.id, mascot);
            this.#paintFocus(data.workspaceID);
          }
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
        case "workspace.browserRequest":
          this.#answer(data);
          break;
      }
    });
    LimaVisualActivity.subscribe(({ workspaces }) => {
      const previous = this.#visuals;
      this.#visuals = workspaces;
      for (const id of new Set([...Object.keys(previous), ...Object.keys(workspaces)])) {
        if (JSON.stringify(previous[id]) !== JSON.stringify(workspaces[id])) this.#paintFocus(id);
      }
    });
    const repaint = () => { for (const workspace of this.workspaces) this.#paintFocus(workspace.id); };
    Services.prefs.addObserver("lima.mascotTheme", repaint);
    Services.obs.addObserver(repaint, "lima-theme-changed");
    this.#enqueue(async () => {
      const all = (await lazy.LimaBridge.request("workspace.list")).filter(workspace => !this.#archived.has(workspace.id));
      const chats = await lazy.LimaBridge.request("chat.list").catch(() => []);
      for (const chat of chats) {
        if (chat.workspaceID && chat.lastStatus === "complete" && !chat.running) this.#finishedHelpers.add(chat.workspaceID);
        if (chat.workspaceID && !this.#mascots.has(chat.id)) this.#mascots.set(chat.id, chat.mascot ?? "classic");
      }
      for (const workspace of all) if (!this.#workspaces.has(workspace.id)) this.#workspaces.set(workspace.id, workspace);
      // Parents before helpers, so Agents folders have somewhere to go.
      for (const workspace of all.filter(w => !w.parentID)) await this.reconcile(this.#workspaces.get(workspace.id));
      for (const workspace of all.filter(w => w.parentID)) await this.reconcile(this.#workspaces.get(workspace.id));
      await this.#prune();

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
    const raw = Services.prefs.getStringPref(MAP_PREF, "{}");
    if (raw !== this.#mapRaw || !this.#mapValue) {
      this.#mapRaw = raw;
      try { this.#mapValue = JSON.parse(raw); } catch { this.#mapValue = {}; }
    }
    return this.#mapValue;
  }

  #saveMap(map) {
    this.#mapRaw = JSON.stringify(map);
    this.#mapValue = map;
    Services.prefs.setStringPref(MAP_PREF, this.#mapRaw);
  }

  #win() {
    const win = lazy.BrowserWindowTracker.getTopWindow({ private: false });
    return win?.gZenFolders ? win : null;
  }

  /** Where each top-level workspace sits in the sidebar, in sidebar order,
   * with the user's own folders around it (outermost first). */
  layout(win = this.#win()) {
    if (!win) return [];
    const rows = [];
    for (const folder of win.document.querySelectorAll("zen-folder[lima-workspace]:not([lima-agent])")) {
      const folders = [];
      let nested = false;
      for (let group = folder.group; group?.isZenFolder; group = group.group) {
        if (group.hasAttribute("lima-workspace")) { nested = true; break; }
        folders.unshift({ id: group.id, label: String(group.label ?? "").slice(0, 80) });
      }
      if (!nested) rows.push({ id: folder.getAttribute("lima-workspace"), folders, pinned: !!folder.pinned });
    }
    return rows;
  }

  /** Tells open Lima pages (the Companion) when folders move or are renamed. */
  watchLayout(win) {
    if (win.limaLayoutWatch || lazy.PrivateBrowsingUtils?.isWindowPrivate?.(win)) return;
    let last = "";
    let timer = null;
    const send = () => {
      timer = null;
      const layout = this.layout(win);
      const text = JSON.stringify(layout);
      if (text === last) return;
      last = text;
      lazy.broadcastToLimaPages("workspace.layout", layout);
    };
    const observer = new win.MutationObserver(() => { if (!timer) timer = win.setTimeout(send, 400); });
    const root = win.document.getElementById("tabbrowser-tabs") ?? win.gBrowser.tabContainer;
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["label", "lima-workspace"] });
    win.limaLayoutWatch = observer;
    win.addEventListener("unload", () => { observer.disconnect(); if (timer) win.clearTimeout(timer); }, { once: true });
    send();
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
    else {
      if (win) this.#updateDone(win, workspace.parentID);
      let root = workspace;
      while (root.parentID && this.#workspaces.has(root.parentID)) root = this.#workspaces.get(root.parentID);
      if (!root.parentID) await this.#reconcileBookmarks({ ...workspace, name: root.name, id: root.id, bookmarks: [] });
    }
  }

  #makeTab(win, workspace, entry) {
    const tab = win.gBrowser.addTab(entry.url, {
      triggeringPrincipal: system(), inBackground: true, lazyTabTitle: entry.title, skipAnimation: true,
    });
    this.#configureTab(win, tab, workspace, entry);
    return tab;
  }

  #configureTab(win, tab, workspace, entry) {
    if (entry.url.startsWith("about:lima?")) tab.setAttribute("undiscardable", "true");
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
    return preserveFolderDisclosure(parent, () => win.gZenFolders.createFolder(tabs, options));
  }

  #coreEntries(workspace) {
    const entries = [];
    if (workspace.conversationID) entries.push({ url: `about:lima?chat=${workspace.conversationID}`, title: "Chat", icon: MASCOT });
    for (const tab of workspace.tabs.filter(t => t.url.startsWith("about:lima") && !imageWorkspaceForURL(t.url))) {
      entries.push({ url: tab.url, title: tab.title, icon: NOTE_ICON });
    }
    return entries;
  }

  #reconcileFolder(win, workspace) {
    const map = this.#map();
    const entry = map[workspace.id] ?? {};
    const helper = !!workspace.parentID;
    let parentFolder = null;
    if (helper) {
      parentFolder = this.#finishedHelpers.has(workspace.id)
        ? this.#doneFolder(win, workspace.parentID, map)
        : this.#agentsFolder(win, workspace.parentID, map);
      if (!parentFolder) return; // parent not shown yet; reconciled again with it
    }

    let folder = this.folderFor(workspace.id, "folder", win);
    const core = this.#coreEntries(workspace);
    const web = workspace.tabs.filter(t => !t.url.startsWith("about:lima")).map(t => ({ url: t.url, title: t.title }));

    if (!folder) {
      const tabs = core.filter(e => !helper || !parentFolder.tabs.some(tab => tabURL(tab) === e.url)).map(e => this.#makeTab(win, workspace, e));
      folder = this.#createFolder(win, tabs, workspace.name, parentFolder, true);
      this.#label(win, tabs);
      entry.folder = folder.id;
      map[workspace.id] = entry;
      this.#saveMap(map);
      log(`folder for “${workspace.name}”${helper ? " (agent)" : ""}`);
    }
    if (helper && folder.group !== parentFolder) {
      preserveFolderDisclosure(parentFolder, () => parentFolder.groupContainer.append(folder));
      win.gBrowser.tabContainer._invalidateCachedTabs();
    }
    folder.setAttribute("lima-workspace", workspace.id);
    if (workspace.companionTask && !folder.hasAttribute("lima-companion-task")) {
      folder.setAttribute("lima-companion-task", "");
      const first = [...folder.parentElement.children].find(node => node !== folder && (node.isZenFolder || node.localName === "tab"));
      if (first) first.before(folder);
      win.gBrowser.tabContainer._invalidateCachedTabs();
    }
    if (helper) folder.setAttribute("lima-agent", "true");
    // A rename the runtime hasn't saved yet wins over its old name.
    const renamedTo = entry.renamedTo;
    if (renamedTo && renamedTo !== workspace.name) {
      if (folder.label !== renamedTo) folder.label = renamedTo;
      if (!this.#renaming.has(workspace.id)) { this.#renaming.add(workspace.id); this.#sendRename(workspace.id, renamedTo).finally(() => this.#renaming.delete(workspace.id)); }
    } else if (folder.label !== workspace.name) folder.label = workspace.name;

    const chatURL = workspace.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const detached = helper && [...parentFolder.tabs].find(tab => tab.group === parentFolder && tabURL(tab) === chatURL);
    if (detached) {
      preserveFolderDisclosure(folder, () => folder.addTabs([detached]));
      detached.removeAttribute("lima-helper-chat");
    }
    const label = folder.querySelector(":scope > .tab-group-label-container");
    if (label && !label.querySelector(".lima-workspace-disclosure")) {
      const disclosure = win.document.createElementNS("http://www.w3.org/1999/xhtml", "button");
      disclosure.className = "lima-workspace-disclosure";
      const sync = () => {
        disclosure.title = folder.collapsed ? "Expand workspace items" : "Collapse workspace items";
        disclosure.setAttribute("aria-label", disclosure.title);
        disclosure.setAttribute("aria-expanded", String(!folder.collapsed));
      };
      sync();
      for (const type of ["TabGroupExpand", "TabGroupCollapse"]) {
        folder.addEventListener(type, event => { if (event.target === folder) sync(); });
      }
      for (const type of ["mousedown", "mouseup", "click"]) disclosure.addEventListener(type, event => {
        event.stopPropagation();
        if (event.type === "click") folder.collapsed = !folder.collapsed;
      });
      label.append(disclosure);
    }

    // Core tabs: add missing ones, drop terminals/chats the workspace replaced.
    const wanted = new Set([...core, ...web].map(e => e.url));
    const nextTerminal = core.find(item => item.url.startsWith("about:lima?terminal="));
    for (const tab of folder.tabs) {
      if (tab.group !== folder) continue;
      const url = tabURL(tab);
      if (/^about:lima\?(terminal|chat|workspace)=/.test(url) && !wanted.has(url)) {
        if (tab.selected && url.startsWith("about:lima?terminal=") && nextTerminal &&
            !folder.tabs.some(other => tabURL(other) === nextTerminal.url)) {
          this.#configureTab(win, tab, workspace, nextTerminal);
          tab.linkedBrowser.loadURI(Services.io.newURI(nextTerminal.url), { triggeringPrincipal: system(),
            loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY });
          continue;
        }
        win.gBrowser.removeTab(tab, { animate: false });
      }
    }
    const allTabs = () => this.#allTabs(folder).filter(tab => this.workspaceForTab(tab) === workspace.id);
    const present = () => new Set(allTabs().map(tabURL));
    const missingCore = core.filter(e => !present().has(e.url));
    if (missingCore.length) {
      const added = missingCore.map(e => this.#makeTab(win, workspace, e));
      preserveFolderDisclosure(folder, () => folder.addTabs(added));
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
      if (helper) preserveFolderDisclosure(folder, () => folder.addTabs(added));
      else {
        let tabsFolder = this.folderFor(workspace.id, "tabs", win);
        if (!tabsFolder || tabsFolder.group !== folder) {
          tabsFolder = this.#createFolder(win, added, "Tabs", folder, true);
          tabsFolder.setAttribute("lima-tabs", workspace.id);
          entry.tabs = tabsFolder.id;
          map[workspace.id] = entry;
          this.#saveMap(map);
        } else preserveFolderDisclosure(tabsFolder, () => tabsFolder.addTabs(added));
      }
      this.#label(win, added);
      added.forEach(tab => this.#animateTab(tab));
    }
    this.folderFor(workspace.id, "tabs", win)?.setAttribute("lima-tabs", workspace.id);
    if (!helper) this.#arrangeTabFolders(win, workspace, allTabs());
    this.#reconcileImages(win, workspace, folder, map, entry);
    this.#orderCore(win, folder);
    // Restored lazy tabs come back without our icons.
    for (const tab of allTabs()) {
      const url = tabURL(tab);
      tab.toggleAttribute("lima-workspace-chat", url === chatURL);
      if (url?.startsWith("about:lima?")) {
        tab.setAttribute("undiscardable", "true");
        if (tab.selected) this.#activateLimaTab(win, tab, url);
      }
      if (!tab.hasAttribute("pending") || tab.getAttribute("image")) continue;
      const icon = imageWorkspaceForURL(url) ? IMAGE_ICON : url?.startsWith("about:lima?chat=") ? MASCOT
        : url?.startsWith("about:lima?terminal=") ? TERMINAL_ICON : url?.startsWith("about:lima?note=") ? NOTE_ICON : null;
      if (icon) { tab.setAttribute("lima-icon", icon); try { win.gBrowser.setIcon(tab, icon); } catch {} }
    }
    this.#paintFocus(workspace.id);
  }

  #reconcileImages(win, workspace, parent, map, entry) {
    const id = workspace.id;
    const desired = new Set(workspace.tabs.filter(tab => imageWorkspaceForURL(tab.url) === id).map(tab => tab.url));
    let folder = this.folderFor(id, "images", win);
    if (folder?.group !== parent) folder = null;
    const existing = [...win.gBrowser.tabs].filter(tab => {
      if (tab.closing) return false;
      // A dormant note/chat is not an image tab. Skip session-state decoding
      // unless its live URI or Lima metadata identifies an image document.
      const current = tab.linkedBrowser?.currentURI?.spec;
      const url = tab.getAttribute("lima-url") || (current && current !== "about:blank" ? current : "") ||
        (tab.hasAttribute("pending") ? lazy.SessionStore.getCustomTabValue(tab, "lima-url") : "");
      if (imageWorkspaceForURL(url) !== id) return false;
      const owner = this.workspaceForTab(tab);
      return !owner || owner === id;
    });
    const present = new Set(existing.map(tabURL));
    const moving = existing.filter(tab => !folder || tab.group !== folder);
    for (const tab of moving) {
      const url = tabURL(tab);
      const title = tab.label || "Image Studio";
      this.#configureTab(win, tab, workspace, { url, title, icon: IMAGE_ICON });
      if (!desired.has(url)) {
        desired.add(url);
        lazy.LimaBridge.request("workspace.openTab", { id, url, title }).catch(error => log(error.message));
      }
    }
    const added = workspace.tabs.filter(tab => desired.has(tab.url) && !present.has(tab.url))
      .map(tab => this.#makeTab(win, workspace, { ...tab, icon: IMAGE_ICON }));
    const tabs = [...moving, ...added];
    if (!folder && tabs.length) {
      folder = this.#createFolder(win, tabs, "Images", parent, true);
      entry.images = folder.id;
      map[id] = entry;
      this.#saveMap(map);
    } else if (tabs.length) preserveFolderDisclosure(folder, () => folder.addTabs(tabs));
    folder?.setAttribute("lima-images", id);
    if (added.length) this.#label(win, added);
  }

  /** Chat, Terminal, notes first; subfolders after them. */
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
    preserveFolderDisclosure(folder, () => {
      for (const tab of sorted) {
        try { win.gBrowser.moveTabBefore(tab, firstFolder); } catch (error) { log(`reorder: ${error}`); }
      }
    });
  }

  // MARK: Tab folders (agents group a workspace's pages)

  /** The folder at `path` inside a workspace's Tabs folder, made as needed. */
  /* Zen restores folders after a restart but not Lima's attributes on them,
   * so each agent folder's Zen id is remembered (map[id].tabFolders[path]).
   * A folder is found by that id, then by its attributes, then by name among
   * its parent's folders; only when none matches is a new one made. Finding
   * by name keeps a restart from filing every tab into fresh duplicates. */
  #tabSubfolder(win, tabsFolder, workspaceId, path) {
    let parent = tabsFolder;
    let sofar = "";
    const map = this.#map();
    const known = { ...(map[workspaceId]?.tabFolders ?? {}) };
    let remembered = false;
    for (const part of path.split("/")) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const children = [...(parent.groupContainer?.children ?? [])].filter(node => node.isZenFolder);
      const byId = known[sofar] ? win.document.getElementById(known[sofar]) : null;
      let next = (byId?.isZenFolder && byId.group === parent ? byId : null)
        ?? children.find(folder => folder.getAttribute("lima-tab-folder") === sofar && folder.getAttribute("lima-tabs-of") === workspaceId)
        // Of same-named copies, the one holding tabs.
        ?? children.filter(folder => !folder.hasAttribute("lima-tab-folder") && !isLimaFolder(folder) && String(folder.label) === part)
          .sort((a, b) => this.#allTabs(b).length - this.#allTabs(a).length)[0];
      if (!next) next = this.#createFolder(win, [], part, parent, false);
      next.setAttribute("lima-tab-folder", sofar);
      next.setAttribute("lima-tabs-of", workspaceId);
      if (known[sofar] !== next.id) { known[sofar] = next.id; remembered = true; }
      parent = next;
    }
    if (remembered) this.#saveMap({ ...map, [workspaceId]: { ...(map[workspaceId] ?? {}), tabFolders: known } });
    return parent;
  }

  /** Marks the agent folders a restart left without Lima's attributes. */
  #reclaimTabFolders(win, workspaceId) {
    for (const [path, zenId] of Object.entries(this.#map()[workspaceId]?.tabFolders ?? {})) {
      const folder = win.document.getElementById(zenId);
      if (!folder?.isZenFolder || folder.hasAttribute("lima-tab-folder")) continue;
      folder.setAttribute("lima-tab-folder", path);
      folder.setAttribute("lima-tabs-of", workspaceId);
    }
  }

  /** Each web tab sits in the folder its entry names (or in Tabs itself). */
  /* Agent folders sit at the top of the workspace, beside Tabs, so one
   * "Marketing" folder holds both pages and notes. Unfiled pages live in
   * Tabs; unfiled notes at the workspace's top level. */
  #arrangeTabFolders(win, workspace, tabs) {
    const folder = this.folderFor(workspace.id, "folder", win);
    if (!folder) return;
    this.#reclaimTabFolders(win, workspace.id);
    for (const entry of workspace.tabs) {
      const web = /^https?:/.test(entry.url);
      if (!web && !entry.url.startsWith("about:lima?note=")) continue;
      const tab = tabs.find(item => web ? sameURL(tabURL(item), entry.url) : tabURL(item) === entry.url);
      if (!tab) continue;
      // Only when the agent (re)files it: a tab you dragged elsewhere stays put.
      // The filing is kept on the tab across restarts, so a restart doesn't
      // count as the agent filing everything again.
      const wanted = entry.folder ?? "";
      tab.limaFiledAs ??= readFiled(tab);
      if (tab.limaFiledAs === wanted) continue;
      tab.limaFiledAs = wanted;
      try { lazy.SessionStore.setCustomTabValue(tab, "lima-filed-as", wanted); } catch {}
      const home = web ? this.folderFor(workspace.id, "tabs", win) ?? folder : folder;
      const target = entry.folder ? this.#tabSubfolder(win, folder, workspace.id, entry.folder) : home;
      if (tab.group !== target && (entry.folder || tab.group?.hasAttribute("lima-tab-folder"))) {
        try { preserveFolderDisclosure(target, () => target.addTabs([tab])); } catch (error) { log(`tab folder: ${error}`); }
      }
    }
    this.#styleTabs(win, workspace, tabs);
    this.#styleTabFolders(win, workspace, folder);
    this.#orderTabs(win, workspace, folder, tabs);
    // Folders agents made that hold nothing any more go away (unless the
    // agent keeps one, empty, for work to come).
    const styled = new Set((workspace.tabFolderStyles ?? []).map(style => style.path));
    const empty = node => !this.#allTabs(node).some(tab => !tab.hasAttribute("zen-empty-tab"));
    const map = this.#map();
    const known = { ...(map[workspace.id]?.tabFolders ?? {}) };
    let forgot = false;
    for (const node of win.document.querySelectorAll(`zen-folder[lima-tabs-of="${win.CSS.escape(workspace.id)}"]`)) {
      const path = node.getAttribute("lima-tab-folder");
      const inside = value => value === path || value?.startsWith(`${path}/`);
      const used = workspace.tabs.some(entry => inside(entry.folder)) || [...styled].some(inside);
      if (!used && empty(node)) {
        if (known[path] === node.id) { delete known[path]; forgot = true; }
        Promise.resolve().then(() => node.delete?.()).catch(() => {});
      }
    }
    if (forgot) this.#saveMap({ ...map, [workspace.id]: { ...(map[workspace.id] ?? {}), tabFolders: known } });
    // Empty copies of the agent's folders, left by earlier restarts: a plain
    // folder in the workspace, holding no tabs, named like one of its folders.
    const names = new Set([...styled, ...workspace.tabs.map(entry => entry.folder).filter(Boolean)].flatMap(path => path.split("/")));
    for (const node of folder.querySelectorAll("zen-folder")) {
      if (node.hasAttribute("lima-tab-folder") || isLimaFolder(node) || !names.has(String(node.label)) || !empty(node)) continue;
      if (node.querySelector("zen-folder[lima-tab-folder]")) continue;
      Promise.resolve().then(() => node.delete?.()).catch(() => {});
    }
  }

  /** Shows `url` (a Lima or Zen icon, or an emoji drawn as an image) as the
   * folder's icon, or its plain folder for null. Zen keeps it with the
   * folder, so it's still there after a restart. */
  setFolderIcon(win, folder, url) {
    try { win.gZenFolders?.setFolderUserIcon(folder, url ?? ""); } catch {}
    this.paintFolderIcon(folder);
    folder.dispatchEvent(new win.CustomEvent("TabGroupUpdate", { bubbles: true }));
  }

  /** Draws the icon Zen stores for a folder in Lima's style. */
  paintFolderIcon(folder) {
    if (!folder?.isZenFolder || folder.hasAttribute("lima-workspace")) return;
    let url = "";
    try { url = folder.iconURL; } catch {}
    if (url) {
      // Icon sets are drawn in the text colour; an emoji keeps its own.
      folder.setAttribute("lima-folder-icon", url.startsWith("data:") ? "image" : "mask");
      folder.style.setProperty("--lima-folder-icon", `url("${url.replace(/"/g, "%22")}")`);
    } else {
      folder.removeAttribute("lima-folder-icon");
      folder.style.removeProperty("--lima-folder-icon");
    }
  }

  /** A Lima icon name or an emoji, as an image URL. */
  iconURL(icon) {
    if (!icon) return null;
    if (/^[a-z][a-z-]*$/.test(icon)) return `resource://lima-ui/icons/${icon}.svg`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="16" y="17" font-size="26" text-anchor="middle" dominant-baseline="central">${icon.replace(/[<&>"]/g, "")}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  /* Names and icons an agent gave its tabs. Each is applied when the agent
   * changes it, so a name or icon you set yourself afterwards stays. */
  #styleTabs(win, workspace, tabs) {
    for (const entry of workspace.tabs) {
      const web = /^https?:/.test(entry.url);
      const tab = tabs.find(item => web ? sameURL(tabURL(item), entry.url) : tabURL(item) === entry.url);
      if (!tab) continue;
      const label = entry.label ?? null;
      if (tab.limaLabelAs !== label) {
        const had = tab.limaLabelAs;
        tab.limaLabelAs = label;
        if (label) {
          tab.zenStaticLabel = label;
          try { win.gBrowser._setTabLabel(tab, label, { _zenChangeLabelFlag: true }); } catch { tab.label = label; }
        } else if (had && tab.zenStaticLabel === had) {
          delete tab.zenStaticLabel;
          try { win.gBrowser.setTabTitle(tab); } catch {}
        }
      }
      const icon = this.iconURL(entry.icon);
      if (tab.limaIconAs !== (entry.icon ?? null)) {
        tab.limaIconAs = entry.icon ?? null;
        tab.limaAgentIcon = icon;
        if (icon) {
          tab.setAttribute("lima-agent-icon", entry.icon);
          try { win.gBrowser.setIcon(tab, icon); } catch {}
        } else if (tab.hasAttribute("lima-agent-icon")) {
          tab.removeAttribute("lima-agent-icon");
          try { win.gBrowser.setIcon(tab, tab.getAttribute("lima-icon") || null); } catch {}
        }
      }
    }
  }

  /** Keeps an agent's icon on a tab when the page loads its own favicon. */
  watchAgentIcons(win) {
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
      const tab = event.target;
      if (!tab.limaAgentIcon || !event.detail?.changed?.includes("image") || tab.getAttribute("image") === tab.limaAgentIcon) return;
      try { win.gBrowser.setIcon(tab, tab.limaAgentIcon); } catch {}
    });
  }

  /** Icons and open state the agent chose for its folders (made if empty). */
  #styleTabFolders(win, workspace, folder) {
    for (const style of workspace.tabFolderStyles ?? []) {
      const target = this.#tabSubfolder(win, folder, workspace.id, style.path);
      const icon = style.icon ?? null;
      if (target.limaIconAs !== icon) {
        target.limaIconAs = icon;
        this.setFolderIcon(win, target, this.iconURL(icon));
      }
      const collapsed = style.collapsed ?? null;
      if (target.limaCollapsedAs !== collapsed) {
        target.limaCollapsedAs = collapsed;
        if (collapsed !== null && target.collapsed !== collapsed) target.collapsed = collapsed;
      }
    }
  }

  /** Puts the agent's tabs in the order it set, within each folder, once per change. */
  #orderTabs(win, workspace, folder, tabs) {
    const version = workspace.tabOrder ?? 0;
    if (!version || folder.limaTabOrder === version) return;
    folder.limaTabOrder = version;
    const byGroup = new Map();
    for (const entry of workspace.tabs) {
      const web = /^https?:/.test(entry.url);
      const tab = tabs.find(item => web ? sameURL(tabURL(item), entry.url) : tabURL(item) === entry.url);
      if (!tab?.group) continue;
      if (!byGroup.has(tab.group)) byGroup.set(tab.group, []);
      byGroup.get(tab.group).push(tab);
    }
    for (const [group, list] of byGroup) {
      preserveFolderDisclosure(group, () => {
        for (let i = 1; i < list.length; i++) {
          try { if (list[i].previousElementSibling !== list[i - 1]) win.gBrowser.moveTabAfter(list[i], list[i - 1]); } catch (error) { log(`order: ${error}`); }
        }
      });
    }
  }

  /** A tab's folder path inside its workspace's Tabs folder ("" = Tabs itself). */
  #tabFolderPath(tab) {
    return tab.group?.getAttribute?.("lima-tab-folder") ?? "";
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

  #doneFolder(win, parentID, map) {
    const agents = this.#agentsFolder(win, parentID, map);
    if (!agents) return null;
    let done = this.folderFor(parentID, "done", win);
    if (!done || done.group !== agents) {
      done = this.#createFolder(win, [], "Done", agents, true);
      done.setAttribute("lima-agents-done", "");
      map[parentID] = { ...(map[parentID] ?? {}), done: done.id };
      this.#saveMap(map);
    }
    return done;
  }

  #updateDone(win, parentID) {
    const done = this.folderFor(parentID, "done", win);
    if (!done) return;
    const count = [...done.groupContainer.children].filter(node => node.hasAttribute?.("lima-agent")).length;
    done.hidden = count === 0;
    done.label = count ? `Done (${count})` : "Done";
    win.limaRelayoutFolders?.();
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
        if (urls.has(url) || imageWorkspaceForURL(url) === id || (owner === id && /^about:lima\?(workspace|chat|terminal)=/.test(url))) {
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
    panel.dataset.phase = "confirm";
    const element = (tag, className, text) => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const mark = element("span", "lima-archive-mark");
    mark.setAttribute("aria-hidden", "true");
    const heading = element("strong", "lima-archive-heading", workspace.parentID ? "Dismiss agent" : "Archive workspace");
    const title = element("div", "lima-archive-title", workspace.name);
    const summary = element("div", "lima-archive-summary");
    summary.append(heading, title);
    const header = element("header", "lima-archive-header");
    header.append(mark, summary);
    const description = element("p", "lima-archive-description", workspace.parentID
      ? "Close this agent and its tabs."
      : "Closes it and saves its folder as a verified ZIP.");
    const path = element("code", "lima-archive-path", workspace.parentID ? "" : workspace.directory);
    const source = element("div", "lima-archive-location");
    const pathLabel = element("span", "", "Project folder");
    source.append(pathLabel, path);
    source.hidden = !path.textContent;
    const status = element("p", "lima-archive-status");
    status.setAttribute("role", "status");
    const cancel = element("button", "", "Cancel");
    const action = element("button", "lima-archive-action", workspace.parentID ? "Dismiss agent" : "Archive workspace");
    const controls = element("div", "lima-archive-actions");
    controls.append(cancel, action);
    const content = element("div", "lima-archive-content");
    content.append(header, description, source, status, controls);
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
      panel.dataset.phase = "working";
      status.textContent = workspace.parentID ? "Dismissing agent…" : "Creating and verifying the ZIP…";
      try {
        const result = await perform();
        panel.dataset.phase = "complete";
        heading.textContent = workspace.parentID ? "Agent dismissed" : "Workspace archived";
        description.textContent = result?.recoveryPath ? `A recovery copy remains at ${result.recoveryPath}` : "The sidebar has been updated.";
        pathLabel.textContent = "Verified ZIP";
        path.textContent = result?.archivePath ?? "";
        source.hidden = !path.textContent;
        status.textContent = result?.directoryKept && !workspace.parentID ? "The original folder is still available." : "";
        action.hidden = true;
        cancel.textContent = "Done";
      } catch (error) {
        panel.dataset.phase = "failed";
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
    if (Services.prefs.getStringPref("lima.personality", "full") !== "full" ||
        tab.ownerDocument.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    tab.querySelector(".tab-content")?.animate(
      [{ opacity: 0.55, transform: "translateX(-5px)" }, { opacity: 1, transform: "translateX(0)" }],
      { duration: 220, easing: SETTLE },
    );
  }

  /** User closed a page the agent had opened: drop it from desired state. */
  onTabClose(tab) {
    const id = this.workspaceForTab(tab);
    const url = tabURL(tab);
    const folder = tab.closest("zen-folder[lima-workspace]");
    if (!id || !url || (url.startsWith("about:lima") && imageWorkspaceForURL(url) !== id)) return;
    tab.ownerDocument.defaultView.setTimeout(() => {
      const workspace = this.#workspaces.get(id);
      if (!workspace || this.#deleting.has(id) || this.#deleting.has(workspace.parentID) || !folder?.isConnected) return;
      lazy.LimaBridge.request("workspace.closeTab", { id, url }).catch(() => {});
    }, 0);
  }

  #activateLimaTab(win, tab, url = tabURL(tab)) {
    if (!url?.startsWith("about:lima?") || !tab.hasAttribute("pending") || tab.hasAttribute("lima-reactivating")) return;
    tab.setAttribute("lima-reactivating", "true");
    win.gBrowser.insertBrowser(tab);
    tab.linkedBrowser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: system(), loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
  }

  onTabSelect(win) {
    const selected = win.gBrowser.selectedTab;
    if (selected.hasAttribute("undiscardable")) this.#activateLimaTab(win, selected);
    const id = this.workspaceForTab(selected);
    for (const folder of win.document.querySelectorAll("zen-folder[lima-workspace]")) {
      folder.toggleAttribute("lima-chat-selected", folder.getAttribute("lima-workspace") === id && selected.hasAttribute("lima-workspace-chat"));
    }
  }

  /** Zen expands a collapsed folder when selecting its only tab. A workspace
   * chat has its own visible row already, so its hidden tab needs no reveal. */
  keepChatFoldersCollapsed(win) {
    const folders = win.gZenFolders;
    const select = folders.on_TabSelect;
    folders.on_TabSelect = function (event) {
      if (event.target?.hasAttribute("lima-workspace-chat")) return;
      return select.call(this, event);
    };
  }

  /** The folder's ✦ opens its chat. */
  openChat(win, id) {
    const workspace = this.#workspaces.get(id);
    const folder = this.folderFor(id, "folder", win);
    const url = workspace?.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const tab = folder && url && folder.tabs.find(t => tabURL(t) === url);
    if (tab) { this.#activateLimaTab(win, tab, url); win.gBrowser.selectedTab = tab; return; }
    if (url) win.gBrowser.selectedTab = win.gBrowser.addTab(url, { triggeringPrincipal: system() });
  }

  async openImageStudio(win, id, { url = `about:lima?view=image&imageWorkspace=${encodeURIComponent(id)}`, background = false } = {}) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) throw new Error("Open Image Studio in a regular Lima window.");
    if (imageWorkspaceForURL(url) !== id) throw new Error("Open Image Studio from its workspace.");
    const params = new URL(url).searchParams;
    const title = params.has("vectorDocument") ? "Vector Studio" : params.has("animationDocument") ? "Animation Studio" : "Image Studio";
    await lazy.LimaBridge.request("workspace.openTab", { id, url, title });
    for (let attempt = 0; attempt < 40; attempt++) {
      const owner = lazy.BrowserWindowTracker.orderedWindows.find(window => this.folderFor(id, "images", window));
      const tab = owner && this.folderFor(id, "images", owner)?.tabs.find(tab => tabURL(tab) === url);
      if (tab) {
        if (!background) owner.gBrowser.selectedTab = tab;
        return;
      }
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
    throw new Error("Image Studio did not appear in this workspace.");
  }

  /** Tab menu → Add Tab to Workspace: the page joins the workspace's Tabs
   * folder, where its agent can read and act on it. */
  async addTab(win, id, tab) {
    const workspace = this.#workspaces.get(id);
    const folder = this.folderFor(id, "folder", win);
    if (!workspace || !folder) throw new Error("This workspace isn't in the sidebar of this window.");
    const url = tabURL(tab);
    if (!/^https?:/.test(url)) throw new Error("Only web pages can be added to a workspace.");
    const from = this.workspaceForTab(tab);
    if (from === id) return workspace;
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
    await lazy.LimaBridge.request("workspace.organizeTabs", { id, tabs: [{ url, title: tab.label, folder: "" }] });
    if (from && !this.#pages(win, from).some(page => sameURL(tabURL(page), url))) {
      await lazy.LimaBridge.request("workspace.closeTab", { id: from, url });
    }
    return workspace;
  }

  /** Top-level workspaces shown in this window's sidebar, for menus. */
  roots(win) {
    return this.workspaces.filter(workspace => !workspace.parentID && this.folderFor(workspace.id, "folder", win));
  }

  /** Called when the user renames a workspace folder inline. */
  /* The new name is kept (map[id].renamedTo) until Lima's runtime has saved
   * it, so a rename made while the runtime was busy or restarting is sent
   * again rather than lost, and never overwritten by the old name. */
  onFolderRenamed(folder) {
    const id = folder.getAttribute("lima-workspace");
    const name = String(folder.label ?? "").trim();
    if (!id || !name || name === this.#workspaces.get(id)?.name) return;
    const map = this.#map();
    this.#saveMap({ ...map, [id]: { ...(map[id] ?? {}), renamedTo: name } });
    this.#sendRename(id, name);
  }

  async #sendRename(id, name, attempt = 0) {
    try {
      const saved = await lazy.LimaBridge.request("workspace.rename", { id, name });
      const map = this.#map();
      if (map[id]?.renamedTo === name) {
        const { renamedTo, ...rest } = map[id];
        this.#saveMap({ ...map, [id]: rest });
      }
      if (saved?.name) this.#workspaces.set(id, { ...(this.#workspaces.get(id) ?? {}), ...saved });
    } catch (error) {
      log(`rename: ${error.message}`);
      if (attempt < 5) setTimeout(() => this.#sendRename(id, name, attempt + 1), 2000 * 2 ** attempt);
    }
  }

  // MARK: Prism: where the agent is

  #paintFocus(id) {
    if (!id) return;
    const win = lazy.BrowserWindowTracker.orderedWindows.find(window => this.folderFor(id, "folder", window));
    const folder = win && this.folderFor(id, "folder", win);
    if (!folder) return;
    const activity = this.#visuals[id];
    const target = activity?.target ?? {};
    const workspace = this.#workspaces.get(id);
    const own = this.#allTabs(workspace?.parentID && folder.group?.isZenFolder ? folder.group : folder).filter(tab => this.workspaceForTab(tab) === id);
    folder.setAttribute("lima-mascot", this.#mascots.get(workspace?.conversationID) ?? "classic");
    const chatURL = workspace?.conversationID && `about:lima?chat=${workspace.conversationID}`;
    const activeURL = { chat: chatURL, tab: target.url, terminal: `about:lima?terminal=${workspace?.terminalID}` }[target.surface];
    folder.toggleAttribute("lima-chat-selected", own.some(tab => tab.selected && tabURL(tab) === chatURL));
    for (const tab of own) {
      const next = sameURL(tabURL(tab), activeURL) ? (target.surface === "chat" ? "thinking" : "here") : "";
      if (!next) tab.removeAttribute("lima-ai");
      else if (tab.getAttribute("lima-ai") !== next) {
        tab.setAttribute("lima-ai", next);
        if (next === "here") this.#animateTab(tab);
      }
    }
    const motion = activity?.motion;
    if (motion && folder.getAttribute("lima-motion") !== motion) folder.setAttribute("lima-motion", motion);
    else if (!motion) folder.removeAttribute("lima-motion");
    this.#observeMascot(win, folder);
    const moving = ["working", "starting"].includes(activity?.state);
    if (moving) folder.setAttribute("lima-ai", "working"); else folder.removeAttribute("lima-ai");
    const attention = activity?.attention || ["blocked", "failed"].includes(activity?.state);
    folder.toggleAttribute("lima-attention", attention);
    // One status at a glance: needs approval (amber), failed (red), or
    // finished and not looked at yet (green, until you open its chat).
    const selectedChat = folder.hasAttribute("lima-chat-selected");
    if (folder.limaWasWorking && activity?.state === "complete" && !selectedChat) folder.limaUnseenDone = true;
    if (selectedChat || moving) folder.limaUnseenDone = false;
    folder.limaWasWorking = moving;
    const status = activity?.state === "failed" ? "failed" : attention ? "approval" : folder.limaUnseenDone ? "done" : moving ? "working" : "";
    if (status) folder.setAttribute("lima-status", status); else folder.removeAttribute("lima-status");
    // A clock on the Pip when this workspace has work scheduled.
    const upcoming = [...(this.#schedules.get(id)?.values() ?? [])].sort((a, b) => a.at - b.at)[0];
    folder.toggleAttribute("lima-scheduled", !!upcoming);
    folder.limaNextRun = upcoming ? `Scheduled: ${upcoming.title}, ${upcoming.label ?? "soon"}` : null;
    const label = folder.querySelector(":scope > .tab-group-label-container");
    if (label) {
      const title = [folder.label, activity?.label ?? "Ready", activity?.detail, activity?.lastResult, folder.limaNextRun].filter(Boolean).join(" · ");
      if (activity && label.limaLastState !== activity.state) {
        const prior = label.limaLastState;
        label.limaLastState = activity.state;
        if (prior && ["working", "blocked", "complete", "failed"].includes(activity.state)) this.#announce(win, folder.label, activity.label);
      }
      if (label.title !== title) {
        label.title = title;
        label.setAttribute("aria-label", title);
      }
      if (label.limaVisible) this.#paintMascot(win, label, folder, id, title);
    }
  }

  #announce(win, name, activity) {
    let live = win.document.getElementById("lima-sidebar-announcement");
    if (!live) {
      live = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      live.id = "lima-sidebar-announcement";
      live.className = "lima-s-visually-hidden";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      win.document.documentElement.append(live);
    }
    win.requestAnimationFrame(() => { if (live.isConnected) live.textContent = `${name}. ${activity}`; });
  }

  #paintMascot(win, label, folder, id, title) {
    const slot = label.querySelector(":scope > .tab-group-folder-icon");
    if (!slot) return;
    const variant = folder.getAttribute("lima-mascot");
    const theme = Services.prefs.getStringPref("lima.mascotTheme", "graphite");
    const dark = win.document.documentElement.getAttribute("lima-theme") === "dark";
    const key = `${id}/${variant}/${theme}/${dark}`;
    let art = slot.querySelector(":scope > .lima-sidebar-pip");
    if (art?.dataset.look !== key) {
      art?.remove();
      let template = this.#mascotTemplates.get(win);
      if (!template) {
        template = characterArt(win.document, "sidebar");
        this.#mascotTemplates.set(win, template);
      }
      art = template.cloneNode(true);
      art.classList.add("lima-sidebar-pip");
      art.dataset.look = key;
      const { ears, eyes, marking, extra, tilt, ...other } = generateMascot(id);
      for (const [part, value] of Object.entries({ ears, eyes, marking, extra })) {
        const prefix = part === "ears" ? "ears" : part;
        for (const group of art.querySelectorAll(`g[class^="${prefix}-"]`)) {
          const show = group.classList.contains(`${prefix}-${value}`) &&
            !(part === "marking" && theme === "outline") &&
            !(part === "extra" && variant !== "classic" && ["headphones", "flower", "bow"].includes(value));
          if (!show) group.style.display = "none";
        }
      }
      for (const costume of art.querySelectorAll(".mascot-accent")) costume.style.display = costume.classList.contains(variant) ? "inline" : "none";
      for (const part of art.querySelectorAll(".companion-speaking, .companion-sparks")) part.style.display = "none";
      for (const [name, value] of Object.entries(mascotColors({ ...other }, dark, theme))) art.style.setProperty(name, value);
      art.style.setProperty("--mascot-tilt", `${tilt}deg`);
      slot.append(art);
    }
    slot.title = title;
  }

  #observeMascot(win, folder) {
    if (this.#observed.has(folder)) return;
    const label = folder.querySelector(":scope > .tab-group-label-container");
    if (!label) return;
    let observer = this.#observers.get(win);
    if (!observer) {
      observer = new win.IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
          if (!target.isConnected) observer.unobserve(target);
          else {
            target.toggleAttribute("lima-offscreen", !isIntersecting);
            target.limaVisible = isIntersecting;
            const workspace = target.parentElement;
            const id = workspace?.getAttribute("lima-workspace");
            if (isIntersecting && id) this.#paintMascot(win, target, workspace, id, target.title);
          }
        }
      });
      this.#observers.set(win, observer);
      win.addEventListener("unload", () => observer.disconnect(), { once: true });
    }
    this.#observed.add(folder);
    observer.observe(label);
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
      if (request.kind === "location") return reply(await approximateLocation(win));
      if (request.kind === "notesOutline") return reply(await lazy.LimaNotesBookmarks.outline());
      if (request.kind === "notesOrganize") return reply(await lazy.LimaNotesBookmarks.organize(request.noteId, request.folder));
      if (request.kind === "notesArchive") return reply(await lazy.LimaNotesBookmarks.archiveNote(request.noteId));
      if (request.kind === "notesUnarchive") return reply(await lazy.LimaNotesBookmarks.unarchiveNote(request.noteId));
      if (request.kind === "listTabs") return reply(this.#pages(win, request.workspaceId).map(tab => ({ url: tabURL(tab), title: tab.label, selected: tab.selected, folder: this.#tabFolderPath(tab), icon: tab.limaIconAs ?? null })));
      if (request.kind === "action") return reply(await this.#act(win, request));
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
    const filed = workspace?.parentID ? [] : [...win.document.querySelectorAll(`zen-folder[lima-tabs-of="${win.CSS.escape(id)}"]`)]
      .filter(folder => !folder.parentElement?.closest?.(`zen-folder[lima-tabs-of="${win.CSS.escape(id)}"]`)).flatMap(folder => this.#allTabs(folder));
    return [...new Set([...this.#allTabs(container), ...filed])].filter(tab => /^https?:/.test(tabURL(tab)) && (!workspace?.parentID || tab.group === container));
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
    const current = new URL(browser.currentURI.spec).pathname;
    if (request.paths && !request.paths.includes(current) && !request.confirmed) {
      return { needsApproval: { kind: "path", path: current, risk: "routine", reason: "The page moved to a path the plan didn't list." } };
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
    // `confirmed` comes only from the runtime, after the user approved this step.
    const data = { origin, paths: request.paths, action: request.action, options: request.options, confirmed: request.confirmed === true };
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
    if (!Services.prefs.getBoolPref("lima.browser.actionOverlay", false) ||
        !["click", "type"].includes(action) || win.gBrowser.selectedBrowser !== browser) return;
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
    const notes = workspace.tabs.filter(tab => tab.url.startsWith("about:lima?note=") && !this.#seenWorkspaceNotes.has(tab.url));
    if (!workspace.bookmarks.length && !notes.length && !this.#map()[workspace.id]?.bookmarks) return;
    const root = await this.#bookmarkRoot();
    const map = this.#map();
    const saved = map[workspace.id]?.bookmarks;
    let item = saved && await lazy.PlacesUtils.bookmarks.fetch(saved);
    if (item?.parentGuid !== root) item = null;
    let folder;
    if (item) {
      folder = item.guid;
      if (item.title !== workspace.name) await lazy.PlacesUtils.bookmarks.update({ guid: folder, title: workspace.name });
    } else {
      const reserved = new Set(Object.values(map).map(entry => entry.bookmarks).filter(Boolean));
      await lazy.PlacesUtils.bookmarks.fetch({ parentGuid: root }, child => {
        if (!folder && child.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER && child.title === workspace.name && !reserved.has(child.guid)) folder = child.guid;
      });
      folder ??= (await lazy.PlacesUtils.bookmarks.insert({ parentGuid: root, type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER, title: workspace.name })).guid;
      map[workspace.id] = { ...(map[workspace.id] ?? {}), bookmarks: folder };
      this.#saveMap(map);
    }
    for (const tab of notes) {
      const id = decodeURIComponent(tab.url.slice("about:lima?note=".length).split("&")[0]);
      // Note creation and the Places observer can reach the browser in either order.
      const note = await lazy.LimaBridge.request("notes.get", { id }).catch(() => null);
      if (!note || note.trashedAt) continue;
      let parent = folder;
      for (const part of (tab.folder ?? "").split("/").filter(Boolean)) parent = await this.#childFolder(parent, part);
      await lazy.LimaNotesBookmarks.ensureWorkspaceNote(note, parent);
      this.#seenWorkspaceNotes.add(tab.url);
    }
    for (const bookmark of workspace.bookmarks) {
      let parent = folder;
      for (const part of bookmark.folder.split("/").filter(Boolean)) parent = await this.#childFolder(parent, part);
      if (bookmark.url.startsWith("about:lima?note=")) continue;
      await this.#ensureBookmark(parent, bookmark.url, bookmark.title);
    }
  }
}


/** Folders Lima itself manages (a workspace, its Tabs or Images, an agent's). */
function isLimaFolder(folder) {
  return ["lima-workspace", "lima-tabs", "lima-images", "lima-agents", "lima-agent", "lima-notebook", "lima-section"].some(name => folder.hasAttribute(name));
}

/** The folder path the agent last filed this tab under, kept across restarts. */
function readFiled(tab) {
  try {
    const value = lazy.SessionStore.getCustomTabValue(tab, "lima-filed-as");
    return typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}

export const LimaWorkspaces = new Workspaces();
