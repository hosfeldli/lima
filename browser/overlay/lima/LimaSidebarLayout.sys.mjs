/* Zen stores its tabs in internal containers. Present one sidebar in Lima. */
const installed = new WeakSet();

export function disableSpaceRouting() {
  const { gZenSpaceRoutingManager } = ChromeUtils.importESModule(
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs");
  // Keep saved rules on disk. Old space targets should never move a new tab
  // out of Lima's sidebar, even during startup or external navigation.
  gZenSpaceRoutingManager.routeUri = (_url, options) =>
    options?.fromExternal && gZenSpaceRoutingManager.getDefaultExternalRoute() === "little-window"
      ? "little-window" : "most-recent-space";
}

export async function flattenSidebar(win) {
  const manager = win.gZenWorkspaces;
  if (!manager) return;
  await win.gZenStartup?.promiseInitialized;
  if (win.closed) return;

  const stored = Services.prefs.getStringPref("lima.sidebar.container", "");
  const id = manager.workspaceElement(stored) ? stored : manager.activeWorkspace;
  if (id !== manager.activeWorkspace) await manager.changeWorkspaceWithID(id);
  if (!id || win.closed) return;
  Services.prefs.setStringPref("lima.sidebar.container", id);
  if (!installed.has(win)) {
    installed.add(win);
    win.document.addEventListener("command", event => {
      const command = event.target.getAttribute?.("command") || event.target.id;
      if (/^cmd_zen(?:Workspace(?:Forward|Backward|Switch\d+)|OpenWorkspaceCreation|ManageWorkspaces|ChangeWorkspaceTab|OpenSpaceRoutingSettings)$/.test(command)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  const pinned = manager.workspaceElement(id)?.pinnedTabsContainer;
  if (!pinned) return;
  const tabs = [...manager.allStoredTabs].filter(tab =>
    !tab.closing && !tab.hasAttribute("zen-essential") && !tab.hasAttribute("zen-empty-tab") &&
    tab.getAttribute("zen-workspace-id") && tab.getAttribute("zen-workspace-id") !== id);
  const folders = new Set();
  const ungrouped = [];
  for (const tab of tabs) {
    let group = tab.group;
    while (group?.group?.isZenFolder) group = group.group;
    if (group?.isZenFolder) folders.add(group);
    else ungrouped.push(tab);
  }
  for (const folder of folders) {
    pinned.insertBefore(folder, pinned.lastChild);
    win.gZenFolders.changeFolderToSpace(folder, id, { hasDndSwitch: true });
  }
  if (ungrouped.length) manager.moveTabsToWorkspace(ungrouped, id);
}
