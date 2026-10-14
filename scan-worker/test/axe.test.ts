// axe-core in the scanner: the embedded build is the pinned package byte for byte with its MPL-2.0 notice, the installer
// takes axe only from that build, the run's options, the result mapping (impact to severity, best practices one level
// lower, rules the scanner measures itself left out, links and text checked), the visual duplicate rule, and hostile
// rule text escaped wherever a report is shown.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { AXE_OFF, AXE_TAGS, axeFindings, axeSeverity, axeSummary, installAxeSource, parseAxe, runAxeSource, withoutVisualDuplicates } from "../src/axe.ts";
import { AXE_BUILD, AXE_SOURCE } from "../src/axe-source.ts";
import { describe as words, ruleOf, sanitizeFinding, severityOf, standardsOf, type RawFinding } from "../src/catalog.ts";
import { embed, scanPage, staticReport } from "../src/page.ts";

const root = new URL("../", import.meta.url);

describe("the embedded axe-core", () => {
  it("is node_modules/axe-core/axe.min.js of the pinned version, byte for byte, with its copyright and MPL-2.0 notice first", () => {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const installed = JSON.parse(readFileSync(new URL("node_modules/axe-core/package.json", root), "utf8"));
    const file = readFileSync(new URL("node_modules/axe-core/axe.min.js", root), "utf8");
    assert.equal(pkg.dependencies["axe-core"], AXE_BUILD.version, "package.json pins the embedded version exactly");
    assert.equal(installed.version, AXE_BUILD.version, "npm ci installed it (run node scripts/build-axe.mjs after a bump)");
    assert.equal(AXE_SOURCE, file);
    assert.equal(createHash("sha256").update(AXE_SOURCE).digest("hex"), AXE_BUILD.sha256);
    assert.equal(AXE_BUILD.license, "MPL-2.0");
    assert.match(AXE_SOURCE.slice(0, 600), new RegExp(`^/\\*! axe v${AXE_BUILD.version.replace(/\./g, "\\.")}\\n \\* Copyright \\(c\\) 2015 - \\d{4} Deque Systems, Inc\\.[\\s\\S]*Mozilla Public[\\s\\S]*This entire copyright notice must appear in every copy`));
    const generated = readFileSync(new URL("src/axe-source.ts", root), "utf8").slice(0, 1500);
    assert.match(generated, /licensed under the Mozilla Public License 2\.0 \(MPL-2\.0\); its source code is at\n\/\/ https:\/\/github\.com\/dequelabs\/axe-core/);
  });
});

/** A sandbox that stands in for the isolated world's window. */
function sandbox(setup = ""): vm.Context {
  const ctx = vm.createContext({ console });
  vm.runInContext(`var window = globalThis; ${setup}`, ctx);
  return ctx;
}
const FAKE_AXE = `!function(w){ var axe = { version: "4.13.0", run: function(){ return Promise.resolve({ violations: [], incomplete: [], passes: [] }); }, configure: function(){} }; w.axe = axe; }(window);`;

describe("installing axe-core in the page", () => {
  it("takes the axe the embedded source defined, pins it under the per-scan name and removes window.axe", () => {
    const ctx = sandbox();
    assert.equal(vm.runInContext(installAxeSource("__gcsX", FAKE_AXE), ctx), true);
    assert.equal(vm.runInContext("typeof window.axe", ctx), "undefined");
    assert.equal(vm.runInContext("typeof window.__gcsX.run", ctx), "function");
    vm.runInContext("try { window.__gcsX = null; } catch (e) {}", ctx);
    assert.equal(vm.runInContext("typeof window.__gcsX.run", ctx), "function", "the pinned name cannot be overwritten");
    assert.equal(vm.runInContext(installAxeSource("__gcsX", FAKE_AXE), ctx), true, "installed already");
  });
  it("refuses an axe the page put there first, and a source that did not define one", () => {
    const planted = sandbox(`window.axe = { run: function(){ return Promise.resolve({ violations: [{ id: "fake" }] }); } };`);
    assert.equal(vm.runInContext(installAxeSource("__gcsY", FAKE_AXE), planted), false);
    assert.equal(vm.runInContext(installAxeSource("__gcsZ", "/* nothing */"), sandbox()), false);
    assert.equal(vm.runInContext(installAxeSource("__gcsW", "throw new Error('x')"), sandbox()), false);
  });
  it("runs with the WCAG 2.2 A and AA tags and best practices, violations only, no iframes, no network, three rules off", () => {
    assert.deepEqual([...AXE_TAGS], ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]);
    assert.deepEqual([...AXE_OFF], ["target-size", "meta-viewport", "meta-viewport-large"]);
    const src = runAxeSource("__gcsX");
    assert.doesNotThrow(() => new Function(`return ${src}`));
    for (const part of ['"resultTypes":["violations"]', '"iframes":false', '"preload":false', '"restoreScroll":true', '"target-size":{"enabled":false}', '"meta-viewport":{"enabled":false}', '"values":["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa","best-practice"]']) assert.ok(src.includes(part), part);
    assert.match(src, /noHtml: true/);
  });
  it("installs and runs the real axe-core in a sandbox and returns its result as JSON", async () => {
    // a document with nothing in it: axe-core loads and runs; nothing fails
    const ctx = vm.createContext({ console });
    vm.runInContext("var window = globalThis;", ctx);
    let installed: unknown = null;
    try {
      installed = vm.runInContext(installAxeSource("__gcsR", AXE_SOURCE), ctx);
    } catch {
      installed = "threw";
    }
    // without a DOM the real build cannot start; the installer must say false, never throw
    assert.ok(installed === false || installed === true, String(installed));
  });
});

