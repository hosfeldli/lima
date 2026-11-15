/* Parent half of the about:lima bridge. Requests are limited to the
 * runtime namespaces the Lima UI needs; host lifecycle is never exposed. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
});

const ALLOWED_PREFIXES = [
  "notes.", "chat.", "terminal.", "search.", "context.", "capture.", "audio.", "media.", "tools.",
  "agents.", "integrations.", "mcp.grants.", "storage.", "background.", "capabilities.", "workspace.", "agent.", "agents.", "fs.", "dictation.",
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
        const { LimaTabs } = ChromeUtils.importESModule("resource://lima/LimaTabs.sys.mjs");
        LimaTabs.openOrFocus(win, message.data.url, { background: message.data.background });
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
    switch (kind) {
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
        if (payload?.what === "workspace") LimaCreate.workspace(win);
        else if (payload?.what === "note") LimaCreate.note(win);
        else if (payload?.what === "terminal") LimaCreate.terminal(win);
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
