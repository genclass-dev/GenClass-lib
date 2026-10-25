// The bench runner: builds the pages, fetches the model, starts the server and drives every strategy page in
// headless Chromium (Playwright) for each GenClass condition, network profile and seed, then writes the raw results
// (results/raw/<condition>/<strategy>-<profile>.json) and the report (report.mjs -> RESULTS.md).
//
//   node run.mjs                                   everything (3 conditions x 14 strategies x 3 profiles x 200 seeds)
//   node run.mjs --conditions off --seeds 20       a quick look
//   options: --conditions off,model,skipped  --strategies a,b,...  --profiles fast,jittery,lossy  --seeds 200
//            --seed-start 1  --workers 6  --model-workers 3  --out <dir> (default results/raw)  --force (redo
//            finished cells)  --no-report
//
// A cell (condition, strategy, profile) is written when all its seeds are done, so an interrupted run resumes where it
// stopped. What the user does in a seed (query, keystroke delays, the pause, the double-click gap) depends on the
// seed only, and what the network does to a request depends on the seed, the profile and the request, so every
// strategy and condition in a seed sees the same user and the same network.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import https from "node:https";
import os from "node:os";
import { chromium } from "playwright";
import { build } from "./build.mjs";
import { CONDITIONS, PROFILES, QUERIES, SETTLE_CAP_MS, SETTLE_QUIET_MS, STRATEGIES, USER } from "./lib/config.mjs";
import { ensureModel } from "./lib/model.mjs";
import { stream, uniformInt } from "./lib/rng.mjs";
import { start } from "./server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let RAW = join(HERE, "results/raw");

