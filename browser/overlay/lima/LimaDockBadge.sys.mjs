import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { LimaVisualActivity } from "resource://lima/LimaVisualActivity.sys.mjs";
import { LimaAppearance } from "resource://lima/LimaAppearance.sys.mjs";

/* The Dock icon's "working" badge: a speech bubble whose dots ripple while
 * any chat or workspace is working, a brief check when the work ends, then
 * the plain icon again. One animator serves every window (the Dock is
 * shared). The palette follows Lima's theme setting (`lima.theme`, default
 * "system", which tracks macOS appearance live through the runtime). */

const FRAMES = 12;
const FRAME_MS = 190; // ~5 fps: enough to read as motion, half the Dock updates
const DONE_MS = 1400;
// A 1×1 transparent PNG: drawn over the badge if the engine can't clear it.
const CLEAR = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function decode(bytes) {
  return Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromArrayBuffer(bytes.buffer, "image/png");
}

function load(name) {
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch({ uri: `resource://lima-ui/marks/${name}.png`, loadUsingSystemPrincipal: true }, (stream, status) => {
      if (!Components.isSuccessCode(status)) { reject(new Error(`Unable to load Dock badge ${name}`)); return; }
      try {
        const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        input.setInputStream(stream);
        resolve(decode(Uint8Array.from(input.readByteArray(input.available()))));
      } catch (error) { reject(error); }
    });
  });
}

async function palette(theme) {
  const [frames, done] = await Promise.all([
    Promise.all(Array.from({ length: FRAMES }, (_, n) => load(`dock-${theme}-${n}`))),
    load(`dock-${theme}-done`),
  ]);
  return { frames, done };
}

let dock;
const windows = new Set();
let images = {};
let active = false;
let shown = false;
let timer;
let finishing;
let index = 0;
let unsubscribe;
let clearImage;

const personality = () => Services.prefs.getStringPref("lima.personality", "full");

function anyWindow() {
  for (const win of windows) if (!win.closed) return win;
  return null;
}

const theme = () => LimaAppearance.theme();
let unwatchAppearance;

function still() {
  const win = anyWindow();
  return personality() !== "full" || !!win?.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (finishing) clearTimeout(finishing);
  finishing = undefined;
}

/** Back to the plain app icon. Clearing the text alone left the last frame. */
function clear() {
  stop();
  if (!shown) return;
  shown = false;
  // A transparent image hides the badge for certain; null then removes it
  // where the engine supports that.
  try { clearImage ??= decode(Uint8Array.from(atob(CLEAR), c => c.charCodeAt(0))); dock.setBadgeImage(clearImage); } catch {}
  try { dock.setBadgeImage(null); } catch {}
  try { dock.badgeText = ""; } catch {}
}

function show(image) {
  if (!image) return;
  dock.setBadgeImage(image);
  shown = true;
}

function paint() {
  stop();
  const set = images[theme()];
  if (!active || !set || personality() === "off" || !windows.size) { clear(); return; }
  if (still()) { show(set.frames[3]); return; }
  show(set.frames[index % FRAMES]);
  timer = setInterval(() => show(images[theme()]?.frames[++index % FRAMES]), FRAME_MS);
}

/** Work ended: a short check, then the plain icon. */
function finish() {
  stop();
  const set = images[theme()];
  if (!shown || !set || personality() === "off") { clear(); return; }
  show(set.done);
  finishing = setTimeout(clear, still() ? 600 : DONE_MS);
}

function changed() {
  if (active) paint();
  else if (shown && !finishing) paint();
}

export const LimaDockBadge = {
  start(win) {
    if (!dock) {
      try { dock = Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport); } catch { return; }
      if (!dock.setBadgeImage) { dock = null; return; }
      Services.prefs.addObserver("lima.personality", changed);
      Services.prefs.addObserver("lima.theme", changed);
      unwatchAppearance = LimaAppearance.subscribe(changed);
      unsubscribe = LimaVisualActivity.subscribe(({ chats, workspaces }) => {
        const next = [...Object.values(chats), ...Object.values(workspaces)].some(item => ["starting", "working"].includes(item.state));
        if (active === next) return;
        active = next;
        if (active) { index = 0; paint(); }
        else finish();
      });
      Promise.all(["light", "dark"].map(name => palette(name).then(set => { images[name] = set; })))
        .then(changed).catch(error => Cu.reportError(error));
    }
    windows.add(win);
    const motion = win.matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", changed);
    win.addEventListener("unload", () => {
      motion.removeEventListener("change", changed);
      windows.delete(win);
      if (!windows.size) {
        clear();
        unsubscribe?.();
        Services.prefs.removeObserver("lima.personality", changed);
        Services.prefs.removeObserver("lima.theme", changed);
        unwatchAppearance?.();
        dock = null;
        images = {};
        active = false;
      }
    }, { once: true });
  },
};
