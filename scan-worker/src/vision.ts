// GenClass Vision (beta) in the page check: the Vision v2 student (MobileNetV3-small over a 224 x 128 letterboxed crop,
// 64 measured facts joined before the head; branch wave2/vision-v2-student, vision/results/vision-v2/RESULTS.md) gives
// a second opinion on the measured visual findings the model judge (src/judge.ts) cropped. It never changes a score:
// the findings, the judge's outcomes and the score are computed exactly as without it. The report shows its score on
// each finding it saw ("Vision 0.91") and lists the findings it flags that are not scored (src/report.ts), marked beta.
//
// Where it runs: a blank tab the scanner opens in the scan's own Cloudflare browser (src/vision-page.ts), never the
// scanned page. onnxruntime-web is the pinned WASM build from jsDelivr; the model's bytes come from the private R2 key
// VISION_KEY over the scanner's DevTools connection (checked against VISION_SHA256 first), so they are never on a
// public URL. The tab opens when the first measured finding is cropped (src/scan.ts startVision): it loads while the
// other views finish and scores while the race probe and the guard pass run.
//
// Invariants:
// - Vision never throws into the scan and never holds it up: every step has a timeout, a failure leaves it off for the
//   rest of the scan (the report then says it did not run), and the scan waits for its last answers only briefly.
// - Its input is the training's (spec.json): the judge's crop (the element's box plus 24 CSS px, clipped to the
//   viewport, captured at CSS-pixel resolution, JPEG quality 90) letterboxed by Pillow's resize (vision-page.ts), and
//   the 64 facts below, computed from the row src/judge-page.ts measures the way vision/src/extract.js measured the
//   training crops. visionFacts() is score_onnx.py facts() line for line; test/vision.test.ts checks both against the
//   Python's output on synthetic rows and images (test/vision-fixtures.json).
// - The operating point is the one RESULTS.md measured behind the rules ("rules, then Vision v2": notFine >= 0.752, the
//   fresh-dev threshold for recall 0.5; 69 of the 500 rule-flagged test crops kept, 33 real, precision 0.478). Nothing
//   here was tuned on a scanned page.

import type { Crop, JudgeFacts } from "./judge.ts";
import type { BrowserLike, PageLike, RequestLike } from "./scan.ts";
import { visionPageSource } from "./vision-page.ts";

/** The model, by name, and where its bytes are. */
export const VISION_NAME = "GenClass Vision";
export const VISION_MODEL = "genclass-vision-v2";
/** R2 key in the genclass-models bucket (binding MODELS). The site worker serves only @genclass/runtime-model keys, so this one stays private. */
export const VISION_KEY = "vision/genclass-vision-v2/model.onnx";
/** sha256 and size of the exported ONNX (fp32, opset 17; export.json: 4,767,031 bytes, 1,188,787 parameters). */
export const VISION_SHA256 = "08ab85836b5f28fb7646488145ec9a712dfc1e83dcd9467024420180d1e4a1d3";
export const VISION_BYTES = 4_767_031;
/**
 * A finding is flagged from this any-problem score (notFine = 1 - P(verdict = fine)): spec.json
 * thresholdsFromFreshDev["secondStage:v2"], the fresh-dev threshold for recall 0.5, as "rules, then Vision v2" used it.
 */
export const VISION_THRESHOLD = 0.7515736222267151;
/** onnxruntime-web, the WASM-only build, the version @genclass/runtime pins (packages/runtime/package.json). */
export const VISION_ORT = {
  version: "1.30.0",
  base: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/",
  module: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.bundle.min.mjs",
} as const;

/** The numbers the report and the pages publish (vision/results/vision-v2/RESULTS.md, test-final.json, export.json). */
export const VISION_EVAL = {
  ref: "wave2/vision-v2-student, vision/results/vision-v2/RESULTS.md",
  testCrops: 1052,
  testReal: 173,
  ap: 0.611,
  apClef: 0.615,
  apOpenAI: 0.651,
  apVisionV1: 0.518,
  rules: { flagged: 500, real: 75, precision: 0.15 },
  behindRules: { kept: 69, real: 33, precision: 0.478 },
  params: 1_188_787,
  bytes: 4_767_031,
  msPerCrop: 0.53,
  labels: "AI labeller agents (Claude subagents), not people",
  teacher: "OpenAI's Decisions API (gpt-6-luna, public beta), its family answer averaged with Clef's",
} as const;

