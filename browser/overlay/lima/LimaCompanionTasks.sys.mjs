import { tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";
import { preserveFolderDisclosure } from "resource://lima/LimaFolderDisclosure.sys.mjs";

const MAX_TABS = 30;
const MAX_GROUPS = 12;

function folders(win) {
  const root = win.gZenWorkspaces?.pinnedTabsContainer;
  return [...(root?.querySelectorAll("zen-folder") ?? [])].filter(folder =>
    folder.isZenFolder && !folder.closest("[lima-workspace]") && !folder.closest("#tabbrowser-arrowscrollbox-periphery"));
}

function folderTabs(folder) {
  return [...folder.tabs].filter(tab => tab.group === folder && !tab.hasAttribute("zen-empty-tab") && !tab.closing);
}

function folderTree(folder, depth = 0) {
  return {
    title: folder.label,
    tabs: folderTabs(folder).map(tab => ({ title: tab.label, url: tabURL(tab) })),
    groups: depth < 2 ? [...folder.querySelectorAll("zen-folder")].filter(child => child.group === folder)
      .map(child => folderTree(child, depth + 1)) : [],
  };
}

export function companionFolders(win) {
  return folders(win).slice(0, 80).map(folder => ({
    id: folder.id, title: String(folder.label ?? "").slice(0, 100),
    parent: String(folder.group?.label ?? "").slice(0, 100),
    tabCount: folderTabs(folder).length,
  }));
}

function tabEntry(entry) {
  try {
    if (typeof entry?.url !== "string" || entry.url.length > 2048) return null;
    const url = new URL(entry.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    return { url: url.href, title: String(entry.title || url.hostname).slice(0, 140) };
  } catch { return null; }
}

function createTabGroup(win, action, title) {
  const template = action.templateId && folders(win).find(folder => folder.id === action.templateId);
  if (action.templateId && !template) throw new Error("The template folder moved or was closed. Choose a folder and try again.");
  const tree = template ? folderTree(template) : { tabs: [], groups: [] };
  tree.title = title;
  tree.tabs.push(...(Array.isArray(action.tabs) ? action.tabs.slice(0, MAX_TABS) : []));
  tree.groups.push(...(Array.isArray(action.groups) ? action.groups.slice(0, MAX_GROUPS) : []));

  const tabs = [], created = [];
  const browser = win.gBrowser;
  const principal = Services.scriptSecurityManager.createNullPrincipal({});
  function build(group, parent = null, depth = 0) {
    if (created.length >= MAX_GROUPS || depth > 2) return null;
    const entries = (Array.isArray(group.tabs) ? group.tabs : []).map(tabEntry).filter(Boolean);
    const children = [];
    for (const entry of entries.slice(0, MAX_TABS - tabs.length)) {
      const tab = browser.addTab(entry.url, { triggeringPrincipal: principal, inBackground: true,
        createLazyBrowser: true, lazyTabTitle: entry.title, skipAnimation: true });
      tabs.push(tab);
      children.push(tab);
    }
    const folder = preserveFolderDisclosure(parent, () => win.gZenFolders.createFolder(children, {
      label: String(group.title || "Tabs").slice(0, 100), collapsed: true,
      insertAfter: parent?.groupContainer.lastElementChild,
    }));
    if (!folder?.isConnected) throw new Error("Lima could not create the tab folder.");
    created.push(folder);
    for (const child of Array.isArray(group.groups) ? group.groups.slice(0, MAX_GROUPS) : []) {
      if (child && typeof child === "object") build(child, folder, depth + 1);
    }
    return folder;
  }
  try {
    const folder = build(tree);
    return { kind: "tabs", title: folder.label, id: folder.id, count: tabs.length };
  } catch (error) {
    for (const folder of created.reverse()) if (folder.isConnected) void folder.delete();
    for (const tab of tabs) if (tab.isConnected && !tab.closing) browser.removeTab(tab, { animate: false });
    throw error;
  }
}

export async function runCompanionTask(win, action) {
  const title = typeof action?.title === "string" ? action.title.trim().slice(0, 100) : "";
  if (!title) throw new Error("Give the new item a title and try again.");
  if (action.kind === "tabs") return createTabGroup(win, action, title);
  if (action.kind !== "note" || typeof action.markdown !== "string" || action.markdown.length > 80_000) {
    throw new Error("The Companion returned an invalid note or folder.");
  }
  const { LimaNotesBookmarks } = ChromeUtils.importESModule("resource://lima/LimaNotesBookmarks.sys.mjs");
  const note = await LimaNotesBookmarks.createNote({ title, markdown: action.markdown });
  return { kind: "note", title: note.title, id: note.id };
}

export function revealCompanionGroup(win, id) {
  const folder = folders(win).find(item => item.id === id);
  if (!folder) throw new Error("This folder is no longer in the sidebar.");
  folder.collapsed = false;
  folder.scrollIntoView({ block: "nearest" });
}
