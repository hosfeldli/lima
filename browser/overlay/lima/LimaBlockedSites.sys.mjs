/* Pages Lima never opens: Zen's own site (welcome, release notes, donate,
 * share links, …). Lima is a rebranded Zen, so those pages only confuse.
 * Every page or frame load to zen-browser.app or a subdomain is cancelled in
 * the parent process before it reaches the network; a tab that was opened
 * just for it closes, and a tab with history stays on the page it was on. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { setTimeout: "resource://gre/modules/Timer.sys.mjs" });

const BLOCKED = ["zen-browser.app"];

const DOCUMENT_TYPES = new Set([Ci.nsIContentPolicy.TYPE_DOCUMENT, Ci.nsIContentPolicy.TYPE_SUBDOCUMENT]);

export function isBlockedHost(host) {
  const name = String(host ?? "").toLowerCase().replace(/\.$/, "");
  return BLOCKED.some(domain => name === domain || name.endsWith("." + domain));
}

export function isBlockedURL(url) {
  try { return isBlockedHost(new URL(url).hostname); } catch { return false; }
}

/** The tab showing browsing context `id` (by its top context), if any. */
function tabFor(id) {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const tab of win.gBrowser?.tabs ?? []) {
      const context = tab.linkedBrowser?.browsingContext;
      if (context && (context.id === id || context.top?.id === id)) return { win, tab };
    }
  }
  return null;
}

/** A tab opened just for the blocked page closes once the load has stopped.
 * It's looked up afterwards: when the first request of a new tab goes out,
 * its browser isn't attached to the tab yet. */
function closeIfEmpty(contextID) {
  if (!contextID) return;
  lazy.setTimeout(() => {
    const found = tabFor(contextID);
    if (!found) return;
    const { win, tab } = found;
    const browser = tab.linkedBrowser;
    if (browser.canGoBack) return;
    const spec = browser.currentURI?.spec ?? "about:blank";
    if (!["about:blank", "about:newtab", "about:home"].includes(spec) && !isBlockedURL(spec)) return;
    if (win.gBrowser.tabs.length > 1) win.gBrowser.removeTab(tab, { animate: false });
  }, 250);
}

const observer = {
  observe(subject) {
    const channel = subject.QueryInterface?.(Ci.nsIHttpChannel);
    const loadInfo = channel?.loadInfo;
    if (!loadInfo || !DOCUMENT_TYPES.has(loadInfo.externalContentPolicyType)) return;
    if (!isBlockedHost(channel.URI?.host)) return;
    // Aborted, not "blocked": no error page, the tab stays where it was.
    channel.cancel(Cr.NS_BINDING_ABORTED);
    dump(`[lima] blocked ${channel.URI.spec}\n`);
    if (loadInfo.externalContentPolicyType === Ci.nsIContentPolicy.TYPE_DOCUMENT) {
      const context = loadInfo.browsingContext ?? BrowsingContext.get(loadInfo.browsingContextID);
      closeIfEmpty(context?.top?.id ?? loadInfo.browsingContextID);
    }
  },
};

let started = false;

export const LimaBlockedSites = {
  start() {
    if (started) return;
    started = true;
    Services.obs.addObserver(observer, "http-on-modify-request");
  },
};