/** The one line the report shows above Vision's list. */
export const VISION_LINE = "Beta model. On our test, about half of what it flags is a real bug.";

/** How long the scan waits for Vision's last answers after the guard pass (they normally came in during it). */
export const VISION_TAIL_MS = 2500;
const INIT_MS = 15_000;
const LOAD_MS = 12_000;
const SCORE_MS = 4000;
/** The model goes to the tab in pieces, so the views' DevTools messages are not held up behind one large message. */
const CHUNK = 768 * 1024;

// ------------------------------------------------------------------------------------------- the 64 facts

export const FACT_NAMES = [
  "phone", "dark", "pageSideways", "pageSidewaysPx", "appDark", "pageFailedLoads",
  "x/vw", "right/vw", "y/vh", "bottom/vh", "logW", "logH", "inv",
  "inCropX", "inCropY", "inCropW", "inCropH",
  "interactive", "pointer", "pointerEventsNone", "disabled", "fixedOrSticky", "absolute",
  "hasOwnText", "logOwnText", "logAllText", "fontSize", "contrast", "contrastMissing", "bgKnown",
  "paintContrast", "paintContrastMissing", "effOpacity",
  "hitSelf", "hitOther", "hitAncestor", "hitNone",
  "tagImg", "tagSvg", "tagMedia", "tagButton", "tagA", "tagField", "tagText", "tagOther",
  "imgBroken", "imgDistortion", "imgNoNaturalSize", "imgNoAlt",
  "scrollsX", "scrollsY", "overflowHidden", "clipAncestors", "clipVisible", "textSpill",
  "leakPattern", "undefinedVar", "zIndex", "transform", "filter", "animation", "bgImage", "logKids", "clipPath",
] as const;

