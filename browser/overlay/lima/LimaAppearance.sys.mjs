import { LimaBridge } from "resource://lima/LimaBridge.sys.mjs";

/* Lima's light/dark theme. `lima.theme` is "system" (default), "light" or
 * "dark". The system appearance comes from the runtime, which reads macOS's
 * setting and broadcasts `system.appearance` when it changes (including
 * Auto); `prefers-color-scheme` in chrome can't be relied on because Lima
 * sets the chrome's color-scheme itself. Windows, Lima pages, Search and the
 * Dock badge all follow `theme()`. */

const listeners = new Set();
let dark = false;
let started = false;

let last;

function notify() {
  const current = LimaAppearance.theme();
  if (current === last) return;
  last = current;
  for (const listener of listeners) {
    try { listener(current); } catch (error) { Cu.reportError(error); }
  }
}

function set(value) {
  if (typeof value !== "boolean" || value === dark) return;
  dark = value;
  notify();
}

function refresh() {
  LimaBridge.request("system.appearance").then(result => set(result?.dark === true)).catch(() => {});
}

function start() {
  if (started) return;
  started = true;
  Services.prefs.addObserver("lima.theme", notify);
  LimaBridge.onEvent(({ event, data }) => {
    if (event === "system.appearance") set(data?.dark === true);
    if (event === "host.connected") refresh();
  });
  refresh();
}

export const LimaAppearance = {
  get dark() { start(); return dark; },

  /** Lima's theme setting resolved: "light", "dark", or the system's. */
  theme() {
    start();
    const chosen = Services.prefs.getStringPref("lima.theme", "system");
    return chosen === "light" || chosen === "dark" ? chosen : dark ? "dark" : "light";
  },

  /** Calls `listener(theme)` whenever the resolved theme changes (system
   * appearance or the `lima.theme` setting); returns an unsubscribe. */
  subscribe(listener) {
    start();
    last ??= this.theme();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
