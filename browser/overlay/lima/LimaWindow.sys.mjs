/* Per-window integration: the bottom-anchored tool rail in Zen's sidebar
 * (spec v2 §2.2) opens Lima surfaces as tabs, and non-private navigation
 * metadata feeds the Context Shelf. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";

// Fallback until the runtime answers; the rail is otherwise generated from
// the capability manifest (surfaces.rail), so it never drifts from Search,
// the palette, Home or MCP.
const FALLBACK_RAIL = [
  { id: "open.home", title: "Lima Home", icon: "home", url: "about:lima" },
  { id: "open.notes", title: "Notes", icon: "note", url: "about:lima?view=notes" },
  { id: "open.chat", title: "AI Chat", icon: "chat", url: "about:lima?view=chat" },
  { id: "open.terminal", title: "Terminal", icon: "terminal", url: "about:lima?view=terminal" },
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

function railButton(doc, win, entry) {
  const glyph = el(doc, "span", { class: "lima-glyph" });
  glyph.style.maskImage = `url("resource://lima-ui/icons/${entry.icon}.svg")`;
  return el(doc, "button", {
    class: "lima-rail-button",
    "data-tool": entry.id,
    title: entry.title,
    "aria-label": entry.title,
    onclick: async event => {
      try {
        // Rail clicks run through the same capability entry point as every surface.
        const result = entry.url ? { type: "open", url: entry.url } : await lazy.LimaBridge.request("capabilities.run", { id: entry.id });
        if (result?.type === "open") lazy.LimaTabs.openOrFocus(win, result.url, { background: event.metaKey });
      } catch (error) {
        dump(`[lima] rail ${entry.id} failed: ${error.message}\n`);
      }
    },
  }, [glyph]);
}

function attachRail(win) {
  const doc = win.document;
  const rail = el(doc, "div", { id: "lima-rail", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Lima tools" });
  const urls = new Map();
  const populate = entries => {
    rail.replaceChildren();
    for (const entry of entries) rail.prepend(railButton(doc, win, entry)); // bottom-anchored: first entry lowest
    update();
  };
  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (foot?.parentNode) foot.parentNode.insertBefore(rail, foot);
  else (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(rail);

  // Mark the active Lima surface in the rail.
  function update() {
    const url = win.gBrowser.selectedBrowser?.currentURI?.spec ?? "";
    for (const button of rail.querySelectorAll(".lima-rail-button")) {
      const target = urls.get(button.dataset.tool);
      const view = target?.split("view=")[1];
      const active = url.startsWith("about:lima") && (url === target ||
        (view === "notes" && url.includes("note=")) || (view === "chat" && url.includes("chat=")) || (view === "terminal" && url.includes("terminal=")));
      button.toggleAttribute("data-active", active);
    }
  }

  populate(FALLBACK_RAIL);
  rail.before(createChooser(win));
  for (const entry of FALLBACK_RAIL) urls.set(entry.id, entry.url);
  lazy.LimaBridge.request("capabilities.list").then(manifest => {
    const railEntries = manifest.filter(c => c.surfaces.rail).sort((a, b) => a.rank - b.rank);
    // Navigation capabilities resolve to fixed URLs, so the rail can mark the active one.
    const known = { "open.home": "about:lima", "open.notes": "about:lima?view=notes", "open.chat": "about:lima?view=chat", "open.terminal": "about:lima?view=terminal",
      "open.agents": "about:lima?view=agents", "open.activity": "about:lima?view=activity", "open.context": "about:lima?view=context",
      "open.studio": "about:lima?view=studio", "open.audio": "about:lima?view=audio", "open.integrations": "about:lima?view=integrations" };
    for (const entry of railEntries) urls.set(entry.id, known[entry.id]);
    populate(railEntries.map(c => ({ id: c.id, title: c.title, icon: c.icon, url: known[c.id] })));
  }).catch(() => {});

  win.gBrowser.tabContainer.addEventListener("TabSelect", update);
  win.gBrowser.addProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
    onLocationChange: update,
  });
}

/** "＋" chooser: every new thing is a Tab, a Folder, or an AI Workspace. */
function createChooser(win) {
  const doc = win.document;
  const menu = el(doc, "div", { id: "lima-new-menu", role: "menu", hidden: "true" });
  const option = (iconName, title, detail, action) => {
    const glyph = el(doc, "span", { class: "lima-glyph" });
    glyph.style.maskImage = `url("resource://lima-ui/icons/${iconName}.svg")`;
    return el(doc, "button", { class: "lima-new-option", role: "menuitem", onclick: () => { menu.hidden = true; action(); } },
      [glyph, el(doc, "span", {}, [el(doc, "strong", { text: title }), el(doc, "small", { text: detail })])]);
  };
  menu.append(
    option("tab", "Tab", "A page in this space", () => {
      try { win.BrowserCommands.openTab(); } catch { win.gBrowser.selectedTab = win.gBrowser.addTab("about:newtab", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); }
    }),
    option("folder", "Folder", "Group tabs together", () => doc.getElementById("cmd_zenOpenFolderCreation")?.doCommand()),
    option("workspace", "AI Workspace", "Folder + terminal + agent on a directory", () => lazy.LimaTabs.openOrFocus(win, "about:lima?view=workspaces&new=1")),
  );
  const plus = el(doc, "span", { class: "lima-glyph" });
  plus.style.maskImage = 'url("resource://lima-ui/icons/plus.svg")';
  const button = el(doc, "button", { id: "lima-new-button", title: "New Tab, Folder or AI Workspace", "aria-haspopup": "menu",
    onclick: () => { menu.hidden = !menu.hidden; } }, [plus]);
  doc.addEventListener("mousedown", event => { if (!menu.hidden && !menu.contains(event.target) && event.target !== button && !button.contains(event.target)) menu.hidden = true; });
  return el(doc, "div", { id: "lima-new" }, [menu, button]);
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
    win.gBrowser.tabContainer.addEventListener("TabClose", event => lazy.LimaWorkspaces.onTabClose(event.target));
    attachContextRecorder(win);
    // Development/testing aid: open a Lima URL once the window has settled
    // (Zen's first-run flow replaces command-line tabs on new profiles).
    const devURL = Services.env.get("LIMA_DEV_OPEN_URL");
    if (devURL.startsWith("about:lima")) win.setTimeout(() => lazy.LimaTabs.openOrFocus(win, devURL), 4000);
    dump("[lima] window integrated\n");
  },
};
