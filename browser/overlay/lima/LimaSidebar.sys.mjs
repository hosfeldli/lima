/* Lima in Zen's sidebar (docs/architecture/sidebar-workspaces.md):
 *
 *  - Creation, in Zen's bottom ＋ and on right-click (empty sidebar, a
 *    folder, a tab): New Tab · New Note · New Terminal · New AI Workspace.
 *    From a folder's menu, the new item goes into that folder.
 *  - The dock above Zen's footer: now-playing pill (4.x music bar), the
 *    dictation pill while recording/transcribing, and the mic.
 *  - A workspace folder's ✦ opens its chat; renaming a folder renames the
 *    workspace or sidebar section. */

import { googleEssentialTabs, refreshGoogleEssentials } from "resource://lima/LimaGoogleEssentials.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaSearchPanel: "resource://lima/LimaSearchPanel.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  tabURL: "resource://lima/LimaWorkspaces.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";
const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const ICON = name => `resource://lima-ui/icons/${name}.svg`;
const system = () => Services.scriptSecurityManager.getSystemPrincipal();

function log(message) {
  dump(`[lima] sidebar: ${message}\n`);
}

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function glyph(doc, name) {
  const node = el(doc, "span", { class: "lima-glyph" });
  node.style.maskImage = `url("${ICON(name)}")`;
  return node;
}

// MARK: Creating things