function args() {
  const a = process.argv.slice(2);
  const get = (name, def) => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : def;
  };
  return {
    conditions: get("conditions", Object.keys(CONDITIONS).join(",")).split(","),
    strategies: get("strategies", STRATEGIES.map((s) => s.id).join(",")).split(","),
    profiles: get("profiles", Object.keys(PROFILES).join(",")).split(","),
    seeds: Number(get("seeds", "200")),
    seedStart: Number(get("seed-start", "1")),
    workers: Number(get("workers", "6")),
    modelWorkers: Number(get("model-workers", "3")),
    out: get("out", null),
    force: a.includes("--force"),
    report: !a.includes("--no-report"),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the user does in a seed: the same in every strategy, profile and condition. */
export function userPlan(kind, seed) {
  const rnd = stream(`user|${kind}|${seed}`);
  if (kind === "submit") return { gapMs: uniformInt(rnd, USER.doubleClickGapMs[0], USER.doubleClickGapMs[1]) };
  const query = QUERIES[Math.floor(rnd() * QUERIES.length)];
  const space = query.indexOf(" ");
  const keys = [...query].map((ch, i) => ({
    ch,
    // the delay before this key; the space comes after the user's glance at the first results
    before: i === 0 ? 0 : i === space ? uniformInt(rnd, USER.wordPauseMs[0], USER.wordPauseMs[1]) : uniformInt(rnd, USER.keyDelayMs[0], USER.keyDelayMs[1]),
  }));
  return { query, keys };
}

// Harness instrumentation added to every page before its own scripts: when each keystroke and click happened, and
// every change of what the page shows (the results' term, the error, the created ticket). It reads the DOM only.
const INIT = `(() => {
  const s = { keys: [], clicks: [], timeline: [], lastMutation: 0, errors: [] };
  Object.defineProperty(window, "__bench", { value: s });
  addEventListener("keydown", () => s.keys.push(performance.now()), true);
  addEventListener("mousedown", () => s.clicks.push(performance.now()), true);
  addEventListener("error", (e) => s.errors.push(String(e.message)));
  const read = () => {
    const r = document.getElementById("results");
    const c = document.getElementById("created");
    return { term: r ? r.getAttribute("data-term") : null, error: !!document.getElementById("error"), created: c ? c.getAttribute("data-id") : null };
  };
  let last = "";
  const check = () => {
    s.lastMutation = performance.now();
    const v = read();
    const k = JSON.stringify(v);
    if (k !== last) { last = k; s.timeline.push({ t: performance.now(), ...v }); }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

// The runner talks to the server's control routes over HTTPS with the bench's own certificate.
let agent = null;
function api(origin, path, init = {}) {
  agent ??= new https.Agent({ keepAlive: true, maxSockets: 32, ca: readFileSync(join(HERE, ".cache/tls/cert.pem")) });
  return new Promise((ok, fail) => {
    const req = https.request(origin + path, { method: init.method ?? "GET", headers: init.headers, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          fail(e);
        }
      });
    });
    req.on("error", fail);
    req.end(init.body);
  });
}

/** Wait until nothing is in flight, nothing new started, the page is quiet and not busy; or the cap. */
async function settle(page, origin, id, since) {
  for (;;) {
    const [srv, pg] = await Promise.all([
      api(origin, `/__bench/runs/${encodeURIComponent(id)}`),
      page.evaluate(() => ({ quiet: performance.now() - window.__bench.lastMutation, busy: !!document.querySelector('[aria-busy="true"]') })),
    ]);
    if (srv.inflight === 0 && srv.quietMs >= SETTLE_QUIET_MS && pg.quiet >= SETTLE_QUIET_MS && !pg.busy) return { capped: false };
    if (Date.now() - since > SETTLE_CAP_MS) return { capped: true };
    await sleep(100);
  }
}

/** In the model condition: wait until the runtime has made no new decision for a second (decisions are async). */
async function drainDecisions(page) {
  const t0 = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - t0 < 10000) {
    const n = await page.evaluate(() => {
      const s = window.GenClass?.runtime?.summary();
      return s ? s.model.decisions + Object.values(s.detections).reduce((a, b) => a + b, 0) : 0;
    });
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1000) return;
    await sleep(200);
  }
}

const GC_COLLECT = () => {
  const rt = window.GenClass?.runtime;
  if (!rt) return null;
  const st = rt.status;
  return {
    status: { state: st.state, reason: st.reason ?? null, device: st.device ?? null, model: st.model ?? null, loadMs: st.loadMs ?? null },
    summary: rt.summary(),
    decisions: rt.decisions().map((d) => {
      // the subject, short: the search term or the request line
      const q = /[?&]q=(.*?) \(#/.exec(d.subject);
      const line = /(GET|POST) (\/api\/[a-z]+)/.exec(d.subject);
      return {
        trigger: d.trigger,
        subject: q ? `q:${decodeURIComponent(q[1])}` : line ? `${line[1]} ${line[2]}` : d.subject.slice(0, 40),
        diagnosis: d.diagnosis,
        p: Math.round(d.diagnosisConfidence * 1000) / 1000,
        detection: d.detection ?? null,
        action: d.action,
        latencyMs: Math.round(d.latencyMs),
      };
    }),
  };
};

/** Classify a search run's final state and its timeline. */
function searchOutcome(plan, fin, bench, log) {
  const final = plan.query;
  const typedAt = (term) => (term === null ? -1 : final.startsWith(term) ? term.length : -1);
  let category;
  if (fin.error) {
    // an error is the truth only if the final term's last answer was a failure
    const answers = log.filter((e) => e.key === `GET /api/search?q=${final}` && !e.aborted && e.end !== null).sort((x, y) => x.end - y.end);
    const lastAnswer = answers[answers.length - 1];
    category = lastAnswer && lastAnswer.status >= 500 ? "error" : "wrong-error";
  } else if (fin.term === final) category = "correct";
  else if (fin.term !== null) category = "stale";
  else category = "missing";
  // overwrites: the shown results moved to an older (shorter) prefix than the one shown before
  let overwrites = 0;
  let shown = -1;
  for (const s of bench.timeline) {
    if (s.term === null || s.error) continue;
    const at = typedAt(s.term);
    if (at < shown) overwrites++;
    shown = at;
  }
  const lastKey = bench.keys[bench.keys.length - 1];
  let correctAt = null;
  for (const s of bench.timeline) {
    const ok = s.term === final && !s.error;
    if (ok && correctAt === null) correctAt = s.t;
    if (!ok) correctAt = null;
  }
  const delays = bench.keys.slice(1).map((t, i) => t - bench.keys[i]);
  const drift = delays.map((d, i) => Math.abs(d - plan.keys[i + 1].before));
  return {
    query: final,
    finalTerm: fin.term,
    error: fin.error,
    category,
    wrong: category === "stale" || category === "wrong-error" || category === "missing",
    overwrites,
    timeToCorrectMs: category === "correct" && correctAt !== null && lastKey !== undefined ? Math.round(correctAt - lastKey) : null,
    keyDriftMaxMs: drift.length ? Math.round(Math.max(...drift)) : 0,
  };
}

function submitOutcome(plan, fin, bench, srv, clickGap) {
  const tickets = srv.tickets.length;
  const firstClick = bench.clicks[0];
  const created = bench.timeline.find((s) => s.created !== null);
  return {
    gapMs: plan.gapMs,
    gapActualMs: clickGap === null ? null : Math.round(clickGap),
    tickets,
    category: tickets > 1 ? "duplicate" : tickets === 1 ? "one" : "none",
    wrong: tickets > 1,
    posts: srv.log.filter((e) => e.key === "POST /api/tickets").length,
    timeToConfirmMs: created && firstClick !== undefined ? Math.round(created.t - firstClick) : null,
    errorShown: fin.error,
  };
}

async function oneRun(page, origin, cond, strategy, profile, seed) {
  const id = `${cond}-${strategy.id}-${profile}-${seed}`;
  await api(origin, "/__bench/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, strategy: strategy.id, profile, seed, gc: CONDITIONS[cond].gc }) });
  const pageErrors = [];
  const onErr = (e) => pageErrors.push(String(e.message ?? e));
  page.on("pageerror", onErr);
  try {
    await page.goto(`${origin}/s/${strategy.id}/?run=${encodeURIComponent(id)}`, { waitUntil: "load", timeout: 30000 });
    let ready = null;
    if (CONDITIONS[cond].gc === "model") {
      ready = await page.evaluate(async () => {
        const rt = window.GenClass?.runtime;
        if (!rt) return { ok: false, why: "no runtime" };
        const t = new Promise((r) => setTimeout(() => r("timeout"), 30000));
        const r = await Promise.race([rt.ready.then(() => "ready"), t]);
        return { ok: r === "ready" && rt.status.state === "ready", why: r, state: rt.status.state };
      });
      if (!ready.ok) throw new Error(`model not ready: ${JSON.stringify(ready)}`);
    }
    const plan = userPlan(strategy.kind, seed);
    let since;
    let clickGap = null;
    if (strategy.kind === "search") {
      await page.focus("#q");
      for (const k of plan.keys) {
        if (k.before) await sleep(k.before);
        await page.keyboard.type(k.ch);
      }
      since = Date.now();
    } else {
      // a user sees the page, then double-clicks Create
      await page.waitForFunction(() => !/Loading/.test(document.getElementById("count")?.textContent ?? "Loading"), null, { timeout: 2500 }).catch(() => {});
      const box = await page.locator("#create").boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down({ clickCount: 1 });
      await page.mouse.up({ clickCount: 1 });
      const firstUp = performance.now();
      if (plan.gapMs) await sleep(plan.gapMs);
      // a disabled button gets no mouse events in Chromium, so the gap is timed here, not in the page
      clickGap = performance.now() - firstUp;
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      since = Date.now();
    }
    const st = await settle(page, origin, id, since);
    if (CONDITIONS[cond].gc === "model") await drainDecisions(page);
    const pageState = await page.evaluate(() => {
      const b = window.__bench;
      const r = document.getElementById("results");
      const c = document.getElementById("created");
      return {
        fin: { term: r ? r.getAttribute("data-term") : null, error: !!document.getElementById("error"), created: c ? c.getAttribute("data-id") : null, input: document.getElementById("q")?.value ?? null },
        bench: { keys: b.keys, clicks: b.clicks, timeline: b.timeline, errors: b.errors },
      };
    });
    const gc = CONDITIONS[cond].gc ? await page.evaluate(GC_COLLECT) : null;
    const srv = await api(origin, `/__bench/runs/${encodeURIComponent(id)}`);
    const outcome = strategy.kind === "search" ? searchOutcome(plan, pageState.fin, pageState.bench, srv.log) : submitOutcome(plan, pageState.fin, pageState.bench, srv, clickGap);
    if (strategy.kind === "search" && pageState.fin.input !== plan.query) throw new Error(`typed "${pageState.fin.input}", planned "${plan.query}"`);
    return {
      seed,
      ...outcome,
      requests: srv.log.length,
      aborted: srv.log.filter((e) => e.aborted).length,
      failed: srv.log.filter((e) => e.status >= 500).length,
      capped: st.capped,
      pageErrors: pageErrors.length + pageState.bench.errors.length,
      log: srv.log.map((e) => [e.key.replace(/^GET \/api\/search\?q=/, "q:"), e.attempt, Math.round(e.arrival), e.wait, e.status, e.aborted ? 1 : 0]),
      gc: gc && {
        status: gc.status,
        detections: gc.summary.detections,
        possible: gc.summary.possibleDetections,
        decisions: gc.decisions,
        modelP50Ms: gc.summary.model.p50Ms ?? null,
        dropped: gc.summary.model.dropped,
      },
    };
  } finally {
    page.off("pageerror", onErr);
    await api(origin, `/__bench/runs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }
}

