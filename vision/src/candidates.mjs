// Candidates for labelling (v2): on natural (never injected) views, the elements whose crops a person labels to
// build a real-bug test set. Per view, at most 6, chosen as
//   - the top-scoring elements of the v1 gbt-small model (vision/results/train/gbt-small.json, scored here with the
//     frozen v1 encoder and train/gbt.mjs),
//   - every element the v1 rules flag (train/common.py `rules`, ported to raw rows below),
//   - 2 random visible elements,
// all at least partly in the viewport (crops come from a viewport screenshot). Pure functions: crawl.mjs calls them
// on the node; test/candidates.test.mjs checks them without a browser.
//
// The v1 encoder is frozen here on purpose: build_set.mjs v2 changed the feature set, and the v1 model needs the 112
// v1 columns with the v1 categorical codes (vision/results/schema.json).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prepare, score as gbtScore } from "../train/gbt.mjs";

// ---------------------------------------------------------------- the v1 feature vector (build_set.mjs at 14483a1)

const V1_NUM = [
  ["d", 0], ["x", 0], ["y", 0], ["w", 0], ["h", 0], ["inv", 0], ["vis", 0], ["tt", 0], ["tl", 0], ["ln", 0], ["tspill", 0],
  ["fs", 0], ["fw", 400], ["lh", -1], ["ia", 0], ["cur", 0], ["pen", 0], ["dis", 0], ["foc", 0], ["sr", 0],
  ["hs", 0], ["ho", 0], ["ha", 0], ["hn", 0], ["cmp", -1], ["iok", -1], ["nh", -1], ["alt", -2], ["dist", 0], ["lazy", 0],
  ["nosize", 0], ["nca", 0], ["cvis", 1], ["eop", 1], ["op", 1], ["tf", 0], ["flt", 0], ["an", 0], ["tsh", 0], ["ell", 0],
  ["lcl", 0], ["bclip", 0], ["clip", 0], ["vu", 0], ["vi", 0], ["bgi", 0], ["ebs", 0], ["sbs", -1], ["cr", -1], ["scr", -1],
  ["vb", -1], ["wa", -1], ["rs", -1], ["verr", 0], ["ftrap", 0],
];
const V1_CAT = ["tag", "role", "disp", "pos", "ox", "oy", "fst", "ta", "why", "sc", "src", "bsrc", "of", "cpath"];
const V1_PAGE = ["pDesktop", "pDark", "pVw", "pVh", "pAppDark", "pVmeta", "pVmetaDW", "pSideways", "pFontsLoaded", "pRound"];
const V1_DERIVED = [
  "nowrap", "natW", "zSet", "z", "swRatio", "shRatio", "swOver", "shOver", "area", "aspect", "hasParent", "covered", "scaSet",
  "lkN", "vpN", "rwNum", "tfcSet",
  "c0", "c1", "c2", "c3", "bg0", "bg1", "bg2", "bg3", "eb0", "eb1", "eb2", "eb3", "sb0", "sb1", "sb2", "sb3",
];
export const V1_FEATURES = [...V1_NUM.map((x) => x[0]), ...V1_DERIVED, ...V1_CAT.map((c) => "cat_" + c), ...V1_PAGE];

/** The v1 page columns of a view (device "phone" is a phone view whatever the context). */
export function v1PageFeatures(page, device, scheme) {
  const p = page || {};
  const vm = p.viewportMeta || {};
  return [device === "desktop" ? 1 : 0, scheme === "dark" ? 1 : 0, p.vw || 0, p.vh || 0, p.appDark ? 1 : 0, vm.present ? 1 : 0, vm.deviceWidth ? 1 : 0, (p.scrollW || 0) > (p.clientW || 0) + 1 ? 1 : 0, p.fontsStatus === "loaded" ? 1 : 0, 0];
}

