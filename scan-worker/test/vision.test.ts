// GenClass Vision (src/vision.ts, src/vision-page.ts and its use in src/scan.ts, src/report.ts, src/page.ts): the
// model's input is the training's (the letterbox byte for byte and the 64 facts, against the Python reference on
// synthetic fixtures), answers are checked, a Vision that fails or hangs never breaks or changes a scan, the score is
// the same with and without it, and the report's chip, beta list and JSON block.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { handle, type AppDeps, type Env } from "../src/app.ts";
import { cropOf, type JudgeFacts } from "../src/judge.ts";
import { aboutPage, CROP_URL, scanPage } from "../src/page.ts";
import type { Report } from "../src/report.ts";
import type { BrowserLike, PageLike } from "../src/scan.ts";
import { normaliseTarget, type Target } from "../src/target.ts";
import {
  FACT_NAMES, parseScore, readVisionModel, VISION_EVAL, VISION_KEY, VISION_LINE, VISION_ORT, VISION_SHA256, VISION_TAIL_MS, VISION_THRESHOLD, visionFacts, visionItem, visionRunner,
  type VisionClient, type VisionItem, type VisionRun,
} from "../src/vision.ts";
import { letterbox, visionPageSource } from "../src/vision-page.ts";
import { FakeBrowser, fakeFetch, Limiter, MemBucket, ndjson } from "./helpers.ts";
import { image } from "./vision-pixels.ts";

interface FixtureImage { name: string; w: number; h: number; pattern: string; seed: number; nw: number; nh: number; dx: number; dy: number; filter: string; sha256: string; sum: number }
interface FixtureItem extends VisionItem { id: string; image?: string; facts: number[]; score?: { any: number; family: number[]; verdict: number[] } }
const FIX = JSON.parse(readFileSync(new URL("./vision-fixtures.json", import.meta.url), "utf8")) as { images: FixtureImage[]; items: FixtureItem[] };

describe("GenClass Vision: the letterbox is Pillow's, byte for byte (spec.json inputs.image.letterbox)", () => {
  for (const f of FIX.images) {
    it(`${f.name}: ${f.w} x ${f.h} -> ${f.nw} x ${f.nh} at (${f.dx}, ${f.dy}), ${f.filter}`, () => {
      const r = letterbox(image(f.pattern, f.w, f.h, f.seed), f.w, f.h, 4);
      assert.deepEqual([r.nw, r.nh, r.dx, r.dy], [f.nw, f.nh, f.dx, f.dy]);
      assert.equal(r.data.length, 224 * 128 * 3);
      assert.equal(r.data.reduce((s, v) => s + v, 0), f.sum);
      assert.equal(createHash("sha256").update(r.data).digest("hex"), f.sha256);
    });
  }
  it("RGB input (3 bytes a pixel) gives the same bytes as RGBA", () => {
    const f = FIX.images.find((x) => x.name === "card")!;
    assert.equal(createHash("sha256").update(letterbox(image(f.pattern, f.w, f.h, f.seed, 3), f.w, f.h, 3).data).digest("hex"), f.sha256);
  });
  it("a half rounds to even, as Python's round() (101 x 256 -> 50 x 128, not 51)", () => {
    const r = letterbox(image("stripes", 101, 256, 7), 101, 256, 4);
    assert.equal(r.nw, 50);
  });
});