const TEXT_TAGS = new Set(["p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "li", "label", "small", "strong", "em", "b", "i", "td", "th", "dt", "dd", "blockquote", "figcaption", "code", "pre"]);

/** One crop's input, in score_onnx.py's item shape: the element row, its page record, the view and the crop geometry. */
export interface VisionItem {
  device: string;
  scheme: string;
  page: Record<string, unknown> | null;
  el: Record<string, unknown>;
  kids: unknown;
  crop: { size: number[]; inCrop: number[] };
}

/** Python's isinstance(v, (int, float)) (a bool is an int there). */
const pyNumber = (v: unknown): boolean => typeof v === "number" || typeof v === "boolean";
/** score_onnx.py num(): a number that is not NaN, else the default. */
const num = (v: unknown, d = 0): number => (typeof v === "number" ? (v === v ? v : d) : typeof v === "boolean" ? (v ? 1 : 0) : d);
/** Python truthiness. */
const truthy = (v: unknown): boolean =>
  !(v === undefined || v === null || v === 0 || v === "" || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0));
const b = (v: boolean): number => (v ? 1 : 0);
/** Python's `x == 0` for a value that may be missing (then the default 0). */
const isZero = (v: unknown): boolean => v === undefined || v === 0 || v === false;

/**
 * score_onnx.py facts(): the 64 measured facts of one item as float32 values (NaN to 0, infinities to +-3, clipped to
 * [-3, 3]), in FACT_NAMES order. Line for line the Python, Python's semantics kept (missing keys, truthiness, bools).
 */
export function visionFacts(it: VisionItem): number[] {
  const e = it.el;
  const p = (it.page ?? {}) as Record<string, unknown>;
  const vw = num(p.vw, 1366) || 1366;
  const vh = num(p.vh, 768) || 768;
  const sw = num(p.scrollW);
  const cw = num(p.clientW);
  const res = (truthy(p.res) ? p.res : {}) as Record<string, unknown>;
  const x = num(e.x);
  const y = num(e.y);
  const w = num(e.w);
  const h = num(e.h);
  const cs = it.crop.size;
  const ic = it.crop.inCrop;
  const cr = e.cr;
  const scr = e.scr;
  const tag = typeof e.tag === "string" ? e.tag : "";
  const hs = e.hs;
  const f = [
    b(it.device === "phone"), b(it.scheme === "dark"),
    b(sw > cw + 1), Math.log1p(Math.max(0, sw - cw)) / 7, b(truthy(p.appDark)),
    Math.min(1, (num(res.imgFailed) + num(res.cssFailed) + num(res.fontFailed)) / 3),
    x / vw, (x + w) / vw, y / vh, (y + h) / vh, Math.log1p(Math.max(0, w)) / 8, Math.log1p(Math.max(0, h)) / 8, num(e.inv),
    num(ic[0]) / Math.max(1, cs[0]), num(ic[1]) / Math.max(1, cs[1]), num(ic[2]) / Math.max(1, cs[0]), num(ic[3]) / Math.max(1, cs[1]),
    b(truthy(e.ia)), b(truthy(e.cur)), b(truthy(e.pen)), b(truthy(e.dis)),
    b(e.pos === "f" || e.pos === "s"), b(e.pos === "a"),
    b(truthy(e.tl)), Math.log1p(num(e.tl)) / 7, Math.log1p(num(e.tt)) / 8, num(e.fs, 16) / 32,
    pyNumber(cr) ? Math.log(Math.max(1, num(cr, 1))) / Math.log(21) : 0, pyNumber(cr) ? 0 : 1,
    b(isZero(e.ebs)),
    pyNumber(scr) ? Math.log(Math.max(1, num(scr, 1))) / Math.log(21) : 0, pyNumber(scr) ? 0 : 1,
    num(e.eop, 1) * num(e.op, 1),
    num(hs, 0) / 5, num(e.ho) / 5, num(e.ha) / 5, num(e.hn) / 5,
    b(tag === "img"), b(["svg", "path", "use", "g"].includes(tag)),
    b(["video", "canvas", "iframe", "picture", "object", "embed"].includes(tag)),
    b(tag === "button"), b(tag === "a"), b(["input", "select", "textarea"].includes(tag)),
    b(TEXT_TAGS.has(tag)), 0,
    b(tag === "img" && truthy(e.cmp) && !truthy(e.iok)), Math.min(1, num(e.dist)),
    b(tag === "img" && !truthy(num(e.nw))), b(tag === "img" && (e.alt === undefined ? -1 : e.alt) === -1),
    b(e.sw !== undefined && e.sw !== null && num(e.sw) > num(e.cw) + 1),
    b(e.sh !== undefined && e.sh !== null && num(e.sh) > num(e.ch) + 1),
    b(e.ox === "h" || e.ox === "c" || e.oy === "h" || e.oy === "c"),
    Math.min(1, num(e.nca) / 3), num(e.cvis, 1), Math.min(1, num(e.tspill) / 20),
    b(truthy(e.lk)), b(truthy(e.vu) || truthy(e.vi)),
    b(e.z !== undefined && e.z !== null), b(truthy(e.tf)), b(truthy(e.flt)),
    b(truthy(e.an)), b(truthy(e.bgi)), Math.log1p(num(it.kids)) / 4,
    b(truthy(e.clip) || truthy(e.cpath)),
  ];
  if (f.length !== FACT_NAMES.length) throw new Error("facts out of step with FACT_NAMES");
  const k = FACT_NAMES.indexOf("tagOther");
  f[k] = f.slice(k - 7, k).reduce((s, v) => s + v, 0) === 0 ? 1 : 0;
  return f.map((v) => {
    const q = Math.fround(v);
    const c = Number.isNaN(q) ? 0 : q === Infinity ? 3 : q === -Infinity ? -3 : q;
    return c < -3 ? -3 : c > 3 ? 3 : c;
  });
}

/**
 * The item for one crop the judge took: its measured row (src/judge-page.ts "facts") with the training's two
 * differences made up: the child count capped at 12, as vision_v1/build_index.py capped it, and the undefined-var()
 * count, which the judge measures only for css-var-undefined findings (`undefinedVar`: what the scanner's own pass
 * measured for the others, false when it could not).
 */
export function visionItem(f: JudgeFacts, c: Crop, undefinedVar: boolean): VisionItem {
  const el = { ...f.el };
  if (undefinedVar && !truthy(el.vu) && !truthy(el.vi)) el.vu = 1;
  return { device: f.device, scheme: f.scheme, page: f.page, el, kids: Math.min(12, Math.max(0, Math.round(num(f.kids)))), crop: { size: [c.w, c.h], inCrop: [...c.inCrop] } };
}

// ------------------------------------------------------------------------------------------- answers

/** What the model said about one crop (spec.json outputs: family 11 classes, any, verdict 8 classes). */
export interface VisionScore {
  any: number;
  family: number[];
  verdict: number[];
  /** Time in the tab: preparing the input, and the model's run. */
  prepMs: number;
  runMs: number;
  /** The crop's decoded size. */
  w: number;
  h: number;
}

/** An answer read back from the tab, or null when it is not the model's output shape. */
export function parseScore(v: unknown): VisionScore | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const p = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
  if (o.ok !== true || !p(o.any) || !Array.isArray(o.family) || o.family.length !== 11 || !o.family.every(p) || !Array.isArray(o.verdict) || o.verdict.length !== 8 || !o.verdict.every(p)) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return { any: o.any as number, family: o.family as number[], verdict: o.verdict as number[], prepMs: n(o.prepMs), runMs: n(o.runMs), w: n(o.w), h: n(o.h) };
}

