/* Per-window integration: Lima's sidebar pieces (LimaSidebar) and the
 * Context Shelf recorder for non-private navigation metadata. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaAssistant: "resource://lima/LimaAssistant.sys.mjs",
  LimaAppearance: "resource://lima/LimaAppearance.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaSidebar: "resource://lima/LimaSidebar.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

function attachContextRecorder(win) {
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return; // never record private browsing
  const recent = new Map();
  win.gBrowser.addTabsProgressListener({
    onStateChange(browser, webProgress, request, flags) {
      const STOP = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
      if (!webProgress.isTopLevel || (flags & STOP) !== STOP) return;
      const uri = browser.currentURI;
      if (!uri || !["http", "https"].includes(uri.scheme)) return;
      const key = uri.spec;
      const now = Date.now();
      if (recent.get(key) > now - 60_000) return; // dedupe reloads/refreshes
      recent.set(key, now);
      const title = browser.contentTitle || uri.host;
      lazy.LimaBridge.request("context.record", { title, url: uri.spec }).catch(() => {});
    },
  });
}

export const LimaWindow = {
  attach(win) {
    if (win.limaAttached) return;
    win.limaAttached = true;
    win.document.documentElement.setAttribute("lima-window", "true");
    lazy.LimaSidebar.attach(win);
    lazy.LimaAssistant.attach(win);
    lazy.LimaWorkspaces.keepChatFoldersCollapsed(win);
    const applyPersonality = () => win.document.documentElement.dataset.limaPersonality =
      Services.prefs.getStringPref("lima.personality", "full");
    applyPersonality();
    Services.prefs.addObserver("lima.personality", applyPersonality);
    // Light or dark, following macOS unless Settings pins one. Private
    // windows keep Zen's own look (see lima.css).
    const root = win.document.documentElement;
    const applyTheme = theme => root.setAttribute("lima-theme", theme);
    applyTheme(lazy.LimaAppearance.theme());
    const unwatchTheme = lazy.LimaAppearance.subscribe(applyTheme);
    win.addEventListener("unload", () => {
      Services.prefs.removeObserver("lima.personality", applyPersonality);
      unwatchTheme();
    }, { once: true });
    win.gBrowser.tabContainer.addEventListener("TabGroupRemoved", event => lazy.LimaWorkspaces.onFolderRemoved(event));
    win.gBrowser.tabContainer.addEventListener("TabClose", event => lazy.LimaWorkspaces.onTabClose(event.target));
    attachContextRecorder(win);
    // Development/testing aid: open a Lima URL once the window has settled
    // (Zen's first-run flow replaces command-line tabs on new profiles).
    const devURL = Services.env.get("LIMA_DEV_OPEN_URL");
    if (devURL.startsWith("about:lima")) win.setTimeout(() => lazy.LimaTabs.openOrFocus(win, devURL), 4000);
    dump("[lima] window integrated\n");
  },
};
