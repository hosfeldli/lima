import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFormula, formatValue, parseValueSource, valueSource } from "../overlay/lima/ui/rich-content.js";

test("formulas compare, branch and combine", () => {
  assert.equal(evaluateFormula("if(guests > 8 and vegan, 2, 1)", { guests: 10, vegan: 1 }), 2);
  assert.equal(evaluateFormula("guests >= 8 or not(vegan)", { guests: 2, vegan: 1 }), 0);
  assert.equal(evaluateFormula("0.1 + 0.2 == 0.3", {}), 1, "comparisons forgive float rounding");
  assert.equal(evaluateFormula("sum(1, 2, 3) + avg(2, 4) + clamp(15, 0, 10) + pct(1, 4)", {}), 6 + 3 + 10 + 25);
  assert.equal(evaluateFormula("round(pi, 2)", {}), 3.14);
  assert.equal(evaluateFormula("yes + no", {}), 1);
  assert.equal(evaluateFormula("-2^2", {}), -4);
});

test("formula errors say what's wrong", () => {
  assert.throws(() => evaluateFormula("budget / guests", { budget: 1 }), /Nothing is named “guests”/);
  assert.throws(() => evaluateFormula("frobnicate(2)", {}), /No function named “frobnicate”/);
  assert.throws(() => evaluateFormula("1 / 0", {}), /isn't a number/);
  assert.throws(() => evaluateFormula("2 +", {}), /ends too soon/);
  assert.throws(() => evaluateFormula("2 $ 3", {}), /Can't read/);
});

test("value blocks parse into inputs and results", () => {
  assert.deepEqual(parseValueSource("guests := 20 in 1..12"), { kind: "slider", name: "guests", value: 12, min: 1, max: 12, step: 1 });
  assert.deepEqual(parseValueSource("vegan := on"), { kind: "toggle", name: "vegan", value: 1 });
  const choice = parseValueSource("size := large in small=1, large=2.5");
  assert.equal(choice.kind, "choice");
  assert.equal(choice.value, 2.5);
  assert.equal(valueSource(choice, "small"), "size := small in small=1, large=2.5");
  assert.equal(parseValueSource("size := huge in small=1, large=2").value, 1, "an unknown choice falls back to the first");
  assert.deepEqual(parseValueSource("each = budget / guests as $"), { kind: "result", name: "each", formula: "budget / guests", format: "$" });
  assert.deepEqual(parseValueSource("a == b"), { kind: "result", name: null, formula: "a == b", format: "" });
  assert.equal(parseValueSource("x * 2 as nonsense words here").format, "", "an unreadable format stays part of the formula");
  assert.equal(valueSource(parseValueSource("n := 3 in 0..10 step 0.5"), 4), "n := 4 in 0..10 step 0.5");
});

test("results format as money, percent, decimals and units", () => {
  assert.equal(formatValue(1234.5, "$"), "$1,234.50");
  assert.equal(formatValue(-5, "€"), "−€5.00");
  assert.equal(formatValue(12.345, "%"), "12.35%");
  assert.equal(formatValue(3.14159, "0.0 kg"), "3.1 kg");
  assert.equal(formatValue(7.6, "int"), "8");
  assert.equal(formatValue(2.5, ""), "2.5");
});
