#!/usr/bin/env node
// The reproduction step of "Using a result publicly" (README): the same scenario with NO GenClass on the page, and the
// responses a finding names slowed down with plain Playwright routing. A race GenClass found should show the same
// wrong end state here, with nothing of GenClass involved; if it does not, say so before anyone reads the report.
//
//   node bench/hunt/plain.mjs --url <page> --scenario scenarios/x.mjs [--param k=v] [--storage-state file]
//     --delay 'GET /api/search#4=1500' [--delay ...] [--runs 4] [--timeout 30000] [--settle 400] [--headful]
//
// A --delay is `<what>=<ms>`: the extra time before that response is handed to the page (the request itself goes to
// the server at once; only its delivery waits). <what> is one of
//   METHOD /path-prefix        every matching request
//   METHOD /path-prefix#N      only the N-th matching request of the page load (GenClass's request keys count the same
//                              way: "GET /api/search#4" in a finding's delivery order is the 4th search request)
//   /regular expression/       requests whose "METHOD URL" matches
//   text                       requests whose URL contains it
// The first two runs have no delay: they are the reference, and when they disagree the page's end state is noisy and
// no run can be read as reproduced. The other runs have the delays. Each run's oracle is printed, then the verdict.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { paramsOf } from "./lib/args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = `node bench/hunt/plain.mjs --url <page> --scenario <file> --delay '<what>=<ms>' [--delay ...] [--param k=v] [--storage-state <file>] [--runs n] [--timeout ms] [--settle ms] [--headful]`;
const KNOWN = { url: "string", scenario: "string", delay: "list", param: "list", "storage-state": "string", runs: "number", timeout: "number", settle: "number", headful: "boolean", help: "boolean" };
const opt = { delay: [], param: [] };
const errors = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    errors.push(`unexpected argument ${a}`);
    continue;
  }
  let k = a.slice(2);
  let v;
  const eq = k.indexOf("=");
  if (eq >= 0) {
    v = k.slice(eq + 1);
    k = k.slice(0, eq);
  }
  const kind = KNOWN[k];
  if (!kind) {
    errors.push(`unknown option --${k}`);
    continue;
  }
  if (kind === "boolean") {
    opt[k] = true;
    continue;
  }
  if (v === undefined) v = argv[++i];
  if (v === undefined) {
    errors.push(`--${k} needs a value`);
    continue;
  }
  if (kind === "list") opt[k].push(v);
  else if (kind === "number") {
    if (!Number.isFinite(Number(v))) errors.push(`--${k} needs a number, got ${v}`);
    else opt[k] = Number(v);
  } else opt[k] = v;
}
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!opt.url) errors.push("--url is required");
if (!opt.scenario) errors.push("--scenario is required");
if (!opt.delay.length) errors.push("--delay is required (at least one)");

