/* Universal Search ranking: pure functions and the ResultSet that decides
 * what the panel shows. No Gecko APIs, so `browser/tests` runs it in Node.
 *
 * Rules (docs/spec/universal-search.md §4–§6, §12):
 * - Best Match is computed synchronously from the query alone: an explicit
 *   URL opens first, otherwise "Search with <engine>" is first. Local and
 *   remote sources never take row one, so Enter is predictable.
 * - At most one AI suggestion (Ask Lima or Delegate Task) joins Best Match,
 *   after the ordinary result, and only above a confidence threshold.
 * - Tabs, bookmarks and history pointing at the same page merge into one row.
 * - Eight rows show at first; the rest sit behind "Show more".
 * - Once the user moves the selection, the visible rows are frozen: later
 *   results only add to the hidden overflow or append below everything. */

export const INITIAL_LIMIT = 8;
export const EXPANDED_LIMIT = 40;
export const EMPTY_LIMIT = 4;
export const AI_THRESHOLD = 0.6;
const WEB_RESERVE = 2;

export const SECTIONS = [
  { id: "best", title: "Best Match" },
  { id: "local", title: "Your Browser & Lima" },
  { id: "web", title: "Web Suggestions" },
];

export const TARGETS = ["page", "tabs", "workspace", "notes", "files"];
const TARGET_PATTERN = new RegExp(`(^|\\s)@(${TARGETS.join("|")})(?=\\s|$)`, "i");

/** Splits an explicit `@target` from the query text. */
export function parseQuery(raw) {
  const value = String(raw ?? "");
  const match = value.match(TARGET_PATTERN);
  if (!match) return { text: value.trim(), target: null };
  const text = (value.slice(0, match.index) + match[1] + value.slice(match.index + match[0].length)).replace(/\s+/g, " ").trim();
  return { text, target: match[2].toLowerCase() };
}

export function looksLikeURL(text) {
  if (!text || /\s/.test(text)) return false;
  return /^[a-z][\w+.-]*:\/\//i.test(text) ||
    /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(text) ||
    /^[\w-]+(\.[\w-]+)*\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(text);
}

/** The address Enter opens for URL-like input, or null. */
export function navigationURL(text) {
  if (!looksLikeURL(text)) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][\w+.-]*:\/\//i.test(text)) return null;
  return /^(localhost|127\.0\.0\.1)(?=[:/]|$)/i.test(text) ? `http://${text}` : `https://${text}`;
}

const WH = /^(what|who|whom|whose|why|how|when|where|which)\b/i;
const AUX = /^(is|are|was|were|can|could|does|do|did|should|would|will|has|have|may|might)\b/i;
const ASK_VERB = /^(explain|define|summarize|summarise|tell me|translate)\b/i;
const TASK_VERB = /^(research|create|build|make|write|draft|plan|organize|organise|refactor|fix|implement|migrate|analyze|analyse|automate|prepare|review|set up|clean up|investigate|compile|collect|find and|compare and|update|debug)\b/i;

/** Confidence (0–1) that a query is a question for Lima or a task to delegate.
 * Single words, URLs and short phrases never qualify. */
export function aiIntent(text) {
  const query = String(text ?? "").trim();
  const words = query ? query.split(/\s+/).length : 0;
  if (words < 2 || looksLikeURL(query)) return { ask: 0, task: 0 };
  const lima = /\blima\b/i.test(query);
  const body = query.replace(/^(hey\s+|ask\s+)?lima[,:]?\s*/i, "");
  let ask = 0;
  let task = 0;
  if (/\?\s*$/.test(query)) ask += 0.55;
  if (WH.test(body)) {
    ask += 0.4;
    if (AUX.test(body.replace(WH, "").trim())) ask += 0.2;
  } else if (AUX.test(body)) ask += 0.4;
  if (ASK_VERB.test(body)) ask += 0.45;
  if (words >= 4) ask += 0.15;
  if (lima) ask += 0.6;
  if (TASK_VERB.test(body)) task += 0.45;
  if (words >= 4) task += 0.2;
  if (/\b(and then|then|and also|after that|step by step)\b|,\s*and\b/i.test(body)) task += 0.2;
  if (/\bfor me\b/i.test(body)) task += 0.1;
  if (words < 3) task = Math.min(task, 0.4);
  if (task >= AI_THRESHOLD && TASK_VERB.test(body)) ask = Math.min(ask, task - 0.05);
  const clamp = value => Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  return { ask: clamp(ask), task: clamp(task) };
}

