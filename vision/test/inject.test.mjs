// Browser-free tests of the v2 traceless injection (src/inject.mjs): which recipes are dropped and why, the static
// lint over every trainable recipe, and the page runtime's pure helpers (structural selectors, marker resolution,
// rule text) on a small fake DOM in a Node vm context. The in-browser check of every recipe (no trace left, the undo
// restores the page, no request made) is test/browser/traceless.mjs, run on a node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadRecipes, runnable, trainable, DROPPED, SPREAD, TEXT_ONLY_URLS, lint, finalOnly, schemeOf, injectionScript, PAGE_RUNTIME } from "../src/inject.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECIPES = join(HERE, "..", "..", "research", "visual", "injectors.json");

test("DROPPED names runnable recipes, each with a reason of a known kind", async () => {
  const run = runnable(await loadRecipes(RECIPES));
  const ids = new Set(run.map((r) => r.id));
  for (const [id, why] of Object.entries(DROPPED)) {
    assert.ok(ids.has(id), `${id} is not a runnable recipe`);
    assert.match(why, /^(request|trace|emulation): .{10,}/, id);
  }
  const tr = trainable(run);
  assert.equal(tr.length, run.length - Object.keys(DROPPED).length);
  assert.ok(tr.length >= 110, `${tr.length} trainable`);
  // every family keeps faults
  const fams = new Set(tr.filter((r) => r.kind === "fault").map((r) => r.family));
  for (const f of ["blank", "controls", "dark", "design", "leaks", "media", "motion", "occlusion", "other", "overflow", "responsive", "styles", "text"]) assert.ok(fams.has(f), f);
});

test("SPREAD names trainable fault recipes, each with a reason", async () => {
  const tr = trainable(await loadRecipes(RECIPES));
  const byId = new Map(tr.map((r) => [r.id, r]));
  for (const [id, why] of Object.entries(SPREAD)) {
    assert.ok(byId.has(id), `${id} is not trainable`);
    assert.equal(byId.get(id).kind, "fault", id);
    assert.match(why, /\(0\.\d{3}\)$/, id);
  }
});

test("lint: no trainable recipe requests anything or writes late; the dropped request recipes are caught", async () => {
  const run = runnable(await loadRecipes(RECIPES));
  for (const r of trainable(run)) assert.deepEqual(lint(r), [], r.id);
  for (const r of run.filter((x) => /^request/.test(DROPPED[x.id] || ""))) assert.ok(lint(r).length > 0, `${r.id} should fail the lint`);
  for (const id of ["shift-late-banner", "reveal-threshold-unreachable", "control-reveal-completes", "wheel-hijack"]) assert.ok(lint(run.find((r) => r.id === id)).includes("late-write"), id);
  // the one kept recipe with a URL holds it as text content
  for (const id of TEXT_ONLY_URLS) assert.ok(!DROPPED[id] && /textContent/.test(run.find((r) => r.id === id).operation), id);
});

test("finalOnly: journaled CSSOM helpers and stylesheet.disabled are undone now; timers, media and WebGL are not", async () => {
  const run = runnable(await loadRecipes(RECIPES));
  const by = (id) => run.find((r) => r.id === id);
  for (const id of ["stylesheets-disabled", "prose-rules-removed", "keyframes-removed", "contrast-muted-light"]) assert.ok(!finalOnly(by(id)), id);
  for (const id of ["webgl-context-lost", "shift-late-banner", "control-video-controls"]) assert.ok(finalOnly(by(id)), id);
  assert.equal(schemeOf(by("dark-input-low")), "dark");
  assert.equal(schemeOf(by("contrast-muted-light")), "light");
});

