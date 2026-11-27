import { SPRING, SINK } from "./motion.sys.mjs";
/* Shared helpers for about:lima pages. `window.lima` is the only bridge to
 * the native runtime (installed by the LimaChild actor). */
import { ICONS } from "./icons.js";
import { artifactFromBlock, markdownCells, markdownTableAt, valueChip, wireValues } from "./rich-content.js";

function requestBridge() {
  // Ask the LimaChild actor to install window.lima (dispatch is synchronous).
  if (!window.lima) window.dispatchEvent(new CustomEvent("LimaInit", { bubbles: true }));
  return window.lima;
}

export const bridge = requestBridge();

// Conditional UI passes null for "nothing here". The DOM would print it as
// the text "null", so Lima pages drop null, undefined and false children.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  for (const name of ["append", "prepend", "replaceChildren"]) {
    const original = proto[name];
    if (original.limaFiltered) continue;
    const filtered = function (...nodes) { return original.apply(this, nodes.filter(node => node !== null && node !== undefined && node !== false)); };
    filtered.limaFiltered = true;
    proto[name] = filtered;
  }
}
for (const name of ["before", "after", "replaceWith"]) {
  const original = Element.prototype[name];
  if (original.limaFiltered) continue;
  const filtered = function (...nodes) { return original.apply(this, nodes.filter(node => node !== null && node !== undefined && node !== false)); };
  filtered.limaFiltered = true;
  Element.prototype[name] = filtered;
}

export function call(method, params) {
  if (!bridge) return Promise.reject({ code: "bridge", message: "Lima bridge unavailable" });
  return bridge.request(method, params ?? null);
}

const listeners = new Set();
bridge?.on(message => { for (const listener of listeners) listener(message); });
/** Subscribe to runtime events; returns an unsubscribe function. */
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

let currentIcon = "lima";
let currentHue = 225;

/** Inline SVG from the shared Prism icon set. */
export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.lima);
  svg.append(path);
  return svg;
}

export const CATEGORY_HUES = { create: 222, navigate: 225, system: 170, media: 330, capture: 30, ai: 268, data: 150, developer: 205 };

export function setPage(title, iconName = "lima", hue) {
  document.title = title;
  if (String(iconName).startsWith("resource://")) {
    document.getElementById("favicon").href = iconName;
    currentIcon = "star";
  } else {
    currentIcon = ICONS[iconName] ? iconName : "lima";
    document.getElementById("favicon").href = `resource://lima-ui/icons/${currentIcon}.svg`;
  }
  if (hue !== undefined) currentHue = hue;
  for (const node of document.querySelectorAll(".bar .title-icon")) node.replaceChildren(icon(currentIcon));
}

export function errorText(error) {
  return error?.message ?? String(error);
}

export function activityStatus() {
  const indicator = el("span", { class: "activity-indicator", "aria-hidden": "true" });
  const label = el("span", { class: "activity-label" });
  const detail = el("span", { class: "activity-detail" });
  const elapsed = el("time", { class: "activity-time", hidden: true, "aria-label": "Elapsed time" });
  const last = el("span", { class: "activity-last", hidden: true });
  const node = el("div", { class: "activity-status" }, indicator,
    el("span", { class: "activity-copy", role: "status", "aria-atomic": "true" }, label, detail), elapsed, last);
  let since;
  let timer;
  function tick() {
    if (!node.isConnected) { clearInterval(timer); timer = undefined; return; }
    if (document.hidden) return;
    const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
    elapsed.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function update({ state, label: title, detail: description = "", icon: glyph = "", motion, startedAt, lastResult }) {
    if (!["working", "starting"].includes(state)) startedAt = undefined;
    node.dataset.activity = state;
    indicator.dataset.motion = motion ?? "";
    if (indicator.dataset.glyph !== glyph) {
      indicator.dataset.glyph = glyph;
      indicator.replaceChildren(...(glyph ? [icon(glyph, "icon tool-glyph")] : []));
    }
    if (label.textContent !== title) label.textContent = title;
    if (detail.textContent !== description) detail.textContent = description;
    detail.hidden = !description;
    const resultText = lastResult ? `Last result: ${lastResult}` : "";
    if (last.textContent !== resultText) last.textContent = last.title = resultText;
    last.hidden = !resultText;
    elapsed.hidden = !startedAt;
    if (startedAt !== since) {
      clearInterval(timer);
      timer = undefined;
      since = startedAt;
    }
    if (since && timer === undefined) {
      timer = setInterval(tick, 1000);
      tick();
    }
  }
  return { node, update };
}

export function filesPrivacyButton(onError) {
  return el("button", { class: "ghost", onclick: () => {
    try { permissionSheet("files"); } catch (error) { onError?.(error); }
  } }, "Allow Files & Folders…");
}

/** Glass page header: icon chip, title, then actions. */
export function bar(title, ...actions) {
  const chip = el("span", { class: "title-icon", style: { "--hue": currentHue } }, icon(currentIcon));
  return el("header", { class: "bar" }, el("h1", {}, chip, title ? el("span", { text: title }) : null), el("div", { class: "spacer" }), ...actions);
}

export const b64 = {
  encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  },
  bytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  },
};

