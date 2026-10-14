// The v2 detector bundle (train/detect_v2.mjs) on hand-built models: a check filter only scores elements its
// checks flagged, a model that reads rule bits gets them appended, and a stack combines logits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, load, scores } from "../train/detect_v2.mjs";

const stump = (inputs, f, t, lo, hi) => ({ format: "genclass-gbt-1", inputs, base: 0, cats: [],
  trees: [[f, t, -1, -2]], leaves: [[lo, hi]] });
const sig = (s) => 1 / (1 + Math.exp(-s));
const logit = (p) => Math.log(p / (1 - p));

const bundle = () => load({
  format: "genclass-visual-2",
  inputs: ["a", "b"],
  ruleInputs: ["rule_image_broken", "rule_page_overflow_x"],
  rules: ["image-broken", "page-overflow-x"],
  models: {
    m: stump(["a", "b"], 0, 0.5, -2, 2), // a <= 0.5 -> sigmoid(-2), else sigmoid(2)
    lab: stump(["a", "b", "rule_image_broken", "rule_page_overflow_x"], 3, 0.5, -1, 1), // reads the second rule bit
  },
  detectors: [
    { family: "media", kind: "check-filter", checks: ["image-broken"], models: ["m"], coef: [1], intercept: 0, threshold: 0.5 },
    { family: "responsive", kind: "model", models: ["m", "lab"], coef: [0.5, 1], intercept: -0.5, threshold: 0.5 },
  ],
});

test("a check filter scores 0 unless one of its checks flagged the element", () => {
  const b = bundle();
  assert.equal(scores(b, [1, 0], [0, 0])[0], 0);
  assert.equal(scores(b, [1, 0], [1, 0])[0], sig(2));
  assert.deepEqual(detect(b, [0, 0], [1, 0]).map((f) => f.family), []);
});

test("a stack adds weighted logits, and a model with rule inputs reads the bits", () => {
  const b = bundle();
  const z = (a, bit) => -0.5 + 0.5 * logit(sig(a > 0.5 ? 2 : -2)) + logit(sig(bit > 0.5 ? 1 : -1));
  const s = scores(b, [1, 0], [0, 1])[1];
  assert.ok(Math.abs(s - sig(z(1, 1))) < 1e-12);
  assert.ok(Math.abs(scores(b, [0, 0], [0, 0])[1] - sig(z(0, 0))) < 1e-12);
  assert.deepEqual(detect(b, [1, 0], [1, 1]).map((f) => f.family), ["media", "responsive"]);
});
