/* Lima in Zen's sidebar (docs/architecture/sidebar-workspaces.md):
 *
 *  - Creation, in Zen's bottom ＋ and on right-click (empty sidebar, a
 *    folder, a tab): New Tab · New Note · New Terminal · New AI Workspace.
 *    From a folder's menu, the new item goes into that folder.
 *  - The dock above Zen's footer: now-playing pill (4.x music bar), the
 *    dictation pill while recording/transcribing, and the mic.
 *  - A workspace folder's ✦ opens its chat; renaming a folder renames the
 *    workspace or Notebook section. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaNotebook: "resource://lima/LimaNotebook.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaSearchPanel: "resource://lima/LimaSearchPanel.sys.mjs",
  LimaTabs: "resource://lima/LimaTabs.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
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
    const section = folder?.hasAttribute("lima-section") ? folder.getAttribute("lima-section") : null;
    const note = await lazy.LimaNotesBookmarks.createNote({ title: "Untitled", kind: "classic", folderGuid: section });
    if (!folder || lazy.LimaNotebook.isNotebookFolder(folder)) {
      if (await lazy.LimaNotebook.reveal(win, note.id)) return note;
    }
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
      workspace = await lazy.LimaBridge.request("workspace.create", { name, directory });
    } catch (error) {
      win.alert?.(`Couldn't create the workspace: ${error.message}`);
      return;
    }
    // The reconciler builds the folder from the workspace.created event.
    for (let i = 0; i < 40; i++) {
      const folder = lazy.LimaWorkspaces.folderFor(workspace.id, "folder", win);
      if (folder) {
        lazy.LimaWorkspaces.openChat(win, workspace.id);
        if (!pickFolder) win.setTimeout(() => folder.rename(), 250);
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

  // Right-click on a folder: create inside it; workspace/agent/notebook actions.
  const folderMenu = doc.getElementById("zenFolderActions");
  if (folderMenu && !doc.getElementById("lima-folder-note")) {
    let target = null;
    const inFolder = (id, label, iconName, fn) => item(id, label, iconName, () => fn(target));
    const own = [
      inFolder("lima-folder-chat", "Open Chat", "star", f => lazy.LimaWorkspaces.openChat(win, f.getAttribute("lima-workspace"))),
      inFolder("lima-folder-tab", "New Tab Here", "tab", f => { const tab = win.gBrowser.addTab("about:blank", { triggeringPrincipal: system() }); LimaCreate.place(win, tab, f); lazy.LimaSearchPanel.open(win); }),
      inFolder("lima-folder-note", "New Note Here", "note", f => LimaCreate.note(win, f)),
      inFolder("lima-folder-terminal", "New Terminal Here", "terminal", f => LimaCreate.terminal(win, f)),
      inFolder("lima-folder-section", "New Section", "folder", () => lazy.LimaNotebook.newSection(win)),
      inFolder("lima-folder-dismiss", "Dismiss Agent", "close", f => lazy.LimaBridge.request("workspace.delete", { id: f.getAttribute("lima-workspace") })),
      inFolder("lima-folder-remove", "Remove Workspace…", "trash", f => {
        const id = f.getAttribute("lima-workspace");
        const workspace = lazy.LimaWorkspaces.workspace(id);
        if (win.confirm(`Remove “${workspace?.name ?? f.label}”? Its tabs, terminal and helper agents close. The folder on disk is kept.`)) {
          lazy.LimaBridge.request("workspace.delete", { id });
        }
      }),
      separator("lima-folder-sep"),
    ];
    folderMenu.prepend(...own);
    folderMenu.addEventListener("popupshowing", event => {
      if (event.target !== folderMenu) return;
      target = contextFolder(win, folderMenu);
      const workspace = target?.hasAttribute("lima-workspace");
      const agent = target?.hasAttribute("lima-agent");
      const notebook = lazy.LimaNotebook.isNotebookFolder(target);
      doc.getElementById("lima-folder-chat").hidden = !workspace;
      doc.getElementById("lima-folder-tab").hidden = !target || notebook;
      doc.getElementById("lima-folder-terminal").hidden = !target || notebook;
      doc.getElementById("lima-folder-note").hidden = !target;
      doc.getElementById("lima-folder-section").hidden = !target?.hasAttribute("lima-notebook");
      doc.getElementById("lima-folder-dismiss").hidden = !agent;
      doc.getElementById("lima-folder-remove").hidden = !workspace || agent;
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
  const art = el(doc, "button", { class: "lima-music-art", title: "Open the player" });
  const title = el(doc, "span", { class: "lima-music-title" });
  const artist = el(doc, "span", { class: "lima-music-artist" });
  const playIcon = glyph(doc, "play");
  const control = action => event => { event.stopPropagation(); lazy.LimaBridge.request("media.control", { action }).catch(error => flash(error.message)); };
  const play = el(doc, "button", { class: "lima-music-btn", title: "Play / pause", onclick: control("playpause") }, playIcon);
  const progress = el(doc, "div", { class: "lima-music-progress" }, el(doc, "i"));
  const times = el(doc, "div", { class: "lima-music-times" }, el(doc, "span"), el(doc, "span"));
  const expanded = el(doc, "div", { class: "lima-music-expanded" }, progress, times,
    el(doc, "div", { class: "lima-music-transport" },
      el(doc, "button", { class: "lima-music-btn", title: "Previous", onclick: control("previous") }, glyph(doc, "previous")),
      el(doc, "button", { class: "lima-music-btn big", title: "Play / pause", onclick: control("playpause") }, glyph(doc, "play")),
      el(doc, "button", { class: "lima-music-btn", title: "Next", onclick: control("next") }, glyph(doc, "next")),
      el(doc, "button", { class: "lima-music-dj", title: "Spotify DJ", onclick: control("dj") }, "DJ")));
  const music = el(doc, "div", { id: "lima-music", hidden: true, title: "Scroll to change volume" },
    el(doc, "div", { class: "lima-music-row" }, art, el(doc, "div", { class: "lima-music-text" }, title, artist), play), expanded);

  const level = el(doc, "div", { class: "lima-dict-level" }, ...Array.from({ length: 5 }, () => el(doc, "i")));
  const dictLabel = el(doc, "span", { class: "lima-dict-label" });
  const dictation = el(doc, "div", { id: "lima-dictation", hidden: true },
    el(doc, "span", { class: "lima-dict-dot" }), level, dictLabel,
    el(doc, "button", { class: "lima-music-btn", title: "Stop and transcribe (⌃⌥D)", onclick: () => toggleDictation(win) }, glyph(doc, "stop")),
    el(doc, "button", { class: "lima-music-btn", title: "Cancel", onclick: () => lazy.LimaBridge.request("dictation.cancel").catch(() => {}) }, glyph(doc, "close")));
  const mic = el(doc, "button", { id: "lima-mic", title: "Dictate (⌃⌥D)", "aria-label": "Dictate", onclick: () => toggleDictation(win) }, glyph(doc, "mic"));
  const dock = el(doc, "div", { id: "lima-dock" }, el(doc, "div", { id: "lima-dock-main" }, music, dictation), mic);

  const foot = doc.getElementById("zen-sidebar-foot-buttons");
  if (foot?.parentNode) foot.parentNode.insertBefore(dock, foot);
  else (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(dock);

  // Now playing.
  let track = null;
  let flashTimer = null;
  const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function flash(text) {
    artist.textContent = text;
    win.clearTimeout(flashTimer);
    flashTimer = win.setTimeout(() => paintTrack(), 1600);
  }
  function paintTrack() {
    const visible = !!track?.title && ["Playing", "Paused"].includes(track.state);
    music.hidden = !visible;
    if (!visible) return;
    title.textContent = track.title;
    artist.textContent = [track.artist, track.player].filter(Boolean).join(" · ");
    const icon = track.state === "Playing" ? "pause" : "play";
    for (const node of music.querySelectorAll('.lima-glyph[data-role="pp"], .lima-music-btn[title="Play / pause"] .lima-glyph')) node.style.maskImage = `url("${ICON(icon)}")`;
    art.style.backgroundImage = track.artworkURL ? `url("${track.artworkURL}")` : "";
    art.toggleAttribute("data-empty", !track.artworkURL);
    music.toggleAttribute("data-playing", track.state === "Playing");
    tick();
  }
  function tick() {
    if (!track?.durationMs || track.positionMs === undefined || track.positionMs === null) { progress.hidden = times.hidden = true; return; }
    progress.hidden = times.hidden = false;
    const elapsed = track.state === "Playing" ? Date.now() - track.updatedAt : 0;
    const position = Math.min(track.durationMs, track.positionMs + elapsed);
    progress.firstChild.style.width = `${(position / track.durationMs) * 100}%`;
    times.firstChild.textContent = fmt(position);
    times.lastChild.textContent = fmt(track.durationMs);
  }
  win.setInterval(() => { if (!music.hidden && music.hasAttribute("data-open")) tick(); }, 1000);
  const refresh = () => lazy.LimaBridge.request("media.nowPlaying").then(item => { track = item; paintTrack(); }).catch(() => {});
  // Clicking the pill only expands it (it never opens the player);
  // the artwork opens the player, as in 4.x.
  music.addEventListener("click", event => {
    if (event.target.closest("button")) return;
    music.toggleAttribute("data-open");
    if (music.hasAttribute("data-open")) refresh();
  });
  art.addEventListener("click", event => {
    event.stopPropagation();
    const app = track?.player === "Spotify" ? "/Applications/Spotify.app" : "/System/Applications/Music.app";
    lazy.LimaBridge.request("system.openApp", { path: app }).catch(() => {});
  });
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
    if (message.event === "media.nowPlaying") { track = message.data; paintTrack(); }
    else if (message.event === "dictation.state") paintDictation(message.data);
    else if (message.event === "dictation.result") deliverDictation(win, message.data);
  });
  refresh();
  lazy.LimaBridge.request("dictation.status").then(paintDictation).catch(() => {});
}

// MARK: Dictation

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
    win.document.getElementById("lima-dictation")?.removeAttribute("hidden");
    const label = win.document.querySelector("#lima-dictation .lima-dict-label");
    if (label) label.textContent = error.message;
    win.document.getElementById("lima-dictation")?.setAttribute("data-phase", "failed");
    win.setTimeout(() => win.document.getElementById("lima-dictation")?.setAttribute("hidden", "true"), 6000);
  }
}

/** Text goes into the note you were in (its open page inserts it at the
 * cursor); otherwise into a new Dictation note, as in 4.x. */
