// The snow day site's five planted bugs, at the user's end: a copy of demo-site/snowday-before gets the script-tag
// integration (the checkout's own build of the runtime, guard with the visual fixes and the eager profile, the board
// search as one atom, the rest of the store guarded), runs on `wrangler pages dev` with its functions, and a headless Chromium plays the
// five bugs in observe (they must show) and in guard (they must not):
//   1 stale board search (the first letter's answer lands last)     2 double Subscribe   3 white text on white
//   4 click block "Load road conditions" never releases             5 scroll lock the notice leaves behind
// Usage: node demo-site/record/verify-snowday.mjs [--keep] [--src <dir>]  (--src: an already integrated copy, e.g.
// after the agent's fixes; the bugs are then expected fixed in observe too). Build the runtime first.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const args = process.argv.slice(2);
const SRC = args.includes("--src") ? args[args.indexOf("--src") + 1] : join(ROOT, "demo-site", "snowday-before");
const integrated = args.includes("--src");
const WORK = join(REC, "out", "verify-snowday");
const PORT = 8788;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------------------------------------------- the site, integrated
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
sh(`rsync -a --exclude node_modules --exclude .wrangler "${SRC}/" "${WORK}/"`);
let html = readFileSync(join(WORK, "index.html"), "utf8");
if (!integrated) {
  // the whole dist: the script-tag build loads its worker, model and visual chunks relative to its own URL
  sh(`rsync -a "${join(ROOT, "packages", "runtime", "dist")}/" "${join(WORK, "genclass-dist")}/"`);
  html = html.replace("<head>", `<head>
    <script>window.GENCLASS_CONFIG = { token: "gc_verify_only", telemetry: false, mode: new URLSearchParams(location.search).get("mode") || "guard", aggressiveness: "eager", visual: { on: true, fix: true } };</script>
    <script src="/genclass-dist/genclass.global.js"></script>`);
  // the board search as one atom (the README's one line), the rest of the store guarded
  html = html.replace(`        document.getElementById('board-q').addEventListener('input', async function (e) {
            const q = e.target.value;
            const response = await fetch('/api/boards?q=' + encodeURIComponent(q));
            const data = await response.json();
            store.set('boards.results', data.results);
            store.set('boards.query', data.q);
        });
        store.subscribe('boards.results', function (results) {`, `        const boards = GenClass.runtime.atom('boards', { query: '', results: [] });
        const guarded = Object.fromEntries(store.keys().filter((k) => !k.startsWith('boards.')).map((k) => [k, GenClass.runtime.guard(k, { get: () => store.get(k), set: (v) => store.set(k, v) })]));
        document.getElementById('board-q').addEventListener('input', async function (e) {
            const q = e.target.value;
            const response = await fetch('/api/boards?q=' + encodeURIComponent(q));
            const data = await response.json();
            boards.set((s) => ({ ...s, results: data.results, query: data.q }));
        });
        boards.subscribe(function ({ results }) {`).replace("store.set('alerts.count', data.count);", "guarded['alerts.count'].set(data.count);");
  if (!html.includes("GenClass.runtime.atom('boards'")) throw new Error("the board search did not match");
}
writeFileSync(join(WORK, "index.html"), html);
sh(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
await sleep(500);
const dev = spawn("npx", ["--yes", "wrangler@4", "pages", "dev", ".", "--port", String(PORT), "--compatibility-date=2026-01-01"], { cwd: WORK, stdio: "ignore", detached: true });
const waitHttp = async (url, ms = 60000) => { const s = Date.now(); while (Date.now() - s < ms) { try { if ((await fetch(url)).status < 500) return true; } catch {} await sleep(400); } return false; };
if (!(await waitHttp(`http://localhost:${PORT}/`))) throw new Error("wrangler pages dev did not come up");
const stop = () => { try { process.kill(-dev.pid); } catch {} dev.kill(); sh(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`); };

// ---------------------------------------------------------------------------------------------------- the five bugs, per mode
const browser = await chromium.launch({ headless: true });
const typePostal = async (page, code) => { await page.fill("#postal-code", ""); await page.click("#postal-code"); for (const ch of code) { await page.type("#postal-code", ch); await sleep(40); } };
const run = async (mode) => {
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const posts = [];
  page.on("request", (r) => { if (r.url().includes("/api/alerts")) posts.push(r.postData()); });
  await page.goto(`http://localhost:${PORT}/?mode=${mode}`, { waitUntil: "domcontentloaded" });
  await sleep(10000);
  const out = { mode };
  // 1 the stale board search: type "halton" fast; the one-letter answer lands last
  await page.click("#board-q");
  for (const ch of "halton") { await page.type("#board-q", ch); await sleep(60); }
  await sleep(3000);
  out.boardResults = await page.locator("#board-results li").count();
  // 2 the double Subscribe: two clicks 100 ms apart
  await page.evaluate(() => document.querySelector("#alert-btn").scrollIntoView({ block: "center" })); // the page is scroll-locked: a programmatic scroll still works
  await sleep(300);
  const sub = await page.locator("#alert-btn").boundingBox();
  await page.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
  await sleep(100);
  await page.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
  await sleep(1500);
  out.alertPosts = posts.length;
  out.alertCount = (await page.textContent("#alert-count"))?.trim();
  // 3 the alert bar
  out.alertColor = await page.evaluate(() => getComputedStyle(document.querySelector(".alert-bar")).color);
  // 5 the scroll lock after the notice (a JS click: the control is fine, the lock is the bug)
  await page.evaluate(() => { document.querySelector("#notice-ok").click(); window.scrollTo(0, 0); });
  await sleep(300);
  await page.mouse.move(380, 450);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await sleep(600); }
  await sleep(2500);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 300); await sleep(300); }
  await sleep(500);
  out.bodyOverflow = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY + "/" + getComputedStyle(document.body).overflowY);
  out.scrollY = await page.evaluate(() => Math.round(window.scrollY));
  // 4 the click block after "Load road conditions" (last: in observe the page is dead afterwards)
  await page.evaluate(() => document.querySelector("#roads-btn").scrollIntoView({ block: "center" }));
  await sleep(300);
  await page.click("#roads-btn", { timeout: 5000 }).catch(() => page.evaluate(() => document.querySelector("#roads-btn").click()));
  await sleep(9000);
  out.bodyPointerEvents = await page.evaluate(() => getComputedStyle(document.body).pointerEvents);
  out.alertColorEnd = await page.evaluate(() => getComputedStyle(document.querySelector(".alert-bar")).color);
  const rec = await page.evaluate(() => {
    const r = globalThis.GenClass?.runtime;
    return { interventions: (r?.interventions?.() ?? []).map((a) => ({ action: a.action ?? "?", changed: String(a.changed ?? "").slice(0, 110) })), checks: (r?.checks?.() ?? []).map((c) => ({ kind: c.kind, fixed: !!c.fix?.applied })) };
  }).catch((e) => ({ error: String(e) }));
  out.interventions = rec.interventions; out.checks = rec.checks;
  out.visual = await page.evaluate(() => { const v = GenClass.runtime.summary()?.visual; return v ? { abstained: v.abstained, checks: v.checks } : null; }).catch(() => null);
  out.decisions = await page.evaluate(() => (GenClass.runtime.audit() ?? []).filter((e) => e.kind === "decision").map((e) => `${e.trigger} ${String(e.subject ?? "").slice(0, 50)} -> ${e.decision?.diagnosis ?? e.diagnosis ?? "?"} ${e.action ?? ""} ${e.reason ?? ""}`.slice(0, 200))).catch(() => []);
  await page.close();
  return out;
};
const results = [];
for (const mode of ["observe", "guard"]) results.push(await run(mode));
await browser.close();
stop();
if (!args.includes("--keep")) rmSync(WORK, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------- the verdicts
const white = (c) => /rgb\(255,\s*255,\s*255\)/.test(c);
const verdict = (o) => ({
  "1 stale board search (2 Halton boards, not 5 for 'h')": o.boardResults === 2,
  "2 double Subscribe (one request)": o.alertPosts === 1,
  "3 alert bar readable (and still at the end)": !white(o.alertColor) && !white(o.alertColorEnd),
  "4 clicks work after Load road conditions": o.bodyPointerEvents !== "none",
  "5 page scrolls after the notice's OK": !/hidden/.test(o.bodyOverflow) && o.scrollY > 0,
});
for (const o of results) {
  console.log(`\n== ${o.mode}`);
  for (const [k, ok] of Object.entries(verdict(o))) console.log(`  ${ok ? "fixed  " : "BROKEN "} ${k}`);
  console.log("  raw:", JSON.stringify({ boardResults: o.boardResults, alertPosts: o.alertPosts, alertCount: o.alertCount, alertColor: o.alertColor, alertColorEnd: o.alertColorEnd, bodyPointerEvents: o.bodyPointerEvents, bodyOverflow: o.bodyOverflow, scrollY: o.scrollY }));
  console.log("  interventions:", JSON.stringify(o.interventions));
  console.log("  checks:", JSON.stringify(o.checks));
  console.log("  visual:", JSON.stringify(o.visual));
  console.log("  decisions:", JSON.stringify(o.decisions));
}
const guard = results.find((r) => r.mode === "guard"), observe = results.find((r) => r.mode === "observe");
const brokenInObserve = Object.values(verdict(observe)).filter((x) => !x).length;
const fixedInGuard = Object.values(verdict(guard)).filter((x) => x).length;
// the double Subscribe: on this page the model's gain for coalescing stays under the eager margin (about 2.3 of 3 at
// human click gaps), so guard flags the duplicate and sends both; the agent fixes it in code
const flagged = (guard.decisions ?? []).some((d) => /alerts.*duplicate/.test(d));
console.log(`\n${integrated ? `observe (fixed code): ${5 - brokenInObserve}/5 fixed; ` : `observe: ${brokenInObserve}/5 bugs show; `}guard: ${fixedInGuard}/5 fixed at the user's end${flagged && !verdict(guard)["2 double Subscribe (one request)"] ? " (the double Subscribe flagged as a duplicate, not merged)" : ""}`);
const runtimeOk = integrated ? brokenInObserve === 0 && fixedInGuard === 5 : brokenInObserve === 5 && fixedInGuard >= 4 && (fixedInGuard === 5 || flagged);
process.exit(runtimeOk ? 0 : 1);
