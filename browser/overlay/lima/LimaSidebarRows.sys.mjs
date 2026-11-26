/* Presentation and keyboard actions for Zen's native tab and folder rows. */
import { LimaWorkspaces, tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";
import { showSidebarNotice, failed } from "resource://lima/LimaSidebar.sys.mjs";

const STATE_KEY = "lima-folder-disclosure";
const TAB_TYPE = "application/x-moz-tabbrowser-tab";
const rowSelector = ".tab-group-label-container, .tabbrowser-tab";
const labelOf = folder => folder?.querySelector(":scope > .tab-group-label-container");
const folderKey = folder => folder.getAttribute("lima-workspace") ??
  (folder.id ? `folder:${folder.id}` : null);

export function installSidebarRows(win, { privateWindow = false } = {}) {
  const root = win.gBrowser.tabContainer;
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  const restored = new WeakSet();
  let ready = false;
  let saved = {};
  let frame = 0;
  const refresh = () => {
    frame = 0;
    for (const folder of root.querySelectorAll("zen-folder")) {
      const row = labelOf(folder);
      if (!row) continue;
      if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "0");
      const workspace = folder.hasAttribute("lima-workspace");
      row.setAttribute("aria-keyshortcuts", workspace ? "F2 Enter Delete Shift+F10" : "F2 Enter Shift+F10");
      const key = folderKey(folder);
      if (ready && key && !restored.has(folder)) {
        restored.add(folder);
        if (Object.hasOwn(saved, key) && folder.collapsed !== saved[key]) folder.collapsed = saved[key];
      }
    }
  };
  const schedule = () => { if (!frame) frame = win.requestAnimationFrame(refresh); };
  const observer = new win.MutationObserver(records => {
    if (records.some(record => record.type === "attributes" || [...record.addedNodes].some(node =>
      node.nodeType === 1 && (node.isZenFolder || node.matches?.(".tab-group-label-container") || node.querySelector?.("zen-folder"))))) schedule();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["lima-workspace"] });
  SessionStore.promiseInitialized.then(() => {
    if (win.closed || privateWindow) return;
    try { saved = JSON.parse(SessionStore.getCustomWindowValue(win, STATE_KEY) || "{}"); } catch {}
    ready = true;
    schedule();
  });
  for (const type of ["TabGroupCollapse", "TabGroupExpand"]) {
    root.addEventListener(type, ({ target }) => {
      const key = target.isZenFolder && folderKey(target);
      if (!ready || !key || !restored.has(target)) return;
      saved[key] = target.collapsed;
      SessionStore.setCustomWindowValue(win, STATE_KEY, JSON.stringify(saved));
    });
  }

  const workspaces = () => LimaWorkspaces.roots(win);
  const moveTab = async (tab, id) => {
    const workspace = await LimaWorkspaces.addTab(win, id, tab);
    showSidebarNotice(win, { title: `Added to ${workspace.name}`, detail: tab.label,
      actions: [["Open Agent", () => LimaWorkspaces.openChat(win, id)]] });
  };
  let preview;
  const clearDrop = () => {
    if (!preview) return;
    preview.removeAttribute("lima-drop-target");
    preview = null;
  };
  const targetFor = event => {
    const row = event.target.closest?.(".tab-group-label-container");
    const folder = row?.parentElement;
    const id = folder?.getAttribute("lima-workspace");
    if (!id || folder.hasAttribute("lima-agent")) return null;
    let tab;
    try { tab = event.dataTransfer?.mozGetDataAt(TAB_TYPE, 0); } catch {}
    if (tab?.localName !== "tab" || tab.ownerGlobal !== win || tab.closing || !/^https?:/.test(tabURL(tab)) ||
        LimaWorkspaces.workspaceForTab(tab) === id) return null;
    return { row, folder, tab, id };
  };
  if (!privateWindow) {
    root.addEventListener("dragover", event => {
      const target = targetFor(event);
      if (!target) { clearDrop(); return; }
      if (preview !== target.row) {
        clearDrop();
        preview = target.row;
        preview.setAttribute("lima-drop-target", `Move to ${target.folder.label}`);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      event.dataTransfer.dropEffect = "move";
    }, true);
    root.addEventListener("drop", event => {
      const target = targetFor(event);
      clearDrop();
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      moveTab(target.tab, target.id).catch(error => failed(win, "Move tab", error));
    }, true);
    root.addEventListener("dragleave", event => { if (!preview?.contains(event.relatedTarget)) clearDrop(); });
    root.addEventListener("dragend", clearDrop);
  }

  root.addEventListener("keydown", event => {
    const row = event.target.closest?.(rowSelector);
    if (!row || event.target.matches?.("input, button, textarea")) return;
    const folder = row.matches(".tab-group-label-container") ? row.parentElement : null;
    const id = folder?.getAttribute("lima-workspace");
    const tab = folder ? null : row;
    let action;
    if (folder && event.key === "F2") action = () => folder.rename();
    else if (id && event.key === "Delete" && !event.metaKey) action = () => LimaWorkspaces.archive(win, id);
    else if (folder && ["Enter", " "].includes(event.key)) action = () => {
      if (event.key === "Enter" && id && !event.altKey) LimaWorkspaces.openChat(win, id);
      else folder.collapsed = !folder.collapsed;
    };
    else if (event.key === "F10" && event.shiftKey) action = () => {
      const menu = folder ? [...win.document.querySelectorAll("menupopup")].find(node => node.querySelector("#lima-folder-rename"))
        : win.document.getElementById("tabContextMenu");
      menu?.openPopup(row, "after_start", 0, 0, true, false, event);
    };
    else if (tab && event.code === "KeyM" && event.ctrlKey && event.altKey && !privateWindow && /^https?:/.test(tabURL(tab))) {
      action = () => {
        const targets = workspaces().filter(workspace => LimaWorkspaces.workspaceForTab(tab) !== workspace.id);
        if (!targets.length) return;
        const choices = targets.map(workspace => workspace.name);
        const selection = {};
        if (Services.prompt.select(win, "Move tab", "Choose a workspace", choices, selection)) return moveTab(tab, targets[selection.value].id);
      };
    }
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve().then(action).catch(error => failed(win, "Sidebar action", error));
  }, true);

  win.addEventListener("unload", () => {
    observer.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    clearDrop();
  }, { once: true });
  schedule();
}
