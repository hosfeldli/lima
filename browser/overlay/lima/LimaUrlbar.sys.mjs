/* Lima results in Zen's own address bar (Universal Search, spec v2 §3):
 * notes, chats, reports, terminal history and Lima tools appear next to
 * history and bookmarks, and every result opens as a normal tab.
 * Questions offer Quick Ask; nothing is sent to an AI unless chosen. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

const ICONS = {
  note: "resource://lima-ui/icons/note.svg",
  conversation: "resource://lima-ui/icons/chat.svg",
  report: "resource://lima-ui/icons/context.svg",
  terminal: "resource://lima-ui/icons/terminal.svg",
  context: "resource://lima-ui/icons/context.svg",
  tool: "resource://lima-ui/icons/tool.svg",
  ai: "resource://lima-ui/icons/chat.svg",
  app: "resource://lima-ui/icons/tool.svg",
};

/** Maps a runtime search action to the about:lima tab that performs it. */
export function urlForAction(action, query) {
  const p = action.payload ?? {};
  const q = encodeURIComponent;
  switch (action.type) {
    case "openNote": return `about:lima?note=${q(p.id)}`;
    case "openConversation": return `about:lima?chat=${q(p.id)}`;
    case "openReport": return `about:lima?view=context&report=${q(p.id)}`;
    case "openContext": return `about:lima?view=context`;
    case "runTool": return `about:lima?tool=${q(p.tool)}&input=${q(toolInput(query))}`;
    case "openApp": return `about:lima?tool=app.open&input=${q(p.path)}`;
    case "quickAsk": return `about:lima?ask=${q(p.prompt)}`;
    case "agentAsk": return `about:lima?chat=new&prompt=${q(p.prompt)}`;
    case "copyText": return `about:lima?tool=copy&input=${q(p.text)}`;
    default: return null;
  }
}

function toolInput(query) {
  const words = String(query ?? "").trim().split(/\s+/);
  return words.slice(1).join(" ");
}

let UrlbarProviderBase = null;
let providerInstance = null;

function makeProvider() {
  const { UrlbarProvider } = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs");
  UrlbarProviderBase = UrlbarProvider;

  return new (class LimaUrlbarProvider extends UrlbarProvider {
    get name() {
      return "Lima";
    }

    get type() {
      return lazy.UrlbarShared.PROVIDER_TYPE.PROFILE;
    }

    async isActive(queryContext) {
      return !!queryContext.trimmedSearchString && queryContext.trimmedSearchString.length >= 2 && !queryContext.isPrivate;
    }

    async startQuery(queryContext, addCallback) {
      const query = queryContext.trimmedSearchString;
      let response;
      try {
        response = await lazy.LimaBridge.request("search.query", { query, limit: 8 });
      } catch {
        return;
      }
      let added = 0;
      for (const result of response.results) {
        // The address bar already handles web search and URL navigation;
        // open tabs and apps are left to Zen and Spotlight.
        if (["web", "tab", "app"].includes(result.source)) continue;
        if (result.action.type === "agentAsk") continue;
        const url = urlForAction(result.action, query);
        if (!url) continue;
        const isAsk = result.action.type === "quickAsk";
        if (isAsk && !response.intent.looksLikeQuestion && response.intent.mode !== "quickAsk") continue;
        addCallback(this, new lazy.UrlbarResult({
          type: lazy.UrlbarShared.RESULT_TYPE.URL,
          source: lazy.UrlbarShared.RESULT_SOURCE.OTHER_LOCAL,
          suggestedIndex: isAsk ? 1 : undefined,
          payload: {
            url,
            title: result.subtitle ? `${result.title} — ${result.subtitle}` : result.title,
            icon: ICONS[result.source] ?? ICONS.tool,
          },
        }));
        if (++added >= 6) break;
      }
    }
  })();
}

export const LimaUrlbar = {
  register() {
    if (providerInstance) return true;
    try {
      const { ProvidersManager } = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
      providerInstance = makeProvider();
      ProvidersManager.getInstanceForSap("urlbar").registerProvider(providerInstance);
      return true;
    } catch (error) {
      dump(`[lima] urlbar provider unavailable: ${error}\n`);
      return false;
    }
  },
};
