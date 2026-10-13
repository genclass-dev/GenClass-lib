#!/usr/bin/env node
// The visual bench runner (docs/runtime/VISUAL.md section 15, bench/visual/README.md). GitHub Actions only
// (.github/workflows/visual-measure.yml): it starts Chromium, which never runs on a developer machine here.
//
//   node bench/visual/run.mjs --group demos|templates|compat|sites [--shard 0/4] [--parts clean,cost,faults,integration]
//                            [--workers 2] [--seed 1] [--out <dir>]
//
// Loads, per page:
//   clean        desktop 1280 x 800 and phone 390 x 844, light and dark (public sites: dark only where the site has a
//                dark design), scripted hover and keyboard focus, a pass at the top and one at the end of the page
//   cost         desktop light at 4x CPU throttling: the automatic pass and one more (local pages)
//   faults       one load per fault group (faults.ts), desktop and phone, light (local pages with faults: true)
//   integration  the real integration (window.GENCLASS_CONFIG = { visual: true }, no harness): stub timing (compat)
// Local pages run the checks in guard mode with fixes on, so a fix applied on a clean page counts as a false fix.
// Public sites run in observe mode (report-only) and get no clicks, no forms and no crawling.
//
// Writes <out>/<group>[-<shard>]-<parts>.json with every load and finding (messages, selectors, page text excerpts)
// and <out>/crops/*.png. Both go to the CI artifact only; summarize.mjs reduces them to counts per check kind.

import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localRoute, start } from "./corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const GROUP = opt("group", null);
const SHARD = opt("shard", null);
const PARTS = new Set(opt("parts", "clean,cost,faults,integration").split(","));
const WORKERS = Number(opt("workers", "2"));
const SEED = Number(opt("seed", "1"));
const OUT = resolve(opt("out", join(HERE, ".out", GROUP ?? "x")));
const PAGE_JS = readFileSync(join(HERE, ".out/page.js"), "utf8");
mkdirSync(join(OUT, "crops"), { recursive: true });

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const GROUPS = {
  A1: ["text-invisible:equal", "text-invisible:1.3", "font-failed", "css-var-undefined", "text-template-leak:object", "text-template-leak:nan", "text-encoding", "text-placeholder"],
  A2: ["image-broken", "image-distorted", "image-css-broken", "media-failed", "icon-font-failed", "stylesheet-failed", "csp-blocked"],
};
const FAULTS = {
  desktop: ["A1", "A2", "page-overflow-x", "pointer-events-leak", "scroll-lock-stuck", "click-blocked", "control-unreachable", "focus-obscured", "dialog-covered", "layout-shift", "page-blank"],
  phone: ["A1", "A2", "viewport-meta-missing", "page-overflow-x", "control-unreachable", "scroll-lock-stuck"],
};
const EARLY = new Set(["page-blank", "viewport-meta-missing"]);
/** Kinds matched by kind alone (the finding names html, body or a moved element, not the planted one). */
const PAGE_LEVEL = new Set(["pointer-events-leak", "scroll-lock-stuck", "layout-shift", "page-blank", "viewport-meta-missing", "csp-blocked"]);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class NotMeasured extends Error {}

async function ev(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch {
    return undefined;
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function openPage(browser, spec, o) {
  const ctx = await browser.newContext({ ...VIEWPORTS[o.viewport], colorScheme: o.scheme ?? "light" });
  const blocked = new Set();
  if (spec.local) await ctx.route("**/*", localRoute(blocked));
  await ctx.addInitScript(
    (c) => {
      if (c.bench) window.__GC_BENCH_CFG = c.bench;
      if (c.gc) window.GENCLASS_CONFIG = Object.assign({}, window.GENCLASS_CONFIG || {}, c.gc);
      if (c.local) {
        try {
          localStorage.setItem("genclass.telemetry", "off");
        } catch {
          /* storage blocked */
        }
      }
    },
    { bench: o.bench ?? null, gc: o.harness === false ? null : (spec.gcConfig ?? null), local: !!spec.local },
  );
  if (o.harness !== false) await ctx.addInitScript({ content: PAGE_JS });
  if (o.init) await ctx.addInitScript(o.init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.length < 10 && errors.push(String(e?.message ?? e).slice(0, 300)));
  if (o.throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: o.throttle });
  }
  return { ctx, page, blocked, errors };
}

