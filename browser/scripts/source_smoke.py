#!/usr/bin/env python3
"""Exercise a built Lima.app and its runtime through an isolated macOS profile.

A source build must also carry no Zen executable or identifier. A repack
(Contents/MacOS/zen present) skips those compiled-identity checks.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time


def read_packet(stream):
    prefix = bytearray()
    while byte := stream.read(1):
        if byte == b":":
            return json.loads(stream.read(int(prefix)))
        prefix.extend(byte)
    raise EOFError("Marionette closed its connection")


def chrome(socket_handle, script):
    stream = socket_handle.makefile("rb")
    read_packet(stream)
    methods = [
        ("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}}),
        ("Marionette:SetContext", {"value": "chrome"}),
        ("WebDriver:ExecuteAsyncScript", {"script": script, "args": [], "newSandbox": True, "sandbox": "system"}),
    ]
    for request, (method, params) in enumerate(methods, 1):
        data = json.dumps([0, request, method, params]).encode()
        socket_handle.sendall(str(len(data)).encode() + b":" + data)
        _, _, error, response = read_packet(stream)
        if error:
            raise RuntimeError(error["message"])
    return response["value"]


CHECK = """
const done = arguments[arguments.length - 1];
const compiled = COMPILED;
(async () => {
  for (let attempt = 0; attempt < 120 && !document.getElementById("lima-assistant-toggle"); attempt++) {
    await new Promise(resolve => window.setTimeout(resolve, 250));
  }
  const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
  const hello = await LimaBridge.request("host.hello");
  const note = await LimaBridge.request("notes.create", { title: "Source smoke", markdown: "Verified" });
  const persisted = await LimaBridge.request("notes.get", { id: note.id });
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  await SessionStore.promiseInitialized;
  await gZenStartup.promiseInitialized;
  // Search runs a command once; its result tab (opened, then reloaded) only
  // displays the stored result.
  const executionId = Services.uuid.generateUUID().toString().slice(1, -1);
  const ran = await LimaBridge.request("capabilities.run", { id: "uuid.generate", input: "", executionId });
  const tab = gBrowser.addTab(`about:lima?run=uuid.generate&execution=${executionId}`,
    { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  gBrowser.selectedTab = tab;
  const loaded = () => new Promise(resolve => {
    const poll = () => tab.linkedBrowser?.webProgress?.isLoadingDocument === false && tab.linkedBrowser.currentURI?.spec.startsWith("about:lima")
      ? resolve() : window.setTimeout(poll, 100);
    window.setTimeout(poll, 300);
  });
  await loaded();
  await new Promise(resolve => window.setTimeout(resolve, 1500));
  tab.linkedBrowser.reload();
  await loaded();
  await new Promise(resolve => window.setTimeout(resolve, 1500));
  const countRuns = async () => (await LimaBridge.request("capabilities.runs", { limit: 200 })).filter(run => run.capability === "uuid.generate").length;
  const uuidRuns = await countRuns();
  const rendered = tab.label === "Generate UUID";
  const stored = await LimaBridge.request("capabilities.execution", { executionId });
  // Opened without an execution, the Run page runs once and records it, so
  // a reload shows the same result.
  tab.linkedBrowser.loadURI(Services.io.newURI("about:lima?run=uuid.generate"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  await loaded();
  await new Promise(resolve => window.setTimeout(resolve, 1500));
  tab.linkedBrowser.reload();
  await loaded();
  await new Promise(resolve => window.setTimeout(resolve, 1500));
  const directRuns = await countRuns();
  const recorded = /[?&#]execution=/.test(tab.linkedBrowser.currentURI.spec);
  gBrowser.removeTab(tab);
  const tasks = await LimaBridge.request("task.list", { limit: 5 }).catch(() => null);
  // Zen's and Firefox's updaters never appear: the About window shows Lima's
  // updater, and Settings hides Firefox's update section and policy banner.
  const about = await new Promise(resolve => {
    const opened = { observe(subject, topic) {
      if (topic !== "domwindowopened") return;
      Services.obs.removeObserver(opened, "domwindowopened");
      subject.addEventListener("load", () => window.setTimeout(() => resolve(subject), 1500), { once: true });
    } };
    Services.obs.addObserver(opened, "domwindowopened");
    window.openAboutDialog();
    window.setTimeout(() => resolve(null), 8000);
  });
  const aboutText = about?.document.getElementById("zen-about-update-text")?.textContent ?? "";
  about?.close();
  const prefsTab = gBrowser.addTab("about:preferences", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
  gBrowser.selectedTab = prefsTab;
  await new Promise(resolve => window.setTimeout(resolve, 2500));
  const prefsDoc = prefsTab.linkedBrowser.contentDocument;
  const shown = id => { const node = prefsDoc?.getElementById(id); return !!node && prefsDoc.defaultView.getComputedStyle(node).display !== "none"; };
  const firefoxUpdates = ["updateApp", "policies-container"].filter(shown);
  gBrowser.removeTab(prefsTab);
  // Lima's own surfaces never sit on the right edge of the window.
  const { LimaSearchPanel } = ChromeUtils.importESModule("resource://lima/LimaSearchPanel.sys.mjs");
  const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const rows = () => [...document.querySelectorAll("#lima-search-results [role=option]")];
  const selected = () => document.querySelector('#lima-search-results [aria-selected="true"]');
  const press = (key, modifiers = {}) => document.getElementById("lima-search-input")
    .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
  const type = async text => {
    const field = document.getElementById("lima-search-input");
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
  };
  // A question keeps ordinary web search first and offers Ask Lima second.
  LimaSearchPanel.open(window, "what is a browser?");
  await sleep(400);
  const input = document.getElementById("lima-search-input");
  const question = rows().map(row => row.dataset.key);
  const aria = input?.getAttribute("role") === "combobox" && input.getAttribute("aria-activedescendant") === selected()?.id &&
    document.getElementById("lima-search-results")?.getAttribute("role") === "listbox";
  // Keyboard: Down moves the selection (and the active descendant), Up returns.
  press("ArrowDown");
  const moved = selected()?.dataset.key === question[1] && input.getAttribute("aria-activedescendant") === selected()?.id;
  press("ArrowUp");
  const back = selected()?.dataset.key === question[0];
  // A URL opens first; a plain word searches the web without AI rows.
  await type("example.com");
  const url = rows()[0]?.dataset.key;
  await type("browser");
  const plain = rows().map(row => row.dataset.key);
  // Pressing ⌘T again keeps the query; Escape closes and returns focus.
  LimaSearchPanel.open(window);
  const kept = input.value === "browser" && document.activeElement === input;
  const metrics = LimaSearchPanel.metrics(window);
  press("Escape");
  const closed = document.getElementById("lima-search-scrim")?.hidden === true && document.activeElement !== input;
  const footer = document.getElementById("lima-search-foot")?.textContent ?? "";
  const rightEdge = [...document.querySelectorAll("[id^='lima-']")].filter(node => {
    if (node.closest("#lima-search-scrim")) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left > window.innerWidth * 0.6;
  }).map(node => node.id);
  const checks = {
    commandsOnce: uuidRuns === 1 && rendered && stored?.status === "completed" && stored.result?.text === ran.text && directRuns === 2 && recorded
      || { uuidRuns, rendered, status: stored?.status, directRuns, recorded },
    search: (question[0] === "web" && question[1] === "ask" && question.length <= 9 && aria && moved && back &&
      url === "nav:https://example.com" && plain[0] === "web" && !plain.some(key => ["ask", "delegate"].includes(key)) &&
      kept && closed && /AI Chat/.test(footer) && !document.querySelector("#lima-search button:not(.lima-s-chip-remove, .lima-s-button, #lima-search-where, .lima-s-scope, .lima-s-close)"))
      || { question, aria, moved, back, url, plain, kept, closed, footer },
    searchSpeed: metrics.open < 100 || metrics,
    // macOS light/dark comes from the runtime; windows carry the resolved
    // theme and switch with the setting.
    appearance: await (async () => {
      const { LimaAppearance } = ChromeUtils.importESModule("resource://lima/LimaAppearance.sys.mjs");
      const root = Services.wm.getMostRecentWindow("navigator:browser")?.document.documentElement;
      if (typeof (await LimaBridge.request("system.appearance"))?.dark !== "boolean") return "no runtime appearance";
      if (root?.getAttribute("lima-theme") !== LimaAppearance.theme()) return `window ${root?.getAttribute("lima-theme")}`;
      const before = Services.prefs.getStringPref("lima.theme", "system");
      Services.prefs.setStringPref("lima.theme", "dark");
      const dark = root.getAttribute("lima-theme");
      Services.prefs.setStringPref("lima.theme", "light");
      const light = root.getAttribute("lima-theme");
      Services.prefs.setStringPref("lima.theme", before);
      return (dark === "dark" && light === "light") || { dark, light };
    })(),
    // Lima's graphite tab icons (Terminal, Notes…) turn light in the dark
    // theme, whether set on a sleeping tab or as a loaded page's favicon.
    darkTabIcons: await (async () => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const before = Services.prefs.getStringPref("lima.theme", "system");
      Services.prefs.setStringPref("lima.theme", "dark");
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      const sleeping = win.gBrowser.addTab("about:lima?note=smoke", { triggeringPrincipal: principal, inBackground: true, createLazyBrowser: true });
      win.gBrowser.setIcon(sleeping, "resource://lima-ui/icons/note.svg");
      const loaded = win.gBrowser.addTab("about:lima?view=notes", { triggeringPrincipal: principal, inBackground: true });
      for (let i = 0; i < 50 && !loaded.getAttribute("image"); i++) await new Promise(resolve => win.setTimeout(resolve, 100));
      const filter = tab => win.getComputedStyle(tab.querySelector(".tab-icon-image")).filter;
      const result = { sleeping: filter(sleeping), loaded: filter(loaded), image: loaded.getAttribute("image") };
      win.gBrowser.removeTab(sleeping);
      win.gBrowser.removeTab(loaded);
      Services.prefs.setStringPref("lima.theme", before);
      return (/invert/.test(result.sleeping) && /invert/.test(result.loaded)) || result;
    })(),
    // Downloads live in the sidebar rail; Zen's animation and Firefox's panel are off.
    downloadsRail: (() => {
      const button = document.getElementById("lima-downloads");
      const animation = Services.prefs.getBoolPref("zen.downloads.download-animation", true);
      const panel = Services.prefs.getBoolPref("browser.download.alwaysOpenPanel", true);
      return (!!button && !animation && !panel) || { button: !!button, animation, panel };
    })(),
    // Search results without AI answers or ads; Lima Search stands in for the address bar.
    searchCleanup: (() => {
      const { engineFor, stylesheet, safeToHide } = ChromeUtils.importESModule("resource://lima/actors/LimaSearchCleanChild.sys.mjs");
      const css = stylesheet("google", { ai: true, ads: true });
      // A filter must never hide the results themselves.
      const page = new DOMParser().parseFromString(`<body><div id="rcnt"><div id="center_col">
        <div id="ai"><h2>AI Overview</h2><a href="/x"><h3>One source</h3></a></div>
        <div id="rso"><div id="wrap"><a href="/a"><h3>A</h3></a><a href="/b"><h3>B</h3></a></div></div></div></div></body>`, "text/html");
      const guarded = safeToHide(page.getElementById("ai")) && !safeToHide(page.getElementById("center_col"))
        && !safeToHide(page.getElementById("rcnt")) && !safeToHide(page.getElementById("wrap")) && !safeToHide(page.body);
      return (engineFor("https://www.google.com/search?q=x") === "google" && engineFor("https://example.com/search") === null &&
        css.includes("#tads") && css.includes(":not(:has(#rso") && guarded) || { css, guarded };
    })(),
    addressBar: window.limaAddressBar === true || "not installed",
    shortsHidden: (() => {
      const { engineFor, shortsWatchURL, stylesheet } = ChromeUtils.importESModule("resource://lima/actors/LimaSearchCleanChild.sys.mjs");
      return (engineFor("https://www.youtube.com/") === "youtube" && shortsWatchURL("https://www.youtube.com/shorts/abcDEF12345") === "https://www.youtube.com/watch?v=abcDEF12345"
        && stylesheet("youtube", { shorts: true }).includes("ytd-reel-shelf-renderer") && stylesheet("youtube", { shorts: false }) === "") || "shorts rules";
    })(),
    usageOffByDefault: await (async () => {
      const state = await LimaBridge.request("usage.get");
      return (state.enabled === false) || state;
    })(),
    terminalGone: !(await LimaBridge.request("host.hello")).methods.some(method => method.startsWith("terminal.") || method === "workspace.run")
      || "terminal methods still registered",
    // Zen's own site never opens in Lima.
    zenBlocked: await (async () => {
      const { isBlockedURL } = ChromeUtils.importESModule("resource://lima/LimaBlockedSites.sys.mjs");
      const matches = isBlockedURL("https://zen-browser.app/welcome/") && isBlockedURL("https://docs.zen-browser.app/") &&
        !isBlockedURL("https://example.com/") && !isBlockedURL("https://notzen-browser.app/");
      if (!matches) return "matching";
      // A tab opened just for a Zen page closes instead of loading it.
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const tab = win.gBrowser.addTab("https://zen-browser.app/welcome/", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
      for (let i = 0; i < 40 && tab.isConnected; i++) await new Promise(resolve => win.setTimeout(resolve, 100));
      const spec = tab.isConnected ? tab.linkedBrowser.currentURI.spec : "closed";
      if (tab.isConnected) win.gBrowser.removeTab(tab);
      return spec === "closed" || { spec };
    })(),
    dockFrames: (await Promise.all(["dock-light-0", "dock-light-11", "dock-dark-0", "dock-dark-done"].map(name =>
      fetch(`resource://lima-ui/marks/${name}.png`).then(response => response.ok, () => false)))).every(Boolean),
    // First launch: the walkthrough has the window and the sidebar waits to the left.
    welcomeSidebar: (() => {
      const intro = [...gBrowser.tabs].some(tab => tab.linkedBrowser?.currentURI?.spec === "about:lima?view=welcome");
      const tucked = Services.prefs.getBoolPref("lima.welcome.sidebarTucked", false);
      return !intro || (tucked && window.gZenCompactModeManager?.preference === true && !Services.prefs.getBoolPref("zen.tabs.vertical.right-side"))
        || { intro, tucked, compact: window.gZenCompactModeManager?.preference };
    })(),
    pageActions: ["lima-tabctx-add", "lima-tabctx-ask", "lima-tabctx-send", "lima-page-summarize", "lima-page-save", "lima-page-ask",
      "lima-folder-reveal", "lima-folder-rename"].every(id => document.getElementById(id)),
    rightEdgeClear: rightEdge.length ? rightEdge.join(",") : true,
    orchestrator: Array.isArray(tasks),
    limaUpdaterOnly: (/Lima|updates are off/.test(aboutText) && !/organization|Zen/.test(aboutText) && !firefoxUpdates.length && !!prefsDoc)
      || { aboutText, firefoxUpdates },
    branding: Services.appinfo.name === "Lima" && Services.appinfo.vendor === "Lima",
    profileIdentity: !compiled || (AppConstants.MOZ_APP_NAME === "lima" && AppConstants.MOZ_MACBUNDLE_ID === "dev.lima.browser"),
    noZenServices: !Services.prefs.getStringPref("zen.share.base-url", "") && !/zen-browser\\.app/.test(Services.prefs.getStringPref("zen.injections.match-urls", "")),
    brandStrings: (await new Localization(["branding/brand.ftl", "browser/aboutDialog.ftl"]).formatValue("update-noUpdatesFound")) === "Lima is up to date",
    noZenStrings: !/\bZen\b/.test(await new Localization(["browser/zen-general.ftl"]).formatValue("zen-window-sync-migration-dialog-message")),
    noAutoConfig: !compiled || !Services.prefs.getStringPref("general.config.filename", ""),
    noZenWelcome: Services.prefs.prefIsLocked("zen.welcome-screen.always-show") &&
      !Services.prefs.getBoolPref("zen.welcome-screen.always-show") &&
      Services.prefs.prefIsLocked("browser.shell.checkDefaultBrowser") &&
      !Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser"),
    companion: !!document.getElementById("lima-assistant-toggle"),
    runtime: typeof hello.hostVersion === "string" && hello.pid > 1,
    note: persisted.markdown === "Verified"
  };
  await LimaBridge.request("host.shutdown");
  return checks;
})().then(done, error => done({error: String(error)}));
"""


def check_bundle(app):
    """The packaged bundle carries no Zen executable, helper or identifier."""
    import plistlib
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    problems = []
    if info.get("CFBundleIdentifier") != "dev.lima.browser" or info.get("CFBundleExecutable") != "lima":
        problems.append("Info.plist identity")
    for path in app.rglob("*"):
        if "zen" in path.name.lower() and path.suffix in ("", ".app", ".dylib"):
            problems.append(str(path.relative_to(app)))
    if problems:
        raise RuntimeError("Zen identity remains in the bundle: " + ", ".join(problems[:20]))
    # Agents' build output (SwiftPM manifests, test binaries) must not be
    # quarantined, or Gatekeeper refuses to run it.
    if info.get("LSFileQuarantineEnabled"):
        raise RuntimeError("Info.plist still quarantines every file Lima and its agents write (LSFileQuarantineEnabled)")


def main(app):
    compiled = not (app / "Contents/MacOS/zen").exists()
    if compiled:
        check_bundle(app)
    with tempfile.TemporaryDirectory(prefix="lima-source-qa-", dir="/tmp") as temp:
        root = Path(temp)
        profile = root / "profile"
        profile.mkdir()
        key = root / "key"
        key.write_bytes(os.urandom(32))
        key.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (profile / "user.js").write_text(f'user_pref("marionette.port", {port});\n')
        environment = dict(os.environ, MOZ_HEADLESS="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1",
                           LIMA_DATA_DIR=str(root / "runtime"), LIMA_KEY_FILE=str(key),
                           LIMA_WORKSPACES_ROOT=str(root / "workspaces"))
        with (root / "browser.log").open("w+b") as log:
            process = subprocess.Popen([app / "Contents/MacOS/lima", "-profile", profile, "-no-remote",
                                        "-headless", "--marionette"], env=environment, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError("Lima exited before the smoke test")
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                        break
                    except OSError:
                        time.sleep(.25)
                else:
                    raise RuntimeError("Marionette did not start")
                with connection:
                    connection.settimeout(45)
                    result = chrome(connection, CHECK.replace("COMPILED", "true" if compiled else "false"))
                print(json.dumps(result, indent=2))
                if not result or not all(value is True for value in result.values()):
                    raise RuntimeError("Compiled browser smoke check failed")
            except Exception:
                log.seek(0)
                sys.stderr.write(log.read().decode(errors="replace")[-8000:])
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
