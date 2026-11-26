import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_THRESHOLD, EXPANDED_LIMIT, INITIAL_LIMIT, ResultSet, aiIntent, aiSuggestion, dedupe, matchScore,
  navigationURL, normalizeURL, parseQuery, rankLocal, recentDestinations,
} from "../overlay/lima/ui/search-ranking.sys.mjs";

const NOW = Date.UTC(2026, 10, 23);
const keys = set => set.layout().sections.flatMap(section => section.items.map(item => item.key));
const local = (key, title, extra = {}) => ({ key, kind: "note", title, ...extra });
const best = text => [{ key: "web", title: text }];

test("URLs open directly and only real addresses count as URLs", () => {
  assert.equal(navigationURL("example.com"), "https://example.com");
  assert.equal(navigationURL("github.com/lima/browser?x=1"), "https://github.com/lima/browser?x=1");
  assert.equal(navigationURL("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(navigationURL("http://192.168.0.1"), "http://192.168.0.1");
  assert.equal(navigationURL("https://lima.dev"), "https://lima.dev");
  for (const text of ["github", "what is lima", "node.js tutorial", "file:///etc/passwd", "javascript:alert(1)", "v1.2"]) {
    assert.equal(navigationURL(text), null, text);
  }
});

test("ordinary searches never surface AI", () => {
  for (const text of ["github", "weather", "best pizza near me", "how to cook rice", "python list comprehension", "fix", "news today"]) {
    assert.equal(aiSuggestion(text), null, text);
  }
});

test("questions and explicit Lima references offer Ask Lima", () => {
  for (const text of ["what is the capital of norway", "is it going to rain tomorrow?", "lima summarize my day", "explain quantum tunnelling simply"]) {
    assert.equal(aiSuggestion(text), "ask", text);
    assert.ok(aiIntent(text).ask >= AI_THRESHOLD);
  }
});

test("multi-step work offers delegation, never both suggestions", () => {
  for (const text of ["research flights to tokyo and make a plan", "write a cover letter for my job application", "organize my downloads, and then summarize them"]) {
    assert.equal(aiSuggestion(text), "delegate", text);
  }
  assert.equal(aiSuggestion("create note"), null);
});

test("explicit @targets are stripped from the query wherever they appear", () => {
  assert.deepEqual(parseQuery("@tabs github"), { text: "github", target: "tabs" });
  assert.deepEqual(parseQuery("meeting @notes"), { text: "meeting", target: "notes" });
  assert.deepEqual(parseQuery("summarize @page this"), { text: "summarize this", target: "page" });
  assert.deepEqual(parseQuery("email me@tabs.com"), { text: "email me@tabs.com", target: null });
  assert.deepEqual(parseQuery("  plain  "), { text: "plain", target: null });
});

test("exact matches outrank prefixes, word prefixes and substrings", () => {
  assert.ok(matchScore("github", "GitHub") > matchScore("github", "GitHub Desktop"));
  assert.ok(matchScore("hub", "Git Hub page") > matchScore("hub", "GitHub"));
  assert.ok(matchScore("hub", "GitHub") > matchScore("hub", "Example", "https://example.com/hub"));
  assert.equal(matchScore("github", "Home", "https://github.com/"), 100);
  assert.equal(matchScore("zzz", "GitHub"), 0);
});

test("tabs, bookmarks and history for one page merge into a single tab row", () => {
  const merged = dedupe([
    { key: "hist:a", kind: "history", title: "Docs", url: "https://www.example.com/docs/", frecency: 900 },
    { key: "tab:1", kind: "tab", title: "Docs", url: "https://example.com/docs#intro", lastUsed: NOW },
    { key: "bm:a", kind: "bookmark", title: "Docs", url: "http://example.com/docs" },
    { key: "note:1", kind: "note", title: "Docs" },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].key, "tab:1");
  assert.equal(merged[0].subtitle, "Open tab · Bookmarked");
  assert.equal(merged[0].frecency, 900);
  assert.equal(normalizeURL("HTTPS://www.Example.com/docs/index.html#x"), "example.com/docs");
});

test("open tabs, current-workspace items and recent use rank higher", () => {
  const ranked = rankLocal("plan", [
    { key: "h", kind: "history", title: "Plan" },
    { key: "t", kind: "tab", title: "Plan" },
    { key: "w", kind: "tab", title: "Plan", inCurrentWorkspace: true },
    { key: "old", kind: "note", title: "Plan", lastUsed: NOW - 90 * 86_400_000 },
    { key: "new", kind: "note", title: "Plan", lastUsed: NOW },
  ], NOW).map(item => item.key);
  assert.equal(ranked[0], "w");
  assert.ok(ranked.indexOf("t") < ranked.indexOf("old"));
  assert.ok(ranked.indexOf("new") < ranked.indexOf("old"));
  assert.equal(ranked.at(-1), "h");
});

test("equal scores keep arrival order, so ranking is deterministic", () => {
  const items = Array.from({ length: 6 }, (_, index) => local(`n${index}`, "Same title"));
  assert.deepEqual(rankLocal("same", items, NOW).map(item => item.key), items.map(item => item.key));
});

test("at most eight rows show, with the rest behind Show more", () => {
  const set = new ResultSet("note", { webExpected: false });
  set.setBest(best("note"));
  set.addLocal(Array.from({ length: 20 }, (_, index) => local(`n${index}`, `Note ${index}`)), NOW);
  const { sections, hidden } = set.layout();
  assert.equal(sections.reduce((sum, section) => sum + section.items.length, 0), INITIAL_LIMIT);
  assert.equal(hidden, 21 - INITIAL_LIMIT);
  set.expand();
  assert.equal(keys(set).length, 21);
  assert.ok(keys(set).length <= EXPANDED_LIMIT);
});

test("headings appear only when more than one category is visible", () => {
  const set = new ResultSet("x", { webExpected: false });
  set.setBest(best("x"));
  assert.equal(set.layout().headings, false);
  assert.deepEqual(set.layout().sections.map(section => section.id), ["best"]);
  set.addLocal([local("n", "x note")], NOW);
  assert.equal(set.layout().headings, true);
  assert.deepEqual(set.layout().sections.map(section => section.title), ["Best Match", "Your Browser & Lima"]);
});

test("late web suggestions fill reserved rows below local results", () => {
  const set = new ResultSet("lima", { webExpected: true });
  set.setBest(best("lima"));
  set.addLocal(Array.from({ length: 12 }, (_, index) => local(`n${index}`, `lima ${index}`)), NOW);
  const before = keys(set);
  set.setWeb([{ key: "s1", title: "lima peru" }, { key: "s2", title: "lima beans" }, { key: "s3", title: "lima ohio" }]);
  const after = keys(set);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(-2), ["s1", "s2"]);
  assert.equal(after.length, INITIAL_LIMIT);
});

test("web suggestions that repeat a visible title are dropped", () => {
  const set = new ResultSet("lima", { webExpected: true });
  set.setBest(best("lima"));
  set.addLocal([local("n", "Lima Beans")], NOW);
  set.setWeb([{ key: "s1", title: "lima beans" }, { key: "s2", title: "lima peru" }]);
  assert.deepEqual(set.web.map(item => item.key), ["s2"]);
});

test("after the user moves the selection, new results never appear above it", () => {
  const set = new ResultSet("plan", { webExpected: true });
  set.setBest(best("plan"));
  set.addLocal([local("a", "plan a"), local("b", "plan b")], NOW);
  set.freeze();
  const frozen = keys(set);
  const selectedIndex = frozen.indexOf("b");
  // A better-scoring local match arrives late.
  set.addLocal([{ key: "tab", kind: "tab", title: "Plan", inCurrentWorkspace: true, lastUsed: NOW }], NOW);
  set.setWeb([{ key: "s1", title: "plan b ideas" }]);
  const after = keys(set);
  assert.equal(after.indexOf("b"), selectedIndex);
  assert.deepEqual(after.slice(0, frozen.length), frozen);
  assert.ok(!after.includes("tab"), "late local results wait in the overflow");
  assert.equal(after.at(-1), "s1", "web suggestions append below everything");
  assert.equal(set.layout().hidden, 1);
});

test("Best Match is never replaced by a late local result", () => {
  const set = new ResultSet("github", { webExpected: false });
  set.setBest([{ key: "nav:https://github.com" }, { key: "web" }]);
  set.addLocal([{ key: "tab", kind: "tab", title: "github", url: "https://github.com", lastUsed: NOW, inCurrentWorkspace: true }], NOW);
  assert.deepEqual(keys(set).slice(0, 2), ["nav:https://github.com", "web"]);
});

test("the empty state shows at most four recent destinations, unfinished work first", () => {
  const recent = recentDestinations([
    { key: "t1", kind: "tab", title: "Mail", url: "https://mail.example.com", when: NOW - 1000 },
    { key: "t2", kind: "tab", title: "Mail again", url: "https://mail.example.com/", when: NOW - 2000 },
    { key: "n1", kind: "note", title: "Ideas", when: NOW - 5000 },
    { key: "c1", kind: "chat", title: "Refactor", when: NOW - 86_400_000, unfinished: true },
    { key: "w1", kind: "workspace", title: "Launch", when: NOW - 60_000 },
    { key: "n2", kind: "note", title: "Old", when: NOW - 60 * 86_400_000 },
    { key: "n3", kind: "note", title: "Later", when: NOW - 9000 },
  ], 4, NOW).map(item => item.key);
  assert.equal(recent.length, 4);
  assert.equal(recent[0], "c1");
  assert.ok(!recent.includes("t2"), "duplicates of one page are merged");
  assert.ok(!recent.includes("n2"), "stale items are left out");
});

test("a late tab for a selected note preserves the note row and its destination", () => {
  const set = new ResultSet("plan", { webExpected: false });
  const url = "about:lima?note=a";
  const note = { ...local("n", "Weekend plan"), url, kind: "note", subtitle: "Plan a hike", highlights: ["plan"] };
  set.addLocal([note], NOW);
  set.freeze();
  set.addLocal([{ ...local("t", "Weekend plan"), kind: "tab", url }], NOW);
  const rows = set.layout().sections.flatMap(section => section.items);
  assert.deepEqual(rows.map(row => [row.key, row.kind, row.subtitle]), [["n", "note", "Plan a hike"]]);
  set.expand();
  assert.deepEqual(set.layout().sections.flatMap(section => section.items).map(row => row.kind), ["tab"]);
});
