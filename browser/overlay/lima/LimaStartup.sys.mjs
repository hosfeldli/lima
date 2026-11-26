/* Lima chrome entry point, loaded once in the parent process from lima.cfg. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, { PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs" });
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  flattenSidebar: "resource://lima/LimaSidebarLayout.sys.mjs",
  disableSpaceRouting: "resource://lima/LimaSidebarLayout.sys.mjs",
  LimaWelcome: "resource://lima/LimaWelcome.sys.mjs",
  LimaWindow: "resource://lima/LimaWindow.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaUrlbar: "resource://lima/LimaUrlbar.sys.mjs",
  LimaNotebook: "resource://lima/LimaNotebook.sys.mjs",
  LimaDockBadge: "resource://lima/LimaDockBadge.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  LimaUpdates: "resource://lima/LimaUpdates.sys.mjs",
});

let initialized = false;

function log(message) {
  dump(`[lima] ${message}\n`);
}

function step(name, fn) {
  try {
    fn();
  } catch (error) {
    log(`${name} failed: ${error}\n${error.stack ?? ""}`);
  }
}

export const LimaStartup = {
  init() {
    if (initialized) return;
    initialized = true;
    step("sidebar routing", () => lazy.disableSpaceRouting());
    step("blocked sites", () => ChromeUtils.importESModule("resource://lima/LimaBlockedSites.sys.mjs").LimaBlockedSites.start());
    step("usage", () => ChromeUtils.importESModule("resource://lima/LimaUsage.sys.mjs").LimaUsage.start());
    // Gecko builds its accessibility tree only once a client asks, so the
    // first ⌘G (or VoiceOver read) in a note or Lima page could find nothing.
    // Keeping the service on exposes Lima's pages and notes from the start.
    step("accessibility", () => {
      if (Services.prefs.getBoolPref("lima.accessibility.alwaysOn", true)) {
        LimaStartup.accessibility = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);
      }
    });
    log("bootstrap loaded");

    step("ui substitution", () => {
      // Page assets are content-accessible; chrome modules under resource://lima are not.
      const ui = Services.dirsvc.get("GreD", Ci.nsIFile);
      ui.append("lima");
      ui.append("ui");
      Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler)
        .setSubstitutionWithFlags("lima-ui", Services.io.newFileURI(ui), Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS);
    });
    step("about:lima", () => {
      ChromeUtils.importESModule("resource://lima/LimaAbout.sys.mjs").registerAboutLima();
      Services.ppmm.loadProcessScript("resource://lima/LimaContentProcess.js", true);
    });
    step("window actor", () => {
      ChromeUtils.registerWindowActor("LimaPage", {
        child: { esModuleURI: "resource://lima/actors/LimaPageChild.sys.mjs" },
        matches: ["http://*/*", "https://*/*"],
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
      // Search results without AI answers or ads, YouTube without Shorts (Settings → Browsing).
      ChromeUtils.registerWindowActor("LimaSearchClean", {
        child: {
          esModuleURI: "resource://lima/actors/LimaSearchCleanChild.sys.mjs",
          events: { DOMDocElementInserted: { capture: true }, DOMContentLoaded: {} },
        },
        matches: ["*://*.google.com/search*", "*://*.google.co.uk/search*", "*://*.google.ca/search*", "*://*.google.com.au/search*",
          "*://*.google.de/search*", "*://*.google.fr/search*", "*://*.bing.com/search*", "*://duckduckgo.com/*",
          "*://*.search.yahoo.com/search*", "*://search.brave.com/search*", "*://*.youtube.com/*", "*://youtube.com/*"],
        messageManagerGroups: ["browsers"],
        safeForUntrustedWebProcess: true,
      });
      ChromeUtils.registerWindowActor("Lima", {
        parent: { esModuleURI: "resource://lima/actors/LimaParent.sys.mjs" },
        child: {
          esModuleURI: "resource://lima/actors/LimaChild.sys.mjs",
          events: { DOMDocElementInserted: { capture: true }, DOMContentLoaded: {}, LimaInit: { wantUntrusted: true } },
        },
        // about:lima loads only in the privileged-about process (never with
        // websites). Match patterns don't reliably cover about: URLs with
        // queries, so LimaChild also checks the document URL itself.
        remoteTypes: ["privilegedabout"],
      });
    });
    step("branding", () => {
      const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
      aomStartup.registerChrome(Services.io.newURI("resource://lima/"), [
        ["override", "chrome://branding/locale/brand.properties", "resource://lima/branding/brand.properties"],
      ]);
    });
    step("styles", () => {
      const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
      const uri = Services.io.newURI("resource://lima/lima.css");
      if (!sss.sheetRegistered(uri, sss.AUTHOR_SHEET)) sss.loadAndRegisterSheet(uri, sss.AUTHOR_SHEET);
    });

    Services.obs.addObserver(win => {
      try {
        lazy.LimaWindow.attach(win);
        if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
          lazy.flattenSidebar(win)
            .catch(error => log(`Sidebar setup failed: ${error}`))
            .then(() => lazy.LimaWelcome.install(win))
            .catch(error => log(`Welcome setup failed: ${error}`));
        }
        lazy.LimaNotebook.retire(win).catch(error => log(`Notebook sidebar migration failed: ${error}`));
      } catch (error) {
        log(`window attach failed: ${error}\n${error.stack}`);
      }
    }, "browser-delayed-startup-finished");

    Services.obs.addObserver(async function onFirstWindow(win) {
      Services.obs.removeObserver(onFirstWindow, "browser-delayed-startup-finished");
      step("urlbar", () => log(`urlbar provider ${lazy.LimaUrlbar.register() ? "registered" : "not registered"}`));
      try {
        const hello = await lazy.LimaBridge.request("host.hello");
        const provider = Services.prefs.getStringPref("lima.agent.provider", "claude");
        lazy.LimaBridge.request("integrations.grammar.provider", {
          provider, model: Services.prefs.getStringPref("lima.agent.model." + provider, "default"),
        }).catch(() => {});
        log(`runtime ${hello.hostVersion} pid ${hello.pid}`);
        await lazy.LimaNotesBookmarks.start();
        lazy.LimaWorkspaces.start();
        lazy.LimaDockBadge.start(win);
        lazy.LimaUpdates.start().catch(error => log(`updates unavailable: ${error}`));
      } catch (error) {
        log(`runtime unavailable: ${error.message ?? error}`);
      }
    }, "browser-delayed-startup-finished");
  },
};
