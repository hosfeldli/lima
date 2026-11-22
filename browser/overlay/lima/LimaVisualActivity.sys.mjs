import { LimaBridge } from "resource://lima/LimaBridge.sys.mjs";
import { VisualState, VISUAL_EVENTS } from "resource://lima/ui/visual-state.sys.mjs";

const state = new VisualState();
const listeners = new Set();
let snapshot = state.snapshot();
let serialized = JSON.stringify(snapshot);
let pending = false;
let expiry;
let queued = [];
let generation = 0;
let syncing = false;

function publish() {
  const next = state.snapshot();
  const encoded = JSON.stringify(next);
  if (serialized !== encoded) {
    serialized = encoded;
    snapshot = next;
    for (const listener of listeners) {
      try { listener(snapshot); } catch (error) { Cu.reportError(error); }
    }
  }
  expiry?.cancel();
  expiry = null;
  if (state.celebrations.size) {
    expiry = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    const nextExpiry = Math.min(...state.celebrations.values());
    expiry.initWithCallback(publish, Math.max(1, nextExpiry - Date.now()), Ci.nsITimer.TYPE_ONE_SHOT);
  }
}

function schedule() {
  if (pending) return;
  pending = true;
  Promise.resolve().then(() => { pending = false; publish(); });
}

async function sync() {
  const revision = ++generation;
  syncing = true;
  queued = [];
  try {
    const [workspaces, chats, tasks, prompts, focus, terminals] = await Promise.all([
      LimaBridge.request("workspace.list"), LimaBridge.request("chat.list"), LimaBridge.request("task.visualState"),
      LimaBridge.request("workspace.prompts"), LimaBridge.request("workspace.activity"), LimaBridge.request("terminal.list"),
    ]);
    if (revision !== generation) return;
    state.restore({ workspaces, chats, tasks, prompts, focus, terminals });
    for (const event of queued) state.ingest(event);
  } catch (error) {
    if (revision === generation) state.connected = false;
  } finally {
    if (revision === generation) { syncing = false; queued = []; schedule(); }
  }
}

LimaBridge.onEvent(message => {
  if (message.event === "host.connected") { sync(); return; }
  if (["host.disconnected", "host.unavailable"].includes(message.event)) {
    generation++;
    syncing = false;
    queued = [];
    state.celebrations.clear();
    state.connected = false;
    schedule();
    return;
  }
  if (!VISUAL_EVENTS.has(message.event)) return;
  if (syncing) queued.push(message);
  else if (state.ingest(message)) schedule();
});
if (LimaBridge.status === "running") sync();

export const LimaVisualActivity = {
  get snapshot() { return snapshot; },
  subscribe(callback) {
    listeners.add(callback);
    callback(snapshot);
    return () => listeners.delete(callback);
  },
};
