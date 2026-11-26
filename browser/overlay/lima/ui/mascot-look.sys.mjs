/* Shared Pip geometry, appearance and palette for sidebar and content. */
/** A small deterministic generator (mulberry32) seeded from a string. */
function seeded(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (let i = 0; i < String(seed).length; i++) {
    h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const EARS = ["pointy", "round", "floppy"];
export const EYES = ["dots", "happy", "sleepy", "sparkle"];
export const MARKINGS = ["none", "none", "spots", "patch", "stripes"];
export const EXTRAS = ["none", "none", "scarf", "bow", "glasses", "headphones", "flower"];

/** The look for one id: the same id always gets the same mascot. */
export function generateMascot(seed) {
  if (!seed) return { ears: "pointy", eyes: "dots", marking: "none", extra: "none", hue: 30, tilt: 0 };
  const random = seeded(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  return {
    ears: pick(EARS), eyes: pick(EYES), marking: pick(MARKINGS), extra: pick(EXTRAS),
    hue: Math.floor(random() * 360),
    // A touch of individual posture.
    tilt: Math.round((random() - .5) * 6),
  };
}

/** Colours for a look in the current theme, as CSS custom properties. */
export function mascotColors(look, dark, theme) {
  if (theme === "pastel") {
    return {
      "--mascot-fill": `hsl(${look.hue} ${dark ? 22 : 62}% ${dark ? 30 : 93}%)`,
      "--mascot-tone": `hsl(${look.hue} ${dark ? 24 : 48}% ${dark ? 40 : 82}%)`,
      "--mascot-accent": `hsl(${(look.hue + 150) % 360} ${dark ? 40 : 55}% ${dark ? 62 : 58}%)`,
    };
  }
  if (theme === "outline") return { "--mascot-fill": "var(--paper)", "--mascot-tone": "transparent", "--mascot-accent": "var(--paper)" };
  // Graphite: Lima's greys, each mascot a slightly different shade.
  const light = dark ? 22 + (look.hue % 7) : 96 - (look.hue % 6);
  return { "--mascot-fill": `hsl(0 0% ${light}%)`, "--mascot-tone": `hsl(0 0% ${dark ? light + 10 : light - 9}%)`, "--mascot-accent": "var(--ink-2)" };
}

export function characterArt(document, size) {
  const svgElement = (name, attributes, ...children) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  };
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