describe("GenClass Vision: the 64 facts are score_onnx.py facts() (spec.json inputs.facts)", () => {
  it("names in spec.json's order", () => {
    assert.equal(FACT_NAMES.length, 64);
    assert.equal(FACT_NAMES[44], "tagOther");
    assert.equal(FACT_NAMES[56], "undefinedVar");
  });
  for (const item of FIX.items) {
    it(`${item.id}: <${String(item.el.tag)}> ${item.device} ${item.scheme}`, () => {
      const got = visionFacts(item);
      assert.equal(got.length, 64);
      for (let i = 0; i < 64; i++) assert.ok(Math.abs(got[i] - item.facts[i]) <= 1e-7 * Math.max(1, Math.abs(item.facts[i])), `${FACT_NAMES[i]}: ${got[i]} vs ${item.facts[i]}`);
    });
  }
  it("float32 values, NaN to 0, clipped to [-3, 3]", () => {
    const f = visionFacts({ device: "desktop", scheme: "light", page: { vw: 100, vh: 100 }, el: { tag: "div", x: 1000, y: -500, w: 10, h: 10 }, kids: 0, crop: { size: [58, 58], inCrop: [24, 24, 10, 10] } });
    assert.equal(f[FACT_NAMES.indexOf("x/vw")], 3);
    assert.equal(f[FACT_NAMES.indexOf("y/vh")], -3);
    for (const v of f) assert.equal(v, Math.fround(v));
  });
  it("the judge's row becomes the training's item: children capped at 12, the undefined var() counted when measured", () => {
    const facts: JudgeFacts = { device: "phone", scheme: "dark", page: { vw: 390, vh: 844, scrollW: 390, clientW: 390, res: {} }, el: { tag: "p", x: 10, y: 20, w: 100, h: 18, inv: 1, vis: 1, tl: 12 }, anc: null, kids: 40 };
    const crop = cropOf({ x: 10, y: 20, w: 100, h: 18 }, 390, 844)!;
    const it1 = visionItem(facts, crop, false);
    assert.equal(it1.kids, 12);
    assert.deepEqual(it1.crop, { size: [crop.w, crop.h], inCrop: crop.inCrop });
    assert.equal(visionFacts(it1)[FACT_NAMES.indexOf("undefinedVar")], 0);
    assert.equal(visionFacts(visionItem(facts, crop, true))[FACT_NAMES.indexOf("undefinedVar")], 1);
    assert.equal(facts.el.vu, undefined, "the judge's own row is not changed");
  });
});

