/* Mini Lima: a transient browsing surface. Links you open from other apps
 * (Mail, Slack, Messages…) open in a compact floating window instead of
 * piling up in your sidebar: read it and dismiss it, or hand it to your main
 * window with everything intact. Temporary by default, persistent when
 * needed, transferable at any time.
 *
 * One window, three behaviours (not three modes to learn):
 *   Quick View   – the default. Escape or clicking away dismisses it, when
 *                  that loses nothing.
 *   Interactive  – entered by itself once you type into the page, play
 *                  media or download: it stays until you close it.
 *   Pinned       – ⇧⌘P or the pin: floats above other apps.
 *
 * It is an ordinary Lima window that Zen doesn't sync with your sidebar,
 * with the sidebar hidden and a 44-point toolbar in its place: back,
 * forward, reload, the site (domain first, full address on click, with its
 * connection security), share, pin, Open in Lima (with where to send it) and
 * a menu for the rest. Pages it opens in new tabs stay in it, in a strip
 * that only appears with more than one. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

export const PREFS = {
  external: "lima.mini.externalLinks",
  reuse: "lima.mini.reuseWindow",
  rememberSize: "lima.mini.rememberSize",
  outside: "lima.mini.outsideClick", // "dismiss" (when safe) or "keep"
  pinned: "lima.mini.pinnedByDefault",
  restoreFocus: "lima.mini.restoreFocus",
  hints: "lima.mini.hints",
  shortcut: "lima.mini.shortcut", // e.g. "alt+meta+KeyN"
  appRules: "lima.mini.appRules", // { bundleId: { name, open: "mini" | "main" } }
  siteRules: "lima.mini.siteRules", // ["example.com", …]: always the main window
  lastClosed: "lima.mini.lastClosed",
};
const STORE_ID = "lima-mini";
const DEFAULT = { width: 960, height: 720, minWidth: 420, minHeight: 320 };
const START = "about:lima?view=mini";
const HTML = "http://www.w3.org/1999/xhtml";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const system = () => Services.scriptSecurityManager.getSystemPrincipal();
const log = message => Services.console.logStringMessage(`[lima] mini: ${message}`);

const bool = (pref, fallback) => Services.prefs.getBoolPref(pref, fallback);
const json = (pref, fallback) => { try { return JSON.parse(Services.prefs.getStringPref(pref, "")); } catch { return fallback; } };

/** The main (non-mini, non-private) window to hand pages to. */
function mainWindow() {
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false })
    .find(win => !win.closed && !win.limaMini && !win.document.documentElement.hasAttribute("lima-mini")) ?? null;
}

function miniWindows() {
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false }).filter(win => !win.closed && win.limaMini);
}

/** The window's link handler with `openURI` replaced. The engine's own
 * handler is frozen, so this one delegates every other member to it. */
function wrapLinkHandler(win, openURI) {
  const original = win.browserDOMWindow;
  if (!original || original.limaWrapped) return;
  const wrapper = { limaWrapped: true, QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]) };
  const seen = new Set(["QueryInterface", "openURI", "constructor"]);
  for (let proto = original; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (seen.has(name) || name.startsWith("_")) continue;
      seen.add(name);
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (typeof descriptor.value === "function") wrapper[name] = (...args) => original[name](...args);
      else Object.defineProperty(wrapper, name, { get: () => original[name], enumerable: true });
    }
  }
  wrapper.openURI = (...args) => openURI(original, ...args);
  win.browserDOMWindow = wrapper;
}

/** "alt+meta+KeyN" → matches a keydown. */
export function matchesShortcut(event, spec = Services.prefs.getStringPref(PREFS.shortcut, "alt+meta+KeyN")) {
  const parts = String(spec).split("+");
  const code = parts.pop();
  const want = new Set(parts);
  return event.code === code && event.altKey === want.has("alt") && event.metaKey === want.has("meta")
    && event.shiftKey === want.has("shift") && event.ctrlKey === want.has("ctrl");
}

