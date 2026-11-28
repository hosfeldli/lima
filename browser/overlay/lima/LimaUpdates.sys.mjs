import { showSidebarNotice } from "resource://lima/LimaSidebar.sys.mjs";
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

import { sinkAway } from "resource://lima/LimaMotion.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  isMiniWindow: "resource://lima/LimaTabs.sys.mjs",
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
  // Full Lima windows only: Mini Lima never shows update cards or pages.
  return [...Services.wm.getEnumerator("navigator:browser")]
    .filter(win => !win.closed && win.gNotificationBox && !lazy.isMiniWindow(win));
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

const WHATS_NEW = "about:lima?view=whats-new";
function whatsNew(win) {
  lazy.LimaTabs.openOrFocus(win, state?.releaseNotes ? WHATS_NEW : (state?.notesUrl || RELEASES));
}

function showInstalledChanges(status) {
  const win = windows()[0];
  const update = status.lastInstall;
  if (!win || !update?.ok || update.kind === "rollback" || update.build !== status.currentBuild || !update.at) return;
  const token = `${update.build}:${update.at}`;
  if (Services.prefs.getStringPref("lima.updates.shownInstall", "") === token) return;
  Services.prefs.setStringPref("lima.updates.shownInstall", token);
  // The What's New tab opens by itself, once, after the restart.
  if (status.releaseNotes) { lazy.LimaTabs.openOrFocus(win, WHATS_NEW); return; }
  showSidebarNotice(win, { title: `Updated to Lima ${status.currentVersion}`, tone: "ask",
    actions: [["What's New", () => lazy.LimaTabs.openOrFocus(win, RELEASES)]] });
}

function offerApplications(status) {
  const win = windows()[0];
  if (!win || !status.moveRecommended || Services.prefs.getBoolPref("lima.installation.offeredMove", false)) return;
  Services.prefs.setBoolPref("lima.installation.offeredMove", true);
  showSidebarNotice(win, { title: "Move Lima to Applications", tone: "ask", detail: "Install Lima there so it can update and open from Finder.",
    actions: [["Move to Applications", async () => {
      await lazy.LimaBridge.request("update.moveToApplications");
      showSidebarNotice(win, { title: "Lima is installed", detail: "Quit this window and reopen Lima from Applications." });
    }]] });
}

const HTML = "http://www.w3.org/1999/xhtml";
function el(doc, tag, props = {}, ...children) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

/** Sits in the window's bottom-left corner, above the sidebar's dock. */
function place(win, card) {
  const dock = win.document.getElementById("lima-dock");
  const rect = dock?.getBoundingClientRect();
  const visible = rect && rect.width > 0 && rect.height > 0;
  card.style.left = `${visible ? Math.max(8, rect.left + 8) : 12}px`;
  card.style.bottom = `${visible ? Math.max(12, win.innerHeight - rect.top + 8) : 12}px`;
  if (visible) card.style.maxWidth = `${Math.max(260, rect.width - 16)}px`;
}

/** A Lima card, not Firefox's notification bar: what's ready, when it
 * installs, and Restart / What's New / Later. Later hides it for this
 * build; the update still installs on quit. */
function showCard(win, status) {
  const doc = win.document;
  doc.getElementById(NOTIFICATION_ID)?.remove();
  const onQuit = Services.prefs.getBoolPref(INSTALL_ON_QUIT, true);
  const close = () => { win.removeEventListener("resize", reposition); sinkAway(card, { done: () => card.remove() }); };
  const reposition = () => place(win, card);
  const restart = el(doc, "button", { type: "button", class: "lima-update-primary", onclick: () => {
    restart.disabled = true;
    restart.textContent = "Restarting…";
    restartToUpdate().catch(error => { restart.disabled = false; restart.textContent = "Restart to Update"; failedInstall(win, error); });
  } }, "Restart to Update");
  const card = el(doc, "div", { id: NOTIFICATION_ID, class: "lima-update-card", role: "status", "aria-live": "polite",
    "data-critical": status.critical ? "true" : null },
    el(doc, "div", { class: "lima-update-head" },
      el(doc, "span", { class: "lima-update-icon", "aria-hidden": "true" }),
      el(doc, "div", { class: "lima-update-copy" },
        el(doc, "strong", { text: status.critical ? `Security update: Lima ${status.version}` : `Lima ${status.version} is ready` }),
        el(doc, "span", { text: status.critical ? "Includes security fixes. Restart now to install it."
          : onQuit ? "Installs when you quit, or restart now." : "Restart to install it." })),
      el(doc, "button", { type: "button", class: "lima-update-close", title: "Later", "aria-label": "Remind me later", onclick: close }, "×")),
    el(doc, "div", { class: "lima-update-actions" },
      el(doc, "button", { type: "button", class: "lima-update-secondary", onclick: () => whatsNew(win) }, "What's New"), restart));
  doc.documentElement.append(card);
  place(win, card);
  win.addEventListener("resize", reposition);
}

function notify(status) {
  const key = `${status.build}`;
  if (shown === key) return;
  shown = key;
  for (const win of windows()) {
    win.gNotificationBox.getNotificationWithValue(NOTIFICATION_ID)?.close();
    try { showCard(win, status); } catch (error) { dump(`[lima] update card: ${error}\n`); }
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
    offerApplications(status);
    showInstalledChanges(status);
    if (status.lastInstall?.ok === false) dump(`[lima] last update was rolled back: ${status.lastInstall.error}\n`);
    Services.obs.addObserver(quitObserver, "quit-application");
    Services.obs.addObserver(freshness, "wake_notification");
    Services.obs.addObserver(freshness, "network:link-status-changed");
    schedule(FIRST_CHECK_MS);
  },
  check,
  restartToUpdate,
  /** Shows the update card for a status (tests and screenshots). */
  previewCard(win, status) { showCard(win, status); },
};