export const LimaCreate = {
  tab(win) {
    lazy.LimaSearchPanel.open(win);
  },

  /** Put a freshly made tab into `folder` (or leave it loose) and select it. */
  place(win, tab, folder) {
    if (folder) {
      folder.collapsed = false;
      folder.addTabs([tab]);
    }
    win.gBrowser.selectedTab = tab;
  },

  async note(win, folder = null) {
    const note = await lazy.LimaNotesBookmarks.createNote({ title: "Untitled", kind: "classic" });
    const tab = win.gBrowser.addTab(`about:lima?note=${encodeURIComponent(note.id)}`, { triggeringPrincipal: system() });
    this.place(win, tab, folder);
    return note;
  },

  async terminal(win, folder = null) {
    const workspaceId = folder?.closest?.("zen-folder[lima-workspace]")?.getAttribute("lima-workspace");
    const cwd = workspaceId ? lazy.LimaWorkspaces.workspace(workspaceId)?.directory : null;
    const info = await lazy.LimaBridge.request("terminal.create", { cols: 100, rows: 30, ...(cwd ? { cwd } : {}) });
    const tab = win.gBrowser.addTab(`about:lima?terminal=${encodeURIComponent(info.id)}`, { triggeringPrincipal: system() });
    this.place(win, tab, folder);
  },

  async workspace(win, { pickFolder = false } = {}) {
    let directory = null;
    let name = "New Workspace";
    if (pickFolder) {
      directory = await pick(win);
      if (!directory) return;
      name = directory.split("/").filter(Boolean).pop() ?? name;
    }
    let workspace;
    try {
      const provider = Services.prefs.getStringPref("lima.agent.provider", "claude");
      const model = Services.prefs.getStringPref("lima.agent.model." + provider, "default");
      workspace = await lazy.LimaBridge.request("workspace.create", { name, directory, provider, model });
    } catch (error) {
      win.alert?.(`Couldn't create the workspace: ${error.message}`);
      return;
    }
    // The reconciler builds the folder from the workspace.created event.
    for (let i = 0; i < 40; i++) {
      const folder = lazy.LimaWorkspaces.folderFor(workspace.id, "folder", win);
      if (folder) {
        lazy.LimaWorkspaces.openChat(win, workspace.id);
        return;
      }
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
  },
};

function pick(win) {
  return new Promise(resolve => {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(win.browsingContext, "Choose a folder for the AI workspace", Ci.nsIFilePicker.modeGetFolder);
    picker.open(result => resolve(result === Ci.nsIFilePicker.returnOK ? picker.file.path : null));
  });
}

// MARK: Menus

/** The folder a context menu was opened on (or the folder of the tab). */
function contextFolder(win, popup) {
  const node = popup.triggerNode;
  const folder = node?.closest?.("zen-folder");
  if (folder) return folder;
  const tab = win.TabContextMenu?.contextTab;
  return tab?.group?.isZenFolder ? tab.group : null;
}

function installMenus(win) {
  const doc = win.document;
  const item = (id, label, iconName, command) => {
    const node = doc.createElementNS(XUL, "menuitem");
    node.id = id;
    node.setAttribute("label", label);
    node.setAttribute("image", ICON(iconName));
    node.classList.add("menuitem-iconic", "lima-menuitem");
    node.addEventListener("command", () => Promise.resolve().then(command).catch(error => log(`${label}: ${error}`)));
    return node;
  };
  const separator = id => Object.assign(doc.createElementNS(XUL, "menuseparator"), { id });

  // Zen's bottom ＋.
  const create = doc.getElementById("zenCreateNewPopup");
  if (create && !doc.getElementById("lima-create-note")) {
    create.prepend(
      item("lima-create-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      item("lima-create-workspace-folder", "New AI Workspace from Folder…", "folder", () => LimaCreate.workspace(win, { pickFolder: true })),
      item("lima-create-note", "New Note", "note", () => LimaCreate.note(win)),
      item("lima-create-terminal", "New Terminal", "terminal", () => LimaCreate.terminal(win)),
      separator("lima-create-sep"));
  }

  // Right-click on the sidebar's empty area.
  const toolbar = doc.getElementById("toolbar-context-menu");
  if (toolbar && !doc.getElementById("lima-ctx-note")) {
    const anchor = doc.getElementById("toolbar-context-openANewTab");
    const items = [
      item("lima-ctx-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      item("lima-ctx-note", "New Note", "note", () => LimaCreate.note(win)),
      item("lima-ctx-terminal", "New Terminal", "terminal", () => LimaCreate.terminal(win)),
    ];
    if (anchor) anchor.after(...items); else toolbar.prepend(...items, separator("lima-ctx-sep"));
  }

  // Right-click on a folder: create inside it; workspace and agent actions.
  const folderMenu = doc.getElementById("zenFolderActions");
  if (folderMenu && !doc.getElementById("lima-folder-note")) {
    let target = null;
    const inFolder = (id, label, iconName, fn) => item(id, label, iconName, () => fn(target));
    const own = [
      inFolder("lima-folder-chat", "Open Chat", "star", f => lazy.LimaWorkspaces.openChat(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-tab", "New Tab Here", "tab", f => { const tab = win.gBrowser.addTab("about:blank", { triggeringPrincipal: system() }); LimaCreate.place(win, tab, f); lazy.LimaSearchPanel.open(win); }),
      inFolder("lima-folder-note", "New Note Here", "note", f => LimaCreate.note(win, f)),
      inFolder("lima-folder-terminal", "New Terminal Here", "terminal", f => LimaCreate.terminal(win, f)),
      inFolder("lima-folder-dismiss", "Dismiss Agent", "close", f => lazy.LimaWorkspaces.archive(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-remove", "Archive Workspace…", "trash", f => lazy.LimaWorkspaces.archive(win, f.getAttribute("lima-workspace"))),
      separator("lima-folder-sep"),
    ];
    folderMenu.prepend(...own);
    folderMenu.addEventListener("popupshowing", event => {
      if (event.target !== folderMenu) return;
      target = contextFolder(win, folderMenu);
      const workspace = target?.hasAttribute("lima-workspace");
      const agent = target?.hasAttribute("lima-agent");
      doc.getElementById("lima-folder-chat").hidden = !workspace;
      doc.getElementById("lima-folder-tab").hidden = !target;
      doc.getElementById("lima-folder-terminal").hidden = !target;
      doc.getElementById("lima-folder-note").hidden = !target;
      doc.getElementById("lima-folder-dismiss").hidden = !agent;
      doc.getElementById("lima-folder-remove").hidden = !workspace || agent;
      const deleteItem = doc.getElementById("context_zenFolderDelete");
      if (deleteItem) deleteItem.hidden = !!workspace;
    });
  }

  // Right-click on a tab: create next to it (in its folder).
  const tabMenu = doc.getElementById("tabContextMenu");
  if (tabMenu && !doc.getElementById("lima-tabctx-note")) {
    const folderOfTab = () => win.TabContextMenu?.contextTab?.group?.isZenFolder ? win.TabContextMenu.contextTab.group : null;
    tabMenu.prepend(
      item("lima-tabctx-note", "New Note", "note", () => LimaCreate.note(win, folderOfTab())),
      item("lima-tabctx-terminal", "New Terminal", "terminal", () => LimaCreate.terminal(win, folderOfTab())),
      item("lima-tabctx-workspace", "New AI Workspace", "star", () => LimaCreate.workspace(win)),
      separator("lima-tabctx-sep"));
  }
}

// MARK: Dock: music + dictation

function attachDock(win) {
  const doc = win.document;
  const title = el(doc, "span", { class: "lima-music-title" });
  const artist = el(doc, "span", { class: "lima-music-artist" });
  const control = (action, parameters = () => ({})) => async event => {
    event.stopPropagation();
    if (controlBusy) return;
    controlBusy = true;
    music.dataset.gesture = action === "next" || action === "previous" ? "skip" : action === "playpause" ? "tap" : "cue";
    try {
      await lazy.LimaBridge.request("media.control", { action, player: "Spotify", ...parameters() });
      await refresh(true);
      win.setTimeout(() => { if (music.hasAttribute("data-open")) refresh(true); }, 850);
    } catch (error) { flash(error.message); }
    finally {
      controlBusy = false;
      win.clearTimeout(gestureTimer);
      gestureTimer = win.setTimeout(() => { delete music.dataset.gesture; }, 620);
    }
  };
  const progress = el(doc, "input", { class: "lima-music-progress", type: "range", min: "0", max: "0", step: "0.25", "aria-label": "Track position" });
  const volume = el(doc, "input", { type: "range", min: "0", max: "100", "aria-label": "Audio volume" });
  const outputs = el(doc, "div", { class: "lima-audio-outputs", hidden: true, "aria-label": "Audio outputs" });
  const output = el(doc, "button", { class: "lima-music-btn", title: "Choose audio output", "aria-label": "Choose audio output", "aria-expanded": "false", onclick: toggleOutputs }, glyph(doc, "volume"));
  const elapsedTime = el(doc, "span", { class: "lima-music-time" });
  const durationTime = el(doc, "span", { class: "lima-music-time" });
  const timeline = el(doc, "div", { class: "lima-music-timeline" }, elapsedTime, progress, durationTime);
  const djMascot = el(doc, "img", { class: "lima-dj-mascot", src: "resource://lima-ui/marks/companion.svg#dj", alt: "" });
  const djScene = el(doc, "span", { class: "lima-dj-scene", "aria-hidden": "true" }, djMascot,
    el(doc, "i", { class: "lima-dj-record" }));
  const expanded = el(doc, "div", { class: "lima-music-expanded" }, timeline,
    el(doc, "div", { class: "lima-music-transport" },
      el(doc, "button", { class: "lima-music-btn", title: "Previous", onclick: control("previous") }, glyph(doc, "previous")),
      el(doc, "button", { class: "lima-music-btn big", title: "Play / pause", onclick: control("playpause") }, glyph(doc, "play")),
      el(doc, "button", { class: "lima-music-btn", title: "Next", onclick: control("next") }, glyph(doc, "next")),
      el(doc, "button", { class: "lima-music-dj", title: "Play Spotify DJ", "aria-label": "Play Spotify DJ", onclick: control("dj") },
        el(doc, "img", { src: "resource://lima-ui/marks/spotify-dj.svg", alt: "" }))),
    el(doc, "div", { class: "lima-music-audio" }, volume, output), outputs);
  expanded.inert = true;
  const playerHeader = el(doc, "button", { class: "lima-music-row", title: "Expand music controls", "aria-expanded": "false", onclick: toggleSpotify },
    djScene, el(doc, "span", { class: "lima-music-text" }, title, artist),
    el(doc, "span", { class: "lima-music-notes", "aria-hidden": "true" }, el(doc, "i", {}, "♪"), el(doc, "i", {}, "♫")));
  const music = el(doc, "div", { id: "lima-music", hidden: true, "aria-label": "Spotify playback" },
    playerHeader, el(doc, "div", { class: "lima-music-reveal" }, expanded));
  const spotify = el(doc, "button", { id: "lima-spotify", title: "Spotify", "aria-label": "Spotify", "aria-expanded": "false", onclick: toggleSpotify },
    el(doc, "span", { class: "lima-spotify-icon" }));

  const level = el(doc, "div", { class: "lima-dict-level" }, ...Array.from({ length: 5 }, () => el(doc, "i")));
  const dictLabel = el(doc, "span", { class: "lima-dict-label" });
  const dictation = el(doc, "div", { id: "lima-dictation", hidden: true },
    el(doc, "span", { class: "lima-dict-dot" }), level, dictLabel,
    el(doc, "button", { class: "lima-music-btn", title: "Stop and transcribe (⌃⌥D)", onclick: () => toggleDictation(win) }, glyph(doc, "stop")),
    el(doc, "button", { class: "lima-music-btn", title: "Cancel", onclick: () => lazy.LimaBridge.request("dictation.cancel").catch(() => {}) }, glyph(doc, "close")));
  const mic = el(doc, "button", { id: "lima-mic", title: "Dictate (⌃⌥D)", "aria-label": "Dictate", onclick: () => toggleDictation(win) }, glyph(doc, "mic"));
  const rail = el(doc, "div", { class: "lima-dock-rail", role: "toolbar", "aria-label": "Sidebar shortcuts" });

  const dock = el(doc, "div", { id: "lima-dock" }, el(doc, "div", { id: "lima-dock-main" }, music, dictation));

  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (foot?.parentNode) {
    foot.before(dock);
    const plus = doc.getElementById("zen-create-new-button");
    if (plus?.parentElement === foot) plus.after(rail);
    else foot.append(rail);
  } else {
    dock.append(rail);
    (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(dock);
  }

  // Now playing.
  let track = null;
  let flashTimer = null;
  let controlBusy = false;
  let gestureTimer = null;
  let revision = 0;
  let musicVisible = true;
  let scrubbing = false;
  const personality = () => music.dataset.personality = Services.prefs.getStringPref("lima.personality", "full");
  personality();
  Services.prefs.addObserver("lima.personality", personality);
  win.addEventListener("unload", () => Services.prefs.removeObserver("lima.personality", personality), { once: true });
  const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function flash(text) {
    artist.textContent = text;
    win.clearTimeout(flashTimer);
    flashTimer = win.setTimeout(() => paintTrack(), 1600);
  }
  function paintTrack() {
    const open = music.hasAttribute("data-open");
    music.hidden = !musicVisible;
    expanded.inert = !open;
    playerHeader.setAttribute("aria-expanded", String(open));
    spotify.setAttribute("aria-expanded", String(open));
    title.textContent = track?.title || "Spotify";
    artist.textContent = track?.title ? track.artist : "Spotify is idle";
    const icon = track?.state === "Playing" ? "pause" : "play";
    for (const node of music.querySelectorAll('.lima-glyph[data-role="pp"], .lima-music-btn[title="Play / pause"] .lima-glyph')) node.style.maskImage = `url("${ICON(icon)}")`;
    music.toggleAttribute("data-playing", track?.state === "Playing");
    if (track?.positionMs != null && music.dataset.personality === "full") {
      const elapsed = track.state === "Playing" ? Math.max(0, Date.now() - track.updatedAt) : 0;
      const position = track.positionMs + elapsed;
      for (const animation of playerHeader.getAnimations({ subtree: true })) {
        if (!["dj-groove", "dj-spin", "lima-note-lift"].includes(animation.animationName)) continue;
        if (animation.currentTime == null || Math.abs(animation.currentTime - position) > 160) animation.currentTime = position;
      }
    }
    tick();
  }
  function tick() {
    progress.disabled = !track?.durationMs || track.positionMs == null;
    timeline.hidden = progress.disabled;
    if (progress.disabled || scrubbing) return;
    const elapsed = track.state === "Playing" ? Date.now() - track.updatedAt : 0;
    const position = Math.min(track.durationMs, track.positionMs + elapsed);
    progress.max = track.durationMs / 1000;
    progress.value = position / 1000;
    elapsedTime.textContent = fmt(position);
    durationTime.textContent = fmt(track.durationMs);
  }
  let inactivity, ticker;
  function closeOutputs() {
    outputs.hidden = true;
    output.setAttribute("aria-expanded", "false");
  }
  function keepMusicOpen() {
    win.clearTimeout(inactivity);
    if (!music.hasAttribute("data-open")) return;
    inactivity = win.setTimeout(() => {
      if (scrubbing || !outputs.hidden || controlBusy) { keepMusicOpen(); return; }
      toggleSpotify();
    }, 8500);
  }
  for (const event of ["pointerdown", "keydown", "focusin"]) music.addEventListener(event, keepMusicOpen);
  async function toggleOutputs() {
    if (!outputs.hidden) { closeOutputs(); keepMusicOpen(); return; }
    outputs.hidden = false;
    output.setAttribute("aria-expanded", "true");
    outputs.textContent = "Loading audio outputs…";
    try {
      const devices = await lazy.LimaBridge.request("audio.outputs");
      outputs.replaceChildren(...devices.map(device => el(doc, "button", {
        text: device.name, "aria-pressed": String(device.isDefault), onclick: async () => {
          try {
            await lazy.LimaBridge.request("audio.setOutput", { id: device.id });
            output.title = device.name;
            closeOutputs();
            output.focus();
          } catch (error) { flash(error.message); }
          keepMusicOpen();
        },
      })));
      if (!devices.length) outputs.textContent = "No audio outputs available.";
    } catch (error) { outputs.textContent = error.message; }
  }
  music.addEventListener("keydown", event => {
    if (event.key === "Escape" && !outputs.hidden) { closeOutputs(); output.focus(); }
  });
  win.addEventListener("unload", () => { win.clearInterval(ticker); win.clearTimeout(inactivity); }, { once: true });
  const refresh = (update = false) => {
    const request = ++revision;
    return lazy.LimaBridge.request("media.nowPlaying", { player: "Spotify", refresh: update }).then(item => {
      if (request === revision) { track = item; paintTrack(); }
    }).catch(error => { if (update) flash(error.message); });
  };
  function toggleSpotify() {
    music.toggleAttribute("data-open");
    paintTrack();
    win.clearInterval(ticker);
    if (music.hasAttribute("data-open")) {
      refresh(true);
      ticker = win.setInterval(() => { if (!music.hidden && !doc.hidden) tick(); }, 1000);
      lazy.LimaBridge.request("audio.volume").then(value => { volume.value = Math.round((value ?? 0) * 100); }).catch(() => {});
    } else closeOutputs();
    keepMusicOpen();
  }
  progress.addEventListener("input", () => { scrubbing = true; elapsedTime.textContent = fmt(Number(progress.value) * 1000); });
  progress.addEventListener("change", event => {
    const seconds = Number(progress.value);
    control("seek", () => ({ seconds }))(event).finally(() => { scrubbing = false; tick(); });
  });
  progress.addEventListener("blur", () => { scrubbing = false; });
  volume.addEventListener("change", () => lazy.LimaBridge.request("audio.volume", { value: Number(volume.value) / 100 }).catch(error => flash(error.message)));
  // One volume control: scroll on the pill.
  let volumeBusy = false;
  music.addEventListener("wheel", async event => {
    event.preventDefault();
    if (volumeBusy) return;
    volumeBusy = true;
    try {
      const current = await lazy.LimaBridge.request("audio.volume");
      const next = Math.max(0, Math.min(1, (current ?? 0.5) + (event.deltaY < 0 ? 0.04 : -0.04)));
      await lazy.LimaBridge.request("audio.volume", { value: next });
      flash(`Volume ${Math.round(next * 100)}%`);
    } catch (error) {
      flash(error.message);
    } finally {
      volumeBusy = false;
    }
  }, { passive: false });

  // Dictation pill.
  function paintDictation(state) {
    const active = ["recording", "transcribing", "failed"].includes(state.phase);
    dictation.hidden = !active;
    music.toggleAttribute("data-covered", active);
    mic.toggleAttribute("data-recording", state.phase === "recording");
    dictation.setAttribute("data-phase", state.phase);
    if (state.phase === "recording") {
      dictLabel.textContent = fmt(state.elapsedMs);
      const bars = [...level.children];
      bars.forEach((bar, i) => { bar.style.transform = `scaleY(${Math.max(0.15, Math.min(1, state.level * (1.4 - Math.abs(i - 2) * 0.25)))})`; });
    } else if (state.phase === "transcribing") {
      dictLabel.textContent = "Transcribing…";
    } else if (state.phase === "failed") {
      dictLabel.textContent = state.error ?? "Dictation failed";
      dictation.title = state.error ?? "";
      win.setTimeout(() => { if (dictation.getAttribute("data-phase") === "failed") dictation.hidden = true; music.removeAttribute("data-covered"); }, 6000);
    }
  }

  lazy.LimaBridge.onEvent(message => {
    if (message.event === "media.nowPlaying" && message.data?.player === "Spotify") { revision++; track = message.data; paintTrack(); }
    else if (message.event === "dictation.state") paintDictation(message.data);
    else if (message.event === "dictation.result") deliverDictation(win, message.data).catch(error => showDictationError(win, error));
  });
  refresh();
  lazy.LimaBridge.request("dictation.status").then(paintDictation).catch(() => {});
  attachServices(win, dock, rail, spotify, mic, visible => {
    musicVisible = visible;
    if (!visible) music.removeAttribute("data-open");
    paintTrack();
  });
}

function attachServices(win, dock, rail, spotify, mic, hideSpotify) {
  const doc = win.document;
  const main = dock.querySelector("#lima-dock-main");
  const privateMode = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const pref = "lima.sidebar.shortcuts";
  const definitions = { inbox: "Gmail", calendar: "Google Calendar", spotify: "Spotify", mic: "Dictation", grammar: "Grammar settings" };
  const settingsURL = section => `about:lima?view=integrations&section=${section}`;
  const gmailURL = "https://mail.google.com/mail/u/0/#inbox";
  const calendarURL = "https://calendar.google.com/calendar/u/0/r";
  const launch = url => lazy.LimaTabs.openOrFocus(win, url);
  const notice = el(doc, "div", { class: "lima-services-notice", hidden: true });
  main.prepend(notice);
  let snapshot = null;
  let nativeStatus;
  let tabStatus = {};
  const keptLoaded = new Set();
  const since = Date.now();
  const seenMail = new Map();
  const pendingMail = [];
  const meetingNotices = new Map();
  let essentialBaseline = false;
  let noticeKind;
  let dismissTimer;
  let sequence = 0;
  function jump(name) {
    const service = name === "inbox" ? "mail" : "calendar";
    const essential = googleEssentialTabs(win)[service];
    if (essential) {
      win.gBrowser.selectedTab = essential.tab;
      notice.hidden = true;
    } else if (snapshot?.[service] === "connected") {
      launch(name === "inbox" ? gmailURL : calendarURL);
      notice.hidden = true;
    } else launch(settingsURL("google"));
  }
  const control = (label, icon, run) => el(doc, "button", { title: label, "aria-label": label, onclick: run }, glyph(doc, icon));
  const inbox = control("Gmail", "inbox", () => jump("inbox"));
  const calendar = control("Google Calendar", "calendar", () => jump("calendar"));
  const grammar = control("Grammar settings", "grammar", () => launch(settingsURL("grammar")));
  const buttons = { inbox, calendar, spotify, mic, grammar };
  const settings = control("Settings", "sliders", () => launch("about:lima?view=integrations"));
  settings.id = "lima-settings-button";
  (doc.getElementById("zen-sidebar-foot-buttons") ?? dock).append(settings);
  const defaultOrder = Object.keys(definitions);

  function layout() {
    let stored;
    try { stored = JSON.parse(Services.prefs.getStringPref(pref, "{}")); } catch {}
    const ordered = [...new Set((Array.isArray(stored?.order) ? stored.order : []).filter(id => Object.hasOwn(definitions, id)))];
    const hidden = new Set(Array.isArray(stored?.hidden) ? stored.hidden : ["grammar"]);
    return { order: [...ordered, ...defaultOrder.filter(id => !ordered.includes(id))], hidden };
  }

  function paintRail() {
    const { order, hidden } = layout();
    const visible = order.filter(id => !hidden.has(id) && (!privateMode || !["inbox", "calendar"].includes(id)));
    hideSpotify(visible.includes("spotify"));
    const current = doc.activeElement;
    rail.replaceChildren(...visible.map(id => buttons[id]));
    if (current?.isConnected && rail.contains(current)) current.focus();
  }

  function closeNotice() {
    notice.hidden = true;
    win.clearTimeout(dismissTimer);
  }

  function remind(kind, title, detail, action, duration, extra) {
    noticeKind = kind;
    notice.setAttribute("role", "status");
    notice.dataset.kind = kind;
    notice.replaceChildren(el(doc, "img", { src: "resource://lima-ui/marks/companion.svg", alt: "" }),
      el(doc, "div", { class: "lima-reminder-copy" }, el(doc, "strong", { text: title }),
        el(doc, "span", { class: "lima-reminder-detail", text: detail }),
        el(doc, "div", { class: "lima-reminder-actions" }, action, extra)),
      control("Dismiss reminder", "close", closeNotice));
    notice.hidden = false;
    win.clearTimeout(dismissTimer);
    dismissTimer = win.setTimeout(() => { closeNotice(); paint(); }, duration);
  }

  function meetingReminder(meeting, started) {
    const open = el(doc, "button", { onclick: () => { launch(meeting.link || calendarURL); closeNotice(); } }, "Open Calendar");
    let mic;
    if (started) mic = control("Dictate a meeting note", "mic", () => {
      win.clearTimeout(dismissTimer);
      const detail = notice.querySelector(".lima-reminder-detail");
      detail.textContent = "Dictate up to 50 seconds. Apple Speech Recognition may send audio to Apple.";
      mic.replaceWith(el(doc, "button", { onclick: () => { closeNotice(); startMeetingDictation(win, meeting.title); } },
        "Start dictation"));
      notice.querySelector(".lima-reminder-actions button:last-child")?.focus();
    });
    const minutes = Math.max(1, Math.ceil((meeting.startsAt - Date.now()) / 60000));
    remind(started ? "meeting-start" : "meeting-soon", meeting.title, started ? "Starting now" : `Starts in ${minutes} min`,
      open, started ? 45000 : 12000, mic);
  }

  function paint() {
    const result = { ...nativeStatus };
    // Essential tab metadata is local to this window. GWS fills gaps when the
    // tab layout doesn't expose a usable count or time.
    if (tabStatus.mail) Object.assign(result, { mail: "connected", unread: tabStatus.mail.unread, mailReconnect: false });
    if (tabStatus.calendar && result.calendar !== "connected") Object.assign(result, {
      calendar: "connected", meetings: tabStatus.calendar.meetings, calendarReconnect: false,
    });
    if (tabStatus.mail || tabStatus.calendar) result.enabled = true;
    snapshot = result;
    const count = result.unread ?? 0;
    inbox.toggleAttribute("lima-reconnect", result.enabled && result.mailReconnect);
    calendar.toggleAttribute("lima-reconnect", result.enabled && result.calendarReconnect);
    inbox.toggleAttribute("lima-unread", result.mail === "connected" && count > 0);
    const now = Date.now();
    const meetings = result.meetings ?? (result.meeting ? [result.meeting] : []);
    calendar.toggleAttribute("lima-upcoming", meetings.some(meeting => meeting.startsAt > now && meeting.startsAt <= now + 600000));
    inbox.title = result.mailReconnect ? "Reconnect Gmail" : count > 0 ? `Gmail · ${count} unread` : "Gmail";
    calendar.title = result.calendarReconnect ? "Reconnect Google Calendar" : "Google Calendar";
    inbox.setAttribute("aria-label", inbox.title);
    calendar.setAttribute("aria-label", calendar.title);
    if (!result.enabled) { closeNotice(); pendingMail.length = 0; essentialBaseline = false; return; }
    const nativePreviews = result.mailPreviews;
    const previews = nativePreviews ?? tabStatus.mail?.previews ?? [];
    for (const message of [...previews].reverse()) {
      const key = `${nativePreviews ? "api" : "tab"}:${message.id}`;
      if (seenMail.has(key)) continue;
      seenMail.set(key, now);
      if (nativePreviews ? message.receivedAt >= since : essentialBaseline) pendingMail.push(message);
    }
    if (tabStatus.mail?.previews?.length || tabStatus.mail?.unread === 0) essentialBaseline = true;
    if (pendingMail.length > 8) pendingMail.splice(0, pendingMail.length - 8);
    for (const [key, time] of seenMail) if (now - time > 86400000 && !previews.some(message => key.endsWith(`:${message.id}`))) seenMail.delete(key);
    for (const [key, time] of meetingNotices) if (now - time > 86400000) meetingNotices.delete(key);
    if (!(doc.hasFocus() || Services.focus.activeWindow === win)) return;
    if (result.calendar === "connected" && calendar.isConnected) {
      for (const started of [true, false]) {
        if (!notice.hidden && noticeKind === "meeting-start") break;
        const meeting = meetings.find(item => {
          const offset = item.startsAt - now;
          const key = `${item.startsAt}:${item.title}:${started}`;
          return !meetingNotices.has(key) && (started
            ? offset <= 0 && offset >= -120000 && (item.endsAt == null || item.endsAt > now)
            : offset > 0 && offset <= 600000);
        });
        if (meeting) {
          meetingNotices.set(`${meeting.startsAt}:${meeting.title}:${started}`, now);
          meetingReminder(meeting, started);
          return;
        }
      }
    }
    if (notice.hidden && result.mail === "connected" && inbox.isConnected && pendingMail.length) {
      const message = pendingMail.shift();
      const action = el(doc, "button", { onclick: () => {
        if (message.link) { launch(message.link); closeNotice(); } else jump("inbox");
      } }, message.link ? "Open email" : "Open inbox");
      remind("mail", message.subject, message.sender, action, 7000);
    }
  }

  async function refresh() {
    if (privateMode || doc.hidden) return;
    const ticket = ++sequence;
    try {
      const result = await lazy.LimaBridge.request("integrations.google.refresh");
      if (ticket === sequence && result) { nativeStatus = result; paint(); }
    } catch {}
  }
  let readingTabs = false;
  async function refreshTabs() {
    if (privateMode || doc.hidden || readingTabs) return;
    readingTabs = true;
    try {
      tabStatus = await refreshGoogleEssentials(win, keptLoaded);
      win.limaGoogleEssentialStatus = { mail: Boolean(tabStatus.mail), calendar: Boolean(tabStatus.calendar) };
      paint();
    } finally { readingTabs = false; }
  }
  const tabEvents = ["TabSelect", "TabOpen", "TabClose", "TabAttrModified", "SSTabRestored"];
  let refreshTimer;
  const scheduleTabs = () => {
    win.clearTimeout(refreshTimer);
    refreshTimer = win.setTimeout(refreshTabs, 450);
  };
  for (const event of tabEvents) win.gBrowser.tabContainer.addEventListener(event, scheduleTabs);
  doc.addEventListener("visibilitychange", scheduleTabs);
  const tabTimer = win.setInterval(refreshTabs, 5000);
  Services.prefs.addObserver(pref, paintRail);
  const off = lazy.LimaBridge.onEvent(({ event, data }) => {
    if (!privateMode && event === "integrations.google.updated" && data) { sequence++; nativeStatus = data; paint(); }
  });
  const timer = win.setInterval(refresh, 20000);
  const clock = win.setInterval(() => { if (!privateMode && !doc.hidden && snapshot?.enabled) paint(); }, 3000);
  win.addEventListener("focus", () => { paint(); refresh(); scheduleTabs(); });
  doc.addEventListener("visibilitychange", refresh);
  win.addEventListener("unload", () => {
    off();
    Services.prefs.removeObserver(pref, paintRail);
    win.clearInterval(timer);
    win.clearInterval(tabTimer);
    win.clearInterval(clock);
    win.clearTimeout(refreshTimer);
    for (const event of tabEvents) win.gBrowser.tabContainer.removeEventListener(event, scheduleTabs);
    win.clearTimeout(dismissTimer);
  }, { once: true });
  paintRail();
  refresh();
  refreshTabs();
}

// MARK: Dictation

let meetingDictationWindow;

async function startMeetingDictation(win, meeting) {
  try {
    const result = await lazy.LimaBridge.request("dictation.status");
    if (["recording", "transcribing"].includes(result.phase)) throw new Error("Finish the current dictation first.");
    meetingDictationWindow = win;
    await lazy.LimaBridge.request("dictation.start", { meeting });
  } catch (error) {
    meetingDictationWindow = null;
    showDictationError(win, error);
  }
}

function noteIdOf(tab) {
  const url = tab && lazy.tabURL(tab);
  return url?.startsWith("about:lima?note=") ? decodeURIComponent(url.slice("about:lima?note=".length).split("&")[0]) : null;
}

async function toggleDictation(win) {
  try {
    const status = await lazy.LimaBridge.request("dictation.status");
    if (status.phase === "recording") await lazy.LimaBridge.request("dictation.stop");
    else if (status.phase !== "transcribing") await lazy.LimaBridge.request("dictation.start", { target: noteIdOf(win.gBrowser.selectedTab) });
  } catch (error) {
    showDictationError(win, error);
  }
}

function showDictationError(win, error) {
  const pill = win.document.getElementById("lima-dictation");
  if (!pill) return;
  pill.hidden = false;
  pill.setAttribute("data-phase", "failed");
  pill.querySelector(".lima-dict-label").textContent = error.message;
  win.setTimeout(() => { if (pill.getAttribute("data-phase") === "failed") pill.hidden = true; }, 6000);
}

/** Text goes into the note you were in (its open page inserts it at the
 * cursor); otherwise into a new Dictation note, as in 4.x. */
async function deliverDictation(win, { text, target, meeting }) {
  if (!text) return;
  if (meeting) {
    const owner = meetingDictationWindow?.closed || !meetingDictationWindow
      ? lazy.BrowserWindowTracker.getTopWindow({ private: false }) : meetingDictationWindow;
    if (owner !== win) return;
  }
  const page = target && [...win.gBrowser.tabs].find(tab => noteIdOf(tab) === target && tab.linkedPanel && !tab.hasAttribute("pending"));
  if (page) return; // the note page handles dictation.result itself
  if (target) {
    try {
      const note = await lazy.LimaBridge.request("notes.get", { id: target });
      await lazy.LimaBridge.request("notes.apply", { id: target, author: "user",
        edits: [{ setMarkdown: { _0: `${note.markdown.replace(/\s+$/, "")}\n\n${text}\n` } }] });
      return;
    } catch {}
  }
  const stamp = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const note = await lazy.LimaNotesBookmarks.createNote({ title: meeting ? `${meeting} — Dictation` : `Dictation — ${stamp}`, kind: "classic", markdown: `${text}\n` });
  lazy.LimaTabs.openOrFocus(win, `about:lima?note=${encodeURIComponent(note.id)}`);
}

// MARK: Folder behaviour

function attachFolderBehaviour(win) {
  const doc = win.document;
  const openWorkspaceChat = event => {
    if (event.button !== 0 || event.target.closest?.(".lima-workspace-disclosure, input")) return;
    const label = event.target.closest?.(".tab-group-label-container");
    const folder = label?.parentElement;
    if (!folder?.hasAttribute("lima-workspace")) return;
    event.stopPropagation();
    if (event.type === "click") {
      event.preventDefault();
      lazy.LimaWorkspaces.openChat(win, folder.getAttribute("lima-workspace"));
    }
  };
  doc.addEventListener("click", openWorkspaceChat, true);
  win.gBrowser.tabContainer.addEventListener("TabSelect", () => lazy.LimaWorkspaces.onTabSelect(win));

  win.addEventListener("ZenFolderRenamed", event => {
    const folder = event.target;
    if (folder.hasAttribute?.("lima-workspace")) lazy.LimaWorkspaces.onFolderRenamed(folder);
  });
}

// MARK: Keys

function attachKeys(win) {
  win.addEventListener("keydown", event => {
    // ⌃⌥D: dictation (4.x default shortcut).
    if (event.ctrlKey && event.altKey && !event.metaKey && event.code === "KeyD") {
      event.preventDefault();
      event.stopPropagation();
      toggleDictation(win);
    }
  }, true);
}

export const LimaSidebar = {
  attach(win) {
    try { installMenus(win); } catch (error) { log(`menus: ${error}\n${error.stack}`); }
    try { attachDock(win); } catch (error) { log(`dock: ${error}\n${error.stack}`); }
    try { attachFolderBehaviour(win); } catch (error) { log(`folders: ${error}\n${error.stack}`); }
    try { attachKeys(win); } catch (error) { log(`keys: ${error}`); }
    try { lazy.LimaSearchPanel.install(win); } catch (error) { log(`search: ${error}`); }
  },
};
