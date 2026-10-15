// GenClass Vision: end-to-end parity of the scanner's input pipeline and onnxruntime-web 1.30.0 (WASM, one thread)
// against the Python reference scorer (vision/vision_v2/portable/score_onnx.py, onnxruntime 1.31 CPU), on the synthetic
// fixtures in test/vision-fixtures.json. Needs the private model and a folder with onnxruntime-web's
// ort.wasm.bundle.min.mjs and ort-wasm-simd-threaded.wasm (the pinned files the Vision tab loads), so it is not part of
// npm test; CALIBRATION.md and VISION.md record what it printed.
//
//   node scripts/vision-parity.ts --model model.onnx --ort <folder>
//
// For each fixture image: rebuild it (test/vision-pixels.ts), letterbox it with src/vision-page.ts, compute the facts
// with src/vision.ts, run the model, and compare `any`, `family` and `verdict` with the Python's scores.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { visionFacts, VISION_SHA256, VISION_THRESHOLD, type VisionItem } from "../src/vision.ts";
import { letterbox } from "../src/vision-page.ts";
import { image } from "../test/vision-pixels.ts";

const { values } = parseArgs({ options: { model: { type: "string" }, ort: { type: "string" } } });
if (!values.model || !values.ort) throw new Error("usage: vision-parity.ts --model model.onnx --ort <folder>");
const modelBytes = readFileSync(values.model);
const sha = createHash("sha256").update(modelBytes).digest("hex");
if (sha !== VISION_SHA256) throw new Error(`model sha256 ${sha} is not VISION_SHA256`);
const dir = values.ort.endsWith("/") ? values.ort : `${values.ort}/`;
const ort = (await import(pathToFileURL(`${dir}ort.wasm.bundle.min.mjs`).href)) as any;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = pathToFileURL(dir).href;
const t0 = performance.now();
const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 });
const loadMs = performance.now() - t0;

interface Img { name: string; w: number; h: number; pattern: string; seed: number }
interface Item extends VisionItem { id: string; image?: string; score?: { any: number; family: number[]; verdict: number[] } }
const fx = JSON.parse(readFileSync(new URL("../test/vision-fixtures.json", import.meta.url), "utf8")) as { images: Img[]; items: Item[] };
let maxAny = 0;
let maxFam = 0;
let maxVer = 0;
let flips = 0;
const ms: number[] = [];
const rows: string[] = [];
for (const it of fx.items) {
  if (!it.image || !it.score) continue;
  const im = fx.images.find((x) => x.name === it.image)!;
  const lb = letterbox(image(im.pattern, im.w, im.h, im.seed), im.w, im.h, 4);
  const x = new Float32Array(3 * 128 * 224);
  for (let i = 0; i < 128 * 224; i++) for (let c = 0; c < 3; c++) x[c * 128 * 224 + i] = lb.data[i * 3 + c];
  const facts = Float32Array.from(visionFacts(it));
  const t1 = performance.now();
  const out = await session.run({ image: new ort.Tensor("float32", x, [1, 3, 128, 224]), facts: new ort.Tensor("float32", facts, [1, 64]) });
  ms.push(performance.now() - t1);
  const any = Number(out.any.data[0]);
  const fam = Array.from(out.family.data as Float32Array);
  const ver = Array.from(out.verdict.data as Float32Array);
  const dAny = Math.abs(any - it.score.any);
  maxAny = Math.max(maxAny, dAny);
  maxFam = Math.max(maxFam, ...fam.map((v, i) => Math.abs(v - it.score!.family[i])));
  maxVer = Math.max(maxVer, ...ver.map((v, i) => Math.abs(v - it.score!.verdict[i])));
  if (any >= VISION_THRESHOLD !== it.score.any >= VISION_THRESHOLD) flips++;
  rows.push(`${it.id} ${im.name.padEnd(11)} python ${it.score.any.toFixed(6)}  scanner ${any.toFixed(6)}  diff ${dAny.toExponential(2)}`);
}
ms.sort((a, b) => a - b);
console.log(rows.join("\n"));
console.log(
  JSON.stringify(
    {
      ort: ort.env.versions?.web ?? "",
      items: rows.length,
      maxAbsAny: maxAny,
      maxAbsFamily: maxFam,
      maxAbsVerdict: maxVer,
      thresholdFlips: flips,
      sessionMs: Math.round(loadMs),
      runMsMedian: Math.round(ms[Math.floor((ms.length - 1) / 2)] * 100) / 100,
      node: process.version,
    },
    null,
    1,
  ),
);