describe("GenClass Vision: answers, constants and the tab's source", () => {
  it("only the model's output shape is read back", () => {
    const ok = { ok: true, any: 0.8, family: Array(11).fill(1 / 11), verdict: Array(8).fill(1 / 8), prepMs: 3, runMs: 9, w: 100, h: 60 };
    assert.equal(parseScore(ok)?.any, 0.8);
    assert.equal(parseScore({ ...ok, ok: false }), null);
    assert.equal(parseScore({ ...ok, any: 1.2 }), null);
    assert.equal(parseScore({ ...ok, any: Number.NaN }), null);
    assert.equal(parseScore({ ...ok, family: Array(10).fill(0.1) }), null);
    assert.equal(parseScore({ ...ok, verdict: [...Array(7).fill(0.1), "x"] }), null);
    assert.equal(parseScore("nonsense"), null);
  });
  it("the operating point is spec.json's secondStage:v2 and the numbers are RESULTS.md's", () => {
    assert.equal(VISION_THRESHOLD, 0.7515736222267151);
    assert.deepEqual(VISION_EVAL.behindRules, { kept: 69, real: 33, precision: 0.478 });
    assert.deepEqual(VISION_EVAL.rules, { flagged: 500, real: 75, precision: 0.15 });
    assert.equal(VISION_EVAL.ap, 0.611);
    assert.match(VISION_SHA256, /^[0-9a-f]{64}$/);
    assert.ok(!/^@genclass\/runtime-model@/.test(VISION_KEY), "a key the site worker does not serve");
    assert.equal(VISION_ORT.module, `${VISION_ORT.base}ort.wasm.bundle.min.mjs`);
  });
  it("the tab's commands serialise without bundler names and parse", () => {
    for (const cmd of ["init", "put", "load", "score"] as const) {
      const src = visionPageSource(cmd, { name: "__gcsv", jpeg: "", facts: [] });
      assert.doesNotMatch(src, /__name\(/);
      assert.doesNotThrow(() => new Function(`return ${src}`));
    }
  });
});

// ------------------------------------------------------------------------------------------- in a scan

const DNS = { "shop.example.com": ["93.184.215.14"] };
const FINDING = (view: string): unknown[] => (view === "desktop" ? [{ kind: "text-invisible", selector: "p.fine", box: { x: 10, y: 40, w: 200, h: 24 }, measured: "text contrast 1.08:1 on p.fine", detail: { severity: "high" } }] : []);
/** The judge's page side on the fake page: the visual finding only, measured as judge-page.ts measures it. */
function judgeSide(vars: Record<string, number> | null) {
  return (view: string, cmd: string, arg: Record<string, any>): unknown => {
    const vw = view === "desktop" ? 1366 : 390;
    const vh = view === "desktop" ? 768 : 844;
    if (cmd === "find") return { ok: true, vw, vh, sx: 0, sy: 0, items: (arg.targets as any[]).map((t, i) => ({ i, cls: "finding", key: t.key, kind: t.kind, sel: t.selector, box: t.box })), unmatched: [] };
    if (cmd === "facts")
      return {
        ok: true, vw, vh, sx: 0, sy: 0, page: { vw, vh, colorScheme: "normal", scrollW: vw, clientW: vw, res: {} },
        items: (arg.idx as number[]).map((i) => ({ i, el: { tag: "p", x: 10, y: 40, w: 200, h: 24, inv: 1, vis: 1, tl: 20, tt: 20, fs: 16, cr: 1.08, c: [0, 0, 0, 1], eb: [255, 255, 255], hs: 5 }, anc: { tag: "div", w: 300, h: 300 }, kids: 30 })),
      };
    if (cmd === "vars") return vars ? { ok: true, vars } : { ok: false };
    return { ok: true };
  };
}
const fineAnswer = { model: "clef", answers: { verdict: { type: "choice", choice: "fine", probabilities: { fine: 0.9, unreadable_text: 0.1 } }, family: { type: "choice", choice: "none", probabilities: { none: 0.5, text: 0.5 } } }, usage: { input_tokens: 1300, output_tokens: 0 } };

/** A stand-in for the Vision tab: scores every crop with `score`, records what it was handed. */
function fakeVision(score: (facts: number[]) => number | "throw" | "hang") {
  const handed: { jpeg: string; facts: number[] }[] = [];
  let started = 0;
  let scored = 0;
  const c: VisionClient & { handed: typeof handed; started: () => number } = {
    handed,
    started: () => started,
    start() {
      started++;
    },
    async score(jpeg: string, facts: number[]) {
      handed.push({ jpeg, facts });
      const s = score(facts);
      if (s === "throw") throw new Error("the tab crashed");
      if (s === "hang") return new Promise<never>(() => undefined);
      scored++;
      return { any: s, family: Array(11).fill(1 / 11), verdict: Array(8).fill(1 / 8), prepMs: 2, runMs: 8, w: 248, h: 72 };
    },
    idle: async () => undefined,
    noteVars() {},
    run: (): VisionRun => ({ on: true, started: started > 0, ran: scored > 0, error: scored ? null : "the tab crashed", loadMs: 2100, scored, failed: handed.length - scored, msMedian: 10, msMax: 10, varsUnmeasured: 0, ort: "1.30.0" }),
    close: async () => undefined,
  };
  return c;
}

function setupScan(vision: VisionClient | null, vars: Record<string, number> | null = { "0": 0 }) {
  let clock = Date.parse("2026-10-15T04:00:00Z");
  const bucket = new MemBucket(() => clock);
  const deps: AppDeps = {
    launch: async () => new FakeBrowser({ findings: FINDING, judge: judgeSide(vars) }),
    fetch: fakeFetch(DNS).fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 0));
    },
    runtimeSource: async () => "window.__rt = 1;",
    visualSource: "window.__genclassScanVisual = function () {};",
    axe: null,
    scanId: () => "scan0001",
    vision: () => vision,
  };
  const env: Env = { BROWSER: { fetch }, BUCKET: bucket, SCAN_LIMIT: new Limiter(5), MAX_CONCURRENT: "2", AI: { run: async () => fineAnswer } };
  return async () => {
    const waits: Promise<unknown>[] = [];
    const res = await handle(new Request("https://genclass-scan.example.workers.dev/api/scan", { method: "POST", body: JSON.stringify({ url: "shop.example.com" }), headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil: (p) => void waits.push(p) }, deps);
    const lines = await ndjson(res);
    await Promise.all(waits);
    return { report: lines.find((l) => l.type === "done")?.report as Report | undefined, bucket };
  };
}