/** Vision over one scan, for the report. */
export interface VisionRun {
  /** Vision was available to this scan (the model binding is there and VISION is not off). */
  on: boolean;
  /** The tab was opened: some view had a measured finding to score. */
  started: boolean;
  /** The model loaded in the tab and scored at least one crop. */
  ran: boolean;
  /** Why it did not run, or the first thing that failed. */
  error: string | null;
  /** From the browser's start to the model being ready in the tab. */
  loadMs: number | null;
  /** Crops scored, and crops it was handed that got no score. */
  scored: number;
  failed: number;
  /** Per crop in the tab (decode, letterbox and the model's run): median and slowest. */
  msMedian: number | null;
  msMax: number | null;
  /** Crops whose undefined var() fact could not be measured (taken as 0). */
  varsUnmeasured: number;
  ort: string;
}

/** What the scan hands Vision, and what it asks of it. */
export interface VisionClient {
  /**
   * Opens the Vision tab in `browser` and loads the model, in the background; never throws. `name` is the per-scan name
   * of its state in the tab; `left()` is the time the scan has left, which bounds every step.
   */
  start(browser: BrowserLike, name: string, left: () => number): void;
  /** Scores one crop (base64 JPEG) with its 64 facts; null when Vision is not running or the answer was not usable. */
  score(jpeg: string, facts: number[]): Promise<VisionScore | null>;
  /** Resolves when every crop handed over so far has its answer (or none). */
  idle(): Promise<void>;
  /** Counts a crop whose undefined-var() fact was not measured. */
  noteVars(unmeasured: number): void;
  run(): VisionRun;
  close(): Promise<void>;
}

/** The model's bytes as base64, checked against VISION_SHA256; null when they are missing or different. */
export interface VisionModel {
  b64: string;
  sha256: string;
}

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Reads the model from R2 and checks it; null when it is missing or its sha256 is not VISION_SHA256. */
export async function readVisionModel(bucket: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }): Promise<VisionModel | null> {
  const obj = await bucket.get(VISION_KEY);
  if (!obj) return null;
  const buf = await obj.arrayBuffer();
  const sha = hex(await crypto.subtle.digest("SHA-256", buf));
  if (sha !== VISION_SHA256) return null;
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return { b64: btoa(s), sha256: sha };
}

