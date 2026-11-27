import { SETTLE } from "resource://lima/LimaMotion.sys.mjs";
/* Per-window integration: Lima's sidebar pieces (LimaSidebar) and the
 * Context Shelf recorder for non-private navigation metadata. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaAssistant: "resource://lima/LimaAssistant.sys.mjs",
  LimaAppearance: "resource://lima/LimaAppearance.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaSidebar: "resource://lima/LimaSidebar.sys.mjs",
  LimaMini: "resource://lima/LimaMini.sys.mjs",
  installCopyLink: "resource://lima/LimaCopyLink.sys.mjs",
  LimaEmoji: "resource://lima/LimaEmoji.sys.mjs",
  LimaSidebarModes: "resource://lima/LimaSidebarModes.sys.mjs",
  LimaMemory: "resource://lima/LimaMemory.sys.mjs",
  installSidebarRows: "resource://lima/LimaSidebarRows.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

function attachContextRecorder(win) {
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return; // never record private browsing
  const recent = new Map();
  const recentLimit = 512;
  win.gBrowser.addTabsProgressListener({
    onStateChange(browser, webProgress, request, flags) {
      const STOP = Ci.nsIWebProgressListener.STATE_STOP | Ci.nsIWebProgressListener.STATE_IS_WINDOW;
      if (!webProgress.isTopLevel || (flags & STOP) !== STOP) return;
      const uri = browser.currentURI;
      if (!uri || !["http", "https"].includes(uri.scheme)) return;
      const key = uri.spec;
      const now = win.performance.now();
      for (const [url, recordedAt] of recent) {
        if (recordedAt > now - 60_000) break;
        recent.delete(url);
      }
      if (recent.has(key)) return; // dedupe reloads/refreshes
      if (recent.size >= recentLimit) recent.delete(recent.keys().next().value);
      recent.set(key, now);
      const title = browser.contentTitle || uri.host;
      lazy.LimaBridge.request("context.record", { title, url: uri.spec }).catch(() => {});
    },
  });
}

export const LimaWindow = {
  /** A Mini Lima window: Lima's look and the slim bar, no sidebar. */
  attachMini(win) {
    if (win.limaAttached) return;
    win.limaAttached = true;
    const root = win.document.documentElement;
    root.setAttribute("lima-window", "true");
    root.setAttribute("lima-theme", lazy.LimaAppearance.theme());
    const unwatch = lazy.LimaAppearance.subscribe(theme => root.setAttribute("lima-theme", theme));
    win.addEventListener("unload", unwatch, { once: true });
    lazy.LimaMini.setup(win);
    try { lazy.installCopyLink(win); lazy.LimaEmoji.install(win); } catch (error) { Services.console.logStringMessage(`[lima] mini extras: ${error}`); }
  },

  attach(win) {
    if (win.limaMini) return this.attachMini(win);
    if (win.limaAttached) return;
    win.limaAttached = true;
    lazy.LimaMini.installInMainWindow(win);
    win.document.documentElement.setAttribute("lima-window", "true");
    win.document.documentElement.style.setProperty("--lima-motion-settle", SETTLE);
    lazy.LimaSidebar.attach(win);
    try { lazy.installCopyLink(win); } catch (error) { Services.console.logStringMessage(`[lima] copy link: ${error}`); }
    try { lazy.LimaEmoji.install(win); } catch (error) { Services.console.logStringMessage(`[lima] emoji: ${error}`); }
    try { lazy.LimaSidebarModes.install(win); } catch (error) { Services.console.logStringMessage(`[lima] sidebar modes: ${error}`); }
    try { lazy.LimaMemory.install(win); } catch (error) { Services.console.logStringMessage(`[lima] memory: ${error}`); }
    lazy.installSidebarRows(win, { privateWindow: lazy.PrivateBrowsingUtils.isWindowPrivate(win) });
    lazy.LimaAssistant.attach(win);
    lazy.LimaWorkspaces.keepChatFoldersCollapsed(win);
    lazy.LimaWorkspaces.watchLayout(win);
    lazy.LimaWorkspaces.watchAgentIcons(win);
    // Tab size (Settings → General → Tabs): row height, with the label scaled to match.
    const applyTabSize = () => {
      const height = Math.max(22, Math.min(40, Services.prefs.getIntPref("lima.tabs.height", 26)));
      win.document.documentElement.style.setProperty("--lima-tab-height", `${height}px`);
      win.document.documentElement.style.setProperty("--lima-tab-font", `${(11.5 + (height - 26) * 0.2).toFixed(2)}px`);
    };
    // A collapsed Zen folder hides its rows behind a margin measured when it
    // collapsed. Lima adds, hides and resizes rows inside collapsed folders
    // afterwards, which left that margin short (a blank gap under the folder)
    // or long. Re-measure them, once things settle, whenever rows change.
    let relayoutTimer = 0;
    const relayoutFolders = () => {
      win.clearTimeout(relayoutTimer);
      relayoutTimer = win.setTimeout(() => {
        try { win.gZenFolders?.relayoutCollapsedFolders?.(); } catch (error) { console.error("Lima folder relayout", error); }
      }, 160);
    };
    win.limaRelayoutFolders = relayoutFolders;
    for (const type of ["TabOpen", "TabClose", "TabGrouped", "TabUngrouped", "TabSelect", "TabShow", "TabHide",
      "TabGroupExpand", "TabGroupCollapse", "TabGroupCreate", "TabGroupRemoved"]) {
      win.gBrowser.tabContainer.addEventListener(type, relayoutFolders);
    }
    const resizeRows = () => { applyTabSize(); relayoutFolders(); };
    applyTabSize();
    Services.prefs.addObserver("lima.tabs.height", resizeRows);
    win.addEventListener("unload", () => Services.prefs.removeObserver("lima.tabs.height", resizeRows), { once: true });
    const applyPersonality = () => win.document.documentElement.dataset.limaPersonality =
      Services.prefs.getStringPref("lima.personality", "full");
    applyPersonality();
    Services.prefs.addObserver("lima.personality", applyPersonality);
    // Light or dark, following macOS unless Settings pins one. Private
    // windows keep Zen's own look (see lima.css).
    const root = win.document.documentElement;
    const applyTheme = theme => {
      root.setAttribute("lima-theme", theme);
      Services.obs.notifyObservers(null, "lima-theme-changed");
    };
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