async function challenge(page) {
  return ev(page, () => {
    const t = (document.title || "").toLowerCase();
    if (/just a moment|attention required|access denied|are you a robot|verify you are human|captcha|request blocked|pardon our interruption|^forbidden|security check/.test(t)) return `title "${document.title.slice(0, 60)}"`;
    if (document.querySelector("#challenge-form, #challenge-running, #cf-challenge-running, iframe[src*='captcha'], iframe[src*='challenges.cloudflare.com'], #px-captcha, .g-recaptcha, [data-sitekey]")) return "a challenge element";
    const body = (document.body?.innerText || "").slice(0, 3000).toLowerCase();
    if (/verify you are human|enable javascript and cookies to continue|unusual traffic from your|are you a robot|checking your browser/.test(body)) return "challenge text";
    return null;
  });
}

async function waitFirstPass(page, ms) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    try {
      const s = await page.evaluate(() => {
        const b = window.__gcBench;
        return b ? { passes: b.passes(), error: b.error, started: b.startedAt !== null } : { missing: String(window.__gcBenchError ?? "") };
      });
      last = s;
      if (s?.error) return { ok: false, why: `engine error: ${s.error.slice(0, 200)}` };
      if (s && s.passes >= 1) return { ok: true };
    } catch {
      /* a navigation is in progress (the demos reload once for cross-origin isolation) */
    }
    await sleep(300);
  }
  if (!last) return { ok: false, why: "the page never answered" };
  if (last.missing !== undefined) return { ok: false, why: `the harness did not run${last.missing ? `: ${last.missing}` : ""}` };
  return { ok: false, why: last.started ? "no pass within the time limit" : "the engine never started" };
}

async function arrive(page, spec, rec, t0) {
  const resp = await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: spec.timeoutMs });
  rec.status = resp?.status() ?? null;
  if (rec.status && rec.status >= 400) throw new NotMeasured(`HTTP ${rec.status}`);
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => (rec.loadTimeout = true));
  if (spec.ready) await page.waitForSelector(spec.ready, { timeout: 45_000 });
  if (!spec.local) {
    await sleep(1500);
    const ch = await challenge(page);
    if (ch) throw new NotMeasured(`bot challenge (${ch})`);
  }
  const vis = await ev(page, () => document.visibilityState);
  if (vis !== "visible") throw new Error(`visibilityState is ${vis}`);
  // a page may navigate once more right after load (the demos reload for cross-origin isolation): measure the
  // document that stays
  for (let i = 0; ; i++) {
    const w = await waitFirstPass(page, 45_000);
    if (!w.ok) throw new NotMeasured(w.why);
    const origin = await ev(page, () => performance.timeOrigin);
    await sleep(1000);
    if (origin !== undefined && (await ev(page, () => performance.timeOrigin)) === origin) break;
    if (i >= 2) throw new NotMeasured("the page kept navigating");
  }
  rec.firstPassMs = Date.now() - t0;
  rec.firstPass = await ev(page, () => window.__gcBench.summary());
}

/** Scan mode (VISUAL.md 15): hover and keyboard focus over controls, a pass, scroll to the end, another pass. */
async function scan(page) {
  const pts = (await ev(page, () => window.__gcBench.hoverTargets(8))) ?? [];
  for (const p of pts) {
    await page.mouse.move(p.x, p.y, { steps: 2 }).catch(() => undefined);
    await sleep(650);
  }
  await page.mouse.move(1, 1).catch(() => undefined);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab").catch(() => undefined);
    await sleep(350);
  }
  await sleep(500);
  await ev(page, () => window.__gcBench.now());
  const q = (await ev(page, () => window.__gcBench.quietPoint())) ?? { x: 640, y: 400 };
  await page.mouse.move(q.x, q.y).catch(() => undefined);
  for (let i = 0; i < 12; i++) {
    const end = await ev(page, () => scrollY + innerHeight >= document.documentElement.scrollHeight - 2);
    if (end !== false) break;
    await page.mouse.wheel(0, 700).catch(() => undefined);
    await sleep(250);
  }
  await sleep(1800); // control-unreachable: 500 ms after scrolling stops, re-checked 1 s later
  await ev(page, () => window.__gcBench.now());
  await sleep(2200); // one more periodic read (pointer-events, scroll lock)
}

async function crop(page, rec, f) {
  const file = `${rec.id}-${f.i}.png`;
  try {
    const box = await ev(
      page,
      (i) => {
        const el = window.__gcBench.element(i);
        if (!el || !el.isConnected || el === document.documentElement || el === document.body) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      },
      f.i,
    );
    if (box && box.w >= 1 && box.h >= 1) {
      const pad = 24;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      await page.screenshot({ path: join(OUT, "crops", file), fullPage: true, clip: { x, y, width: Math.min(1400, box.w + 2 * pad), height: Math.min(1000, box.h + 2 * pad) }, timeout: 8000 });
    } else await page.screenshot({ path: join(OUT, "crops", file), timeout: 8000 });
    f.crop = file;
  } catch (e) {
    f.cropError = String(e?.message ?? e).slice(0, 160);
  }
}

