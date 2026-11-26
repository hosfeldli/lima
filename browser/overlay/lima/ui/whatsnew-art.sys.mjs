/* What's New, drawn automatically. A release's notes come from its commit
 * messages (one "## Subject" section per commit, its body underneath). Each
 * section gets a small illustration chosen from its words: a topic scene
 * (notes, search, sidebar, agents, updates, safety, music, fixes) in colours
 * seeded by its title, so every release looks different and nothing is drawn
 * by hand. Pure functions: no DOM, so they're tested in Node. */

/** Sections from release-notes Markdown: "## Title" + body, or "- Title" lines. */
export function releaseSections(markdown) {
  const sections = [];
  let current = null;
  for (const raw of String(markdown ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^##\s+(.+)$/.exec(line);
    const bullet = !heading && !current?.fromHeading && /^[-*]\s+(.+)$/.exec(line);
    if (heading || bullet) {
      const title = (heading ?? bullet)[1].trim();
      if (/^bump lima version\b/i.test(title) || /^merge (branch|pull request)\b/i.test(title)) { current = { skip: true, fromHeading: !!heading }; continue; }
      current = { title, body: [], fromHeading: !!heading };
      sections.push(current);
    } else if (current && !current.skip && line.trim() && !/^#\s/.test(line) && !/^co-authored-by:/i.test(line.trim())) {
      current.body.push(line.trim());
    }
  }
  return sections.map(({ title, body }) => ({ title, body, topic: topicOf(`${title} ${body.join(" ")}`) }));
}

export const TOPICS = {
  notes: { label: "Notes", words: /\bnote|calculat|formula|value block|markdown|script|checklist|table/i },
  search: { label: "Search", words: /search|find|result|rank|scope/i },
  sidebar: { label: "Sidebar", words: /sidebar|folder|tab\b|tabs\b|workspace|arrange|row|icon/i },
  agents: { label: "Agents", words: /agent|chat|companion|\bpip\b|mascot|permission|guardrail|run\b/i },
  updates: { label: "Updates", words: /update|release|install|download|rollout|what.?s new/i },
  safety: { label: "Safety", words: /privacy|security|legal|backup|export|restore|safe|crash|report|log/i },
  music: { label: "Music", words: /music|spotify|audio|\bdj\b|volume/i },
  fixes: { label: "Fixes", words: /\bfix|bug|glitch|broken|repair|spacing|gap/i },
};

export function topicOf(text) {
  // The topic whose words appear most, earlier topics winning ties.
  let best = "sparkle", score = 0;
  for (const [name, { words }] of Object.entries(TOPICS)) {
    const hits = (String(text).match(new RegExp(words.source, "gi")) ?? []).length;
    if (hits > score) { best = name; score = hits; }
  }
  return best;
}

/** A small seeded random generator (mulberry32 over a string hash). */
export function seeded(text) {
  let h = 1779033703 ^ String(text).length;
  for (const ch of String(text)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = n => Math.round(n * 10) / 10;

/* Each scene draws in a 280×150 box with the stroke colour --art-ink and
 * fills from the palette; the Pip is added by the page beside it. */
const SCENES = {
  notes: (p, rand) => `
    <g transform="rotate(${r1(-4 + rand() * 8)} 140 78)">
      <rect x="92" y="26" width="104" height="104" rx="12" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2"/>
      <path d="M108 52h56M108 66h72M108 80h40" stroke="var(--art-ink)" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>
      <rect x="106" y="94" width="54" height="18" rx="6" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="1.5"/>
      <text x="133" y="107" text-anchor="middle" font-size="11" font-weight="700" fill="var(--art-ink)" font-family="ui-monospace, monospace">{{ }}</text>
    </g>`,
  search: (p, rand) => `
    <rect x="70" y="40" width="140" height="22" rx="11" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2"/>
    <path d="M84 84h70M84 98h96M84 112h56" stroke="var(--art-ink)" stroke-width="2.4" stroke-linecap="round" opacity=".45"/>
    <circle cx="${r1(178 + rand() * 10)}" cy="92" r="20" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="3"/>
    <path d="M${r1(192 + rand() * 10)} 106l16 16" stroke="var(--art-ink)" stroke-width="5" stroke-linecap="round"/>`,
  sidebar: (p, rand) => `
    <rect x="80" y="24" width="120" height="110" rx="14" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2"/>
    ${[0, 1, 2, 3].map(i => `<rect x="${92 + (i % 2) * 10}" y="${38 + i * 22}" width="${r1(70 + rand() * 24)}" height="14" rx="5" fill="${i === 1 ? p.strong : p.soft}" opacity="${i === 1 ? 0.9 : 0.8}"/>`).join("")}
    <path d="M178 61l6 5-6 5" stroke="var(--art-ink)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  agents: (p, rand) => `
    <rect x="70" y="30" width="140" height="96" rx="14" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2"/>
    <circle cx="86" cy="44" r="3.5" fill="var(--art-ink)" opacity=".4"/><circle cx="98" cy="44" r="3.5" fill="var(--art-ink)" opacity=".4"/>
    <rect x="86" y="58" width="${r1(70 + rand() * 30)}" height="14" rx="7" fill="${p.soft}"/>
    <rect x="${r1(118 - rand() * 10)}" y="80" width="76" height="14" rx="7" fill="${p.strong}" opacity=".85"/>
    <rect x="86" y="102" width="52" height="12" rx="6" fill="${p.soft}"/>`,
  updates: (p, rand) => `
    <path d="M100 66l40-22 40 22v44l-40 22-40-22z" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M100 66l40 22 40-22M140 88v44" stroke="var(--art-ink)" stroke-width="2" fill="none" stroke-linejoin="round"/>
    <path d="M${r1(196 + rand() * 6)} 40v30m-10-10l10 10 10-10" stroke="${p.strong}" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  safety: (p, rand) => `
    <path d="M140 26l46 16v32c0 30-20 48-46 58-26-10-46-28-46-58V42z" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M122 80l12 12 24-26" stroke="var(--art-ink)" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${r1(204 + rand() * 8)}" cy="44" r="6" fill="${p.strong}"/>`,
  music: (p, rand) => `
    <path d="M118 108V46l58-12v62" stroke="var(--art-ink)" stroke-width="3" fill="none" stroke-linejoin="round"/>
    <ellipse cx="108" cy="110" rx="13" ry="10" fill="${p.strong}" stroke="var(--art-ink)" stroke-width="2"/>
    <ellipse cx="166" cy="98" rx="13" ry="10" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="2"/>
    <text x="${r1(196 + rand() * 12)}" y="58" font-size="22" fill="var(--art-ink)" opacity=".6">♪</text>`,
  fixes: (p, rand) => `
    <g transform="rotate(${r1(-30 + rand() * 12)} 140 80)">
      <rect x="92" y="66" width="96" height="30" rx="15" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="2.4"/>
      <rect x="124" y="66" width="32" height="30" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="2"/>
      ${[0, 1, 2, 3].map(i => `<circle cx="${132 + (i % 2) * 16}" cy="${74 + Math.floor(i / 2) * 14}" r="2" fill="var(--art-ink)" opacity=".5"/>`).join("")}
    </g>`,
  sparkle: (p, rand) => `
    <path d="M140 34l9 28 28 9-28 9-9 28-9-28-28-9 28-9z" fill="${p.soft}" stroke="var(--art-ink)" stroke-width="2.4" stroke-linejoin="round"/>
    <circle cx="${r1(196 + rand() * 10)}" cy="${r1(46 + rand() * 10)}" r="7" fill="${p.strong}"/>`,
};

/** The illustration for one section: an SVG string (no text from the notes is embedded). */
export function sectionArt(title, topic = topicOf(title), dark = false) {
  const rand = seeded(title);
  const hue = Math.floor(rand() * 360);
  const palette = dark
    ? { back: `hsl(${hue} 22% 18%)`, soft: `hsl(${hue} 30% 34%)`, strong: `hsl(${(hue + 40) % 360} 46% 56%)` }
    : { back: `hsl(${hue} 70% 95%)`, soft: `hsl(${hue} 62% 84%)`, strong: `hsl(${(hue + 40) % 360} 62% 62%)` };
  const confetti = Array.from({ length: 7 }, () => {
    const x = r1(12 + rand() * 256), y = r1(10 + rand() * 130), size = r1(3 + rand() * 5);
    return rand() < 0.5
      ? `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${palette.strong}" opacity="${r1(0.35 + rand() * 0.4)}"/>`
      : `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="1.5" transform="rotate(${Math.floor(rand() * 90)} ${x} ${y})" fill="${palette.soft}"/>`;
  }).join("");
  const scene = (SCENES[topic] ?? SCENES.sparkle)(palette, rand);
  return { topic, hue, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 150" role="img" aria-hidden="true"><rect width="280" height="150" rx="16" fill="${palette.back}"/>${confetti}${scene}</svg>` };
}
