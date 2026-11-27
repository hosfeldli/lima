import { tabURL } from "resource://lima/LimaWorkspaces.sys.mjs";

const origins = { mail: "https://mail.google.com", calendar: "https://calendar.google.com" };

function tabAddress(tab) {
  if (tab.hasAttribute("pending")) return tabURL(tab);
  return tab.linkedBrowser?.currentURI?.spec || tabURL(tab);
}

function serviceFor(url) {
  try {
    const parsed = new URL(url);
    return Object.keys(origins).find(key => origins[key] === parsed.origin);
  } catch { return undefined; }
}

function matchingTabs(win) {
  const source = win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs;
  const tabs = [...source].filter(tab => tab.isConnected && !tab.closing && tab.hasAttribute("zen-essential"));
  const selected = tabs.indexOf(win.gBrowser.selectedTab);
  if (selected > 0) tabs.unshift(...tabs.splice(selected, 1));
  return tabs.flatMap(tab => {
    const url = tabAddress(tab);
    const service = serviceFor(url);
    return service ? [{ service, tab, url }] : [];
  });
}

export function googleEssentialTabs(win) {
  const preferred = {};
  for (const entry of matchingTabs(win)) preferred[entry.service] ??= entry;
  return preferred;
}

export async function refreshGoogleEssentials(win, retained) {
  // One tab per service stays loaded for its unread count, not every copy.
  const tabs = Object.values(googleEssentialTabs(win));
  const owned = new Set(tabs.map(({ tab }) => tab));
  for (const tab of retained) {
    if (owned.has(tab)) continue;
    retained.delete(tab);
    tab.removeAttribute("undiscardable");
  }
  for (const { tab, url } of tabs) {
    if (!tab.hasAttribute("undiscardable")) {
      tab.setAttribute("undiscardable", "true");
      retained.add(tab);
    }
    if (tab.hasAttribute("pending") && !tab.linkedPanel) {
      try {
        win.gBrowser.insertBrowser(tab);
        tab.linkedBrowser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
        });
      } catch {}
    }
  }
  const entries = Object.entries(googleEssentialTabs(win));
  const results = await Promise.all(entries.map(async ([service, { tab }]) => {
    try {
      const global = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
      if (!global || serviceFor(global.documentURI?.spec) !== service) return [service, null];
      const value = await global.getActor("LimaPage").sendQuery("essentialStatus", { origin: origins[service], service });
      if (tab.closing || !tab.hasAttribute("zen-essential") || global !== tab.linkedBrowser.browsingContext?.currentWindowGlobal) {
        return [service, null];
      }
      return [service, value];
    } catch { return [service, null]; }
  }));
  return Object.fromEntries(results);
}
