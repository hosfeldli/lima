/* Exposes window.lima to about:lima pages only:
 *   lima.request(method, params) -> Promise
 *   lima.on(callback)            -> receives runtime events
 * Nothing else from chrome is reachable from the page. */

export class LimaChild extends JSWindowActorChild {
  #listeners = [];

  #installed = false;

  /** Installs the bridge on DOMDocElementInserted, DOMContentLoaded, or the
   * page's own LimaInit request — whichever arrives first. Any page may send
   * LimaInit; only about:lima documents get anything. */
  handleEvent() {
    if (this.#installed) return;
    const win = this.contentWindow;
    const uri = this.document?.documentURIObject;
    if (!win || !uri || uri.scheme !== "about" || uri.filePath !== "lima") return;

    this.#installed = true;
    const api = Cu.createObjectIn(win, { defineAs: "lima" });
    Cu.exportFunction(
      (method, params) =>
        new win.Promise((resolve, reject) => {
          this.sendQuery("request", { method: String(method), params: params === undefined ? null : JSON.parse(JSON.stringify(params)) })
            .then(reply => {
              if (reply.ok) resolve(Cu.cloneInto(reply.result ?? null, win));
              else reject(Cu.cloneInto({ code: reply.code ?? "error", message: reply.message ?? "Lima request failed" }, win));
            })
            .catch(error => reject(Cu.cloneInto({ code: "bridge", message: String(error) }, win)));
        }),
      api,
      { defineAs: "request" }
    );
    Cu.exportFunction(callback => { this.#listeners.push(callback); }, api, { defineAs: "on" });
    Cu.exportFunction(
      (url, options) => this.sendAsyncMessage("openTab", { url: String(url), background: !!options?.background }),
      api,
      { defineAs: "openTab" }
    );
    Cu.exportFunction(text => this.sendAsyncMessage("copy", { text: String(text) }), api, { defineAs: "copy" });
    // Re-open this tab at another about:lima URL (e.g. a session's permanent
    // URL) without adding a history entry. Only about:lima targets.
    Cu.exportFunction(url => {
      if (String(url).startsWith("about:lima")) this.sendAsyncMessage("replaceURL", { url: String(url) });
    }, api, { defineAs: "replaceURL" });
    // Promises handed to the page must be created in the page's compartment.
    Cu.exportFunction(
      (kind, payload) =>
        new win.Promise((resolve, reject) => {
          this.sendQuery("browser", { kind: String(kind), payload: JSON.parse(JSON.stringify(payload ?? null)) })
            .then(result => resolve(Cu.cloneInto(result ?? null, win)))
            .catch(error => reject(Cu.cloneInto({ code: "browser", message: String(error) }, win)));
        }),
      api,
      { defineAs: "browser" }
    );
  }

  receiveMessage(message) {
    if (message.name !== "event") return;
    const win = this.contentWindow;
    if (!win) return;
    for (const listener of this.#listeners) {
      try {
        listener(Cu.cloneInto(message.data, win));
      } catch (error) {
        Cu.reportError(error);
      }
    }
  }
}
