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
    const tab = gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      inBackground: background,
    });
    if (!background) gBrowser.selectedTab = tab;
    return tab;
  },
};