const parse = (v: unknown): Record<string, unknown> | null => {
  try {
    const o = typeof v === "string" ? JSON.parse(v) : v;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const timed = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 100) / 10} s`)), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/** Vision for one scan, in its own tab of the scan's browser. `model` reads the bytes (the caller caches them per isolate). */
export function visionRunner(model: () => Promise<VisionModel | null>, now: () => number): VisionClient {
  let page: PageLike | null = null;
  let tab = "";
  let left: () => number = () => 0;
  let started = false;
  let ready: Promise<boolean> = Promise.resolve(false);
  let tail: Promise<unknown> = Promise.resolve();
  let error: string | null = null;
  let loadMs: number | null = null;
  let scored = 0;
  let failed = 0;
  let varsUnmeasured = 0;
  const times: number[] = [];
  const fail = (e: unknown) => {
    error = error ?? (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return false;
  };
  const bound = (ms: number) => Math.max(0, Math.min(ms, left() - 500));
  return {
    start(browser: BrowserLike, name: string, timeLeft: () => number): void {
      const t0 = now();
      tab = name;
      left = timeLeft;
      started = true;
      ready = (async () => {
        const p = await timed(browser.newWindowPage ? browser.newWindowPage() : browser.newPage(), bound(8000), "opening the Vision tab");
        page = p;
        // the tab loads onnxruntime-web from its pinned folder on jsDelivr and nothing else
        await p.setRequestInterception(true);
        p.on("request", (req: RequestLike) => {
          const u = req.url();
          void (u.startsWith(VISION_ORT.base) && req.method() === "GET" ? req.continue() : req.abort("blockedbyclient")).catch(() => undefined);
        });
        const bytes = model();
        const init = parse(await timed(p.evaluate(visionPageSource("init", { name, module: VISION_ORT.module, base: VISION_ORT.base })), bound(INIT_MS), "loading onnxruntime-web"));
        if (!init || init.ok !== true) throw new Error(`onnxruntime-web did not load (${String(init?.error ?? "no answer")})`);
        const m = await timed(bytes, bound(LOAD_MS), "reading the model");
        if (!m) throw new Error("the model could not be read or did not match its sha256");
        for (let i = 0; i < m.b64.length; i += CHUNK) {
          const put = parse(await timed(p.evaluate(visionPageSource("put", { name, part: m.b64.slice(i, i + CHUNK), first: i === 0 })), bound(LOAD_MS), "handing the model over"));
          if (!put || put.ok !== true) throw new Error("the tab did not take the model");
        }
        const load = parse(await timed(p.evaluate(visionPageSource("load", { name })), bound(LOAD_MS), "creating the model session"));
        if (!load || load.ok !== true) throw new Error(`the model did not load (${String(load?.error ?? "no answer")})`);
        loadMs = now() - t0;
        return true;
      })().catch(fail);
    },
    score(jpeg: string, facts: number[]): Promise<VisionScore | null> {
      const job = tail.then(async () => {
        if (!(await ready) || !page) {
          failed++;
          return null;
        }
        try {
          const out = parseScore(parse(await timed(page.evaluate(visionPageSource("score", { name: tab, jpeg, facts })), bound(SCORE_MS), "scoring a crop")));
          if (!out) {
            failed++;
            return null;
          }
          scored++;
          times.push(Math.round((out.prepMs + out.runMs) * 10) / 10);
          return out;
        } catch (e) {
          failed++;
          fail(e);
          return null;
        }
      });
      tail = job.catch(() => undefined);
      return job;
    },
    idle: () => tail.then(() => undefined),
    noteVars(n: number) {
      varsUnmeasured += n;
    },
    run(): VisionRun {
      const t = [...times].sort((a, c) => a - c);
      return {
        on: true, started, ran: scored > 0, error, loadMs, scored, failed,
        msMedian: t.length ? t[Math.floor((t.length - 1) / 2)] : null, msMax: t.length ? t[t.length - 1] : null,
        varsUnmeasured, ort: VISION_ORT.version,
      };
    },
    async close() {
      if (page) await page.close().catch(() => undefined);
    },
  };
}
