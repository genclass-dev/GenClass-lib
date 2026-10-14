// Browser-free tests for the multi-round injection chooser and the training-set encoder.
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRecipes, runnable, chooseRound, finalOnly, deviceOf } from "../src/inject.mjs";
import { rng } from "../src/discover.mjs";
import { encode, F, FEATURES, makeVocab, countCats, freezeVocab, natRow, newNat } from "../src/build_set.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES = join(HERE, "..", "..", "research", "visual", "injectors.json");

test("chooseRound: same env, distinct catalog ids, no reuse, finalOnly only in the last round", async () => {
  const recipes = runnable(await loadRecipes(RECIPES));
  const rand = rng(3);
  const counts = {};
  for (let i = 0; i < 400; i++) {
    const device = i % 2 ? "phone" : "desktop";
    const used = new Set(["contrast-muted-light"]);
    const final = i % 4 === 0;
    const out = chooseRound(recipes, device, rand, counts, { final, used });
    assert.ok(out.length >= 1 && out.length <= 3);
    const env = JSON.stringify(out[0].env || {});
    for (const r of out) {
      assert.equal(JSON.stringify(r.env || {}), env);
      assert.equal(deviceOf(r), device);
      assert.ok(!used.has(r.id));
      if (!final) assert.ok(!finalOnly(r), r.id);
    }
    assert.equal(new Set(out.map((r) => r.catalog_id)).size, out.length);
    for (const r of out) if (r.kind === "fault") counts[r.family] = (counts[r.family] || 0) + 1;
  }
  // inverse-count weighting keeps desktop-only families from starving
  const fams = Object.values(counts);
  assert.ok(Math.min(...fams) > 0);
});

test("finalOnly marks recipes the undo journal cannot reverse", async () => {
  const recipes = runnable(await loadRecipes(RECIPES));
  const ids = recipes.filter(finalOnly).map((r) => r.id);
  assert.ok(ids.includes("stylesheets-disabled"));
  assert.ok(ids.includes("shift-late-banner"));
  assert.ok(!ids.includes("contrast-muted-light"));
});

test("encode: fixed width, defaults for absent keys, categorical codes", () => {
  const rows = [
    { i: 0, tag: "p", x: 1, y: 2, w: 300, h: 20, vis: 1, tl: 12, c: [10, 10, 10, 1], eb: [255, 255, 255, 1], cr: 1.2 },
    { i: 1, tag: "img", w: 10, h: 10, vis: 1, nw: 0, nh: 0, cmp: 1, iok: 0, src: "same" },
  ];
  const vc = makeVocab();
  for (const r of rows) countCats(vc, r);
  const codes = freezeVocab(vc);
  const buf = new Float32Array(F * 2);
  const end = encode(rows[0], codes, new Array(10).fill(0), buf, 0);
  assert.equal(end, F);
  encode(rows[1], codes, new Array(10).fill(0), buf, F);
  assert.equal(buf[FEATURES.indexOf("fw")], 400);
  assert.equal(buf[FEATURES.indexOf("cr")], Math.fround(1.2));
  assert.equal(buf[F + FEATURES.indexOf("natW")], 0);
  assert.equal(buf[F + FEATURES.indexOf("nowrap")], 0);
  assert.ok(buf[FEATURES.indexOf("cat_tag")] >= 2);
  const n = newNat();
  // under 1.5:1 on a solid background and nothing contradicts it: loose (4) and strict (32)
  assert.equal(natRow(n, rows[0]), 36);
  assert.equal(natRow(n, rows[1]), 1);
  // the paint stack found an image behind the text: loose only
  assert.equal(natRow(n, { ...rows[0], sbs: 2, scr: 1 }), 4);
  // a one-character separator: loose only
  assert.equal(natRow(n, { ...rows[0], tl: 1 }), 4);
});
