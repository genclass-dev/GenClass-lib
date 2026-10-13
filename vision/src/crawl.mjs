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
import { loadRecipes, runnable, chooseRecipes, envOf, injectionScript, PAGE_RUNTIME } from "./inject.mjs";
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

async function screenshot(page, dev) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const vp = page.viewportSize();
    // clip is in CSS px and the output is clip size times scale (the DPR does not multiply it; checked on c20:
    // 1366x768 at 0.5 gives 683x384, 390x844 at 0.25 gave 98x211)
    const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 55, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: dev.shotScale }, captureBeyondViewport: false });
    return Buffer.from(r.data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
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
  // interleave groups so a partial run still has every group
  const byG = {};
  for (const r of list) (byG[r.group] = byG[r.group] || []).push(r);
  const order = [];
  const gs = Object.values(byG);
  for (let i = 0; gs.some((g) => i < g.length); i++) for (const g of gs) if (i < g.length) order.push(g[i]);
  list = opts.limit ? order.slice(0, opts.limit) : order;
  const recipes = runnable(await loadRecipes(opts.recipes));
  const views = gzWriter(join(opts.out, `views-${T}.jsonl.gz`));
  const elements = gzWriter(join(opts.out, `elements-${T}.jsonl.gz`));
  const doneOut = createWriteStream(join(opts.out, `done-${T}.jsonl`), { flags: "a" });
  const t0 = Date.now();
  const stats = { hosts: 0, ok: 0, skipped: 0, failed: 0, views: 0, rows: 0, injected: 0 };
  const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  log(`shard ${si}/${sn}: ${list.length} hosts to do (${done.size} done before), ${opts.workers} workers, ${recipes.length} runnable recipes`);

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

  async function oneLoad(w, item, device, rand, out, holder) {
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
        const vid = `${vidBase}-${scheme}${inj ? "-inj" : ""}`;
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
            await writeFile(join(dir, `${device}-${scheme}${inj ? "-inj" : ""}.jpg`), shot);
          } catch {
            shot = null;
          }
        }
        out.views.push({ vid, host: item.host, group: item.group, builder: item.builder, domain: item.domain, device, scheme, inj: !!inj, page: r.page, cost: r.cost, nav: { ...nav }, injected: injected || null, shot: shot ? shot.length : 0 });
        out.rows.push([vid, r.rows]);
      };
      await extract("light", false);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(`${SETTLE}(1500)`).catch(() => {});
      await extract("dark", false);
      if (rand() < opts.inject) {
        const chosen = chooseRecipes(recipes, device, rand);
        if (chosen.length) {
          const env = envOf(chosen);
          const scheme = env.colorScheme === "dark" ? "dark" : "light";
          await page.emulateMedia({ colorScheme: scheme, reducedMotion: env.reducedMotion || "no-preference" });
          if (env.viewport) await page.setViewportSize({ width: env.viewport[0], height: env.viewport[1] });
          await page.evaluate(PAGE_RUNTIME);
          if (env.classicScrollbars) await page.evaluate(`(() => { const s = document.createElement("style"); s.textContent = "::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#999}"; document.head.appendChild(s); })()`);
          const results = await page.evaluate(injectionScript(chosen, (opts.seed * 1000003 + vidBase.charCodeAt(0)) >>> 0)).catch((e) => chosen.map((c) => ({ id: c.id, applied: false, reason: "error: " + String(e.message).slice(0, 100) })));
          await page.evaluate(`${SETTLE}(1500)`).catch(() => {});
          if (results.some((x) => x.applied)) {
            stats.injected++;
            // partial: some recipe changed the page and then failed; its labels were removed, so the view's
            // labels may miss a real change. Training should drop views with partial set.
            await extract(scheme, true, { env, recipes: results, partial: results.some((x) => x.partial) });
          } else out.notApplied.push(results);
        }
      }
      return nav;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async function worker(w) {
    for (;;) {
      const item = list.shift();
      if (!item) return;
      const t = Date.now();
      stats.hosts++;
      const rec = { host: item.host, group: item.group, status: "", ms: 0, views: 0, error: "" };
      const rb = await robots(item.host);
      if (!rb.ok) {
        rec.status = rb.reason;
        stats.skipped++;
      } else {
        const rand = rng(createHash("sha1").update(`${opts.seed}|${item.host}`).digest().readUInt32LE(0));
        const out = { views: [], rows: [], notApplied: [] };
        try {
          for (const device of ["desktop", "phone"]) {
            const holder = {};
            let timer;
            const hard = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("load hard timeout")), opts.timeout + 40000)));
            try {
              await Promise.race([oneLoad(w, item, device, rand, out, holder), hard]);
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
        stats.views += out.views.length;
        stats.rows += out.rows.reduce((n, x) => n + x[1].length, 0);
        if (out.notApplied.length) rec.notApplied = out.notApplied.flat().map((x) => `${x.id}:${x.reason}`).slice(0, 6);
      }
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
