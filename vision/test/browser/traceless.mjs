// In-browser check of the v2 injection, run on a cluster node (never on the Mac; it launches Chromium):
//
//   cd ~/gcl/vision && node test/browser/traceless.mjs [--out ~/vision-out/traceless.json] [--only id,id]
//
// For every trainable recipe, on a fresh copy of test/browser/fixture.html (set with page.setContent: no network),
// at the recipe's device size and colour scheme:
//   1. inject it alone and record the result (applied, n/a, error, trace);
//   2. if applied: no element that existed before has a style, class or data-* attribute that differs, no element
//      the recipe created carries a style attribute or a bench marker, nothing carries data-bench-fault, and the
//      extractor gives the marked elements their labels from the WeakMap;
//   3. undo, and check the page is back: every element, attribute and text node equal to before (attribute order
//      ignored), the injected sheet empty and not adopted, the stylesheets' rule counts and disabled flags restored;
//   4. no request was made at any point.
// Prints one line per recipe and a summary; exits 1 when an applied recipe left a trace, failed the undo or made a
// request.

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/discover.mjs";
import { loadRecipes, trainable, deviceOf, schemeOf, injectionScript, PAGE_RUNTIME } from "../../src/inject.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "fixture.html"), "utf8");
const EXTRACT_SRC = readFileSync(join(HERE, "..", "..", "src", "extract.js"), "utf8");
const SIZES = { desktop: { width: 1366, height: 768 }, phone: { width: 390, height: 844 } };

/** In the page: a canonical dump of the document (elements, sorted attributes, text) and the CSSOM state. */
const STATE = `(() => {
  const out = [];
  const walk = (n, d) => {
    if (n.nodeType === 1) {
      const attrs = Array.from(n.attributes).map((a) => a.name + "=" + a.value).sort().join(" ");
      out.push(d + "<" + n.localName + " " + attrs + ">");
      for (const c of n.childNodes) walk(c, d + 1);
    } else if (n.nodeType === 3 && n.data.trim()) out.push(d + "#" + n.data);
  };
  walk(document.documentElement, 0);
  const sheets = Array.from(document.styleSheets).map((s) => { try { return s.cssRules.length + (s.disabled ? "d" : ""); } catch (e) { return "x"; } });
  return { dom: out, sheets: sheets.join(","), adopted: (document.adoptedStyleSheets || []).length };
})()`;

/** In the page: index every element now (WeakMap element -> its style, class and data-* values). */
const SNAP = `(() => {
  const m = new WeakMap();
  for (const el of document.getElementsByTagName("*")) {
    const o = {};
    for (const a of Array.from(el.attributes)) if (a.name === "style" || a.name === "class" || a.name.startsWith("data-")) o[a.name] = a.value;
    m.set(el, o);
  }
  globalThis.__tracelessSnap = m;
  return true;
})()`;