describe("GenClass Vision in a scan: a second opinion that never changes the score", () => {
  it("scores the crop the judge took of each measured finding, with its 64 facts; the score is the same as without it", async () => {
    const without = (await setupScan(null)()).report!;
    const v = fakeVision(() => 0.9);
    const { report: r } = await setupScan(v)();
    assert.ok(r && without);
    assert.equal(v.started(), 1);
    assert.equal(v.handed.length, 1, "the measured finding, once");
    assert.equal(v.handed[0].facts.length, 64);
    assert.equal(v.handed[0].facts[FACT_NAMES.indexOf("logKids")], Math.fround(Math.log1p(12) / 4), "children capped at 12");
    assert.equal(v.handed[0].facts[FACT_NAMES.indexOf("phone")], 0);
    // the score, the categories and every finding's scoring are those of the scan without Vision
    assert.deepEqual(r.score, without.score);
    assert.deepEqual(r.findings.map((f) => [f.kind, f.unscored, f.judge?.outcome]), without.findings.map((f) => [f.kind, f.unscored, f.judge?.outcome]));
    assert.equal(r.withGenClass.value, without.withGenClass.value);
    // the chip, the JSON block, and the beta list: the finding Clef judged as probably fine, which Vision flags
    const f = r.findings.find((x) => x.kind === "text-invisible")!;
    assert.equal(f.judge?.outcome, "fine");
    assert.deepEqual(f.vision, { score: 0.9, flagged: true, views: [{ view: "desktop", score: 0.9 }] });
    assert.equal(r.vision.ran, true);
    assert.equal(r.vision.model, "genclass-vision-v2");
    assert.equal(r.vision.threshold, VISION_THRESHOLD);
    assert.equal(r.vision.flagged, 1);
    assert.deepEqual(r.vision.findings, [{ n: f.n, score: 0.9, flagged: true }]);
    assert.equal(r.vision.beta.length, 1);
    assert.equal(r.vision.beta[0].n, f.n);
    assert.match(String(r.vision.beta[0].crop), CROP_URL);
    assert.equal(without.vision.on, false);
    assert.equal(without.findings[0].vision, null);
  });
  it("opens the Vision tab only when a measured finding is cropped", async () => {
    const v = fakeVision(() => 0.9);
    let clock = Date.parse("2026-10-15T04:00:00Z");
    const deps: AppDeps = {
      launch: async () => new FakeBrowser({ findings: () => [], judge: judgeSide(null) }),
      fetch: fakeFetch(DNS).fetch, now: () => clock, sleep: async (ms) => { clock += ms; await new Promise((r) => setTimeout(r, 0)); },
      runtimeSource: async () => "window.__rt = 1;", visualSource: "window.__genclassScanVisual = function () {};", axe: null, scanId: () => "scan0002", vision: () => v,
    };
    const env: Env = { BROWSER: { fetch }, BUCKET: new MemBucket(() => clock), SCAN_LIMIT: new Limiter(5), MAX_CONCURRENT: "2", AI: { run: async () => fineAnswer } };
    const waits: Promise<unknown>[] = [];
    const res = await handle(new Request("https://genclass-scan.example.workers.dev/api/scan", { method: "POST", body: JSON.stringify({ url: "shop.example.com" }), headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" } }), env, { waitUntil: (p) => void waits.push(p) }, deps);
    const r = (await ndjson(res)).find((l) => l.type === "done")?.report as Report | undefined;
    await Promise.all(waits);
    assert.ok(r);
    assert.equal(v.started(), 0);
    assert.equal(r.vision.started, false);
    assert.equal(r.vision.ran, false);
  });
  it("a finding it scores below the operating point keeps its chip and is not in the beta list", async () => {
    const { report: r } = await setupScan(fakeVision(() => VISION_THRESHOLD - 1e-9))();
    assert.ok(r);
    assert.equal(r.vision.flagged, 0);
    assert.equal(r.vision.beta.length, 0);
    assert.equal(r.findings[0].vision?.flagged, false);
  });
  it("a Vision that throws leaves the report without its scores, and the scan as it would be", async () => {
    const without = (await setupScan(null)()).report!;
    const { report: r } = await setupScan(fakeVision(() => "throw"))();
    assert.ok(r);
    assert.deepEqual(r.score, without.score);
    assert.equal(r.vision.ran, false);
    assert.equal(r.findings[0].vision, null);
    assert.equal(r.vision.beta.length, 0);
  });
  it("a Vision that hangs is waited for briefly, and the scan finishes without it", async () => {
    const t0 = Date.now();
    const { report: r } = await setupScan(fakeVision(() => "hang"))();
    assert.ok(r);
    assert.ok(Date.now() - t0 < VISION_TAIL_MS + 2000);
    assert.equal(r.findings[0].vision, null);
  });
  it("measures the undefined var() fact for findings the judge did not measure it on", async () => {
    const v = fakeVision(() => 0.5);
    await setupScan(v, { "0": 2 })();
    assert.equal(v.handed[0].facts[FACT_NAMES.indexOf("undefinedVar")], 1);
    const w = fakeVision(() => 0.5);
    await setupScan(w, { "0": 0 })();
    assert.equal(w.handed[0].facts[FACT_NAMES.indexOf("undefinedVar")], 0);
  });
});

describe("GenClass Vision in the report page and /scan/about", () => {
  const stored = (vision: Record<string, unknown>, findings: Record<string, unknown>[]) => ({
    v: 8, id: "s1", key: "0".repeat(32), url: "https://shop.example.com/", host: "shop.example.com", display: "shop.example.com", scannedAt: "2026-10-15T04:00:00Z",
    runtime: "0.2.1", chrome: "", axe: "", ms: { total: 20000 }, timedOut: false, views: [], score: { value: 90, categories: [] }, top: [], notMeasured: {}, metrics: {},
    withGenClass: { shown: false }, probe: {}, judge: { note: "" }, notes: [], findings, vision,
  });
  const crop = `/api/scan/shot/${"0".repeat(32)}/s0000001-desktop-j1.jpg`;
  const F = { n: 1, kind: "text-invisible", rule: "text-invisible", category: "visual", severity: "serious", count: 1, views: ["desktop"], selector: "p.fine", examples: [], boxes: {}, measured: "m", what: "Invisible text", why: "w", standards: [], fix: "f", fixed: null, genclass: { status: "reported", text: "" }, unscored: "Listed, not scored", judge: { outcome: "fine", views: [] } };
  it("shows the chip on a finding and the beta list with its crop, and nothing when Vision did not run", () => {
    const html = scanPage("nonce", { input: "shop.example.com", target: normaliseTarget("shop.example.com") as Target, report: stored({ ran: true, beta: [{ n: 1, kind: "text-invisible", what: "Invisible text", selector: "p.fine", view: "desktop", score: 0.83, crop }] }, [{ ...F, vision: { score: 0.83, flagged: true } }]), error: null } as never);
    assert.match(html, /<span class="vchip"[^>]*>Vision 0\.83<\/span>/);
    assert.match(html, new RegExp(`${VISION_LINE.replace(/[.]/g, "\\.")}`));
    assert.ok(html.includes(`<img src="${crop}"`));
    assert.ok(html.includes('href="#sf-1"'));
    const off = scanPage("nonce", { input: "shop.example.com", target: normaliseTarget("shop.example.com") as Target, report: stored({ ran: false, beta: [{ n: 1, score: 0.9, crop }] }, [F]), error: null } as never);
    assert.doesNotMatch(off, /class="vbeta">/);
    assert.doesNotMatch(off, /<span class="vchip"/);
  });
  it("escapes what a stored report says and shows only this origin's crop URLs", () => {
    const html = scanPage("nonce", { input: "x", target: normaliseTarget("shop.example.com") as Target, report: stored({ ran: true, beta: [{ n: 1, what: "<script>x</script>", view: "desktop", score: 0.9, crop: "https://evil.example/a.jpg" }, { n: 2, what: "w", view: "desktop", score: 0.95, crop: "javascript:alert(1)" }] }, [F]), error: null } as never);
    const ssr = html.slice(html.indexOf('<div id="ssr">'), html.indexOf("</main>"));
    assert.match(ssr, /class="vbeta">/);
    assert.doesNotMatch(ssr, /<script>x<\/script>/);
    assert.match(ssr, /&#60;script&#62;x&#60;\/script&#62;/);
    assert.doesNotMatch(ssr, /evil\.example/);
    assert.doesNotMatch(ssr, /javascript:/);
    const block = html.slice(html.indexOf('id="data">') + 10, html.indexOf("</script>", html.indexOf('id="data">')));
    assert.doesNotMatch(block, /</, "the JSON block has no raw <");
  });
  it("/scan/about says what it is, that it is not scored, its numbers, and that AI agents made the labels", () => {
    const about = aboutPage("nonce");
    assert.match(about, /id="vision"/);
    assert.match(about, /GenClass Vision \(beta\)/);
    assert.match(about, /never\s+changes a finding or the score/);
    assert.ok(about.includes(`${VISION_EVAL.behindRules.real} of those were real`));
    assert.ok(about.includes("AI labeller agents"));
    assert.match(about, /looks at the same crops inside the same Cloudflare browser\. Nothing more is sent anywhere\./);
  });
});

// ------------------------------------------------------------------------------------------- the runner

describe("GenClass Vision's tab (visionRunner)", () => {
  /** A fake tab: answers each command of vision-page.ts; records the requests it let through. */
  function tab(answers: Partial<Record<"init" | "put" | "load" | "score", unknown>>) {
    const seen: string[] = [];
    const routed: { url: string; how: string }[] = [];
    let onRequest: ((r: any) => void) | null = null;
    const page = {
      async setRequestInterception() {},
      on(ev: string, h: (r: any) => void) {
        if (ev === "request") onRequest = h;
      },
      async evaluate(src: string) {
        const cmd = /\)\("(init|put|load|score)", /.exec(src)?.[1] ?? "";
        seen.push(cmd);
        if (cmd === "init" && onRequest) {
          for (const url of [`${VISION_ORT.base}ort-wasm-simd-threaded.wasm`, "https://example.com/x.js", `${VISION_ORT.base}x`.replace("1.30.0", "1.29.0")])
            onRequest({ url: () => url, method: () => "GET", continue: async () => void routed.push({ url, how: "continue" }), abort: async () => void routed.push({ url, how: "abort" }) });
        }
        return JSON.stringify(answers[cmd as keyof typeof answers] ?? { ok: false });
      },
      async close() {},
    } as unknown as PageLike;
    const browser = { newPage: async () => page, version: async () => "", close: async () => undefined } as unknown as BrowserLike;
    return { browser, seen, routed };
  }
  const MODEL = { b64: "A".repeat(2_000_000), sha256: VISION_SHA256 };
  const OUT = { ok: true, any: 0.4, family: Array(11).fill(0.05), verdict: Array(8).fill(0.1), prepMs: 3, runMs: 7, w: 100, h: 50 };
  it("loads onnxruntime-web, hands the model over in pieces, then scores; only the pinned ORT folder is loaded", async () => {
    const t = tab({ init: { ok: true, version: "1.30.0" }, put: { ok: true }, load: { ok: true }, score: OUT });
    const v = visionRunner(async () => MODEL, () => 0);
    v.start(t.browser, "__v", () => 40_000);
    const s = await v.score("/9j/", Array(64).fill(0));
    assert.equal(s?.any, 0.4);
    assert.deepEqual(t.seen, ["init", "put", "put", "put", "load", "score"]);
    assert.deepEqual(t.routed.map((r) => r.how), ["continue", "abort", "abort"]);
    const run = v.run();
    assert.equal(run.ran, true);
    assert.equal(run.scored, 1);
    assert.equal(run.ort, "1.30.0");
  });
  it("does not run when the model cannot be read (missing, or not the pinned sha256), and says why", async () => {
    const t = tab({ init: { ok: true }, put: { ok: true }, load: { ok: true }, score: OUT });
    const v = visionRunner(async () => null, () => 0);
    v.start(t.browser, "__v", () => 40_000);
    assert.equal(await v.score("/9j/", Array(64).fill(0)), null);
    assert.equal(v.run().ran, false);
    assert.match(String(v.run().error), /sha256/);
    assert.ok(!t.seen.includes("score"));
  });
  it("reads only the model's output shape back from the tab", async () => {
    const t = tab({ init: { ok: true }, put: { ok: true }, load: { ok: true }, score: { ...OUT, family: [1] } });
    const v = visionRunner(async () => MODEL, () => 0);
    v.start(t.browser, "__v", () => 40_000);
    assert.equal(await v.score("/9j/", Array(64).fill(0)), null);
    assert.equal(v.run().failed, 1);
  });
  it("reads the model from R2 only when its sha256 is the pinned one", async () => {
    const bucket = (bytes: Uint8Array | null) => ({ get: async (k: string) => (k === VISION_KEY && bytes ? { arrayBuffer: async () => bytes.buffer as ArrayBuffer } : null) });
    assert.equal(await readVisionModel(bucket(null)), null);
    assert.equal(await readVisionModel(bucket(new Uint8Array([1, 2, 3]))), null);
  });
});
