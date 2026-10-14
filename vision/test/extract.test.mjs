// Browser-free tests of the pipeline's logic: extract.js pure helpers (loaded into a Node vm context, as the page
// would load it), discover.mjs parsing and sampling, crawl.mjs robots.txt rules, and inject.mjs recipe selection and
// script generation over the real research/visual/injectors.json. Fixtures are in test/fixtures/.
//   cd vision && npm test   (node --test test/*.test.mjs)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { surtPrefix, parseClusterIdx, blocksFor, parseCdxBlock, parseCdx, hostOf, hostKey, isPlatformHost, sampleIndices, rng, parseTranco, sampleControl } from "../src/discover.mjs";
import { robotsAllows } from "../src/robots.mjs";
import { loadRecipes, runnable, chooseRecipes, deviceOf, injectionScript, PAGE_RUNTIME } from "../src/inject.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
// the page has URL; a bare vm context does not
const ctx = vm.createContext({ URL });
vm.runInContext(readFileSync(join(HERE, "..", "src", "extract.js"), "utf8"), ctx);
const lib = ctx.__visionLib;
// values from the vm context carry its Array prototype: compare plain copies
const plain = (x) => JSON.parse(JSON.stringify(x));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("extract.js loads as a classic script and exposes the extractor", () => {
  assert.equal(typeof ctx.__visionExtract, "function");
  assert.equal(lib.VERSION, "vision-extract-2");
});

test("parseColor: the computed forms Chromium returns", () => {
  for (const c of fx("colors.json").cases) {
    const got = lib.parseColor(c.in);
    if (c.out === null) {
      assert.equal(got, null, c.in);
      continue;
    }
    assert.ok(got, `parsed ${c.in}`);
    for (let i = 0; i < 3; i++) near(got[i], c.out[i], 2);
    near(got[3], c.out[3], 0.01);
  }
});

test("contrast: WCAG 2.2 ratios, truncated", () => {
  for (const c of fx("contrast.json").cases) assert.equal(lib.textContrast(c.fg, c.bg, 1), c.ratio, c.why);
  // ancestor opacity scales the text alpha before compositing
  assert.equal(lib.textContrast([0, 0, 0, 1], [255, 255, 255], 0.5), lib.textContrast([0, 0, 0, 0.5], [255, 255, 255], 1));
});

test("resolveLayers: effective background and its status", () => {
  for (const c of fx("layers.json").cases) {
    const r = lib.resolveLayers(c.layers.map((l) => ({ color: l.color, image: !!l.image, media: !!l.media, filter: !!l.filter })), c.base);
    assert.equal(r.status, c.status, c.why);
    for (let i = 0; i < 3; i++) near(r.rgb[i], c.rgb[i], 1);
  }
});

test("scanLeaks: pattern ids and at most 24 matched characters", () => {
  for (const c of fx("leaks.json").cases) {
    const got = lib.scanLeaks(c.text);
    assert.deepEqual(plain(got.map((x) => x[0])), c.ids, c.text);
    for (const [, m] of got) assert.ok(m.length <= 24);
  }
  assert.equal(lib.scanLeaks("x".repeat(50) + "{{ a }}")[0][1], "{{ a }}");
});

test("parseViewportMeta: missing meta, zoom blocking, fixed widths", () => {
  for (const c of fx("viewport.json").cases) {
    const got = lib.parseViewportMeta(c.in);
    for (const k of Object.keys(c)) if (k !== "in") assert.equal(got[k], c[k], `${c.in} ${k}`);
  }
});

test("substituteVars and varRefs: undefined tokens and fallbacks", () => {
  for (const c of fx("vars.json").cases) assert.equal(lib.substituteVars(c.value, (n) => c.defined[n] ?? ""), c.out, c.value);
  assert.deepEqual(plain(lib.varRefs("hsl(var(--a)) var(--b, var(--c))").map((r) => r.name)), ["--a", "--b", "--c"]);
  assert.equal(lib.varRefs("var(--b, 1px)")[0].fallback, "1px");
});

test("declarations: splits a rule body, keeps parentheses intact", () => {
  const d = lib.declarations(".a { background: url(\"data:image/png;base64,AA\"); color: hsl(var(--x)) !important; }");
  assert.deepEqual(plain(d), [["background", 'url("data:image/png;base64,AA")'], ["color", "hsl(var(--x))"]]);
});

test("stackingReason and trapsFixed: the CSS triggers", () => {
  const base = { position: "static", zIndex: "auto", opacity: "1", transform: "none", filter: "none", backdropFilter: "none", mixBlendMode: "normal", isolation: "auto", clipPath: "none", maskImage: "none", willChange: "auto", contain: "none", perspective: "none", containerType: "normal" };
  assert.equal(lib.stackingReason(base, "block"), "");
  assert.equal(lib.stackingReason({ ...base, position: "relative", zIndex: "10" }, "block"), "z");
  assert.equal(lib.stackingReason({ ...base, zIndex: "1" }, "flex"), "z-item");
  assert.equal(lib.stackingReason({ ...base, opacity: "0.99" }, "block"), "opacity");
  assert.equal(lib.stackingReason({ ...base, position: "fixed" }, "block"), "pos");
  assert.equal(lib.trapsFixed({ ...base, backdropFilter: "blur(8px)" }), true);
  assert.equal(lib.trapsFixed(base), false);
});

