// Does installing GenClass fix the shop's planted bugs at the user's end? A copy of demo-site/tiny-shop-before gets
// the demo's integration (what the dashboard's prompt and the second demo prompt produce: GenClass.init in guard
// with the visual fixes and the eager profile, the search state as one atom, the rest of the store guarded), runs on
// the dev server, and a
// headless Chromium plays the five bugs in observe (they must show) and in guard (they must not):
//   1 stale search response   2 double add-to-cart   3 white text on white   4 click block never released
//   5 scroll lock the cookie notice leaves behind
// Usage: node demo-site/record/verify-fixes.mjs [--keep] [--src <dir>]  (--src: an already integrated shop, e.g. after
// the agent's fixes; the bugs are then expected fixed in observe too)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const args = process.argv.slice(2);
const SRC = args.includes("--src") ? args[args.indexOf("--src") + 1] : join(ROOT, "demo-site", "tiny-shop-before");
const integrated = args.includes("--src");
const WORK = join(REC, "out", "verify-shop");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------------------------------------------- the shop, integrated
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
sh(`rsync -a --exclude node_modules --exclude .vercel --exclude .genclass --exclude dist "${SRC}/" "${WORK}/"`);
if (!integrated) {
  const pkg = JSON.parse(readFileSync(join(WORK, "package.json"), "utf8"));
  // LOCAL_RUNTIME=1: the checkout's own build (packages/runtime, built first) instead of npm's beta
  pkg.dependencies = { ...(pkg.dependencies ?? {}), "@genclass/runtime": process.env.LOCAL_RUNTIME ? `file:${join(ROOT, "packages", "runtime")}` : "beta" };
  writeFileSync(join(WORK, "package.json"), JSON.stringify(pkg, null, 2));
  let vc = readFileSync(join(WORK, "vite.config.js"), "utf8");
  if (!/worker:/.test(vc)) vc = vc.replace("defineConfig({", 'defineConfig({\n  worker: { format: "es" },');
  writeFileSync(join(WORK, "vite.config.js"), vc);
  writeFileSync(join(WORK, "src", "genclass.js"), `import { GenClass } from "@genclass/runtime";
export const rt = GenClass.init({ token: "gc_verify_only", telemetry: false, mode: globalThis.__GC_MODE__ ?? "guard", aggressiveness: "eager", visual: { on: true, fix: true } });
globalThis.__rt = rt;
`);
  let main = readFileSync(join(WORK, "src", "main.js"), "utf8");
  main = main.replace('import { store } from "./store.js";', 'import { rt } from "./genclass.js";\nimport { store } from "./store.js";\nconst search = rt.atom("search", { query: "", results: [] });');
  main = main.replace(/\$\("#q"\)\.addEventListener\("input", async \(e\) => \{[\s\S]*?\n\}\);\nstore\.subscribe\("search\.results", \(results\) => \{/, `$("#q").addEventListener("input", async (e) => {
  const q = e.target.value;
  const r = await fetch(\`/api/search?q=\${encodeURIComponent(q)}\`);
  const data = await r.json();
  search.set((s) => ({ ...s, results: data.results, query: data.q }));
});
search.subscribe(({ results }) => {`);
  if (!main.includes("search.subscribe")) throw new Error("the search handler did not match; the integration patch needs updating");
  writeFileSync(join(WORK, "src", "main.js"), main);
  let st = readFileSync(join(WORK, "src", "store.js"), "utf8");
  st = st.replace("export const store = {", `import { rt } from "./genclass.js";
const handles = Object.fromEntries(Object.keys(state).filter((k) => !k.startsWith("search.")).map((k) => [k, rt.guard(k, { get: () => state[k], set: (v) => { state[k] = v; notify(k, v); } })]));
export const store = {`).replace("set(k, v) {", "set(k, v) { if (handles[k]) return handles[k].set(v);");
  if (!st.includes("handles[k]")) throw new Error("the store did not match; the integration patch needs updating");
  writeFileSync(join(WORK, "src", "store.js"), st);
}
// the mode comes from the URL for the test pages: a tiny inline switch before the app script
let html = readFileSync(join(WORK, "index.html"), "utf8");
html = html.replace("<head>", '<head>\n    <script>globalThis.__GC_MODE__ = new URLSearchParams(location.search).get("mode") || "guard";</script>');
writeFileSync(join(WORK, "index.html"), html);
console.log("installing…");
const inst = sh("npm install --no-audit --no-fund 2>&1 | tail -1", WORK);
if (inst.status !== 0) throw new Error("npm install failed: " + inst.stderr);
for (const p of [5173, 8788]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
await sleep(500);
const dev = spawn(process.execPath, ["dev.mjs"], { cwd: WORK, stdio: "ignore" });
const waitHttp = async (url, ms = 40000) => { const s = Date.now(); while (Date.now() - s < ms) { try { if ((await fetch(url)).status < 500) return true; } catch {} await sleep(300); } return false; };
if (!(await waitHttp("http://localhost:5173/")) || !(await waitHttp("http://localhost:5173/api/search?q=r"))) throw new Error("the dev server did not come up");

// ---------------------------------------------------------------------------------------------------- the five bugs, per mode
const browser = await chromium.launch({ headless: true });
const run = async (mode) => {
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const cartPosts = [];
  page.on("request", (r) => { if (r.url().includes("/api/cart")) cartPosts.push(r.postData()); });
  await page.goto(`http://localhost:5173/?mode=${mode}`, { waitUntil: "domcontentloaded" });
  // the model: wait until the runtime says it is ready (at most 25 s), else go on and say so
  let model = "unknown";
  for (let i = 0; i < 50; i++) {
    const st = await page.evaluate(() => { const r = globalThis.__rt; const s = r?.status?.() ?? r?.state?.() ?? null; return s ? JSON.stringify(s).slice(0, 400) : (r ? "runtime, no status()" : "no runtime"); }).catch(() => "evaluate failed");
    if (/ready|loaded|"model":"on"/i.test(st)) { model = "ready"; break; }
    if (i === 49) model = st;
    await sleep(500);
  }
  const out = { mode, model };
  // 1 the stale search
  await page.click("#q");
  for (const ch of "react") { await page.type("#q", ch); await sleep(60); }
  await sleep(3200);
  out.searchResults = await page.locator("#results li").count();
  // 2 the double add-to-cart
  // a person's double click: two clicks 100 ms apart, with no wait for the button to be enabled in between (a fix may
  // disable it)
  const add = await page.locator('button.add[data-item="Retro keyboard"]').boundingBox();
  await page.mouse.click(add.x + add.width / 2, add.y + add.height / 2);
  await sleep(100);
  await page.mouse.click(add.x + add.width / 2, add.y + add.height / 2);
  await sleep(1500);
  out.cartPosts = cartPosts.length;
  out.cartCount = (await page.textContent("#cartcount"))?.trim();
  // 3 the banner's text
  out.bannerColor = await page.evaluate(() => getComputedStyle(document.querySelector(".banner")).color);
  // 5 the scroll lock after the cookie notice (a JS click: the control itself is fine, the lock is the bug)
  await page.evaluate(() => document.querySelector("#ok").click());
  await sleep(300);
  await page.mouse.move(380, 450);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await sleep(600); }
  await sleep(2500);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 300); await sleep(300); }
  await sleep(500);
  out.bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflowY);
  out.scrollY = await page.evaluate(() => Math.round(window.scrollY));
  out.bannerAfterScroll = await page.evaluate(() => getComputedStyle(document.querySelector(".banner")).color);
  // 4 the click block after "Load reviews" (last: in observe the page is dead afterwards)
  await page.click("#reviews", { timeout: 5000 }).catch(() => page.evaluate(() => document.querySelector("#reviews").click()));
  await sleep(1500);
  out.bannerDuringReviews = await page.evaluate(() => getComputedStyle(document.querySelector(".banner")).color);
  await sleep(7500); // the reviews answer after 3.5 s; the leak counts from then (a busy shield while a request runs is intended)
  out.bodyPointerEvents = await page.evaluate(() => getComputedStyle(document.body).pointerEvents);
  out.bannerColorEnd = await page.evaluate(() => getComputedStyle(document.querySelector(".banner")).color);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(6000);
  out.bannerColorBackAtTop = await page.evaluate(() => getComputedStyle(document.querySelector(".banner")).color);
  // what GenClass recorded
  const rec = await page.evaluate(() => {
    const r = globalThis.__rt;
    const iv = (r?.interventions?.() ?? []).map((a) => ({ changed: String(a.changed ?? "").slice(0, 120), action: a.action ?? a.kind ?? "?" }));
    const ch = (r?.checks?.() ?? []).map((c) => ({ kind: c.kind, fixed: !!c.fix?.applied, reason: c.fix?.reason ?? "" }));
    return { interventions: iv, checks: ch };
  }).catch((e) => ({ error: String(e) }));
  out.interventions = rec.interventions;
  out.checks = rec.checks;
  await page.close();
  return out;
};
const results = [];
for (const mode of ["observe", "guard"]) results.push(await run(mode));
await browser.close();
dev.kill();
for (const p of [5173, 8788]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
if (!args.includes("--keep")) rmSync(WORK, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------- the verdicts
const white = (c) => /rgb\(255,\s*255,\s*255\)/.test(c);
const verdict = (o) => ({
  "1 stale search (right list = 2 results)": o.searchResults === 2,
  "2 double add-to-cart (one request)": o.cartPosts === 1,
  "3 banner text readable (and still at the end)": !white(o.bannerColor) && !white(o.bannerColorEnd),
  "4 clicks work after Load reviews": o.bodyPointerEvents !== "none",
  "5 page scrolls after the cookie OK": o.bodyOverflow !== "hidden" && o.scrollY > 0,
});
for (const o of results) {
  console.log(`\n== ${o.mode} (model: ${o.model})`);
  const v = verdict(o);
  for (const [k, ok] of Object.entries(v)) console.log(`  ${ok ? "fixed  " : "BROKEN "} ${k}`);
  console.log("  raw:", JSON.stringify({ searchResults: o.searchResults, cartPosts: o.cartPosts, cartCount: o.cartCount, bannerColor: o.bannerColor, bannerAfterScroll: o.bannerAfterScroll, bannerDuringReviews: o.bannerDuringReviews, bannerColorEnd: o.bannerColorEnd, bannerColorBackAtTop: o.bannerColorBackAtTop, bodyPointerEvents: o.bodyPointerEvents, bodyOverflow: o.bodyOverflow, scrollY: o.scrollY }));
  console.log("  interventions:", JSON.stringify(o.interventions));
  console.log("  checks:", JSON.stringify(o.checks));
}
const guard = results.find((r) => r.mode === "guard");
const observe = results.find((r) => r.mode === "observe");
const expectBroken = !integrated;
const brokenInObserve = Object.values(verdict(observe)).filter((x) => !x).length;
const fixedInGuard = Object.values(verdict(guard)).filter((x) => x).length;
console.log(`\n${expectBroken ? `observe: ${brokenInObserve}/5 bugs show; ` : `observe (fixed code): ${5 - brokenInObserve}/5 fixed; `}guard: ${fixedInGuard}/5 fixed at the user's end`);
process.exit(fixedInGuard === 5 && (expectBroken ? brokenInObserve === 5 : brokenInObserve === 0) ? 0 : 1);