function cellFile(cond, sid, profile) {
  return join(RAW, cond, `${sid}-${profile}.json`);
}

async function runCondition(browser, origin, cond, opt, meta) {
  const cells = [];
  for (const sid of opt.strategies) for (const profile of opt.profiles) {
    const f = cellFile(cond, sid, profile);
    if (!opt.force && existsSync(f)) continue;
    cells.push({ strategy: STRATEGIES.find((s) => s.id === sid), profile, file: f, runs: [], errors: [] });
  }
  if (!cells.length) return;
  const queue = [];
  for (const cell of cells) for (let s = opt.seedStart; s < opt.seedStart + opt.seeds; s++) queue.push({ cell, seed: s, tries: 0 });
  const total = queue.length;
  let done = 0;
  const t0 = Date.now();
  const nWorkers = CONDITIONS[cond].gc === "model" ? opt.modelWorkers : opt.workers;
  mkdirSync(join(RAW, cond), { recursive: true });
  const finishCell = (cell) => {
    if (cell.runs.length + cell.errors.length < opt.seeds) return;
    cell.runs.sort((a, b) => a.seed - b.seed);
    writeFileSync(cell.file, JSON.stringify({ condition: cond, strategy: cell.strategy.id, profile: cell.profile, seeds: [opt.seedStart, opt.seedStart + opt.seeds - 1], workers: nWorkers, ...meta, runs: cell.runs, harnessErrors: cell.errors }) + "\n");
  };
  async function worker() {
    let context = null;
    let page = null;
    let used = 0;
    const fresh = async () => {
      if (context) await context.close().catch(() => {});
      context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1000, height: 700 } });
      await context.addInitScript(INIT);
      page = await context.newPage();
      used = 0;
    };
    await fresh();
    while (queue.length) {
      const job = queue.shift();
      if (used >= 60) await fresh();
      used++;
      try {
        const r = await oneRun(page, origin, cond, job.cell.strategy, job.cell.profile, job.seed);
        job.cell.runs.push(r);
      } catch (e) {
        if (job.tries < 2) {
          job.tries++;
          queue.push(job);
          await fresh();
          continue;
        }
        job.cell.errors.push({ seed: job.seed, error: String(e.message ?? e).slice(0, 300) });
      }
      done++;
      finishCell(job.cell);
      if (done % 50 === 0 || done === total) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log(`[${cond}] ${done}/${total} runs, ${rate.toFixed(2)} runs/s, about ${Math.round((total - done) / rate / 60)} min left`);
      }
    }
    await context.close().catch(() => {});
  }
  await Promise.all(Array.from({ length: nWorkers }, worker));
}