test("the page runtime writes no label or marker into the DOM", () => {
  assert.doesNotThrow(() => new Function(PAGE_RUNTIME));
  // labels go to a WeakMap; the only data-bench-fault left is the selector pattern resolveMarkers replaces
  assert.ok(!/setAttribute\(\s*["']data-bench-fault/.test(PAGE_RUNTIME));
  assert.ok(/new WeakMap\(\)/.test(PAGE_RUNTIME));
  assert.ok(!/createElement\(\s*["']style["']\s*\)/.test(PAGE_RUNTIME), "faults go through the constructed sheet, not a <style> node");
  const ex = readFileSync(join(HERE, "..", "src", "extract.js"), "utf8");
  assert.ok(!/getAttribute\(\s*labelAttr|data-bench-fault"\)/.test(ex), "the extractor reads labels from the WeakMap only");
});

test("injectionScript: every trainable recipe compiles; opaque only for the WebGL ones", async () => {
  const tr = trainable(await loadRecipes(RECIPES));
  for (const r of tr) {
    const src = injectionScript([r], 7);
    assert.doesNotThrow(() => new Function(src), r.id);
    assert.equal(/opaque: true/.test(src), /loseContext/.test(r.operation), r.id);
  }
});

// ---------------------------------------------------------------- the runtime's pure helpers on a fake DOM

function fakeDom() {
  const all = [];
  const doc = {};
  const mk = (tag, parent, id) => {
    const el = {
      localName: tag,
      ownerDocument: doc,
      parentElement: parent || null,
      children: [],
      attrs: id ? { id } : {},
      isConnected: true,
      getAttribute(n) {
        return n in this.attrs ? this.attrs[n] : null;
      },
      get previousElementSibling() {
        if (!this.parentElement) return null;
        const s = this.parentElement.children;
        const k = s.indexOf(this);
        return k > 0 ? s[k - 1] : null;
      },
    };
    if (parent) parent.children.push(el);
    all.push(el);
    return el;
  };
  doc.documentElement = mk("html");
  doc.body = mk("body", doc.documentElement);
  doc.querySelectorAll = (sel) => {
    const id = sel.slice(1).replace(/\\(.)/g, "$1");
    return all.filter((e) => e.isConnected && e.attrs.id === id);
  };
  return { doc, mk };
}

const ctx = vm.createContext({});
vm.runInContext(PAGE_RUNTIME, ctx);
const lib = ctx.__visionInjectLib;

test("cssPath: id anchors, nth-child paths, body and root, detached elements", () => {
  const { doc, mk } = fakeDom();
  const main = mk("main", doc.body, "content");
  const s1 = mk("section", main);
  const s2 = mk("section", main);
  const p = mk("p", s2);
  const dupA = mk("div", doc.body, "dup");
  const dupB = mk("div", doc.body, "dup");
  const inDup = mk("span", dupB);
  assert.equal(lib.cssPath(doc.documentElement), ":root");
  assert.equal(lib.cssPath(doc.body), "body");
  assert.equal(lib.cssPath(s1), "#content > section:nth-child(1)");
  assert.equal(lib.cssPath(p), "#content > section:nth-child(2) > p:nth-child(1)");
  // a duplicated id is no anchor: the path goes up to body
  assert.equal(lib.cssPath(inDup), "body > div:nth-child(3) > span:nth-child(1)");
  assert.equal(lib.cssPath(dupA), "body > div:nth-child(2)");
  const loose = mk("div", null);
  assert.equal(lib.cssPath(loose), null);
  // an id that needs escaping
  const odd = mk("div", doc.body, "a:b");
  assert.equal(lib.cssPath(mk("i", odd)), "#a\\:b > i:nth-child(1)");
});

test("resolveMarkers: recipe and class markers become :is() of structural selectors, or :not(*)", () => {
  const { doc, mk } = fakeDom();
  const main = mk("main", doc.body, "m");
  const a = mk("div", main);
  const b = mk("div", main);
  const gone = mk("div", main);
  gone.isConnected = false;
  const byRecipe = new Map([["scroller-scrollbar-hidden", new Set([a])]]);
  const byClass = new Map([["bench-ho", new Set([a, b, gone])], ["bench-ho-a", new Set([b])]]);
  const out = lib.resolveMarkers('[data-bench-fault~="scroller-scrollbar-hidden"]::-webkit-scrollbar{display:none} @media (hover: hover) { .bench-ho:hover .bench-ho-a { opacity: 1 !important; } } .bench-x { color: red }', byRecipe, byClass);
  assert.equal(out, ":is(#m > div:nth-child(1))::-webkit-scrollbar{display:none} @media (hover: hover) { :is(#m > div:nth-child(1), #m > div:nth-child(2)):hover :is(#m > div:nth-child(2)) { opacity: 1 !important; } } :not(*) { color: red }");
  assert.equal(lib.declText({ color: "#fff", "background-color": "hsl(var(--x))" }), "color: #fff !important; background-color: hsl(var(--x)) !important");
});
