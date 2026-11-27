/* Mini Lima: links you open from other apps (Mail, Slack, Messages…) open in a
 * small window of their own instead of piling up in your sidebar. Read the
 * page, then close it, or press ⌘O / "Open in Lima" to move it into your
 * main window. ⌥⌘N opens an empty Mini Lima for a quick search.
 *
 * A mini window is an ordinary Lima window that Zen doesn't sync with your
 * sidebar, with the sidebar hidden and a slim bar in its place. Links it
 * opens in new tabs go to your main window. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PREF = "lima.mini.externalLinks";
const STORE_ID = "lima-mini";
const SIZE = { width: 980, height: 720, minWidth: 420, minHeight: 320 };
const START = "about:lima?view=mini";
const HTML = "http://www.w3.org/1999/xhtml";

function size() {
  const stored = (name, fallback, min) => {
    const value = parseInt(Services.xulStore.getValue(AppConstants.BROWSER_CHROME_URL, STORE_ID, name), 10);
    return Number.isFinite(value) ? Math.max(value, min) : fallback;
  };
  return { width: stored("width", SIZE.width, SIZE.minWidth), height: stored("height", SIZE.height, SIZE.minHeight) };
}

/** The main (non-mini, non-private) window to hand pages to. */
function mainWindow() {
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false })
    .find(win => !win.closed && !win.limaMini && !win.document.documentElement.hasAttribute("lima-mini")) ?? null;
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