function versions() {
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const lock = read(join(HERE, "package-lock.json")).packages;
  const v = (n) => lock[`node_modules/${n}`]?.version ?? null;
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: HERE }).toString().trim();
  } catch {}
  return {
    runtime: read(join(HERE, "../../packages/runtime/package.json")).version,
    commit,
    react: v("react"),
    "@tanstack/react-query": v("@tanstack/react-query"),
    swr: v("swr"),
    rxjs: v("rxjs"),
    vue: v("vue"),
    svelte: v("svelte"),
    playwright: v("playwright"),
    node: process.version,
    cpus: os.cpus().length,
  };
}

async function main() {
  const opt = args();
  if (opt.out) RAW = opt.out;
  if (!existsSync(join(HERE, "../../packages/runtime/dist/genclass.global.min.js"))) {
    console.log("building @genclass/runtime (packages/runtime/dist is missing)");
    execFileSync("npm", ["run", "build", "-w", "@genclass/runtime"], { cwd: join(HERE, "../.."), stdio: "inherit" });
  }
  // SKIP_BUILD=1: reuse .out/build (for a second runner started next to a first one)
  if (!process.env.SKIP_BUILD) await build();
  const model = opt.conditions.includes("model") ? ensureModel() : null;
  const { origin, server } = await start(Number(process.env.PORT ?? 4517));
  const browser = await chromium.launch();
  const meta = { versions: { ...versions(), chromium: browser.version(), model: model ? `@genclass/runtime-model@${model.version} (${model.card.name} ${model.card.version})` : null }, startedAt: new Date().toISOString() };
  console.log(`server ${origin}; Chromium ${browser.version()}; ${opt.seeds} seeds from ${opt.seedStart}`);
  try {
    for (const cond of opt.conditions) await runCondition(browser, origin, cond, opt, meta);
  } finally {
    await browser.close();
    server.close();
  }
  if (opt.report) {
    const { report } = await import("./report.mjs");
    // with --out, the report goes next to the raw results instead of over RESULTS.md
    report(RAW, opt.out ? dirname(RAW) : null);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
