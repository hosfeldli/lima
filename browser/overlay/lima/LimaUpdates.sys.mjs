/* Lima updates. lima-host checks the signed release feed, downloads and
 * verifies the build (feed signature, digest, code signature, no
 * downgrades) and installs it out of process. This module decides when to
 * check, tells the user, and installs a ready update when they quit.
 *
 * Zen's and Firefox's own updaters stay off (policy DisableAppUpdate and
 * locked prefs in lima.cfg). Their surfaces show Lima's updater instead:
 * Zen's About window reports and installs Lima updates, and Settings hides
 * Firefox's update section and the policy banner that switching it off
 * would otherwise show. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
});

const FIRST_CHECK_MS = 20 * 1000;
// Security releases ship within hours of Zen's; check hourly.
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
// A failed check (offline, server busy) retries soon instead of waiting an hour.
const RETRY_MS = 10 * 60 * 1000;
// Waking the Mac or reconnecting checks again if the last check is this old.
const STALE_MS = 20 * 60 * 1000;
const NOTIFICATION_ID = "lima-update-ready";
const INSTALL_ON_QUIT = "lima.updates.installOnQuit";
const RELEASES = "https://github.com/hosfeldli/lima/releases";

let timer = null;
let shown = null;
let state = null;
let lastCheck = 0;
let installing = false;
const aboutWindows = new Set();

function windows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(win => !win.closed && win.gNotificationBox);
}

function profilePath() {
  return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
}

async function restartToUpdate() {
  installing = true;
  try {
    await lazy.LimaBridge.request("update.install", { browserPid: Services.appinfo.processID, profilePath: profilePath() });
  } catch (error) { installing = false; throw error; }
  // Allow Zen to finish writing session state before replacing the app.
  Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
}

function whatsNew(win) {
  lazy.LimaTabs.openOrFocus(win, state?.notesUrl || RELEASES);
}

function notify(status) {
  const key = `${status.build}`;
  if (shown === key) return;
  shown = key;
  for (const win of windows()) {
    const box = win.gNotificationBox;
    box.getNotificationWithValue(NOTIFICATION_ID)?.close();
    const when = Services.prefs.getBoolPref(INSTALL_ON_QUIT, true) ? " It installs when you quit Lima." : "";
    box.appendNotification(
      NOTIFICATION_ID,
      {
        label: status.critical
          ? `Lima ${status.version} includes security fixes. Restart to install it now.${when}`
          : `Lima ${status.version} is ready.${when}`,
        priority: status.critical ? box.PRIORITY_WARNING_HIGH : box.PRIORITY_INFO_MEDIUM,
      },
      [
        { label: "Restart to Update", accessKey: "R", callback: () => { restartToUpdate().catch(error => failedInstall(win, error)); return false; } },
        { label: "View What's New", accessKey: "W", callback: () => { whatsNew(win); return true; } },
      ]
    ).then(notification => notification?.setAttribute("lima-update-notice", "true")).catch(() => {});
  }
}

function failedInstall(win, error) {
  shown = null;
  lazy.LimaTabs.openOrFocus(win, "about:lima?view=integrations&section=updates");
  dump(`[lima] update install failed: ${error.message ?? error}\n`);
}

function onStatus(status) {
  if (!status) return;
  state = status;
  if (status.phase === "ready") notify(status);
  for (const win of aboutWindows) paintAbout(win);
}

function schedule(delay) {
  timer?.cancel();
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(() => check(), delay, Ci.nsITimer.TYPE_ONE_SHOT);
}

async function check() {
  lastCheck = Date.now();
  try {
    onStatus(await lazy.LimaBridge.request("update.check"));
    schedule(CHECK_INTERVAL_MS);
  } catch (error) {
    dump(`[lima] update check failed: ${error.message ?? error}\n`);
    schedule(RETRY_MS);
  }
}

// MARK: Install when the user quits

/** A ready update installs once quitting is final (after any "close tabs?"
 * prompt), without relaunching; Lima opens updated next time. A restart
 * skips it, so the old app never reopens mid-swap. Active agents or terminal
 * commands keep the update for next time (the runtime refuses then). */
const quitObserver = {
  observe(_subject, topic, data) {
    if (topic !== "quit-application" || data === "restart" || installing || state?.phase !== "ready") return;
    if (!Services.prefs.getBoolPref(INSTALL_ON_QUIT, true)) return;
    installing = true;
    let settled = false;
    const deadline = Date.now() + 4000;
    lazy.LimaBridge.request("update.install", { browserPid: Services.appinfo.processID, profilePath: profilePath(), relaunch: false })
      .catch(error => dump(`[lima] install on quit skipped: ${error.message ?? error}\n`))
      .finally(() => { settled = true; });
    // The installer only needs the request; it waits for this process to exit.
    Services.tm.spinEventLoopUntil("Lima: hand the update to the installer", () => settled || Date.now() > deadline);
  },
};

