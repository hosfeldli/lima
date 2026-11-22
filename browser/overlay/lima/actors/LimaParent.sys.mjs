/* Parent half of the about:lima bridge. Requests are limited to the
 * runtime namespaces the Lima UI needs; host lifecycle is never exposed. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  tabURL: "resource://lima/LimaWorkspaces.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaVisualActivity: "resource://lima/LimaVisualActivity.sys.mjs",
});

const ALLOWED_PREFIXES = [
  "notes.", "chat.", "terminal.", "search.", "context.", "capture.", "audio.", "media.", "tools.",
  "assistant.", "agents.", "integrations.", "mcp.grants.", "storage.", "background.", "capabilities.", "workspace.", "agent.", "agents.", "fs.", "dictation.", "task.", "image.", "vector.", "animation.",
];
const ALLOWED_METHODS = new Set(["quickAsk", "auth.approve", "auth.evaluate", "system.openApp", "host.hello"]);

const actors = new Set();
let unsubscribe = null;

function ensureEventPump() {
  if (unsubscribe) return;
  unsubscribe = lazy.LimaBridge.onEvent(message => {
    for (const actor of actors) {
      try {
        actor.sendAsyncMessage("event", message);
      } catch {
        actors.delete(actor);
      }
    }
  });
  lazy.LimaVisualActivity.subscribe(data => {
    for (const actor of actors) {
      const win = actor.browsingContext?.topChromeWindow;
      if (win && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        try { actor.sendAsyncMessage("event", { event: "ui.visualActivity", data }); }
        catch { actors.delete(actor); }
      }
    }
  });
}

/** Browser-side events for open about:lima pages (e.g. bookmark changes). */
export function broadcastToLimaPages(event, data = null) {
  for (const actor of actors) {
    try {
      actor.sendAsyncMessage("event", { event, data });
    } catch {
      actors.delete(actor);
    }
  }
}

export class LimaParent extends JSWindowActorParent {
  actorCreated() {
    actors.add(this);
    ensureEventPump();
  }

