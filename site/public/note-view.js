// Shared Lima notes: the note is in the link's fragment (never sent to a
// server), deflate-compressed JSON {v, t, m}: version, title, Markdown. This
// page renders it read only. Calculators and value blocks stay live; nothing
// else runs. Everything is built with textContent, never as HTML.
import { artifactFromBlock, markdownTableAt, markdownCells, valueChip, wireValues } from "./rich-content.js";

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
};

async function decode(fragment) {
  const base64 = fragment.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const text = await new Response(stream).text();
  const note = JSON.parse(text);
  if (note?.v !== 1 || typeof note.m !== "string") throw new Error("unknown format");
  return { title: String(note.t ?? "").slice(0, 200) || "Untitled", markdown: note.m.slice(0, 400000) };
}

function inline(node, text) {
  const pattern = /(`[^`]+`)|\{\{([^{}\n]{1,300})\}\}|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~|!\[([^\]]*)\]\([^)]*\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) node.append(text.slice(last, match.index));
    if (match[1]) node.append(el("code", { text: match[1].slice(1, -1) }));
    else if (match[2] !== undefined) node.append(valueChip(match[2], el));
    else if (match[3]) node.append(el("a", { href: match[4], rel: "noopener noreferrer nofollow", target: "_blank", text: match[3] }));
    else if (match[5]) node.append(el("strong", { text: match[5] }));
    else if (match[6]) node.append(el("em", { text: match[6] }));
    else if (match[7]) node.append(el("s", { text: match[7] }));
    else node.append(el("span", { class: "shared-image", text: `Image${match[8] ? `: ${match[8].split("|")[0]}` : ""} (not included in shared links)` }));
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
  return node;
}

function render(markdown) {
  const root = el("div", { class: "md" });
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      list = null;
      root.append((fence[1] && artifactFromBlock(fence[1], body.join("\n"), el)) || el("pre", {}, el("code", { text: body.join("\n") })));
      continue;
    }
    const table = markdownTableAt(lines, i);
    if (table) {
      list = null;
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) rows.push(markdownCells(lines[i]));
      i--;
      root.append(el("table", {}, el("thead", {}, el("tr", {}, table.headers.map(cell => inline(el("th"), cell)))),
        el("tbody", {}, rows.map(row => el("tr", {}, row.map(cell => inline(el("td"), cell)))))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:([-*+])|(\d+)\.)\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (heading) { list = null; root.append(inline(el(`h${heading[1].length}`), heading[2])); }
    else if (item) {
      const kind = item[2] ? "ol" : "ul";
      if (list?.localName !== kind) { list = el(kind); root.append(list); }
      const li = el("li");
      if (item[3] !== undefined) li.append(el("input", { type: "checkbox", checked: item[3].toLowerCase() === "x", "aria-label": item[4] }), " ");
      list.append(inline(li, item[4]));
    } else if (/^\s*>/.test(line)) { list = null; root.append(inline(el("blockquote"), line.replace(/^\s*>\s?/, ""))); }
    else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { list = null; root.append(el("hr")); }
    else if (line.trim() && !/^\s*:::/.test(line)) { list = null; root.append(inline(el("p"), line.replace(/^\s*::embed\s+/, ""))); }
    else list = null;
  }
  return root;
}

const target = document.getElementById("note");
const fragment = location.hash.slice(1);
if (!fragment) target.replaceChildren(el("p", { class: "shared-empty", text: "This link has no note in it. Ask for the whole link." }));
else {
  decode(fragment).then(({ title, markdown }) => {
    document.title = `${title} · Lima`;
    const body = render(markdown);
    target.replaceChildren(el("h1", { class: "shared-title", text: title }), body);
    if (body.querySelector(".note-value, .calculator")) wireValues(body);
  }).catch(() => {
    target.replaceChildren(el("p", { class: "shared-empty", text: "This link is incomplete or damaged, so the note can't be shown. Ask for the whole link." }));
  });
}
