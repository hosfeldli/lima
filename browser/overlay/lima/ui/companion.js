import { characterArt } from "./mascot-look.sys.mjs";
import { bridge, el, icon, onEvent, prefs } from "./lib.js";
import { bringToLife, react, setMascotTheme } from "./mascot.js";

const pauseCompanions = () => document.documentElement.toggleAttribute("lima-hidden", document.hidden);
document.addEventListener("visibilitychange", pauseCompanions);
pauseCompanions();

// Light or dark, as the browser resolves it (macOS appearance unless
// Settings pins one). The last value is cached so pages open without a flash.
function applyTheme(value) {
  if (value !== "light" && value !== "dark") return;
  document.documentElement.setAttribute("lima-theme", value);
  prefs.set("theme", value);
}
applyTheme(prefs.get("theme", "light"));

let personality = prefs.get("personality", "full");
document.documentElement.dataset.limaPersonality = personality;
let visualSnapshot;
let visualRequested = false;
let visualGeneration = 0;
const visualListeners = new Set();
function receiveVisualState(data) {
  if (!data) return;
  visualSnapshot = data;
  for (const listener of visualListeners) listener(data);
}
export function watchVisualActivity(select, update) {
  let previous;
  const listener = snapshot => {
    const value = select(snapshot);
    const key = JSON.stringify(value);
    if (key === previous) return;
    previous = key;
    update(value);
  };
  visualListeners.add(listener);
  if (visualSnapshot) listener(visualSnapshot);
  if (!visualRequested && bridge) {
    visualRequested = true;
    const generation = visualGeneration;
    bridge.browser("visualActivity", {}).then(data => {
      if (generation === visualGeneration) receiveVisualState(data);
    }).catch(() => {});
  }
  return () => visualListeners.delete(listener);
}
function applyPersonality(value) {
  personality = value;
  document.documentElement.dataset.limaPersonality = value;
  for (const character of document.querySelectorAll(".companion")) character.dataset.personality = value;
}
bridge?.browser("agentPreferences", {}).then(data => {
  if (data?.personality) applyPersonality(data.personality);
  if (data?.mascotTheme) setMascotTheme(data.mascotTheme);
  applyTheme(data?.theme);
}).catch(() => {});
onEvent(({ event, data }) => {
  if (event === "ui.personality") applyPersonality(data);
  if (event === "ui.theme") applyTheme(data);
  if (event === "ui.visualActivity") { visualGeneration++; receiveVisualState(data); }
  if (event === "ui.companionVisible") document.documentElement.toggleAttribute("lima-panel-hidden", !data);
  if (event === "ui.mascotTheme") setMascotTheme(data);
});

const visibleCompanions = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) {
    if (!target.isConnected) visibleCompanions.unobserve(target);
    else target.toggleAttribute("data-offscreen", !isIntersecting);
  }
});
window.addEventListener("pagehide", () => visibleCompanions.disconnect(), { once: true });
const cues = new WeakMap();

export function cueCompanion(element, gesture) {
  if (element.hasAttribute("data-gesture")) return;
  element.dataset.gesture = gesture;
  clearTimeout(cues.get(element));
  cues.set(element, setTimeout(() => delete element.dataset.gesture, gesture === "farewell" ? 660 : 280));
}

const ACCESSORIES = {
  think: "notebook", read: "search", tabs: "tab", write: "file", terminal: "terminal",
  delegate: "note", planning: "checkbox", waiting: "note", test: "checkbox", recover: "redo", failed: "warning", blocked: "warning", complete: "check", paused: "pause",
};

export const MASCOTS = {
  classic: "Classic", builder: "Coding", explorer: "Research", chef: "Cooking",
  traveler: "Travel", artist: "Creative", analyst: "Analysis",
};

/** A companion. `seed` (a workspace or chat id) gives it its own generated
 * look; without one it's Lima's classic companion. */
export function companion(size = "status", seed = null) {
  const character = el("span", { class: "companion " + size, title: "Ready", "aria-hidden": "true", "data-personality": personality },
    characterArt(document, size), el("span", { class: "companion-prop" }));
  visibleCompanions.observe(character);
  bringToLife(character, seed);
  return character;
}

/** Gives an existing companion the look for `seed` (once its id is known). */
export function setCompanionSeed(element, seed) {
  if (!element || element.limaSeed === (seed ?? "")) return;
  bringToLife(element, seed);
}

// State changes that get a reaction, drawn from a varied pool (mascot.js).
const REACTS_TO = { complete: "complete", failed: "failed", blocked: "blocked", waiting: "blocked" };

export function setCompanionState(element, state, label) {
  const descriptions = { idle: "Ready", think: "Thinking", planning: "Planning", read: "Reading",
    tabs: "Working in tabs", write: "Writing", terminal: "Running a command", test: "Checking results",
    waiting: "Waiting for you", blocked: "Needs your attention", complete: "Finished", failed: "Couldn’t finish",
    delegate: "Handing off work", paused: "Paused", recover: "Recovering" };
  const title = label ?? descriptions[state] ?? "Working";
  if (element.title !== title) element.title = title;
  if (element.dataset.state === state) return;
  const previous = element.dataset.state;
  element.dataset.state = state;
  element.lastChild.replaceChildren(...(ACCESSORIES[state] ? [icon(ACCESSORIES[state])] : []));
  if (previous !== undefined && REACTS_TO[state]) react(element, REACTS_TO[state]);
}
