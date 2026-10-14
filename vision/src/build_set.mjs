// Builds the training set for the visual checks from the crawl output (crawl.mjs). Runs on the cluster node that
// holds the merged crawl shards, never on the Mac.
//
//   node --max-old-space-size=24000 src/build_set.mjs --in ~/vision-out/crawl --out ~/vision-out/trainset
//        [--recipes ../research/visual/injectors.json] [--clean-per-view 40] [--seed 7]
//
// Input: IN/shard-*/{views,elements}-*.jsonl.gz and done-*.jsonl.
// Output in OUT:
//   views.jsonl.gz      one line per view: index `v`, ids, split, near-duplicate cluster, page features, the recipes
//                       applied (with family, catalog id, label attribute), page-level fault labels, natural signals
//   X-<split>.f32       float32 feature matrix, row-major, `F` columns (schema.json lists them), one row per element
//   meta-<split>.jsonl.gz  one line per matrix row: {v, i, y, ...}. y is one of
//                         nat      an element of a natural (clean) view: label unknown, mostly negative
//                         clean    an unlabelled element of an injected view (sampled, --clean-per-view per view)
//                         fault    an element a fault recipe marked: r recipe ids, f families, c catalog ids,
//                                  a label attributes (target, culprit), pv pixel verdict, pa/pn pixel area/changed
//                         control  an element only a control recipe marked (a correct lookalike: a hard negative)
//   schema.json         feature names, categorical vocabularies, label and verdict definitions, counts
//   summary.json        crawl success, extractor cost, injected faults per family and recipe, pixel verdicts,
//                       natural-bug prevalence by measured signals
//
// Splits are by host (a page never sits in two splits), after near-duplicate removal: hosts whose clean desktop
// light view has the same layout fingerprint (tag and 16 px quantized box of the first 150 visible rows) form a
// cluster; only the cluster's representative host goes into the matrices, the rest are listed in views.jsonl.gz
// with `dup` set. Views whose injection was partial (a recipe changed the page and then threw, or left a trace the
// scrubber could not remove) are dropped.
//
// v2 (provenance): no column may encode how a view was made. Dropped from v1: pRound (the injection round) and
// pFontsLoaded (font loading finishes with time, and injected views are always later than natural ones). Rows of
// elements a recipe created and did not label (`made`, the inside of an injected overlay or card row) are not clean
// rows: they exist only because of the injection. The extractor no longer gives labelled elements extra rows, hit
// tests or a place under the row cap (extract.js), and the injection leaves no inline style, data-* or class marker
// (inject.mjs). train/provenance.py checks what is left. Injected views that applied a recipe in inject.mjs SPREAD
// (a page-wide effect such as the root font size or a sideways page) keep their labelled rows and give no clean rows.

