/* Lima in Zen's sidebar (docs/architecture/sidebar-workspaces.md):
 *
 *  - Creation, in Zen's bottom ＋ and on right-click (empty sidebar, a
 *    folder, a tab): New Tab · New Note · New Terminal · New AI Workspace.
 *    From a folder's menu, the new item goes into that folder.
 *  - The dock above Zen's footer: now-playing pill (4.x music bar), the
 *    dictation pill while recording/transcribing, and the mic.
 *  - A workspace folder's ✦ opens its chat; renaming a folder renames the
 *    workspace or sidebar section. */

import { googleEssentialTabs, refreshGoogleEssentials } from "resource://lima/LimaGoogleEssentials.sys.mjs";
import { isLeaving, popIn, sinkAway } from "resource://lima/LimaMotion.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaDownloads: "resource://lima/LimaDownloads.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaSearchPanel: "resource://lima/LimaSearchPanel.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  tabURL: "resource://lima/LimaWorkspaces.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const system = () => Services.scriptSecurityManager.getSystemPrincipal();

function log(message) {
  dump(`[lima] sidebar: ${message}\n`);
}

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

function glyph(doc, name) {
  const node = el(doc, "span", { class: "lima-glyph" });
  node.style.maskImage = `url("${ICON(name)}")`;
  return node;
}

// MARK: Notices
//
// Results and failures of sidebar actions appear in a small notice above
// the dock, never only in a log. Failures stay until dismissed or retried.

function noticeNode(win) {
  const doc = win.document;
  let notice = doc.getElementById("lima-action-notice");
  if (!notice) {
    notice = el(doc, "div", { id: "lima-action-notice", role: "status", hidden: true });
    const host = doc.getElementById("lima-dock-main") ?? doc.getElementById("lima-dock");
    if (!host) return null;
    host.prepend(notice);
  }
  win.clearTimeout(notice.limaTimer);
  // A multi-step card (sidebarCard) learns when something else takes its place.
  const replaced = notice.limaReplaced;
  notice.limaReplaced = null;
  replaced?.();
  return notice;
}

/** The sidebar's card for a prompt that changes as it goes (confirm, then
 * working, then done), drawn where every other sidebar notice appears.
 * `paint(children)` fills it; `close()` sinks it away; `closed` resolves once
 * it's gone, whether dismissed, closed or replaced by another notice. */
export function sidebarCard(win, { tone = "ask", label = "" } = {}) {
  const notice = noticeNode(win);
  if (!notice) return null;
  let settle;
  const closed = new Promise(resolve => { settle = resolve; });
  const finish = () => { win.removeEventListener("unload", finish); notice.limaReplaced = null; settle(); };
  const close = () => { if (notice.limaReplaced !== finish) return; finish(); sinkAway(notice, { flow: true, done: () => notice.replaceChildren() }); };
  notice.limaReplaced = finish;
  win.addEventListener("unload", finish, { once: true });
  notice.dataset.tone = tone;
  notice.setAttribute("role", "dialog");
  notice.setAttribute("aria-label", label);
  const paint = (...children) => {
    notice.replaceChildren(el(win.document, "div", { class: "lima-action-copy" }, ...children),
      el(win.document, "button", { class: "lima-action-close", title: "Dismiss", "aria-label": "Dismiss", onclick: () => notice.limaCloseRequest?.() ?? close() }, glyph(win.document, "close")));
  };
  return { notice, paint, close, closed, popIn: () => popIn(notice, { flow: true }) };
}

export function showSidebarNotice(win, { title, detail = "", tone = "ok", actions = [] }) {
  const doc = win.document;
  const notice = noticeNode(win);
  if (!notice) { log(`${title}: ${detail}`); return; }
  notice.limaCloseRequest = null;
  notice.removeAttribute("aria-label");
  const hide = () => sinkAway(notice, { flow: true, done: () => notice.replaceChildren() });
  notice.dataset.tone = tone;
  notice.setAttribute("role", tone === "bad" ? "alert" : "status");
  notice.replaceChildren(
    el(doc, "div", { class: "lima-action-copy" }, el(doc, "strong", { text: title }), detail ? el(doc, "span", { text: detail }) : null,
      actions.length ? el(doc, "div", { class: "lima-action-buttons" }, ...actions.map(([label, run]) =>
        el(doc, "button", { onclick: () => { hide(); Promise.resolve().then(run).catch(error => failed(win, label, error, run)); } }, label))) : null),
    el(doc, "button", { class: "lima-action-close", title: "Dismiss", "aria-label": "Dismiss", onclick: hide }, glyph(doc, "close")));
  popIn(notice, { flow: true });
  if (tone !== "bad" && tone !== "ask") notice.limaTimer = win.setTimeout(hide, 6000);
}

/** A sidebar action failed: say which one and why, and offer a retry. */
export function failed(win, label, error, retry) {
  log(`${label}: ${error}`);
  showSidebarNotice(win, { title: "Couldn't complete this action.", detail: `${label}: ${error?.message ?? error}`, tone: "bad",
    actions: retry ? [["Retry", retry]] : [] });
}

// MARK: Creating things

