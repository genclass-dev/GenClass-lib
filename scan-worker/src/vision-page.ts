// The page side of GenClass Vision (src/vision.ts): runs in a blank tab of the scan's browser that the scanner opens for
// it, never in the scanned site's page, so the site's scripts cannot see or change the model, its input or its
// answers. Serialised with toString() like src/judge-page.ts: self-contained, DOM through `any`.
//
//   "init"   loads onnxruntime-web (the pinned WASM build from jsDelivr, one thread) into the tab
//   "put"    takes one piece of the model's bytes (base64; the scanner checked their sha256 and sends them in pieces)
//   "load"   creates the session from those bytes
//   "score"  one crop: decodes the JPEG the judge's capture made, letterboxes it as the training did, runs the model
//            with the 64 measured facts, returns its outputs
//
// letterbox() is Pillow's resize, ported: the training and the reference scorer (vision/vision_v2/portable/
// score_onnx.py) letterbox with Image.resize (bicubic up, bilinear down, at most 2x), so the scanner computes the same
// 224 x 128 input bytes instead of approximating them with the canvas's own scaling. test/vision.test.ts checks it
// against the Python's output byte for byte (sha256).

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The model's input size and the letterbox rules (spec.json inputs.image.letterbox). */
export const LETTERBOX = { width: 224, height: 128, maxUpscale: 2, fill: 128 } as const;

/**
 * score_onnx.py letterbox(): fit a w x h image into 224 x 128 keeping its aspect ratio (upscaled at most 2x), centred
 * on grey (128), offsets floor((W - w') / 2) and floor((H - h') / 2). The resize is Pillow's (libImaging/Resample.c:
 * precompute_coeffs, normalize_coeffs_8bpc and the 8-bit horizontal then vertical passes, 22-bit fixed point), bicubic
 * (a = -0.5) when scaling up and bilinear when scaling down; an image whose size does not change is copied. Sizes are
 * rounded as Python rounds (an exact half to even). `px` holds `stride` bytes per pixel (4 for canvas ImageData, 3 for
 * RGB); the result is the RGB input, row by row (HWC, uint8).
 *
 * Self-contained (no outer names): it is serialised into the Vision tab.
 */