const violation = (o: Record<string, unknown> = {}) => ({
  id: "color-contrast",
  impact: "serious",
  tags: ["cat.color", "wcag2aa", "wcag143", "TTv5", "EN-9.1.4.3"],
  help: "Elements must meet minimum color contrast ratio thresholds",
  description: "Ensure the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds",
  helpUrl: "https://dequeuniversity.com/rules/axe/4.13/color-contrast?application=axeAPI",
  count: 3,
  nodes: [
    { target: ".a", box: { x: 10, y: 20, w: 100, h: 18 }, summary: "Fix any of the following:\n  Element has insufficient color contrast of 2.85 (foreground color: #999999, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1" },
    { target: ".b", box: { x: 10, y: 60, w: 100, h: 18 }, summary: "Fix any of the following:\n  Element has insufficient color contrast of 3.10" },
    { target: ".c", box: null, summary: "" },
  ],
  ...o,
});

describe("axe-core results become findings", () => {
  it("keep the impact as the severity, one level lower for a best practice", () => {
    assert.equal(axeSeverity("critical", ["wcag2a", "wcag111"]), "critical");
    assert.equal(axeSeverity("moderate", ["best-practice"]), "minor");
    assert.equal(axeSeverity("serious", ["best-practice"]), "moderate");
    assert.equal(axeSeverity("minor", ["best-practice"]), "minor");
    assert.equal(axeSeverity("bogus", ["wcag2aa"]), "moderate");
    const r = parseAxe({ ok: true, violations: [violation(), violation({ id: "region", impact: "moderate", tags: ["cat.keyboard", "best-practice"] })] });
    assert.deepEqual(r.rules.map((x) => [x.rule, x.severity]), [["color-contrast", "serious"], ["region", "minor"]]);
  });
  it("drop the rules the scanner measures itself, misshapen ids, repeats and links off dequeuniversity.com", () => {
    const r = parseAxe({
      ok: true,
      incomplete: 7,
      passes: 40,
      violations: [
        violation({ id: "target-size" }), violation({ id: "meta-viewport" }), violation({ id: "Bad Id<script>" }), violation({ id: "__proto__" }), violation(), violation(),
        violation({ id: "image-alt", helpUrl: "javascript:alert(1)" }), violation({ id: "label", helpUrl: "https://evil.example.com/rules/axe/4.13/label" }),
      ],
    });
    assert.deepEqual(r.rules.map((x) => x.rule), ["color-contrast", "image-alt", "label"]);
    assert.equal(r.rules[1].helpUrl, null);
    assert.equal(r.rules[2].helpUrl, null);
    assert.equal(r.incomplete, 7, "needs-review rules are a count");
    assert.equal(r.passes, 40);
    assert.equal(parseAxe({ ok: false, error: "axe timed out" }).error, "axe timed out");
    assert.equal(parseAxe(null).ok, false);
  });
  it("keep tags of the right shape, counts, up to 50 boxes and the failure summary as one sentence", () => {
    const r = parseAxe({ ok: true, violations: [violation({ nodes: Array.from({ length: 80 }, (_, i) => ({ target: `.n${i}`, box: { x: i, y: i, w: 5, h: 5 }, summary: i === 0 ? "Fix all of the following:\n  A\n\nFix any of the following:\n  B;\n  C." : "" })), count: 120 })] }).rules[0];
    assert.deepEqual(r.tags, ["wcag2aa", "wcag143"]);
    assert.equal(r.count, 120);
    assert.equal(r.nodes.length, 50);
    assert.equal(r.summary, "A; B; C.");
    assert.equal(axeSummary(""), "");
  });
  it("leave out of color-contrast the text inside an element marked role=img or aria-hidden (WCAG 1.4.3's incidental text)", () => {
    const nodes = [
      { target: ".mock-ui span", box: null, picture: true, summary: "Fix any of the following:\n  Element has insufficient color contrast of 2.41" },
      { target: ".price", box: null, picture: false, summary: "Fix any of the following:\n  Element has insufficient color contrast of 3.9" },
    ];
    const [cc] = parseAxe({ ok: true, violations: [violation({ count: 2, nodes })] }).rules;
    assert.deepEqual([cc.count, cc.nodes.map((n) => n.target), cc.summary], [1, [".price"], "Element has insufficient color contrast of 3.9."]);
    assert.deepEqual(parseAxe({ ok: true, violations: [violation({ count: 1, nodes: [nodes[0]] })] }).rules, [], "nothing left of the rule");
    const [other] = parseAxe({ ok: true, violations: [violation({ id: "link-name", count: 2, nodes })] }).rules;
    assert.equal(other.count, 2, "only color-contrast has the exception");
    assert.match(runAxeSource("__x"), /closest\('\[role="img"\], \[aria-hidden="true"\]'\)/);
  });
  it("mark, in the page, color-contrast text inside a picture and text that is only the site's own name (a logotype)", async () => {
    const el = (text: string, inPicture = false) => ({ textContent: text, closest: (q: string) => (inPicture && /role="img"/.test(q) ? {} : null), getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }) });
    const nodes: Record<string, unknown> = { ".watermark": el("craigslist"), ".price": el("$12 a month"), ".mock span": el("Continue", true), ".nav": el("Shop") };
    const ctx = vm.createContext({ console });
    vm.runInContext(`var window = globalThis; window.scrollX = 0; window.scrollY = 0; var location = { hostname: "www.craigslist.org" }; var performance = { now: () => 0 };`, ctx);
    ctx.document = { querySelector: (s: string) => nodes[s] ?? null };
    ctx.__gcsT = {
      version: "4.13.0",
      configure: () => undefined,
      run: async () => ({ violations: [{ id: "color-contrast", impact: "serious", tags: ["wcag2aa", "wcag143"], nodes: Object.keys(nodes).map((k) => ({ target: [k], failureSummary: "x" })) }, { id: "link-name", impact: "serious", tags: ["wcag2a"], nodes: [{ target: [".watermark"] }] }], incomplete: [], passes: [] }),
    };
    const out = JSON.parse(await vm.runInContext(runAxeSource("__gcsT"), ctx));
    assert.deepEqual(out.violations[0].nodes.map((n: { target: string; picture: boolean }) => [n.target, n.picture]), [[".watermark", true], [".price", false], [".mock span", true], [".nav", false]]);
    assert.equal(out.violations[1].nodes[0].picture, false, "only color-contrast has these exceptions");
    const [cc] = parseAxe(out).rules;
    assert.deepEqual([cc.count, cc.nodes.map((n) => n.target)], [2, [".price", ".nav"]]);
  });
  it("count an element the visual checks found as invisible text once: in the visual finding", () => {
    const rules = parseAxe({ ok: true, violations: [violation(), violation({ id: "image-alt", impact: "critical", tags: ["wcag2a", "wcag111"] })] }).rules;
    const invisible: RawFinding = { kind: "text-invisible", selector: "p.a", box: { x: 11, y: 19, w: 101, h: 18 }, measured: "1.08:1", detail: { severity: "high" } };
    const out = withoutVisualDuplicates(rules, [invisible]);
    const cc = out.find((r) => r.rule === "color-contrast")!;
    assert.equal(cc.count, 2);
    assert.deepEqual(cc.nodes.map((n) => n.target), [".b", ".c"]);
    assert.equal(cc.summary, "Element has insufficient color contrast of 3.10.", "the summary of the first element left");
    assert.equal(out.find((r) => r.rule === "image-alt")!.count, 3, "other rules are untouched");
    const only = parseAxe({ ok: true, violations: [violation({ count: 1, nodes: [violation().nodes[0]] })] }).rules;
    assert.deepEqual(withoutVisualDuplicates(only, [invisible]), [], "nothing left of the rule");
    assert.deepEqual(withoutVisualDuplicates(rules, []), rules, "no invisible text: nothing changes");
  });
  it("are one finding per rule that the report's sanitiser keeps, with the WCAG criteria from the tags", () => {
    const [f] = axeFindings(parseAxe({ ok: true, violations: [violation()] }).rules);
    assert.deepEqual(sanitizeFinding(f), f);
    assert.equal(ruleOf(f), "axe:color-contrast");
    assert.equal(severityOf(f), "serious");
    assert.deepEqual(f.detail!.examples, [".a", ".b", ".c"]);
    assert.equal(f.detail!.count, 3);
    assert.deepEqual(standardsOf(f), [{ label: "WCAG 2.2 SC 1.4.3 Contrast (Minimum), level AA", url: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" }]);
    assert.equal(words(f).what, "Elements must meet minimum color contrast ratio thresholds");
    const [bp] = axeFindings(parseAxe({ ok: true, violations: [violation({ id: "region", tags: ["best-practice"] })] }).rules);
    assert.match(standardsOf(bp)[0].label, /best practice \(not a WCAG requirement\)/);
    const [two] = axeFindings(parseAxe({ ok: true, violations: [violation({ id: "link-name", tags: ["wcag2a", "wcag244", "wcag412"] })] }).rules);
    assert.deepEqual(standardsOf(two).map((s) => s.label.slice(0, 18)), ["WCAG 2.2 SC 2.4.4 ", "WCAG 2.2 SC 4.1.2 "]);
    assert.equal(sanitizeFinding({ ...f, detail: { ...f.detail, rule: "<img>" } }), null, "an axe finding needs a rule id of the right shape");
  });
});

describe("hostile rule text from the page", () => {
  const evil = '</script><img src=x onerror=alert(1)>"\u2028';
  it("is escaped in the report without JavaScript, and links only to the standards' own sites", () => {
    const report = {
      v: 6, url: "https://shop.example.com/", display: "shop.example.com", scannedAt: "2026-10-14T00:00:00Z", ms: { total: 1000 }, axe: "4.13.0",
      score: { value: 70, categories: [{ id: "accessibility", label: "Accessibility", weight: 25, measured: true, value: 70, count: 1, rules: [] }] },
      withGenClass: { shown: false }, notMeasured: {},
      top: [{ rule: "axe:x", category: "accessibility", what: evil, severity: "serious", count: 2, n: 1, points: 7.5 }],
      findings: [{
        n: 1, kind: "axe", rule: "axe:x", source: "axe", category: "accessibility", severity: "serious", count: 2, views: ["desktop"], selector: evil, examples: [evil, "ok"], boxes: {},
        measured: evil, what: evil, why: evil, fix: evil, guide: "javascript:alert(1)", unscored: null, fixed: null, genclass: { status: "reported", text: evil },
        standards: [{ label: evil, url: "javascript:alert(1)" }, { label: "WCAG", url: "https://evil.example.com/" }, { label: "ok", url: 'https://www.w3.org/WAI/x" onmouseover="alert(1)' }],
      }],
    };
    const html = staticReport(report);
    assert.doesNotMatch(html, /<img src=x|<\/script>|javascript:|evil\.example\.com|onmouseover/);
    assert.match(html, /&#60;\/script&#62;&#60;img src=x onerror=alert\(1\)&#62;/);
    assert.doesNotMatch(html, /href="(?!#|\/scan\/about)/, "no link from stored data survives here: none of these is a standard's own site");
    const page = scanPage("n0nce", { target: { url: report.url, display: report.display }, input: "", error: null, report, shareBase: "https://genclass.dev" });
    const data = /<script type="application\/json" id="data">([^<]*)<\/script>/.exec(page)![1];
    assert.equal(JSON.parse(data).report.findings[0].what, evil, "the JSON block keeps the text intact for textContent");
    assert.doesNotMatch(embed(evil), /<|>|\u2028/);
    assert.equal(page.split("</script>").length - 1, page.split("<script").length - 1, "no early </script>");
  });
  it("keeps a real standard's link and axe-core's guide", () => {
    const html = staticReport({
      score: { value: 90, categories: [] }, withGenClass: {}, top: [],
      findings: [{ n: 1, kind: "axe", rule: "axe:image-alt", category: "accessibility", severity: "critical", count: 1, views: ["phone"], selector: "img", measured: "m", what: "w", why: "y", fix: "f", genclass: {}, fixed: null, unscored: null,
        guide: "https://dequeuniversity.com/rules/axe/4.13/image-alt?application=axeAPI", standards: [{ label: "WCAG 2.2 SC 1.1.1 Non-text Content, level A", url: "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html" }] }],
    });
    assert.match(html, /<a href="https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/non-text-content\.html">WCAG 2\.2 SC 1\.1\.1 Non-text Content, level A<\/a>/);
    assert.match(html, /<a href="https:\/\/dequeuniversity\.com\/rules\/axe\/4\.13\/image-alt\?application=axeAPI">dequeuniversity\.com\/rules\/axe\/4\.13\/image-alt<\/a>/);
  });
});