/** "alt+meta+KeyN" → "⌥⌘N" */
export function shortcutLabel(spec = Services.prefs.getStringPref(PREFS.shortcut, "alt+meta+KeyN")) {
  const parts = String(spec).split("+");
  const code = parts.pop() ?? "";
  const key = code.replace(/^Key|^Digit/, "").replace("Space", "Space").replace("Period", ".").replace("Comma", ",");
  return `${parts.includes("ctrl") ? "⌃" : ""}${parts.includes("alt") ? "⌥" : ""}${parts.includes("shift") ? "⇧" : ""}${parts.includes("meta") ? "⌘" : ""}${key}`;
}

/** Size and place for a new window on the display you're working on. */
async function geometry(opener) {
  let screen = null;
  try { screen = await lazy.LimaBridge.request("system.pointerScreen"); } catch {}
  const area = screen ?? { left: opener.screenX, top: opener.screenY, width: opener.outerWidth, height: opener.outerHeight, layout: "" };
  const key = `size:${area.layout || "default"}`;
  const stored = bool(PREFS.rememberSize, true) ? Services.xulStore.getValue(AppConstants.BROWSER_CHROME_URL, STORE_ID, key) : "";
  const [savedWidth, savedHeight] = stored.split("x").map(Number);
  // About 70% of the display's width and 78% of its height, at most 960 × 720.
  let width = savedWidth || Math.min(DEFAULT.width, Math.round(area.width * 0.72));
  let height = savedHeight || Math.min(DEFAULT.height, Math.round(area.height * 0.78));
  width = Math.max(DEFAULT.minWidth, Math.min(width, area.width - 40));
  height = Math.max(DEFAULT.minHeight, Math.min(height, area.height - 40));
  const left = Math.round(area.left + (area.width - width) / 2);
  const top = Math.round(area.top + Math.max(12, (area.height - height) * 0.42));
  return { width, height, left, top, key };
}

function openWindow(opener, url, { width, height, left, top, pinned, principal }) {
  // The same argument list Firefox's own "open in a new window" builds.
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  const uri = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  uri.data = url;
  const extraOptions = Cc["@mozilla.org/hash-property-bag;1"].createInstance(Ci.nsIWritablePropertyBag2);
  extraOptions.setPropertyAsBool("lima-mini", true);
  const fixup = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
  fixup.data = false;
  const container = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(Ci.nsISupportsPRUint32);
  container.data = 0;
  for (const item of [uri, extraOptions, null, null, fixup, container, null, null, principal ?? system(), null, null]) args.appendElement(item);
  const features = `chrome,dialog=no,all,width=${width},height=${height},left=${left},top=${top}${pinned ? ",alwaysontop" : ""}`;
  const win = Services.ww.openWindow(opener, AppConstants.BROWSER_CHROME_URL, null, features, args);
  // Zen keeps windows in sync with your sidebar; this one stays on its own.
  win._zenStartupSyncFlag = "unsynced";
  win.limaMini = true;
  win.addEventListener("DOMContentLoaded", () => win.document.documentElement.setAttribute("lima-mini", "true"), { once: true });
  return win;
}