export function letterbox(px: ArrayLike<number>, w: number, h: number, stride: number): { data: Uint8Array; nw: number; nh: number; dx: number; dy: number; filter: string } {
  const W = 224;
  const H = 128;
  const s = Math.min(W / w, H / h, 2);
  const pyRound = (x: number): number => {
    const f = Math.floor(x);
    const d = x - f;
    return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
  };
  const nw = Math.max(1, pyRound(w * s));
  const nh = Math.max(1, pyRound(h * s));
  const up = s > 1;
  const support0 = up ? 2 : 1;
  const filt = up
    ? (x0: number): number => {
        const a = -0.5;
        const x = x0 < 0 ? -x0 : x0;
        if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
        if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
        return 0;
      }
    : (x0: number): number => {
        const x = x0 < 0 ? -x0 : x0;
        return x < 1 ? 1 - x : 0;
      };
  const PB = 22;
  // precompute_coeffs + normalize_coeffs_8bpc for one axis: bounds (first index, count) and fixed-point weights
  const coeffs = (inSize: number, outSize: number) => {
    const scale = inSize / outSize;
    const filterscale = scale < 1 ? 1 : scale;
    const support = support0 * filterscale;
    const ksize = Math.ceil(support) * 2 + 1;
    const bounds = new Int32Array(outSize * 2);
    const kk = new Float64Array(outSize * ksize);
    for (let xx = 0; xx < outSize; xx++) {
      const center = (xx + 0.5) * scale;
      const ss = 1 / filterscale;
      let xmin = Math.trunc(center - support + 0.5);
      if (xmin < 0) xmin = 0;
      let xmax = Math.trunc(center + support + 0.5);
      if (xmax > inSize) xmax = inSize;
      xmax -= xmin;
      let ww = 0;
      for (let x = 0; x < xmax; x++) {
        const v = filt((x + xmin - center + 0.5) * ss);
        kk[xx * ksize + x] = v;
        ww += v;
      }
      for (let x = 0; x < xmax; x++) if (ww !== 0) kk[xx * ksize + x] /= ww;
      bounds[xx * 2] = xmin;
      bounds[xx * 2 + 1] = xmax;
    }
    const k = new Int32Array(outSize * ksize);
    for (let i = 0; i < k.length; i++) k[i] = kk[i] < 0 ? Math.trunc(-0.5 + kk[i] * (1 << PB)) : Math.trunc(0.5 + kk[i] * (1 << PB));
    return { ksize, bounds, k };
  };
  const clip8 = (v: number): number => {
    const q = Math.floor(v / (1 << PB));
    return q < 0 ? 0 : q > 255 ? 255 : q;
  };
  // the image as RGB rows
  let cur = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += stride) {
    cur[i * 3] = px[j];
    cur[i * 3 + 1] = px[j + 1];
    cur[i * 3 + 2] = px[j + 2];
  }
  let cw = w;
  let ch = h;
  if (nw !== w || nh !== h) {
    const horiz = nw !== w;
    const vert = nh !== h;
    const kh = coeffs(w, nw);
    const kv = coeffs(h, nh);
    if (horiz) {
      // only the rows the vertical pass reads, as Pillow does (ybox_first .. ybox_last)
      const first = kv.bounds[0];
      const last = kv.bounds[nh * 2 - 2] + kv.bounds[nh * 2 - 1];
      for (let i = 0; i < nh; i++) kv.bounds[i * 2] -= first;
      const rows = last - first;
      const out = new Uint8Array(nw * rows * 3);
      for (let yy = 0; yy < rows; yy++) {
        const src = (yy + first) * w * 3;
        for (let xx = 0; xx < nw; xx++) {
          const xmin = kh.bounds[xx * 2];
          const xmax = kh.bounds[xx * 2 + 1];
          let s0 = 1 << (PB - 1);
          let s1 = s0;
          let s2 = s0;
          for (let x = 0; x < xmax; x++) {
            const kx = kh.k[xx * kh.ksize + x];
            const p = src + (x + xmin) * 3;
            s0 += cur[p] * kx;
            s1 += cur[p + 1] * kx;
            s2 += cur[p + 2] * kx;
          }
          const o = (yy * nw + xx) * 3;
          out[o] = clip8(s0);
          out[o + 1] = clip8(s1);
          out[o + 2] = clip8(s2);
        }
      }
      cur = out;
      cw = nw;
      ch = rows;
    }
    if (vert) {
      const out = new Uint8Array(cw * nh * 3);
      for (let yy = 0; yy < nh; yy++) {
        const ymin = kv.bounds[yy * 2];
        const ymax = kv.bounds[yy * 2 + 1];
        for (let xx = 0; xx < cw; xx++) {
          let s0 = 1 << (PB - 1);
          let s1 = s0;
          let s2 = s0;
          for (let y = 0; y < ymax; y++) {
            const ky = kv.k[yy * kv.ksize + y];
            const p = ((y + ymin) * cw + xx) * 3;
            s0 += cur[p] * ky;
            s1 += cur[p + 1] * ky;
            s2 += cur[p + 2] * ky;
          }
          const o = (yy * cw + xx) * 3;
          out[o] = clip8(s0);
          out[o + 1] = clip8(s1);
          out[o + 2] = clip8(s2);
        }
      }
      cur = out;
      ch = nh;
    }
  }
  const dx = Math.floor((W - nw) / 2);
  const dy = Math.floor((H - nh) / 2);
  const data = new Uint8Array(W * H * 3).fill(128);
  for (let y = 0; y < ch && y < nh; y++) data.set(cur.subarray(y * cw * 3, (y * cw + cw) * 3), ((y + dy) * W + dx) * 3);
  return { data, nw, nh, dx, dy, filter: nw === w && nh === h ? "copy" : up ? "bicubic" : "bilinear" };
}

/**
 * The Vision tab's commands. `o.name` is the per-scan name its state lives under; `lb` is letterbox() (handed in, so
 * this function stays self-contained when serialised).
 */
