/* Anonymous usage statistics, browser side (the runtime keeps the counts and
 * sends them; see native UsageStats). Off until the user says yes. Lima asks
 * once, after the walkthrough, and never again after an answer; a dismissed
 * question comes back at most every two weeks. Private windows never count. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaAppearance: "resource://lima/LimaAppearance.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const ASK_AGAIN = 14 * 24 * 3600 * 1000;
const PREFS = ["lima.theme", "lima.agent.provider", "lima.tabs.height", "lima.search.hideAI", "lima.search.hideAds",
  "lima.youtube.hideShorts", "lima.search.replaceAddressBar"];
let started = false;

/** The settings that go with a report: only these, as coarse values. */
export function settingsSnapshot() {
  const height = Services.prefs.getIntPref("lima.tabs.height", 26);
  return {
    theme: Services.prefs.getStringPref("lima.theme", "system"),
    provider: Services.prefs.getStringPref("lima.agent.provider", "none"),
    tabSize: height < 25 ? "compact" : height > 30 ? "large" : "default",
    hideAI: Services.prefs.getBoolPref("lima.search.hideAI", true),
    hideAds: Services.prefs.getBoolPref("lima.search.hideAds", true),
    hideShorts: Services.prefs.getBoolPref("lima.youtube.hideShorts", true),
    addressBar: Services.prefs.getBoolPref("lima.search.replaceAddressBar", true),
  };
}

export const LimaUsage = {
  start() {
    if (started) return;
    started = true;
    const report = () => lazy.LimaBridge.request("usage.settings", settingsSnapshot()).catch(() => {});
    for (const pref of PREFS) Services.prefs.addObserver(pref, report);
    lazy.LimaBridge.onEvent(({ event }) => { if (event === "host.connected") { report(); this.count("app.active"); } });
    report();
    this.count("app.active");
  },

  /** One feature use. The runtime ignores it unless sharing is on. */
  count(event, win = null) {
    if (win && lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    lazy.LimaBridge.request("usage.count", { event }).catch(() => {});
  },

  /** The one-time question, in the sidebar dock. */
  async maybeAsk(win, show) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    const askedAt = Number(Services.prefs.getStringPref("lima.analytics.askedAt", "0")) || 0;
    if (Date.now() - askedAt < ASK_AGAIN) return;
    // Not during the walkthrough.
    if ([...win.gBrowser.tabs].some(tab => tab.linkedBrowser?.currentURI?.spec === "about:lima?view=welcome")) return;
    const state = await lazy.LimaBridge.request("usage.get").catch(() => null);
    if (!state || state.asked) return;
    Services.prefs.setStringPref("lima.analytics.askedAt", String(Date.now()));
    const answer = enabled => lazy.LimaBridge.request("usage.set", { enabled });
    show(win, {
      title: "Help improve Lima?",
      detail: "Share anonymous daily counts of the features you use. Never pages, searches, text, files or accounts. Off unless you say yes.",
      tone: "ask",
      actions: [
        ["Share", () => answer(true)],
        ["No thanks", () => answer(false)],
        ["What's sent?", () => win.gBrowser.selectedTab = win.gBrowser.addTab("about:lima?view=integrations&section=privacy",
          { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })],
      ],
    });
  },
};
