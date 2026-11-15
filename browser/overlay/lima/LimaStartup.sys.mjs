/* Lima chrome entry point, loaded once per process from lima.cfg. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  LimaWindow: "resource://lima/LimaWindow.sys.mjs",
});

let initialized = false;

function log(message) {
  dump(`[lima] ${message}\n`);
}

function registerBrandingOverride() {
  const aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  const manifest = Services.io.newURI("resource://lima/");
  aomStartup.registerChrome(manifest, [
    ["override", "chrome://branding/locale/brand.properties", "resource://lima/branding/brand.properties"],
  ]);
}

function registerStyles() {
  const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
  const uri = Services.io.newURI("resource://lima/lima.css");
  if (!sss.sheetRegistered(uri, sss.AUTHOR_SHEET)) sss.loadAndRegisterSheet(uri, sss.AUTHOR_SHEET);
}

function attach(win) {
  if (win.document.documentElement.getAttribute("windowtype") !== "navigator:browser") return;
  try {
    lazy.LimaWindow.attach(win);
    log("workspace rail attached");
  } catch (error) {
    log(`rail attach failed: ${error}\n${error.stack}`);
  }
}

export const LimaStartup = {
  init() {
    if (initialized) return;
    initialized = true;
    log("bootstrap loaded");

    for (const step of [registerBrandingOverride, registerStyles]) {
      try {
        step();
      } catch (error) {
        log(`${step.name} failed: ${error}`);
      }
    }

    Services.obs.addObserver(win => attach(win), "browser-delayed-startup-finished");

    // Probe the native host once at startup so failures surface early.
    Services.obs.addObserver(
      async function onFirstWindow() {
        Services.obs.removeObserver(onFirstWindow, "browser-delayed-startup-finished");
        try {
          const hello = await lazy.LimaBridge.request("host.hello");
          log(`host.hello ${JSON.stringify(hello)}`);
          const agents = await lazy.LimaBridge.request("agents.discover");
          log(`agents.discover ${JSON.stringify(agents.map(a => [a.provider, a.status, a.version ?? null]))}`);
        } catch (error) {
          log(`native host unavailable: ${error}`);
        }
      },
      "browser-delayed-startup-finished"
    );
  },
};
