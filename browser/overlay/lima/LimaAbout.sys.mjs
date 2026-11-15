/* about:lima — every Lima surface is a page in a normal Zen tab, so tabs,
 * workspaces, Essentials, split view, Glance, session restore, history and
 * bookmarks apply to notes, terminals and chats exactly as to websites.
 *
 * The page is untrusted content (not chrome): it runs in a content process
 * and reaches the runtime only through the LimaChild actor's narrow bridge.
 * It is not linkable from websites (no MAKE_LINKABLE flag). */

const CLASS_ID = Components.ID("{7d6a3c2e-4f1b-4a8e-9c2d-5b1e0a9f3d71}");
const CONTRACT = "@mozilla.org/network/protocol/about;1?what=lima";
const PAGE = "resource://lima-ui/app.html";

class LimaAboutModule {
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(Services.io.newURI(PAGE), loadInfo);
    channel.originalURI = uri;
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT |
      Ci.nsIAboutModule.ALLOW_SCRIPT |
      Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD |
      // Lima pages get their own privileged-about process, apart from websites.
      Ci.nsIAboutModule.URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS |
      Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT
    );
  }
}

const factory = {
  createInstance(iid) {
    return new LimaAboutModule().QueryInterface(iid);
  },
};

export function registerAboutLima() {
  const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  if (registrar.isCIDRegistered(CLASS_ID)) return;
  registrar.registerFactory(CLASS_ID, "about:lima", CONTRACT, factory);
}
