// The visual crawl: Playwright Chromium (headless shell), many contexts in parallel, one homepage per host. Runs on
// a cluster node, never on the Mac. Per host:
//   1. robots.txt for our user agent ("genclass-vision") and "*"; a disallowed "/" or a 5xx or timeout skips it.
//   2. Two loads of the homepage, one per device profile (desktop 1366x768 at DPR 1; phone 390x844, isMobile,
//      touch, DPR 3), because the viewport meta, hover and pointer media only apply to a mobile context. Nothing
//      else is ever requested from the host: no links followed, no reloads; the colour scheme is switched in place.
//   3. In each load, after the settle gates (load event, fonts, 500 ms without DOM mutations, all inside the 15 s
//      cap): the light view, then the dark view (emulated prefers-color-scheme), each extracted by extract.js
//      with a downscaled JPEG of the viewport. Then, on a seeded fraction of loads, 1 to 3 after-load fault recipes
//      from research/visual/injectors.json (inject.mjs) and one more extracted view with the labels.
// Safety: downloads refused, service workers blocked, popups closed, form submission cancelled in the page, no
// typing, no clicks, no logins. Contexts are fresh per load and closed after it; cookies and storage are never
// saved. Rows hold lengths and pattern ids, never page text (extract.js invariants).
//
//   node src/crawl.mjs --urls ~/vision-out/discover/urls.jsonl [--out ~/vision-out/crawl] [--shard 0/4]
//                      [--workers 48] [--per-browser 8] [--limit 0] [--inject 0.35] [--seed 11]
//                      [--timeout 15000] [--max-rows 2500] [--groups ai-builder,mixed-host,control]
//
// Output under OUT/shard-I (I = the shard index), one set per process start (T = start time):
//   views-T.jsonl.gz     one line per extracted view: {vid, host, group, builder, device, scheme, inj, page,
//                        cost, nav, injected}
//   elements-T.jsonl.gz  one line per element row: {vid, ...row} (schema in vision/README.md)
//   shots/<host>/<device>-<scheme>[-inj].jpg   downscaled viewport screenshots
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
import { loadRecipes, runnable, chooseRound, envOf, injectionScript, PAGE_RUNTIME } from "./inject.mjs";
import { robotsAllows } from "./robots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRACT_SRC = readFileSync(join(HERE, "extract.js"), "utf8");
const UA_TOKEN = "genclass-vision";

export const DEVICES = {
  desktop: {
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    shotScale: 0.5,
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 genclass-vision/0.1",
  },
  phone: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    shotScale: 0.75,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 genclass-vision/0.1",
  },
};

