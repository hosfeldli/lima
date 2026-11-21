import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { setInterval, clearInterval } from "resource://gre/modules/Timer.sys.mjs";
import { LimaBridge } from "resource://lima/LimaBridge.sys.mjs";

function loadBadge(number) {
  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch({ uri: `resource://lima-ui/marks/dock-chat-${number}.png`, loadUsingSystemPrincipal: true }, (stream, status) => {
      if (!Components.isSuccessCode(status)) { reject(new Error("Unable to load Dock badge")); return; }
      try {
        const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        input.setInputStream(stream);
        const bytes = Uint8Array.from(input.readByteArray(input.available()));
        resolve(Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools).decodeImageFromArrayBuffer(bytes.buffer, "image/png"));
      } catch (error) { reject(error); }
    });
  });
}

export const LimaDockBadge = {
  start(win) {
    let dock;
    try { dock = Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport); } catch { return; }
    if (!dock.setBadgeImage) return;
    const active = new Set();
    const changed = new Set();
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");
    let timer;
    let frames = [];
    let index = 0;
    let shown = false;
    function paint() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!active.size || !frames.length || Services.prefs.getStringPref("lima.personality", "full") === "off") {
        if (shown) dock.badgeText = "";
        shown = false;
        return;
      }
      dock.setBadgeImage(frames[index++ % frames.length]);
      shown = true;
      if (!reduce.matches && Services.prefs.getStringPref("lima.personality", "full") === "full") {
        timer = setInterval(() => dock.setBadgeImage(frames[index++ % frames.length]), 260);
      }
    }
    reduce.addEventListener("change", paint);
    Services.prefs.addObserver("lima.personality", paint);
    LimaBridge.onEvent(({ event, data }) => {
      if (event === "chat.updated") {
        changed.add(data.id);
        const wasActive = active.has(data.id);
        if (data.messages?.some(message => message.status === "streaming")) active.add(data.id);
        else active.delete(data.id);
        if (wasActive !== active.has(data.id)) paint();
      }
      if (event === "host.unavailable") { active.clear(); paint(); }
    });
    Promise.all([1, 2, 3, 4, 5, 6].map(loadBadge)).then(loaded => { frames = loaded; paint(); }).catch(error => Cu.reportError(error));
    LimaBridge.request("chat.list").then(list => {
      for (const chat of list) if (chat.running && !changed.has(chat.id)) active.add(chat.id);
      paint();
    }).catch(() => {});
  },
};
