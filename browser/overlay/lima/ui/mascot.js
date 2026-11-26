import { SPRING, SETTLE } from "./motion.sys.mjs";
import { generateMascot, mascotColors } from "./mascot-look.sys.mjs";
/* The mascot engine: every workspace and chat gets its own companion,
 * generated from its id (ears, eyes, markings, an accessory and a colour),
 * drawn in the chosen theme, kept lively with small idle moments, and
 * reacting to what its agent does with a varied pick of reactions.
 *
 * Everything here is decoration. It pauses off screen and in hidden pages,
 * stops with Reduce Motion, and the Off personality keeps mascots still.
 * companion.js draws the art; this module decides what it looks like and
 * how it moves. */

// MARK: Generation

export const THEMES = { graphite: "Graphite", pastel: "Pastel", outline: "Outline" };
let theme = "graphite";
try { theme = localStorage.getItem("lima.mascotTheme") ?? "graphite"; } catch {}

export function setMascotTheme(value) {
  if (!THEMES[value]) return;
  theme = value;
  try { localStorage.setItem("lima.mascotTheme", value); } catch {}
  for (const character of document.querySelectorAll(".companion[data-look]")) paintLook(character);
}
export const mascotTheme = () => theme;

/** Applies a character's colours and its look's attributes. Both the light
 * and dark palettes are set; CSS picks one from the page's theme, so a
 * mascot follows light and dark mode the moment it changes. */
export function paintLook(character) {
  const look = character.limaLook;
  if (!look) return;
  for (const [mode, dark] of [["light", false], ["dark", true]]) {
    for (const [name, value] of Object.entries(mascotColors(look, dark, theme))) character.style.setProperty(`${name}-${mode}`, value);
  }
  character.dataset.look = "";
  character.dataset.ears = look.ears;
  character.dataset.eyes = look.eyes;
  character.dataset.marking = look.marking;
  character.dataset.extra = look.extra;
  character.dataset.mascotTheme = theme;
  character.style.setProperty("--mascot-tilt", `${look.tilt}deg`);
}

// MARK: Motion

const lively = character => character.dataset.personality === "full" && !character.hasAttribute("data-offscreen") &&
  !document.documentElement.hasAttribute("lima-hidden") && !matchMedia("(prefers-reduced-motion: reduce)").matches;
const part = (character, name) => character.querySelector(`.companion-${name}`);

/** Small things a resting mascot does now and then. */
const IDLES = {
  look: c => part(c, "eyes")?.animate([{ transform: "none" }, { transform: "translateX(-2px)", offset: .3 }, { transform: "translateX(-2px)", offset: .5 },
    { transform: "translateX(2px)", offset: .75 }, { transform: "none" }], { duration: 1800, easing: "ease-in-out" }),
  stretch: c => part(c, "body")?.animate([{ transform: "none" }, { transform: "scale(1.04, .94) translateY(1px)", offset: .3 },
    { transform: "scale(.97, 1.06) translateY(-2px)", offset: .65 }, { transform: "none" }], { duration: 1200, easing: "ease-in-out" }),
  blink: c => part(c, "eyes")?.animate([{ transform: "none" }, { transform: "scaleY(.1)", offset: .15 }, { transform: "none", offset: .3 },
    { transform: "scaleY(.1)", offset: .45 }, { transform: "none", offset: .6 }], { duration: 700 }),
  twitch: c => c.querySelector(".companion-ears")?.animate([{ transform: "none" }, { transform: "rotate(-6deg)", offset: .2 },
    { transform: "rotate(4deg)", offset: .4 }, { transform: "none", offset: .6 }], { duration: 650, easing: "ease-out" }),
  hop: c => part(c, "body")?.animate([{ transform: "none" }, { transform: "translateY(-5px) scale(.97, 1.04)", offset: .4 },
    { transform: "scale(1.05, .93)", offset: .7 }, { transform: "none" }], { duration: 650, easing: SPRING }),
  yawn: c => part(c, "speaking")?.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1.5)", offset: .4 },
    { opacity: 1, transform: "scale(1.5)", offset: .7 }, { opacity: 0, transform: "scale(.6)" }], { duration: 1500, easing: "ease-in-out" }),
};

/** Reactions, by event: each event draws from a pool so it doesn't always look the same. */
const REACTIONS = {
  complete: ["celebrate", "heart", "spin", "celebrate"],
  failed: ["surprised", "shrug"],
  blocked: ["question", "wave"],
  delegate: ["wave", "salute"],
  listen: ["perk", "tilt"],
  receive: ["perk", "heart"],
};

function overlay(character, draw, keyframes, duration) {
  const art = character.querySelector(".companion-art");
  if (!art) return;
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "companion-reaction");
  draw(group);
  art.append(group);
  const animation = group.animate(keyframes, { duration, easing: SETTLE, fill: "forwards" });
  animation.finished.then(() => group.remove(), () => group.remove());
}

function svg(name, attributes) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