const delays = opt.delay.map((d) => {
  const eq = d.lastIndexOf("=");
  const ms = Number(d.slice(eq + 1));
  const what = eq > 0 ? d.slice(0, eq) : "";
  if (eq <= 0 || !Number.isFinite(ms) || ms < 0) {
    errors.push(`--delay ${d}: expected <what>=<ms>`);
    return null;
  }
  const re = /^\/(.+)\/([a-z]*)$/.exec(what);
  if (re) return { what, ms, regex: new RegExp(re[1], re[2]) };
  const m = /^([A-Za-z]+) (\S+?)(?:#(\d+))?$/.exec(what);
  if (m) return { what, ms, method: m[1].toUpperCase(), path: m[2], nth: m[3] ? Number(m[3]) : null };
  return { what, ms, text: what };
});
if (errors.length) {
  console.error(errors.map((e) => `error: ${e}`).join("\n"));
  console.error(USAGE);
  process.exit(1);
}

const timeout = opt.timeout ?? 30_000;
const runs = Math.max(3, opt.runs ?? 4);
const params = paramsOf(opt.param);
const file = [resolve(process.cwd(), opt.scenario), resolve(here, opt.scenario)].find((f) => existsSync(f));
if (!file) {
  console.error(`error: scenario not found: ${opt.scenario}`);
  process.exit(1);
}
const m = await import(pathToFileURL(file).href);
const sc = m.default && typeof m.default === "object" ? { ...m.default, ...m } : { ...m };
const url = sc.url ? new URL(sc.url, opt.url).href : opt.url;
const storageState = opt["storage-state"] ? resolve(process.cwd(), opt["storage-state"]) : undefined;
const settle = Number(opt.settle ?? sc.settleMs ?? 400);

const browser = await chromium.launch({ headless: !opt.headful });
const results = [];
for (let i = 0; i < runs; i++) {
  const reference = i < 2;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, ...(storageState ? { storageState } : {}) });
  const delayed = [];
  if (!reference) {
    const seen = new Map();
    await ctx.route("**/*", async (route, request) => {
      const u = new URL(request.url());
      const hit = delays.find((d) => {
        if (d.regex) return d.regex.test(`${request.method()} ${request.url()}`);
        if (d.text) return request.url().includes(d.text);
        if (d.method !== request.method() || !u.pathname.startsWith(d.path)) return false;
        const n = (seen.get(d) ?? 0) + 1;
        seen.set(d, n);
        return d.nth === null || d.nth === n;
      });
      if (!hit) return route.continue();
      // fetch now, hand the response to the page later: the request reaches the server at its own time
      const response = await route.fetch({ timeout: timeout + hit.ms });
      const body = await response.body();
      await new Promise((r) => setTimeout(r, hit.ms));
      delayed.push(`${request.method()} ${u.pathname}${u.search} +${hit.ms} ms`);
      await route.fulfill({ response, body }).catch(() => undefined);
    });
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeout);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 200)));
  let oracle;
  let error = null;
  let stepsError = null;
  let pageText;
  try {
    await page.goto(url, { timeout });
    await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
    try {
      await sc.steps(page, { params, url, log: (s) => console.error(`[plain] ${s}`), phase: reference ? "reference" : "delayed" });
    } catch (e) {
      stepsError = String(e.message).split("\n")[0]; // the page did not offer what the steps needed: record what it showed
    }
    await page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
    await page.waitForTimeout(settle + (reference ? 0 : Math.max(0, ...delays.map((d) => d.ms))));
    const bodyLines = () => page.evaluate(() => document.body.innerText.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 200));
    oracle = sc.oracle ? await sc.oracle(page, { params, url }).catch((e) => ({ oracleError: String(e.message).split("\n")[0] })) : await bodyLines();
    if (stepsError) pageText = await bodyLines().catch(() => undefined);
  } catch (e) {
    error = String(e.message).split("\n")[0];
  } finally {
    await ctx.close();
  }
  results.push({ run: i + 1, reference, delays: delayed, oracle, error, stepsError, pageText, pageErrors });
}
await browser.close();

const canon = (v) => JSON.stringify(v);
const [r1, r2] = results;
const noisy = canon(r1.oracle) !== canon(r2.oracle);
for (const r of results) {
  const label = r.reference ? "reference, no delay" : `delayed: ${r.delays.join(", ") || "nothing matched the --delay patterns"}`;
  const verdict = r.error ? `error ${r.error}` : r.reference ? "" : r.delays.length === 0 ? "NOTHING DELAYED (check the --delay patterns)" : canon(r.oracle) === canon(r1.oracle) ? "SAME end state as the reference" : "DIFFERENT end state from the reference";
  console.log(`\n== run ${r.run} (${label}): ${verdict}`);
  if (r.stepsError) console.log(`the steps could not be done: ${r.stepsError}\npage text at the end:\n${JSON.stringify(r.pageText, null, 2)?.slice(0, 3000)}`);
  if (r.pageErrors.length) console.log(`page errors: ${r.pageErrors.join(" | ")}`);
  console.log(JSON.stringify(r.oracle, null, 2)?.slice(0, 4000));
}
const delayedRuns = results.filter((r) => !r.reference && !r.error && r.delays.length);
const differ = delayedRuns.filter((r) => canon(r.oracle) !== canon(r1.oracle)).length;
if (noisy) console.log(`\nThe two reference runs ended differently: the end state is noisy without any delay, so no delayed run can be read as reproduced.`);
else console.log(`\n${differ} of ${delayedRuns.length} delayed run(s) ended differently from the two reference runs (which agree), with no GenClass on the page.`);
