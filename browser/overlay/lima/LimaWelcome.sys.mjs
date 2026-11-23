import { tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";
import { isBlockedURL } from "resource://lima/LimaBlockedSites.sys.mjs";

const INTRO = "about:lima?view=welcome";
const CREATED = "lima.welcome.created";
const FINISHED = "lima.welcome.finished";
// Set while the walkthrough keeps the sidebar tucked away to the left.
const TUCKED = "lima.welcome.sidebarTucked";
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MigrationUtils: "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
  ShellService: "moz-src:///browser/components/shell/ShellService.sys.mjs",
});

// Any zen-browser.app page (LimaBlockedSites cancels their loads; restored
// or leftover tabs are cleared here).
const isZenOnboarding = isBlockedURL;

function introTab(win) {
  return win.gBrowser.addTab(INTRO, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
}

function basicsFolders(win) {
  const tabs = [...(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs)];
  return [...new Set([...win.document.querySelectorAll("zen-folder"), ...tabs.map(tab => tab.group)])].filter(folder =>
    folder?.isZenFolder && !folder.hasAttribute("lima-workspace") &&
    (folder.label?.toLowerCase() === "zen basics" ||
      (["lima basics", "welcome to lima"].includes(folder.label?.toLowerCase()) && folder.tabs.some(tab => tabURL(tab) === INTRO))));
}

async function retireBasics(win, keep = null) {
  for (const folder of basicsFolders(win)) {
    for (const tab of [...folder.tabs].filter(tab => tab.group === folder && tab !== keep &&
      (tabURL(tab) === INTRO || isZenOnboarding(tabURL(tab))))) {
      if (tab.selected && keep) win.gBrowser.selectedTab = keep;
      win.gBrowser.removeTab(tab, { animate: false });
    }
    if (!folder.isConnected) continue;
    await folder.unpackTabs();
    if (folder.isConnected && folder.allItems.every(item => item.hasAttribute("zen-empty-tab"))) await folder.delete();
    if (folder.isConnected && !folder.allItems.length) {
      folder.remove();
      win.gBrowser.tabContainer._invalidateCachedTabs();
    }
  }
}

/** First launch: the sidebar waits off to the left (Zen's compact mode) so
 * the walkthrough has the whole window. */
function tuckSidebar(win) {
  const manager = win.gZenCompactModeManager;
  if (!manager || manager.preference) return;
  Services.prefs.setBoolPref("zen.tabs.vertical.right-side", false);
  Services.prefs.setBoolPref(TUCKED, true);
  try { manager.preference = true; } catch (error) { Services.prefs.clearUserPref(TUCKED); console.error(error); }
}

/** After the walkthrough, the sidebar slides back in from the left. */
function revealSidebar(win) {
  if (!Services.prefs.getBoolPref(TUCKED, false)) return;
  Services.prefs.clearUserPref(TUCKED);
  const manager = win.gZenCompactModeManager;
  try { if (manager?.preference) manager.preference = false; } catch (error) { console.error(error); }
}

function acknowledge(win, browser) {
  const destination = win.document.getElementById("lima-assistant-toggle");
  if (!destination || win.gBrowser.selectedBrowser !== browser ||
      win.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      Services.prefs.getStringPref("lima.personality", "full") !== "full") return;
  destination.animate([{ transform: "scale(.94)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
    { duration: 250, easing: "ease-out" });
}

export const LimaWelcome = {
  /** Opens Firefox's import wizard over the walkthrough and resolves when
   * it closes: `imported` is true if any import finished meanwhile. */
  async importBrowserData(win, browser) {
    let imported = false;
    const ended = () => { imported = true; };
    Services.obs.addObserver(ended, "Migration:Ended");
    try {
      const box = win.gBrowser.getTabDialogBox?.(browser);
      if (!box) {
        await lazy.MigrationUtils.showMigrationWizard(win, { entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN, tabModal: true });
        return { imported: false, waited: false };
      }
      const { closedPromise } = box.open("chrome://browser/content/migration/migration-dialog-window.html",
        { features: "resizable=no", modalType: Ci.nsIPrompt.MODAL_TYPE_CONTENT },
        { options: { entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN, tabModal: true } });
      await closedPromise;
      return { imported, waited: true };
    } finally {
      Services.obs.removeObserver(ended, "Migration:Ended");
    }
  },

  isDefaultBrowser() {
    return lazy.ShellService.isDefaultBrowser(false, false);
  },

  async makeDefaultBrowser() {
    await lazy.ShellService.setDefaultBrowser(false);
    return this.isDefaultBrowser();
  },

  async finish(win, browser) {
    revealSidebar(win);
    acknowledge(win, browser);
    Services.prefs.setBoolPref(FINISHED, true);
    const { LimaTabs } = ChromeUtils.importESModule("resource://lima/LimaTabs.sys.mjs");
    LimaTabs.openOrFocus(win, "about:lima");
    const source = win.gBrowser.getTabForBrowser(browser);
    await retireBasics(win, source);
    if (source && !source.closing) win.gBrowser.removeTab(source, { animate: false });
  },

  async install(win) {
    await win.gZenStartup?.promiseInitialized;
    const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
    await SessionStore.promiseInitialized;
    if (win.closed || !win.gZenFolders) return;
    const finished = Services.prefs.getBoolPref(FINISHED, false);
    const existing = [...win.gBrowser.tabs].find(tab => tabURL(tab) === INTRO && !tab.closing);
    const firstLaunch = !finished && !Services.prefs.getBoolPref(CREATED, false) && !existing &&
      ![...win.gBrowser.tabs].some(tab => !tab.hasAttribute("zen-empty-tab") &&
        !["", "about:blank", "about:newtab", "about:home", "about:lima"].includes(tabURL(tab)) &&
        !isZenOnboarding(tabURL(tab)));
    Services.prefs.setBoolPref(CREATED, true);
    const walkthrough = finished ? null : existing ?? (firstLaunch ? introTab(win) : null);
    if (firstLaunch && walkthrough) {
      win.gBrowser.selectedTab = walkthrough;
      tuckSidebar(win);
    }
    // Finished elsewhere, or the walkthrough tab is gone: never leave the
    // sidebar hidden. Closing the walkthrough tab also brings it back.
    if (finished || !walkthrough) revealSidebar(win);
    walkthrough?.addEventListener("TabClose", () => revealSidebar(win), { once: true });
    await retireBasics(win, walkthrough);
  },
};
