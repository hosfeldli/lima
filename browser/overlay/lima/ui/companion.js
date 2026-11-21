import { bridge, el, icon, onEvent, prefs } from "./lib.js";

const pauseCompanions = () => document.documentElement.toggleAttribute("lima-hidden", document.hidden);
document.addEventListener("visibilitychange", pauseCompanions);
pauseCompanions();

let personality = prefs.get("personality", "full");
function applyPersonality(value) {
  personality = value;
  for (const character of document.querySelectorAll(".companion")) character.dataset.personality = value;
}
bridge?.browser("agentPreferences", {}).then(data => { if (data?.personality) applyPersonality(data.personality); }).catch(() => {});
onEvent(({ event, data }) => { if (event === "ui.personality") applyPersonality(data); });

const ACCESSORIES = {
  think: "notebook", read: "search", tabs: "tab", write: "file", terminal: "terminal",
  delegate: "note", test: "checkbox", failed: "warning", blocked: "warning", complete: "check", paused: "pause",
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
  const eyes = svgElement("g", { class: "companion-eyes", fill: "var(--ink)" },
    svgElement("ellipse", { cx: 41, cy: 53, rx: 2.3, ry: 3.3 }),
    svgElement("ellipse", { cx: 60, cy: 53, rx: 2.3, ry: 3.3 }));
  const outline = {
    fill: "none", stroke: "var(--ink)", "stroke-width": 2.7, "stroke-linecap": "round", "stroke-linejoin": "round",
  };
  const isWorkspace = size === "workspace-avatar";
  const isChat = size === "chat-avatar";
  const body = svgElement("g", { class: "companion-body" },
    path("M24 57c0-8 4-16 11-21 0-8 6-15 13-17l9 12c3 0 6 1 9 2l8-5c-1 5-1 9 1 12 7 7 10 17 8 26-3 10-13 14-32 14S18 75 18 65c0-3 2-6 6-8Z", { ...outline, fill: "var(--paper)" }),
    path("M37 35c1-7 5-12 10-15l10 13c-8 2-14 3-20 2Z", { fill: "var(--panel-2)" }),
    path("M37 36c6 2 12 1 20-3", { ...outline, "stroke-width": 1.7 }),
    path("M21 65c3 8 15 12 29 12 15 0 26-4 30-11-1 9-15 12-29 12S23 75 21 65Z", { fill: "var(--panel-2)" }),
    path("M45 61c3 4 7 4 10 0", { class: "companion-smile", ...outline, "stroke-width": 2.1 }),
    path("M48 61c0-3 4-3 4 0 0 2-4 2-4 0Z", { class: "companion-speaking", ...outline, "stroke-width": 1.6 }),
    path("M30 56l-2 3m45-3-2 3", { ...outline, opacity: .33, "stroke-width": 1.4 }),
    eyes,
    path("M24 59c-4-1-8 1-10 4m64-4c4 0 7 1 10 4", { class: "companion-hands", ...outline }),
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

export function companion(size = "status") {
  return el("span", { class: "companion " + size, "aria-hidden": "true", "data-personality": personality },
    characterArt(size), el("span", { class: "companion-prop" }));
}

export function setCompanionState(element, state) {
  if (element.dataset.state === state) return;
  element.dataset.state = state;
  element.lastChild.replaceChildren(...(ACCESSORIES[state] ? [icon(ACCESSORIES[state])] : []));
}
