/* Quick emoji: tap ⌘ twice to pick an emoji and drop it where you were
 * typing, in a web page, a Lima page or the address bar. Type to search;
 * arrows move, Return inserts, Escape closes. Recent picks come first. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const RECENT = "lima.emoji.recent";
const DOUBLE_TAP_MS = 350;
let catalog = null;

function loadCatalog() {
  catalog ??= lazy.LimaBridge.request("emoji.catalog").catch(error => { catalog = null; throw error; });
  return catalog;
}

function recent() {
  try { return JSON.parse(Services.prefs.getStringPref(RECENT, "[]")).filter(item => Array.isArray(item)).slice(0, 18); } catch { return []; }
}

function remember(entry) {
  const next = [entry, ...recent().filter(([emoji]) => emoji !== entry[0])].slice(0, 18);
  Services.prefs.setStringPref(RECENT, JSON.stringify(next));
}

export const LimaEmoji = {
  install(win) {
    if (win.limaEmoji) return;
    const doc = win.document;
    const el = (tag, attrs = {}, ...children) => {
      const node = doc.createElementNS(HTML, tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
      node.append(...children);
      return node;
    };
    const search = el("input", { type: "search", class: "lima-emoji-search", placeholder: "Search emoji", "aria-label": "Search emoji", autocomplete: "off" });
    const grid = el("div", { class: "lima-emoji-grid", role: "listbox", "aria-label": "Emoji" });
    const hint = el("div", { class: "lima-emoji-hint" });
    const panel = el("div", { id: "lima-emoji", role: "dialog", "aria-label": "Emoji", hidden: "true" }, search, grid, hint);
    (doc.getElementById("browser") ?? doc.documentElement).append(panel);
    let groups = [];
    let cells = [];
    let active = 0;
    let previousFocus = null;
    let previousBrowser = null;

    function paint() {
      const query = search.value.trim().toLowerCase();
      const sections = [];
      if (!query) {
        const recents = recent();
        if (recents.length) sections.push({ name: "Recent", emoji: recents });
        sections.push(...groups);
      } else {
        const terms = query.split(/\s+/);
        const found = groups.flatMap(group => group.emoji).filter(([, name]) => terms.every(term => name.includes(term))).slice(0, 120);
        sections.push({ name: found.length ? "Results" : "No emoji match", emoji: found });
      }
      grid.replaceChildren();
      cells = [];
      for (const section of sections) {
        grid.append(el("div", { class: "lima-emoji-group", role: "presentation" }, section.name));
        for (const entry of section.emoji) {
          const cell = el("button", { type: "button", class: "lima-emoji-cell", role: "option", title: entry[1], "aria-label": entry[1], tabindex: "-1" }, entry[0]);
          cell.addEventListener("click", () => choose(entry));
          cell.addEventListener("mousemove", () => select(cells.indexOf(cell), false));
          cells.push(cell);
          grid.append(cell);
        }
      }
      select(0, false);
    }
    function select(index, scroll = true) {
      if (!cells.length) { hint.textContent = ""; return; }
      active = Math.max(0, Math.min(index, cells.length - 1));
      for (const [position, cell] of cells.entries()) cell.toggleAttribute("aria-selected", position === active);
      if (scroll) cells[active].scrollIntoView({ block: "nearest" });
      hint.textContent = cells[active].title;
    }
    function close(restore = true) {
      if (panel.hidden) return;
      panel.removeAttribute("data-open");
      panel.hidden = true;
      if (restore) refocus();
    }
    function refocus() {
      if (previousBrowser?.isConnected) previousBrowser.focus();
      else previousFocus?.focus?.();
    }
    function choose(entry) {
      remember(entry);
      close(false);
      refocus();
      // Inserted as typed text into whatever had focus, in any process.
      win.setTimeout(() => {
        try { win.windowUtils.sendContentCommandEvent("insertText", null, entry[0]); }
        catch { try { previousFocus?.setRangeText?.(entry[0], previousFocus.selectionStart, previousFocus.selectionEnd, "end"); } catch {} }
      }, 30);
    }
    async function open() {
      if (!panel.hidden) { close(); return; }
      const focused = Services.focus.focusedElement;
      previousBrowser = focused?.localName === "browser" ? focused : (focused ? null : win.gBrowser.selectedBrowser);
      previousFocus = focused;
      search.value = "";
      panel.hidden = false;
      void panel.offsetWidth;
      panel.setAttribute("data-open", "true");
      search.focus();
      if (!groups.length) {
        grid.replaceChildren(el("div", { class: "lima-emoji-group" }, "Loading…"));
        try { groups = await loadCatalog(); } catch { grid.replaceChildren(el("div", { class: "lima-emoji-group" }, "Emoji aren't available right now.")); return; }
      }
      paint();
    }

    const COLUMNS = 9;
    search.addEventListener("input", paint);
    panel.addEventListener("keydown", event => {
      const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Enter") { event.preventDefault(); const cell = cells[active]; if (cell) cell.click(); }
      else if (moves[event.key] && (event.key.startsWith("ArrowU") || event.key.startsWith("ArrowD") || !search.value || search.selectionStart === search.value.length)) {
        event.preventDefault();
        select(active + moves[event.key]);
      }
    });
    panel.addEventListener("focusout", () => win.setTimeout(() => { if (!panel.contains(doc.activeElement)) close(false); }, 0));

    // Tapping ⌘ twice, with no other key in between, opens the picker.
    let lastTap = 0;
    let metaDown = false;
    let otherKey = false;
    win.addEventListener("keydown", event => {
      if (event.key === "Meta") { metaDown = true; otherKey = false; return; }
      otherKey = true;
      lastTap = 0;
    }, true);
    win.addEventListener("keyup", event => {
      if (event.key !== "Meta") return;
      const clean = metaDown && !otherKey;
      metaDown = false;
      if (!clean) { lastTap = 0; return; }
      const now = Date.now();
      if (now - lastTap < DOUBLE_TAP_MS) { lastTap = 0; open(); }
      else lastTap = now;
    }, true);
    win.addEventListener("mousedown", () => { otherKey = true; lastTap = 0; }, true);
    win.limaEmoji = { open, close };
  },
};