const PERFORM = {
  celebrate: c => {
    IDLES.hop(c);
    overlay(c, group => {
      for (let i = 0; i < 9; i++) {
        const angle = (i / 9) * Math.PI * 2;
        group.append(svg("circle", { cx: 51 + Math.cos(angle) * 34, cy: 44 + Math.sin(angle) * 26, r: i % 3 ? 1.8 : 2.4,
          fill: i % 2 ? "var(--mascot-accent, var(--ink-2))" : "var(--ink)" }));
      }
    }, [{ opacity: 0, transform: "scale(.4)" }, { opacity: 1, transform: "scale(1.05)", offset: .35 }, { opacity: 0, transform: "scale(1.25) translateY(-4px)" }], 1100);
  },
  heart: c => {
    IDLES.hop(c);
    overlay(c, group => group.append(svg("path", { d: "M82 22c-3-5-11-3-10 3 1 4 6 7 10 10 4-3 9-6 10-10 1-6-7-8-10-3Z",
      fill: "var(--mascot-accent, var(--ink-2))", stroke: "var(--ink)", "stroke-width": 1.6 })),
    [{ opacity: 0, transform: "translateY(6px) scale(.5)" }, { opacity: 1, transform: "translateY(-2px) scale(1.1)", offset: .4 }, { opacity: 0, transform: "translateY(-12px) scale(1)" }], 1300);
  },
  spin: c => part(c, "body")?.animate([{ transform: "none" }, { transform: "rotate(-8deg) translateY(-4px)", offset: .25 },
    { transform: "rotate(360deg) translateY(-6px)", offset: .75 }, { transform: "rotate(360deg)" }], { duration: 900, easing: "ease-in-out" }),
  surprised: c => {
    part(c, "eyes")?.animate([{ transform: "none" }, { transform: "scale(1.5)", offset: .2 }, { transform: "scale(1.5)", offset: .7 }, { transform: "none" }], { duration: 900 });
    part(c, "body")?.animate([{ transform: "none" }, { transform: "translateY(2px) scale(1.04, .95)", offset: .2 }, { transform: "none" }], { duration: 500 });
    overlay(c, group => group.append(svg("path", { d: "M84 16v12m0 5v1", stroke: "var(--ink)", "stroke-width": 3, "stroke-linecap": "round", fill: "none" })),
      [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none", offset: .2 }, { opacity: 1, offset: .75 }, { opacity: 0 }], 1100);
  },
  shrug: c => part(c, "hands")?.animate([{ transform: "none" }, { transform: "translateY(-4px)", offset: .3 }, { transform: "translateY(-4px)", offset: .6 }, { transform: "none" }],
    { duration: 900, easing: "ease-in-out" }),
  question: c => {
    IDLES.look(c);
    overlay(c, group => group.append(svg("path", { d: "M80 17c0-4 8-4 8 1 0 3-4 4-4 7m0 4v1", stroke: "var(--ink)", "stroke-width": 2.4, "stroke-linecap": "round", fill: "none" })),
      [{ opacity: 0, transform: "rotate(-12deg) scale(.6)" }, { opacity: 1, transform: "none", offset: .25 }, { opacity: 1, offset: .8 }, { opacity: 0 }], 1600);
  },
  wave: c => part(c, "hands")?.animate([{ transform: "none" }, { transform: "rotate(-8deg) translateY(-3px)", offset: .2 }, { transform: "rotate(6deg) translateY(-3px)", offset: .4 },
    { transform: "rotate(-8deg) translateY(-3px)", offset: .6 }, { transform: "none" }], { duration: 950, easing: "ease-in-out" }),
  salute: c => {
    PERFORM.wave(c);
    IDLES.hop(c);
  },
  perk: c => {
    c.querySelector(".companion-ears")?.animate([{ transform: "none" }, { transform: "translateY(-2px) scale(1.05)", offset: .35 }, { transform: "none" }], { duration: 420, easing: SPRING });
    part(c, "body")?.animate([{ transform: "none" }, { transform: "translateY(-2px)", offset: .35 }, { transform: "none" }], { duration: 420, easing: SPRING });
  },
  tilt: c => part(c, "body")?.animate([{ transform: "none" }, { transform: "rotate(-7deg)", offset: .35 }, { transform: "rotate(-7deg)", offset: .7 }, { transform: "none" }],
    { duration: 1100, easing: "ease-in-out" }),
};

/** Plays a reaction to `event` (complete, failed, blocked, delegate, listen, receive). */
export function react(character, event) {
  if (!character?.isConnected || !lively(character)) return;
  const pool = REACTIONS[event];
  if (!pool) return;
  const choices = pool.filter(name => name !== character.limaLastReaction);
  const name = (choices.length ? choices : pool)[Math.floor(Math.random() * (choices.length || pool.length))];
  character.limaLastReaction = name;
  try { PERFORM[name]?.(character); } catch {}
}

// The idle scheduler: one timer for the page, picking a resting mascot now and then.
const resting = new Set();
let idleTimer = 0;
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    for (const character of [...resting]) if (!character.isConnected) resting.delete(character);
    const candidates = [...resting].filter(character => lively(character) && ["idle", undefined, "complete"].includes(character.dataset.state));
    if (candidates.length) {
      const character = candidates[Math.floor(Math.random() * candidates.length)];
      const names = Object.keys(IDLES).filter(name => name !== character.limaLastIdle);
      const name = names[Math.floor(Math.random() * names.length)];
      character.limaLastIdle = name;
      try { IDLES[name](character); } catch {}
    }
    idleTimer = 0;
    if (resting.size) scheduleIdle();
  }, 30000 + Math.random() * 25000);
}

/** Gives a character its generated look and joins it to the idle moments. */
export function bringToLife(character, seed) {
  character.limaLook = generateMascot(seed);
  character.limaSeed = seed ?? "";
  paintLook(character);
  resting.add(character);
  if (!idleTimer) scheduleIdle();
}

addEventListener("pagehide", () => clearTimeout(idleTimer), { once: true });