export function relativeTime(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); return fn(...args); };
  return wrapped;
}

export const prefs = {
  get(key, fallback) { try { return localStorage.getItem(`lima.${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`lima.${key}`, value); } catch {} },
};

/** Small, safe Markdown renderer: everything is escaped; links are limited
 * to http(s) and about:lima; images to data:/lima attachments. */
/** An embed in a note. Most sites refuse to be framed, so a web page shows
 * a preview Lima reads natively (title, description, image) with Open Side
 * by Side, which opens the live page next to the note in a Zen split.
 * Players built for embedding (YouTube, Spotify) can also play in place.
 *
 * The card carries no listeners: the editor can insert it as one undoable
 * edit, and `installEmbedActions` handles its buttons by delegation. */
export function noteEmbed(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.username || url.password) return null;
  const player = embedPlayer(url);
  const button = (action, label, extra = {}) => el("button", { type: "button", class: "ghost", "data-embed-action": action, ...extra }, label);
  return el("figure", { class: "note-embed", contenteditable: "false", "data-note-embed": url.href, "data-embed-kind": player ? "player" : "link" },
    el("div", { class: "note-embed-preview" }, el("strong", { class: "note-embed-title", text: url.hostname }),
      el("span", { class: "note-embed-description muted", text: url.href })),
    el("figcaption", {},
      player ? button("play", "Play here") : null,
      button("side", "Open Side by Side"), button("tab", "Open in Tab"),
      el("span", { class: "spacer" }),
      button("remove", "Remove", { title: "Remove embed", "aria-label": "Remove embed" })));
}

function embedPlayer(url) {
  if (url.hostname === "open.spotify.com" && /^\/(track|episode|album|playlist|artist)\//.test(url.pathname)) {
    return `https://open.spotify.com/embed${url.pathname}`;
  }
  const video = ["www.youtube.com", "youtube.com", "youtu.be"].includes(url.hostname)
    ? (url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v")) : null;
  return video && /^[\w-]{11}$/.test(video) ? `https://www.youtube-nocookie.com/embed/${video}` : null;
}

/** Fills each embed in `root` with its native preview (once per card). */
export function hydrateEmbeds(root) {
  for (const card of root.querySelectorAll(".note-embed:not([data-hydrated])")) {
    card.dataset.hydrated = "";
    const preview = card.querySelector(".note-embed-preview");
    call("notes.linkPreview", { url: card.dataset.noteEmbed }).then(data => {
      if (!preview) return;
      preview.replaceChildren(
        data.image ? el("img", { class: "note-embed-image", src: data.image, alt: "" }) : null,
        el("div", { class: "note-embed-text" },
          el("strong", { class: "note-embed-title", text: data.title || new URL(card.dataset.noteEmbed).hostname }),
          data.description ? el("span", { class: "note-embed-description", text: data.description }) : null,
          el("small", { class: "muted", text: data.site || new URL(card.dataset.noteEmbed).hostname })));
    }).catch(() => {
      preview?.querySelector(".note-embed-description")?.replaceChildren("Preview unavailable. Open the page side by side to use it.");
    });
  }
}

let embedActions = false;
/** One delegated handler for every embed's buttons. Remove dispatches
 * `lima-embed-remove` so the editor that owns the card deletes it (with Undo). */
export function installEmbedActions() {
  if (embedActions) return;
  embedActions = true;
  document.addEventListener("mousedown", event => { if (event.target.closest?.("[data-embed-action]")) event.preventDefault(); }, true);
  document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-embed-action]");
    const card = button?.closest(".note-embed");
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    const url = card.dataset.noteEmbed;
    const action = button.dataset.embedAction;
    if (action === "tab") bridge.openTab(url);
    else if (action === "side") bridge.browser("openBeside", { url }).catch(() => bridge.openTab(url));
    else if (action === "remove") card.dispatchEvent(new CustomEvent("lima-embed-remove", { bubbles: true }));
    else if (action === "play") {
      const source = embedPlayer(new URL(url));
      if (!source) return;
      card.querySelector("iframe")?.remove();
      card.querySelector(".note-embed-preview").after(el("iframe", { src: source, title: `Player from ${new URL(url).hostname}`,
        sandbox: "allow-scripts allow-same-origin allow-presentation", allow: "encrypted-media; fullscreen; picture-in-picture",
        referrerpolicy: "strict-origin-when-cross-origin", loading: "lazy" }));
      button.remove();
    }
  });
}

