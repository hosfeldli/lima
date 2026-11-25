/* Downloads in the sidebar's bottom rail: a button with live progress and a
 * panel of recent files (open, show in Finder, retry, cancel, drag out).
 * Replaces Zen's download animation and Firefox's auto-opening panel
 * (both turned off in lima.cfg). Private windows list only their own. */

import { popIn, sinkAway } from "resource://lima/LimaMotion.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  LimaUsage: "resource://lima/LimaUsage.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const SHOWN = 30;

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function glyph(doc, name) {
  const node = el(doc, "span", { class: "lima-glyph" });
  node.style.maskImage = `url("${ICON(name)}")`;
  return node;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function fileName(download) {
  const path = download.target?.path ?? "";
  return path.split("/").pop() || (() => { try { return new URL(download.source.url).pathname.split("/").pop(); } catch { return ""; } })() || "Download";
}

/** One line on where a download stands. */
export function describe(download, now = Date.now()) {
  if (download.succeeded) {
    if (download.target?.exists === false) return "Moved or deleted";
    const host = (() => { try { return new URL(download.source.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
    return [formatBytes(download.target?.size ?? download.totalBytes), host].filter(Boolean).join(" · ");
  }
  if (download.canceled) return "Canceled";
  if (download.error) return download.error.becauseBlocked ? "Blocked: this file may be harmful" : "Failed";
  if (download.stopped) return "Paused";
  const done = formatBytes(download.currentBytes);
  if (!download.hasProgress) return `${done} downloaded`;
  const elapsed = (now - new Date(download.startTime).getTime()) / 1000;
  const rate = elapsed > 1 ? download.currentBytes / elapsed : 0;
  const left = rate > 0 ? Math.max(0, (download.totalBytes - download.currentBytes) / rate) : NaN;
  const eta = !Number.isFinite(left) ? "" : left < 60 ? `${Math.ceil(left)}s left` : `${Math.ceil(left / 60)} min left`;
  return [`${done} of ${formatBytes(download.totalBytes)}`, eta].filter(Boolean).join(" · ");
}

export const LimaDownloads = {
  /** The rail button; the panel and notices live in the dock above the rail. */
  attach(win, dock) {
    const doc = win.document;
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    const ring = el(doc, "span", { class: "lima-download-ring", hidden: true });
    const badge = el(doc, "span", { class: "lima-download-badge", hidden: true });
    const button = el(doc, "button", { id: "lima-downloads", title: "Downloads", "aria-label": "Downloads", "aria-expanded": "false",
      onclick: () => toggle() }, glyph(doc, "download"), ring, badge);
    const list = el(doc, "ul", { class: "lima-downloads-list", role: "list" });
    const empty = el(doc, "p", { class: "lima-downloads-empty", text: "Files you download appear here." });
    const clear = el(doc, "button", { class: "lima-downloads-clear", onclick: clearFinished }, "Clear");
    const panel = el(doc, "section", { class: "lima-downloads-panel", hidden: true, "aria-label": "Downloads" },
      el(doc, "header", {}, el(doc, "strong", { text: "Downloads" }), clear,
        el(doc, "button", { class: "lima-downloads-folder", title: "Open the Downloads folder", onclick: openFolder }, glyph(doc, "folder"))),
      list, empty);
    const toast = el(doc, "div", { class: "lima-download-toast", hidden: true, role: "status" });
    dock.querySelector("#lima-dock-main")?.prepend(panel, toast);

    const rows = new Map();
    let downloads = [];
    let unseen = 0;
    let downloadList;
    let ticker;
    let toastTimer;

    function toggle(open = panel.hidden) {
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) { unseen = 0; paintButton(); paintList(); toast.hidden = true; }
    }

    function paintButton() {
      const active = downloads.filter(item => !item.stopped);
      button.toggleAttribute("data-active", active.length > 0);
      const total = active.reduce((sum, item) => sum + (item.hasProgress ? item.totalBytes : 0), 0);
      const current = active.reduce((sum, item) => sum + (item.hasProgress ? item.currentBytes : 0), 0);
      ring.hidden = !active.length;
      ring.style.setProperty("--progress", total ? `${Math.round((current / total) * 100)}%` : "25%");
      ring.toggleAttribute("data-indeterminate", active.length > 0 && !total);
      badge.hidden = !unseen;
      badge.textContent = unseen > 9 ? "9+" : String(unseen);
      button.title = active.length ? `Downloading ${active.length} ${active.length === 1 ? "file" : "files"}` : "Downloads";
    }

    function rowFor(download) {
      let row = rows.get(download);
      if (row) return row;
      const name = el(doc, "span", { class: "lima-download-name" });
      const status = el(doc, "span", { class: "lima-download-status" });
      const bar = el(doc, "progress", { max: "100", class: "lima-download-progress" });
      const actions = el(doc, "span", { class: "lima-download-actions" });
      const node = el(doc, "li", { class: "lima-download", draggable: "true", title: "",
        ondblclick: () => open(download),
        onclick: event => { if (!event.target.closest("button")) open(download); },
        ondragstart: event => {
          // Drag the finished file into Finder, a chat or another app.
          if (!download.succeeded) { event.preventDefault(); return; }
          try {
            const file = new lazy.FileUtils.File(download.target.path);
            event.dataTransfer.mozSetDataAt("application/x-moz-file", file, 0);
            event.dataTransfer.setData("text/uri-list", Services.io.newFileURI(file).spec);
            event.dataTransfer.effectAllowed = "copyMove";
          } catch { event.preventDefault(); }
        } },
        el(doc, "span", { class: "lima-download-icon" }, glyph(doc, "file")),
        el(doc, "span", { class: "lima-download-main" }, name, status, bar), actions);
      row = { node, name, status, bar, actions };
      rows.set(download, row);
      return row;
    }

    function action(label, icon, run) {
      return el(doc, "button", { class: "lima-download-action", title: label, "aria-label": label,
        onclick: event => { event.stopPropagation(); Promise.resolve().then(run).catch(error => Cu.reportError(error)).finally(paintList); } },
        glyph(doc, icon));
    }

    function paintRow(download) {
      const row = rowFor(download);
      row.name.textContent = fileName(download);
      row.node.title = download.target?.path ?? "";
      row.status.textContent = describe(download);
      const running = !download.stopped;
      row.bar.hidden = !running;
      if (download.hasProgress) row.bar.value = download.progress; else row.bar.removeAttribute("value");
      row.node.dataset.state = download.succeeded ? "done" : running ? "running" : download.error ? "failed" : "stopped";
      row.actions.replaceChildren(...[
        download.succeeded ? action("Show in Finder", "folder-open", () => download.showContainingDirectory()) : null,
        running ? action("Cancel", "close", () => download.cancel()) : null,
        !running && !download.succeeded ? action("Retry", "redo", () => download.start()) : null,
        !running ? action("Remove from list", "trash", () => downloadList.remove(download)) : null,
      ].filter(Boolean));
      return row.node;
    }

    function paintList() {
      if (panel.hidden) return;
      const shown = downloads.slice(-SHOWN).reverse();
      list.replaceChildren(...shown.map(paintRow));
      empty.hidden = shown.length > 0;
      clear.hidden = !downloads.some(item => item.stopped);
    }

    async function open(download) {
      if (!download.succeeded) return;
      try { await download.launch(); } catch { download.showContainingDirectory().catch(() => {}); }
    }

    async function openFolder() {
      const directory = await lazy.Downloads.getPreferredDownloadsDirectory();
      const file = new lazy.FileUtils.File(directory);
      try { file.launch(); } catch { file.reveal(); }
    }

    async function clearFinished() {
      for (const download of downloads.filter(item => item.stopped)) await downloadList.remove(download);
      paintList();
    }

    function announce(download) {
      if (!panel.hidden || !download.succeeded) return;
      toast.replaceChildren(glyph(doc, "check"),
        el(doc, "span", { class: "lima-download-toast-name", text: fileName(download) }),
        el(doc, "button", { onclick: () => { sinkAway(toast, { flow: true }); open(download); } }, "Open"),
        el(doc, "button", { onclick: () => { sinkAway(toast, { flow: true }); download.showContainingDirectory(); } }, "Show"));
      popIn(toast, { flow: true });
      win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(() => sinkAway(toast, { flow: true }), 6000);
    }

    const finished = new WeakSet();
    const view = {
      onDownloadAdded(download) {
        downloads.push(download);
        if (!download.stopped && Date.now() - new Date(download.startTime).getTime() < 10_000) { unseen++; }
        if (download.stopped) finished.add(download);
        paintButton();
        paintList();
      },
      onDownloadChanged(download) {
        if (download.stopped && !finished.has(download)) {
          finished.add(download);
          announce(download);
          if (download.succeeded) lazy.LimaUsage.count("download.finished", win);
        }
        paintButton();
        if (!panel.hidden && rows.has(download)) paintRow(download);
        else paintList();
      },
      onDownloadRemoved(download) {
        downloads = downloads.filter(item => item !== download);
        rows.delete(download);
        paintButton();
        paintList();
      },
    };
    lazy.Downloads.getList(isPrivate ? lazy.Downloads.PRIVATE : lazy.Downloads.PUBLIC).then(found => {
      if (win.closed) return;
      downloadList = found;
      return found.addView(view);
    }).catch(error => Cu.reportError(error));
    // Times and speeds move while the panel is open.
    ticker = win.setInterval(() => { if (!panel.hidden) for (const item of downloads) if (!item.stopped) paintRow(item); }, 1000);
    win.addEventListener("unload", () => { win.clearInterval(ticker); downloadList?.removeView(view); }, { once: true });
    doc.addEventListener("keydown", event => { if (event.key === "Escape" && !panel.hidden) toggle(false); });
    doc.addEventListener("mousedown", event => {
      if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) toggle(false);
    });
    return button;
  },
};