export const LimaMini = {
  get handlesExternalLinks() { return Services.prefs.getBoolPref(PREF, true); },

  /** Opens `url` (or the quick-search page) in a new mini window. */
  open(url = START, { triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal() } = {}) {
    const opener = mainWindow() ?? lazy.BrowserWindowTracker.getTopWindow({ private: false });
    if (!opener) return null;
    const { width, height } = size();
    // Centered over the window you were in, so it appears where you're looking.
    const left = Math.round(opener.screenX + Math.max(0, (opener.outerWidth - width) / 2));
    const top = Math.round(opener.screenY + Math.max(0, (opener.outerHeight - height) / 3));
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
    for (const item of [uri, extraOptions, null, null, fixup, container, null, null, triggeringPrincipal, null, null]) args.appendElement(item);
    const win = Services.ww.openWindow(opener, AppConstants.BROWSER_CHROME_URL, null,
      `chrome,dialog=no,all,width=${width},height=${height},left=${left},top=${top}`, args);
    // Zen keeps windows in sync with your sidebar; this one stays on its own.
    win._zenStartupSyncFlag = "unsynced";
    win.limaMini = true;
    win.addEventListener("DOMContentLoaded", () => win.document.documentElement.setAttribute("lima-mini", "true"), { once: true });
    return win;
  },

  /** In a main window: catch links from other apps, and ⌥⌘N. */
  installInMainWindow(win) {
    if (win.limaMiniInstalled || win.limaMini || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    win.limaMiniInstalled = true;
    wrapLinkHandler(win, (original, uri, openWindowInfo, where, flags, principal, csp) => {
      const external = !!(flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL);
      const web = uri && /^(https?|file):$/.test(`${uri.scheme}:`);
      if (external && web && LimaMini.handlesExternalLinks) {
        const mini = LimaMini.open(uri.spec, { triggeringPrincipal: principal ?? undefined });
        if (mini) return null;
      }
      return original.openURI(uri, openWindowInfo, where, flags, principal, csp);
    });
    win.addEventListener("keydown", event => {
      if (event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey && event.code === "KeyN") {
        event.preventDefault();
        event.stopPropagation();
        LimaMini.open();
      }
    }, true);
  },

  /** A mini window: hide the sidebar, add the slim bar, route new tabs home. */
  setup(win) {
    const doc = win.document;
    const root = doc.documentElement;
    root.setAttribute("lima-mini", "true");
    const gBrowser = win.gBrowser;
    const el = (tag, attrs = {}, ...children) => {
      const node = doc.createElementNS(HTML, tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
      node.append(...children);
      return node;
    };
    const favicon = el("img", { class: "lima-mini-favicon", alt: "" });
    const host = el("span", { class: "lima-mini-host" });
    const title = el("span", { class: "lima-mini-title" });
    const copy = el("button", { class: "lima-mini-button", type: "button", title: "Copy link (⇧⌘C)", "aria-label": "Copy link",
      onclick: () => copyLink() }, "Copy link");
    const move = el("button", { class: "lima-mini-button primary", type: "button", title: "Open in your Lima window (⌘O)",
      "aria-label": "Open in Lima", onclick: () => moveToMain() }, "Open in Lima");
    const bar = el("div", { id: "lima-mini-bar", role: "toolbar", "aria-label": "Mini Lima" },
      el("div", { class: "lima-mini-site" }, favicon, el("div", { class: "lima-mini-text" }, host, title)),
      el("div", { class: "lima-mini-actions" }, copy, move));
    const box = doc.getElementById("tabbrowser-tabbox");
    box?.parentNode.insertBefore(bar, box);

    function paint() {
      const tab = gBrowser.selectedTab;
      const spec = gBrowser.currentURI?.spec ?? "";
      let shown = "";
      try {
        const url = new URL(spec);
        shown = /^https?:$/.test(url.protocol) ? url.host.replace(/^www\./, "") : spec.startsWith("about:lima") ? "Mini Lima" : url.protocol.replace(/:$/, "");
      } catch {}
      host.textContent = shown;
      title.textContent = tab?.label && tab.label !== shown ? tab.label : "";
      const image = tab?.getAttribute("image");
      favicon.hidden = !image;
      if (image) favicon.src = image;
      win.document.title = tab?.label ? `${tab.label} — Mini Lima` : "Mini Lima";
      move.disabled = spec === START || spec === "about:blank";
    }
    function copyLink() {
      const spec = gBrowser.currentURI?.spec;
      if (!spec || spec.startsWith("about:")) return;
      Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(spec);
      copy.textContent = "Copied";
      win.setTimeout(() => { copy.textContent = "Copy link"; }, 1200);
    }
    function moveToMain() {
      const main = mainWindow();
      const tab = gBrowser.selectedTab;
      if (!main || !tab || move.disabled) return;
      // Moving the only tab closes this window; the page keeps its state.
      const adopted = main.gBrowser.adoptTab(tab, { selectTab: true });
      if (adopted) main.focus();
    }

    gBrowser.addProgressListener({
      QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
      onLocationChange: () => paint(),
    });
    gBrowser.tabContainer.addEventListener("TabAttrModified", paint);
    gBrowser.tabContainer.addEventListener("TabSelect", paint);
    paint();

    // New tabs (target=_blank, ⌘-click) go to your main window.
    wrapLinkHandler(win, (original, uri, openWindowInfo, where, flags, principal, csp) => {
      const main = mainWindow();
      if (main && where !== Ci.nsIBrowserDOMWindow.OPEN_CURRENTWINDOW) {
        main.focus();
        return main.browserDOMWindow.openURI(uri, openWindowInfo, Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
          flags & ~Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL, principal, csp);
      }
      return original.openURI(uri, openWindowInfo, where, flags, principal, csp);
    });

    win.addEventListener("keydown", event => {
      if (event.metaKey && !event.altKey && !event.shiftKey && event.code === "KeyO") { event.preventDefault(); moveToMain(); }
      else if (event.metaKey && event.shiftKey && event.code === "KeyC") { event.preventDefault(); copyLink(); }
      else if (event.metaKey && event.altKey && event.code === "KeyN") { event.preventDefault(); LimaMini.open(); }
    }, true);
    // Remember the size you leave it at for next time.
    win.addEventListener("resize", () => {
      win.clearTimeout(win.limaMiniResize);
      win.limaMiniResize = win.setTimeout(() => {
        for (const [name, value] of [["width", win.outerWidth], ["height", win.outerHeight]]) {
          Services.xulStore.setValue(AppConstants.BROWSER_CHROME_URL, STORE_ID, name, String(Math.round(value)));
        }
      }, 400);
    });
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
