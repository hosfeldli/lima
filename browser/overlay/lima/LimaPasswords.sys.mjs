/* Apple Passwords: the passwords and passkeys saved on this Mac (iCloud
 * Keychain) fill in Lima through Apple's own iCloud Passwords add-on.
 * macOS registers its Passwords helper for Firefox-family browsers in
 * /Library/Application Support/Mozilla/NativeMessagingHosts, so the add-on
 * talks to it directly; nothing passes through Lima.
 *
 * Lima installs the add-on once, on first launch where the helper exists
 * (`lima.applePasswords.offered`). If you turn it off, it stays off. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

const ID = "password-manager-firefox-extension@apple.com";
const XPI = "https://addons.mozilla.org/firefox/downloads/latest/icloud-passwords/latest.xpi";
const HELPER = "/Library/Application Support/Mozilla/NativeMessagingHosts/com.apple.passwordmanager.json";
const OFFERED = "lima.applePasswords.offered";
const log = message => Services.console.logStringMessage(`[lima] passwords: ${message}`);

let installing = null;

export const LimaPasswords = {
  async status() {
    const available = await IOUtils.exists(HELPER);
    const addon = await lazy.AddonManager.getAddonByID(ID);
    return { available, installed: !!addon, enabled: !!addon?.isActive };
  },

  async enable() {
    if (!(await IOUtils.exists(HELPER))) throw new Error("This Mac's Passwords helper wasn't found. Apple Passwords needs macOS 14 or later.");
    const existing = await lazy.AddonManager.getAddonByID(ID);
    if (existing) { if (!existing.isActive) await existing.enable(); return this.status(); }
    installing ??= (async () => {
      const install = await lazy.AddonManager.getInstallForURL(XPI, { telemetryInfo: { source: "about:lima" } });
      const addon = await new Promise((resolve, reject) => {
        install.addListener({
          onInstallEnded: (_install, result) => resolve(result),
          onDownloadFailed: () => reject(new Error("Lima couldn't download Apple's add-on. Check your connection and try again.")),
          onInstallFailed: () => reject(new Error("Apple's add-on didn't install. Try again in a moment.")),
          onInstallCancelled: () => reject(new Error("The install was cancelled.")),
        });
        install.install();
      });
      if (addon?.id !== ID) {
        await addon?.uninstall?.();
        throw new Error("That wasn't Apple's add-on, so Lima removed it.");
      }
    })().finally(() => { installing = null; });
    await installing;
    Services.prefs.setBoolPref(OFFERED, true);
    return this.status();
  },

  async disable() {
    Services.prefs.setBoolPref(OFFERED, true);
    const addon = await lazy.AddonManager.getAddonByID(ID);
    if (addon) await addon.uninstall();
    return this.status();
  },

  /** On by default: installed once where the helper exists, then left to you. */
  async installByDefault() {
    if (Services.prefs.getBoolPref(OFFERED, false)) return;
    try {
      if (!(await IOUtils.exists(HELPER))) return;
      if (await lazy.AddonManager.getAddonByID(ID)) { Services.prefs.setBoolPref(OFFERED, true); return; }
      await this.enable();
      log("installed Apple's iCloud Passwords add-on");
    } catch (error) {
      // Offline or AMO unreachable: tried again on the next launch.
      log(`not installed yet: ${error.message}`);
    }
  },
};
