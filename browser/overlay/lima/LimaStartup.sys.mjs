/* Lima chrome entry point, loaded once in the parent process from lima.cfg. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaWindow: "resource://lima/LimaWindow.sys.mjs",
  LimaNotesBookmarks: "resource://lima/LimaNotesBookmarks.sys.mjs",
  LimaUrlbar: "resource://lima/LimaUrlbar.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  registerZenActions: "resource://lima/LimaWorkspaces.sys.mjs",
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
      } catch (error) {
        log(`window attach failed: ${error}\n${error.stack}`);
      }
    }, "browser-delayed-startup-finished");

    Services.obs.addObserver(async function onFirstWindow() {
      Services.obs.removeObserver(onFirstWindow, "browser-delayed-startup-finished");
      step("urlbar", () => log(`urlbar provider ${lazy.LimaUrlbar.register() ? "registered" : "not registered"}`));
      try {
        const hello = await lazy.LimaBridge.request("host.hello");
        log(`runtime ${hello.hostVersion} pid ${hello.pid}`);
        await lazy.LimaNotesBookmarks.start();
        lazy.LimaWorkspaces.start();
        lazy.registerZenActions();
      } catch (error) {
        log(`runtime unavailable: ${error.message ?? error}`);
      }
    }, "browser-delayed-startup-finished");
  },
};
