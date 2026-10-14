// Reference evaluator for the compact tree format that train/export.py writes ("genclass-gbt-1"). No
// dependencies; the runtime would carry the same loop. score(model, x) takes one element's inputs in the order of
// model.inputs (common.py model_inputs: the extractor columns minus pRound, pVw, pVh, pDark, then the box relative
// to the viewport) and returns the fault probability.
//
// Parity and cost check on a node (never on the Mac):
//   node vision/train/gbt.mjs ~/vision-out/export/gbt-small.json ~/vision-out/export/sample-X-gbt-small.f32 \
//        ~/vision-out/export/sample-p-gbt-small.f64

export function prepare(model) {
  model._cats = model.cats.map((c) => new Set(c));
  return model;
}

export function score(model, x) {
  const { trees, leaves, _cats } = model;
  let s = model.base;
  for (let t = 0; t < trees.length; t++) {
    const nodes = trees[t];
    let k = 0;
    for (;;) {
      const o = 4 * k;
      const f = nodes[o];
      let left;
      if (f < 0) {
        const v = x[-1 - f];
        left = v >= 0 && Number.isInteger(v) && _cats[nodes[o + 1]].has(v);
      } else left = x[f] <= nodes[o + 1];
      k = left ? nodes[o + 2] : nodes[o + 3];
      if (k < 0) {
        s += leaves[t][-1 - k];
        break;
      }
    }
  }
  return 1 / (1 + Math.exp(-s));
}

async function main(argv) {
  const { readFileSync } = await import("node:fs");
  const [modelPath, xPath, pPath] = argv;
  const model = prepare(JSON.parse(readFileSync(modelPath, "utf8")));
  const F = model.inputs.length;
  const xb = readFileSync(xPath);
  const X = new Float32Array(xb.buffer, xb.byteOffset, xb.byteLength / 4);
  const pb = readFileSync(pPath);
  const P = new Float64Array(pb.buffer, pb.byteOffset, pb.byteLength / 8);
  const n = X.length / F;
  const rows = [];
  for (let r = 0; r < n; r++) rows.push(Array.from(X.subarray(r * F, (r + 1) * F)));
  let maxDiff = 0;
  for (let r = 0; r < n; r++) maxDiff = Math.max(maxDiff, Math.abs(score(model, rows[r]) - P[r]));
  // warm, then time 5 passes over the sample
  let sink = 0;
  for (let r = 0; r < n; r++) sink += score(model, rows[r]);
  const t0 = process.hrtime.bigint();
  for (let pass = 0; pass < 5; pass++) for (let r = 0; r < n; r++) sink += score(model, rows[r]);
  const ns = Number(process.hrtime.bigint() - t0) / (5 * n);
  console.log(JSON.stringify({ rows: n, inputs: F, trees: model.trees.length, maxAbsDiff: maxDiff, microsecondsPerElement: +(ns / 1000).toFixed(3), node: process.version, sink: sink > 0 }));
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