/** The one AI suggestion Best Match may carry: "ask", "delegate" or null. */
export function aiSuggestion(text) {
  const { ask, task } = aiIntent(text);
  if (Math.max(ask, task) < AI_THRESHOLD) return null;
  return task > ask ? "delegate" : "ask";
}

/** Text relevance from 0 to 100: exact, prefix, word prefix, substring. */
export function matchScore(query, title = "", url = "") {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return 0;
  const t = String(title ?? "").toLowerCase();
  const host = hostOf(url);
  if (t === q || host === q || host === `${q}.com`) return 100;
  if (t.startsWith(q) || host.startsWith(q)) return 80;
  if (t.split(/[\s\-_/.:|·]+/).some(word => word.startsWith(q))) return 62;
  if (t.includes(q)) return 45;
  if (String(url ?? "").toLowerCase().includes(q)) return 30;
  const terms = q.split(/\s+/);
  if (terms.length > 1 && terms.every(term => t.includes(term) || String(url ?? "").toLowerCase().includes(term))) return 38;
  return 0;
}

function hostOf(url) {
  const match = String(url ?? "").toLowerCase().match(/^[a-z][\w+.-]*:\/\/(?:www\.)?([^/:?#]+)/);
  return match?.[1] ?? "";
}

/** Key used to merge rows that point at the same page. */
export function normalizeURL(url) {
  if (!url) return null;
  return String(url).trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/#.*$/, "")
    .replace(/\/(index\.html?)?$/, "") || null;
}

const KIND_BONUS = { tab: 14, workspace: 12, bookmark: 9, note: 8, command: 8, app: 7, chat: 6, file: 5, history: 0, other: 0 };
const KIND_RANK = { tab: 3, bookmark: 2, history: 1 };
const KIND_LABEL = { tab: "Open tab", bookmark: "Bookmarked", history: "History" };
const DAY = 86_400_000;

/** One local candidate's score. `item.score` (from the native index) counts
 * as relevance when the text match can't be computed locally. */
export function scoreItem(query, item, now = Date.now()) {
  let relevance = matchScore(query, item.title, item.url);
  if (!relevance && Number.isFinite(item.score)) relevance = Math.min(70, Math.max(20, item.score / 15));
  if (!relevance) return 0;
  let score = relevance + (KIND_BONUS[item.kind] ?? 0);
  if (item.inCurrentWorkspace) score += 8;
  if (item.lastUsed) score += Math.max(0, 10 - ((now - item.lastUsed) / DAY) * 2);
  if (item.frecency) score += Math.min(8, Math.log10(item.frecency + 1) * 2);
  if (Number.isFinite(item.score) && item.score >= 1000) score += 30;
  return Math.round(score * 10) / 10;
}

/** Merges tabs, bookmarks and history for the same page into one row:
 * the open tab wins, and its subtitle names every source. */
export function dedupe(items) {
  const byURL = new Map();
  const out = [];
  for (const item of items) {
    const key = KIND_RANK[item.kind] ? normalizeURL(item.url) : null;
    const existing = key && byURL.get(key);
    if (!existing) {
      const copy = { ...item, sources: KIND_RANK[item.kind] ? [item.kind] : [] };
      if (key) byURL.set(key, copy);
      out.push(copy);
      continue;
    }
    const sources = [...new Set([...existing.sources, item.kind])];
    const winner = (KIND_RANK[item.kind] ?? 0) > (KIND_RANK[existing.kind] ?? 0) ? item : existing;
    Object.assign(existing, { ...winner, sources, rank: Math.max(existing.rank ?? 0, item.rank ?? 0),
      lastUsed: Math.max(existing.lastUsed ?? 0, item.lastUsed ?? 0) || undefined,
      frecency: Math.max(existing.frecency ?? 0, item.frecency ?? 0) || undefined,
      inCurrentWorkspace: existing.inCurrentWorkspace || item.inCurrentWorkspace });
  }
  for (const item of out) if (item.sources.length > 1) item.subtitle = mergedSubtitle(item);
  return out;
}

function mergedSubtitle(item) {
  const labels = item.sources.sort((a, b) => KIND_RANK[b] - KIND_RANK[a]).map(kind => KIND_LABEL[kind]);
  const where = item.kind === "tab" && item.group ? `Tab in ${item.group}` : labels[0];
  return [where, ...labels.slice(1).filter(label => label !== "History")].join(" · ");
}

/** Scores, merges and orders local candidates. Ties keep arrival order. */
export function rankLocal(query, items, now = Date.now()) {
  const scored = items.map((item, index) => ({ ...item, rank: scoreItem(query, item, now), arrival: index })).filter(item => item.rank > 0);
  return dedupe(scored).sort((a, b) => b.rank - a.rank || a.arrival - b.arrival);
}

/** Empty query: the last meaningful destinations, at most four. Unfinished
 * work (a running chat) outranks plain recency. */
export function recentDestinations(items, limit = EMPTY_LIMIT, now = Date.now()) {
  const seen = new Set();
  return items
    .filter(item => item.when && item.title)
    .map(item => ({ ...item, weight: item.when + (item.unfinished ? 3 * DAY : 0) + (item.kind === "workspace" ? DAY / 4 : 0) }))
    .sort((a, b) => b.weight - a.weight)
    .filter(item => {
      const key = normalizeURL(item.url) ?? item.key;
      if (seen.has(key)) return false;
      seen.add(key);
      return now - item.when < 30 * DAY || item.unfinished;
    })
    .slice(0, limit);
}

/** Holds one query's results and decides which rows are visible. */
export class ResultSet {
  constructor(query = "", { webExpected = true, limit = INITIAL_LIMIT } = {}) {
    this.query = query;
    this.limit = limit;
    this.best = [];
    this.pool = [];
    this.local = [];
    this.web = [];
    this.webExpected = webExpected;
    this.expanded = false;
    this.frozen = null;
  }

  setBest(items) { this.best = items.slice(0, 3); }

  addLocal(items, now = Date.now()) {
    this.pool.push(...items);
    this.local = rankLocal(this.query, this.pool, now);
  }

  setWeb(items) {
    const shown = new Set([...this.best, ...this.local].map(item => item.title?.toLowerCase()));
    this.web = items.filter(item => !shown.has(item.title?.toLowerCase()));
    this.webExpected = false;
  }

  webDone() { this.webExpected = false; }

  expand() {
    this.expanded = true;
    this.frozen = null;
  }

  /** Called when the user moves the selection: what's visible stays put. */
  freeze() {
    if (!this.frozen) this.frozen = this.layout().sections.flatMap(section => section.items.map(item => item.key));
  }

  layout() {
    const cap = this.expanded ? EXPANDED_LIMIT : this.limit;
    const best = this.best.slice(0, cap);
    const room = cap - best.length;
    // Keep up to two rows for web suggestions (even while they're loading),
    // so their arrival fills reserved space instead of pushing rows around.
    const wanted = this.web.length ? Math.min(this.web.length, WEB_RESERVE) : this.webExpected ? WEB_RESERVE : 0;
    const reserve = this.expanded ? 0 : Math.min(wanted, room);
    let local = this.local.slice(0, Math.max(0, room - reserve));
    let web = this.web.slice(0, Math.max(0, room - local.length));

    if (this.frozen) {
      const visible = new Set(this.frozen);
      const keep = list => list.filter(item => visible.has(item.key));
      local = keep(this.local).sort((a, b) => this.frozen.indexOf(a.key) - this.frozen.indexOf(b.key));
      // Web Suggestions is the last section, so new ones can only append below.
      const kept = keep(this.web);
      const spare = Math.max(0, cap - best.length - local.length - kept.length);
      web = [...kept, ...this.web.filter(item => !visible.has(item.key)).slice(0, spare)];
    }

    // `titles` renames sections for a view that isn't a query (the empty
    // panel: "Start" and "Recent").
    const sections = [
      { ...SECTIONS[0], title: this.titles?.[0] ?? SECTIONS[0].title, items: best },
      { ...SECTIONS[1], title: this.titles?.[1] ?? SECTIONS[1].title, items: local },
      { ...SECTIONS[2], items: web },
    ].filter(section => section.items.length);
    const shown = sections.reduce((sum, section) => sum + section.items.length, 0);
    const total = best.length + this.local.length + this.web.length;
    // A single section needs no heading; Best Match alone never needs one.
    const headings = sections.length > 1;
    return { sections, headings, hidden: Math.max(0, total - shown) };
  }
}