import { createReadStream, createWriteStream, readdirSync, readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./discover.mjs";
import { DROPPED, SPREAD } from "./inject.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

async function* gzLines(path) {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield l;
}

function gzWriter(path) {
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(path);
  gz.pipe(out);
  return {
    write: (s) => (gz.write(s) ? null : new Promise((r) => gz.once("drain", r))),
    close: () => new Promise((r) => (out.on("close", r), gz.end())),
  };
}

function binWriter(path) {
  const out = createWriteStream(path);
  return {
    write: (buf) => (out.write(buf) ? null : new Promise((r) => out.once("drain", r))),
    close: () => new Promise((r) => out.end(r)),
  };
}

const pct = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---------------------------------------------------------------- features

// numeric keys and the value the extractor leaves out (vision/README.md, element rows)
const NUM = [
  ["d", 0], ["x", 0], ["y", 0], ["w", 0], ["h", 0], ["inv", 0], ["vis", 0], ["tt", 0], ["tl", 0], ["ln", 0], ["tspill", 0],
  ["fs", 0], ["fw", 400], ["lh", -1], ["ia", 0], ["cur", 0], ["pen", 0], ["dis", 0], ["foc", 0], ["sr", 0],
  ["hs", 0], ["ho", 0], ["ha", 0], ["hn", 0], ["cmp", -1], ["iok", -1], ["nh", -1], ["alt", -2], ["dist", 0], ["lazy", 0],
  ["nosize", 0], ["nca", 0], ["cvis", 1], ["eop", 1], ["op", 1], ["tf", 0], ["flt", 0], ["an", 0], ["tsh", 0], ["ell", 0],
  ["lcl", 0], ["bclip", 0], ["clip", 0], ["vu", 0], ["vi", 0], ["bgi", 0], ["ebs", 0], ["sbs", -1], ["cr", -1], ["scr", -1],
  ["vb", -1], ["wa", -1], ["rs", -1], ["verr", 0], ["ftrap", 0],
];
const CAT = ["tag", "role", "disp", "pos", "ox", "oy", "fst", "ta", "why", "sc", "src", "bsrc", "of", "cpath"];
const PAGE_F = ["pDesktop", "pDark", "pVw", "pVh", "pAppDark", "pVmeta", "pVmetaDW", "pSideways"];
/** v1 columns removed because they record how a view was made (README, "Provenance"). */
const REMOVED_V1 = ["pRound", "pFontsLoaded"];
const DERIVED = [
  "nowrap", "natW", "zSet", "z", "swRatio", "shRatio", "swOver", "shOver", "area", "aspect", "hasParent", "covered", "scaSet",
  "lkN", "vpN", "rwNum", "tfcSet",
  "c0", "c1", "c2", "c3", "bg0", "bg1", "bg2", "bg3", "eb0", "eb1", "eb2", "eb3", "sb0", "sb1", "sb2", "sb3",
];
const FEATURES = [...NUM.map((x) => x[0]), ...DERIVED, ...CAT.map((c) => "cat_" + c), ...PAGE_F];
const F = FEATURES.length;

function makeVocab() {
  return Object.fromEntries(CAT.map((c) => [c, new Map()]));
}
function countCats(vc, row) {
  for (const c of CAT) {
    const v = row[c];
    if (v === undefined || v === null) continue;
    const m = vc[c];
    m.set(String(v), (m.get(String(v)) || 0) + 1);
  }
}
/** frequency-ordered codes: 0 absent, 1 other, 2.. the top `top` values */
function freezeVocab(vc, top = 120) {
  const out = {};
  for (const c of CAT) {
    const sorted = [...vc[c].entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
    out[c] = Object.fromEntries(sorted.map(([k], i) => [k, i + 2]));
  }
  return out;
}

function encode(row, vocab, pageF, buf, off) {
  let k = off;
  for (const [key, def] of NUM) {
    const v = row[key];
    buf[k++] = typeof v === "number" && Number.isFinite(v) ? v : def;
  }
  const img = row.tag === "img";
  buf[k++] = !img && row.nw ? 1 : 0;
  buf[k++] = img && typeof row.nw === "number" ? row.nw : -1;
  buf[k++] = typeof row.z === "number" ? 1 : 0;
  buf[k++] = typeof row.z === "number" ? Math.max(-1e6, Math.min(1e6, row.z)) : 0;
  const cw = row.cw || row.w || 0;
  const ch = row.ch || row.h || 0;
  buf[k++] = row.sw && cw ? row.sw / cw : 1;
  buf[k++] = row.sh && ch ? row.sh / ch : 1;
  buf[k++] = row.sw && row.cw ? row.sw - row.cw : 0;
  buf[k++] = row.sh && row.ch ? row.sh - row.ch : 0;
  buf[k++] = (row.w || 0) * (row.h || 0);
  buf[k++] = row.h ? (row.w || 0) / row.h : 0;
  buf[k++] = typeof row.p === "number" && row.p >= 0 ? 1 : 0;
  buf[k++] = typeof row.hb === "number" ? 1 : 0;
  buf[k++] = typeof row.sca === "number" ? (row.sca >= 0 ? 1 : row.sca) : 0;
  buf[k++] = Array.isArray(row.lk) ? row.lk.length : 0;
  buf[k++] = Array.isArray(row.vp) ? row.vp.length : 0;
  buf[k++] = typeof row.rw === "number" ? row.rw : Number(row.rw) || -1;
  buf[k++] = row.tfc ? 1 : 0;
  for (const [key, def] of [["c", 0], ["bg", 0], ["eb", 0], ["sb", -1]]) {
    const a = Array.isArray(row[key]) ? row[key] : null;
    for (let j = 0; j < 4; j++) buf[k++] = a && typeof a[j] === "number" ? a[j] : a && j === 3 ? 1 : def;
  }
  for (const c of CAT) {
    const v = row[c];
    buf[k++] = v === undefined || v === null ? 0 : vocab[c][String(v)] || 1;
  }
  for (const v of pageF) buf[k++] = v;
  return k;
}

function pageFeatures(view) {
  const p = view.page || {};
  const vm = p.viewportMeta || {};
  return [
    view.device === "desktop" ? 1 : 0,
    view.scheme === "dark" ? 1 : 0,
    p.vw || 0,
    p.vh || 0,
    p.appDark ? 1 : 0,
    vm.present ? 1 : 0,
    vm.deviceWidth ? 1 : 0,
    (p.scrollW || 0) > (p.clientW || 0) + 1 ? 1 : 0,
  ];
}

// ---------------------------------------------------------------- natural signals (clean views only)

const NAT_BITS = { brokenImg: 1, leak: 2, invisibleText: 4, placeholderImg: 8, varUndefined: 16, invisibleTextStrict: 32 };

function newNat() {
  return { brokenImg: 0, leak: 0, invisibleText: 0, invisibleTextStrict: 0, placeholderImg: 0, varUndefined: 0, leakIds: {} };
}

/**
 * Low-contrast text the measurements agree on: at least 2 characters, opaque enough to be meant as visible (colour
 * alpha above 0, ancestor opacity at least 0.2, no background-clip text or text-fill colour), under 1.5:1 on a solid
 * ancestor-chain background, and when the paint stack was read (text in the viewport) it also found a solid
 * background and under 1.5:1. The loose signal (bit 4) counts hero text over an image the ancestor chain cannot
 * see and one-character separators; this one does not.
 */
function invisibleStrict(row) {
  if ((row.tl || 0) < 2 || row.vis !== 1 || typeof row.cr !== "number" || row.cr >= 1.5 || (row.ebs || 0) !== 0) return false;
  if (row.bclip || row.tfc || (row.eop ?? 1) < 0.2) return false;
  if (Array.isArray(row.c) && (row.c[3] ?? 1) === 0) return false;
  if (row.sbs !== undefined && (row.sbs !== 0 || typeof row.scr !== "number" || row.scr >= 1.5)) return false;
  return true;
}
function natRow(n, row) {
  let bits = 0;
  if (row.tag === "img" && row.cmp === 1 && row.iok === 0 && row.vis === 1) (n.brokenImg++, (bits |= 1));
  if (Array.isArray(row.lk) && row.lk.length && row.vis === 1) {
    n.leak++;
    bits |= 2;
    for (const [id] of row.lk) n.leakIds[id] = (n.leakIds[id] || 0) + 1;
  }
  if ((row.tl || 0) > 0 && row.vis === 1 && typeof row.cr === "number" && row.cr < 1.5 && (row.ebs || 0) === 0) (n.invisibleText++, (bits |= 4));
  if (invisibleStrict(row)) (n.invisibleTextStrict++, (bits |= 32));
  if (row.tag === "img" && row.src === "ph" && row.vis === 1) (n.placeholderImg++, (bits |= 8));
  if ((row.vu || 0) > 0) (n.varUndefined++, (bits |= 16));
  return bits;
}

// ---------------------------------------------------------------- main

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const IN = a.in || join(homedir(), "vision-out", "crawl");
  const OUT = a.out || join(homedir(), "vision-out", "trainset");
  const cleanPerView = a["clean-per-view"] ?? 40;
  const seed = a.seed ?? 7;
  const recipesPath = a.recipes || join(HERE, "..", "..", "research", "visual", "injectors.json");
  await mkdir(OUT, { recursive: true });
  const t0 = Date.now();
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

  const recipes = new Map(JSON.parse(readFileSync(recipesPath, "utf8")).injectors.map((r) => [r.id, r]));
  const shards = readdirSync(IN).filter((d) => /^shard-\d+$/.test(d)).map((d) => join(IN, d));
  const files = (re) => shards.flatMap((d) => readdirSync(d).filter((f) => re.test(f)).map((f) => join(d, f)));

  // ---- hosts
  const hosts = new Map();
  for (const f of files(/^done-.*\.jsonl$/))
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        if (!hosts.has(r.host)) hosts.set(r.host, r);
      } catch {
        // torn line
      }
    }
  log(`${hosts.size} hosts in done files`);

  // ---- views
  const views = [];
  const byVid = new Map();
  for (const f of files(/^views-.*\.jsonl\.gz$/))
    for await (const l of gzLines(f)) {
      const v = JSON.parse(l);
      if (byVid.has(v.vid)) continue;
      v.v = views.length;
      byVid.set(v.vid, v);
      views.push(v);
    }
  log(`${views.length} views`);

  // ---- pass 1: vocabularies, fingerprints, natural signals, row counts
  const vocab = makeVocab();
  const fpRows = new Map(); // vid -> [] for clean light views used for fingerprints
  const rowsIn = new Map();
  const elementFiles = files(/^elements-.*\.jsonl\.gz$/);
  let nRows = 0;
  for (const f of elementFiles) {
    for await (const l of gzLines(f)) {
      const row = JSON.parse(l);
      const v = byVid.get(row.vid);
      if (!v) continue;
      nRows++;
      rowsIn.set(row.vid, (rowsIn.get(row.vid) || 0) + 1);
      if (nRows % 50 === 0) countCats(vocab, row);
      if (!v.round) {
        if (!v.nat) v.nat = newNat();
        natRow(v.nat, row);
        if (v.scheme === "light" && row.vis === 1) {
          let fr = fpRows.get(row.vid);
          if (!fr) fpRows.set(row.vid, (fr = []));
          if (fr.length < 150) {
            const q = (x) => Math.round((x || 0) / 16);
            fr.push(`${row.tag}|${q(row.x)}|${q(row.y)}|${q(row.w)}|${q(row.h)}`);
          }
        }
      }
    }
    log(`pass 1: ${f.split("/").slice(-2).join("/")} done, ${nRows} rows so far`);
  }
  const codes = freezeVocab(vocab);

  // ---- near-duplicate clusters (by host)
  const fpOf = new Map();
  for (const v of views) {
    if (v.round || v.scheme !== "light") continue;
    const fr = fpRows.get(v.vid);
    if (!fr) continue;
    const key = (v.device === "desktop" ? "d:" : "p:") + sha1(fr.join(";"));
    const cur = fpOf.get(v.host);
    if (!cur || (cur.startsWith("p:") && key.startsWith("d:"))) fpOf.set(v.host, key);
  }
  const clusters = new Map();
  for (const [h, k] of fpOf) {
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(h);
  }
  const repOf = new Map();
  for (const hs of clusters.values()) {
    const rep = hs.slice().sort((x, y) => (sha1(x) < sha1(y) ? -1 : 1))[0];
    for (const h of hs) repOf.set(h, rep);
  }
  const splitOf = (host) => {
    const b = parseInt(sha1(`${seed}|${repOf.get(host) || host}`).slice(0, 2), 16);
    return b < 205 ? "train" : b < 230 ? "val" : "test";
  };
  const dupHosts = [...repOf.entries()].filter(([h, r]) => h !== r).length;
  log(`${clusters.size} layout clusters over ${fpOf.size} hosts; ${dupHosts} near-duplicate hosts dropped from the matrices`);

  // ---- pass 2: matrices
  const splits = ["train", "val", "test"];
  const X = Object.fromEntries(splits.map((s) => [s, binWriter(join(OUT, `X-${s}.f32`))]));
  const M = Object.fromEntries(splits.map((s) => [s, gzWriter(join(OUT, `meta-${s}.jsonl.gz`))]));
  const counts = Object.fromEntries(splits.map((s) => [s, { nat: 0, clean: 0, fault: 0, control: 0, views: new Set(), hosts: new Set() }]));
  const famRows = {};
  const pixBy = {}; // family -> verdict -> n
  const BATCH = 4096;
  const bufs = Object.fromEntries(splits.map((s) => [s, { f: new Float32Array(BATCH * F), n: 0, meta: [] }]));
  const flush = async (s) => {
    const b = bufs[s];
    if (!b.n) return;
    const w1 = X[s].write(Buffer.from(b.f.slice(0, b.n * F).buffer));
    if (w1) await w1;
    const w2 = M[s].write(b.meta.join(""));
    if (w2) await w2;
    b.n = 0;
    b.meta = [];
  };
  const appliedOf = (v) => {
    if (v._ap) return v._ap;
    const ap = new Map();
    for (const r of (v.injected && v.injected.recipes) || []) if (r.applied && !r.partial) ap.set(r.id, recipes.get(r.id) || { kind: r.kind });
    return (v._ap = ap);
  };
  const pixOf = (v, row) => {
    const p = v.injected && v.injected.pix;
    if (!p) return null;
    let best = null;
    let bd = Infinity;
    for (const e of p.els) {
      if (e.lab !== row.lab) continue;
      const d = Math.abs(e.x - (row.x || 0)) + Math.abs(e.y - (row.y || 0)) + Math.abs(e.w - (row.w || 0)) + Math.abs(e.h - (row.h || 0));
      if (d < bd) (bd = d), (best = e);
    }
    if (!best) return null;
    let inBoxes = 0;
    let inArea = 0;
    for (const e of p.els) (inBoxes += e.n), (inArea += e.a);
    const churn = (p.total - inBoxes) / Math.max(1, p.W * p.H - inArea);
    const verdict = !best.a ? "out" : best.n >= Math.max(16, 0.01 * best.a) ? "seen" : "unseen";
    return { pv: verdict, pa: best.a, pn: best.n, noisy: churn > 0.05 ? 1 : 0 };
  };
  // injected views that applied a SPREAD recipe give no clean rows
  const spreadOf = (v) => {
    if (v._sp === undefined) v._sp = [...appliedOf(v).keys()].some((id) => SPREAD[id]);
    return v._sp;
  };
  let spreadSkipped = 0;
  const SKIP_TAGS = new Set(["style", "script", "link", "meta", "head", "title", "noscript", "template"]);
  let written = 0;
  let madeSkipped = 0;
  for (const f of elementFiles) {
    for await (const l of gzLines(f)) {
      const row = JSON.parse(l);
      const v = byVid.get(row.vid);
      if (!v) continue;
      if (repOf.has(v.host) && repOf.get(v.host) !== v.host) continue;
      if (v.injected && v.injected.partial) continue;
      if (SKIP_TAGS.has(row.tag)) continue;
      if (typeof row.w !== "number") continue; // no box (v1 kept labelled display:none targets as box-less rows)
      if (v.round && row.made && !row.lab) {
        madeSkipped++;
        continue; // created by a recipe and not labelled: exists only because of the injection
      }
      const s = splitOf(v.host);
      let meta;
      if (!v.round) {
        meta = { v: v.v, i: row.i, y: "nat" };
        const bits = natRow(newNat(), row);
        if (bits) meta.n = bits;
      } else if (row.lab) {
        const ap = appliedOf(v);
        const ids = row.lab.split(" ").filter((id) => ap.has(id));
        if (!ids.length) continue;
        const faults = ids.filter((id) => (ap.get(id).kind || "fault") === "fault");
        if (faults.length) {
          meta = { v: v.v, i: row.i, y: "fault", r: faults, f: faults.map((id) => ap.get(id).family), c: faults.map((id) => ap.get(id).catalog_id), a: faults.map((id) => (ap.get(id).label || {}).attribute) };
          const px = pixOf(v, row);
          if (px) Object.assign(meta, px);
          for (const fam of new Set(meta.f)) {
            famRows[fam] = (famRows[fam] || 0) + 1;
            const pb = (pixBy[fam] = pixBy[fam] || { seen: 0, unseen: 0, out: 0, none: 0, noisy: 0 });
            pb[px ? px.pv : "none"]++;
            if (px && px.noisy) pb.noisy++;
          }
        } else meta = { v: v.v, i: row.i, y: "control", r: ids };
      } else {
        if (spreadOf(v)) {
          spreadSkipped++;
          continue; // a page-wide fault changed this unlabelled element (inject.mjs SPREAD): not a negative
        }
        const rin = rowsIn.get(row.vid) || 1;
        const keep = cleanPerView >= rin || parseInt(sha1(`${seed}|${row.vid}|${row.i}`).slice(0, 8), 16) / 4294967296 < cleanPerView / rin;
        if (!keep) continue;
        meta = { v: v.v, i: row.i, y: "clean" };
      }
      const b = bufs[s];
      if (!v._pf) v._pf = pageFeatures(v);
      encode(row, codes, v._pf, b.f, b.n * F);
      b.n++;
      b.meta.push(JSON.stringify(meta) + "\n");
      const c = counts[s];
      c[meta.y]++;
      c.views.add(v.v);
      c.hosts.add(v.host);
      written++;
      if (b.n === BATCH) await flush(s);
    }
    log(`pass 2: ${f.split("/").slice(-2).join("/")} done, ${written} rows written`);
  }
  for (const s of splits) {
    await flush(s);
    await X[s].close();
    await M[s].close();
  }

  // ---- views table
  const VW = gzWriter(join(OUT, "views.jsonl.gz"));
  for (const v of views) {
    const ap = v.round ? appliedOf(v) : new Map();
    const rec = {
      v: v.v, vid: v.vid, host: v.host, group: v.group, builder: v.builder, domain: v.domain, device: v.device, scheme: v.scheme,
      round: v.round || 0, split: splitOf(v.host), rep: repOf.get(v.host) || v.host, dup: repOf.has(v.host) && repOf.get(v.host) !== v.host ? 1 : 0,
      partial: v.injected && v.injected.partial ? 1 : 0, pre: v.injected ? v.injected.pre || null : null, env: v.injected ? v.injected.env : null,
      applied: [...ap.entries()].map(([id, r]) => ({ id, kind: r.kind, family: r.family, catalog_id: r.catalog_id, attribute: (r.label || {}).attribute })),
      pageLabels: [...ap.entries()].filter(([, r]) => (r.label || {}).attribute === "page").map(([id]) => id),
      pageF: pageFeatures(v), page: v.page, cost: v.cost, nav: v.nav, nat: v.nat ? { ...v.nat } : null, rows: rowsIn.get(v.vid) || 0,
    };
    const w = VW.write(JSON.stringify(rec) + "\n");
    if (w) await w;
  }
  await VW.close();

  // ---- schema
  const countsOut = Object.fromEntries(splits.map((s) => [s, { ...counts[s], views: counts[s].views.size, hosts: counts[s].hosts.size }]));
  await writeFile(
    join(OUT, "schema.json"),
    JSON.stringify(
      {
        version: "vision-trainset-2",
        built: new Date().toISOString(),
        F,
        features: FEATURES,
        numericDefaults: Object.fromEntries(NUM),
        categorical: codes,
        labels: { nat: "element of a clean view; label unknown", clean: "unlabelled element of an injected view (sampled)", fault: "marked by a fault recipe", control: "marked only by a control recipe" },
        natBits: NAT_BITS,
        pixel: "pv: seen (changed pixels >= max(16, 1% of the box) between the screenshot before injection and after), unseen (in the viewport, no visible change: a NOI candidate), out (box outside the viewport or empty); noisy: more than 5% of the viewport outside the labelled boxes changed (page animation)",
        splits: "by host after near-duplicate removal: sha1(seed|representative host) first byte < 205 train, < 230 val, else test",
        cleanPerView,
        removedV1: REMOVED_V1,
        madeRowsSkipped: madeSkipped,
        spreadCleanRowsSkipped: spreadSkipped,
        spreadRecipes: Object.keys(SPREAD),
        counts: countsOut,
      },
      null,
      1,
    ),
  );

  // ---- summary
  const hs = [...hosts.values()];
  const byGroup = {};
  for (const h of hs) {
    const g = (byGroup[h.group] = byGroup[h.group] || { attempted: 0, ok: 0, partial: 0, skipped: {}, failed: 0 });
    g.attempted++;
    if (h.status === "ok") g.ok++;
    else if (h.status === "partial") g.partial++;
    else if (/^robots/.test(h.status)) g.skipped[h.status] = (g.skipped[h.status] || 0) + 1;
    else g.failed++;
  }
  const byDomain = {};
  for (const v of views) {
    if (v.round || v.device !== "desktop" || v.scheme !== "light") continue;
    byDomain[v.domain || v.group] = (byDomain[v.domain || v.group] || 0) + 1;
  }
  const clean = views.filter((v) => !v.round);
  const inj = views.filter((v) => v.round);
  const costs = views.map((v) => (v.cost && v.cost.total) || 0);
  const perLoad = new Map();
  for (const v of clean) {
    const k = `${v.host}|${v.device}`;
    perLoad.set(k, (perLoad.get(k) || 0) + ((v.cost && v.cost.total) || 0));
  }
  const fam = {};
  const rec = {};
  for (const v of inj) {
    if (v.injected && v.injected.partial) continue;
    for (const r of v.injected.recipes || []) {
      const meta = recipes.get(r.id) || {};
      const x = (rec[r.id] = rec[r.id] || { family: meta.family, kind: meta.kind, applied: 0, na: 0, error: 0, marked: 0 });
      if (r.applied) {
        x.applied++;
        x.marked += r.marked || 0;
        if (meta.kind === "fault") {
          const fx = (fam[meta.family] = fam[meta.family] || { faults: 0, recipes: new Set(), markedElements: 0 });
          fx.faults++;
          fx.recipes.add(r.id);
          fx.markedElements += r.marked || 0;
        }
      } else if (/^error/.test(r.reason || "")) x.error++;
      else x.na++;
    }
  }
  // also count rounds that applied nothing (not in views): from done files we only keep counts
  for (const k of Object.keys(fam)) fam[k] = { ...fam[k], recipes: fam[k].recipes.size, matrixRows: famRows[k] || 0, pixel: pixBy[k] || null };
  const natSummary = {};
  for (const v of clean) {
    const key = `${v.group}|${v.device}|${v.scheme}`;
    const n = (natSummary[key] = natSummary[key] || { views: 0, brokenImg: 0, leak: 0, invisibleText: 0, invisibleTextStrict: 0, placeholderImg: 0, varUndefined: 0, sideways: 0, noViewportMeta: 0, fontError: 0, cssFailed: 0, consoleErrors: 0, leakIds: {} });
    n.views++;
    const nat = v.nat || newNat();
    for (const k of ["brokenImg", "leak", "invisibleText", "invisibleTextStrict", "placeholderImg", "varUndefined"]) if (nat[k] > 0) n[k]++;
    for (const id of Object.keys(nat.leakIds || {})) n.leakIds[id] = (n.leakIds[id] || 0) + 1;
    const p = v.page || {};
    if ((p.scrollW || 0) > (p.clientW || 0) + 1) n.sideways++;
    if (v.device === "phone" && p.viewportMeta && !p.viewportMeta.present) n.noViewportMeta++;
    if ((p.fonts || []).some((x) => x[2] > 0)) n.fontError++;
    if (p.res && p.res.cssFailed > 0) n.cssFailed++;
    if (v.nav && v.nav.consoleErrors > 0) n.consoleErrors++;
  }
  for (const n of Object.values(natSummary))
    for (const k of ["brokenImg", "leak", "invisibleText", "invisibleTextStrict", "placeholderImg", "varUndefined", "sideways", "noViewportMeta", "fontError", "cssFailed", "consoleErrors"]) n[k + "Share"] = r3(n[k] / Math.max(1, n.views));
  const natByBuilder = {};
  const phoneLight = new Map(clean.filter((x) => x.device === "phone" && x.scheme === "light").map((x) => [x.host, x]));
  for (const v of clean) {
    if (v.device !== "desktop" || v.scheme !== "light") continue;
    const k = v.group === "control" ? "control (Tranco)" : v.domain || v.builder;
    const n = (natByBuilder[k] = natByBuilder[k] || { pages: 0, brokenImg: 0, leak: 0, invisibleText: 0, invisibleTextStrict: 0, sidewaysPhone: 0 });
    n.pages++;
    const nat = v.nat || newNat();
    if (nat.brokenImg) n.brokenImg++;
    if (nat.leak) n.leak++;
    if (nat.invisibleText) n.invisibleText++;
    if (nat.invisibleTextStrict) n.invisibleTextStrict++;
    const ph = phoneLight.get(v.host);
    if (ph && ph.page && (ph.page.scrollW || 0) > (ph.page.clientW || 0) + 1) n.sidewaysPhone++;
  }
  const pre = inj.map((v) => (v.injected && v.injected.pre && typeof v.injected.pre.same === "number" ? v.injected.pre.same : 1));
  const summary = {
    built: new Date().toISOString(),
    crawl: {
      hosts: hs.length,
      byGroup,
      hostsWithViewsByDomain: byDomain,
      views: { total: views.length, clean: clean.length, injected: inj.length, byDeviceScheme: Object.fromEntries(Object.entries(clean.reduce((m, v) => ((m[`${v.device}-${v.scheme}`] = (m[`${v.device}-${v.scheme}`] || 0) + 1), m), {}))) },
      elementRows: nRows,
      hostMs: { p50: pct(hs.filter((h) => h.status === "ok").map((h) => h.ms), 0.5), p90: pct(hs.filter((h) => h.status === "ok").map((h) => h.ms), 0.9) },
    },
    extractorCostMs: {
      perView: { p50: pct(costs, 0.5), p90: pct(costs, 0.9), p99: pct(costs, 0.99), max: Math.max(...costs) },
      perCleanLoad: { p50: pct([...perLoad.values()], 0.5), p90: pct([...perLoad.values()], 0.9) },
      rowsPerView: { p50: pct([...rowsIn.values()], 0.5), p90: pct([...rowsIn.values()], 0.9) },
      truncatedViews: views.filter((v) => v.page && v.page.truncated).length,
    },
    injection: {
      injectedViews: inj.length,
      partialViews: inj.filter((v) => v.injected && v.injected.partial).length,
      tracedViews: inj.filter((v) => v.injected && v.injected.traced).length,
      tracedRecipes: inj.flatMap((v) => ((v.injected && v.injected.recipes) || []).filter((r) => r.trace).map((r) => r.id)).reduce((m, id) => ((m[id] = (m[id] || 0) + 1), m), {}),
      mechanismAttributes: inj.flatMap((v) => ((v.injected && v.injected.recipes) || []).filter((r) => r.applied && r.attrs).flatMap((r) => r.attrs.map((a) => `${r.id}:${a}`))).reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {}),
      roundRequests: inj.reduce((s, v) => s + ((v.injected && v.injected.requests && v.injected.requests.n) || 0), 0),
      roundRequestsOffHost: inj.reduce((s, v) => s + ((v.injected && v.injected.requests && v.injected.requests.offHost) || 0), 0),
      madeRowsSkipped: madeSkipped,
      spreadCleanRowsSkipped: spreadSkipped,
      spreadViews: inj.filter((v) => !(v.injected && v.injected.partial) && spreadOf(v)).length,
      recipesSpread: SPREAD,
      faultsApplied: Object.values(fam).reduce((s, x) => s + x.faults, 0),
      controlsApplied: Object.values(rec).filter((x) => x.kind === "control").reduce((s, x) => s + x.applied, 0),
      byFamily: fam,
      byRecipe: rec,
      recipesNeverApplied: [...recipes.values()].filter((r) => r.phase === "after-load" && !DROPPED[r.id] && !(rec[r.id] && rec[r.id].applied)).map((r) => r.id),
      recipesDropped: DROPPED,
      layoutSameAfterUndo: { p10: pct(pre, 0.1), p50: pct(pre, 0.5) },
    },
    naturalSignals: { byGroupDeviceScheme: natSummary, desktopLightByDomain: natByBuilder },
    dedupe: { clusters: clusters.size, hostsFingerprinted: fpOf.size, nearDuplicateHosts: dupHosts, largestClusters: [...clusters.values()].sort((x, y) => y.length - x.length).slice(0, 10).map((x) => x.length) },
    trainset: countsOut,
    F,
  };
  await writeFile(join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
  log(`done: ${written} matrix rows (${F} features); ${JSON.stringify(countsOut)}`);
}

export { encode, FEATURES, F, NUM, CAT, PAGE_F, REMOVED_V1, pageFeatures, natRow, newNat, freezeVocab, makeVocab, countCats };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
