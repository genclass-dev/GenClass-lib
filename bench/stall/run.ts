// request-stalled on the demos (issue 94; docs/runtime/VISUAL.md 3.24, RESULTS.md): false reports and recall of the
// measured stalled-request check, in headless Chromium with the real runtime, without touching the demos.
//
//   npm run build -w @genclass/runtime
//   DEMOS_OUT_DIR=/tmp/demos-dist node demos/scripts/build.mjs
//   node --experimental-strip-types bench/stall/run.ts --dist /tmp/demos-dist [--clean 10] [--chaos 10] [--planted 3]
//
// Each trial is a fresh page in the demos' "off" mode (GenClass observes with no model; the visual checks are on
// because 127.0.0.1:<port> is a development host). The demo's own synthetic user runs its scripted steps
// (window.__trial.runSynthetic()), then the page stays open for --hold ms (default 20 s, past the 15 s threshold) so
// anything still pending (EventSource streams, polls, slow answers) has time to be reported. Findings are read from
// the console lines the runtime prints ("[GenClass] Check (measured): ... has been pending ..."): the demos do not
// expose the runtime, and nothing on the page changes for the measurement.
// - clean trials: no chaos, the apps are correct: every request-stalled finding is a false report;
// - chaos trials: the demos' chaos (hangs of 6 to 8 s, slowdowns, failures): a finding is a request pending > 15 s;
// - planted: a clean trial, then every response held 60 s by the mock server and the same steps again: each run
//   should report at least one request-stalled finding.
// Writes bench/stall/results.json and prints the table that goes into docs/runtime/RESULTS.md.

import { chromium, type BrowserContext } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveStatic } from "../../demos/e2e/serve.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const DIST = opt("dist", fileURLToPath(new URL("../../demos/dist/", import.meta.url)));
const CLEAN = Number(opt("clean", "10"));
const CHAOS = Number(opt("chaos", "10"));
const PLANTED = Number(opt("planted", "3"));
const HOLD = Number(opt("hold", "20000"));
const WORKERS = Number(opt("workers", "6"));
const PORT = Number(opt("port", "4183"));
const DEMOS = opt("demos", "search,editor,checkout,status,board,decisions").split(",");
const SITE = `http://127.0.0.1:${PORT}/genclass/`;

type Kind = "clean" | "chaos" | "planted";
interface Job {
  demo: string;
  kind: Kind;
  seed: number;
}
interface Row extends Job {
  /** The console line of each request-stalled finding. */
  stalled: string[];
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type W = { __trial?: { runSynthetic(): Promise<unknown>; chaos(p: Record<string, unknown>): Promise<void> }; __trialError?: string };
const PREFIX = "[GenClass] Check (measured): ";

async function run(ctx: BrowserContext, j: Job): Promise<Row> {
  const page = await ctx.newPage();
  const stalled: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith(PREFIX) && t.includes(" has been pending for ")) stalled.push(t.slice(PREFIX.length, PREFIX.length + 300));
  });
  try {
    const u = new URL(`${j.demo}/`, SITE);
    u.searchParams.set("embed", "trial");
    u.searchParams.set("mode", "off");
    u.searchParams.set("kind", j.kind === "chaos" ? "chaos" : "clean");
    u.searchParams.set("seed", String(j.seed));
    u.searchParams.set("run", `${j.kind}-${j.seed}`);
    await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => (window as unknown as W).__trial || (window as unknown as W).__trialError, null, { timeout: 120000, polling: 100 });
    const err = await page.evaluate(() => (window as unknown as W).__trialError);
    if (err) throw new Error(err);
    await page.evaluate(() => (window as unknown as W).__trial!.runSynthetic());
    if (j.kind === "planted") {
      await sleep(2000);
      await page.evaluate(() => (window as unknown as W).__trial!.chaos({ timeoutRate: 1, hangMs: 60000 }));
      // the same steps again: every response the apps wait for now takes 60 s
      void page.evaluate(() => (window as unknown as W).__trial!.runSynthetic()).catch(() => undefined);
    }
    await sleep(HOLD);
    return { ...j, stalled };
  } catch (e) {
    return { ...j, stalled, error: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

const server = await serveStatic(DIST, "/genclass/", PORT);
const browser = await chromium.launch();
const jobs: Job[] = [];
for (const demo of DEMOS) {
  for (let i = 0; i < CLEAN; i++) jobs.push({ demo, kind: "clean", seed: 1500 + i });
  for (let i = 0; i < CHAOS; i++) jobs.push({ demo, kind: "chaos", seed: 1000 + i });
  for (let i = 0; i < PLANTED; i++) jobs.push({ demo, kind: "planted", seed: 1700 + i });
}
const rows: Row[] = [];
const total = jobs.length;
await Promise.all(
  Array.from({ length: WORKERS }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
    // register the mock server worker once per context
    const warm = await ctx.newPage();
    await warm.goto(new URL("search/?mode=off", SITE).href, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await warm.waitForFunction(() => document.querySelector(".app-body > *"), null, { timeout: 30000, polling: 200 }).catch(() => undefined);
    await warm.close();
    while (jobs.length) {
      const j = jobs.shift()!;
      const r = await run(ctx, j);
      rows.push(r);
      console.log(`[${rows.length}/${total}] ${j.demo} ${j.kind} #${j.seed}: ${r.error ? `ERROR ${r.error}` : `${r.stalled.length} stalled`}${r.stalled.length ? ` ${JSON.stringify(r.stalled)}` : ""}`);
    }
    await ctx.close();
  }),
);
await browser.close();
server.close();

await writeFile(new URL("./results.json", import.meta.url), JSON.stringify(rows, null, 2) + "\n");
const lines = ["| demo | clean runs | clean runs with a finding (false) | chaos runs | chaos runs with a finding | planted runs | planted runs found | planted findings naming a control |", "|---|---|---|---|---|---|---|---|"];
const ok = rows.filter((r) => !r.error);
for (const demo of [...DEMOS, "all"]) {
  const of = (k: Kind) => ok.filter((r) => r.kind === k && (demo === "all" || r.demo === demo));
  const hit = (k: Kind) => of(k).filter((r) => r.stalled.length > 0).length;
  const found = of("planted").flatMap((r) => r.stalled);
  const named = found.filter((t) => t.includes(", which became ")).length;
  lines.push(`| ${demo} | ${of("clean").length} | ${hit("clean")} | ${of("chaos").length} | ${hit("chaos")} | ${of("planted").length} | ${hit("planted")} | ${named} of ${found.length} |`);
}
console.log(lines.join("\n"));
const errors = rows.filter((r) => r.error);
if (errors.length) console.log(`${errors.length} runs failed: ${[...new Set(errors.map((r) => r.error))].join("; ")}`);
