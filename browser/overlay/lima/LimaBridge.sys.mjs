/* Lima browser bridge: the only path from trusted browser chrome to the
 * native runtime. Web content can never reach it — it lives in a system
 * module, and lima-host is a child process speaking over private pipes
 * (4-byte little-endian length + JSON, protocol v1). */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const STUDIO_RENDER_TIMEOUT_MS = 90000;
const STUDIO_RENDER_METHODS = new Set(["image.select_subject", "image.remove_background", "vector.trace",
  "animation.tween", "animation.render_preview", "animation.export", "animation.export_spritesheet"]);
const MAX_RESTARTS = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hostPath() {
  const file = Services.dirsvc.get("GreBinD", Ci.nsIFile);
  file.append("lima-host");
  return file.path;
}

/* Marionette or the remote agent can run chrome-privileged script on behalf
 * of whoever started the browser with --marionette / --remote-debugging-port.
 * Release builds refuse to hand such a session the user's runtime. */
function remoteControlled() {
  if (!Services.prefs.getBoolPref("lima.release.hardened", false)) return false;
  try { if (Services.marionette?.running) return true; } catch {}
  try {
    const agent = Cc["@mozilla.org/remote/agent;1"]?.getService(Ci.nsIRemoteAgent);
    if (agent?.running) return true;
  } catch {}
  return false;
}

class Bridge {
  #proc = null;
  #starting = null;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #restarts = 0;
  #buffer = new Uint8Array(0);
  #startupError = null;
  status = "stopped";

  async request(method, params) {
    await this.#ensureStarted();
    const id = String(this.#nextId++);
    const payload = encoder.encode(JSON.stringify({ v: PROTOCOL_VERSION, id, method, params }));
    const frame = new Uint8Array(4 + payload.length);
    new DataView(frame.buffer).setUint32(0, payload.length, true);
    frame.set(payload, 4);

    return new Promise((resolve, reject) => {
      const handle = {
        resolve,
        reject,
        timer: Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer),
      };
      handle.timer.initWithCallback(
        () => {
          this.#pending.delete(id);
          reject(new Error(`lima-host: ${method} timed out`));
        },
        ["workspace.delete", "assistant.plan", "assistant.delegate"].includes(method) ? 600000
          : STUDIO_RENDER_METHODS.has(method) ? STUDIO_RENDER_TIMEOUT_MS : method === "integrations.google.refresh" ? 30000
          // Waits while macOS asks you to let Lima use Messages.
          : method === "messages.verify" ? 130000 : REQUEST_TIMEOUT_MS,
        Ci.nsITimer.TYPE_ONE_SHOT
      );
      this.#pending.set(id, handle);
      this.#proc.stdin.write(frame).catch(error => {
        this.#pending.delete(id);
        handle.timer.cancel();
        reject(error);
      });
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #ensureStarted() {
    if (this.#proc) return;
    if (this.status === "failed") throw this.#startupError ?? new Error("Lima’s runtime exited repeatedly. Reopen Lima to retry.");
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    await this.#starting;
  }

  async #start() {
    if (remoteControlled()) {
      this.status = "failed";
      this.#startupError = new Error("Lima’s runtime is unavailable while the browser is under remote control.");
      throw this.#startupError;
    }
    this.status = "starting";
    this.#startupError = null;
    this.#proc = await lazy.Subprocess.call({
      command: hostPath(),
      arguments: ["--stdio"],
      stderr: "pipe",
    });
    this.status = "running";
    const process = this.#proc;
    const output = this.#readLoop(process).catch(error => Cu.reportError(error));
    this.#drainStderr(process);
    process.wait().then(async ({ exitCode }) => {
      await output;
      this.#onExit(exitCode);
    });
    this.#dispatch({ event: "host.connected" });
  }

  async #readLoop(proc) {
    for (;;) {
      const chunk = await proc.stdout.read();
      if (!chunk || chunk.byteLength === 0) return;
      const incoming = new Uint8Array(chunk);
      const merged = new Uint8Array(this.#buffer.length + incoming.length);
      merged.set(this.#buffer);
      merged.set(incoming, this.#buffer.length);
      this.#buffer = merged;

      while (this.#buffer.length >= 4) {
        const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(0, true);
        if (this.#buffer.length < 4 + length) break;
        const payload = this.#buffer.subarray(4, 4 + length);
        this.#buffer = this.#buffer.slice(4 + length);
        this.#dispatch(JSON.parse(decoder.decode(payload)));
      }
    }
  }

  async #drainStderr(proc) {
    for (;;) {
      const text = await proc.stderr.readString();
      if (!text) return;
      dump(`[lima-host] ${text}`);
    }
  }

  #dispatch(message) {
    if (message.event) {
      if (message.event === "host.unavailable" && typeof message.data === "string") {
        this.#startupError = new Error(message.data);
      }
      for (const listener of this.#listeners) {
        try { listener(message); }
        catch (error) { Cu.reportError(error); }
      }
      return;
    }
    const handle = this.#pending.get(message.id);
    if (!handle) return;
    this.#pending.delete(message.id);
    handle.timer.cancel();
    if (message.ok) handle.resolve(message.result);
    else handle.reject(Object.assign(new Error(message.error?.message ?? "lima-host error"), { code: message.error?.code }));
  }

  #onExit(exitCode) {
    this.#proc = null;
    this.#buffer = new Uint8Array(0);
    for (const handle of this.#pending.values()) {
      handle.timer.cancel();
      handle.reject(this.#startupError ?? new Error(`Lima’s runtime exited (${exitCode})`));
    }
    this.#pending.clear();
    this.status = this.#restarts < MAX_RESTARTS ? "stopped" : "failed";
    this.#restarts++;
    this.#dispatch({ event: "host.disconnected" });
  }
}

export const LimaBridge = new Bridge();
