// The visual crawl (v2): Playwright Chromium (headless shell), many contexts in parallel, one homepage per host, one
// page load per host. Runs on a cluster node, never on the Mac. Per host:
//   1. robots.txt for our user agent token ("genclass-vision") and "*"; a disallowed path, a 5xx or a timeout skips
//      the host.
//   2. One load of the homepage in a desktop context (1366x768, DPR 1). After the redirects, robots.txt of the final
//      host is checked for the final path too; a disallow there discards the load before anything is extracted.
//   3. Natural views, each extracted by extract.js with a downscaled JPEG of the viewport: desktop light; desktop dark
//      (prefers-color-scheme emulated in place) on a seeded share of hosts; then the same page resized to the phone
//      viewport (page.setViewportSize, 390x844) for phone light and, on the same hosts, phone dark. Nothing is
//      reloaded. On each natural view, up to 6 candidates for labelling are cropped (candidates.mjs).
//   4. On a seeded share of hosts, injection rounds in place (inject.mjs): phone rounds at the phone size, then the
//      desktop size again for desktop rounds; each round's labelled view is extracted and the round undone.
// Nothing else is requested from the host by the crawler: no links followed, no reloads, no second load. The
// injection recipes that would make the page request anything are dropped (inject.mjs DROPPED); requests the page
// makes on its own during the rounds are counted per round (injected.requests) for the audit.
// Safety: downloads refused, service workers blocked, popups closed, form submission cancelled in the page, no
// typing, no clicks, no logins. A fresh context per host, closed after it; cookies and storage are never saved.
// Rows hold lengths and pattern ids, never page text (extract.js invariants).
//
//   node src/crawl.mjs --urls ~/vision-out/discover/urls.jsonl [--out ~/vision-out/crawl] [--shard 0/4]
//                      [--workers 48] [--per-browser 8] [--limit 0] [--inject 0.35] [--seed 11]
//                      [--timeout 15000] [--max-rows 2500] [--groups ai-builder,mixed-host,control]
//                      [--crops true] [--crops-per-view 6]
//
// Output under OUT/shard-I (I = the shard index), one set per process start (T = start time):
//   views-T.jsonl.gz     one line per extracted view: {vid, host, group, builder, device, scheme, inj, round, page,
//                        cost, nav, injected}
//   elements-T.jsonl.gz  one line per element row: {vid, ...row} (schema in vision/README.md)
//   shots/<host>/<device>-<scheme>[-rN].jpg   downscaled viewport screenshots (stay on the node)
//   crops/<id>.jpg, crops/<id>.json   labelling candidates of natural views: a crop with 24 px of context and its
//                        sidecar (no host in the id, the file name or the sidecar; vid + i join it to its row)
//   done-T.jsonl         one line per host: {host, status, ms, views, error}; a rerun skips hosts already done

import { chromium } from "playwright";
import { createGzip } from "node:zlib";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, cpus } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs, rng } from "./discover.mjs";
import { loadRecipes, trainable, chooseRound, envOf, injectionScript, PAGE_RUNTIME } from "./inject.mjs";
import { robotsAllows } from "./robots.mjs";
import { loadV1, v1PageFeatures, chooseCandidates, cropRect, cropId, guessFamily } from "./candidates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACT_SRC = readFileSync(join(HERE, "extract.js"), "utf8");
export const UA_TOKEN = "genclass-vision";
export const UA_PRODUCT = "genclass-vision/0.2 (+https://genclass.dev/security)";
export const BROWSER_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${UA_PRODUCT}`;

/** The two views of the one desktop context: the viewport size and the screenshot scale. */
export const DEVICES = {
  desktop: { viewport: { width: 1366, height: 768 }, shotScale: 0.5 },
  phone: { viewport: { width: 390, height: 844 }, shotScale: 0.75 },
};

/** robots.txt of a host: { status, text, reason }. 4xx means no rules (text ""); 5xx, timeouts and errors set reason. */
async function fetchRobots(host) {
  try {
    const res = await fetch(`https://${host}/robots.txt`, { headers: { "user-agent": UA_PRODUCT }, redirect: "follow", signal: AbortSignal.timeout(6000) });
    if (res.status >= 500) return { status: res.status, text: null, reason: "robots-5xx" };
    if (res.status >= 400) return { status: res.status, text: "" };
    const type = res.headers.get("content-type") || "";
    const text = /text\/plain/.test(type) || !/html/.test(type) ? (await res.text()).slice(0, 500000) : "";
    return { status: res.status, text };
  } catch (e) {
    return { status: 0, text: null, reason: "robots-unreachable" };
  }
}