async function collect(page, rec, crops) {
  rec.findings = (await ev(page, () => window.__gcBench.serial())) ?? [];
  rec.summary = (await ev(page, () => window.__gcBench.summary())) ?? null;
  rec.title = (await page.title().catch(() => "")).slice(0, 80);
  rec.finalUrl = page.url();
  if (crops) for (const f of rec.findings.slice(0, 12)) await crop(page, rec, f);
}

const idOf = (spec, o) => `${spec.id.replace(/[^\w-]+/g, "_")}-${o.viewport}-${o.scheme ?? "light"}${o.throttle ? `-x${o.throttle}` : ""}${o.fault ? `-${o.fault.replace(/[^\w-]+/g, "_")}` : ""}`;

async function cleanLoad(browser, spec, o) {
  const rec = { id: idOf(spec, o), group: spec.group, page: spec.id, url: spec.url, part: o.throttle ? "cost" : "clean", viewport: o.viewport, scheme: o.scheme, throttle: o.throttle ?? 1, measured: false };
  const t0 = Date.now();
  const { ctx, page, blocked, errors } = await openPage(browser, spec, { ...o, bench: { mode: spec.local ? "guard" : "observe", fix: !!spec.local, seed: SEED } });
  try {
    spec.reset?.();
    await arrive(page, spec, rec, t0);
    if (!spec.local) await page.screenshot({ path: join(OUT, "crops", `${rec.id}-view.jpg`), type: "jpeg", quality: 55, timeout: 8000 }).then(() => (rec.view = `${rec.id}-view.jpg`), () => undefined);
    if (o.throttle) {
      await ev(page, () => window.__gcBench.now());
    } else await scan(page);
    if (!spec.local) {
      const ch = await challenge(page);
      if (ch) throw new NotMeasured(`bot challenge after load (${ch})`);
    }
    rec.measured = true;
    await collect(page, rec, !o.throttle);
    if (o.viewport === "desktop" && !o.throttle) {
      rec.dark = await ev(page, () => window.__gcBench.darkSupport());
      rec.root = await ev(page, () => window.__gcBench.rootColors());
    }
  } catch (e) {
    rec.notMeasured = e instanceof NotMeasured ? e.message : `error: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`;
  } finally {
    rec.ms = Date.now() - t0;
    rec.blocked = [...blocked].slice(0, 20);
    rec.pageErrors = errors;
    await ctx.close().catch(() => undefined);
  }
  log(`${rec.id}: ${rec.measured ? `${rec.findings.length} finding(s)${rec.findings.length ? ` [${[...new Set(rec.findings.map((f) => f.kind))].join(", ")}]` : ""}` : `not measured (${rec.notMeasured})`} ${Math.round(rec.ms / 1000)} s`);
  return rec;
}

async function drive(page, fault, planted) {
  const p = planted[0];
  switch (fault) {
    case "click-blocked":
      if (!p?.ok || !p.point) return;
      await sleep(300);
      await page.mouse.click(p.point.x, p.point.y);
      await sleep(450);
      await page.mouse.click(p.point.x, p.point.y);
      await sleep(1500);
      return;
    case "scroll-lock-stuck":
      if (!p?.ok || !p.point) return;
      await sleep(2300); // a periodic read sees the lock first
      await page.mouse.move(p.point.x, p.point.y);
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, 400);
        await sleep(450);
      }
      await sleep(2600);
      return;
    case "control-unreachable":
      if (!p?.ok || !p.point) return;
      await page.mouse.move(p.point.x, p.point.y);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 2500);
        await sleep(300);
      }
      await sleep(2500);
      return;
    case "focus-obscured":
    case "dialog-covered":
      await sleep(2000);
      return;
    case "pointer-events-leak":
      await sleep(4600);
      return;
    case "page-blank":
      await sleep(7000);
      return;
    default:
      await sleep(1500);
  }
}

