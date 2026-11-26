import assert from "node:assert/strict";
import test from "node:test";
import { releaseSections, sectionArt, topicOf } from "../overlay/lima/ui/whatsnew-art.sys.mjs";

test("release notes become one section per commit, without version bumps or trailers", () => {
  const notes = "## Faster notes scripting\n\n- Sliders and switches\nCo-Authored-By: Someone <x@y>\n\n## Bump Lima version to 5.0.11\n\n## Fix the sidebar gap";
  const sections = releaseSections(notes);
  assert.deepEqual(sections.map(section => section.title), ["Faster notes scripting", "Fix the sidebar gap"]);
  assert.deepEqual(sections[0].body, ["- Sliders and switches"]);
  assert.equal(sections[0].topic, "notes");
  assert.equal(releaseSections("- Search ranks what you open\n- Bump Lima version to 5.0.9").length, 1, "older bullet notes still work");
});

test("each change gets its own deterministic illustration", () => {
  const a = sectionArt("Smaller updates with chunks");
  assert.equal(a.topic, "updates");
  assert.equal(sectionArt("Smaller updates with chunks").svg, a.svg, "the same title draws the same picture");
  assert.notEqual(sectionArt("Search learns from you").svg, a.svg);
  assert.match(a.svg, /^<svg [^>]*viewBox="0 0 280 150"/);
  assert.doesNotMatch(sectionArt("<script>alert(1)</script> notes").svg, /script/, "note text never goes into the drawing");
  assert.equal(topicOf("Backups, export and problem reports"), "safety");
  assert.equal(topicOf("Something else entirely"), "sparkle");
});