// MARK: Waking and reconnecting

const freshness = {
  observe(_subject, topic, data) {
    if (topic === "network:link-status-changed" && data !== "up") return;
    if (Date.now() - lastCheck > STALE_MS) schedule(5000);
  },
};

// MARK: Zen's About window reports Lima's updater

const ABOUT_STATES = {
  disabled: ["never-checked", () => "Automatic updates are off in development builds."],
  idle: ["up-to-date", status => status.checkedAt ? "Lima is up to date" : "Check for the latest Lima release."],
  checking: ["checking", () => "Checking for updates…"],
  available: ["downloading", () => "Downloading update…"],
  downloading: ["downloading", status => status.progress != null ? `Downloading update… ${Math.round(status.progress * 100)}%` : "Downloading update…"],
  verifying: ["applying", () => "Verifying update…"],
  ready: ["ready", status => `Lima ${status.version} is ready. Restart to install it.`],
  installing: ["applying", () => "Restarting Lima…"],
  failed: ["failed", status => `Update failed${status.error ? `: ${status.error}` : "."} Your current version keeps working.`],
};

function paintAbout(win) {
  const doc = win.document;
  const section = doc.getElementById("zen-about-update");
  if (!section || !state) return;
  const [zenState, text] = ABOUT_STATES[state.phase] ?? ABOUT_STATES.idle;
  section.hidden = false;
  section.dataset.state = zenState;
  const label = doc.getElementById("zen-about-update-text");
  label.removeAttribute("data-l10n-id");
  label.hidden = false;
  label.textContent = text(state);
  const button = doc.getElementById("zen-about-update-button");
  button.removeAttribute("data-l10n-id");
  const action = state.phase === "ready" ? ["Restart to Update", () => restartToUpdate().catch(() => {})]
    : state.phase === "failed" ? ["Retry", check]
    : state.phase === "idle" ? ["Check for Updates", check]
    : null;
  button.hidden = !action;
  button.textContent = action?.[0] ?? "";
  button.limaAction = action?.[1];
  button.classList.toggle("primary", state.phase === "ready");
}

function takeOverAbout(win) {
  const doc = win.document;
  if (doc.documentElement?.id !== "zen-about-dialog" || aboutWindows.has(win)) return;
  // Firefox's updater would report "disabled by your organization" or point at Zen's downloads.
  try { win.zenAboutDialog?.stopUpdateChecks(); } catch {}
  const zenButton = doc.getElementById("zen-about-update-button");
  if (zenButton) {
    const button = zenButton.cloneNode(false); // drops Zen's click handler
    button.addEventListener("click", () => button.limaAction?.());
    zenButton.replaceWith(button);
  }
  aboutWindows.add(win);
  win.addEventListener("unload", () => aboutWindows.delete(win), { once: true });
  if (state) paintAbout(win);
  lazy.LimaBridge.request("update.status").then(onStatus).catch(() => {});
}

const windowObserver = {
  observe(subject, topic) {
    if (topic !== "domwindowopened") return;
    subject.addEventListener("load", () => takeOverAbout(subject), { once: true });
  },
};

// MARK: Settings hides Firefox's update section and the policy banner

function hideFirefoxUpdateUI() {
  const css = `@-moz-document url-prefix("about:preferences") {
    #updatesCategory, #updateApp, #policies-container, #updateDeck { display: none !important; }
  }`;
  const sheets = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const uri = Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css));
  if (!sheets.sheetRegistered(uri, sheets.USER_SHEET)) sheets.loadAndRegisterSheet(uri, sheets.USER_SHEET);
}

export const LimaUpdates = {
  async start() {
    if (timer) return;
    try { hideFirefoxUpdateUI(); } catch (error) { dump(`[lima] update UI: ${error}\n`); }
    Services.obs.addObserver(windowObserver, "domwindowopened");
    for (const win of Services.wm.getEnumerator("Browser:About")) takeOverAbout(win);
    const status = await lazy.LimaBridge.request("update.status").catch(() => null);
    lazy.LimaBridge.onEvent(message => { if (message.event === "update.status") onStatus(message.data); });
    onStatus(status);
    if (!status || status.phase === "disabled") return; // development build
    if (status.lastInstall?.ok === false) dump(`[lima] last update was rolled back: ${status.lastInstall.error}\n`);
    Services.obs.addObserver(quitObserver, "quit-application");
    Services.obs.addObserver(freshness, "wake_notification");
    Services.obs.addObserver(freshness, "network:link-status-changed");
    schedule(FIRST_CHECK_MS);
  },
  check,
  restartToUpdate,
};