export function visionPage(cmd: string, o: any, lb: typeof letterbox): any {
  const g: any = globalThis as any;
  const st = (): any => {
    const d = Object.getOwnPropertyDescriptor(g, o.name);
    return d && d.value ? d.value : null;
  };
  const t0 = g.performance.now();
  const ms = () => Math.round(g.performance.now() - t0);

  if (cmd === "init") {
    if (st()) return Promise.resolve({ ok: true, ms: 0, version: st().ort.env.versions?.web ?? "" });
    // the pinned WASM build as an ES module (its JS glue is in the bundle; the .wasm comes from the same folder)
    return new Promise((resolve) => {
      const done = (v: any) => resolve(v);
      const ev = `${o.name}-ort`;
      g.addEventListener(ev, () => {
        const ort = g[`${o.name}ort`];
        try {
          delete g[`${o.name}ort`];
        } catch (e) {
          /* keep it */
        }
        if (!ort || !ort.InferenceSession) return done({ ok: false, error: "onnxruntime-web did not load" });
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = o.base;
        ort.env.logLevel = "error";
        Object.defineProperty(g, o.name, { value: { ort, session: null, parts: [] }, writable: false, configurable: false, enumerable: false });
        done({ ok: true, ms: ms(), version: ort.env.versions?.web ?? "" });
      }, { once: true });
      const s = g.document.createElement("script");
      s.type = "module";
      s.textContent = `import * as ort from ${JSON.stringify(o.module)}; globalThis[${JSON.stringify(`${o.name}ort`)}] = ort; dispatchEvent(new Event(${JSON.stringify(ev)}));`;
      s.onerror = () => done({ ok: false, error: "the module script failed" });
      g.addEventListener("error", (e: any) => done({ ok: false, error: String(e && e.message).slice(0, 160) }), { once: true });
      (g.document.head || g.document.documentElement).appendChild(s);
    });
  }

  if (cmd === "put") {
    const s = st();
    if (!s) return Promise.resolve({ ok: false, error: "not initialised" });
    if (o.first) s.parts.length = 0;
    s.parts.push(String(o.part));
    return Promise.resolve({ ok: true, parts: s.parts.length });
  }

  if (cmd === "load") {
    const s = st();
    if (!s) return Promise.resolve({ ok: false, error: "not initialised" });
    const bin = g.atob(s.parts.join(""));
    s.parts.length = 0;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return s.ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all", logSeverityLevel: 3 }).then(
      (session: any) => {
        s.session = session;
        return { ok: true, ms: ms(), inputs: session.inputNames, outputs: session.outputNames };
      },
      (e: any) => ({ ok: false, error: String((e && e.message) || e).slice(0, 200) }),
    );
  }

  if (cmd === "score") {
    const s = st();
    if (!s || !s.session) return Promise.resolve({ ok: false, error: "no session" });
    const bin = g.atob(o.jpeg);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return g
      .createImageBitmap(new g.Blob([u], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" })
      .then((bmp: any) => {
        const w = bmp.width;
        const h = bmp.height;
        const c = new g.OffscreenCanvas(w, h);
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, w, h).data;
        bmp.close();
        const t1 = g.performance.now();
        const L = lb(px, w, h, 4);
        const x = new Float32Array(3 * 128 * 224);
        for (let y = 0; y < 128; y++)
          for (let xx = 0; xx < 224; xx++) {
            const p = (y * 224 + xx) * 3;
            x[y * 224 + xx] = L.data[p];
            x[128 * 224 + y * 224 + xx] = L.data[p + 1];
            x[2 * 128 * 224 + y * 224 + xx] = L.data[p + 2];
          }
        const facts = Float32Array.from(o.facts);
        const feeds = { image: new s.ort.Tensor("float32", x, [1, 3, 128, 224]), facts: new s.ort.Tensor("float32", facts, [1, facts.length]) };
        const t2 = g.performance.now();
        return s.session.run(feeds).then((out: any) => ({
          ok: true,
          w,
          h,
          any: Number(out.any.data[0]),
          family: Array.from(out.family.data as ArrayLike<number>).map(Number),
          verdict: Array.from(out.verdict.data as ArrayLike<number>).map(Number),
          prepMs: Math.round((t2 - t1) * 10) / 10,
          runMs: Math.round((g.performance.now() - t2) * 10) / 10,
          ms: ms(),
        }));
      })
      .catch((e: any) => ({ ok: false, error: String((e && e.message) || e).slice(0, 200) }));
  }
  return Promise.resolve({ ok: false, error: "unknown command" });
}

/** The source that runs one Vision tab command and returns its result as a JSON string. */
export function visionPageSource(cmd: "init" | "put" | "load" | "score", options: Record<string, unknown>): string {
  return `(async () => JSON.stringify(await (${visionPage.toString()})(${JSON.stringify(cmd)}, ${JSON.stringify(options)}, (${letterbox.toString()}))))()`;
}