async function deliverDictation(win, { text, target }) {
  if (!text) return;
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
  const note = await lazy.LimaNotesBookmarks.createNote({ title: `Dictation — ${stamp}`, kind: "classic", markdown: `${text}\n` });
  if (!(await lazy.LimaNotebook.reveal(win, note.id))) lazy.LimaTabs.openOrFocus(win, `about:lima?note=${encodeURIComponent(note.id)}`);
}

// MARK: Folder behaviour

function attachFolderBehaviour(win) {
  const doc = win.document;
  // ✦ opens the workspace chat instead of collapsing the folder.
  const onIcon = event => {
    const icon = event.target.closest?.(".tab-group-folder-icon");
    const folder = icon?.closest("zen-folder[lima-workspace]");
    if (!folder || icon.parentElement?.parentElement !== folder) return;
    event.stopPropagation();
    event.preventDefault();
    if (event.type === "click") lazy.LimaWorkspaces.openChat(win, folder.getAttribute("lima-workspace"));
  };
  for (const type of ["mousedown", "mouseup", "click"]) doc.addEventListener(type, onIcon, true);

  win.addEventListener("ZenFolderRenamed", event => {
    const folder = event.target;
    if (folder.hasAttribute?.("lima-workspace")) lazy.LimaWorkspaces.onFolderRenamed(folder);
    else if (folder.hasAttribute?.("lima-section")) lazy.LimaNotebook.onFolderRenamed(folder);
  });
  win.gBrowser.tabContainer.addEventListener("TabGrouped", event => lazy.LimaNotebook.onTabGrouped(event.target));
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