function match(rec) {
  for (const p of rec.planted) {
    if (!p?.ok) continue;
    const hits = rec.findings.filter((f) => {
      if (f.kind !== p.kind) return false;
      if (p.kind === "layout-shift") return Number(f.measured?.startS ?? 0) * 1000 >= (rec.injectedAt ?? 0) - 200;
      if (PAGE_LEVEL.has(p.kind)) return true;
      if (p.kind === "page-overflow-x") return f.faultId === p.id || f.tag === "html";
      return f.faultId === p.id;
    });
    p.detected = hits.length > 0;
    p.hits = hits.map((f) => f.i);
    if (hits.some((f) => f.fix)) p.fix = hits.some((f) => f.fix?.applied && f.fixHeld) ? "held" : hits.some((f) => f.fix?.applied) ? "undone" : "not applied";
  }
  const used = new Set(rec.planted.flatMap((p) => p?.hits ?? []));
  rec.collateral = rec.findings.filter((f) => !used.has(f.i)).map((f) => ({ i: f.i, kind: f.kind, selector: f.selector, fault: f.fault }));
}

async function faultLoad(browser, spec, o) {
  const rec = { id: idOf(spec, o), group: spec.group, page: spec.id, url: spec.url, part: "faults", fault: o.fault, viewport: o.viewport, scheme: "light", measured: false, planted: [] };
  const t0 = Date.now();
  const early = EARLY.has(o.fault) ? o.fault : undefined;
  const { ctx, page, blocked, errors } = await openPage(browser, spec, { viewport: o.viewport, scheme: "light", bench: { mode: "guard", fix: true, early, seed: SEED } });
  try {
    spec.reset?.();
    await arrive(page, spec, rec, t0);
    await sleep(400);
    if (early) rec.planted.push({ kind: o.fault, id: o.fault, ok: true });
    else for (const k of GROUPS[o.fault] ?? [o.fault]) rec.planted.push((await ev(page, ([k, s]) => window.__gcBench.inject(k, s), [k, SEED])) ?? { kind: k.split(":")[0], id: k, ok: false, reason: "inject failed" });
    await drive(page, o.fault, rec.planted);
    await ev(page, () => window.__gcBench.now());
    for (const p of rec.planted) if (p.ok) p.truth = (await ev(page, (id) => window.__gcBench.truth(id), p.id)) ?? { ok: false, why: "truth failed" };
    rec.injectedAt = await ev(page, () => window.__gcBench.injectedAt);
    rec.measured = true;
    await collect(page, rec, false);
    match(rec);
  } catch (e) {
    rec.notMeasured = e instanceof NotMeasured ? e.message : `error: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`;
  } finally {
    rec.ms = Date.now() - t0;
    rec.blocked = [...blocked].slice(0, 20);
    rec.pageErrors = errors;
    await ctx.close().catch(() => undefined);
  }
  const took = rec.planted.filter((p) => p.ok && p.truth?.ok);
  log(`${rec.id}: ${rec.measured ? `${took.filter((p) => p.detected).length}/${took.length} found (${rec.planted.length} planted), ${rec.collateral?.length ?? 0} other` : `not measured (${rec.notMeasured})`}`);
  return rec;
}

/** The real integration: the page's own runtime with visual on (the stub, the chunk loaded by URL), no harness. */
async function integrationLoad(browser, spec) {
  const u = new URL(spec.url);
  u.searchParams.delete("genclass-visual");
  const s2 = { ...spec, url: u.href };
  const rec = { id: `${idOf(spec, { viewport: "desktop", scheme: "light" })}-integration`, group: spec.group, page: spec.id, part: "integration", viewport: "desktop", scheme: "light", measured: false };
  const t0 = Date.now();
  const init = () => {
    const I = (window.__gcInt = { checks: [], rt: null, firstPassAt: null });
    window.GENCLASS_CONFIG = Object.assign({}, window.GENCLASS_CONFIG || {}, {
      telemetry: false,
      model: false,
      visual: true,
      plugins: [
        {
          name: "bench-visual",
          setup(api) {
            I.rt = api.runtime;
            api.on("check", (f) => I.checks.push({ kind: f.kind, selector: f.selector, message: f.message }));
          },
        },
      ],
    });
  };
  const { ctx, page, blocked, errors } = await openPage(browser, s2, { viewport: "desktop", scheme: "light", harness: false, init });
  try {
    spec.reset?.();
    const resp = await page.goto(s2.url, { waitUntil: "load", timeout: spec.timeoutMs });
    rec.status = resp?.status() ?? null;
    if (spec.ready) await page.waitForSelector(spec.ready, { timeout: 45_000 });
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const p = await ev(page, () => {
        const v = window.__gcInt?.rt?.summary?.()?.visual;
        return v && v.passes >= 1 ? performance.now() : null;
      });
      if (p) {
        rec.firstPassAtMs = Math.round(p);
        break;
      }
      await sleep(100);
    }
    await sleep(3000);
    Object.assign(
      rec,
      (await ev(page, () => {
        const nav = performance.getEntriesByType("navigation")[0];
        const chunk = performance.getEntriesByType("resource").find((e) => /visual\/index\.js/.test(e.name));
        return {
          loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
          chunkRequestMs: chunk ? Math.round(chunk.startTime) : null,
          chunkBytes: chunk ? chunk.encodedBodySize || chunk.transferSize || null : null,
          checks: window.__gcInt?.checks ?? [],
          summary: window.__gcInt?.rt?.summary?.()?.visual ?? null,
        };
      })) ?? {},
    );
    rec.measured = rec.firstPassAtMs != null;
    if (!rec.measured) rec.notMeasured = "no pass within 30 s";
  } catch (e) {
    rec.notMeasured = `error: ${String(e?.message ?? e).split("\n")[0].slice(0, 300)}`;
  } finally {
    rec.ms = Date.now() - t0;
    rec.blocked = [...blocked].slice(0, 20);
    rec.pageErrors = errors;
    await ctx.close().catch(() => undefined);
  }
  log(`${rec.id}: ${rec.measured ? `first pass at ${rec.firstPassAtMs} ms (load ${rec.loadEventMs} ms, chunk requested at ${rec.chunkRequestMs} ms), ${rec.checks.length} finding(s)` : `not measured (${rec.notMeasured})`}`);
  return rec;
}