/** One element row as the 112 v1 columns (float32 values, as the v1 matrices stored them). */
export function v1Encode(row, vocab, pageF) {
  const out = new Array(V1_FEATURES.length);
  let k = 0;
  const put = (v) => (out[k++] = Math.fround(v));
  for (const [key, def] of V1_NUM) {
    const v = row[key];
    put(typeof v === "number" && Number.isFinite(v) ? v : def);
  }
  const img = row.tag === "img";
  put(!img && row.nw ? 1 : 0);
  put(img && typeof row.nw === "number" ? row.nw : -1);
  put(typeof row.z === "number" ? 1 : 0);
  put(typeof row.z === "number" ? Math.max(-1e6, Math.min(1e6, row.z)) : 0);
  const cw = row.cw || row.w || 0;
  const ch = row.ch || row.h || 0;
  put(row.sw && cw ? row.sw / cw : 1);
  put(row.sh && ch ? row.sh / ch : 1);
  put(row.sw && row.cw ? row.sw - row.cw : 0);
  put(row.sh && row.ch ? row.sh - row.ch : 0);
  put((row.w || 0) * (row.h || 0));
  put(row.h ? (row.w || 0) / row.h : 0);
  put(typeof row.p === "number" && row.p >= 0 ? 1 : 0);
  put(typeof row.hb === "number" ? 1 : 0);
  put(typeof row.sca === "number" ? (row.sca >= 0 ? 1 : row.sca) : 0);
  put(Array.isArray(row.lk) ? row.lk.length : 0);
  put(Array.isArray(row.vp) ? row.vp.length : 0);
  put(typeof row.rw === "number" ? row.rw : Number(row.rw) || -1);
  put(row.tfc ? 1 : 0);
  for (const [key, def] of [["c", 0], ["bg", 0], ["eb", 0], ["sb", -1]]) {
    const a = Array.isArray(row[key]) ? row[key] : null;
    for (let j = 0; j < 4; j++) put(a && typeof a[j] === "number" ? a[j] : a && j === 3 ? 1 : def);
  }
  for (const c of V1_CAT) {
    const v = row[c];
    put(v === undefined || v === null ? 0 : (vocab[c] && vocab[c][String(v)]) || 1);
  }
  for (const v of pageF) put(v);
  return out;
}

/** The v1 model's inputs from the 112 columns: by name, plus the box relative to the viewport (common.py). */
export function v1Inputs(x112, inputs) {
  const ix = (n) => V1_FEATURES.indexOf(n);
  const vw = Math.max(x112[ix("pVw")], 1);
  const vh = Math.max(x112[ix("pVh")], 1);
  const x = x112[ix("x")];
  const y = x112[ix("y")];
  const w = x112[ix("w")];
  const h = x112[ix("h")];
  const der = { xr: x / vw, rr: (x + w) / vw, yr: y / vh, br: (y + h) / vh, wr: w / vw, ar: (w * h) / (vw * vh) };
  return inputs.map((n) => (n in der ? Math.fround(der[n]) : x112[ix(n)]));
}