/** In the page: what injection left on elements (compared with SNAP), and the labels the extractor reads. */
const TRACES = `(() => {
  const snap = globalThis.__tracelessSnap;
  const out = [];
  for (const el of document.getElementsByTagName("*")) {
    const was = snap.get(el);
    const now = {};
    for (const a of Array.from(el.attributes)) if (a.name === "style" || a.name === "class" || a.name.startsWith("data-")) now[a.name] = a.value;
    if (!was) {
      if ("style" in now) out.push("new <" + el.localName + "> style");
      for (const k of Object.keys(now)) if (k.startsWith("data-bench")) out.push("new <" + el.localName + "> " + k);
      if (/(^|\\s)bench-/.test(now.class || "")) out.push("new <" + el.localName + "> bench class");
      continue;
    }
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (was[k] !== now[k]) out.push("<" + el.localName + "> " + k);
  }
  if (document.querySelector("[data-bench-fault]")) out.push("data-bench-fault present");
  const labs = globalThis.__visionLabels;
  const marked = (globalThis.__visionMarked || []).length;
  return { traces: out.slice(0, 8), marked, labelled: labs ? (globalThis.__visionMarked || []).filter((m) => labs.get(m.el)).length : 0 };
})()`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const only = a.only ? new Set(String(a.only).split(",")) : null;
  const recipes = trainable(await loadRecipes(join(HERE, "..", "..", "..", "research", "visual", "injectors.json"))).filter((r) => !only || only.has(r.id));
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let bad = 0;
  for (const r of recipes) {
    const device = deviceOf(r);
    const scheme = schemeOf(r);
    const ctx = await browser.newContext({ viewport: SIZES[device], deviceScaleFactor: 1, colorScheme: scheme, serviceWorkers: "block" });
    const page = await ctx.newPage();
    const requests = [];
    await page.route("**/*", (route) => {
      requests.push(route.request().url().slice(0, 80));
      return route.abort();
    });
    const row = { id: r.id, device, scheme };
    try {
      await page.setContent(FIXTURE, { waitUntil: "load" });
      requests.length = 0; // setContent itself requests nothing; count from here
      await page.evaluate(EXTRACT_SRC);
      await page.evaluate(PAGE_RUNTIME);
      const before = await page.evaluate(STATE);
      await page.evaluate(SNAP);
      const [res] = await page.evaluate(injectionScript([r], 12345));
      row.applied = res.applied;
      row.reason = res.reason || "";
      if (res.trace) row.trace = res.trace;
      if (res.attrs) row.attrs = res.attrs;
      const tr = await page.evaluate(TRACES);
      row.left = tr.traces;
      row.marked = tr.marked;
      row.labelled = tr.labelled;
      const ex = await page.evaluate(`globalThis.__visionExtract({ maxRows: 5000 })`);
      row.rowsLabelled = ex.rows.filter((x) => x.lab).length;
      row.rowsMade = ex.rows.filter((x) => x.made).length;
      const u = await page.evaluate("__visionUndo()");
      row.undo = u.ok;
      const after = await page.evaluate(STATE);
      const res2 = await page.evaluate("__visionResidue()");
      const diff = [];
      const n = Math.max(before.dom.length, after.dom.length);
      for (let i = 0; i < n && diff.length < 3; i++) if (before.dom[i] !== after.dom[i]) diff.push(`${(before.dom[i] || "").slice(0, 90)} | ${(after.dom[i] || "").slice(0, 90)}`);
      row.restored = diff.length === 0 && before.sheets === after.sheets && before.adopted === after.adopted && !res2.sheet && !res2.rules;
      if (!row.restored) row.restoreDiff = { dom: diff, sheets: [before.sheets, after.sheets], adopted: [before.adopted, after.adopted], residue: res2 };
      row.requests = requests.slice(0, 3);
      const fail = (res.applied && (row.left.length || res.trace || !row.restored)) || requests.length || (!res.applied && /^error/.test(row.reason));
      row.ok = !fail;
      if (fail) bad++;
    } catch (e) {
      row.ok = false;
      row.error = String(e.message || e).split("\n")[0].slice(0, 160);
      bad++;
    } finally {
      await ctx.close();
    }
    results.push(row);
    console.log(`${row.ok ? "ok  " : "FAIL"} ${r.id.padEnd(36)} ${row.applied ? "applied" : (row.reason || row.error || "").slice(0, 40).padEnd(7)} marked ${row.marked ?? "-"} rows ${row.rowsLabelled ?? "-"} made ${row.rowsMade ?? "-"}${row.left && row.left.length ? " left " + row.left.join("; ") : ""}${row.trace ? " trace " + row.trace.join("; ") : ""}${row.restored === false ? " NOT RESTORED " + JSON.stringify(row.restoreDiff) : ""}${row.requests && row.requests.length ? " REQUESTS " + row.requests.join(" ") : ""}`);
  }
  await browser.close();
  const summary = { recipes: results.length, applied: results.filter((x) => x.applied).length, notApplicable: results.filter((x) => !x.applied && /^n\/a/.test(x.reason || "")).length, failed: bad };
  console.log(JSON.stringify(summary));
  if (a.out) writeFileSync(a.out, JSON.stringify({ summary, results }, null, 1));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