/** The verdict for one path: { ok, reason }. */
export function robotsVerdict(r, path) {
  if (!r || r.text === null || r.text === undefined) return { ok: false, reason: (r && r.reason) || "robots-unreachable" };
  return robotsAllows(r.text, UA_TOKEN, path || "/") ? { ok: true } : { ok: false, reason: "robots-disallow" };
}

/** In-page settle: fonts (3 s cap), then 500 ms without DOM mutations (cap `ms`), then two frames. */
const SETTLE = `(async (ms) => {
  const t0 = performance.now();
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]); } catch (e) {}
  await new Promise((resolve) => {
    let last = performance.now();
    const mo = new MutationObserver(() => { last = performance.now(); });
    try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) {}
    const tick = () => {
      const now = performance.now();
      if (now - last >= 500 || now - t0 >= ms) { mo.disconnect(); resolve(); } else setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return Math.round(performance.now() - t0);
})`;

/** Init script for every page: cancel form submission and window.open, nothing else. */
const GUARD = `(() => {
  document.addEventListener("submit", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  try { HTMLFormElement.prototype.submit = function () {}; HTMLFormElement.prototype.requestSubmit = function () {}; } catch (e) {}
  try { window.open = function () { return null; }; } catch (e) {}
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/** A gzip JSONL writer that flushes on close. */
function gzWriter(path) {
  const gz = createGzip({ level: 6 });
  const out = createWriteStream(path);
  gz.pipe(out);
  return {
    write: (obj) => gz.write(JSON.stringify(obj) + "\n"),
    close: () => new Promise((r) => {
      out.on("close", r);
      gz.end();
    }),
  };
}

/** A viewport screenshot: JPEG (or PNG) of the viewport at `scale` (CSS px times scale; DPR 1 here). */
async function screenshot(page, scale, { quality = 55, raw = false, format = "jpeg" } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const vp = page.viewportSize();
    const q = { format, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale }, captureBeyondViewport: false };
    if (format === "jpeg") q.quality = quality;
    const r = await cdp.send("Page.captureScreenshot", q);
    return raw ? r.data : Buffer.from(r.data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Pixel check of labels (VISUAL.md section 15): runs in a blank comparator page, never in the crawled page. Takes two
 * same-size JPEGs (base64, CSS px resolution) and boxes [x0, y0, x1, y1]; a pixel counts as changed when a channel
 * differs by more than `thr`. Returns {W, H, total, out: [[area in viewport, changed pixels], ...]}.
 */
const PIXDIFF = `async (q) => {
  const load = async (b64) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return createImageBitmap(new Blob([u], { type: "image/jpeg" }));
  };
  const [ia, ib] = await Promise.all([load(q.a), load(q.b)]);
  if (ia.width !== ib.width || ia.height !== ib.height) return null;
  const W = ia.width, H = ia.height;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(ia, 0, 0);
  const da = g.getImageData(0, 0, W, H).data;
  g.clearRect(0, 0, W, H);
  g.drawImage(ib, 0, 0);
  const db = g.getImageData(0, 0, W, H).data;
  const ch = new Uint8Array(W * H);
  let total = 0;
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
    if (d > q.thr) { ch[p] = 1; total++; }
  }
  const out = q.boxes.map((b) => {
    const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1]));
    const x1 = Math.min(W, Math.ceil(b[2])), y1 = Math.min(H, Math.ceil(b[3]));
    if (x1 <= x0 || y1 <= y0) return [0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++) { const r = y * W; for (let x = x0; x < x1; x++) n += ch[r + x]; }
    return [(x1 - x0) * (y1 - y0), n];
  });
  return { W, H, total, out };
}`;

/**
 * Crops for labelling, cut in the blank comparator page (never the crawled page): a PNG of the viewport (base64)
 * and rectangles [x0, y0, x1, y1] in CSS px; returns one base64 JPEG (quality 0.9) per rectangle.
 */
const CROPS = `async (q) => {
  const bin = atob(q.img);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const im = await createImageBitmap(new Blob([u], { type: "image/png" }));
  const k = im.width / q.vw;
  const out = [];
  for (const r of q.rects) {
    const sx = Math.round(r[0] * k), sy = Math.round(r[1] * k);
    const w = Math.max(1, Math.round((r[2] - r[0]) * k)), h = Math.max(1, Math.round((r[3] - r[1]) * k));
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d").drawImage(im, sx, sy, w, h, 0, 0, w, h);
    const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    const a = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768));
    out.push(btoa(s));
  }
  return out;
}`;

/**
 * Compare layout signatures from __visionSig: {count: element counts within 2%, same: share of the first boxes that
 * are equal}. Pages move on their own (reveal-on-scroll, carousels, resize handlers), so only the count gates more
 * rounds; `same` is stored on the next injected view (injected.pre) for the training side to filter on.
 */
function sigCompare(a, b) {
  if (!a || !b) return { count: false, same: null };
  const m = Math.min(a.boxes.length, b.boxes.length);
  let same = 0;
  for (let i = 0; i < m; i++) if (a.boxes[i] === b.boxes[i]) same++;
  return { count: Math.abs(a.n - b.n) <= Math.max(2, a.n * 0.02), same: m ? Math.round((same / m) * 100) / 100 : null };
}

/** "a=1,b=2" -> {a: 1, b: 2} */
function kv(s) {
  const o = {};
  for (const part of String(s || "").split(",").filter(Boolean)) {
    const [k, v] = part.split("=");
    o[k] = Number(v);
  }
  return o;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const [si, sn] = String(a.shard || "0/1").split("/").map(Number);
  const opts = {
    urls: a.urls || join(homedir(), "vision-out", "discover", "urls.jsonl"),
    out: join(a.out || join(homedir(), "vision-out", "crawl"), `shard-${si}`),
    workers: a.workers || Math.max(4, Math.floor(cpus().length * 0.6)),
    perBrowser: a["per-browser"] || 8,
    limit: a.limit || 0,
    inject: a.inject ?? 0.35,
    seed: a.seed ?? 11,
    timeout: a.timeout || 15000,
    maxRows: a["max-rows"] || 2500,
    groups: a.groups ? String(a.groups).split(",") : null,
    recipes: a.recipes || join(HERE, "..", "..", "research", "visual", "injectors.json"),
    shots: a.shots === "false" ? false : true,
    // per-group targets of hosts with views, across all shards (each shard takes its share); none = no cap
    targets: kv(a.targets || ""),
    // share of hosts that also get dark views (desktop and phone; light views always)
    darkShare: a["dark-share"] ?? 1 / 3,
    // injection rounds per device size (each round: 1 to 3 recipes, one labelled view, then the undo)
    rounds: { desktop: 8, phone: 6, ...kv(a.rounds || "") },
    pixel: a.pixel === "false" ? false : true,
    crops: a.crops === "false" ? false : true,
    cropsPerView: a["crops-per-view"] || 6,
    v1Model: a["v1-model"] || join(HERE, "..", "results", "train", "gbt-small.json"),
    v1Schema: a["v1-schema"] || join(HERE, "..", "results", "schema.json"),
  };
  await mkdir(join(opts.out, "shots"), { recursive: true });
  if (opts.crops) await mkdir(join(opts.out, "crops"), { recursive: true });
  const T = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  // resume: hosts finished by any earlier run of this shard
  const done = new Set();
  for (const f of readdirSync(opts.out).filter((x) => /^done-.*\.jsonl$/.test(x)))
    for (const line of readFileSync(join(opts.out, f), "utf8").split("\n")) {
      try {
        if (line) done.add(JSON.parse(line).host);
      } catch {
        // a torn last line
      }
    }
  let list = (await readFile(opts.urls, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  list = list.filter((r) => r.shard % sn === si && !done.has(r.host) && (!opts.groups || opts.groups.includes(r.group)));
  // within a group: hosts in seeded hash order, domains drawn with weight sqrt(hosts in the domain), so a capped
  // run is not almost all lovable.app; then the groups are interleaved so a partial run still has every group
  const hkey = (h) => sha1(`${opts.seed}|${h}`);
  const orderRand = rng(opts.seed * 7 + si);
  const byG = {};
  for (const r of list) (byG[r.group] = byG[r.group] || []).push(r);
  const gs = [];
  for (const g of Object.keys(byG)) {
    const byD = new Map();
    for (const r of byG[g]) {
      const d = r.domain || r.builder || "";
      if (!byD.has(d)) byD.set(d, []);
      byD.get(d).push(r);
    }
    const qs = [...byD.values()].map((q) => ({ q: q.sort((x, y) => (hkey(x.host) < hkey(y.host) ? -1 : 1)), w: Math.sqrt(q.length) }));
    const seq = [];
    for (;;) {
      const live = qs.filter((x) => x.q.length);
      if (!live.length) break;
      let x = orderRand() * live.reduce((s, y) => s + y.w, 0);
      let pick = live[live.length - 1];
      for (const y of live) if ((x -= y.w) <= 0) { pick = y; break; }
      seq.push(pick.q.shift());
    }
    gs.push(seq);
  }
  const order = [];
  for (let i = 0; gs.some((g) => i < g.length); i++) for (const g of gs) if (i < g.length) order.push(g[i]);
  list = opts.limit ? order.slice(0, opts.limit) : order;
  // per-shard quota of hosts with views, and hosts in flight, per group
  const quota = {};
  for (const [g, t] of Object.entries(opts.targets)) quota[g] = Math.ceil(t / sn);
  const okBy = {};
  const inflight = {};
  const room = (it) => quota[it.group] == null || (okBy[it.group] || 0) + (inflight[it.group] || 0) < quota[it.group];
  async function nextItem() {
    for (;;) {
      const i = list.findIndex(room);
      if (i >= 0) return list.splice(i, 1)[0];
      if (!list.length) return null;
      // a group is full only because hosts are in flight: wait, one of them may fail
      if (!list.some((it) => (inflight[it.group] || 0) > 0 && (okBy[it.group] || 0) < quota[it.group])) return null;
      await sleep(1000);
    }
  }
  const recipes = trainable(await loadRecipes(opts.recipes));
  const v1 = opts.crops ? loadV1(opts.v1Model, opts.v1Schema) : null;
  const views = gzWriter(join(opts.out, `views-${T}.jsonl.gz`));
  const elements = gzWriter(join(opts.out, `elements-${T}.jsonl.gz`));
  const doneOut = createWriteStream(join(opts.out, `done-${T}.jsonl`), { flags: "a" });
  const t0 = Date.now();
  const stats = { hosts: 0, ok: 0, skipped: 0, robotsFinal: 0, failed: 0, views: 0, rows: 0, crops: 0, injected: 0, rounds: 0, faults: 0, controls: 0, notApplied: 0, recipeErrors: 0, traced: 0, undoDrift: 0, roundErrors: 0, pixChecked: 0, roundRequests: 0, roundOffHost: 0, okBy, family: {} };
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`shard ${si}/${sn}: ${list.length} hosts in the list (${done.size} done before), quota ${JSON.stringify(quota)}, ${opts.workers} workers, ${recipes.length} trainable recipes, rounds ${JSON.stringify(opts.rounds)}, crops ${opts.crops ? (v1 ? "with the v1 model" : "rules and random only (no v1 model)") : "off"}`);

  // robots.txt per host, fetched once per process
  const robotsCache = new Map();
  const robotsFor = (host) => {
    if (!robotsCache.has(host)) robotsCache.set(host, fetchRobots(host));
    return robotsCache.get(host);
  };

  // browsers: one per `perBrowser` workers, relaunched when one dies
  const nb = Math.ceil(opts.workers / opts.perBrowser);
  const browsers = new Array(nb).fill(null);
  const launching = new Array(nb).fill(null);
  async function browserFor(w) {
    const k = w % nb;
    if (browsers[k] && browsers[k].isConnected()) return browsers[k];
    if (!launching[k]) {
      launching[k] = chromium
        .launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] })
        .then((b) => ((browsers[k] = b), b))
        .finally(() => (launching[k] = null));
    }
    return launching[k];
  }

  // one blank comparator page per browser for the pixel check and the crops (no network, never a crawled page)
  const comparators = new Array(nb).fill(null);
  async function comparatorFor(w) {
    const k = w % nb;
    const b = await browserFor(w);
    const c = comparators[k];
    if (c && c.browser === b) return c.page;
    const page = b.newContext().then((ctx) => ctx.newPage());
    comparators[k] = { browser: b, page };
    return page;
  }
  async function inComparator(w, fn, arg) {
    try {
      const page = await comparatorFor(w);
      return await page.evaluate(`(${fn})(${JSON.stringify(arg)})`);
    } catch (e) {
      comparators[w % nb] = null;
      return null;
    }
  }

  /** Labelling candidates of one natural view: choose, crop, write crops/<id>.jpg and crops/<id>.json. */
  async function saveCandidates(w, page, item, view, rows) {
    const vp = page.viewportSize();
    const pageF = v1PageFeatures(view.page, view.device, view.scheme);
    const score = v1 ? (row) => v1(row, pageF) : null;
    const crand = rng(createHash("sha1").update(`${opts.seed}|cand|${view.vid}`).digest().readUInt32LE(0));
    const picks = chooseCandidates(rows, view.page, { score, rand: crand, max: opts.cropsPerView }).map((p) => ({ ...p, rect: cropRect(rows[p.k], vp.width, vp.height, 24) })).filter((p) => p.rect);
    if (!picks.length) return 0;
    const img = await screenshot(page, 1, { raw: true, format: "png" }).catch(() => null);
    if (!img) return 0;
    const jpgs = await inComparator(w, CROPS, { img, vw: vp.width, rects: picks.map((p) => p.rect) });
    if (!jpgs) return 0;
    let n = 0;
    for (let j = 0; j < picks.length; j++) {
      const p = picks[j];
      const row = rows[p.k];
      const id = cropId(view.vid, row.i);
      const [x0, y0, x1, y1] = p.rect;
      const side = {
        id, file: `${id}.jpg`, vid: view.vid, i: row.i, device: view.device, scheme: view.scheme, group: item.group, domain: item.domain || null,
        sources: p.sources, family: guessFamily(row, view.page, p.rules), rules: p.rules, score: p.score, model: v1 ? "v1 gbt-small" : null,
        tag: row.tag, role: row.role || null, box: [row.x, row.y, row.w, row.h], crop: p.rect, inCrop: [Math.round((row.x - x0) * 10) / 10, Math.round((row.y - y0) * 10) / 10, row.w, row.h],
        cropSize: [x1 - x0, y1 - y0], viewport: [vp.width, vp.height], extractor: view.page && view.page.v, crawl: T,
      };
      try {
        await writeFile(join(opts.out, "crops", side.file), Buffer.from(jpgs[j], "base64"));
        await writeFile(join(opts.out, "crops", `${id}.json`), JSON.stringify(side));
        n++;
      } catch {
        // disk trouble: skip this crop
      }
    }
    return n;
  }

  async function oneHost(w, item, rand, out, holder, { dark, inject }) {
    const browser = await browserFor(w);
    const ctx = await browser.newContext({
      viewport: DEVICES.desktop.viewport,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      userAgent: BROWSER_UA,
      colorScheme: "light",
      reducedMotion: "no-preference",
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: "UTC",
      javaScriptEnabled: true,
    });
    holder.ctx = ctx;
    const nav = { status: 0, ok: false, finalHost: "", type: "", consoleErrors: 0, pageErrors: 0, failedRequests: 0, requests: 0, roundRequests: 0, roundOffHost: 0, settleMs: 0, loadMs: 0 };
    out.nav = nav;
    let phase = "load";
    let page = null;
    try {
      // popups and new tabs are closed at once
      ctx.on("page", (p) => {
        if (page && p !== page) p.close().catch(() => {});
      });
      await ctx.addInitScript(GUARD);
      page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") nav.consoleErrors++;
      });
      page.on("pageerror", () => nav.pageErrors++);
      page.on("request", (r) => {
        nav.requests++;
        if (phase !== "rounds") return;
        nav.roundRequests++;
        try {
          if (new URL(r.url()).hostname !== nav.finalHost) nav.roundOffHost++;
        } catch {
          // data: and other URLs without a host
        }
      });
      page.on("requestfailed", () => nav.failedRequests++);
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      page.on("download", (d) => d.cancel().catch(() => {}));
      const tl = Date.now();
      let resp = null;
      try {
        resp = await page.goto(item.url, { waitUntil: "load", timeout: opts.timeout });
      } catch (e) {
        // no load event inside the cap: measure what rendered, if the document committed
        if (!page.url() || page.url() === "about:blank") throw e;
        nav.loadTimeout = true;
      }
      nav.loadMs = Date.now() - tl;
      if (resp) {
        nav.status = resp.status();
        nav.type = (resp.headers()["content-type"] || "").split(";")[0].slice(0, 40);
      }
      let finalUrl = null;
      try {
        finalUrl = new URL(page.url());
        nav.finalHost = finalUrl.hostname;
      } catch {
        nav.finalHost = "";
      }
      nav.redirectedOff = nav.finalHost && nav.finalHost !== item.host ? 1 : 0;
      // robots.txt of the host the redirects ended on, for the final path, before anything is extracted
      if (!finalUrl) {
        nav.skip = "no-final-url";
        return nav;
      }
      const rv = robotsVerdict(await robotsFor(finalUrl.hostname), finalUrl.pathname || "/");
      if (!rv.ok) {
        nav.skip = "robots-final:" + rv.reason;
        return nav;
      }
      if ((resp && nav.status >= 400) || (nav.type && !/html/.test(nav.type))) {
        nav.skip = "not-html-or-error";
        return nav;
      }
      const settle = (ms) => page.evaluate(`${SETTLE}(${ms})`).catch(() => -1);
      // a client-side navigation (a redirect script, pushState) after the load: robots.txt again for the new URL
      let checked = finalUrl.href;
      const checkUrl = async () => {
        let u;
        try {
          u = new URL(page.url());
        } catch {
          return;
        }
        if (u.href === checked) return;
        const v = robotsVerdict(await robotsFor(u.hostname), u.pathname || "/");
        if (!v.ok) throw new Error(`robots-final:${v.reason} after a client-side navigation`);
        checked = u.href;
        nav.finalHost = u.hostname;
        nav.clientNav = (nav.clientNav || 0) + 1;
      };
      nav.settleMs = await settle(Math.min(Math.max(1000, opts.timeout - nav.loadMs), 5000));
      nav.ok = true;
      phase = "natural";
      const vidBase = { desktop: sha1(`${item.host}|desktop|${T}`).slice(0, 12), phone: sha1(`${item.host}|phone|${T}`).slice(0, 12) };
      const extract = async (device, scheme, round, injected) => {
        // round: 0 for a natural view, else the injection round (1, 2, ...) of this device size
        const vid = `${vidBase[device]}-${scheme}${round ? "-r" + round : ""}`;
        const expr = `${EXTRACT_SRC}\n;globalThis.__visionExtract(${JSON.stringify({ maxRows: opts.maxRows })})`;
        let r;
        await checkUrl();
        try {
          r = await page.evaluate(expr);
        } catch (e) {
          // a client-side redirect replaced the document: settle once more, check robots.txt for it, retry
          if (!/context was destroyed|navigat/i.test(String(e.message))) throw e;
          nav.clientRedirect = 1;
          await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
          await settle(2000);
          await checkUrl();
          r = await page.evaluate(expr);
        }
        let shot = null;
        if (opts.shots) {
          try {
            shot = await screenshot(page, DEVICES[device].shotScale);
            const dir = join(opts.out, "shots", item.host);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, `${device}-${scheme}${round ? "-r" + round : ""}.jpg`), shot);
          } catch {
            shot = null;
          }
        }
        const view = { vid, host: item.host, group: item.group, builder: item.builder, domain: item.domain, device, scheme, inj: !!round, round: round || 0, page: r.page, cost: r.cost, nav: { ...nav }, injected: injected || null, shot: shot ? shot.length : 0 };
        out.views.push(view);
        out.rows.push([vid, r.rows]);
        return { view, rows: r.rows };
      };

      // ---- natural views: desktop, then the same page at the phone size; dark in place on dark hosts
      const schemes = dark ? ["light", "dark"] : ["light"];
      for (const device of ["desktop", "phone"]) {
        if (device === "phone") {
          await page.setViewportSize(DEVICES.phone.viewport);
          await settle(1500);
        }
        await page.evaluate("scrollTo(0, 0)").catch(() => {});
        for (const scheme of schemes) {
          if (scheme === "dark") {
            await page.emulateMedia({ colorScheme: "dark" });
            await settle(1500);
          }
          const { view, rows } = await extract(device, scheme, 0);
          if (opts.crops) out.crops += await saveCandidates(w, page, item, view, rows).catch(() => 0);
        }
        if (dark) {
          await page.emulateMedia({ colorScheme: "light" });
          await settle(1000);
        }
      }

      // ---- injection rounds, in place: phone rounds at the phone size, then desktop rounds
      if (inject) {
        phase = "rounds";
        await page.evaluate(PAGE_RUNTIME);
        const devs = ["phone", "desktop"].filter((d) => (opts.rounds[d] || 0) > 0);
        const total = devs.reduce((s, d) => s + opts.rounds[d], 0);
        const used = new Set();
        let k = 0;
        let stop = false;
        for (const device of devs) {
          if (stop) break;
          if (device === "desktop") {
            await page.setViewportSize(DEVICES.desktop.viewport);
            await settle(1500);
          }
          await page.evaluate("scrollTo(0, 0)").catch(() => {});
          const base = await page.evaluate("__visionSig()").catch(() => null);
          let pre = { same: 1, undoOk: true };
          const seed0 = parseInt(vidBase[device].slice(0, 8), 16);
          for (let round = 1; round <= opts.rounds[device] && !stop; round++) {
            k++;
            const final = k === total; // only the load's very last round is left in place
            const chosen = chooseRound(recipes, device, rand, stats.family, { final, used, schemes });
            if (!chosen.length) break;
            for (const c of chosen) used.add(c.id);
            const scheme = envOf(chosen).colorScheme;
            try {
              // a client-side redirect or reload replaced the document: its runtime and baseline are gone
              if (!(await page.evaluate("typeof globalThis.__visionInject === 'function' && typeof globalThis.__visionLib === 'object'").catch(() => false))) {
                nav.docReplaced = `${device}-${round}`;
                stop = true;
                break;
              }
              if (scheme !== "light") {
                await page.emulateMedia({ colorScheme: scheme });
                await settle(1500);
              }
              const rq0 = { n: nav.roundRequests, off: nav.roundOffHost };
              const before = opts.pixel ? await screenshot(page, 1, { quality: 90, raw: true }).catch(() => null) : null;
              const results = await page
                .evaluate(injectionScript(chosen, (seed0 ^ Math.imul(round, 2654435761) ^ opts.seed) >>> 0))
                .catch((e) => chosen.map((c) => ({ id: c.id, kind: c.kind, applied: false, reason: "error: " + String(e.message).slice(0, 100) })));
              stats.rounds++;
              await settle(1500);
              for (const x of results) {
                if (x.trace) stats.traced++;
                if (x.applied) {
                  if (x.kind === "fault") {
                    stats.faults++;
                    const fam = (recipeById.get(x.id) || {}).family || "?";
                    stats.family[fam] = (stats.family[fam] || 0) + 1;
                  } else stats.controls++;
                } else if (/^error/.test(x.reason || "")) stats.recipeErrors++;
                else stats.notApplied++;
              }
              const applied = results.some((x) => x.applied);
              let view = null;
              let after = null;
              let shotAfter = null;
              if (applied) {
                stats.injected++;
                // partial: a recipe changed the page and then failed, or left a trace the scrubber could not remove;
                // its labels were removed, so the view may hold an unlabelled change. Training drops these views.
                const injected = { env: { colorScheme: scheme }, round, final, recipes: results, partial: results.some((x) => x.partial), traced: results.some((x) => x.trace), pre };
                ({ view } = await extract(device, scheme, round, injected));
                view.injected.requests = { n: nav.roundRequests - rq0.n, offHost: nav.roundOffHost - rq0.off };
                if (opts.pixel) {
                  after = await page.evaluate("__visionMarkedBoxes()").catch(() => null);
                  shotAfter = await screenshot(page, 1, { quality: 90, raw: true }).catch(() => null);
                }
              } else out.notApplied.push(results);
              let beforeBoxes = null;
              if (!final) {
                const u = await page.evaluate("__visionUndo()").catch((e) => ({ ok: false, err: String(e.message).slice(0, 80) }));
                await settle(1000);
                if (view) view.injected.undo = u;
                if (after) beforeBoxes = await page.evaluate("__visionMarkedBoxes()").catch(() => null);
              }
              if (view && after && before && shotAfter) {
                // per marked element: the union of its box before (after the undo) and after injection, in the viewport
                const vp = page.viewportSize();
                const boxes = after.map((b, j) => {
                  if (b.page) return [0, 0, vp.width, vp.height];
                  const bb = beforeBoxes && beforeBoxes[j];
                  const xs = [], ys = [], xe = [], ye = [];
                  for (const q of [b, bb]) if (q && q.w > 0 && q.h > 0) xs.push(q.x), ys.push(q.y), xe.push(q.x + q.w), ye.push(q.y + q.h);
                  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xe), Math.max(...ye)] : [0, 0, 0, 0];
                });
                const d = await inComparator(w, PIXDIFF, { a: before, b: shotAfter, boxes, thr: 32 });
                if (d) {
                  stats.pixChecked++;
                  // per marked element: lab, page flag, box after injection, union box, [area in viewport, changed px]
                  view.injected.pix = { W: d.W, H: d.H, total: d.total, els: after.map((b, j) => ({ lab: b.lab, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, u: boxes[j].map((v) => Math.round(v)), a: d.out[j][0], n: d.out[j][1] })) };
                }
              }
              if (final) break;
              if (scheme !== "light") {
                await page.emulateMedia({ colorScheme: "light" });
                await settle(1000);
              }
              await page.evaluate("scrollTo(0, 0)").catch(() => {});
              const now = await page.evaluate("__visionSig()").catch(() => null);
              const residue = await page.evaluate("__visionResidue()").catch(() => ({ sheet: -1, open: -1 }));
              const left = residue.sheet || residue.open ? 1 : 0;
              const cmp = sigCompare(base, now);
              const undoOk = !view || !view.injected.undo || view.injected.undo.ok;
              pre = { same: cmp.same, undoOk };
              if (!cmp.count || left !== 0 || !undoOk) {
                // the page did not come back to its natural state: stop injecting into this load
                stats.undoDrift++;
                nav.undoDrift = `${device}-${round}`;
                out.drift.push({ device, round, recipes: chosen.map((c) => c.id), n0: base && base.n, n1: now && now.n, same: cmp.same, left, undoOk });
                stop = true;
              }
            } catch (e) {
              stats.roundErrors++;
              nav.roundError = String(e.message || e).split("\n")[0].slice(0, 120);
              stop = true;
            }
          }
        }
      }
      return nav;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async function worker(w) {
    for (;;) {
      const item = await nextItem();
      if (!item) return;
      inflight[item.group] = (inflight[item.group] || 0) + 1;
      const t = Date.now();
      stats.hosts++;
      const rec = { host: item.host, group: item.group, status: "", ms: 0, views: 0, error: "" };
      let path = "/";
      try {
        path = new URL(item.url).pathname || "/";
      } catch {
        // keep "/"
      }
      const rv = robotsVerdict(await robotsFor(item.host), path);
      if (!rv.ok) {
        rec.status = rv.reason;
        stats.skipped++;
      } else {
        const rand = rng(createHash("sha1").update(`${opts.seed}|${item.host}`).digest().readUInt32LE(0));
        const dark = rand() < opts.darkShare;
        const inject = rand() < opts.inject;
        const out = { views: [], rows: [], notApplied: [], drift: [], crops: 0, nav: null };
        const holder = {};
        let timer;
        const capMs = opts.timeout + 40000 + ((opts.rounds.desktop || 0) + (opts.rounds.phone || 0)) * 7000;
        const hard = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("host hard timeout")), capMs)));
        try {
          await Promise.race([oneHost(w, item, rand, out, holder, { dark, inject }), hard]);
          const skip = out.nav && out.nav.skip;
          if (skip && /^robots-final/.test(skip)) stats.robotsFinal++;
          rec.status = out.views.length ? "ok" : skip ? skip : "no-views";
          if (out.views.length) stats.ok++;
          else if (!(skip && /^robots-final/.test(skip))) stats.failed++;
        } catch (e) {
          rec.status = out.views.length ? "partial" : "failed";
          rec.error = String(e.message || e).split("\n")[0].slice(0, 160);
          if (!out.views.length) stats.failed++;
        } finally {
          clearTimeout(timer);
          if (holder.ctx) await holder.ctx.close().catch(() => {});
        }
        for (const v of out.views) views.write(v);
        for (const [vid, rows] of out.rows) for (const r of rows) elements.write({ vid, ...r });
        rec.views = out.views.length;
        rec.dark = dark ? 1 : 0;
        rec.inject = inject ? 1 : 0;
        rec.rounds = out.views.filter((v) => v.round).length;
        rec.crops = out.crops;
        if (out.nav) {
          stats.roundRequests += out.nav.roundRequests || 0;
          stats.roundOffHost += out.nav.roundOffHost || 0;
        }
        if (out.views.length) okBy[item.group] = (okBy[item.group] || 0) + 1;
        stats.views += out.views.length;
        stats.crops += out.crops;
        stats.rows += out.rows.reduce((n, x) => n + x[1].length, 0);
        if (out.drift.length) rec.drift = out.drift;
        if (out.notApplied.length) rec.notApplied = out.notApplied.flat().map((x) => `${x.id}:${x.reason}`).slice(0, 6);
      }
      inflight[item.group]--;
      rec.ms = Date.now() - t;
      doneOut.write(JSON.stringify(rec) + "\n");
      if (stats.hosts % 50 === 0) log(`${stats.hosts} hosts: ${JSON.stringify(stats)}`);
    }
  }

  let stopping = false;
  const finish = async () => {
    if (stopping) return;
    stopping = true;
    await views.close();
    await elements.close();
    await new Promise((r) => doneOut.end(r));
    for (const b of browsers) if (b) await b.close().catch(() => {});
    stats.recipesTrainable = recipes.length;
    await writeFile(join(opts.out, `stats-${T}.json`), JSON.stringify({ ...stats, seconds: Math.round((Date.now() - t0) / 1000), opts }, null, 2));
    log(`finished: ${JSON.stringify(stats)}`);
  };
  // one odd page must not take the shard down: log and keep going
  process.on("uncaughtException", (e) => console.error(`uncaught: ${String((e && e.stack) || e).split("\n").slice(0, 3).join(" | ")}`));
  process.on("unhandledRejection", (e) => console.error(`unhandled: ${String((e && e.message) || e).slice(0, 200)}`));
  process.on("SIGTERM", () => {
    list.length = 0; // let running hosts finish, take no new ones
  });
  await Promise.all(Array.from({ length: opts.workers }, (_, w) => worker(w)));
  await finish();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