async function main() {
  if (!GROUP) throw new Error("--group demos|templates|compat|sites");
  const corpus = await start(GROUP, { shard: SHARD });
  // smoke run (VISUAL_SMOKE=true): two pages per group, to check the plumbing
  if (process.env.VISUAL_SMOKE === "true") corpus.pages = corpus.pages.filter((p) => GROUP !== "compat" || p.faults).slice(0, 2);
  const browser = await chromium.launch();
  const out = { group: GROUP, shard: SHARD, parts: [...PARTS], seed: SEED, at: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, chromium: browser.version(), pages: corpus.pages.map((p) => p.id), loads: [] };
  const file = join(OUT, `${GROUP}${SHARD ? `-${SHARD.replace("/", "of")}` : ""}-${[...PARTS].join("+")}.json`);
  const save = () => writeFileSync(file, JSON.stringify(out, null, 1));
  try {
    if (GROUP === "sites") {
      // one site at a time; dark loads only where the site has a dark design
      for (const spec of corpus.pages) {
        const light = await cleanLoad(browser, spec, { viewport: "desktop", scheme: "light" });
        out.loads.push(light);
        if (light.measured) {
          out.loads.push(await cleanLoad(browser, spec, { viewport: "phone", scheme: "light" }));
          if (light.dark?.supported !== false) {
            const dd = await cleanLoad(browser, spec, { viewport: "desktop", scheme: "dark" });
            dd.darkDesign = light.dark?.supported === true || (!!dd.root && JSON.stringify(dd.root) !== JSON.stringify(light.root));
            out.loads.push(dd);
            if (dd.darkDesign) out.loads.push(Object.assign(await cleanLoad(browser, spec, { viewport: "phone", scheme: "dark" }), { darkDesign: true }));
          }
        }
        save();
      }
    } else {
      const pages = corpus.pages;
      if (PARTS.has("clean")) {
        const jobs = pages.flatMap((spec) => ["desktop", "phone"].flatMap((viewport) => ["light", "dark"].map((scheme) => ({ spec, o: { viewport, scheme } }))));
        out.loads.push(...(await pool(jobs, WORKERS, (j) => cleanLoad(browser, j.spec, j.o))));
        save();
      }
      if (PARTS.has("cost")) {
        for (const spec of pages) out.loads.push(await cleanLoad(browser, spec, { viewport: "desktop", scheme: "light", throttle: 4 }));
        save();
      }
      if (PARTS.has("integration")) {
        for (const spec of pages.filter((p) => p.integration)) out.loads.push(await integrationLoad(browser, spec));
        save();
      }
      if (PARTS.has("faults")) {
        const jobs = pages.filter((p) => p.faults).flatMap((spec) => Object.entries(FAULTS).flatMap(([viewport, list]) => list.map((fault) => ({ spec, o: { viewport, fault } }))));
        out.loads.push(...(await pool(jobs, Math.max(WORKERS, 3), (j) => faultLoad(browser, j.spec, j.o))));
        save();
      }
    }
  } finally {
    save();
    await browser.close().catch(() => undefined);
    await corpus.stop().catch(() => undefined);
  }
  const m = out.loads.filter((l) => l.measured);
  log(`${file}: ${out.loads.length} loads, ${m.length} measured, ${m.reduce((a, l) => a + (l.part === "clean" ? l.findings.length : 0), 0)} findings on clean loads`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