/** Load the v1 model and vocabulary; returns score(row, page, device, scheme) -> probability, or null. */
export function loadV1(modelPath, schemaPath) {
  try {
    const model = prepare(JSON.parse(readFileSync(modelPath, "utf8")));
    const vocab = JSON.parse(readFileSync(schemaPath, "utf8")).categorical;
    for (const n of model.inputs) if (!V1_FEATURES.includes(n) && !["xr", "rr", "yr", "br", "wr", "ar"].includes(n)) throw new Error(`unknown v1 input ${n}`);
    return (row, pageF) => gbtScore(model, v1Inputs(v1Encode(row, vocab, pageF), model.inputs));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- the v1 rules on raw rows (common.py `rules`)

export const RULES = ["image-broken", "media-failed", "text-invisible", "text-template-leak", "text-placeholder", "css-var-undefined",
  "image-distorted", "page-overflow-x", "font-failed", "pointer-events-leak", "scroll-lock-stuck", "click-blocked",
  "control-unreachable", "dialog-covered"];

/** The family a v1 rule speaks for (catalog families of research/visual/injectors.json). */
export const RULE_FAMILY = {
  "image-broken": "media", "media-failed": "media", "text-invisible": "text", "text-template-leak": "leaks",
  "text-placeholder": "media", "css-var-undefined": "styles", "image-distorted": "media", "page-overflow-x": "overflow",
  "font-failed": "text", "pointer-events-leak": "controls", "scroll-lock-stuck": "overflow", "click-blocked": "occlusion",
  "control-unreachable": "occlusion", "dialog-covered": "occlusion",
};

const num = (v, def) => (typeof v === "number" && Number.isFinite(v) ? v : def);

/** v1 rules for every row of one view: Map(row index in `rows` -> [rule names]). */
export function v1Rules(rows, page) {
  const p = page || {};
  const vw = Math.max(p.vw || 0, 1);
  const vh = Math.max(p.vh || 0, 1);
  const sideways = (p.scrollW || 0) > (p.clientW || 0) + 1;
  const ovxOk = !["h", "c"].includes(p.htmlOverflowX) && !["h", "c"].includes(p.bodyOverflowX);
  const out = new Map();
  const hit = (k, r) => {
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  };
  const overflow = [];
  rows.forEach((row, k) => {
    const tag = row.tag;
    const vis = num(row.vis, 0);
    const inv = num(row.inv, 0);
    const w = num(row.w, 0);
    const h = num(row.h, 0);
    const img = tag === "img";
    if (img && row.cmp === 1 && row.iok === 0 && vis === 1 && w >= 16 && h >= 16) hit(k, "image-broken");
    if (tag === "video" && [2, 3, 4].includes(row.verr) && w >= 48 && h >= 48) hit(k, "media-failed");
    const cr = num(row.cr, -1);
    const sbs = num(row.sbs, -1);
    const scr = num(row.scr, -1);
    const stackOk = sbs === -1 || (sbs === 0 && scr >= 0 && scr < 1.5);
    if (num(row.tl, 0) >= 1 && vis === 1 && inv > 0 && num(row.fs, 0) >= 6 && cr >= 0 && cr < 1.5 && num(row.ebs, 0) === 0 && !row.bclip && !row.tfc && !row.tsh && !row.an && !row.dis && tag !== "text" && tag !== "tspan" && stackOk) hit(k, "text-invisible");
    if (Array.isArray(row.lk) && row.lk.length && vis === 1) hit(k, "text-template-leak");
    if (img && row.src === "ph" && vis === 1) hit(k, "text-placeholder");
    if ((num(row.vu, 0) > 0 || num(row.vi, 0) > 0) && vis === 1 && cr >= 0 && cr < 3 && num(row.ebs, 0) === 0) hit(k, "css-var-undefined");
    if (img && row.iok === 1) {
      const nw = num(row.nw, -1);
      const nh = num(row.nh, -1);
      const a = nw / Math.max(nh, 1);
      const mis = Math.min(Math.abs(w - h * a), Math.abs(h - w / Math.max(a, 1e-6)));
      if (nw > 5 && nh > 5 && !row.of && num(row.dist, 0) > 0.05 && mis > 2 && w >= 48 && h >= 48) hit(k, "image-distorted");
    }
    const x = num(row.x, 0);
    if (sideways && ovxOk && (x + w > vw + 1 || x < -1) && num(row.nca, 0) === 0 && row.pos !== "f" && w > 0) overflow.push([num(row.d, 0), k]);
    if (row.fst === "e" && num(row.tl, 0) > 0 && vis === 1 && inv > 0) hit(k, "font-failed");
    const root = tag === "body" || tag === "html";
    if (root && row.pen) hit(k, "pointer-events-leak");
    const shOver = row.sh && row.ch ? row.sh - row.ch : 0;
    if (root && (row.oy === "h" || row.oy === "c") && shOver > 100) hit(k, "scroll-lock-stuck");
    const bg3 = Array.isArray(row.bg) ? num(row.bg[3], 1) : 0;
    const transp = num(row.op, 1) < 0.05 || (bg3 < 0.05 && !row.bgi);
    if (!row.ia && !row.cur && !num(row.tt, 0) && transp && w * h >= 0.3 * vw * vh && !row.pen && num(row.hs, 0) >= 3 && (row.pos === "f" || row.pos === "a") && !root) hit(k, "click-blocked");
    if (row.ia === 1 && vis === 1 && inv >= 0.5 && row.ho === 5) hit(k, "control-unreachable");
    if ((row.role === "dialog" || row.role === "alertdialog") && vis === 1 && num(row.ho, 0) >= 3) hit(k, "dialog-covered");
  });
  // page-overflow-x: the 3 shallowest culprits per view (ties in document order)
  overflow.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, k] of overflow.slice(0, 3)) hit(k, "page-overflow-x");
  return out;
}

// ---------------------------------------------------------------- choosing and describing candidates

