// Reference evaluator for the v2 detector bundle that train/export_v2.py writes ("genclass-visual-2"). No
// dependencies beyond gbt.mjs. detect(bundle, x, ruleBits) takes one element's model inputs (bundle.inputs order:
// common.py model_inputs) and its v1 rule bits (bundle.rules order, 0 or 1; candidates.mjs v1Rules computes them
// from the view's rows) and returns [{family, score}] for each detector whose score reaches its threshold.
//
// Parity and cost check on a node (never on the Mac):
//   node vision/train/detect_v2.mjs ~/vision-out/v2/export

import { prepare, score } from "./gbt.mjs";

const logit = (p) => {
  const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(q / (1 - q));
};

export function load(bundle) {
  for (const m of Object.values(bundle.models)) {
    prepare(m);
    m._rules = m.inputs.length > bundle.inputs.length;
  }
  bundle._checkBits = bundle.detectors.map((d) => (d.checks || []).map((c) => bundle.rules.indexOf(c)));
  return bundle;
}

function modelScore(bundle, name, x, xr, cache) {
  if (cache[name] !== undefined) return cache[name];
  const m = bundle.models[name];
  return (cache[name] = score(m, m._rules ? xr() : x));
}

/** Each detector's score for one element (0 for a check filter whose checks did not flag the element). */
export function scores(bundle, x, ruleBits) {
  const cache = {};
  let joined = null;
  const xr = () => joined || (joined = x.concat(ruleBits));
  return bundle.detectors.map((d, k) => {
    if (d.kind === "check-filter" && !bundle._checkBits[k].some((i) => ruleBits[i] === 1)) return 0;
    if (d.models.length === 1 && d.coef[0] === 1 && d.intercept === 0) return modelScore(bundle, d.models[0], x, xr, cache);
    let z = d.intercept;
    d.models.forEach((name, j) => (z += d.coef[j] * logit(modelScore(bundle, name, x, xr, cache))));
    return 1 / (1 + Math.exp(-z));
  });
}

export function detect(bundle, x, ruleBits) {
  return scores(bundle, x, ruleBits)
    .map((s, k) => ({ family: bundle.detectors[k].family, score: s, threshold: bundle.detectors[k].threshold }))
    .filter((f) => f.score >= f.threshold);
}

async function main(argv) {
  const { readFileSync } = await import("node:fs");
  const dir = argv[0];
  const bundle = load(JSON.parse(readFileSync(`${dir}/visual-v2.json`, "utf8")));
  const F = bundle.inputs.length;
  const K = bundle.rules.length;
  const D = bundle.detectors.length;
  const f32 = (p) => {
    const b = readFileSync(p);
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  };
  const X = f32(`${dir}/sample-v2-X.f32`);
  const R = f32(`${dir}/sample-v2-R.f32`);
  const pb = readFileSync(`${dir}/sample-v2-p.f64`);
  const P = new Float64Array(pb.buffer, pb.byteOffset, pb.byteLength / 8);
  const n = X.length / F;
  const rows = [];
  for (let r = 0; r < n; r++) rows.push([Array.from(X.subarray(r * F, (r + 1) * F)), Array.from(R.subarray(r * K, (r + 1) * K))]);
  let maxDiff = 0;
  const flags = new Array(D).fill(0);
  for (let r = 0; r < n; r++) {
    const s = scores(bundle, rows[r][0], rows[r][1]);
    for (let k = 0; k < D; k++) {
      maxDiff = Math.max(maxDiff, Math.abs(s[k] - P[r * D + k]));
      if (s[k] >= bundle.detectors[k].threshold) flags[k]++;
    }
  }
  let sink = 0;
  for (let r = 0; r < n; r++) sink += scores(bundle, rows[r][0], rows[r][1])[0];
  const t0 = process.hrtime.bigint();
  for (let pass = 0; pass < 5; pass++) for (let r = 0; r < n; r++) sink += detect(bundle, rows[r][0], rows[r][1]).length;
  const ns = Number(process.hrtime.bigint() - t0) / (5 * n);
  console.log(JSON.stringify({ rows: n, inputs: F, ruleInputs: K, detectors: bundle.detectors.map((d) => d.family), flags,
    maxAbsDiff: maxDiff, microsecondsPerElement: +(ns / 1000).toFixed(3), node: process.version, sink: sink >= 0 }));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
