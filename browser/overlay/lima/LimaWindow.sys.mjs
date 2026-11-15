/* Per-window integration: the bottom-anchored tool rail in Zen's sidebar
 * (spec v2 §2.2) opens Lima surfaces as tabs, and non-private navigation
 * metadata feeds the Context Shelf. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";

// Bottom-up order: the first entry sits lowest.
const TOOLS = [
  { id: "notes", label: "Notes", glyph: "✎", url: "about:lima?view=notes" },
  { id: "chat", label: "AI Chat", glyph: "✦", url: "about:lima?view=chat" },
  { id: "terminal", label: "Terminal", glyph: "›_", url: "about:lima?view=terminal" },
  { id: "agents", label: "Agents", glyph: "◎", url: "about:lima?view=agents" },
  { id: "context", label: "Context Shelf", glyph: "◷", url: "about:lima?view=context" },
  { id: "studio", label: "Screenshot Studio", glyph: "⌗", url: "about:lima?view=studio" },
  { id: "audio", label: "Audio", glyph: "♪", url: "about:lima?view=audio" },
  { id: "integrations", label: "Integrations & Settings", glyph: "⇄", url: "about:lima?view=integrations" },
];

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function attachRail(win) {
  const doc = win.document;
  const rail = el(doc, "div", { id: "lima-rail", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Lima tools" });
  for (const tool of TOOLS) {
    rail.prepend(el(doc, "button", {
      class: "lima-rail-button",
      "data-tool": tool.id,
      title: tool.label,
      "aria-label": tool.label,
      onclick: event => lazy.LimaTabs.openOrFocus(win, tool.url, { background: event.metaKey }),
    }, [el(doc, "span", { class: "lima-glyph", text: tool.glyph })]));
  }
  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (foot?.parentNode) foot.parentNode.insertBefore(rail, foot);
  else (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(rail);

  // Mark the active Lima surface in the rail.
  const update = () => {
    const url = win.gBrowser.selectedBrowser?.currentURI?.spec ?? "";
    for (const button of rail.querySelectorAll(".lima-rail-button")) {
      const tool = TOOLS.find(t => t.id === button.dataset.tool);
      const active = url.startsWith("about:lima") && (url === tool.url || (tool.id === "notes" && url.includes("note=")) || (tool.id === "chat" && url.includes("chat=")) || (tool.id === "terminal" && url.includes("terminal=")));
      button.toggleAttribute("data-active", active);
    }
  };
  win.gBrowser.tabContainer.addEventListener("TabSelect", update);
  win.gBrowser.addProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    onLocationChange: update,
  });
  update();
}

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
    attachRail(win);
    attachContextRecorder(win);
    // Development/testing aid: open a Lima URL once the window has settled
    // (Zen's first-run flow replaces command-line tabs on new profiles).
    const devURL = Services.env.get("LIMA_DEV_OPEN_URL");
    if (devURL.startsWith("about:lima")) win.setTimeout(() => lazy.LimaTabs.openOrFocus(win, devURL), 4000);
    dump("[lima] window integrated\n");
  },
};
