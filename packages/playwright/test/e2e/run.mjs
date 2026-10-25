// End-to-end: the fixture on a real page in headless Chromium (playwright-reporter.yml runs it after building
// @genclass/runtime and this package). It runs Playwright with ./playwright.config.ts (the search page of server.mjs,
// the fixture with seeded chaos, five seeds per test, this package's reporter), then checks what was written:
//   - the buggy page: a `witness|overwrote-newer|GET /api/search` signature in at least one of the five seeds (the
//     count is printed: a race shows under some orders, not all);
//   - the buggy page with `reorder: false` (latency only, responses keep their order): no signature in any seed,
//     since nothing overtakes;
//   - the fixed page: no signature at all in any of the five seeds (the false-report count on the correct variant);
//   - every file validates as genclass-races/1 and carries the seed and the chaos settings;
//   - genclass-report.md names the buggy test under the witness group and lists the fixed test under "nothing
//     flagged"; the command renders the same report from the same files.
// Exit code 0 when all hold; the summary is printed as JSON.
//
//   npm run build -w @genclass/runtime && npm run build -w @genclass/playwright
//   node packages/playwright/test/e2e/run.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRaces, summarize } from "../../dist/summarize.js";

const here = dirname(fileURLToPath(import.meta.url));
const racesDir = join(here, "test-results", "genclass");
const reportPath = join(here, "genclass-report.md");
const summary = {};
const fail = (msg) => {
  summary.failed = msg;
  console.log(JSON.stringify(summary, null, 2));
  process.exit(1);
};

for (const p of [join(here, "test-results"), reportPath]) rmSync(p, { recursive: true, force: true });
if (!existsSync(resolve(here, "../../../runtime/dist/genclass.global.js"))) fail("build @genclass/runtime first");
if (!existsSync(resolve(here, "../../dist/fixture.js"))) fail("build @genclass/playwright first");

const cli = resolve(here, "../../../../node_modules/@playwright/test/cli.js");
const run = spawnSync(process.execPath, [cli, "test", "--config", join(here, "playwright.config.ts")], { cwd: here, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
const out = `${run.stdout}${run.stderr}`;
console.log(out.slice(-4000));
summary.playwrightStatus = run.status;
if (run.status !== 0) fail("the Playwright run failed");

// the files
const names = existsSync(racesDir) ? readdirSync(racesDir).filter((n) => n.endsWith(".json")).sort() : [];
summary.files = names.length;
if (names.length !== 15) fail(`expected 15 race files (3 tests × 5 seeds), found ${names.length}`);
const files = [];
for (const n of names) {
  const r = parseRaces(readFileSync(join(racesDir, n), "utf8"));
  if (!r.ok) fail(`${n} does not validate: ${r.errors.join("; ")}`);
  files.push({ name: n, file: r.file });
}
const buggy = files.filter((f) => f.file.test.includes("buggy page: results"));
const fifo = files.filter((f) => f.file.test.includes("buggy page, latency only"));
const fixed = files.filter((f) => f.file.test.includes("fixed page"));
if (buggy.length !== 5 || fifo.length !== 5 || fixed.length !== 5) fail(`expected 5 files per test, found buggy ${buggy.length}, latency-only ${fifo.length}, fixed ${fixed.length}`);
const seedsOf = (list) => list.map((f) => f.file.seed).sort((a, b) => a - b);
summary.seeds = { buggy: seedsOf(buggy), latencyOnly: seedsOf(fifo), fixed: seedsOf(fixed) };
for (const s of Object.values(summary.seeds)) if (s.join() !== "1,2,3,4,5") fail("expected seeds 1 to 5 for each test");
for (const f of files) {
  const reorder = !fifo.includes(f);
  if (!f.file.chaos || !f.file.chaos.latencyMs || f.file.chaos.latencyMs[0] !== 0 || f.file.chaos.latencyMs[1] !== 600 || f.file.chaos.reorder !== reorder) fail(`${f.name}: chaos settings missing or wrong: ${JSON.stringify(f.file.chaos)}`);
  if (f.file.mode !== "observe") fail(`${f.name}: mode ${f.file.mode}, expected observe`);
  if (!f.file.model || f.file.model.state !== "off") fail(`${f.name}: model ${JSON.stringify(f.file.model)}, expected state "off" (model skipped)`);
}
const SIG = "witness|overwrote-newer|GET /api/search";
const stale = (f) => f.file.signatures.some((s) => s.sig === SIG);
const sigs = (list) => list.flatMap((f) => f.file.signatures.map((s) => `seed ${f.file.seed}: ${s.sig}`));
summary.buggy = { staleSeeds: buggy.filter(stale).map((f) => f.file.seed), otherSignatures: sigs(buggy).filter((s) => !s.endsWith(SIG)), evidence: buggy.filter(stale).map((f) => f.file.signatures.find((s) => s.sig === SIG).evidence) };
summary.latencyOnly = { signatures: sigs(fifo) };
summary.fixed = { signatures: sigs(fixed) };
if (summary.buggy.staleSeeds.length === 0) fail("no overwrote-newer witness on the buggy page in any seed");
if (summary.latencyOnly.signatures.length !== 0) fail(`signatures on the buggy page with reorder off (latency keeps the order, so nothing should overtake): ${summary.latencyOnly.signatures.join(", ")}`);
if (summary.fixed.signatures.length !== 0) fail(`signatures on the fixed page (false reports): ${summary.fixed.signatures.join(", ")}`);

// the report
if (!existsSync(reportPath)) fail("the reporter wrote no genclass-report.md");
const report = readFileSync(reportPath, "utf8");
const expected = summarize(names.map((n) => ({ name: `test-results/genclass/${n}`, content: readFileSync(join(racesDir, n), "utf8") })), { sources: ["test-results/genclass"] });
if (report !== expected) fail("genclass-report.md differs from the command's rendering of the same files");
if (!report.includes("| Witnesses (facts measured without the model) |")) fail("the report has no witness row");
if (!report.includes("search.spec.ts > search > buggy page: results of the last query")) fail("the report does not name the buggy test");
if (!/`GET \/api\/search` · `witness:overwrote-newer`/.test(report)) fail("the report has no overwrote-newer line for GET /api/search");
if (!report.includes("2 tests with nothing flagged") || !report.includes("fixed page: results of the last query (5 seeds: 1, 2, 3, 4, 5)")) fail("the report does not list the fixed test under nothing flagged");
if (report.includes("model was not ready")) fail("the report notes a model that was not ready (the model was off by choice)");
summary.reportFirstLines = report.split("\n").slice(0, 4);
summary.ok = true;
console.log(JSON.stringify(summary, null, 2));
