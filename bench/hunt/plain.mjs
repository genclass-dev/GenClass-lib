#!/usr/bin/env node
// The reproduction step of "Using a result publicly" (README): the same scenario with NO GenClass on the page, and the
// responses a finding names slowed down with plain Playwright routing. A race GenClass found should show the same
// wrong end state here, with nothing of GenClass involved; if it does not, say so in the report before anyone reads it.
//
//   node bench/hunt/plain.mjs --url <page> --scenario scenarios/x.mjs [--param k=v] [--storage-state file]
//     --delay 'GET /admin/users/me/permissions=2500' [--delay ...] [--runs 3] [--timeout 30000] [--headful]
//
// Each --delay names a method and a path prefix (or any substring of the URL when it holds no space) and the extra
// milliseconds before that response is handed to the page; everything else is untouched. The first run has no delays
// (the reference); the others have them. It prints each run's oracle and whether it equals the reference.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { paramsOf } from "./lib/args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = { delay: [], param: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
  const k = a.slice(2);
  if (k === "headful") opt.headful = true;
  else if (k === "delay" || k === "param") opt[k].push(argv[++i]);
  else opt[k] = argv[++i];
}
if (!opt.url || !opt.scenario) {
  console.error("usage: node bench/hunt/plain.mjs --url <page> --scenario <file> [--param k=v] [--storage-state f] [--delay 'METHOD /path=ms'] [--runs n] [--timeout ms] [--headful]");
  process.exit(1);
}
const timeout = Number(opt.timeout ?? 30_000);
const runs = Math.max(2, Number(opt.runs ?? 2));
const params = paramsOf(opt.param);
const delays = opt.delay.map((d) => {
  const eq = d.lastIndexOf("=");
  const [method, path] = d.slice(0, eq).includes(" ") ? d.slice(0, eq).split(" ", 2) : [null, d.slice(0, eq)];
  return { method: method?.toUpperCase() ?? null, path, ms: Number(d.slice(eq + 1)) || 0 };
});
const file = [resolve(process.cwd(), opt.scenario), resolve(here, opt.scenario)].find((f) => existsSync(f));
if (!file) throw new Error(`scenario not found: ${opt.scenario}`);
const m = await import(pathToFileURL(file).href);
const sc = m.default && typeof m.default === "object" ? { ...m.default, ...m } : { ...m };
const url = sc.url ? new URL(sc.url, opt.url).href : opt.url;
const storageState = opt["storage-state"] ? resolve(process.cwd(), opt["storage-state"]) : undefined;

const browser = await chromium.launch({ headless: !opt.headful });
const results = [];
for (let i = 0; i < runs; i++) {
  const withDelays = i > 0;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, ...(storageState ? { storageState } : {}) });
  const delayed = [];
  if (withDelays && delays.length)
    await ctx.route("**/*", async (route, request) => {
      const u = new URL(request.url());
      const hit = delays.find((d) => (!d.method || d.method === request.method()) && (d.path.startsWith("/") ? u.pathname.startsWith(d.path) : request.url().includes(d.path)));
      if (!hit) return route.continue();
      // fetch now, hand the response to the page later: the request's own timing is unchanged, only its delivery
      const response = await route.fetch();
      const body = await response.body();
      await new Promise((r) => setTimeout(r, hit.ms));
      delayed.push(`${request.method()} ${u.pathname} +${hit.ms} ms`);
      await route.fulfill({ response, body });
    });
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  let oracle;
  let error = null;
  let stepsError = null;
  let pageText;
  try {
    await page.goto(url, { timeout });
    try {
      await sc.steps(page, { params, url, log: (s) => console.error(`[plain] ${s}`), phase: withDelays ? "delayed" : "reference" });
    } catch (e) {
      stepsError = String(e.message).split("\n")[0]; // the page did not offer what the steps needed: record what it showed
    }
    await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
    await page.waitForTimeout(Number(opt.settle ?? sc.settleMs ?? 400) + Math.max(0, ...delays.map((d) => d.ms)));
    const bodyLines = () => page.evaluate(() => document.body.innerText.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 200));
    oracle = sc.oracle ? await sc.oracle(page, { params, url }).catch(() => undefined) : await bodyLines();
    if (stepsError) pageText = await bodyLines().catch(() => undefined);
  } catch (e) {
    error = String(e.message).split("\n")[0];
  } finally {
    await ctx.close();
  }
  results.push({ run: i + 1, delays: withDelays ? delayed : [], oracle, error, stepsError, pageText, errors });
}
await browser.close();
const ref = JSON.stringify(results[0].oracle);
for (const r of results) {
  const same = JSON.stringify(r.oracle) === ref;
  console.log(`\n== run ${r.run} (${r.run === 1 ? "reference, no delay" : `delayed: ${r.delays.join(", ") || "nothing matched the --delay patterns"}`}): ${r.error ? `error ${r.error}` : r.run === 1 ? "" : same ? "SAME end state as the reference" : "DIFFERENT end state from the reference"}`);
  if (r.stepsError) console.log(`the steps could not be done: ${r.stepsError}\npage text at the end:\n${JSON.stringify(r.pageText, null, 2)?.slice(0, 3000)}`);
  if (r.errors.length) console.log(`page errors: ${r.errors.join(" | ")}`);
  console.log(JSON.stringify(r.oracle, null, 2)?.slice(0, 4000));
}
const differ = results.slice(1).filter((r) => !r.error && JSON.stringify(r.oracle) !== ref).length;
console.log(`\n${differ} of ${results.length - 1} delayed run(s) ended differently from the reference, with no GenClass on the page.`);
