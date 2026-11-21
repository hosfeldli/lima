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
    const folders = basicsFolders(win);
    for (const folder of folders) {
      for (const tab of [...folder.tabs].filter(tab => tab.group === folder &&
        (tabURL(tab) === INTRO || isZenOnboarding(tabURL(tab))))) {
        if (tab !== source) win.gBrowser.removeTab(tab, { animate: false });
      }
    }
    if (source && !source.closing) win.gBrowser.removeTab(source, { animate: false });
    for (const folder of folders) if (folder.isConnected) await folder.unpackTabs();
  },

  async install(win) {
    await win.gZenStartup?.promiseInitialized;
    if (win.closed || !win.gZenFolders) return;
    if (Services.prefs.getBoolPref(FINISHED, false)) return;
    const basics = basicsFolders(win);
    for (const folder of basics) {
      folder.label = "Lima Basics";
      const direct = folder.tabs.filter(tab => tab.group === folder && !tab.hasAttribute("zen-empty-tab"));
      let intro = direct.find(tab => tabURL(tab) === INTRO);
      if (!intro) {
        const wasShowingWelcome = direct.some(tab => tab.selected && tabURL(tab) === "about:lima");
        intro = introTab(win);
        folder.addTabs([intro]);
        if (wasShowingWelcome) win.gBrowser.selectedTab = intro;
      }
      for (const tab of direct) {
        const address = tabURL(tab);
        if (tab === intro || !isZenOnboarding(address)) continue;
        if (tab.selected) win.gBrowser.selectedTab = intro;
        win.gBrowser.removeTab(tab, { animate: false });
      }
    }
    if (!basics.length && !Services.prefs.getBoolPref(CREATED, false) &&
        !Services.prefs.prefHasUserValue("zen.welcome-screen.seen")) {
      const intro = introTab(win);
      win.gZenFolders.createFolder([intro], { label: "Lima Basics" });
      win.gBrowser.selectedTab = intro;
    }
    Services.prefs.setBoolPref(CREATED, true);
  },
};
