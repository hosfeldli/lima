import { tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";

const INTRO = "about:lima?view=welcome";
const CREATED = "lima.welcome.created";
const FINISHED = "lima.welcome.finished";

function isZenOnboarding(url) {
  try {
    const address = new URL(url);
    return address.protocol === "https:" && ["zen-browser.app", "www.zen-browser.app"].includes(address.host)
      && ["/welcome", "/privacy-policy"].includes(address.pathname.replace(/\/$/, ""));
  } catch { return false; }
}

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

function acknowledge(win, browser) {
  const destination = win.document.getElementById("lima-assistant-toggle");
  if (!destination || win.gBrowser.selectedBrowser !== browser ||
      win.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      Services.prefs.getStringPref("lima.personality", "full") !== "full") return;
  destination.animate([{ transform: "scale(.94)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }],
    { duration: 250, easing: "ease-out" });
}

export const LimaWelcome = {
  async finish(win, browser) {
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
    if (firstLaunch && walkthrough) win.gBrowser.selectedTab = walkthrough;
    await retireBasics(win, walkthrough);
  },
};
