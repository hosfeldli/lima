/* Universal Search ranking benchmark (docs/spec/universal-search.md §11–§12).
 *
 *   node browser/tests/search-bench.mjs [--tabs 1000] [--history 50000] [--streams 20]
 *
 * Ranks a large candidate pool (open tabs, a history page far larger than the
 * 12 rows Places returns, Lima index hits) for typed prefixes of real-looking
 * queries, while simulated AI streams deliver deltas on the same event loop.
 * Reports p50/p95 per keystroke and fails if p95 exceeds the 75 ms local-update
 * budget. Gecko layout and Places I/O are outside this measurement; the
 * Marionette smoke test (browser/scripts/source_smoke.py) records panel open
 * time in the running browser. */

import { ResultSet, aiSuggestion, navigationURL, parseQuery } from "../overlay/lima/ui/search-ranking.sys.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? Number(process.argv[index + 1]) : fallback;
};
const TABS = arg("tabs", 1000);
const HISTORY = arg("history", 50_000);
const STREAMS = arg("streams", 20);
// The budget is for a typical Mac. Shared CI runners are slower, so the
// budget scales with a fixed calibration workload timed on the same machine:
// a real regression still fails, a slow runner alone doesn't.
const BASE_BUDGET_MS = 75;
const REFERENCE_CALIBRATION_MS = 17; // measured on an Apple silicon Mac (M-series), where the 75 ms budget was set
function calibrate() {
  const start = performance.now();
  let sink = 0;
  for (let round = 0; round < 3; round++) {
    const words = Array.from({ length: 60000 }, (_, i) => `item-${(i * 2654435761) % 100003}`);
    words.sort();
    for (const word of words) sink += word.charCodeAt(word.length - 1);
  }
  return { ms: (performance.now() - start) / 3, sink };
}
calibrate();
const calibration = Math.min(...[0, 1, 2].map(() => calibrate().ms));
const BUDGET_MS = Math.round(BASE_BUDGET_MS * Math.max(1, calibration / REFERENCE_CALIBRATION_MS));
const NOW = Date.now();

let seed = 7;
const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const pick = list => list[Math.floor(random() * list.length)];
const WORDS = ["github", "docs", "lima", "browser", "design", "plan", "invoice", "calendar", "mail", "release", "notes", "search",
  "swift", "gecko", "zen", "workspace", "tokyo", "flights", "recipe", "budget", "report", "meeting", "agent", "terminal"];
const HOSTS = ["github.com", "developer.apple.com", "news.ycombinator.com", "mail.google.com", "docs.rs", "mozilla.org", "zen-browser.app", "example.com"];
const page = index => {
  const host = pick(HOSTS);
  const path = `${pick(WORDS)}/${pick(WORDS)}-${index}`;
  return { url: `https://${host}/${path}`, title: `${pick(WORDS)} ${pick(WORDS)} — ${host}` };
};

const tabs = Array.from({ length: TABS }, (_, index) => ({ key: `tab:${index}`, kind: "tab", ...page(index),
  lastUsed: NOW - random() * 30 * 86_400_000, inCurrentWorkspace: random() < 0.2 }));
const history = Array.from({ length: HISTORY }, (_, index) => ({ key: `hist:${index}`, kind: random() < 0.1 ? "bookmark" : "history",
  ...(random() < 0.05 ? tabs[Math.floor(random() * tabs.length)] : page(index + TABS)), frecency: Math.floor(random() * 5000),
  lastUsed: NOW - random() * 365 * 86_400_000 }));
const lima = Array.from({ length: 18 }, (_, index) => ({ key: `lima:${index}`, kind: pick(["note", "chat", "command", "file"]),
  title: `${pick(WORDS)} ${pick(WORDS)}`, score: random() * 900 }));
const QUERIES = ["github", "lima docs", "what is gecko?", "plan tokyo flights and then book", "mozilla.org", "@tabs mail", "budget report",
  "release notes", "zen", "agent terminal"];

// Concurrent AI work: many streams posting small deltas as fast as timers allow.
let delivered = 0;
let streaming = true;
for (let stream = 0; stream < STREAMS; stream++) {
  (function tick() {
    if (!streaming) return;
    delivered += "token ".repeat(8).length;
    setTimeout(tick, 1);
  })();
}

const timings = [];
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
for (let round = 0; round < 3; round++) {
  for (const full of QUERIES) {
    for (let length = 1; length <= full.length; length++) {
      const raw = full.slice(0, length);
      const started = performance.now();
      const { text, target } = parseQuery(raw);
      navigationURL(text);
      aiSuggestion(text);
      const set = new ResultSet(text, { webExpected: !target });
      set.setBest([{ key: "web", title: text }]);
      // Sources arrive separately, as in the panel; each arrival re-lays out.
      set.addLocal(tabs, NOW);
      set.layout();
      set.addLocal(lima, NOW);
      set.layout();
      set.addLocal(target ? [] : history, NOW);
      set.layout();
      timings.push(performance.now() - started);
      await yieldToLoop();
    }
  }
}
streaming = false;

timings.sort((a, b) => a - b);
const percentile = p => timings[Math.min(timings.length - 1, Math.floor((p / 100) * timings.length))];
const report = {
  candidates: TABS + HISTORY + lima.length, keystrokes: timings.length, concurrentStreams: STREAMS, streamedBytes: delivered,
  p50Ms: +percentile(50).toFixed(2), p95Ms: +percentile(95).toFixed(2), maxMs: +timings.at(-1).toFixed(2), budgetMs: BUDGET_MS, calibrationMs: +calibration.toFixed(2),
};
console.log(JSON.stringify(report, null, 2));
if (report.p95Ms > BUDGET_MS) {
  console.error(`p95 ${report.p95Ms} ms exceeds the ${BUDGET_MS} ms local-update budget`);
  process.exit(1);
}
