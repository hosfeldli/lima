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

async function hop(win, browser, position) {
  const doc = win.document;
  const destination = doc.getElementById("lima-assistant-toggle");
  if (!destination || win.gBrowser.selectedBrowser !== browser ||
      win.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      Services.prefs.getStringPref("lima.personality", "full") !== "full") return;
  const { x, y, width, height } = position ?? {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > 180 || height > 180) return;
  const viewport = browser.getBoundingClientRect();
  const zoom = browser.fullZoom || 1;
  if (x < 0 || y < 0 || x * zoom > viewport.width || y * zoom > viewport.height) return;
  const start = { x: viewport.left + x * zoom, y: viewport.top + y * zoom };
  const end = destination.getBoundingClientRect();
  const dx = end.left + (end.width - width * zoom) / 2 - start.x;
  const dy = end.top + (end.height - height * zoom) / 2 - start.y;
  const jumper = doc.createElementNS("http://www.w3.org/1999/xhtml", "img");
  jumper.alt = "";
  jumper.src = "resource://lima-ui/marks/companion.svg";
  Object.assign(jumper.style, { position: "fixed", zIndex: "2147483647", pointerEvents: "none",
    left: `${start.x}px`, top: `${start.y}px`, width: `${width * zoom}px`, height: `${height * zoom}px` });
  doc.documentElement.append(jumper);
  try {
    await jumper.animate([
      { transform: "translateY(0) scale(1)" },
      { transform: "translateY(5px) scale(1.08, .88)", offset: .17 },
      { transform: `translate(${dx * .48}px, ${dy * .58 - 26}px) scale(.76) rotate(-13deg)`, offset: .53 },
      { transform: `translate(${dx}px, ${dy}px) scale(${end.width / (width * zoom)})` },
    ], { duration: 680, easing: "ease-in-out" }).finished;
    destination.animate([{ transform: "scale(.93)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }], 250);
  } finally { jumper.remove(); }
}

export const LimaWelcome = {
  async finish(win, browser, position) {
    await hop(win, browser, position).catch(() => {});
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