  didDestroy() {
    actors.delete(this);
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "request": {
        const { method, params } = message.data;
        if (!ALLOWED_PREFIXES.some(p => method.startsWith(p)) && !ALLOWED_METHODS.has(method)) {
          return { ok: false, code: "not_authorized", message: `${method} is not available to Lima pages` };
        }
        try {
          const result = await lazy.LimaBridge.request(method, params);
          return { ok: true, result };
        } catch (error) {
          return { ok: false, code: error.code ?? "error", message: error.message };
        }
      }
      case "openTab": {
        const win = this.browsingContext.topChromeWindow;
        const { url, background } = message.data;
        const { LimaWorkspaces, imageWorkspaceForURL } = ChromeUtils.importESModule("resource://lima/LimaWorkspaces.sys.mjs");
        const workspace = imageWorkspaceForURL(url);
        if (workspace) {
          await LimaWorkspaces.openImageStudio(win, workspace, { url, background });
          return null;
        }
        const { LimaTabs } = ChromeUtils.importESModule("resource://lima/LimaTabs.sys.mjs");
        LimaTabs.openOrFocus(win, url, { background });
        return null;
      }
      case "replaceURL": {
        const browser = this.browsingContext.top.embedderElement;
        if (browser && message.data.url.startsWith("about:lima")) {
          browser.loadURI(Services.io.newURI(message.data.url), {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
          });
        }
        return null;
      }
      case "copy": {
        Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(message.data.text);
        return null;
      }
      case "browser":
        return this.#browserRequest(message.data.kind, message.data.payload);
    }
    return null;
  }

  /** Browser-profile operations the UI needs (bookmark folders for notes). */
  async #browserRequest(kind, payload) {
    const win = this.browsingContext.topChromeWindow;
    const browser = this.browsingContext.top.embedderElement;
    switch (kind) {
      case "visualActivity":
        return lazy.PrivateBrowsingUtils.isWindowPrivate(win) ? null : lazy.LimaVisualActivity.snapshot;
      case "finishWelcome": {
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win) || browser?.currentURI?.spec !== "about:lima?view=welcome") return null;
        const { LimaWelcome } = ChromeUtils.importESModule("resource://lima/LimaWelcome.sys.mjs");
        await LimaWelcome.finish(win, browser);
        return null;
      }
      case "updateStatus":
      case "checkForUpdate":
      case "installUpdate": {
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
            !browser?.currentURI?.spec.startsWith("about:lima?view=integrations")) {
          throw new Error("Open Updates in Lima Settings.");
        }
        if (kind === "installUpdate") {
          const { LimaUpdates } = ChromeUtils.importESModule("resource://lima/LimaUpdates.sys.mjs");
          return LimaUpdates.restartToUpdate();
        }
        return lazy.LimaBridge.request(kind === "updateStatus" ? "update.status" : "update.check");
      }
      case "filesPrivacySettings": {
        const page = Services.io.newURI("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
        Cc["@mozilla.org/uriloader/external-protocol-service;1"]
          .getService(Ci.nsIExternalProtocolService)
          .loadURI(page, Services.scriptSecurityManager.getSystemPrincipal());
        return null;
      }
      case "accessibilitySettings": {
        const page = Services.io.newURI("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService)
          .loadURI(page, Services.scriptSecurityManager.getSystemPrincipal());
        return null;
      }
      case "personalityChanged": {
        if (["full", "subtle", "off"].includes(payload?.value)) {
          Services.prefs.setStringPref("lima.personality", payload.value);
          broadcastToLimaPages("ui.personality", payload.value);
        }
        return null;
      }
      case "browserActionOverlayChanged": {
        if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
          Services.prefs.setBoolPref("lima.browser.actionOverlay", payload?.value === true);
        }
        return null;
      }
      case "agentPreferences": {
        const providers = ["claude", "codex", "opencode"];
        return {
          provider: Services.prefs.getStringPref("lima.agent.provider", "claude"),
          models: Object.fromEntries(providers.map(provider => [provider, Services.prefs.getStringPref("lima.agent.model." + provider, "default")])),
          personality: Services.prefs.getStringPref("lima.personality", "full"),
          browserActionOverlay: Services.prefs.getBoolPref("lima.browser.actionOverlay", false),
        };
      }
      case "rememberAgent": {
        const { provider, model } = payload;
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return null;
        if (!["claude", "codex", "opencode"].includes(provider) || typeof model !== "string" || model.length > 160) return null;
        Services.prefs.setStringPref("lima.agent.provider", provider);
        Services.prefs.setStringPref("lima.agent.model." + provider, model);
        await lazy.LimaBridge.request("integrations.grammar.provider", { provider, model }).catch(() => {});
        return null;
      }
      case "googleEssentialStatus":
        return win.limaGoogleEssentialStatus ?? {};
      case "sidebarShortcuts": {
        try { return JSON.parse(Services.prefs.getStringPref("lima.sidebar.shortcuts", "{}")); } catch { return {}; }
      }
      case "saveSidebarShortcuts": {
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return null;
        const ids = ["inbox", "calendar", "spotify", "mic", "grammar"];
        const list = key => [...new Set((Array.isArray(payload?.[key]) ? payload[key] : []).filter(value => ids.includes(value)))];
        Services.prefs.setStringPref("lima.sidebar.shortcuts", JSON.stringify({ order: list("order"), hidden: list("hidden") }));
        return null;
      }
      case "assistantTabs":
      case "assistantReadTab": {
        const tabs = [];
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return kind === "assistantTabs" ? [] : null;
        for (const window of lazy.BrowserWindowTracker.orderedWindows) {
          if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) continue;
          for (const tab of window.gZenWorkspaces?.allStoredTabs ?? window.gBrowser.tabs) {
            const url = tab.hasAttribute("pending") ? lazy.tabURL(tab) : tab.linkedBrowser.currentURI?.spec;
            if (!/^https?:/.test(url ?? "")) continue;
            const id = lazy.BrowserWindowTracker.getIdForBrowser?.(tab.linkedBrowser) ?? tab.linkedBrowser.browserId;
            tabs.push({ id, title: tab.label, url, live: !!tab.linkedPanel && !tab.hasAttribute("pending"), tab });
          }
        }
        if (kind === "assistantTabs") return tabs.map(({ tab, ...reference }) => reference);
        const reference = tabs.find(tab => tab.id === payload?.id && tab.url === payload?.url);
        if (!reference) throw new Error("This tab is unavailable.");
        const tab = reference.tab;
        const owner = tab.ownerGlobal;
        if (!reference.live) {
          if (!tab.linkedPanel) owner.gBrowser.insertBrowser(tab);
          tab.linkedBrowser.loadURI(Services.io.newURI(reference.url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          for (let attempt = 0; attempt < 100; attempt++) {
            if (!tab.isConnected || (tab.linkedBrowser.browsingContext?.currentWindowGlobal?.documentURI?.spec === reference.url &&
                !tab.linkedBrowser.webProgress?.isLoadingDocument)) break;
            await new Promise(resolve => owner.setTimeout(resolve, 100));
          }
        }
        const global = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
        if (global?.documentURI?.spec !== reference.url) throw new Error("This tab navigated. Refresh the tab list.");
        const page = await global.getActor("PageExtractor").getText();
        if (global !== tab.linkedBrowser.browsingContext?.currentWindowGlobal) throw new Error("This tab navigated.");
        return String(page?.text ?? "").slice(0, 6000);
      }
      case "openAssistant":
        win.dispatchEvent(new win.CustomEvent("LimaAssistantOpen"));
        return null;
      case "assistantFolders":
      case "assistantLocalTask":
      case "assistantRevealGroup": {
        if (lazy.PrivateBrowsingUtils.isWindowPrivate(win) || !/^about:lima(?:\?view=assistant(?:&|$)|$)/.test(browser?.currentURI?.spec ?? "")) {
          throw new Error("Open the Companion in a regular Lima window.");
        }
        const tasks = ChromeUtils.importESModule("resource://lima/LimaCompanionTasks.sys.mjs");
        if (kind === "assistantFolders") return tasks.companionFolders(win);
        if (kind === "assistantRevealGroup") return tasks.revealCompanionGroup(win, payload?.id) ?? null;
        return tasks.runCompanionTask(win, payload);
      }
      case "closeAssistant":
        if (browser?.parentNode?.id === "lima-assistant-panel") win.dispatchEvent(new win.CustomEvent("LimaAssistantClose"));
        return null;
      case "assistantAttention":
        if (browser?.parentNode?.id === "lima-assistant-panel" || browser?.currentURI?.spec === "about:lima") {
          win.dispatchEvent(new win.CustomEvent("LimaAssistantAttention", { detail: payload?.pending === true }));
        }
        return null;
      case "closeTerminalTab": {
        const tab = browser && win.gBrowser.getTabForBrowser(browser);
        if (tab && browser.currentURI.spec.startsWith("about:lima?terminal=")) win.gBrowser.removeTab(tab, { animate: true });
        return null;
      }
      case "noteFolders":
        return lazy.LimaNotesBookmarks.folderTree();
      case "createNote":
        return lazy.LimaNotesBookmarks.createNote(payload);
      case "moveNote":
        return lazy.LimaNotesBookmarks.moveNote(payload.noteId, payload.folderGuid);
      case "createFolder":
        return lazy.LimaNotesBookmarks.createFolder(payload.title, payload.parentGuid);
      case "trashNote":
        return lazy.LimaNotesBookmarks.trashNote(payload.noteId);
      case "restoreNote":
        return lazy.LimaNotesBookmarks.restoreNote(payload.noteId);
      case "workspaceOf": {
        // The workspace a terminal or chat tab belongs to (for its header).
        const { LimaWorkspaces } = ChromeUtils.importESModule("resource://lima/LimaWorkspaces.sys.mjs");
        const tab = this.browsingContext.top.embedderElement && this.browsingContext.topChromeWindow.gBrowser.getTabForBrowser(this.browsingContext.top.embedderElement);
        return tab ? LimaWorkspaces.workspaceForTab(tab) : null;
      }
      case "openWorkspacePage": {
        const { LimaWorkspaces } = ChromeUtils.importESModule("resource://lima/LimaWorkspaces.sys.mjs");
        const folder = LimaWorkspaces.folderFor(payload.id, "folder", win);
        const tab = folder?.allItemsRecursive.find(item => item.localName === "tab" && lazy.tabURL(item) === payload.url);
        if (tab) win.gBrowser.selectedTab = tab;
        return !!tab;
      }
      // Embeds: the live page opens in a Zen split beside the note, where no
      // site can refuse to be framed.
      case "openBeside": {
        const win = this.browsingContext.topChromeWindow;
        const browser = this.browsingContext.top.embedderElement;
        let url;
        try { url = new URL(String(payload?.url ?? "")); } catch { throw new Error("Not a web address."); }
        const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if ((url.protocol !== "https:" && !local) || url.username || url.password) throw new Error("Only HTTPS pages and local previews open beside a note.");
        const note = browser && win.gBrowser.getTabForBrowser(browser);
        const page = win.gBrowser.addTab(url.href, { triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}), inBackground: true });
        if (note?.group?.isZenFolder) { try { note.group.addTabs([page]); } catch {} }
        const split = note && win.gZenViewSplitter?.splitTabs([note, page], "vsep", 1);
        if (!split) win.gBrowser.selectedTab = page;
        return !!split;
      }
      case "openChat": {
        const { LimaWorkspaces } = ChromeUtils.importESModule("resource://lima/LimaWorkspaces.sys.mjs");
        LimaWorkspaces.openChat(this.browsingContext.topChromeWindow, payload.id);
        return null;
      }
      case "search": {
        const { LimaSearchPanel } = ChromeUtils.importESModule("resource://lima/LimaSearchPanel.sys.mjs");
        LimaSearchPanel.open(this.browsingContext.topChromeWindow, payload?.text ?? "");
        return null;
      }
      case "create": {
        const { LimaCreate } = ChromeUtils.importESModule("resource://lima/LimaSidebar.sys.mjs");
        const win = this.browsingContext.topChromeWindow;
        // Awaited so the page that asked shows any failure in place.
        if (payload?.what === "workspace") await LimaCreate.workspace(win, { pickFolder: payload?.pickFolder === true });
        else if (payload?.what === "note") await LimaCreate.note(win);
        else if (payload?.what === "terminal") await LimaCreate.terminal(win);
        return null;
      }
      case "dictate": {
        const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
        const status = await LimaBridge.request("dictation.status");
        if (status.phase === "recording") return LimaBridge.request("dictation.stop");
        return LimaBridge.request("dictation.start", { target: payload?.noteId ?? null });
      }
      case "openTabs": {
        const win = this.browsingContext.topChromeWindow;
        return [...win.gBrowser.tabs].map((tab, index) => ({
          index, title: tab.label, url: tab.linkedBrowser.currentURI.spec, selected: tab.selected,
        }));
      }
    }
    return null;
  }
}
