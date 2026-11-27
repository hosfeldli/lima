/* Memory: tabs you haven't looked at in a while are unloaded. They stay in
 * your sidebar exactly where they were and load again when you click them.
 * Firefox only unloads tabs when macOS is already short of memory; after a
 * day of browsing that left dozens of pages (and their processes) resident.
 *
 * Never unloaded: the tab you're on, tabs playing sound or sharing your
 * camera, microphone or screen, a page that asks before leaving (unsaved
 * input), a tab an agent is working in or a workspace chat while its agent
 * works, Mini Lima's tabs, and tabs marked to stay loaded (the Gmail and
 * Calendar essentials that show your unread counts). Settings → General →
 * Tabs sets the time, or turns it off. */

const PREF = "lima.tabs.unloadAfterMinutes";
const CHECK_MS = 2 * 60_000;
const log = message => Services.console.logStringMessage(`[lima] memory: ${message}`);

export function unloadAfterMs() {
  const minutes = Services.prefs.getIntPref(PREF, 30);
  return minutes > 0 ? minutes * 60_000 : 0;
}

/** Whether `tab` may be unloaded now (it's loaded, idle and nothing needs it). */
export function canUnload(tab, { now = Date.now(), after = unloadAfterMs() } = {}) {
  if (!after || tab.selected || tab.multiselected || tab.closing || tab.hasAttribute("pending") || !tab.linkedPanel) return false;
  if (tab.undiscardable || tab.hasAttribute("undiscardable")) return false;
  if (tab.hasAttribute("soundplaying") || tab.hasAttribute("sharing") || tab.hasAttribute("pictureinpicture")) return false;
  if (tab.hasAttribute("lima-ai") || tab.hasAttribute("zen-glance-tab") || tab.hasAttribute("busy")) return false;
  const lastSeen = tab.lastAccessed || 0;
  if (now - lastSeen < after) return false;
  // A workspace chat while its agent works keeps streaming in place.
  const folder = tab.closest?.("zen-folder[lima-workspace]");
  const url = tab.linkedBrowser?.currentURI?.spec ?? "";
  if (url.startsWith("about:lima?chat=") && folder?.getAttribute("lima-status") === "working") return false;
  return true;
}

export const LimaMemory = {
  install(win) {
    if (win.limaMemory || win.limaMini) return;
    win.limaMemory = true;
    const sweep = () => {
      if (win.closed) return;
      const after = unloadAfterMs();
      if (!after) return;
      const tabs = win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs;
      let unloaded = 0;
      for (const tab of [...tabs]) {
        if (!canUnload(tab, { after })) continue;
        try {
          // Respects pages that ask before leaving (it won't force them).
          if (win.gBrowser.discardBrowser(tab)) unloaded++;
        } catch (error) { log(error); }
      }
      if (unloaded) log(`unloaded ${unloaded} idle tab${unloaded === 1 ? "" : "s"}`);
    };
    const timer = win.setInterval(sweep, CHECK_MS);
    win.addEventListener("unload", () => win.clearInterval(timer), { once: true });
    win.limaMemorySweep = sweep;
  },
};