test("insideShare: clipping by ancestors and the viewport", () => {
  const vp = { l: 0, t: 0, r: 100, b: 100 };
  assert.equal(lib.insideShare({ l: 10, t: 10, r: 20, b: 20 }, vp), 1);
  assert.equal(lib.insideShare({ l: 50, t: 0, r: 150, b: 100 }, vp), 0.5);
  assert.equal(lib.insideShare({ l: 200, t: 0, r: 300, b: 10 }, vp), 0);
});

test("urlClass: placeholder hosts, data URLs, same and cross origin", () => {
  assert.equal(lib.urlClass("https://via.placeholder.com/300", "https://a.lovable.app"), "ph");
  assert.equal(lib.urlClass("https://images.unsplash.com/photo-1", "https://a.lovable.app"), "unsplash");
  assert.equal(lib.urlClass("/hero.png", "https://a.lovable.app"), "same");
  assert.equal(lib.urlClass("https://cdn.example.net/x.png", "https://a.lovable.app"), "cross");
  assert.equal(lib.urlClass("data:image/png;base64,AA", "https://a.lovable.app"), "data");
});

test("discover: SURT prefixes, cluster.idx block search, CDX lines", () => {
  assert.equal(surtPrefix("lovable.app"), "app,lovable,");
  const idx = parseClusterIdx(["app,lovable)/ 1\tcdx-00001.gz\t0\t10\t1", "app,lovable,aa)/ 2\tcdx-00001.gz\t10\t10\t2", "app,lovable,mm)/ 3\tcdx-00001.gz\t20\t10\t3", "app,lovablf,x)/ 4\tcdx-00001.gz\t30\t10\t4", ""].join("\n"));
  assert.deepEqual(blocksFor(idx, "app,lovable,"), [0, 1, 2]);
  const rows = parseCdxBlock('app,lovable,aa)/ 20260910074621 {"url": "https://aa.lovable.app/", "mime": "text/html", "status": "200"}\napp,lovablx)/ 1 {}', "app,lovable,");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, "20260910074621");
  assert.equal(parseCdx('{"url":"https://b.bolt.host/","timestamp":"1"}\nnot json\n').length, 1);
  assert.equal(hostOf("https://WWW.Example.com./x"), "www.example.com");
  assert.equal(hostKey("www.example.com"), "example.com");
  assert.equal(isPlatformHost("lovable.app", "lovable.app"), true);
  assert.equal(isPlatformHost("docs.lovable.app", "lovable.app"), true);
  assert.equal(isPlatformHost("my-shop.lovable.app", "lovable.app"), false);
});

test("discover: seeded samples are reproducible and distinct", () => {
  const a = sampleIndices(1000, 20, rng(7));
  assert.deepEqual(a, sampleIndices(1000, 20, rng(7)));
  assert.equal(new Set(a).size, 20);
  assert.deepEqual(sampleIndices(5, 10, rng(1)), [0, 1, 2, 3, 4]);
  const top = parseTranco("1,google.com\r\n2,youtube.com\n1500,example.org\n20000,x.io\nbad line");
  assert.equal(top.length, 4);
  assert.equal(sampleControl(top, 3, rng(3)).length, 3);
});

test("robots.txt: our agent, the * group, longest match", () => {
  for (const c of fx("robots.json").cases) assert.equal(robotsAllows(c.text, "genclass-vision", "/"), c.allowed, c.text);
});

test("inject: every runnable recipe compiles into the page script, selection respects device and env", async () => {
  const recipes = await loadRecipes(join(HERE, "..", "..", "research", "visual", "injectors.json"));
  const run = runnable(recipes);
  assert.ok(run.length >= 100, `${run.length} runnable`);
  assert.ok(run.every((r) => r.phase === "after-load"));
  // the generated expression parses (no page needed): one recipe at a time, so a broken one is named
  for (const r of run) assert.doesNotThrow(() => new Function(injectionScript([r], 1)), r.id);
  assert.doesNotThrow(() => new Function(PAGE_RUNTIME));
  const rand = rng(5);
  for (let i = 0; i < 200; i++) {
    const dev = i % 2 ? "phone" : "desktop";
    const ch = chooseRecipes(run, dev, rand);
    assert.ok(ch.length >= 1 && ch.length <= 3);
    assert.ok(ch.every((r) => deviceOf(r) === dev));
    assert.equal(new Set(ch.map((r) => JSON.stringify(r.env || {}))).size, 1);
    assert.equal(new Set(ch.map((r) => r.catalog_id)).size, ch.length);
  }
});
