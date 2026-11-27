/* Opens Lima surfaces as ordinary Zen tabs, focusing an existing tab for the
 * same surface instead of duplicating it. */

export const LimaTabs = {
  openOrFocus(win, url, { background = false } = {}) {
    const gBrowser = win.gBrowser;
    const existing = [...gBrowser.tabs].find(tab => tab.linkedBrowser?.currentURI?.spec === url);
    if (existing) {
      if (!background) gBrowser.selectedTab = existing;
      return existing;
    }
    // Lima's own pages (Settings, Scheduled Tasks, What's New, Downloads)
    // share one tab, so they don't pile up at the foot of your sidebar.
    if (isUtilityURL(url)) {
      const utility = [...gBrowser.tabs].find(tab => !tab.closing && isUtilityURL(tab.linkedBrowser?.currentURI?.spec ?? ""));
      if (utility) {
        utility.linkedBrowser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        if (!background) gBrowser.selectedTab = utility;
        return utility;
      }
    }
    const tab = gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      inBackground: background,
    });
    if (!background) gBrowser.selectedTab = tab;
    return tab;
  },
};

/** Lima's own settings-type pages, which share a single tab. */
export function isUtilityURL(url) {
  return /^about:lima\?view=(integrations|schedules|whats-new|help|legal|values)(&|$)/.test(url) || url === "about:downloads";
}