export const LimaCreate = {
  tab(win) {
    lazy.LimaSearchPanel.open(win);
  },

  /** Put a freshly made tab into `folder` (or leave it loose) and select it. */
  place(win, tab, folder) {
    if (folder) {
      folder.collapsed = false;
      folder.addTabs([tab]);
    }
    win.gBrowser.selectedTab = tab;
  },

  async note(win, folder = null) {
    const note = await lazy.LimaNotesBookmarks.createNote({ title: "Untitled", kind: "classic" });
    const url = `about:lima?note=${encodeURIComponent(note.id)}`;
    const tab = win.gBrowser.addTab(url, { triggeringPrincipal: system() });
    this.place(win, tab, folder);
    const id = folder?.closest("zen-folder[lima-workspace]")?.getAttribute("lima-workspace");
    if (id) {
      const path = folder.getAttribute("lima-tab-folder") ?? "";
      await lazy.LimaBridge.request("workspace.organizeTabs", { id, tabs: [{ url, title: note.title, folder: path }] });
    }
    return note;
  },

  async workspace(win, { pickFolder = false } = {}) {
    let directory = null;
    let name = "New Workspace";
    if (pickFolder) {
      directory = await pick(win);
      if (!directory) return false;
      name = directory.split("/").filter(Boolean).pop() ?? name;
    }
    const provider = Services.prefs.getStringPref("lima.agent.provider", "claude");
    const model = Services.prefs.getStringPref("lima.agent.model." + provider, "default");
    // Failures reach the caller's notice (with Retry) instead of an alert.
    const workspace = await lazy.LimaBridge.request("workspace.create", { name, directory, provider, model });
    // The reconciler builds the folder from the workspace.created event.
    for (let i = 0; i < 40; i++) {
      const folder = lazy.LimaWorkspaces.folderFor(workspace.id, "folder", win);
      if (folder) return true;
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
    throw new Error(`“${workspace.name}” was created, but its sidebar folder didn't appear. Reopen Lima to restore it.`);
  },
};

function pick(win) {
  return new Promise(resolve => {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Choose a folder for the AI workspace", Ci.nsIFilePicker.modeGetFolder);
    picker.open(result => resolve(result === Ci.nsIFilePicker.returnOK ? picker.file.path : null));
  });
}

// MARK: Menus

/** The folder a context menu was opened on (or the folder of the tab). */
function contextFolder(win, popup) {
  const node = popup.triggerNode;
  const folder = node?.closest?.("zen-folder");
  if (folder) return folder;
  const tab = win.TabContextMenu?.contextTab;
  return tab?.group?.isZenFolder ? tab.group : null;
}

function installMenus(win) {
  const doc = win.document;
  const item = (id, label, iconName, command) => {
    const node = doc.createElementNS(XUL, "menuitem");
    node.id = id;
    node.setAttribute("label", label);
    node.setAttribute("image", ICON(iconName));
    node.classList.add("menuitem-iconic", "lima-menuitem");
    node.addEventListener("command", () => Promise.resolve().then(command).catch(error => failed(win, label, error, command)));
    return node;
  };
  const separator = id => Object.assign(doc.createElementNS(XUL, "menuseparator"), { id });

  // Zen's bottom ＋.
  const create = doc.getElementById("zenCreateNewPopup");
  if (create && !doc.getElementById("lima-create-note")) {
    create.prepend(
      item("lima-create-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      item("lima-create-workspace-folder", "New AI Workspace from Folder…", "folder", () => LimaCreate.workspace(win, { pickFolder: true })),
      item("lima-create-note", "New Note", "note", () => LimaCreate.note(win)),
      separator("lima-create-sep"));
  }

  // Right-click on the sidebar's empty area: one short menu of Lima's own,
  // in place of the toolbar menu and Zen's spaces menu (Lima has one space,
  // so "New Space" and the rest don't apply).
  if (!doc.getElementById("lima-sidebar-menu")) {
    const menu = doc.createXULElement("menupopup");
    menu.id = "lima-sidebar-menu";
    const settingsURL = "about:lima?view=integrations&section=sidebar";
    menu.append(
      item("lima-sidebar-new-tab", "New Tab", "plus", () => LimaCreate.tab(win)),
      item("lima-sidebar-new-folder", "New Folder", "folder", () => win.gZenFolders.createFolder([], { renameFolder: true })),
      item("lima-sidebar-new-note", "New Note", "note", () => LimaCreate.note(win)),
      item("lima-sidebar-new-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      separator("lima-sidebar-menu-sep"),
      item("lima-sidebar-reopen", "Reopen Closed Tab", "undo", () => win.undoCloseTab()),
      separator("lima-sidebar-menu-sep2"),
      siteModeMenu(win),
      item("lima-sidebar-settings", "Sidebar Settings…", "sliders", () => win.switchToTabHavingURI(settingsURL, true, { triggeringPrincipal: system() })));
    menu.addEventListener("popupshowing", event => {
      if (event.target !== menu) return;
      doc.getElementById("lima-sidebar-reopen").disabled = !lazy.SessionStore.getClosedTabCountForWindow?.(win);
      doc.getElementById("lima-sidebar-site-mode")?.limaLabel?.();
    });
    (doc.getElementById("mainPopupSet") ?? doc.documentElement).append(menu);
    let point = null;
    win.addEventListener("contextmenu", event => { point = { x: event.screenX, y: event.screenY }; }, true);
    // On a tab or folder their own menus open; on empty sidebar space, this one.
    const inSidebar = node => !!node?.closest?.("#navigator-toolbox")
      && !!node.closest("#tabbrowser-tabs, zen-workspace, .zen-workspace-tabs-section, #tabbrowser-arrowscrollbox")
      && !node.closest(".tabbrowser-tab, zen-folder, #lima-dock, #lima-music, toolbarbutton:not(.zen-workspaces-actions), #urlbar");
    for (const id of ["toolbar-context-menu", "zenWorkspaceMoreActions"]) {
      const original = doc.getElementById(id);
      original?.addEventListener("popupshowing", event => {
        if (event.target !== original || (id === "toolbar-context-menu" && !inSidebar(original.triggerNode))) return;
        event.preventDefault();
        if (point) menu.openPopupAtScreen(point.x, point.y, true);
        else menu.openPopup(original.triggerNode, "after_pointer");
      });
    }
  }

  // Right-click on a folder: create inside it; workspace and agent actions.
  const folderMenu = doc.getElementById("zenFolderActions");
  if (folderMenu && !doc.getElementById("lima-folder-note")) {
    let target = null;
    const inFolder = (id, label, iconName, fn) => item(id, label, iconName, () => fn(target));
    const own = [
      inFolder("lima-folder-chat", "Open Agent", "star", f => lazy.LimaWorkspaces.openChat(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-tab", "New Tab Here", "tab", f => { const tab = win.gBrowser.addTab("about:blank", { triggeringPrincipal: system() }); LimaCreate.place(win, tab, f); lazy.LimaSearchPanel.open(win); }),
      inFolder("lima-folder-note", "New Note Here", "note", f => LimaCreate.note(win, f)),
      inFolder("lima-folder-image", "Open Image Studio", "image", f => lazy.LimaWorkspaces.openImageStudio(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-rename", "Rename Workspace", "file", f => f.rename()),
      inFolder("lima-folder-reveal", "Reveal Project Folder", "folder", f => lazy.LimaBridge.request("workspace.reveal", { id: f.getAttribute("lima-workspace") })),
      inFolder("lima-folder-dismiss", "Dismiss Finished Agent", "close", f => lazy.LimaWorkspaces.archive(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-remove", "Archive Workspace…", "trash", f => lazy.LimaWorkspaces.archive(win, f.getAttribute("lima-workspace"))),
      separator("lima-folder-sep"),
    ];
    folderMenu.prepend(...own);
    folderMenu.addEventListener("popupshowing", event => {
      if (event.target !== folderMenu) return;
      target = contextFolder(win, folderMenu);
      const workspace = target?.hasAttribute("lima-workspace");
      const agent = target?.hasAttribute("lima-agent");
      doc.getElementById("lima-folder-chat").hidden = !workspace;
      doc.getElementById("lima-folder-tab").hidden = !target;
      doc.getElementById("lima-folder-note").hidden = !target;
      doc.getElementById("lima-folder-image").hidden = !workspace;
      doc.getElementById("lima-folder-dismiss").hidden = !agent;
      doc.getElementById("lima-folder-remove").hidden = !workspace || agent;
      doc.getElementById("lima-folder-rename").hidden = !workspace || agent;
      doc.getElementById("lima-folder-reveal").hidden = !workspace || agent;
      // Lima has one space: moving or sharing a folder between spaces doesn't apply.
      for (const id of ["context_zenChangeFolderSpace", "context_zenShareFolder"]) { const node = doc.getElementById(id); if (node) node.hidden = true; }
      Promise.resolve().then(() => tidySeparators(folderMenu));
      const deleteItem = doc.getElementById("context_zenFolderDelete");
      if (deleteItem) deleteItem.hidden = !!workspace;
      // Rename Workspace replaces Zen's own Rename on workspace folders.
      const renameItem = doc.getElementById("context_zenFolderRename");
      if (renameItem) renameItem.hidden = !!workspace && !agent;
    });
  }

  // Right-click on a tab: create next to it (in its folder), or bring the
  // page into Lima: a workspace, a question, or an agent's task.
  const tabMenu = doc.getElementById("tabContextMenu");
  if (tabMenu && !doc.getElementById("lima-tabctx-note")) {
    const contextTab = () => win.TabContextMenu?.contextTab;
    const folderOfTab = () => contextTab()?.group?.isZenFolder ? contextTab().group : null;
    const addTo = workspaceMenu(win, "lima-tabctx-add", "Add Tab to Workspace (⌃⌥M)", async (workspace, tab) => {
      await lazy.LimaWorkspaces.addTab(win, workspace.id, tab);
      showSidebarNotice(win, { title: `Added to ${workspace.name}`, detail: tab.label, actions: [["Open Agent", () => lazy.LimaWorkspaces.openChat(win, workspace.id)]] });
    }, contextTab);
    tabMenu.prepend(
      addTo,
      item("lima-tabctx-ask", "Ask Lima About Page", "star", () => askAboutPage(win, pageOf(contextTab()?.linkedBrowser))),
      item("lima-tabctx-send", "Send Page to Agent", "workspace", () => sendPageToAgent(win, pageOf(contextTab()?.linkedBrowser))),
      separator("lima-tabctx-page-sep"),
      item("lima-tabctx-note", "New Note", "note", () => LimaCreate.note(win, folderOfTab())),
      item("lima-tabctx-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      separator("lima-tabctx-sep"));
    tabMenu.addEventListener("popupshowing", event => {
      if (event.target !== tabMenu) return;
      const web = /^https?:/.test(contextTab()?.linkedBrowser?.currentURI?.spec ?? "") && !lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      for (const id of ["lima-tabctx-add", "lima-tabctx-ask", "lima-tabctx-send", "lima-tabctx-page-sep"]) doc.getElementById(id).hidden = !web;
      addTo.disabled = !lazy.LimaWorkspaces.roots(win).length;
    });
    organizeTabMenu(win, tabMenu);
  }

  // Right-click on a page or a selection.
  const content = doc.getElementById("contentAreaContextMenu");
  if (content && !doc.getElementById("lima-page-ask")) {
    const page = () => pageOf(win.gContextMenu?.browser);
    const selection = () => String(win.gContextMenu?.selectionInfo?.fullText ?? win.gContextMenu?.contentData?.selectionInfo?.fullText ?? "").trim();
    const items = [
      separator("lima-page-sep"),
      item("lima-page-summarize", "Summarize Selection", "star", () => {
        const current = page();
        lazy.LimaSearchPanel.open(win, "", { context: { kind: "selection", ...current, text: selection() }, ask: "Summarize the selected text." });
      }),
      item("lima-page-save", "Save Selection to Note", "note", () => saveSelection(win, page(), selection())),
      item("lima-page-ask", "Ask Lima About Page", "star", () => askAboutPage(win, page())),
    ];
    content.append(...items);
    content.addEventListener("popupshowing", event => {
      if (event.target !== content) return;
      const current = page();
      const allowed = /^https?:/.test(current.url) && !lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      const selected = allowed && win.gContextMenu?.isTextSelected && !!selection();
      doc.getElementById("lima-page-sep").hidden = !allowed;
      doc.getElementById("lima-page-ask").hidden = !allowed;
      doc.getElementById("lima-page-summarize").hidden = !selected;
      doc.getElementById("lima-page-save").hidden = !selected;
    });
  }
}

/* The tab menu, regrouped so the everyday actions are easy to find:
 *   Ask Lima About Page · Lima ▸
 *   New Tab Below · Reload · Duplicate · Mute
 *   Rename · Change Icon · Move to Folder ▸ · Split View
 *   More ▸ (everything else Firefox and Zen offer)
 *   Close Tab · Reopen Closed Tab
 * Items keep their ids, so Firefox and Zen still update and run them. */
function organizeTabMenu(win, tabMenu) {
  const doc = win.document;
  if (doc.getElementById("lima-tabctx-more")) return;
  const submenu = (id, label, iconName) => {
    const node = doc.createXULElement("menu");
    node.id = id;
    node.setAttribute("label", label);
    node.classList.add("menu-iconic", "lima-menuitem");
    if (iconName) node.setAttribute("image", ICON(iconName));
    const popup = doc.createXULElement("menupopup");
    node.append(popup);
    return [node, popup];
  };
  const sep = id => Object.assign(doc.createXULElement("menuseparator"), { id });
  const take = id => doc.getElementById(id);
  const [lima, limaPopup] = submenu("lima-tabctx-lima", "Lima", "lima");
  const [more, morePopup] = submenu("lima-tabctx-more", "More", "more");
  // Firefox's own separators would stack up inside More; they're kept (code
  // looks some up by id) in a menu that never shows.
  const [holder, holderPopup] = submenu("lima-tabctx-holder", "", null);
  holder.hidden = true;

  limaPopup.append(...["lima-tabctx-add", "lima-tabctx-send", "lima-tabctx-page-sep", "lima-tabctx-note", "lima-tabctx-workspace"].map(take).filter(Boolean));
  const placed = new Set();
  const group = ids => ids.map(take).filter(node => node && !placed.has(node) && placed.add(node));
  const top = [
    ...group(["lima-tabctx-ask"]), lima, sep("lima-tabctx-g1"),
    ...group(["context_openANewTab", "context_reloadTab", "context_duplicateTab", "context_toggleMuteTab", "context_toggleMuteSelectedTabs"]), sep("lima-tabctx-g2"),
    ...group(["context_zen-edit-tab-title", "context_zen-edit-tab-icon", "context_zenMoveToFolder", "context_zenSplitTabs"]), sep("lima-tabctx-g3"),
    more, sep("lima-tabctx-g4"),
    ...group(["context_closeTab", "context_undoCloseTab"]),
  ];
  for (const node of [...tabMenu.children]) {
    if (node === lima || placed.has(node) || node.id?.startsWith("lima-tabctx-")) {
      if (node.localName === "menuseparator" && node.id?.startsWith("lima-tabctx-") && !node.id.startsWith("lima-tabctx-g")) holderPopup.append(node);
      continue;
    }
    (node.localName === "menuseparator" ? holderPopup : morePopup).append(node);
  }
  tabMenu.replaceChildren(...top, holder);
  // Hide a submenu with nothing to show, once Firefox has updated its items.
  tabMenu.addEventListener("popupshown", event => {
    if (event.target !== tabMenu) return;
    const visible = popup => [...popup.children].some(node => !node.hidden && !node.collapsed && node.localName !== "menuseparator");
    more.hidden = !visible(morePopup);
    lima.hidden = !visible(limaPopup);
    for (const popup of [tabMenu, morePopup, limaPopup]) tidySeparators(popup);
  });
}

/** "Sidebar on chatgpt.com ▸ Expanded / Compact / Hidden / Like other sites". */
function siteModeMenu(win) {
  const doc = win.document;
  const { LimaSidebarModes, hostOf } = ChromeUtils.importESModule("resource://lima/LimaSidebarModes.sys.mjs");
  const menu = doc.createXULElement("menu");
  menu.id = "lima-sidebar-site-mode";
  menu.classList.add("menu-iconic", "lima-menuitem");
  menu.setAttribute("image", ICON("sliders"));
  const popup = doc.createXULElement("menupopup");
  menu.append(popup);
  const modes = [["expanded", "Expanded", "Full sidebar"], ["compact", "Compact", "Icons and status"], ["hidden", "Hidden", "All page"], [null, "Like other sites", ""]];
  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) return;
    const host = hostOf(win.gBrowser.currentURI);
    const rule = LimaSidebarModes.ruleFor(host);
    popup.replaceChildren(...modes.map(([mode, label, hint]) => {
      const entry = doc.createXULElement("menuitem");
      entry.setAttribute("type", "radio");
      entry.setAttribute("label", hint ? `${label} — ${hint}` : label);
      if ((rule ?? null) === mode) entry.setAttribute("checked", "true");
      entry.addEventListener("command", () => LimaSidebarModes.set(win, host, mode));
      return entry;
    }));
  });
  // The label names the site; on a Lima page there's no site to set.
  const label = () => {
    const host = hostOf(win.gBrowser.currentURI);
    menu.hidden = !host;
    menu.setAttribute("label", `Sidebar on ${host}`);
  };
  menu.limaLabel = label;
  return menu;
}

/** No leading, trailing or doubled separators once items are hidden. */
function tidySeparators(popup) {
  let previous = null;
  for (const node of popup.children) {
    const shown = !node.hidden && !node.collapsed;
    if (node.localName !== "menuseparator") { if (shown) previous = node; continue; }
    node.hidden = !previous || previous.localName === "menuseparator";
    if (!node.hidden) previous = node;
  }
  if (previous?.localName === "menuseparator") previous.hidden = true;
}

/** The page a browser shows: title and URL only. */
function pageOf(browser) {
  return { url: browser?.currentURI?.spec ?? "", title: String(browser?.contentTitle || browser?.currentURI?.host || "").slice(0, 200) };
}

/** A menu listing this window's workspaces; `choose(workspace, tab)` runs on pick. */
function workspaceMenu(win, id, label, choose, contextTab) {
  const doc = win.document;
  const menu = doc.createXULElement("menu");
  menu.id = id;
  menu.setAttribute("label", label);
  menu.classList.add("menu-iconic", "lima-menuitem");
  menu.setAttribute("image", ICON("workspace"));
  const popup = doc.createXULElement("menupopup");
  menu.append(popup);
  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) return;
    const tab = contextTab();
    popup.replaceChildren(...lazy.LimaWorkspaces.roots(win).map(workspace => {
      const entry = doc.createXULElement("menuitem");
      entry.setAttribute("label", workspace.name);
      entry.addEventListener("command", () => {
        Promise.resolve().then(() => choose(workspace, tab))
          .catch(error => failed(win, label, error, () => choose(workspace, tab)));
      });
      return entry;
    }));
  });
  return menu;
}

function askAboutPage(win, page) {
  if (!/^https?:/.test(page.url)) throw new Error("Lima can only ask about web pages.");
  lazy.LimaSearchPanel.open(win, "", { context: { kind: "page", ...page } });
}

/** The Companion opens with the page named in its draft; nothing is sent
 * until the user sends it, and they can see exactly what is shared. */
function sendPageToAgent(win, page) {
  if (!/^https?:/.test(page.url)) throw new Error("Only web pages can be sent to an agent.");
  win.dispatchEvent(new win.CustomEvent("LimaAssistantOpen", { detail: { draft: `Use this page: ${page.title}\n${page.url}\n\n` } }));
}

async function saveSelection(win, page, text) {
  if (!text) throw new Error("Select some text on the page first.");
  const quoted = text.slice(0, 40000).split("\n").map(line => `> ${line}`).join("\n");
  const title = page.title ? `From ${page.title}`.slice(0, 100) : "Saved Selection";
  const note = await lazy.LimaNotesBookmarks.createNote({ title, kind: "classic", markdown: `${quoted}\n\nSource: [${page.title || page.url}](${page.url})\n` });
  showSidebarNotice(win, { title: "Selection saved", detail: note.title,
    actions: [["Open Note", () => lazy.LimaTabs.openOrFocus(win, `about:lima?note=${encodeURIComponent(note.id)}`)]] });
}

// MARK: Dock: music + dictation

function attachDock(win) {
  const doc = win.document;
  const title = el(doc, "span", { class: "lima-music-title" });
  const artist = el(doc, "span", { class: "lima-music-artist" });
  const control = (action, parameters = () => ({})) => async event => {
    event.stopPropagation();
    if (controlBusy) return;
    controlBusy = true;
    music.dataset.gesture = action === "next" || action === "previous" ? "skip" : action === "playpause" ? "tap" : "cue";
    try {
      if (source === "browser") browserControl(action, parameters());
      else await lazy.LimaBridge.request("media.control", { action, player: source, ...parameters() });
      await refresh(true);
      win.setTimeout(() => { if (music.hasAttribute("data-open")) refresh(true); }, 850);
    } catch (error) { flash(error.message); }
    finally {
      controlBusy = false;
      win.clearTimeout(gestureTimer);
      gestureTimer = win.setTimeout(() => { delete music.dataset.gesture; }, 620);
    }
  };
  const progress = el(doc, "input", { class: "lima-music-progress", type: "range", min: "0", max: "0", step: "0.25", "aria-label": "Track position" });
  const volume = el(doc, "input", { type: "range", min: "0", max: "100", "aria-label": "Audio volume" });
  const outputs = el(doc, "div", { class: "lima-audio-outputs", hidden: true, "aria-label": "Audio outputs" });
  const output = el(doc, "button", { class: "lima-music-btn", title: "Choose audio output", "aria-label": "Choose audio output", "aria-expanded": "false", onclick: toggleOutputs }, glyph(doc, "volume"));
  const elapsedTime = el(doc, "span", { class: "lima-music-time" });
  const durationTime = el(doc, "span", { class: "lima-music-time" });
  const timeline = el(doc, "div", { class: "lima-music-timeline" }, elapsedTime, progress, durationTime);
  const djMascot = el(doc, "img", { class: "lima-dj-mascot", src: "resource://lima-ui/marks/companion.svg#dj", alt: "" });
  const djScene = el(doc, "span", { class: "lima-dj-scene", "aria-hidden": "true" }, djMascot,
    el(doc, "i", { class: "lima-dj-record" }));
  // Spotify DJ exists only for Spotify; a tab playing media gets "Show Tab".
  const dj = el(doc, "button", { class: "lima-music-dj", title: "Play Spotify DJ", "aria-label": "Play Spotify DJ", onclick: control("dj") },
    el(doc, "img", { src: "resource://lima-ui/marks/spotify-dj.svg", alt: "" }));
  const showTab = el(doc, "button", { class: "lima-music-btn", title: "Show the tab that's playing", "aria-label": "Show the tab that's playing", hidden: true,
    onclick: event => { event.stopPropagation(); if (browserTab?.isConnected) win.gBrowser.selectedTab = browserTab; } }, glyph(doc, "tab"));
  // One player in Zen's compact media-card shape: an icon per source that's
  // playing (Spotify shows the DJ mark, a tab its own icon), transport and
  // mute. Clicking the bar, or the selected source's icon, expands Lima's
  // controls: the DJ, the track, its timeline, Spotify DJ or Show Tab,
  // volume and output.
  const sources = el(doc, "span", { class: "lima-music-sources", role: "group", "aria-label": "Playing now" });
  // Other sources playing at the same time stack above the bar, one slim
  // row each; clicking a row makes it the one the bar controls.
  const stack = el(doc, "div", { class: "lima-music-stack", role: "group", "aria-label": "Also playing" });
  const mute = el(doc, "button", { class: "lima-music-btn", title: "Volume", "aria-label": "Volume", "aria-expanded": "false", onclick: toggleMute }, glyph(doc, "volume"));
  // Just the simple controls: what's playing, previous / play / next, Spotify
  // DJ when Spotify plays, and a volume button that springs up a slider.
  const bar = el(doc, "div", { class: "lima-music-bar" },
    sources,
    el(doc, "span", { class: "lima-music-transport" },
      el(doc, "button", { class: "lima-music-btn", title: "Previous", "aria-label": "Previous", onclick: control("previous") }, glyph(doc, "previous")),
      el(doc, "button", { class: "lima-music-btn big", title: "Play / pause", "aria-label": "Play / pause", onclick: control("playpause") }, glyph(doc, "play")),
      el(doc, "button", { class: "lima-music-btn", title: "Next", "aria-label": "Next", onclick: control("next") }, glyph(doc, "next"))),
    dj, mute);
  // The volume slider row, above the bar while it's open.
  // The speaker beside the slider mutes: the tab when a tab plays, else the
  // Mac's volume (and a second click brings back the level it had).
  let unmutedVolume = null;
  const speaker = el(doc, "button", { class: "lima-music-btn lima-volume-speaker", title: "Mute", "aria-label": "Mute", "aria-pressed": "false",
    onclick: event => { event.stopPropagation(); toggleSilence(); } }, glyph(doc, "volume"));
  const volumeLabel = el(doc, "span", { class: "lima-volume-value", "aria-hidden": "true" });
  const volumePop = el(doc, "div", { class: "lima-volume-pop", hidden: true, role: "group", "aria-label": "Volume" },
    speaker, volume, volumeLabel);
  const playerHeader = el(doc, "div", { class: "lima-music-row" },
    djScene, el(doc, "span", { class: "lima-music-text" }, title, artist),
    el(doc, "span", { class: "lima-music-notes", "aria-hidden": "true" }, el(doc, "i", {}, "♪"), el(doc, "i", {}, "♫")));
  const expanded = el(doc, "div", { class: "lima-music-expanded" }, playerHeader, timeline,
    // The DJ and volume live in the bar and its slider row now.
    el(doc, "div", { class: "lima-music-audio" }, showTab, output), outputs);
  expanded.inert = true;
  const music = el(doc, "div", { id: "lima-music", hidden: true, "aria-label": "Now playing" },
    stack, volumePop, bar);
  const spotify = el(doc, "button", { id: "lima-spotify", title: "Sound", "aria-label": "Sound", "aria-expanded": "false", onclick: () => toggleMute() },
    el(doc, "span", { class: "lima-spotify-icon" }));

  const level = el(doc, "div", { class: "lima-dict-level" }, ...Array.from({ length: 5 }, () => el(doc, "i")));
  const dictLabel = el(doc, "span", { class: "lima-dict-label" });
  const dictation = el(doc, "div", { id: "lima-dictation", hidden: true },
    el(doc, "span", { class: "lima-dict-dot" }), level, dictLabel,
    el(doc, "button", { class: "lima-music-btn", title: "Stop and transcribe (⌃⌥D)", onclick: () => toggleDictation(win) }, glyph(doc, "stop")),
    el(doc, "button", { class: "lima-music-btn", title: "Cancel", onclick: () => lazy.LimaBridge.request("dictation.cancel").catch(() => {}) }, glyph(doc, "close")));
  const mic = el(doc, "button", { id: "lima-mic", title: "Dictate (⌃⌥D)", "aria-label": "Dictate", onclick: () => toggleDictation(win) }, glyph(doc, "mic"));
  const rail = el(doc, "div", { class: "lima-dock-rail", role: "toolbar", "aria-label": "Sidebar shortcuts" });

  const dock = el(doc, "div", { id: "lima-dock" }, el(doc, "div", { id: "lima-dock-main" }, music, dictation));

  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (foot?.parentNode) {
    foot.before(dock);
    const plus = doc.getElementById("zen-create-new-button");
    if (plus?.parentElement === foot) plus.after(rail);
    else foot.append(rail);
  } else {
    dock.append(rail);
    (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(dock);
  }

  // Now playing: Spotify, Apple Music (both reported by the runtime) or a
  // tab playing media (YouTube and any other site), whichever played last.
  let track = null;
  let source = "Spotify";
  const tracks = {};
  let browserTab = null;
  let browserController = null;
  const NAMES = { Spotify: "Spotify", Music: "Music", browser: "Browser audio" };
  // A source the user picked from the icons stays selected while it plays.
  let pinned = null;
  function choose() {
    if (pinned && tracks[pinned]?.state === "Playing") {
      source = pinned;
      track = tracks[pinned];
    } else {
      pinned = null;
      const candidates = Object.values(tracks).filter(item => item?.title || item?.player === "browser");
      const playing = candidates.filter(item => item.state === "Playing").sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const next = playing ?? tracks[source] ?? candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) { source = next.player; track = next; } else track = null;
    }
  }

  const privateWindow = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const playingTabs = () => privateWindow ? [] : [...win.gBrowser.tabs].filter(tab => !tab.closing && tab.hasAttribute("soundplaying"));
  function sourceIcon(entry) {
    // Spotify's own logo marks the source; the DJ mark stays on the DJ button.
    if (entry.player === "Spotify") return el(doc, "span", { class: "lima-glyph lima-spotify-mark" });
    if (entry.player === "Music") return el(doc, "span", { class: "lima-glyph lima-music-mark" });
    const image = entry.tab?.getAttribute("image");
    return image ? el(doc, "img", { src: image, alt: "" }) : glyph(doc, "audio");
  }
  const tabKeys = new WeakMap();
  let tabKeySeed = 0;
  const entryKey = entry => entry.player !== "browser" ? entry.player
    : entry.tab ? (tabKeys.get(entry.tab) ?? (tabKeys.set(entry.tab, `tab${++tabKeySeed}`), tabKeys.get(entry.tab))) : "browser";
  /** A slim row for a source that's playing but not in the bar. */
  function stackRow(entry) {
    const text = el(doc, "span", { class: "lima-music-alt-text" });
    const toggle = el(doc, "button", { class: "lima-music-btn", onclick: event => {
      event.stopPropagation();
      const current = row.limaEntry;
      if (current.player === "browser") { current.tab?.toggleMuteAudio(); paintTrack(); return; }
      lazy.LimaBridge.request("media.control", { action: "playpause", player: current.player })
        .then(() => refresh(true)).catch(error => flash(error.message));
    } }, glyph(doc, "pause"));
    const row = el(doc, "div", { class: "lima-music-alt", role: "button", tabindex: "0", "data-key": entryKey(entry),
      onclick: () => select(row.limaEntry),
      onkeydown: event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(row.limaEntry); } } },
    el(doc, "span", { class: "lima-music-alt-icon" }), text, toggle);
    row.limaText = text;
    row.limaToggle = toggle;
    return row;
  }
  function paintStackRow(row, entry) {
    row.limaEntry = entry;
    const item = entry.player === "browser" ? null : tracks[entry.player];
    const label = item ? [item.title, item.artist].filter(Boolean).join(" · ") : entry.label;
    if (row.limaText.textContent !== label) row.limaText.textContent = label;
    const icon = row.firstChild;
    const src = entry.player === "browser" ? entry.tab?.getAttribute("image") ?? "" : entry.player;
    if (icon.dataset.src !== src) { icon.dataset.src = src; icon.replaceChildren(sourceIcon(entry)); }
    const muted = entry.player === "browser" && entry.tab?.hasAttribute("muted");
    const action = entry.player === "browser" ? (muted ? "Unmute" : "Mute") : entry.playing ? "Pause" : "Play";
    row.limaToggle.firstChild.style.maskImage = `url("${ICON(entry.player === "browser" ? (muted ? "mute" : "volume") : entry.playing ? "pause" : "play")}")`;
    row.limaToggle.title = `${action} ${NAMES[entry.player]}`;
    row.limaToggle.setAttribute("aria-label", row.limaToggle.title);
    row.title = `Control ${entry.label}`;
    row.setAttribute("aria-label", row.title);
  }
  /** The selected source's icon sits in the bar; every other source that's
   * playing gets a row in the stack, springing in and sinking away. */
  function paintSources() {
    const open = music.hasAttribute("data-open");
    const entries = [];
    for (const player of ["Spotify", "Music"]) {
      const item = tracks[player];
      if (item?.title && (item.state === "Playing" || source === player)) entries.push({ player, label: `${NAMES[player]}: ${item.title}`, playing: item.state === "Playing" });
    }
    const tabs = playingTabs();
    if (source === "browser" && browserTab?.isConnected && !tabs.includes(browserTab)) tabs.unshift(browserTab);
    for (const tab of tabs) entries.push({ player: "browser", tab, label: tab.label, playing: tab.hasAttribute("soundplaying") });
    if (!entries.length) entries.push({ player: source, tab: source === "browser" ? browserTab : null, label: NAMES[source], playing: false });
    const isSelected = entry => entry.player === source && (entry.player !== "browser" || !entry.tab || entry.tab === browserTab);
    const current = entries.find(isSelected) ?? entries[0];
    const label = `${current.label} — ${open ? "collapse" : "expand"} controls`;
    const key = entryKey(current);
    let button = sources.firstChild;
    if (button?.dataset.key !== key) {
      button = el(doc, "button", { class: "lima-music-source", "data-key": key, onclick: event => {
        event.stopPropagation();
        // A tab playing audio: go to it.
        if (source === "browser" && browserTab?.isConnected) win.gBrowser.selectedTab = browserTab;
      } }, sourceIcon(current));
      sources.replaceChildren(button);
    }
    button.dataset.player = current.player;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", String(open));
    button.toggleAttribute("data-playing", current.playing);

    const rows = new Map([...stack.children].filter(row => !isLeaving(row)).map(row => [row.dataset.key, row]));
    let previous = null;
    for (const entry of entries) {
      if (entry === current) continue;
      let row = rows.get(entryKey(entry));
      rows.delete(entryKey(entry));
      const fresh = !row;
      if (fresh) row = stackRow(entry);
      paintStackRow(row, entry);
      const place = previous ? previous.nextSibling : stack.firstChild;
      if (row !== place) stack.insertBefore(row, place);
      if (fresh) popIn(row, { flow: true, gap: 0 });
      previous = row;
    }
    for (const row of rows.values()) sinkAway(row, { flow: true, gap: 0, done: () => row.remove() });
    music.toggleAttribute("data-stacked", entries.length > 1);
  }
  function select(entry) {
    pinned = entry.player;
    if (entry.player === "browser" && entry.tab !== browserTab) watchTab(entry.tab);
    source = entry.player;
    track = tracks[source] ?? null;
    paintTrack();
    refresh(true);
  }
  /** The volume button: a slider springs up above the bar (and folds away). */
  function toggleMute(event) {
    event?.stopPropagation();
    // The sound button brings a collapsed bar back with its volume slider.
    if (music.hidden) { lastActive = Date.now(); paintTrack(); }
    const open = volumePop.hidden || volumePop.limaLeaving;
    mute.setAttribute("aria-expanded", String(open));
    if (!open) { sinkAway(volumePop, { flow: true, gap: 0 }); return; }
    popIn(volumePop, { flow: true, gap: 0 });
    lazy.LimaBridge.request("audio.volume").then(value => {
      volume.value = Math.round((value ?? 0) * 100);
      volumeLabel.textContent = `${volume.value}%`;
      paintSpeaker();
    }).catch(() => {});
    volume.focus();
    keepVolumeOpen();
  }
  const silenced = () => source === "browser" ? !!browserTab?.hasAttribute("muted") : Number(volume.value) === 0;
  function paintSpeaker() {
    const muted = silenced();
    speaker.firstChild.style.maskImage = `url("${ICON(muted ? "mute" : "volume")}")`;
    const label = source === "browser" ? (muted ? "Unmute tab" : "Mute tab") : (muted ? "Unmute" : "Mute");
    speaker.title = label;
    speaker.setAttribute("aria-label", label);
    speaker.setAttribute("aria-pressed", String(muted));
  }
  async function toggleSilence() {
    keepVolumeOpen();
    if (source === "browser") {
      if (browserTab?.isConnected) browserTab.toggleMuteAudio();
      paintTrack();
      paintSpeaker();
      return;
    }
    const current = Number(volume.value);
    const next = current === 0 ? (unmutedVolume || 50) : 0;
    if (current) unmutedVolume = current;
    volume.value = next;
    volumeLabel.textContent = `${next}%`;
    paintSpeaker();
    try { await lazy.LimaBridge.request("audio.volume", { value: next / 100 }); } catch (error) { flash(error.message); }
  }
  let volumeTimer;
  function keepVolumeOpen() {
    win.clearTimeout(volumeTimer);
    volumeTimer = win.setTimeout(() => {
      if (volumePop.matches(":hover, :focus-within")) { keepVolumeOpen(); return; }
      mute.setAttribute("aria-expanded", "false");
      sinkAway(volumePop, { flow: true, gap: 0 });
    }, 4000);
  }
  let flashTimer = null;
  let controlBusy = false;
  let gestureTimer = null;
  let revision = 0;
  let musicVisible = true;
  const IDLE_MS = 5 * 60_000;
  let lastActive = 0;
  let idleTimer = null;
  let scrubbing = false;
  const personality = () => music.dataset.personality = Services.prefs.getStringPref("lima.personality", "full");
  personality();
  Services.prefs.addObserver("lima.personality", personality);
  win.addEventListener("unload", () => Services.prefs.removeObserver("lima.personality", personality), { once: true });
  const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function flash(text) {
    artist.textContent = text;
    bar.title = text;
    win.clearTimeout(flashTimer);
    flashTimer = win.setTimeout(() => paintTrack(), 1600);
  }
  function paintTrack() {
    const open = music.hasAttribute("data-open");
    // The bar collapses when nothing has played for a few minutes; playing
    // anything (or the sound button) brings it back.
    const active = track?.state === "Playing" || playingTabs().length > 0;
    if (active) lastActive = Date.now();
    const idle = !active && Date.now() - lastActive > IDLE_MS && !music.hasAttribute("data-open") && volumePop.hidden;
    music.hidden = (!musicVisible && source !== "browser") || idle;
    win.clearTimeout(idleTimer);
    if (!active && !idle) idleTimer = win.setTimeout(() => paintTrack(), IDLE_MS - (Date.now() - lastActive) + 200);
    music.dataset.source = source;
    spotify.dataset.source = source;
    dj.hidden = source !== "Spotify";
    showTab.hidden = source !== "browser";
    expanded.inert = !open;
    spotify.setAttribute("aria-expanded", String(open));
    const muted = source === "browser" && browserTab?.hasAttribute("muted");
    mute.firstChild.style.maskImage = `url("${ICON(muted ? "mute" : "volume")}")`;
    const muteLabel = source === "browser" ? (muted ? "Unmute tab" : "Mute tab") : "Volume";
    mute.title = muteLabel;
    mute.setAttribute("aria-label", muteLabel);
    // With no panel, the bar's tooltip names what's playing.
    bar.title = track?.title ? [track.title, track.artist].filter(Boolean).join(" · ") : NAMES[source];
    paintSources();
    title.textContent = track?.title || NAMES[source];
    artist.textContent = track?.title ? track.artist : `${NAMES[source]} is idle`;
    const icon = track?.state === "Playing" ? "pause" : "play";
    for (const node of music.querySelectorAll('.lima-glyph[data-role="pp"], .lima-music-btn[title="Play / pause"] .lima-glyph')) node.style.maskImage = `url("${ICON(icon)}")`;
    // The source's own icon lets out little notes while it plays.
    if (!volumePop.hidden) paintSpeaker();
    music.toggleAttribute("data-playing", track?.state === "Playing");
    if (track?.positionMs != null && music.dataset.personality === "full") {
      const elapsed = track.state === "Playing" ? Math.max(0, Date.now() - track.updatedAt) : 0;
      const position = track.positionMs + elapsed;
      for (const animation of playerHeader.getAnimations({ subtree: true })) {
        if (!["dj-groove", "dj-spin", "lima-note-lift"].includes(animation.animationName)) continue;
        if (animation.currentTime == null || Math.abs(animation.currentTime - position) > 160) animation.currentTime = position;
      }
    }
    tick();
  }
  function tick() {
    progress.disabled = !track?.durationMs || track.positionMs == null;
    timeline.hidden = progress.disabled;
    if (progress.disabled || scrubbing) return;
    const elapsed = track.state === "Playing" ? Date.now() - track.updatedAt : 0;
    const position = Math.min(track.durationMs, track.positionMs + elapsed);
    progress.max = track.durationMs / 1000;
    progress.value = position / 1000;
    elapsedTime.textContent = fmt(position);
    durationTime.textContent = fmt(track.durationMs);
  }
  let inactivity, ticker;
  function closeOutputs() {
    outputs.hidden = true;
    output.setAttribute("aria-expanded", "false");
  }
  function keepMusicOpen() {
    win.clearTimeout(inactivity);
    if (!music.hasAttribute("data-open")) return;
    inactivity = win.setTimeout(() => {
      if (scrubbing || !outputs.hidden || controlBusy) { keepMusicOpen(); return; }
      toggleSpotify();
    }, 8500);
  }
  for (const event of ["pointerdown", "keydown", "focusin"]) music.addEventListener(event, keepMusicOpen);
  async function toggleOutputs() {
    if (!outputs.hidden) { closeOutputs(); keepMusicOpen(); return; }
    outputs.hidden = false;
    output.setAttribute("aria-expanded", "true");
    outputs.textContent = "Loading audio outputs…";
    try {
      const devices = await lazy.LimaBridge.request("audio.outputs");
      outputs.replaceChildren(...devices.map(device => el(doc, "button", {
        text: device.name, "aria-pressed": String(device.isDefault), onclick: async () => {
          try {
            await lazy.LimaBridge.request("audio.setOutput", { id: device.id });
            output.title = device.name;
            closeOutputs();
            output.focus();
          } catch (error) { flash(error.message); }
          keepMusicOpen();
        },
      })));
      if (!devices.length) outputs.textContent = "No audio outputs available.";
    } catch (error) { outputs.textContent = error.message; }
  }
  music.addEventListener("keydown", event => {
    if (event.key === "Escape" && !outputs.hidden) { closeOutputs(); output.focus(); }
  });
  win.addEventListener("unload", () => { win.clearInterval(ticker); win.clearTimeout(inactivity); }, { once: true });
  const refresh = (update = false) => {
    const request = ++revision;
    if (source === "browser") { readBrowser(); return Promise.resolve(); }
    const player = source;
    return lazy.LimaBridge.request("media.nowPlaying", { player, refresh: update }).then(item => {
      if (request !== revision) return;
      if (item) tracks[player] = item; else delete tracks[player];
      choose();
      paintTrack();
    }).catch(error => { if (update) flash(error.message); });
  };

  // MARK: Media in tabs
  function readBrowser() {
    const controller = browserController;
    if (!controller || !browserTab?.isConnected) { delete tracks.browser; return; }
    let metadata = {};
    try { metadata = controller.getMetadata() ?? {}; } catch {}
    let host = "";
    try { host = browserTab.linkedBrowser.currentURI.host.replace(/^www\./, ""); } catch {}
    const previous = tracks.browser;
    tracks.browser = {
      player: "browser",
      title: metadata.title || browserTab.label || host,
      artist: metadata.artist || host,
      state: controller.isPlaying ? "Playing" : "Paused",
      durationMs: previous?.durationMs, positionMs: previous?.positionMs,
      updatedAt: controller.isPlaying || !previous ? Date.now() : previous.updatedAt,
    };
  }
  function browserControl(action, parameters) {
    const controller = browserController;
    if (!controller) throw new Error("Nothing is playing in a tab.");
    if (action === "playpause") controller.isPlaying ? controller.pause("user") : controller.play();
    else if (action === "next") controller.nextTrack();
    else if (action === "previous") controller.prevTrack();
    else if (action === "seek") controller.seekTo(parameters.seconds);
  }
  const onBrowserChange = () => { readBrowser(); choose(); paintTrack(); };
  function onPosition(event) {
    if (!tracks.browser || !Number.isFinite(event.duration) || event.duration <= 0) return;
    tracks.browser.durationMs = event.duration * 1000;
    tracks.browser.positionMs = (event.position ?? 0) * 1000;
    tracks.browser.updatedAt = Date.now();
    if (source === "browser") paintTrack();
  }
  function watchTab(tab) {
    if (browserController) {
      for (const name of ["metadatachange", "playbackstatechange", "deactivated"]) browserController.removeEventListener(name, onBrowserChange);
      browserController.removeEventListener("positionstatechange", onPosition);
    }
    browserTab = tab;
    browserController = tab?.linkedBrowser?.browsingContext?.mediaController ?? null;
    if (browserController) {
      for (const name of ["metadatachange", "playbackstatechange", "deactivated"]) browserController.addEventListener(name, onBrowserChange);
      browserController.addEventListener("positionstatechange", onPosition);
    }
    onBrowserChange();
  }
  // The tab that most recently started playing sound; private windows don't share theirs.
  if (!privateWindow) {
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
      const changed = event.detail?.changed ?? [];
      if (changed.includes("muted") && event.target === browserTab) { paintTrack(); return; }
      if (!changed.includes("soundplaying")) return;
      const tab = event.target;
      // A user-picked tab keeps the controls while it plays; otherwise the
      // controls follow the tab that started last.
      const keep = pinned === "browser" && browserTab?.hasAttribute("soundplaying") && tab !== browserTab;
      if (tab.hasAttribute("soundplaying")) { if (keep) paintTrack(); else if (tab !== browserTab) watchTab(tab); else onBrowserChange(); }
      else if (tab === browserTab) {
        const other = playingTabs().find(candidate => candidate !== tab);
        if (other) watchTab(other); else onBrowserChange();
      } else paintTrack();
    });
    win.gBrowser.tabContainer.addEventListener("TabClose", event => {
      if (event.target === browserTab) watchTab(playingTabs().find(tab => tab !== event.target) ?? null);
      else if (event.target.hasAttribute("soundplaying")) win.setTimeout(paintTrack, 0);
    });
  }
  function toggleSpotify() {
    music.toggleAttribute("data-open");
    paintTrack();
    win.clearInterval(ticker);
    if (music.hasAttribute("data-open")) {
      refresh(true);
      ticker = win.setInterval(() => { if (!music.hidden && !doc.hidden) tick(); }, 1000);
      lazy.LimaBridge.request("audio.volume").then(value => { volume.value = Math.round((value ?? 0) * 100); }).catch(() => {});
    } else closeOutputs();
    keepMusicOpen();
  }
  progress.addEventListener("input", () => { scrubbing = true; elapsedTime.textContent = fmt(Number(progress.value) * 1000); });
  progress.addEventListener("change", event => {
    const seconds = Number(progress.value);
    control("seek", () => ({ seconds }))(event).finally(() => { scrubbing = false; tick(); });
  });
  progress.addEventListener("blur", () => { scrubbing = false; });
  volume.addEventListener("input", () => { volumeLabel.textContent = `${volume.value}%`; paintSpeaker(); keepVolumeOpen(); });
  volume.addEventListener("change", () => lazy.LimaBridge.request("audio.volume", { value: Number(volume.value) / 100 }).catch(error => flash(error.message)));
  // One volume control: scroll on the pill.
  let volumeBusy = false;
  music.addEventListener("wheel", async event => {
    event.preventDefault();
    if (volumeBusy) return;
    volumeBusy = true;
    try {
      const current = await lazy.LimaBridge.request("audio.volume");
      const next = Math.max(0, Math.min(1, (current ?? 0.5) + (event.deltaY < 0 ? 0.04 : -0.04)));
      await lazy.LimaBridge.request("audio.volume", { value: next });
      flash(`Volume ${Math.round(next * 100)}%`);
    } catch (error) {
      flash(error.message);
    } finally {
      volumeBusy = false;
    }
  }, { passive: false });

  // Dictation pill.
  function paintDictation(state) {
    const active = ["recording", "transcribing", "failed"].includes(state.phase);
    dictation.hidden = !active;
    music.toggleAttribute("data-covered", active);
    mic.toggleAttribute("data-recording", state.phase === "recording");
    dictation.setAttribute("data-phase", state.phase);
    if (state.phase === "recording") {
      dictLabel.textContent = fmt(state.elapsedMs);
      const bars = [...level.children];
      bars.forEach((bar, i) => { bar.style.transform = `scaleY(${Math.max(0.15, Math.min(1, state.level * (1.4 - Math.abs(i - 2) * 0.25)))})`; });
    } else if (state.phase === "transcribing") {
      dictLabel.textContent = "Transcribing…";
    } else if (state.phase === "failed") {
      dictLabel.textContent = state.error ?? "Dictation failed";
      dictation.title = state.error ?? "";
      win.setTimeout(() => { if (dictation.getAttribute("data-phase") === "failed") dictation.hidden = true; music.removeAttribute("data-covered"); }, 6000);
    }
  }

  lazy.LimaBridge.onEvent(message => {
    if (message.event === "media.nowPlaying" && ["Spotify", "Music"].includes(message.data?.player)) {
      revision++;
      tracks[message.data.player] = message.data;
      choose();
      paintTrack();
    }
    else if (message.event === "dictation.state") paintDictation(message.data);
    else if (message.event === "dictation.result") deliverDictation(win, message.data).catch(error => showDictationError(win, error));
  });
  for (const player of ["Spotify", "Music"]) {
    lazy.LimaBridge.request("media.nowPlaying", { player }).then(item => {
      if (item && !tracks[player]) { tracks[player] = item; choose(); paintTrack(); }
    }).catch(() => {});
  }
  lazy.LimaBridge.request("dictation.status").then(paintDictation).catch(() => {});
  attachServices(win, dock, rail, spotify, mic, visible => {
    musicVisible = visible;
    if (!visible) music.removeAttribute("data-open");
    paintTrack();
  });
}

function attachServices(win, dock, rail, spotify, mic, hideSpotify) {
  const doc = win.document;
  const main = dock.querySelector("#lima-dock-main");
  const privateMode = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const pref = "lima.sidebar.shortcuts";
  const definitions = { inbox: "Gmail", calendar: "Google Calendar", spotify: "Music", downloads: "Downloads", mic: "Dictation", grammar: "Grammar settings" };
  const settingsURL = section => `about:lima?view=integrations&section=${section}`;
  const gmailURL = "https://mail.google.com/mail/u/0/#inbox";
  const calendarURL = "https://calendar.google.com/calendar/u/0/r";
  const launch = url => lazy.LimaTabs.openOrFocus(win, url);
  const notice = el(doc, "div", { class: "lima-services-notice", hidden: true });
  main.prepend(notice);
  let snapshot = null;
  let nativeStatus;
  let tabStatus = {};
  const keptLoaded = new Set();
  const since = Date.now();
  const seenMail = new Map();
  const pendingMail = [];
  const meetingNotices = new Map();
  let essentialBaseline = false;
  let noticeKind;
  let dismissTimer;
  let sequence = 0;
  function jump(name) {
    const service = name === "inbox" ? "mail" : "calendar";
    const essential = googleEssentialTabs(win)[service];
    if (essential) {
      win.gBrowser.selectedTab = essential.tab;
      closeNotice();
    } else if (snapshot?.[service] === "connected") {
      launch(name === "inbox" ? gmailURL : calendarURL);
      closeNotice();
    } else launch(settingsURL("google"));
  }
  const control = (label, icon, run) => el(doc, "button", { title: label, "aria-label": label, onclick: run }, glyph(doc, icon));
  const inbox = control("Gmail", "inbox", () => jump("inbox"));
  const calendar = control("Google Calendar", "calendar", () => jump("calendar"));
  const grammar = control("Grammar settings", "grammar", () => launch(settingsURL("grammar")));
  const downloads = lazy.LimaDownloads.attach(win, dock);
  const buttons = { inbox, calendar, spotify, downloads, mic, grammar };
  const settings = control("Settings", "sliders", () => launch("about:lima?view=integrations"));
  settings.id = "lima-settings-button";
  (doc.getElementById("zen-sidebar-foot-buttons") ?? dock).append(settings);
  const defaultOrder = Object.keys(definitions);

  function layout() {
    let stored;
    try { stored = JSON.parse(Services.prefs.getStringPref(pref, "{}")); } catch {}
    const ordered = [...new Set((Array.isArray(stored?.order) ? stored.order : []).filter(id => Object.hasOwn(definitions, id)))];
    const hidden = new Set(Array.isArray(stored?.hidden) ? stored.hidden : ["grammar"]);
    return { order: [...ordered, ...defaultOrder.filter(id => !ordered.includes(id))], hidden };
  }

  function paintRail() {
    const { order, hidden } = layout();
    const visible = order.filter(id => !hidden.has(id) && (!privateMode || !["inbox", "calendar"].includes(id)));
    hideSpotify(visible.includes("spotify"));
    const current = doc.activeElement;
    rail.replaceChildren(...visible.map(id => buttons[id]));
    if (current?.isConnected && rail.contains(current)) current.focus();
  }

  // Sinks away, then the next queued email (if any) rises in its place.
  function closeNotice() {
    win.clearTimeout(dismissTimer);
    sinkAway(notice, { flow: true, done: () => win.setTimeout(paint, 120) });
  }

  /* A mail or meeting reminder: which service and when on top, the subject
   * or meeting in full (two lines), who or how soon, and real buttons. It
   * stays while the pointer is on it. */
  function remind(kind, title, detail, action, duration, extra) {
    noticeKind = kind;
    const meeting = kind.startsWith("meeting");
    notice.setAttribute("role", "status");
    notice.dataset.kind = kind;
    action.classList.add("lima-reminder-primary");
    notice.replaceChildren(
      el(doc, "div", { class: "lima-reminder-head" },
        el(doc, "span", { class: "lima-reminder-icon", "aria-hidden": "true" }, glyph(doc, meeting ? "calendar" : "inbox")),
        el(doc, "span", { class: "lima-reminder-source", text: meeting ? "Calendar" : "Gmail" }),
        el(doc, "span", { class: "lima-reminder-when", text: kind === "meeting-start" ? "Now" : meeting ? "Up next" : "New" }),
        control("Dismiss reminder", "close", closeNotice)),
      el(doc, "div", { class: "lima-reminder-copy" }, el(doc, "strong", { text: title }),
        el(doc, "span", { class: "lima-reminder-detail", text: detail })),
      el(doc, "div", { class: "lima-reminder-actions" }, action, extra));
    popIn(notice, { flow: true });
    win.clearTimeout(dismissTimer);
    const later = ms => { win.clearTimeout(dismissTimer); dismissTimer = win.setTimeout(closeNotice, ms); };
    notice.onmouseenter = () => win.clearTimeout(dismissTimer);
    notice.onmouseleave = () => later(3500);
    later(duration);
  }

  function meetingReminder(meeting, started) {
    const open = el(doc, "button", { onclick: () => { launch(meeting.link || calendarURL); closeNotice(); } }, "Open Calendar");
    let mic;
    if (started) mic = el(doc, "button", { class: "lima-reminder-secondary", title: "Dictate a meeting note", onclick: () => {
      win.clearTimeout(dismissTimer);
      const detail = notice.querySelector(".lima-reminder-detail");
      detail.textContent = "Dictate up to 50 seconds. Apple Speech Recognition may send audio to Apple.";
      mic.replaceWith(el(doc, "button", { class: "lima-reminder-secondary", onclick: () => { closeNotice(); startMeetingDictation(win, meeting.title); } },
        "Start dictation"));
      notice.querySelector(".lima-reminder-actions button:last-child")?.focus();
    } }, glyph(doc, "mic"), "Take notes");
    const minutes = Math.max(1, Math.ceil((meeting.startsAt - Date.now()) / 60000));
    const time = at => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const span = meeting.endsAt ? `${time(meeting.startsAt)} – ${time(meeting.endsAt)}` : time(meeting.startsAt);
    remind(started ? "meeting-start" : "meeting-soon", meeting.title, started ? span : `In ${minutes} min · ${span}`,
      open, started ? 45000 : 12000, mic);
  }

  function paint() {
    const result = { ...nativeStatus };
    // Essential tab metadata is local to this window. GWS fills gaps when the
    // tab layout doesn't expose a usable count or time.
    if (tabStatus.mail) Object.assign(result, { mail: "connected", unread: tabStatus.mail.unread, mailReconnect: false });
    if (tabStatus.calendar && result.calendar !== "connected") Object.assign(result, {
      calendar: "connected", meetings: tabStatus.calendar.meetings, calendarReconnect: false,
    });
    if (tabStatus.mail || tabStatus.calendar) result.enabled = true;
    snapshot = result;
    const count = result.unread ?? 0;
    inbox.toggleAttribute("lima-reconnect", result.enabled && result.mailReconnect);
    calendar.toggleAttribute("lima-reconnect", result.enabled && result.calendarReconnect);
    inbox.toggleAttribute("lima-unread", result.mail === "connected" && count > 0);
    const now = Date.now();
    const meetings = result.meetings ?? (result.meeting ? [result.meeting] : []);
    calendar.toggleAttribute("lima-upcoming", meetings.some(meeting => meeting.startsAt > now && meeting.startsAt <= now + 600000));
    inbox.title = result.mailReconnect ? "Reconnect Gmail" : count > 0 ? `Gmail · ${count} unread` : "Gmail";
    calendar.title = result.calendarReconnect ? "Reconnect Google Calendar" : "Google Calendar";
    inbox.setAttribute("aria-label", inbox.title);
    calendar.setAttribute("aria-label", calendar.title);
    if (!result.enabled) { closeNotice(); pendingMail.length = 0; essentialBaseline = false; return; }
    const nativePreviews = result.mailPreviews;
    const previews = nativePreviews ?? tabStatus.mail?.previews ?? [];
    for (const message of [...previews].reverse()) {
      const key = `${nativePreviews ? "api" : "tab"}:${message.id}`;
      if (seenMail.has(key)) continue;
      seenMail.set(key, now);
      if (nativePreviews ? message.receivedAt >= since : essentialBaseline) pendingMail.push(message);
    }
    if (tabStatus.mail?.previews?.length || tabStatus.mail?.unread === 0) essentialBaseline = true;
    if (pendingMail.length > 8) pendingMail.splice(0, pendingMail.length - 8);
    for (const [key, time] of seenMail) if (now - time > 86400000 && !previews.some(message => key.endsWith(`:${message.id}`))) seenMail.delete(key);
    for (const [key, time] of meetingNotices) if (now - time > 86400000) meetingNotices.delete(key);
    if (!(doc.hasFocus() || Services.focus.activeWindow === win)) return;
    if (result.calendar === "connected" && calendar.isConnected) {
      for (const started of [true, false]) {
        if (!notice.hidden && noticeKind === "meeting-start") break;
        const meeting = meetings.find(item => {
          const offset = item.startsAt - now;
          const key = `${item.startsAt}:${item.title}:${started}`;
          return !meetingNotices.has(key) && (started
            ? offset <= 0 && offset >= -120000 && (item.endsAt == null || item.endsAt > now)
            : offset > 0 && offset <= 600000);
        });
        if (meeting) {
          meetingNotices.set(`${meeting.startsAt}:${meeting.title}:${started}`, now);
          meetingReminder(meeting, started);
          return;
        }
      }
    }
    if (notice.hidden && result.mail === "connected" && inbox.isConnected && pendingMail.length) {
      const message = pendingMail.shift();
      const action = el(doc, "button", { onclick: () => {
        if (message.link) { launch(message.link); closeNotice(); } else jump("inbox");
      } }, message.link ? "Open email" : "Open inbox");
      remind("mail", message.subject, message.sender, action, 7000);
    }
  }

  async function refresh() {
    if (privateMode || doc.hidden) return;
    const ticket = ++sequence;
    try {
      const result = await lazy.LimaBridge.request("integrations.google.refresh");
      if (ticket === sequence && result) { nativeStatus = result; paint(); }
    } catch {}
  }
  let readingTabs = false;
  async function refreshTabs() {
    if (privateMode || doc.hidden || readingTabs) return;
    readingTabs = true;
    try {
      tabStatus = await refreshGoogleEssentials(win, keptLoaded);
      win.limaGoogleEssentialStatus = { mail: Boolean(tabStatus.mail), calendar: Boolean(tabStatus.calendar) };
      paint();
    } finally { readingTabs = false; }
  }
  const tabEvents = ["TabSelect", "TabOpen", "TabClose", "TabAttrModified", "SSTabRestored"];
  let refreshTimer;
  const scheduleTabs = () => {
    win.clearTimeout(refreshTimer);
    refreshTimer = win.setTimeout(refreshTabs, 450);
  };
  for (const event of tabEvents) win.gBrowser.tabContainer.addEventListener(event, scheduleTabs);
  doc.addEventListener("visibilitychange", scheduleTabs);
  const tabTimer = win.setInterval(refreshTabs, 5000);
  Services.prefs.addObserver(pref, paintRail);
  const off = lazy.LimaBridge.onEvent(({ event, data }) => {
    if (!privateMode && event === "integrations.google.updated" && data) { sequence++; nativeStatus = data; paint(); }
  });
  const timer = win.setInterval(refresh, 20000);
  const clock = win.setInterval(() => { if (!privateMode && !doc.hidden && snapshot?.enabled) paint(); }, 3000);
  win.addEventListener("focus", () => { paint(); refresh(); scheduleTabs(); });
  doc.addEventListener("visibilitychange", refresh);
  win.addEventListener("unload", () => {
    off();
    Services.prefs.removeObserver(pref, paintRail);
    win.clearInterval(timer);
    win.clearInterval(tabTimer);
    win.clearInterval(clock);
    win.clearTimeout(refreshTimer);
    for (const event of tabEvents) win.gBrowser.tabContainer.removeEventListener(event, scheduleTabs);
    win.clearTimeout(dismissTimer);
  }, { once: true });
  paintRail();
  refresh();
  refreshTabs();
}

// MARK: Dictation

let meetingDictationWindow;

async function startMeetingDictation(win, meeting) {
  try {
    const result = await lazy.LimaBridge.request("dictation.status");
    if (["recording", "transcribing"].includes(result.phase)) throw new Error("Finish the current dictation first.");
    meetingDictationWindow = win;
    await lazy.LimaBridge.request("dictation.start", { meeting });
  } catch (error) {
    meetingDictationWindow = null;
    showDictationError(win, error);
  }
}

function noteIdOf(tab) {
  const url = tab && lazy.tabURL(tab);
  return url?.startsWith("about:lima?note=") ? decodeURIComponent(url.slice("about:lima?note=".length).split("&")[0]) : null;
}

async function toggleDictation(win) {
  try {
    const status = await lazy.LimaBridge.request("dictation.status");
    if (status.phase === "recording") await lazy.LimaBridge.request("dictation.stop");
    else if (status.phase !== "transcribing") await lazy.LimaBridge.request("dictation.start", { target: noteIdOf(win.gBrowser.selectedTab) });
  } catch (error) {
    showDictationError(win, error);
  }
}

function showDictationError(win, error) {
  const pill = win.document.getElementById("lima-dictation");
  if (!pill) return;
  pill.hidden = false;
  pill.setAttribute("data-phase", "failed");
  pill.querySelector(".lima-dict-label").textContent = error.message;
  win.setTimeout(() => { if (pill.getAttribute("data-phase") === "failed") pill.hidden = true; }, 6000);
}

/** Text goes into the note you were in (its open page inserts it at the
 * cursor); otherwise into a new Dictation note, as in 4.x. */
async function deliverDictation(win, { text, target, meeting }) {
  if (!text) return;
  if (meeting) {
    const owner = meetingDictationWindow?.closed || !meetingDictationWindow
      ? lazy.BrowserWindowTracker.getTopWindow({ private: false }) : meetingDictationWindow;
    if (owner !== win) return;
  }
  const page = target && [...win.gBrowser.tabs].find(tab => noteIdOf(tab) === target && tab.linkedPanel && !tab.hasAttribute("pending"));
  if (page) return; // the note page handles dictation.result itself
  if (target) {
    try {
      const note = await lazy.LimaBridge.request("notes.get", { id: target });
      await lazy.LimaBridge.request("notes.apply", { id: target, author: "user",
        edits: [{ setMarkdown: { _0: `${note.markdown.replace(/\s+$/, "")}\n\n${text}\n` } }] });
      return;
    } catch {}
  }
  const stamp = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const note = await lazy.LimaNotesBookmarks.createNote({ title: meeting ? `${meeting} — Dictation` : `Dictation — ${stamp}`, kind: "classic", markdown: `${text}\n` });
  lazy.LimaTabs.openOrFocus(win, `about:lima?note=${encodeURIComponent(note.id)}`);
}

// MARK: Folder behaviour

function attachFolderBehaviour(win) {
  const doc = win.document;
  const openWorkspaceChat = event => {
    if (event.button !== 0 || event.target.closest?.(".lima-workspace-disclosure, input")) return;
    const label = event.target.closest?.(".tab-group-label-container");
    const folder = label?.parentElement;
    if (!folder?.hasAttribute("lima-workspace")) return;
    event.stopPropagation();
    if (event.type === "click") {
      event.preventDefault();
      lazy.LimaWorkspaces.openChat(win, folder.getAttribute("lima-workspace"));
    }
  };
  doc.addEventListener("click", openWorkspaceChat, true);
  win.gBrowser.tabContainer.addEventListener("TabSelect", () => lazy.LimaWorkspaces.onTabSelect(win));

  win.addEventListener("ZenFolderRenamed", event => {
    const folder = event.target;
    if (folder.hasAttribute?.("lima-workspace")) lazy.LimaWorkspaces.onFolderRenamed(folder);
  });

  // Folder icons: Zen's Change Icon picker, with emoji too, drawn in Lima's
  // style. Zen stores the choice with the folder; it's painted on restore.
  const paintAll = () => { for (const folder of doc.querySelectorAll("zen-folder")) lazy.LimaWorkspaces.paintFolderIcon(folder); };
  win.addEventListener("TabGroupUpdate", event => lazy.LimaWorkspaces.paintFolderIcon(event.target));
  win.addEventListener("TabGroupCreate", event => lazy.LimaWorkspaces.paintFolderIcon(event.target));
  win.gZenStartup?.promiseInitialized?.then(() => { paintAll(); win.setTimeout(paintAll, 1500); win.setTimeout(paintAll, 5000); }, () => {});
  const folderMenu = doc.getElementById("zenFolderActions");
  folderMenu?.addEventListener("command", event => {
    if (event.target.id !== "context_zenFolderChangeIcon") return;
    const folder = contextFolder(win, folderMenu);
    if (!folder || !win.gZenEmojiPicker) return;
    event.stopImmediatePropagation();
    let current = "";
    try { current = folder.iconURL; } catch {}
    win.gZenEmojiPicker.open(folder.icon, {
      onlySvgIcons: false,
      allowNone: Boolean(current),
      closeOnSelect: true,
      onSelect: icon => {
        // An emoji arrives as the character itself; draw it as an image.
        const url = !icon ? null : /^(chrome|resource|data|moz-extension):/.test(icon) ? icon : lazy.LimaWorkspaces.iconURL(icon);
        lazy.LimaWorkspaces.setFolderIcon(win, folder, url);
      },
    });
  }, true);
  folderMenu?.addEventListener("popupshowing", event => {
    if (event.target !== folderMenu) return;
    const item = doc.getElementById("context_zenFolderChangeIcon");
    if (item) item.hidden = !!contextFolder(win, folderMenu)?.hasAttribute("lima-workspace");
  });

  // The tab list only scrolls up and down. Revealing a deeply nested tab
  // could scroll it sideways too, cutting off the start of every row.
  const pinned = new WeakSet();
  const pinHorizontalScroll = () => {
    for (const host of doc.querySelectorAll("#tabbrowser-arrowscrollbox, .workspace-arrowscrollbox")) {
      const box = host.scrollbox;
      if (!box || pinned.has(box)) continue;
      pinned.add(box);
      box.addEventListener("scroll", () => { if (box.scrollLeft) box.scrollLeft = 0; }, { passive: true });
      if (box.scrollLeft) box.scrollLeft = 0;
    }
  };
  win.gZenStartup?.promiseInitialized?.then(pinHorizontalScroll, () => {});
  win.addEventListener("ZenWorkspacesUIUpdate", pinHorizontalScroll);
}

// MARK: Selecting several folders and tabs

/* ⌘-click folders (as with tabs) to select several, then right-click → Delete
 * Selected or press Delete. Workspaces and Lima's own folders aren't
 * selectable: a workspace is archived, not deleted. */
function attachMultiSelect(win) {
  const doc = win.document;
  const selectable = folder => folder?.isZenFolder && !["lima-workspace", "lima-tabs", "lima-images", "lima-agents", "lima-agent", "lima-notebook", "lima-section"]
    .some(name => folder.hasAttribute(name)) && !folder.querySelector("zen-folder[lima-workspace]");
  const folders = () => [...doc.querySelectorAll("zen-folder[lima-selected]")].filter(folder => folder.isConnected);
  const tabs = () => win.gBrowser.multiSelectedTabsCount > 1 || folders().length ? win.gBrowser.selectedTabs.filter(tab => !tab.hasAttribute("zen-empty-tab")) : [];
  const clear = () => { for (const folder of folders()) folder.removeAttribute("lima-selected"); };

  doc.addEventListener("click", event => {
    if (event.button !== 0) return;
    const label = event.target.closest?.("#navigator-toolbox zen-folder > .tab-group-label-container");
    const folder = label?.parentElement;
    const toggle = (event.metaKey || event.ctrlKey) && !event.altKey && label && !event.target.closest("input");
    if (toggle && selectable(folder)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      folder.toggleAttribute("lima-selected");
      // The page you're on joins the selection, as when ⌘-clicking tabs.
      if (folders().length && !win.gBrowser.selectedTab.multiselected) win.gBrowser.addToMultiSelectedTabs(win.gBrowser.selectedTab);
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.target.closest?.("#navigator-toolbox")) clear();
  }, true);

  async function deleteSelected() {
    const chosenFolders = folders().filter(selectable);
    // Tabs inside a chosen folder go with it.
    const chosenTabs = tabs().filter(tab => !chosenFolders.some(folder => folder.contains(tab)));
    const inside = chosenFolders.reduce((sum, folder) => sum + folder.allItemsRecursive.filter(item => item.localName === "tab" && !item.hasAttribute("zen-empty-tab")).length, 0);
    const parts = [chosenFolders.length && `${chosenFolders.length} folder${chosenFolders.length === 1 ? "" : "s"}${inside ? ` (with ${inside} tab${inside === 1 ? "" : "s"} inside)` : ""}`,
      chosenTabs.length && `${chosenTabs.length} tab${chosenTabs.length === 1 ? "" : "s"}`].filter(Boolean);
    if (!parts.length) return;
    if (!Services.prompt.confirm(win, "Delete selected", `Delete ${parts.join(" and ")}? Closed tabs can be reopened from History.`)) return;
    clear();
    if (chosenTabs.length) win.gBrowser.removeTabs(chosenTabs);
    for (const folder of chosenFolders) { try { await folder.delete(); } catch (error) { log(`delete folder: ${error}`); } }
  }

  const count = () => folders().length + tabs().length;
  const addItem = (popup, id) => {
    if (!popup || doc.getElementById(id)) return;
    const menuitem = doc.createXULElement("menuitem");
    menuitem.id = id;
    menuitem.className = "lima-menuitem menuitem-iconic";
    menuitem.setAttribute("image", ICON("trash"));
    menuitem.addEventListener("command", () => deleteSelected());
    popup.prepend(menuitem);
    popup.addEventListener("popupshowing", event => {
      if (event.target !== popup) return;
      const n = count();
      menuitem.hidden = n < 2;
      menuitem.setAttribute("label", `Delete ${n} Selected…`);
    });
  };
  addItem(doc.getElementById("zenFolderActions"), "lima-delete-selected-folder");
  addItem(doc.getElementById("tabContextMenu"), "lima-delete-selected-tab");

  win.addEventListener("keydown", event => {
    if (!["Delete", "Backspace"].includes(event.key) || event.metaKey || event.altKey || event.ctrlKey || !folders().length) return;
    const focused = doc.activeElement;
    if (focused?.closest?.("input, textarea, [contenteditable], browser") || focused?.localName === "browser") return;
    event.preventDefault();
    deleteSelected();
  }, true);
}

// MARK: Keys

function attachKeys(win) {
  win.addEventListener("keydown", event => {
    // ⌃⌥D: dictation (4.x default shortcut).
    if (event.ctrlKey && event.altKey && !event.metaKey && event.code === "KeyD") {
      event.preventDefault();
      event.stopPropagation();
      toggleDictation(win);
    }
  }, true);
}

export const LimaSidebar = {
  attach(win) {
    try { installMenus(win); } catch (error) { log(`menus: ${error}\n${error.stack}`); }
    try { attachDock(win); } catch (error) { log(`dock: ${error}\n${error.stack}`); }
    try { attachFolderBehaviour(win); } catch (error) { log(`folders: ${error}\n${error.stack}`); }
    try { attachKeys(win); } catch (error) { log(`keys: ${error}`); }
    try { attachMultiSelect(win); } catch (error) { log(`multiselect: ${error}`); }
    try { lazy.LimaSearchPanel.install(win); } catch (error) { log(`search: ${error}`); }
  },
};
