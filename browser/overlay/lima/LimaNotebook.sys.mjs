/* Retire the generated Notebook folder. Notes are stored separately and
 * remain available from search and the Notes index. */
import { tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";

export const LimaNotebook = {
  async retire(win) {
    let id;
    try { id = JSON.parse(Services.prefs.getStringPref("lima.notebook.sidebar", "{}")).folder; } catch {}
    const root = win.document.querySelector("zen-folder[lima-notebook]") ?? (id && win.document.getElementById(id));
    if (!root?.isZenFolder) return;
    root.setAttribute("lima-notebook", "true");
    const tabs = () => root.allItemsRecursive.filter(item => item.localName === "tab" && !item.hasAttribute("zen-empty-tab"));
    for (const tab of tabs()) {
      if (!tab.selected && tab.hasAttribute("pending") && tabURL(tab)?.startsWith("about:lima?note=")) {
        win.gBrowser.removeTab(tab, { animate: false });
      } else {
        let group = tab.group;
        while (group?.isZenFolder && root.contains(tab)) {
          win.gBrowser.ungroupTab(tab);
          if (tab.group === group) break;
          group = tab.group;
        }
      }
    }
    if (!tabs().length) {
      await root.delete();
      Services.prefs.clearUserPref("lima.notebook.sidebar");
    }
  },
};