export const LimaMini = {
  get handlesExternalLinks() { return bool(PREFS.external, true); },

  /** Where a link from another app goes: Mini Lima, unless a rule for its
   * site or the app it came from says the main window. */
  async routeExternal(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (json(PREFS.siteRules, []).some(rule => host === rule || host.endsWith(`.${rule}`))) return "main";
    } catch {}
    const rules = json(PREFS.appRules, {});
    if (Object.keys(rules).length) {
      const app = await lazy.LimaBridge.request("system.previousApp").catch(() => null);
      if (app?.bundleId && rules[app.bundleId]?.open) return rules[app.bundleId].open;
    }
    return "mini";
  },

  /** Opens `url` (or the quick search) in Mini Lima: the open Quick View is
   * reused, with a new temporary tab when its page has your input. */
  async open(url = START, { triggeringPrincipal = system(), external = false, pinned = bool(PREFS.pinned, false) } = {}) {
    const reusable = bool(PREFS.reuse, true) && miniWindows().find(win => win.limaMiniState && !win.limaMiniState.closing);
    if (reusable && url !== START) {
      const state = reusable.limaMiniState;
      const current = reusable.gBrowser.currentURI?.spec;
      if (state.dirty || (current && current !== START && current !== "about:blank")) {
        reusable.gBrowser.selectedTab = reusable.gBrowser.addTab(url, { triggeringPrincipal });
      } else {
        reusable.gBrowser.selectedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal });
      }
      if (external) state.external = true;
      reusable.focus();
      return reusable;
    }
    const opener = mainWindow() ?? lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (!opener) return null;
    const place = await geometry(opener);
    const win = openWindow(opener, url, { ...place, pinned, principal: triggeringPrincipal });
    win.limaMiniState = { mode: "quick", pinned, dirty: false, external, sizeKey: place.key, closing: false };
    return win;
  },

  /** Reopens the last Mini Lima you dismissed. */
  reopen() {
    const last = Services.prefs.getStringPref(PREFS.lastClosed, "");
    return last ? this.open(last) : this.open();
  },

  /** In a main window: catch links from other apps, and the shortcut. */
  installInMainWindow(win) {
    if (win.limaMiniInstalled || win.limaMini || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    win.limaMiniInstalled = true;
    wrapLinkHandler(win, (original, uri, openWindowInfo, where, flags, principal, csp) => {
      const external = !!(flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL);
      const web = uri && /^(https?|file):$/.test(`${uri.scheme}:`);
      if (external && web && LimaMini.handlesExternalLinks) {
        // Decided after a quick look at the rules; the main window is the fallback.
        LimaMini.routeExternal(uri.spec).then(target => {
          if (target === "main") {
            original.openURI(uri, openWindowInfo, Ci.nsIBrowserDOMWindow.OPEN_NEWTAB, flags, principal, csp);
            win.focus();
          } else LimaMini.open(uri.spec, { triggeringPrincipal: principal ?? undefined, external: true });
        }).catch(error => { log(error); original.openURI(uri, openWindowInfo, where, flags, principal, csp); });
        return null;
      }
      return original.openURI(uri, openWindowInfo, where, flags, principal, csp);
    });
    win.addEventListener("keydown", event => {
      if (!matchesShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      LimaMini.open();
    }, true);
  },

  /** A mini window: hide the sidebar, add the toolbar, wire its behaviour. */
  setup(win) {
    const doc = win.document;
    const root = doc.documentElement;
    root.setAttribute("lima-mini", "true");
    const gBrowser = win.gBrowser;
    const state = win.limaMiniState ??= { mode: "quick", pinned: false, dirty: false, external: false, sizeKey: "size:default", closing: false };
    const el = (tag, attrs = {}, ...children) => {
      const node = doc.createElementNS(HTML, tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
      }
      node.append(...children);
      return node;
    };
    const glyph = name => el("span", { class: "lima-mini-glyph", style: `mask-image: url("${ICON(name)}")`, "aria-hidden": "true" });
    const button = (label, iconName, onclick, extra = {}) =>
      el("button", { type: "button", class: "lima-mini-icon", title: label, "aria-label": label, onclick, ...extra }, glyph(iconName));

    // MARK: Toolbar
    const back = button("Back (⌘[)", "arrow", () => gBrowser.goBack(), { "data-flip": "" });
    const forward = button("Forward (⌘])", "arrow", () => gBrowser.goForward());
    const reload = button("Reload (⌘R)", "redo", () => gBrowser.selectedBrowser.isNavigating ? gBrowser.stop() : gBrowser.reload());
    const identity = el("button", { type: "button", class: "lima-mini-identity", "aria-label": "Site information" });
    const hostText = el("span", { class: "lima-mini-host" });
    const pathText = el("span", { class: "lima-mini-path" });
    const shown = el("span", { class: "lima-mini-shown" }, hostText, pathText);
    const field = el("input", { class: "lima-mini-field", type: "text", spellcheck: "false", "aria-label": "Address", hidden: true });
    const address = el("div", { class: "lima-mini-address", role: "group", "aria-label": "Address" }, identity, shown, field);
    const share = button("Share", "external", event => sharePage(event.currentTarget));
    const pin = button("Keep on top (⇧⌘P)", "bookmark", () => togglePin(), { "aria-pressed": String(!!state.pinned) });
    const handoff = el("button", { type: "button", class: "lima-mini-handoff", title: "Open in your Lima window (⌘O)", onclick: () => moveToMain() }, "Open in Lima");
    const handoffMore = el("button", { type: "button", class: "lima-mini-handoff-more", title: "Choose where to open it (⇧⌘O)",
      "aria-label": "Choose where to open it", onclick: event => openHandoffMenu(event.currentTarget) }, glyph("chevron"));
    const more = button("More", "more", event => openMoreMenu(event.currentTarget));
    const bar = el("div", { id: "lima-mini-bar", role: "toolbar", "aria-label": "Mini Lima" },
      el("div", { class: "lima-mini-nav" }, back, forward, reload),
      address,
      el("div", { class: "lima-mini-actions" }, share, pin, el("div", { class: "lima-mini-split" }, handoff, handoffMore), more));
    const strip = el("div", { id: "lima-mini-tabs", role: "tablist", "aria-label": "Mini Lima tabs", hidden: true });
    const hint = el("div", { id: "lima-mini-hint", role: "status", hidden: true });
    const box = doc.getElementById("tabbrowser-tabbox");
    box?.parentNode.insertBefore(bar, box);
    bar.after(strip);
    (doc.getElementById("browser") ?? root).append(hint);

    // MARK: Site identity
    const secure = () => gBrowser.securityUI?.state & Ci.nsIWebProgressListener.STATE_IS_SECURE;
    function paintAddress() {
      const uri = gBrowser.currentURI;
      const spec = uri?.spec ?? "";
      let host = "";
      let path = "";
      try {
        const url = new URL(spec);
        if (/^https?:$/.test(url.protocol)) {
          host = url.host.replace(/^www\./, "");
          path = (url.pathname === "/" ? "" : url.pathname) + url.search;
        } else if (spec.startsWith("about:lima")) host = "Mini Lima";
        else host = spec;
      } catch { host = spec; }
      hostText.textContent = host;
      pathText.textContent = path;
      address.title = spec.startsWith("about:lima") ? "" : spec;
      const kind = spec.startsWith("about:") ? "page" : secure() ? "secure" : /^http:/.test(spec) ? "insecure" : "page";
      identity.dataset.kind = kind;
      identity.replaceChildren(glyph(kind === "insecure" ? "warning" : kind === "secure" ? "key" : "globe"));
      identity.title = kind === "secure" ? `Connection to ${host} is secure` : kind === "insecure" ? `Connection to ${host} isn't secure` : "Site information";
      back.disabled = !gBrowser.canGoBack;
      forward.disabled = !gBrowser.canGoForward;
      const loading = gBrowser.selectedBrowser.isNavigating;
      reload.replaceChildren(glyph(loading ? "close" : "redo"));
      reload.title = loading ? "Stop" : "Reload (⌘R)";
      handoff.disabled = handoffMore.disabled = spec === START || spec === "about:blank";
      share.disabled = !/^https?:/.test(spec) || !Services.zen?.canShare?.();
      const tab = gBrowser.selectedTab;
      win.document.title = tab?.label && spec !== START ? `${tab.label} — Mini Lima` : "Mini Lima";
    }
    identity.addEventListener("click", () => {
      try { win.BrowserPageInfo(gBrowser.selectedBrowser.currentURI.spec, "securityTab", null, gBrowser.selectedBrowser.browsingContext); } catch (error) { log(error); }
    });

    // The address: the domain, emphasized; click (or ⌘L) to see and edit the whole URL.
    function editAddress() {
      const spec = gBrowser.currentURI?.spec ?? "";
      field.value = spec === START ? "" : spec;
      shown.hidden = true;
      field.hidden = false;
      address.dataset.editing = "";
      field.focus();
      field.select();
    }
    function stopEditing() {
      field.hidden = true;
      shown.hidden = false;
      delete address.dataset.editing;
    }
    shown.addEventListener("click", editAddress);
    field.addEventListener("blur", stopEditing);
    field.addEventListener("keydown", async event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopEditing(); gBrowser.selectedBrowser.focus(); }
      if (event.key !== "Enter") return;
      event.preventDefault();
      const text = field.value.trim();
      if (!text) return;
      let target = LimaMini.destination(text);
      if (!target) {
        try {
          const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
          target = (await SearchService.getDefault()).getSubmission(text).uri.spec;
        } catch (error) { log(error); return; }
      }
      stopEditing();
      gBrowser.selectedBrowser.fixupAndLoadURIString(target, { triggeringPrincipal: system() });
      gBrowser.selectedBrowser.focus();
    });

    // MARK: Temporary tabs: a strip only when there's more than one page.
    function paintTabs() {
      const tabs = [...gBrowser.tabs].filter(tab => !tab.closing && !tab.hasAttribute("zen-empty-tab") && !tab.hidden);
      strip.hidden = tabs.length < 2;
      root.toggleAttribute("lima-mini-tabs", !strip.hidden);
      if (strip.hidden) { strip.replaceChildren(); return; }
      strip.replaceChildren(...tabs.map(tab => {
        const image = tab.getAttribute("image");
        const item = el("div", { class: "lima-mini-tab", role: "tab", "aria-selected": String(tab.selected), title: tab.label },
          image ? el("img", { src: image, alt: "" }) : glyph("globe"),
          el("span", { class: "lima-mini-tab-label" }, tab.label || "New Tab"),
          el("button", { type: "button", class: "lima-mini-tab-close", "aria-label": `Close ${tab.label}`,
            onclick: event => { event.stopPropagation(); gBrowser.removeTab(tab); } }, glyph("close")));
        item.addEventListener("click", () => { gBrowser.selectedTab = tab; });
        return item;
      }));
    }

    // MARK: Interactive mode: typing into the page, media or a download
    // means you're doing something; Mini Lima then stays until you close it.
    function becomeInteractive(reason) {
      if (state.mode === "interactive") return;
      state.mode = "interactive";
      root.setAttribute("lima-mini-mode", "interactive");
      log(`interactive (${reason})`);
    }
    win.addEventListener("keydown", event => {
      const inPage = event.target?.localName === "browser" || event.target?.closest?.("browser");
      if (inPage && !event.metaKey && !event.ctrlKey && (event.key.length === 1 || event.key === "Backspace")) {
        state.dirty = true;
        becomeInteractive("typing");
      }
    }, true);
    gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
      if (event.detail?.changed?.includes("soundplaying") && event.target.hasAttribute("soundplaying")) becomeInteractive("media");
      if (event.detail?.changed?.some(name => ["image", "label"].includes(name))) { paintTabs(); paintAddress(); }
    });

    // MARK: Dismissing, safely
    const downloading = () => {
      try {
        const { DownloadsCommon } = ChromeUtils.importESModule("resource:///modules/DownloadsCommon.sys.mjs");
        return DownloadsCommon.getData(win).downloads?.some?.(download => !download.stopped) ?? false;
      } catch { return false; }
    };
    const popupsOpen = () => lazy.BrowserWindowTracker.getOrderedWindows({ private: false }).some(other => other !== win && other.opener?.top === win);
    function safeToDismiss() {
      return !state.dirty && !downloading() && !popupsOpen();
    }
    function showHint(text) {
      hint.textContent = text;
      hint.hidden = false;
      win.clearTimeout(win.limaMiniHintTimer);
      win.limaMiniHintTimer = win.setTimeout(() => { hint.hidden = true; }, 2600);
    }
    function close() {
      if (state.closing) return;
      state.closing = true;
      const spec = gBrowser.currentURI?.spec;
      if (spec && spec !== START && !spec.startsWith("about:")) Services.prefs.setStringPref(PREFS.lastClosed, spec);
      const giveBack = state.external && bool(PREFS.restoreFocus, true);
      win.close();
      if (giveBack) lazy.LimaBridge.request("system.activatePrevious").catch(() => {});
    }
    function dismiss(source) {
      if (state.pinned && source === "escape") { togglePin(false); return; }
      if (safeToDismiss()) { close(); return; }
      showHint(state.dirty ? "This page has your input. Press ⌘W to close it anyway." : "A download or sign-in is still going. Press ⌘W to close.");
    }
    // Escape, only when the page didn't use it (it arrives here last):
    // Firefox's own Escape key element stops loading; Mini Lima takes it over.
    const escapeKey = doc.getElementById("key_stop");
    if (escapeKey) {
      escapeKey.removeAttribute("command");
      escapeKey.addEventListener("command", () => {
        if (gBrowser.selectedBrowser.isNavigating) { gBrowser.stop(); return; }
        if (doc.fullscreenElement || win.fullScreen) return;
        dismiss("escape");
      });
    }
    // Clicking away from a Quick View dismisses it when that loses nothing.
    win.addEventListener("deactivate", () => {
      if (state.mode !== "quick" || state.pinned || Services.prefs.getStringPref(PREFS.outside, "dismiss") !== "dismiss") return;
      win.setTimeout(() => {
        if (state.closing || Services.focus.activeWindow === win || !safeToDismiss()) return;
        // Not while one of its own windows (a sign-in popup, a dialog) is in front.
        if (Services.focus.activeWindow?.opener?.top === win) return;
        close();
      }, 180);
    });

    // MARK: Pinning: Mini Lima floats above other apps. A window can't
    // change that once open, so the page moves to a floating one (live,
    // with its history) in the same place.
    function togglePin(next = !state.pinned) {
      if (next === state.pinned) return;
      const tab = gBrowser.selectedTab;
      const floating = openWindow(win, "about:blank", { width: win.outerWidth, height: win.outerHeight, left: win.screenX, top: win.screenY, pinned: next });
      floating.limaMiniState = { ...state, pinned: next, mode: next ? "interactive" : state.mode, closing: false };
      floating.addEventListener("load", () => {
        floating.gBrowser?.tabContainer && Promise.resolve().then(() => {
          const moved = floating.gBrowser.adoptTab(tab, { selectTab: true });
          for (const blank of [...floating.gBrowser.tabs]) if (blank !== moved && blank.linkedBrowser?.currentURI?.spec === "about:blank") floating.gBrowser.removeTab(blank);
        });
      }, { once: true });
    }

    // MARK: Handoff to your main window, keeping the page live (its history,
    // scroll, sign-in, form contents and playback travel with it).
    function moveToMain({ then } = {}) {
      let main = mainWindow();
      const tab = gBrowser.selectedTab;
      if (!tab || handoff.disabled) return null;
      if (!main) { win.OpenBrowserWindow(); main = mainWindow(); }
      if (!main) return null;
      // Every page in this Mini Lima goes together; the one you're on is selected.
      const others = [...gBrowser.tabs].filter(item => item !== tab && !item.closing && !item.hasAttribute("zen-empty-tab")
        && !["about:blank", START].includes(item.linkedBrowser?.currentURI?.spec));
      const moved = main.gBrowser.adoptTab(tab, { selectTab: true });
      for (const item of others) main.gBrowser.adoptTab(item, { selectTab: false });
      if (moved) {
        main.focus();
        state.closing = true;
        then?.(main, moved);
      }
      return moved;
    }
    function openHandoffMenu(anchor) {
      const main = mainWindow();
      const popup = doc.createXULElement("menupopup");
      const item = (label, run, key) => {
        const node = doc.createXULElement("menuitem");
        node.setAttribute("label", label);
        if (key) node.setAttribute("acceltext", key);
        node.addEventListener("command", run);
        return node;
      };
      popup.append(item("Open in Lima", () => moveToMain(), "⌘O"));
      try {
        const { LimaWorkspaces } = ChromeUtils.importESModule("resource://lima/LimaWorkspaces.sys.mjs");
        const roots = main ? LimaWorkspaces.roots(main) : [];
        if (roots.length) {
          const menu = doc.createXULElement("menu");
          menu.setAttribute("label", "Open in Workspace");
          const list = doc.createXULElement("menupopup");
          for (const workspace of roots) {
            list.append(item(workspace.name, () => moveToMain({ then: (target, tab) => LimaWorkspaces.addTab(target, workspace.id, tab).catch(log) })));
          }
          menu.append(list);
          popup.append(menu);
        }
      } catch (error) { log(error); }
      popup.append(
        item("Continue with an Agent…", () => {
          const spec = gBrowser.currentURI.spec;
          const name = gBrowser.selectedTab.label;
          moveToMain({ then: target => target.dispatchEvent(new target.CustomEvent("LimaAssistantOpen", { detail: { draft: `Use this page: ${name}\n${spec}\n\n` } })) });
        }),
        doc.createXULElement("menuseparator"),
        item("Save for Later", () => saveForLater()));
      (doc.getElementById("mainPopupSet") ?? root).append(popup);
      popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
      popup.openPopup(anchor, "after_end");
    }
    async function saveForLater() {
      const uri = gBrowser.currentURI;
      try {
        const parent = lazy.PlacesUtils.bookmarks.unfiledGuid;
        let folder = (await lazy.PlacesUtils.bookmarks.search({ title: "Saved for Later" })).find(entry => entry.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER);
        folder ??= await lazy.PlacesUtils.bookmarks.insert({ parentGuid: parent, type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER, title: "Saved for Later" });
        await lazy.PlacesUtils.bookmarks.insert({ parentGuid: folder.guid, url: uri.spec, title: gBrowser.selectedTab.label || uri.spec });
        showHint("Saved in Bookmarks → Saved for Later");
        win.setTimeout(close, 900);
      } catch (error) { showHint(`Couldn't save it: ${error.message}`); }
    }
    function sharePage(anchor) {
      const uri = gBrowser.currentURI;
      const rect = anchor.getBoundingClientRect();
      try { Services.zen.share(uri, "", "", rect.left, win.innerHeight - rect.bottom, rect.width, rect.height); } catch (error) { log(error); }
    }
    function openMoreMenu(anchor) {
      const popup = doc.createXULElement("menupopup");
      const item = (label, run, key) => {
        const node = doc.createXULElement("menuitem");
        node.setAttribute("label", label);
        if (key) node.setAttribute("acceltext", key);
        node.addEventListener("command", () => { try { run(); } catch (error) { log(error); } });
        return node;
      };
      popup.append(
        item("Find in Page…", () => win.gLazyFindCommand("onFindCommand"), "⌘F"),
        item("Reader View", () => win.AboutReaderParent.toggleReaderMode({ target: gBrowser.selectedBrowser })),
        doc.createXULElement("menuseparator"),
        item("Zoom In", () => win.FullZoom.enlarge(), "⌘+"),
        item("Zoom Out", () => win.FullZoom.reduce(), "⌘−"),
        item("Actual Size", () => win.FullZoom.reset(), "⌘0"),
        doc.createXULElement("menuseparator"),
        item("Copy Link", () => win.gZenCommonActions.copyCurrentURLToClipboard(), "⇧⌘C"),
        item("Print…", () => win.PrintUtils.startPrintWindow(gBrowser.selectedBrowser.browsingContext), "⌘P"),
        item("Downloads", () => moveToMainURL("about:downloads")),
        doc.createXULElement("menuseparator"),
        item("Close Mini Lima", () => close(), "⌘W"));
      (doc.getElementById("mainPopupSet") ?? root).append(popup);
      popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
      popup.openPopup(anchor, "after_end");
    }
    function moveToMainURL(url) {
      const main = mainWindow();
      if (!main) return;
      main.gBrowser.selectedTab = main.gBrowser.addTrustedTab(url);
      main.focus();
    }

    // MARK: Wiring
    gBrowser.addProgressListener({
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: () => paintAddress(),
      onStateChange: () => paintAddress(),
      onSecurityChange: () => paintAddress(),
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => { paintAddress(); paintTabs(); });
    gBrowser.tabContainer.addEventListener("TabOpen", () => win.setTimeout(paintTabs, 0));
    gBrowser.tabContainer.addEventListener("TabClose", () => win.setTimeout(paintTabs, 0));
    paintAddress();
    paintTabs();
    root.setAttribute("lima-mini-mode", state.mode);
    pin.setAttribute("aria-pressed", String(!!state.pinned));
    root.toggleAttribute("lima-mini-pinned", !!state.pinned);
    if (bool(PREFS.hints, true)) win.setTimeout(() => showHint(`Esc closes · ⌘O opens in Lima${state.pinned ? "" : " · ⇧⌘P keeps it on top"}`), 500);

    // New tabs (target=_blank, sign-in pop-ups' follow-ups) stay here as
    // temporary tabs; nothing is pushed into your main window on its own.
    wrapLinkHandler(win, (original, uri, openWindowInfo, where, flags, principal, csp) =>
      original.openURI(uri, openWindowInfo, where, flags & ~Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL, principal, csp));

    win.addEventListener("keydown", event => {
      const meta = event.metaKey && !event.ctrlKey;
      if (meta && !event.altKey && !event.shiftKey && event.code === "KeyO") { event.preventDefault(); moveToMain(); }
      else if (meta && !event.altKey && event.shiftKey && event.code === "KeyO") { event.preventDefault(); openHandoffMenu(handoffMore); }
      else if (meta && !event.altKey && !event.shiftKey && event.code === "KeyL") { event.preventDefault(); editAddress(); }
      else if (meta && !event.altKey && event.shiftKey && event.code === "KeyP") { event.preventDefault(); togglePin(); }
      else if (meta && !event.altKey && !event.shiftKey && event.code === "KeyT") {
        event.preventDefault();
        gBrowser.selectedTab = gBrowser.addTrustedTab(START);
      }
      else if (matchesShortcut(event)) { event.preventDefault(); LimaMini.open(); }
    }, true);
    // Remember the size you leave it at, per display arrangement.
    win.addEventListener("resize", () => {
      if (!bool(PREFS.rememberSize, true)) return;
      win.clearTimeout(win.limaMiniResize);
      win.limaMiniResize = win.setTimeout(() => {
        Services.xulStore.setValue(AppConstants.BROWSER_CHROME_URL, STORE_ID, state.sizeKey, `${Math.round(win.outerWidth)}x${Math.round(win.outerHeight)}`);
      }, 400);
    });
    win.limaMiniControls = { close, dismiss, togglePin, moveToMain, editAddress, state };
  },

  /** For the quick-search page: what to load for typed text. */
  destination(text) {
    const value = String(text ?? "").trim();
    if (!value) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
    if (/^[^\s]+\.[a-z]{2,}(?:[/:?#][^\s]*)?$/i.test(value)) return `https://${value}`;
    return null; // a search: the caller asks the search engine
  },
};
