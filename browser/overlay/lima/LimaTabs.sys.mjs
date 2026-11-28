/* Opens Lima surfaces as ordinary Zen tabs, focusing an existing tab for the
 * same surface instead of duplicating it. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

/** A tab's address, including a tab Lima unloaded for memory (whose
 * browser reads about:blank until it's restored). */
export function tabURL(tab) {
  const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
  if (tab.linkedPanel && !tab.hasAttribute("pending") && spec !== "about:blank") return spec;
  try {
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    return state.entries?.[(state.index ?? state.entries.length) - 1]?.url ?? spec;
  } catch { return spec; }
}

/** Whether `win` is a Mini Lima window rather than a full Lima window. */
export function isMiniWindow(win) {
  return Boolean(win?.limaMini || win?.document?.documentElement?.hasAttribute("lima-mini"));
}

/** The frontmost full (non-Mini, non-private) Lima window, if any. */
export function mainWindow() {
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false })
    .find(win => !win.closed && !isMiniWindow(win)) ?? null;
}

export const LimaTabs = {
  openOrFocus(win, url, { background = false, triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal() } = {}) {
    // Lima's own pages belong in a full window, never in Mini Lima.
    if (isMiniWindow(win)) {
      win = mainWindow() ?? win;
      if (!background) win.focus();
    }
    const gBrowser = win.gBrowser;
    const existing = [...gBrowser.tabs].find(tab => !tab.closing && tabURL(tab) === url);
    if (existing) {
      if (!background) gBrowser.selectedTab = existing;
      return existing;
    }
    // Lima's own pages (Settings, Scheduled Tasks, What's New, Downloads)
    // share one tab, so they don't pile up at the foot of your sidebar.
    if (isUtilityURL(url)) {
      const utility = [...gBrowser.tabs].find(tab => !tab.closing && isUtilityURL(tabURL(tab)));
      // A tab Lima unloaded for memory can't take a new page; replace it.
      if (utility && (!utility.linkedPanel || utility.hasAttribute("pending"))) {
        const tab = gBrowser.addTab(url, {
          triggeringPrincipal,
          inBackground: background,
          index: utility._tPos,
        });
        if (!background) gBrowser.selectedTab = tab;
        gBrowser.removeTab(utility, { animate: false });
        return tab;
      }
      if (utility) {
        utility.linkedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal });
        if (!background) gBrowser.selectedTab = utility;
        return utility;
      }
    }
    const tab = gBrowser.addTab(url, { triggeringPrincipal, inBackground: background });
    if (!background) gBrowser.selectedTab = tab;
    return tab;
  },
};

/** Lima's own settings-type pages, which share a single tab. */
export function isUtilityURL(url) {
  return /^about:lima\?view=(integrations|schedules|whats-new|help|legal|values)(&|$)/.test(url) || url === "about:downloads";
}
