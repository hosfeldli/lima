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
  if (["listen", "receive"].includes(gesture)) react(element, gesture);
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

function svgElement(name, attributes, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function characterArt(size) {
  const path = (d, attributes = {}) => svgElement("path", { d, ...attributes });
  const outline = {
    fill: "none", stroke: "var(--ink)", "stroke-width": 2.7, "stroke-linecap": "round", "stroke-linejoin": "round",
  };
  const FILL = "var(--mascot-fill, var(--paper))";
  const TONE = "var(--mascot-tone, var(--panel-2))";
  const ACCENT = "var(--mascot-accent, var(--ink-2))";
  // Eyes: dots, happy arcs, sleepy lines or sparkly; the look picks one (CSS).
  const eyes = svgElement("g", { class: "companion-eyes", fill: "var(--ink)" },
    svgElement("g", { class: "eyes-dots" },
      svgElement("ellipse", { cx: 41, cy: 53, rx: 2.3, ry: 3.3 }), svgElement("ellipse", { cx: 60, cy: 53, rx: 2.3, ry: 3.3 })),
    svgElement("g", { class: "eyes-happy", ...outline, "stroke-width": 2.2 }, path("M38 54c1-3 5-3 6 0M57 54c1-3 5-3 6 0")),
    svgElement("g", { class: "eyes-sleepy", ...outline, "stroke-width": 2.2 }, path("M38 53c1 2 5 2 6 0M57 53c1 2 5 2 6 0")),
    svgElement("g", { class: "eyes-sparkle" },
      svgElement("ellipse", { cx: 41, cy: 53, rx: 2.8, ry: 3.6 }), svgElement("ellipse", { cx: 60, cy: 53, rx: 2.8, ry: 3.6 }),
      svgElement("circle", { cx: 42, cy: 51.6, r: .9, fill: "var(--paper)" }), svgElement("circle", { cx: 61, cy: 51.6, r: .9, fill: "var(--paper)" })));
  // Ears sit behind the head, so each shape shows only above it.
  const ears = svgElement("g", { class: "companion-ears" },
    svgElement("g", { class: "ears-pointy" },
      path("M35 37C35 28 41 21 48 19L58 32Z", { ...outline, fill: FILL }), path("M39 33c1-5 4-9 8-11l6 9Z", { fill: TONE }),
      path("M64 34L74 28C73 33 73 37 76 41Z", { ...outline, fill: FILL })),
    svgElement("g", { class: "ears-round" },
      svgElement("circle", { cx: 43, cy: 28, r: 8.5, ...outline, fill: FILL }), svgElement("circle", { cx: 43, cy: 28, r: 4.2, fill: TONE }),
      svgElement("circle", { cx: 69, cy: 30, r: 6.5, ...outline, fill: FILL })),
    svgElement("g", { class: "ears-floppy" },
      path("M34 38c-9 1-14 10-11 18 4-2 9-7 12-11Z", { ...outline, fill: TONE }),
      path("M73 36c9 0 14 8 12 16-4-2-9-6-11-9Z", { ...outline, fill: TONE })));
  // Markings in the tone colour; one (or none) shows.
  const markings = svgElement("g", { class: "companion-markings", fill: TONE },
    svgElement("g", { class: "marking-spots" }, svgElement("circle", { cx: 30, cy: 64, r: 3 }), svgElement("circle", { cx: 70, cy: 60, r: 2.4 }),
      svgElement("circle", { cx: 63, cy: 71, r: 2 })),
    svgElement("g", { class: "marking-patch" }, svgElement("ellipse", { cx: 61, cy: 52, rx: 6.5, ry: 5.5 })),
    svgElement("g", { class: "marking-stripes", ...outline, stroke: TONE, "stroke-width": 2.4 }, path("M48 31c1 3 1 5 0 7M55 30c1 3 1 5 0 7M62 32c1 3 1 4 0 6")));
  // A personal accessory, on top of any task costume.
  const extras = svgElement("g", { class: "companion-extras" },
    svgElement("g", { class: "extra-scarf" }, path("M26 67c9 6 40 7 50 0l1 6c-11 7-42 7-52 0Z", { ...outline, "stroke-width": 2, fill: ACCENT }),
      path("M66 72l4 10 6-3-3-9", { ...outline, "stroke-width": 2, fill: ACCENT })),
    svgElement("g", { class: "extra-bow" }, path("M71 36l-7-5v10Zm0 0 7-5v10Z", { ...outline, "stroke-width": 1.8, fill: ACCENT })),
    svgElement("g", { class: "extra-glasses", ...outline, "stroke-width": 1.8 },
      svgElement("circle", { cx: 41, cy: 53, r: 5.5 }), svgElement("circle", { cx: 60, cy: 53, r: 5.5 }), path("M46.5 53h8")),
    svgElement("g", { class: "extra-headphones", ...outline, "stroke-width": 2.2 },
      path("M26 52c0-24 50-24 50 0"), path("M22 49h7v11h-7Zm51 0h7v11h-7Z", { fill: ACCENT })),
    svgElement("g", { class: "extra-flower" },
      ...[[0, -3.5], [3.3, -1.1], [2, 2.9], [-2, 2.9], [-3.3, -1.1]].map(([x, y]) => svgElement("circle", { cx: 33 + x, cy: 33 + y, r: 2.4, fill: ACCENT })),
      svgElement("circle", { cx: 33, cy: 33, r: 1.6, fill: "var(--paper)", stroke: "var(--ink)", "stroke-width": 1 })));
  const isWorkspace = size === "workspace-avatar";
  const isChat = size === "chat-avatar";
  const body = svgElement("g", { class: "companion-body" },
    ears,
    path("M24 57c0-8 4-16 11-21C40 30 48 28 55 28S70 32 76 41c6 7 9 16 7 25-3 10-13 14-32 14S18 75 18 65c0-3 2-6 6-8Z", { ...outline, fill: FILL }),
    path("M21 65c3 8 15 12 29 12 15 0 26-4 30-11-1 9-15 12-29 12S23 75 21 65Z", { fill: TONE }),
    markings,
    path("M45 61c3 4 7 4 10 0", { class: "companion-smile", ...outline, "stroke-width": 2.1 }),
    path("M48 61c0-3 4-3 4 0 0 2-4 2-4 0Z", { class: "companion-speaking", ...outline, "stroke-width": 1.6 }),
    path("M30 56l-2 3m45-3-2 3", { ...outline, opacity: .33, "stroke-width": 1.4 }),
    eyes,
    path("M24 59c-4-1-8 1-10 4m64-4c4 0 7 1 10 4", { class: "companion-hands", ...outline }),
    extras,
    path("M31 40c1-14 9-21 21-21 13 0 22 9 23 21M27 41h52M49 22v10", { class: "mascot-accent builder", ...outline }),
    path("M62 49a9 9 0 1 0 18 0 9 9 0 1 0-18 0Zm15 7 10 11", { class: "mascot-accent explorer", ...outline }),
    path("M32 27c4-10 20-17 32-11 7 4 10 10 7 15-5 5-16 2-23 1-9-2-17 1-16-5Zm21-13 5-5", { class: "mascot-accent artist", ...outline, fill: "var(--panel-2)" }),
    path("M31 49h18v13H31Zm24 0h18v13H55Zm-6 5h6", { class: "mascot-accent analyst", ...outline, "stroke-width": 1.8 }),
    path("M35 35v-9c-8 1-12-3-11-9 1-5 7-8 13-5 1-6 6-9 12-8 6 0 10 4 11 9 5-3 12 0 13 5 2 6-3 10-10 9v8c-9 3-19 4-28 0Zm0-5c9 3 20 3 28 0m-21-12 1 7m11-8-1 8", { class: "mascot-accent chef", ...outline, fill: "var(--paper)" }),
    path("M29 37c3-14 12-19 24-19 10 0 18 6 22 16m-50 3c0-6 13-10 30-9 17 0 27 4 27 8s-12 7-28 7c-16 1-29-1-29-6Zm42 24 11-6 8 4 11-4v18l-11 5-9-3-10 5Zm11-6-1 20m9-16v19", { class: "mascot-accent traveler", ...outline, fill: "var(--panel-2)" }));
  const scene = isWorkspace
    ? svgElement("g", { class: "companion-scene", ...outline, "stroke-width": 2 },
      path("M19 76h32l4 10H18c-2 0-3-2-2-4Z", { fill: "var(--panel-2)" }),
      path("M64 73h19l6 13H58Z", { fill: "var(--paper)" }),
      path("M69 78h9m-10 4h14", { opacity: .54 }))
    : isChat
      ? svgElement("g", { class: "companion-scene", ...outline, "stroke-width": 2 },
        path("M70 15c4-5 18-5 23 0 4 4 3 10-2 12-2 1-5 1-7 1l-6 5v-6c-6-1-10-6-8-12Z", { fill: "var(--paper)" }),
        path("M77 20h1m5 0h1m5 0h1"))
      : svgElement("g", {});
  return svgElement("svg", { class: "companion-art", viewBox: "0 0 102 100", "aria-hidden": "true" },
    svgElement("ellipse", { class: "companion-shadow", cx: 51, cy: 84, rx: 25, ry: 3, fill: "var(--panel-2)" }),
    body,
    scene,
    svgElement("g", { class: "companion-sparks", ...outline, "stroke-width": 1.9 },
      path("M16 37l-3-4m5-2v-4"), path("M83 27l4-4m-1 8 6-1"), path("M86 69l5 2")));
}

/** A companion. `seed` (a workspace or chat id) gives it its own generated
 * look; without one it's Lima's classic companion. */
export function companion(size = "status", seed = null) {
  const character = el("span", { class: "companion " + size, "aria-hidden": "true", "data-personality": personality },
    characterArt(size), el("span", { class: "companion-prop" }));
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
const REACTS_TO = { complete: "complete", failed: "failed", blocked: "blocked", delegate: "delegate", waiting: "blocked" };

export function setCompanionState(element, state) {
  if (element.dataset.state === state) return;
  const previous = element.dataset.state;
  element.dataset.state = state;
  element.lastChild.replaceChildren(...(ACCESSORIES[state] ? [icon(ACCESSORIES[state])] : []));
  if (previous !== undefined && REACTS_TO[state]) react(element, REACTS_TO[state]);
}