export function replyAuthor(message) {
  if (!message.provider) return null;
  const name = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" }[message.provider] ?? message.provider;
  return el("p", { class: "reply-author muted", text: `${name} · ${message.reportedModel ?? (message.model && message.model !== "default" ? message.model : "Provider default model")}` });
}

export function agentSetupAction(error) {
  if (!["missing_executable", "authentication", "incompatible_version"].includes(error?.kind)) return null;
  return el("button", { type: "button", class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=agents") },
    error.kind === "authentication" ? "Open sign-in setup" : "Open provider setup");
}

function reportCard(source) {
  if (source.length > 28000) return null;
  let report;
  try { report = JSON.parse(source); } catch { return null; }
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const status = { completed: "Completed", failed: "Failed", blocked: "Needs attention" }[report.status] ?? "Task report";
  const fields = [["actionsTaken", "Actions"], ["artifacts", "Artifacts"], ["verification", "Verification"],
    ["remainingIssues", "Remaining issues"], ["nextSteps", "Next steps"]];
  const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
  return el("section", { class: "task-report", "aria-label": "Task report", "data-status": String(report.status ?? "") },
    el("strong", { text: status }), report.summary ? el("p", { text: text(report.summary, 1200) }) : null,
    ...fields.map(([key, label]) => {
      const values = Array.isArray(report[key]) ? report[key].map(value => text(value, 500)).filter(Boolean).slice(0, 30) : [];
      return values.length ? el("div", {}, el("strong", { text: label }), el("ul", {}, values.map(value => el("li", { text: value })))) : null;
    }),
    report.needsUser ? el("p", {}, el("strong", { text: "Your input is needed" }), " ", text(report.needsUser, 600)) : null);
}

/** `breaks`: a single newline is a line break, as in chat replies (Notes keeps
 * Markdown's joined paragraphs). */
export function markdown(source, { onTaskToggle, attachments, embeds = false, breaks = false, taskReports = false } = {}) {
  const root = el("div", { class: "md" });
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const lists = [];
  const closeList = () => { lists.length = 0; };

  while (i < lines.length) {
    const line = lines[i];
    const frame = embeds && /^\s*(?:::embed\s+(\S+)|<iframe\s+[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/iframe>)\s*$/i.exec(line);
    if (frame) {
      const card = noteEmbed(frame[1] ?? frame[2]);
      if (card) { closeList(); root.append(card); i++; continue; }
    }
    // A section laid out in two or three columns:
    // :::columns / … / :::column / … / :::end
    if (/^\s*:::columns\s*$/.test(line)) {
      closeList();
      const columns = [[]];
      i++;
      while (i < lines.length && !/^\s*:::end\s*$/.test(lines[i])) {
        if (/^\s*:::column\s*$/.test(lines[i])) { if (columns.length < 3) columns.push([]); else columns.at(-1).push(""); }
        else columns.at(-1).push(lines[i]);
        i++;
      }
      i++;
      root.append(el("div", { class: "note-columns", "data-columns": String(columns.length) },
        columns.map(column => el("div", { class: "note-column" }, ...markdown(column.join("\n"), { onTaskToggle, attachments, embeds }).childNodes))));
      continue;
    }
    if (/^\s*```/.test(line)) {
      closeList();
      const kind = line.trim().slice(3).trim().toLowerCase();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      const data = code.join("\n");
      if (taskReports && kind === "lima-report") {
        const report = reportCard(data);
        if (report) root.append(report);
        else if (closed) root.append(el("p", { class: "muted", text: "The task report could not be read." }));
      } else root.append((closed && artifactFromBlock(kind, data, el)) || el("pre", {}, el("code", { text: data })));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { closeList(); root.append(inline(el(`h${heading[1].length}`), heading[2], attachments)); i++; continue; }
    if (/^\s*>\s?/.test(line)) { closeList(); root.append(inline(el("blockquote"), line.replace(/^\s*>\s?/, ""), attachments)); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); root.append(el("hr")); i++; continue; }
    const tableSpec = markdownTableAt(lines, i);
    if (tableSpec) {
      closeList();
      const row = (cells, tag) => el("tr", {}, tableSpec.headers.map((_, column) =>
        inline(el(tag, { style: { textAlign: tableSpec.alignment[column] } }), cells[column] ?? "", attachments)));
      const table = el("table", {}, el("thead", {}, row(tableSpec.headers, "th")));
      const body = el("tbody");
      i += 2;
      while (i < lines.length && lines[i].includes("|") && !markdownTableAt(lines, i)) body.append(row(markdownCells(lines[i++]), "td"));
      table.append(body);
      root.append(table);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+\.)\s+(\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const indent = item[1].replace(/\t/g, "    ").length;
      while (lists.length && lists.at(-1).indent > indent) lists.pop();
      if (lists.at(-1)?.indent === indent && lists.at(-1).ordered !== ordered) lists.pop();
      if (!lists.length || lists.at(-1).indent < indent) {
        const node = el(ordered ? "ol" : "ul");
        (lists.at(-1)?.node.lastElementChild ?? root).append(node);
        lists.push({ node, ordered, indent });
      }
      const li = el("li");
      if (item[3] !== undefined) {
        li.className = "task";
        const lineIndex = i;
        const box = el("input", { type: "checkbox", checked: /x/i.test(item[4]), "aria-label": String(item[5] ?? "").replace(/[*_`~]/g, "").trim() || "To-do" });
        if (onTaskToggle) box.addEventListener("change", () => onTaskToggle(lineIndex, box.checked)); else box.disabled = true;
        li.append(box, " ");
      }
      lists.at(-1).node.append(inline(li, item[5], attachments));
      i++;
      continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !markdownTableAt(lines, i) && !/^(#{1,6}\s|\s*```|\s*[-*+]\s|\s*\d+\.\s|\s*>|\s*::embed\s|\s*:::|\s*<iframe\s)/i.test(lines[i])) para.push(lines[i++]);
    if (breaks) {
      const paragraph = el("p");
      para.forEach((text, index) => { if (index) paragraph.append(el("br")); inline(paragraph, text, attachments); });
      root.append(paragraph);
    } else root.append(inline(el("p"), para.join(" "), attachments));
  }
  if (embeds) hydrateEmbeds(root);
  if (root.querySelector(".note-value, .calculator")) wireValues(root);
  return root;
}