/** A family guess for an element no rule flagged (null when nothing points anywhere). */
export function guessFamily(row, page, rules) {
  if (rules && rules.length) return RULE_FAMILY[rules[0]] || null;
  const vw = Math.max((page && page.vw) || 0, 1);
  const tag = row.tag;
  if (["img", "video", "svg", "canvas", "iframe", "picture"].includes(tag)) return "media";
  if (num(row.ho, 0) >= 3) return "occlusion";
  if (num(row.x, 0) + num(row.w, 0) > vw + 1 || num(row.tspill, 0) > 2) return "overflow";
  if (num(row.tl, 0) > 0 && num(row.cr, 99) < 3) return "text";
  if (row.ia) return "controls";
  if (num(row.tl, 0) > 0) return "text";
  return null;
}

/** Elements a crop can show: a box at least 4 x 4 px, visible, at least partly in the viewport, not html or body. */
export function eligible(row) {
  return typeof row.x === "number" && row.vis === 1 && num(row.inv, 0) > 0 && num(row.w, 0) >= 4 && num(row.h, 0) >= 4 && row.tag !== "html" && row.tag !== "body";
}

/**
 * Up to `max` candidates of one natural view: the top `gbtTop` by v1 score and up to `rulesTop` rule flags first,
 * `random` random eligible elements, then the remaining rule flags and the remaining elements scoring at least
 * `gbtMin`, alternating, while slots last. Returns [{k (index into rows), sources, score, rules}] in document order.
 * `score(row)` may be null (no model): then the gbt source is empty.
 */
export function chooseCandidates(rows, page, { score = null, rand = Math.random, max = 6, random = 2, gbtTop = 2, rulesTop = 2, gbtMin = 0.208 } = {}) {
  const rules = v1Rules(rows, page);
  const el = [];
  rows.forEach((r, k) => {
    if (eligible(r)) el.push(k);
  });
  const sc = new Map();
  if (score) for (const k of el) sc.set(k, score(rows[k]));
  const R = el.filter((k) => rules.has(k));
  const G = score ? el.slice().sort((a, b) => sc.get(b) - sc.get(a) || a - b) : [];
  const chosen = new Map();
  const add = (k, src) => {
    if (k === undefined) return false;
    if (chosen.has(k)) {
      chosen.get(k).add(src);
      return false;
    }
    if (chosen.size >= max) return false;
    chosen.set(k, new Set([src]));
    return true;
  };
  for (let i = 0; i < Math.min(rulesTop, R.length); i++) add(R[i], "rules");
  for (let i = 0; i < Math.min(gbtTop, G.length); i++) add(G[i], "gbt");
  // random visible elements: uniform over the eligible ones not chosen yet
  const pool = el.filter((k) => !chosen.has(k));
  for (let i = 0; i < random && pool.length && chosen.size < max; i++) {
    const j = Math.floor(rand() * pool.length);
    add(pool.splice(j, 1)[0], "random");
  }
  let ri = Math.min(rulesTop, R.length);
  let gi = Math.min(gbtTop, G.length);
  while (chosen.size < max && (ri < R.length || (gi < G.length && sc.get(G[gi]) >= gbtMin))) {
    if (ri < R.length) add(R[ri++], "rules");
    if (chosen.size < max && gi < G.length && sc.get(G[gi]) >= gbtMin) add(G[gi++], "gbt");
  }
  // an element another source chose that the rules also flag, or that is in the top of the model, says so
  const topG = new Set(G.slice(0, gi));
  for (const [k, s] of chosen) {
    if (rules.has(k)) s.add("rules");
    if (topG.has(k)) s.add("gbt");
  }
  return [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([k, s]) => ({ k, sources: [...s].sort(), score: sc.has(k) ? Math.round(sc.get(k) * 1e4) / 1e4 : null, rules: rules.get(k) || [] }));
}

/** Crop rectangle of a row's box with `pad` px of context, clamped to the viewport; null when under 4 x 4. */
export function cropRect(row, vw, vh, pad = 24) {
  const x0 = Math.max(0, Math.floor(num(row.x, 0) - pad));
  const y0 = Math.max(0, Math.floor(num(row.y, 0) - pad));
  const x1 = Math.min(vw, Math.ceil(num(row.x, 0) + num(row.w, 0) + pad));
  const y1 = Math.min(vh, Math.ceil(num(row.y, 0) + num(row.h, 0) + pad));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  return [x0, y0, x1, y1];
}

/** A pseudonymous crop id: no host in it, stable for (view id, row index). */
export function cropId(vid, i) {
  return "c" + createHash("sha1").update(`crop|${vid}|${i}`).digest("hex").slice(0, 12);
}
