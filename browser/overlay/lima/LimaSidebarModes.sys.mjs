/* The sidebar per website: Expanded (full), Compact (icons and status) or
 * Hidden (all page). Sites with their own navigation (ChatGPT, Gmail) can
 * keep a smaller sidebar; Lima switches when you go to one and back when you
 * leave. Chosen from the sidebar's right-click menu; never changed without a
 * rule you set, so the layout doesn't shift on its own. */

const RULES = "lima.sidebar.siteModes"; // { host: "expanded" | "compact" | "hidden" }
const EXPANDED = "zen.view.sidebar-expanded";

function rules() {
  try { return JSON.parse(Services.prefs.getStringPref(RULES, "{}")); } catch { return {}; }
}

export function hostOf(uri) {
  try { return /^https?$/.test(uri.scheme) ? uri.host.replace(/^www\./, "") : ""; } catch { return ""; }
}

function current(win) {
  if (win.gZenCompactModeManager?.preference) return "hidden";
  return Services.prefs.getBoolPref(EXPANDED, true) ? "expanded" : "compact";
}

function apply(win, mode) {
  if (current(win) === mode) return;
  const compact = win.gZenCompactModeManager;
  if (mode === "hidden") { if (compact) compact.preference = true; return; }
  if (compact?.preference) compact.preference = false;
  Services.prefs.setBoolPref(EXPANDED, mode === "expanded");
}

export const LimaSidebarModes = {
  ruleFor(host) { return host ? rules()[host] ?? null : null; },

  set(win, host, mode) {
    const next = rules();
    if (mode) next[host] = mode; else delete next[host];
    Services.prefs.setStringPref(RULES, JSON.stringify(next));
    this.follow(win);
  },

  /** Applies the selected tab's site rule, or your own layout when it has none. */
  follow(win) {
    const rule = this.ruleFor(hostOf(win.gBrowser.currentURI));
    if (rule) {
      // Remember your own layout the first time a rule takes over.
      win.limaSidebarHome ??= current(win);
      apply(win, rule);
    } else if (win.limaSidebarHome) {
      apply(win, win.limaSidebarHome);
      win.limaSidebarHome = null;
    }
  },

  install(win) {
    if (win.limaSidebarModes) return;
    win.limaSidebarModes = true;
    const follow = () => win.setTimeout(() => this.follow(win), 0);
    win.gBrowser.tabContainer.addEventListener("TabSelect", follow);
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, progress) => { if (progress.isTopLevel && browser === win.gBrowser.selectedBrowser) follow(); },
    });
  },
};