/* {{…}} becomes a note value block (rich-content.js); the rest is ordinary inline Markdown. */
function inline(node, text, attachments) {
  text = String(text);
  let last = 0;
  // Code spans are skipped, so `{{x}}` in code stays literal.
  for (const match of text.matchAll(/(`[^`]*`)|\{\{([^{}\n]{1,300})\}\}/g)) {
    if (match[2] === undefined) continue;
    if (match.index > last) inlineText(node, text.slice(last, match.index), attachments);
    node.append(valueChip(match[2], el));
    last = match.index + match[0].length;
  }
  if (!last) return inlineText(node, text, attachments);
  if (last < text.length) inlineText(node, text.slice(last), attachments);
  return node;
}

function inlineText(node, text, attachments) {
  const pattern = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) node.append(text.slice(last, match.index));
    if (match[1]) {
      const src = match[3];
      // ![alt|50%](…) or ![alt|320](…): the image's width.
      const [alt, size] = match[2].split("|");
      const width = /^(?:\d{1,4}|\d{1,3}%)$/.test(size ?? "") ? size : null;
      const sized = img => { if (width) { img.dataset.width = width; img.style.width = width.endsWith("%") ? width : `${width}px`; } return img; };
      if (src.startsWith("lima-attachment:")) {
        const img = sized(el("img", { alt, "data-src": src }));
        attachments?.(src.slice("lima-attachment:".length)).then(url => { img.src = url; }).catch(() => {});
        node.append(img);
      } else if (src.startsWith("data:image/")) {
        node.append(sized(el("img", { alt, src })));
      } else {
        node.append(`[image: ${alt}]`);
      }
    } else if (match[4]) {
      const href = match[6];
      if (/^(https?:|about:lima)/.test(href)) {
        const a = el("a", { href }, match[5]);
        if (href.startsWith("about:lima")) a.addEventListener("click", e => { e.preventDefault(); bridge.openTab(href); });
        else a.target = "_blank";
        node.append(a);
      } else node.append(match[5]);
    } else if (match[7]) node.append(el("code", { text: match[8] }));
    else if (match[9]) node.append(el("strong", { text: match[10] }));
    else if (match[11]) node.append(el("em", { text: match[12] }));
    else if (match[13]) node.append(el("s", { text: match[14] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(text.slice(last));
  return node;
}

/* A guided sheet for one macOS privacy permission. Lima opens the exact
 * System Settings pane itself (no "open this link?" prompt), shows the three
 * steps beside a small picture of the switch to turn on, and, where macOS
 * lets Lima check, ticks itself off once access is granted. */
const PERMISSIONS = {
  accessibility: { title: "Accessibility", browser: "accessibilitySettings", checkable: true,
    why: "Lets the ⌘G grammar helper read and replace the text you select in other apps." },
  files: { title: "Files & Folders", browser: "filesPrivacySettings",
    why: "Lets agents open the project folders you pick, like Documents or Desktop." },
  location: { title: "Location Services", browser: "locationSettings",
    why: "Lets Lima share your approximate location when an agent asks and you agree." },
};

export function permissionSheet(kind, { onGranted } = {}) {
  const spec = PERMISSIONS[kind];
  const status = el("p", { class: "permission-status", role: "status" });
  const toggle = el("span", { class: "permission-switch", "aria-hidden": "true" }, el("i"));
  const picture = el("div", { class: "permission-picture", "aria-hidden": "true" },
    el("div", { class: "permission-window" },
      el("div", { class: "permission-window-bar" }, el("i"), el("i"), el("i"), el("span", { text: "Privacy & Security" })),
      el("div", { class: "permission-pane" },
        el("strong", { text: spec.title }),
        el("div", { class: "permission-app" }, el("span", { class: "permission-app-icon" }), el("span", { text: "Lima" }), toggle),
        el("div", { class: "permission-app dim" }, el("span", { class: "permission-app-icon" }), el("span", { text: "Other app" }), el("span", { class: "permission-switch off" }, el("i"))))));
  const steps = el("ol", { class: "permission-steps" },
    el("li", { text: "Open System Settings. Lima takes you to the right page." }),
    el("li", {}, "Turn on ", el("strong", { text: "Lima" }), spec.checkable ? "." : ". If Lima isn’t listed, use + to add it from Applications."),
    el("li", { text: spec.checkable ? "Come back here. This updates on its own." : "Come back here when you’re done." }));
  let timer;
  const stop = () => clearInterval(timer);
  const close = el("button", { type: "button", class: "ghost", onclick: () => { stop(); dialog.close(); } }, "Done");
  const open = el("button", { type: "button", class: "primary", onclick: async () => {
    status.textContent = "";
    try {
      await bridge.browser(spec.browser, {});
      status.textContent = spec.checkable ? "Waiting for you to turn on Lima…" : "System Settings is open.";
      if (spec.checkable) watch();
    } catch (error) { status.textContent = errorText(error); }
  } }, "Open System Settings");
  const dialog = el("dialog", { class: "permission-sheet", "aria-labelledby": `permission-${kind}` },
    el("div", { class: "permission-copy" },
      el("h2", { id: `permission-${kind}`, text: `Allow ${spec.title}` }),
      el("p", { class: "muted", text: spec.why }), steps, status,
      el("div", { class: "row" }, open, close)),
    picture);
  const granted = () => {
    stop();
    dialog.classList.add("granted");
    status.textContent = `${spec.title} is on. You’re all set.`;
    open.hidden = true;
    close.textContent = "Done";
    onGranted?.();
  };
  async function check() {
    if (!spec.checkable) return false;
    try { return (await call("system.permissions"))?.[kind] === true; } catch { return false; }
  }
  function watch() {
    stop();
    let polls = 0;
    timer = setInterval(async () => {
      if (!dialog.open || ++polls > 150) return stop();
      if (await check()) granted();
    }, 2000);
  }
  dialog.addEventListener("close", () => { stop(); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
  check().then(ok => { if (ok) granted(); });
  return dialog;
}

// A springy settle (about 10% overshoot), as a linear() curve.

/** Shows or hides a composer button with a little pop: it springs out of
 * nothing when it appears and shrinks away when it goes. */
export function popButton(button, show) {
  const leaving = button.dataset.leaving === "true";
  if (show ? !button.hidden && !leaving : button.hidden || leaving) return;
  button.limaPop?.cancel();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (show) {
    delete button.dataset.leaving;
    button.hidden = false;
    if (!reduce) button.limaPop = button.animate([{ opacity: 0, transform: "scale(.55)" }, { opacity: 1, transform: "none" }], { duration: 440, easing: SPRING });
    return;
  }
  if (reduce) { button.hidden = true; return; }
  button.dataset.leaving = "true";
  const animation = button.limaPop = button.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.55)" }],
    { duration: 170, easing: SINK, fill: "forwards" });
  animation.onfinish = () => {
    if (button.limaPop !== animation) return;
    delete button.dataset.leaving;
    button.hidden = true;
    animation.cancel();
  };
}

/** A warning on a reply that changed files outside its workspace folder. */
export function outsideChanges(message) {
  if (!message.outside?.length) return null;
  const home = /^\/Users\/[^/]+/;
  return el("details", { class: "msg-outside", role: "note" },
    el("summary", {}, icon("warning"), `Changed ${message.outside.length} file${message.outside.length === 1 ? "" : "s"} outside this workspace`),
    el("ul", {}, message.outside.map(path => el("li", {}, el("code", { text: path.replace(home, "~") })))));
}

/** Cache original image bytes, with both an entry limit and a byte budget.
 * The image element owns any decoded pixels while it is still on screen. */
export function imageCache(limit = 48, byteBudget = 24 * 1024 * 1024) {
  const entries = new Map();
  let totalBytes = 0;
  const release = (key, entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
    entry.url.then(url => {
      // Give callers already awaiting the same URL time to start loading it.
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    }, () => {});
  };
  const trim = () => {
    while (entries.size > limit || totalBytes > byteBudget) {
      const [key, entry] = entries.entries().next().value;
      release(key, entry);
    }
  };
  return (key, load) => {
    const existing = entries.get(key);
    if (existing) {
      entries.delete(key);
      entries.set(key, existing);
      return existing.url;
    }
    const entry = { bytes: 0, url: null };
    entry.url = Promise.resolve().then(load).then(({ type, data }) => {
      const bytes = Uint8Array.fromBase64(data);
      const blob = new Blob([bytes], { type: type || "image/png" });
      const url = URL.createObjectURL(blob);
      if (entries.get(key) === entry) {
        entry.bytes = blob.size;
        totalBytes += entry.bytes;
        trim();
      }
      return url;
    });
    entry.url.catch(() => release(key, entry));
    entries.set(key, entry);
    trim();
    return entry.url;
  };
}
