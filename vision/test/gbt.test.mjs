// The compact tree evaluator (train/gbt.mjs) on a hand-built model: numeric and categorical splits, leaf indices,
// a single-leaf tree, and the sigmoid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepare, score } from "../train/gbt.mjs";

const model = prepare({
  format: "genclass-gbt-1",
  inputs: ["a", "b"],
  base: 0,
  cats: [[2, 5]],
  trees: [
    // node 0: a <= 1.5 ? node 1 : leaf 2; node 1: b in {2, 5} ? leaf 0 : leaf 1
    [0, 1.5, 1, -3, -2, 0, -1, -2],
    // a single-leaf tree
    [0, 1e300, -1, -1],
  ],
  leaves: [[1, -1, 0.5], [0.25]],
});

const sig = (s) => 1 / (1 + Math.exp(-s));

test("numeric split goes left on <= and right above", () => {
  assert.equal(score(model, [1.5, 2]), sig(1 + 0.25));
  assert.equal(score(model, [1.6, 2]), sig(0.5 + 0.25));
});

test("categorical split needs a whole number in the set", () => {
  assert.equal(score(model, [0, 5]), sig(1 + 0.25));
  assert.equal(score(model, [0, 3]), sig(-1 + 0.25));
  assert.equal(score(model, [0, 2.5]), sig(-1 + 0.25));
  assert.equal(score(model, [0, -2]), sig(-1 + 0.25));
});
