// Browser-free tests of the labelling candidates (src/candidates.mjs): the frozen v1 encoder against the v1 schema
// and model, the v1 rules on raw rows, the choice of at most 6 candidates per view, crop rectangles and ids.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rng } from "../src/discover.mjs";
import { V1_FEATURES, v1Encode, v1Inputs, v1PageFeatures, loadV1, v1Rules, chooseCandidates, eligible, cropRect, cropId, guessFamily, RULES, RULE_FAMILY } from "../src/candidates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RES = join(HERE, "..", "results");
const schema = JSON.parse(readFileSync(join(RES, "schema.json"), "utf8"));
const model = JSON.parse(readFileSync(join(RES, "train", "gbt-small.json"), "utf8"));

const page = { vw: 1366, vh: 768, scrollW: 1366, clientW: 1366, viewportMeta: { present: 1, deviceWidth: 1 }, fontsStatus: "loaded" };
const button = { i: 3, tag: "button", role: "button", x: 600, y: 580, w: 229, h: 56, inv: 1, vis: 1, tl: 10, tt: 10, fs: 16, ia: 1, cur: 1, foc: 1, hs: 5, c: [255, 255, 255, 1], bg: [37, 99, 235, 1], eb: [37, 99, 235], cr: 5.17, d: 8, p: 2 };

test("v1 encoder: the 112 v1 columns in the v1 order, every v1 model input resolvable", () => {
  assert.deepEqual(V1_FEATURES, schema.features);
  const x = v1Encode(button, schema.categorical, v1PageFeatures(page, "desktop", "light"));
  assert.equal(x.length, 112);
  assert.equal(x[V1_FEATURES.indexOf("fw")], 400);
  assert.equal(x[V1_FEATURES.indexOf("cat_tag")], schema.categorical.tag.button);
  assert.equal(x[V1_FEATURES.indexOf("pDesktop")], 1);
  assert.equal(x[V1_FEATURES.indexOf("pRound")], 0);
  const inp = v1Inputs(x, model.inputs);
  assert.equal(inp.length, model.inputs.length);
  assert.ok(inp.every((v) => Number.isFinite(v)));
  assert.equal(inp[model.inputs.indexOf("wr")], Math.fround(229 / 1366));
});

test("loadV1 scores rows with the exported gbt-small; a missing model gives null", () => {
  const score = loadV1(join(RES, "train", "gbt-small.json"), join(RES, "schema.json"));
  assert.equal(typeof score, "function");
  const p = score(button, v1PageFeatures(page, "desktop", "light"));
  assert.ok(p > 0 && p < 1, String(p));
  assert.equal(loadV1(join(RES, "nope.json"), join(RES, "schema.json")), null);
});

test("v1 rules on raw rows: each rule fires on its case, page-overflow-x keeps the 3 shallowest", () => {
  const rows = [
    { tag: "img", cmp: 1, iok: 0, vis: 1, w: 40, h: 40, x: 0, y: 0, inv: 1 },
    { tag: "p", tl: 20, vis: 1, inv: 1, fs: 14, cr: 1.1, x: 0, y: 0, w: 100, h: 20 },
    { tag: "p", tl: 20, vis: 1, inv: 1, fs: 14, cr: 1.1, sbs: 2, scr: 1.1, x: 0, y: 0, w: 100, h: 20 },
    { tag: "span", tl: 6, vis: 1, lk: [["currency-nan", "$NaN"]], x: 0, y: 0, w: 10, h: 10 },
    { tag: "a", ia: 1, vis: 1, inv: 1, ho: 5, x: 0, y: 0, w: 50, h: 20 },
    { tag: "div", x: 1300, w: 200, h: 10, d: 5 },
    { tag: "div", x: 1300, w: 200, h: 10, d: 3 },
    { tag: "div", x: -50, w: 200, h: 10, d: 3 },
    { tag: "div", x: 1300, w: 200, h: 10, d: 4 },
    { tag: "div", x: 1300, w: 200, h: 10, d: 2, pos: "f" },
  ];
  const r = v1Rules(rows, { ...page, scrollW: 1500 });
  assert.deepEqual(r.get(0), ["image-broken"]);
  assert.deepEqual(r.get(1), ["text-invisible"]);
  assert.equal(r.get(2), undefined); // the paint stack disagrees
  assert.deepEqual(r.get(3), ["text-template-leak"]);
  assert.deepEqual(r.get(4), ["control-unreachable"]);
  const ov = [...r.entries()].filter(([, v]) => v.includes("page-overflow-x")).map(([k]) => k);
  assert.deepEqual(ov.sort(), [6, 7, 8]);
  // no sideways scroll on the page: no overflow culprits
  assert.ok(![...v1Rules(rows, page).values()].flat().includes("page-overflow-x"));
  for (const k of RULES) assert.ok(RULE_FAMILY[k], k);
});

function viewRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ i, tag: i % 5 ? "div" : "p", x: (i * 37) % 1200, y: (i * 53) % 700, w: 40 + (i % 7) * 10, h: 20 + (i % 3) * 10, vis: 1, inv: 1, tl: i % 5 ? 0 : 12, cr: 7 });
  rows.push({ i: n, tag: "body", x: 0, y: 0, w: 1366, h: 3000, vis: 1, inv: 1 });
  rows.push({ i: n + 1, tag: "div", x: 0, y: 900, w: 100, h: 100, vis: 1, inv: 0 }); // below the fold
  rows.push({ i: n + 2, tag: "div", x: 0, y: 0, w: 100, h: 100, vis: 0, inv: 1 }); // hidden
  return rows;
}

test("chooseCandidates: at most 6, eligible only, rule flags and model tops first, 2 random, reproducible", () => {
  const rows = viewRows(60);
  rows[10] = { ...rows[10], tag: "img", cmp: 1, iok: 0 }; // image-broken
  rows[20] = { ...rows[20], tl: 9, cr: 1.2, fs: 14 }; // text-invisible
  rows[30] = { ...rows[30], lk: [["mustache", "{{x}}"]] }; // leak
  const score = (r) => (r.i === 41 ? 0.9 : r.i === 42 ? 0.8 : r.i === 43 ? 0.3 : 0.01);
  const a = chooseCandidates(rows, page, { score, rand: rng(4) });
  const b = chooseCandidates(rows, page, { score, rand: rng(4) });
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  for (const c of a) assert.ok(eligible(rows[c.k]), String(c.k));
  const src = (k) => (a.find((c) => c.k === k) || { sources: [] }).sources;
  assert.ok(src(10).includes("rules") && src(20).includes("rules"));
  assert.ok(src(41).includes("gbt") && src(42).includes("gbt"));
  assert.equal(a.filter((c) => c.sources.includes("random")).length, 2);
  // a third rule flag is left out once the 6 slots are taken (2 rules, 2 model, 2 random)
  assert.equal(src(30).length, 0);
  // without a model: rules, random, then the rest of the rule flags
  const c = chooseCandidates(rows, page, { score: null, rand: rng(4) });
  assert.equal(c.filter((x) => x.sources.includes("rules")).length, 3);
  assert.equal(c.filter((x) => x.sources.includes("random")).length, 2);
  assert.ok(c.every((x) => x.score === null));
  // never html, body, hidden or out-of-viewport rows
  const tags = new Set(c.map((x) => rows[x.k].tag));
  assert.ok(!tags.has("body"));
  assert.ok(chooseCandidates([], page, { score }).length === 0);
});

test("crop rectangles, ids and family guesses", () => {
  assert.deepEqual(cropRect({ x: 10, y: 10, w: 100, h: 20 }, 1366, 768), [0, 0, 134, 54]);
  assert.deepEqual(cropRect({ x: 1300, y: 700, w: 100, h: 100 }, 1366, 768), [1276, 676, 1366, 768]);
  assert.equal(cropRect({ x: 1400, y: 10, w: 10, h: 10 }, 1366, 768), null);
  const id = cropId("0123456789ab-light", 17);
  assert.match(id, /^c[0-9a-f]{12}$/);
  assert.equal(id, cropId("0123456789ab-light", 17));
  assert.notEqual(id, cropId("0123456789ab-dark", 17));
  assert.equal(guessFamily({ tag: "img" }, page, ["image-broken"]), "media");
  assert.equal(guessFamily({ tag: "div", ho: 4 }, page, []), "occlusion");
  assert.equal(guessFamily({ tag: "p", tl: 5, cr: 2 }, page, []), "text");
  assert.equal(guessFamily({ tag: "div" }, page, []), null);
});
