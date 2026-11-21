/* Lima updates: asks the runtime to check the signed release feed, and
 * offers "Restart to update" once a verified build is staged. All checks
 * (feed signature, digest, code signature, no downgrades) happen natively
 * in lima-host; this module only schedules them and shows the result. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
});

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NOTIFICATION_ID = "lima-update-ready";

let timer = null;
let shown = null;

function windows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win.gNotificationBox);
}

async function restartToUpdate() {
  try {
    await lazy.LimaBridge.request("update.install", { browserPid: Services.appinfo.processID });
  } catch (error) {
    Cu.reportError(error);
    return;
  }
  // The installer waits for this process to exit, swaps the bundle and relaunches Lima.
  Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
}

function show(status) {
  const key = `${status.build}`;
  if (shown === key) return;
  shown = key;
  for (const win of windows()) {
    const box = win.gNotificationBox;
    box.getNotificationWithValue(NOTIFICATION_ID)?.close();
    box.appendNotification(
      NOTIFICATION_ID,
      {
        label: status.critical
          ? `Lima ${status.version} includes security fixes. Restart to update.`
          : `Lima ${status.version} is ready. Restart to update.`,
        priority: status.critical ? box.PRIORITY_WARNING_HIGH : box.PRIORITY_INFO_MEDIUM,
      },
      [{ label: "Restart to Update", accessKey: "R", callback: () => { restartToUpdate(); return true; } }]
    );
  }
}

function onStatus(status) {
  if (status?.phase === "ready") show(status);
}

async function check() {
  try {
    onStatus(await lazy.LimaBridge.request("update.check"));
  } catch (error) {
    dump(`[lima] update check failed: ${error.message ?? error}\n`);
  }
}

export const LimaUpdates = {
  async start() {
    if (timer) return;
    const status = await lazy.LimaBridge.request("update.status").catch(() => null);
    if (!status || status.phase === "disabled") return; // development build
    if (status.lastInstall?.ok === false) dump(`[lima] last update was rolled back: ${status.lastInstall.error}\n`);
    lazy.LimaBridge.onEvent(message => { if (message.event === "update.status") onStatus(message.data); });
    onStatus(status);
    timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(() => {
      check();
      timer.initWithCallback(check, CHECK_INTERVAL_MS, Ci.nsITimer.TYPE_REPEATING_SLACK);
    }, FIRST_CHECK_MS, Ci.nsITimer.TYPE_ONE_SHOT);
  },
  check,
};
