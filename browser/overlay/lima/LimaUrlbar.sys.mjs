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

const icon = name => `resource://lima-ui/icons/${name}.svg`;
const SOURCE_ICONS = { note: "note", conversation: "chat", report: "context", terminal: "terminal", context: "activity", ai: "spark" };
/** capability id → icon, from the manifest (shared with rail, palette, Home). */
let capabilityIcons = new Map();

/** Maps a runtime search action to the about:lima tab that performs it. */
export function urlForAction(action, query) {
  const p = action.payload ?? {};
  const q = encodeURIComponent;
  switch (action.type) {
    case "openNote": return `about:lima?note=${q(p.id)}`;
    case "openConversation": return `about:lima?chat=${q(p.id)}`;
    case "openReport": return `about:lima?view=context&report=${q(p.id)}`;
    case "openContext": return `about:lima?view=context`;
    case "runCapability": return `about:lima?run=${q(p.id)}${toolInput(query) ? `&input=${q(toolInput(query))}` : ""}`;
    case "quickAsk": return `about:lima?ask=${q(p.prompt)}`;
    case "agentAsk": return `about:lima?chat=new&prompt=${q(p.prompt)}`;
    case "copyText": return null;
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
            icon: icon(result.action.type === "runCapability" ? capabilityIcons.get(result.action.payload.id) ?? "bolt" : SOURCE_ICONS[result.source] ?? "search"),
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
      lazy.LimaBridge.request("capabilities.list")
        .then(manifest => { capabilityIcons = new Map(manifest.map(c => [c.id, c.icon])); })
        .catch(() => {});
      return true;
    } catch (error) {
      dump(`[lima] urlbar provider unavailable: ${error}\n`);
      return false;
    }
  },
};
