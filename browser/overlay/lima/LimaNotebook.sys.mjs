/* The Notebook: OneNote's navigator, in Zen's sidebar.
 *
 *   ▸ Notebook          zen-folder[lima-notebook]
 *       page            notes in the default "Notes" bookmark folder
 *       ▸ Section       one sub-folder per note bookmark folder
 *           page
 *
 * The bookmark tree stays the source of truth (LimaNotesBookmarks); this
 * mirrors it. Dragging a page into another section moves its bookmark, and
 * renaming a section renames the bookmark folder. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  tabURL: "resource://lima/LimaWorkspaces.sys.mjs",
});

const MAP_PREF = "lima.notebook.sidebar";
const NOTE_ICON = "resource://lima-ui/icons/note.svg";
const PREFIX = "about:lima?note=";

function log(message) {
  dump(`[lima] notebook: ${message}\n`);
}

class Notebook {
  #started = false;
  #timer = null;
  #queue = Promise.resolve();
  #moving = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    lazy.PlacesUtils.observers.addListener(
      ["bookmark-added", "bookmark-removed", "bookmark-moved", "bookmark-title-changed"],
      () => this.schedule()
    );
    this.schedule(0);
  }

  schedule(delay = 300) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win) return;
    win.clearTimeout(this.#timer);
    this.#timer = win.setTimeout(() => { this.#queue = this.#queue.then(() => this.reconcile()).catch(e => log(`${e}\n${e.stack}`)); }, delay);
  }

  #map() {
    try { return JSON.parse(Services.prefs.getStringPref(MAP_PREF, "{}")); } catch { return {}; }
  }

  #saveMap(map) {
    Services.prefs.setStringPref(MAP_PREF, JSON.stringify(map));
  }

  #folder(win, id) {
    const node = id ? win.document.getElementById(id) : null;
    return node?.isZenFolder ? node : null;
  }

  root(win = lazy.BrowserWindowTracker.getTopWindow()) {
    return win && this.#folder(win, this.#map().folder);
  }

  isNotebookFolder(folder) {
    return !!folder && (folder.hasAttribute("lima-notebook") || folder.hasAttribute("lima-section"));
  }

  #tabs(folder) {
    return folder.allItemsRecursive.filter(item => item.localName === "tab" && !item.hasAttribute("zen-empty-tab"));
  }

  #makeTab(win, id, title) {
    const url = PREFIX + encodeURIComponent(id);
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true,
      createLazyBrowser: true, lazyTabTitle: title, skipAnimation: true });
    tab.setAttribute("lima-url", url);
    tab.setAttribute("lima-title", title);
    try { lazy.SessionStore.setCustomTabValue(tab, "lima-url", url); } catch {}
    try { win.gBrowser.setIcon(tab, NOTE_ICON); } catch {}
    return tab;
  }

  async reconcile() {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win?.gZenFolders) return;
    const tree = await lazy.LimaNotesBookmarks.folderTree();
    const map = this.#map();
    map.sections ??= {};

    let root = this.#folder(win, map.folder);
    if (!root) {
      root = win.gZenFolders.createFolder([], { label: "Notebook", collapsed: true });
      map.folder = root.id;
      this.#saveMap(map);
      log("created");
    }
    root.setAttribute("lima-notebook", "true");

    const wantedNotes = new Map(); // noteId → {title, container}
    for (const folder of tree.folders) {
      let container = root;
      if (folder.guid !== tree.defaultGuid) {
        container = this.#folder(win, map.sections[folder.guid]);
        if (!container || container.group !== root) {
          container = win.gZenFolders.createFolder([], { label: folder.title, insertAfter: root.groupContainer.lastElementChild, collapsed: true });
          map.sections[folder.guid] = container.id;
          this.#saveMap(map);
        }
        container.setAttribute("lima-section", folder.guid);
        if (container.label !== folder.title) container.label = folder.title;
      }
      for (const note of folder.notes) if (!wantedNotes.has(note.id)) wantedNotes.set(note.id, { title: note.title || "Untitled", container });
    }

    // Sections whose bookmark folder is gone.
    const liveSections = new Set(tree.folders.map(f => f.guid));
    for (const [guid, id] of Object.entries(map.sections)) {
      if (liveSections.has(guid)) continue;
      const section = this.#folder(win, id);
      if (section && !this.#tabs(section).length) await section.delete();
      if (!section || !this.#tabs(section).length) delete map.sections[guid];
    }
    this.#saveMap(map);

    this.#moving = true;
    try {
      const seen = new Set();
      for (const tab of this.#tabs(root)) {
        const url = lazy.tabURL(tab);
        if (!url.startsWith(PREFIX)) continue;
        const id = decodeURIComponent(url.slice(PREFIX.length).split("&")[0]);
        const want = wantedNotes.get(id);
        if (!want || seen.has(id)) { win.gBrowser.removeTab(tab, { animate: false }); continue; }
        seen.add(id);
        if (tab.group !== want.container) want.container.addTabs([tab]);
        if (tab.hasAttribute("pending") && !tab.getAttribute("image")) { try { win.gBrowser.setIcon(tab, NOTE_ICON); } catch {} }
        if (tab.hasAttribute("pending") && tab.label !== want.title) {
          tab.setAttribute("lima-title", want.title);
          try { win.gBrowser._setTabLabel(tab, want.title); } catch {}
        }
      }
      const byContainer = new Map();
      for (const [id, want] of wantedNotes) {
        if (seen.has(id)) continue;
        if (!byContainer.has(want.container)) byContainer.set(want.container, []);
        byContainer.get(want.container).push(this.#makeTab(win, id, want.title));
      }
      for (const [container, tabs] of byContainer) {
        container.addTabs(tabs);
        win.setTimeout(() => { for (const tab of tabs) { try { win.gBrowser._setTabLabel(tab, tab.getAttribute("lima-title")); win.gBrowser.setIcon(tab, NOTE_ICON); } catch {} } }, 600);
      }
    } finally {
      this.#moving = false;
    }
  }

  /** Select a note's page in the Notebook (creating it if needed). */
  async reveal(win, noteId) {
    await (this.#queue = this.#queue.then(() => this.reconcile()).catch(() => {}));
    const root = this.root(win);
    const url = PREFIX + encodeURIComponent(noteId);
    const tab = root && this.#tabs(root).find(t => lazy.tabURL(t) === url);
    if (!tab) return false;
    for (let folder = tab.group; folder?.isZenFolder; folder = folder.group) folder.collapsed = false;
    win.gBrowser.selectedTab = tab;
    return true;
  }

  /** A page was dragged into another section. */
  onTabGrouped(tab) {
    if (this.#moving) return;
    const url = lazy.tabURL(tab);
    if (!url.startsWith(PREFIX) || !this.isNotebookFolder(tab.group)) return;
    const noteId = decodeURIComponent(url.slice(PREFIX.length).split("&")[0]);
    const guid = tab.group.getAttribute("lima-section");
    (guid ? Promise.resolve(guid) : lazy.LimaNotesBookmarks.defaultFolderGuid())
      .then(target => lazy.LimaNotesBookmarks.moveNote(noteId, target))
      .catch(error => log(`move failed: ${error}`));
  }

  /** Section folder renamed inline. */
  onFolderRenamed(folder) {
    const guid = folder.getAttribute("lima-section");
    if (guid) lazy.PlacesUtils.bookmarks.update({ guid, title: folder.label }).catch(error => log(`rename failed: ${error}`));
  }

  async newSection(win) {
    const created = await lazy.LimaNotesBookmarks.createFolder("New Section");
    await (this.#queue = this.#queue.then(() => this.reconcile()).catch(() => {}));
    const section = this.#folder(win, this.#map().sections?.[created.guid]);
    if (section) {
      this.root(win).collapsed = false;
      section.rename();
    }
  }
}

export const LimaNotebook = new Notebook();