/** robots.txt for a host: { ok, status, reason }. 4xx means no rules; 5xx, timeouts and network errors skip. */
async function robots(host) {
  try {
    const res = await fetch(`https://${host}/robots.txt`, { headers: { "user-agent": `${UA_TOKEN}/0.1` }, redirect: "follow", signal: AbortSignal.timeout(6000) });
    if (res.status >= 500) return { ok: false, status: res.status, reason: "robots-5xx" };
    if (res.status >= 400) return { ok: true, status: res.status };
    const type = res.headers.get("content-type") || "";
    const text = /text\/plain/.test(type) || !/html/.test(type) ? (await res.text()).slice(0, 500000) : "";
    return robotsAllows(text, UA_TOKEN, "/") ? { ok: true, status: res.status } : { ok: false, status: res.status, reason: "robots-disallow" };
  } catch (e) {
    return { ok: false, status: 0, reason: "robots-unreachable" };
  }
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

async function screenshot(page, dev, { scale = dev.shotScale, quality = 55, raw = false } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const vp = page.viewportSize();
    // clip is in CSS px and the output is clip size times scale (the DPR does not multiply it; checked on c20:
    // 1366x768 at 0.5 gives 683x384, 390x844 at 0.25 gave 98x211)
    const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale }, captureBeyondViewport: false });
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
    // share of hosts whose phone load also gets a dark view (desktop and phone always get light)
    darkShare: a["dark-share"] ?? 1 / 3,
    // injection rounds per load (each round: 1 to 3 recipes, one labelled view, then the undo journal)
    rounds: { desktop: 8, phone: 6, ...kv(a.rounds || "") },
    pixel: a.pixel === "false" ? false : true,
  };
  await mkdir(join(opts.out, "shots"), { recursive: true });
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
  const hkey = (h) => createHash("sha1").update(`${opts.seed}|${h}`).digest("hex");
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
  const recipes = runnable(await loadRecipes(opts.recipes));
  const views = gzWriter(join(opts.out, `views-${T}.jsonl.gz`));
  const elements = gzWriter(join(opts.out, `elements-${T}.jsonl.gz`));
  const doneOut = createWriteStream(join(opts.out, `done-${T}.jsonl`), { flags: "a" });
  const t0 = Date.now();
  const stats = { hosts: 0, ok: 0, skipped: 0, failed: 0, views: 0, rows: 0, injected: 0, rounds: 0, faults: 0, controls: 0, notApplied: 0, recipeErrors: 0, undoDrift: 0, roundErrors: 0, pixChecked: 0, okBy, family: {} };
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`shard ${si}/${sn}: ${list.length} hosts in the list (${done.size} done before), quota ${JSON.stringify(quota)}, ${opts.workers} workers, ${recipes.length} runnable recipes, rounds ${JSON.stringify(opts.rounds)}`);

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

  // one blank comparator page per browser for the pixel check (no network, never a crawled page)
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
  async function pixDiff(w, a, b, boxes) {
    try {
      const page = await comparatorFor(w);
      return await page.evaluate(`(${PIXDIFF})(${JSON.stringify({ a, b, boxes, thr: 32 })})`);
    } catch (e) {
      comparators[w % nb] = null;
      return null;
    }
  }

  async function oneLoad(w, item, device, rand, out, holder, dark) {
    const dev = DEVICES[device];
    const browser = await browserFor(w);
    const ctx = await browser.newContext({
      viewport: dev.viewport,
      deviceScaleFactor: dev.deviceScaleFactor,
      isMobile: dev.isMobile,
      hasTouch: dev.hasTouch,
      userAgent: dev.userAgent,
      colorScheme: "light",
      reducedMotion: "no-preference",
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: "UTC",
      javaScriptEnabled: true,
    });
    holder.ctx = ctx;
    const nav = { device, status: 0, ok: false, finalHost: "", type: "", consoleErrors: 0, pageErrors: 0, failedRequests: 0, requests: 0, settleMs: 0, loadMs: 0 };
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
      page.on("request", () => nav.requests++);
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
      try {
        nav.finalHost = new URL(page.url()).hostname;
      } catch {
        nav.finalHost = "";
      }
      nav.redirectedOff = nav.finalHost && nav.finalHost !== item.host ? 1 : 0;
      if ((resp && nav.status >= 400) || (nav.type && !/html/.test(nav.type))) {
        nav.skip = "not-html-or-error";
        return nav;
      }
      const left = Math.max(1000, opts.timeout - nav.loadMs);
      nav.settleMs = await page.evaluate(`${SETTLE}(${Math.min(left, 5000)})`).catch(() => -1);
      nav.ok = true;
      const vidBase = createHash("sha1").update(`${item.host}|${device}|${T}`).digest("hex").slice(0, 12);
      const extract = async (scheme, inj, injected) => {
        // inj: 0 for a clean view, else the injection round (1, 2, ...)
        const vid = `${vidBase}-${scheme}${inj ? "-r" + inj : ""}`;
        const expr = `${EXTRACT_SRC}\n;globalThis.__visionExtract(${JSON.stringify({ maxRows: opts.maxRows })})`;
        let r;
        try {
          r = await page.evaluate(expr);
        } catch (e) {
          // a client-side redirect replaced the document: settle once more and retry
          if (!/context was destroyed|navigat/i.test(String(e.message))) throw e;
          nav.clientRedirect = 1;
          await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {});
          await page.evaluate(`${SETTLE}(2000)`).catch(() => {});
          r = await page.evaluate(expr);
        }
        let shot = null;
        if (opts.shots) {
          try {
            shot = await screenshot(page, dev);
            const dir = join(opts.out, "shots", item.host);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, `${device}-${scheme}${inj ? "-r" + inj : ""}.jpg`), shot);
          } catch {
            shot = null;
          }
        }
        const view = { vid, host: item.host, group: item.group, builder: item.builder, domain: item.domain, device, scheme, inj: !!inj, round: inj || 0, page: r.page, cost: r.cost, nav: { ...nav }, injected: injected || null, shot: shot ? shot.length : 0 };
        out.views.push(view);
        out.rows.push([vid, r.rows]);
        return view;
      };
      await extract("light", 0);
      let curScheme = "light";
      if (dark) {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.evaluate(`${SETTLE}(1500)`).catch(() => {});
        await extract("dark", 0);
        curScheme = "dark";
      }
      const nRounds = rand() < opts.inject ? opts.rounds[device] || 0 : 0;
      if (nRounds) {
        const settle = (ms) => page.evaluate(`${SETTLE}(${ms})`).catch(() => {});
        await page.evaluate(PAGE_RUNTIME);
        if (curScheme !== "light") {
          await page.emulateMedia({ colorScheme: "light" });
          await settle(1500);
          curScheme = "light";
        }
        await page.evaluate("scrollTo(0, 0)").catch(() => {});
        const base = await page.evaluate("__visionSig()").catch(() => null);
        let pre = { same: 1, undoOk: true };
        const used = new Set();
        const seed0 = parseInt(vidBase.slice(0, 8), 16);
        for (let round = 1; round <= nRounds; round++) {
          const final = round === nRounds;
          const chosen = chooseRound(recipes, device, rand, stats.family, { final, used });
          if (!chosen.length) break;
          for (const c of chosen) used.add(c.id);
          const env = envOf(chosen);
          const scheme = env.colorScheme === "dark" ? "dark" : "light";
          const envChanged = scheme !== "light" || !!env.viewport || !!env.reducedMotion;
          try {
            // a client-side redirect or reload replaced the document since round 1: its runtime and baseline are gone
            if (!(await page.evaluate("typeof globalThis.__visionInject === 'function' && typeof globalThis.__visionLib === 'object'").catch(() => false))) {
              nav.docReplaced = round;
              break;
            }
            if (envChanged) {
              await page.emulateMedia({ colorScheme: scheme, reducedMotion: env.reducedMotion || "no-preference" });
              if (env.viewport) await page.setViewportSize({ width: env.viewport[0], height: env.viewport[1] });
              await settle(1500);
            }
            const before = opts.pixel ? await screenshot(page, dev, { scale: 1, quality: 90, raw: true }).catch(() => null) : null;
            const results = await page
              .evaluate(injectionScript(chosen, (seed0 ^ Math.imul(round, 2654435761) ^ opts.seed) >>> 0, { classicScrollbars: !!env.classicScrollbars }))
              .catch((e) => chosen.map((c) => ({ id: c.id, kind: c.kind, applied: false, reason: "error: " + String(e.message).slice(0, 100) })));
            stats.rounds++;
            await settle(1500);
            for (const x of results) {
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
              // partial: some recipe changed the page and then failed; its labels were removed, so the view's
              // labels may miss a real change. Training should drop views with partial set.
              view = await extract(scheme, round, { env, round, final, recipes: results, partial: results.some((x) => x.partial), pre });
              if (opts.pixel) {
                after = await page.evaluate("__visionMarkedBoxes()").catch(() => null);
                shotAfter = await screenshot(page, dev, { scale: 1, quality: 90, raw: true }).catch(() => null);
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
              const boxes = after.map((b, k) => {
                if (b.page) return [0, 0, vp.width, vp.height];
                const bb = beforeBoxes && beforeBoxes[k];
                const xs = [], ys = [], xe = [], ye = [];
                for (const q of [b, bb]) if (q && q.w > 0 && q.h > 0) xs.push(q.x), ys.push(q.y), xe.push(q.x + q.w), ye.push(q.y + q.h);
                return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xe), Math.max(...ye)] : [0, 0, 0, 0];
              });
              const d = await pixDiff(w, before, shotAfter, boxes);
              if (d) {
                stats.pixChecked++;
                // per marked element: lab, page flag, box after injection, union box, [area in viewport, changed px]
                view.injected.pix = { W: d.W, H: d.H, total: d.total, els: after.map((b, k) => ({ lab: b.lab, page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, u: boxes[k].map((v) => Math.round(v)), a: d.out[k][0], n: d.out[k][1] })) };
              }
            }
            if (final) break;
            if (envChanged) {
              if (env.viewport) await page.setViewportSize(dev.viewport);
              await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
              await settle(1000);
            }
            await page.evaluate("scrollTo(0, 0)").catch(() => {});
            const now = await page.evaluate("__visionSig()").catch(() => null);
            const left = await page.evaluate(`document.querySelectorAll("[data-bench-fault]").length`).catch(() => -1);
            const cmp = sigCompare(base, now);
            const undoOk = !view || !view.injected.undo || view.injected.undo.ok;
            pre = { same: cmp.same, undoOk };
            if (!cmp.count || left !== 0 || !undoOk) {
              // the page did not come back to its clean state: stop injecting into this load
              stats.undoDrift++;
              nav.undoDrift = round;
              out.drift.push({ device, round, recipes: chosen.map((c) => c.id), n0: base && base.n, n1: now && now.n, same: cmp.same, left, undoOk });
              break;
            }
          } catch (e) {
            stats.roundErrors++;
            nav.roundError = String(e.message || e).split("\n")[0].slice(0, 120);
            break;
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
      const rb = await robots(item.host);
      if (!rb.ok) {
        rec.status = rb.reason;
        stats.skipped++;
      } else {
        const rand = rng(createHash("sha1").update(`${opts.seed}|${item.host}`).digest().readUInt32LE(0));
        const dark = rand() < opts.darkShare;
        const out = { views: [], rows: [], notApplied: [], drift: [] };
        try {
          for (const device of ["desktop", "phone"]) {
            const holder = {};
            let timer;
            const capMs = opts.timeout + 30000 + (opts.rounds[device] || 0) * 7000;
            const hard = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("load hard timeout")), capMs)));
            try {
              await Promise.race([oneLoad(w, item, device, rand, out, holder, device === "phone" && dark), hard]);
            } finally {
              clearTimeout(timer);
              if (holder.ctx) await holder.ctx.close().catch(() => {});
            }
          }
          rec.status = out.views.length ? "ok" : "no-views";
          if (out.views.length) stats.ok++;
          else stats.failed++;
        } catch (e) {
          rec.status = out.views.length ? "partial" : "failed";
          rec.error = String(e.message || e).split("\n")[0].slice(0, 160);
          if (!out.views.length) stats.failed++;
        }
        for (const v of out.views) views.write(v);
        for (const [vid, rows] of out.rows) for (const r of rows) elements.write({ vid, ...r });
        rec.views = out.views.length;
        rec.dark = dark ? 1 : 0;
        rec.rounds = out.views.filter((v) => v.round).length;
        if (out.views.length) okBy[item.group] = (okBy[item.group] || 0) + 1;
        stats.views += out.views.length;
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
    stats.recipesRunnable = recipes.length;
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
