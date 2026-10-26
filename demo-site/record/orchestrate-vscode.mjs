// The seamless take, second form: VS Code on the right half of the built-in display (its integrated terminal runs
// out/terminal.command, the demo's Claude Code on Opus; the editor shows the files Claude edits), a real Google Chrome
// window on the left half driven by Playwright with a visible cursor, the person signing in to genclass.dev with
// Google themselves when the page comes up. No zoom, no cuts: the whole display is recorded and the video is only
// ever sped up. Before running: `node demo-site/record/stage.mjs setup`, VS Code open on tiny-shop-before with its
// terminal panel showing "tiny-shop · Claude Code (Opus)", placed on the right half of the built-in display.
//   node demo-site/record/orchestrate-vscode.mjs
// Hand-offs: when the script needs something only a person can do it writes out/signals/need-<what> and waits for
// out/signals/go-<what> (google: the sign-in; main: src/main.js shown in VS Code's editor).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const BEFORE = join(ROOT, "demo-site", "tiny-shop-before");
const OUT = join(REC, "out");
const SIG = join(OUT, "signals");
const PROFILE = join(OUT, "..", ".chrome-profile"); // persistent: the Google session survives a retake (gitignored with out/)
const SCREEN = process.env.DEMO_SCREEN ?? "4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${String(Math.floor((Date.now() - t0) / 60000)).padStart(2, "0")}:${String(Math.floor(((Date.now() - t0) / 1000) % 60)).padStart(2, "0")}`;
const say = (s) => { const line = `[${stamp()}] ${s}`; console.log(line); appendFileSync(join(OUT, "chapters.txt"), line + "\n"); };
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const stage = (...args) => sh(`node "${join(REC, "stage.mjs")}" ${args.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ")}`).stdout;

// the stage is set already (stage.mjs setup); only the take's own files start fresh
for (const f of ["chapters.txt", "demo-raw.mov", ".dashboard-link", "rec.json"]) rmSync(join(OUT, f), { force: true });
for (const f of (existsSync(SIG) ? sh(`ls "${SIG}"`).stdout.split("\n") : [])) if (f && !/^claude-stderr/.test(f)) rmSync(join(SIG, f), { force: true });
mkdirSync(SIG, { recursive: true });
const pids = JSON.parse(readFileSync(join(OUT, "pids.json"), "utf8"));
for (const k of ["dev", "bridge"]) { try { process.kill(pids[k], 0); } catch { throw new Error(`${k} is not running: run stage.mjs setup first`); } }

const handoff = async (what, ms) => {
  writeFileSync(join(SIG, `need-${what}`), "");
  say(`waiting for a person: ${what}`);
  const start = Date.now();
  while (!existsSync(join(SIG, `go-${what}`)) && Date.now() - start < ms) await sleep(1000);
  const ok = existsSync(join(SIG, `go-${what}`));
  say(ok ? `${what}: done` : `${what}: not done in time, going on`);
  return ok;
};
const prompt = async (n, text) => {
  say(`prompt ${n}: ${text.split("\n")[0].slice(0, 80)}`);
  writeFileSync(join(SIG, `prompt-${n}.txt`), text);
  while (!existsSync(join(SIG, `done-${n}`))) await sleep(1000);
  say(`prompt ${n} done`);
  return existsSync(join(SIG, `events-${n}.log`)) ? readFileSync(join(SIG, `events-${n}.log`), "utf8") : "";
};
let rec = null, browser = null;
const fail = async (e) => {
  say(`FAILED: ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
  try { writeFileSync(join(SIG, "stop"), ""); } catch {}
  try { rec?.kill("SIGINT"); await new Promise((r) => rec ? rec.on("exit", r) : r()); } catch {}
  try { await browser?.close(); } catch {}
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

// ---------------------------------------------------------------------------------------------------- the browser: a real Chrome, a visible cursor
browser = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome", headless: false, viewport: null, colorScheme: "light",
  args: ["--window-position=0,30", "--window-size=756,952", "--no-first-run", "--no-default-browser-check"],
  ignoreDefaultArgs: ["--enable-automation"],
});
await browser.addInitScript(() => {
  const mount = () => {
    if (document.getElementById("__cur") || !document.documentElement) return;
    const c = document.createElement("div");
    c.id = "__cur";
    Object.assign(c.style, { position: "fixed", left: "-60px", top: "-60px", width: "26px", height: "26px", border: "3px solid #ff3b30", borderRadius: "50%", background: "rgba(255,59,48,.22)", pointerEvents: "none", zIndex: "2147483647", transform: "translate(-50%,-50%)", transition: "transform .15s", boxShadow: "0 0 0 2px #fff" });
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; c.style.transform = "translate(-50%,-50%) scale(1.9)"; setTimeout(() => (c.style.transform = "translate(-50%,-50%)"), 220); }, true);
  };
  mount();
  document.addEventListener("DOMContentLoaded", mount);
});
const page = browser.pages()[0] ?? (await browser.newPage());
const go = (url) => page.goto(url, { waitUntil: "domcontentloaded" });
const glide = async (loc) => {
  const b = await loc.first().boundingBox();
  if (!b) throw new Error("no box for " + String(loc));
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 });
  await sleep(250);
};
const tap = async (loc) => { await glide(loc); await page.mouse.down(); await sleep(70); await page.mouse.up(); };
const typeSearch = async (text) => {
  await tap(page.locator("#q"));
  await page.fill("#q", "");
  for (const ch of text) { await page.type("#q", ch); await sleep(60); }
};
const overlay = async (tab) => {
  const dt = page.locator("genclass-devtools");
  if ((await dt.count()) === 0) { say(`overlay ${tab}: no overlay on this page`); return; }
  try {
    await tap(dt.locator("text=GenClass").first());
    await sleep(700);
    await tap(dt.locator(`text=${tab}`).first());
  } catch (e) { say(`overlay ${tab}: ${e.message.split("\n")[0]}`); }
};
const closeOverlay = async () => { try { await tap(page.locator("genclass-devtools").locator('[title="Minimize"], button:has-text("−")').first()); } catch {} };
const front = () => sh(`osascript -e 'tell application "Google Chrome" to activate' 2>/dev/null; true`);

// ---------------------------------------------------------------------------------------------------- recording
await go("http://localhost:5173/?genclass=off");
await sleep(1500);
rec = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-pixel_format", "nv12", "-capture_cursor", "1", "-i", `${SCREEN}:none`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(OUT, "demo-raw.mov")], { stdio: "ignore" });
await sleep(1500);
say("recording started");

// ---------------------------------------------------------------------------------------------------- act 1: the shop as it is
say("act 1: the shop as it is");
await sleep(2500);
await typeSearch("react");
await sleep(2500);
await tap(page.locator('button.add[data-item="Retro keyboard"]'));
await sleep(90);
await tap(page.locator('button.add[data-item="Retro keyboard"]'));
await sleep(2500);

// ---------------------------------------------------------------------------------------------------- act 2: sign in with Google, a project, the prompt
say("act 2: genclass.dev, sign in with Google, a new project, the Connect prompt");
await go("https://genclass.dev/login");
await sleep(2500);
await tap(page.locator('a:has-text("Continue with Google")'));
const signedIn = await (async () => {
  const start = Date.now();
  while (Date.now() - start < 300000) {
    if (/genclass\.dev\/account/.test(page.url())) return true;
    await sleep(1000);
  }
  return false;
})();
say(signedIn ? "signed in with Google" : "sign-in did not complete");
await sleep(2500);
await go("https://genclass.dev/account/new");
await sleep(2000);
await tap(page.locator("#appname"));
for (const ch of "tiny-shop") { await page.type("#appname", ch); await sleep(70); }
await sleep(600);
await tap(page.locator("#newgo"));
await page.waitForURL(/\/account\/apps\//, { timeout: 30000 });
const dash = page.url().split("#")[0];
writeFileSync(join(OUT, ".dashboard-page"), dash);
say("project created");
await sleep(4000);
let copied = "";
try {
  const btn = page.locator('#m-connect button:has-text("Copy the prompt for your coding agent")').first();
  await btn.waitFor({ timeout: 10000 });
  await tap(btn);
  copied = (await btn.getAttribute("data-copy")) ?? "";
  await sleep(2500);
} catch (e) { say(`copy button: ${e.message.split("\n")[0]}`); }
if (!copied) {
  const r = await fetch(`${dash}`).then((x) => x.text()).catch(() => "");
  copied = r.includes("Add GenClass") ? "" : "";
}
say(`prompt copied: ${copied.length} characters`);
// the agent link for the MCP server (Agent access, on the MCP page)
await go(`${dash}#mcp`);
await sleep(2500);
let link = "";
try {
  const mk = page.locator("[data-mklink]").first();
  await mk.waitFor({ timeout: 10000 });
  await tap(mk);
  const code = page.locator(".alink-out code").first();
  await code.waitFor({ timeout: 15000 });
  link = (await code.textContent())?.trim() ?? "";
  await sleep(3000);
} catch (e) { say(`agent link: ${e.message.split("\n")[0]}`); }
if (link) { writeFileSync(join(OUT, ".dashboard-link"), link); say("agent link created (kept out of the log)"); }

// ---------------------------------------------------------------------------------------------------- prompts 1 and 2 in VS Code's terminal
await prompt(1, copied || "Add GenClass to this web app: install @genclass/runtime@beta, start it with GenClass.init in observe mode, connect the state responses write with rt.atom or rt.guard, add the agent link for development builds, run npx -y @genclass/mcp@0.2.0 init, then run the dev server, load a page and call genclass_status. Tell me what you changed.");
if (link) { stage("mcpenv"); stage("bridge", JSON.stringify({ GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on" })); say(".mcp.json and the bridge: the agent link, GENCLASS_REPORT=on"); }
await front();
await go("http://localhost:5173/");
await sleep(5000);
await overlay("Checks");
await sleep(5000);
await closeOverlay();
await handoff("main", 90000); // src/main.js open in VS Code's editor, so the next edits show
await prompt(2, 'Three small changes for this demo. (1) Wherever GenClass.init is called, set mode: "guard", aggressiveness: "eager" and visual: { on: true, fix: true }. (2) Load the devtools overlay on every build, not only in development, so the audience sees what GenClass does: import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)) (rt is what GenClass.init returned). (3) Keep the search state in one GenClass atom instead of separate store keys: const search = rt.atom("search", { query: "", results: [] }); the search handler writes it once per response with search.set((s) => ({ ...s, results: data.results, query: data.q })), and the results list renders from search.subscribe. Keep everything else as it is. Tell me the lines you changed.');

// ---------------------------------------------------------------------------------------------------- act 3: guard on the dev page, the hot fix
say("act 3: guard mode on the dev server, the hot fix");
await front();
for (let i = 0; i < 20; i++) { const s = await (await fetch("http://localhost:5173/src/main.js")).text().catch(() => ""); if (/atom/.test(s)) break; await sleep(500); }
await go("http://localhost:5173/");
await sleep(12000);
await typeSearch("react");
await sleep(3000);
await overlay("Interventions");
await sleep(9000);
await closeOverlay();

// ---------------------------------------------------------------------------------------------------- act 4: deploy, the live site, the dashboard
const ev = await prompt(3, "Deploy this to Vercel production with the Vercel CLI, non-interactively (vercel --prod --yes), and tell me the production URL.");
const liveUrls = [...new Set(ev.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) ?? [])].sort((a, b) => a.length - b.length);
let live = "";
for (const u of liveUrls) { try { if ((await fetch(u + "/", { redirect: "manual" })).status === 200) { live = u; break; } } catch {} }
say(`live: ${live || "(none reachable)"}`);
await front();
if (live) {
  say("act 4: the live site in observe, then guard; the dashboard");
  await go(`${live}/?genclass=observe`);
  await sleep(12000);
  await typeSearch("react");
  await sleep(3000);
  await overlay("Detections");
  await sleep(7000);
  await closeOverlay();
  await go(`${live}/`);
  await sleep(12000);
  await typeSearch("react");
  await sleep(2500);
  await tap(page.locator('button.add[data-item="Retro keyboard"]'));
  await sleep(90);
  await tap(page.locator('button.add[data-item="Retro keyboard"]'));
  await sleep(2000);
  await overlay("Interventions");
  await sleep(8000);
  await closeOverlay();
  await sleep(10000); // the telemetry batch
  say("the dashboard: overview, problems, what GenClass did, pages");
  for (const [anchor, ms] of [["top", 9000], ["found", 9000], ["acted", 7000], ["pages", 7000]]) {
    await go(`${dash}#${anchor}`);
    await sleep(1200);
    await page.evaluate(() => window.scrollBy({ top: 120, behavior: "smooth" })).catch(() => {});
    await sleep(ms);
  }
}

// ---------------------------------------------------------------------------------------------------- act 5: the agent closes the loop (dev server, observe)
say("act 5: the agent's loop on the dev server");
if (link) stage("bridge", JSON.stringify({ GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on" }), "fresh");
await sleep(5000);
const DEV = "http://localhost:5173/?genclass=observe";
const loadAndSearch = async (settleMs = 3500, readyMs = 6000) => {
  await go(DEV);
  await sleep(readyMs);
  await typeSearch("react");
  await sleep(settleMs);
  await page.evaluate(() => globalThis.__GENCLASS_AGENT__?.whenSettled?.()).catch(() => {});
};
const park = async () => { await go("about:blank"); };
await front();
await loadAndSearch(3000, 12000);
await prompt(4, "The search on the dev page shows results for the wrong query sometimes. Use genclass_status to check the page is connected, then start an explore with genclass_explore (3 runs) on that page; I will load it five times and type the same search. Do not report yet.");
await front();
for (let i = 0; i < 5; i++) await loadAndSearch(2500, 2500);
await park();
await prompt(5, "Report the explore with genclass_explore and explain the top race finding with genclass_explain, briefly. Then arm a replay of that finding with genclass_replay; I will load the page and type the same search. Do not fix anything yet and do not check the result yet.");
await front();
await loadAndSearch();
await park();
await prompt(6, "Check the replay result with genclass_replay. If it reproduced, fix the bug in src/main.js the simplest way (a sequence number per search request so an older response that arrives later is ignored), save the regression test genclass_explain generates under test/, then arm the replay again. I will load the page and type the same search; do not check the result yet.");
await front();
for (let i = 0; i < 30; i++) { const s = await (await fetch("http://localhost:5173/src/main.js")).text().catch(() => ""); if (/seq|Seq|latest|newest|abort|Abort|token/.test(s)) break; await sleep(500); }
await sleep(1500);
await loadAndSearch();
await park();
await prompt(7, "Check the replay result with genclass_replay. Then start another explore with genclass_explore (3 runs) on the same page; I will load it five times again. Do not report yet.");
await front();
for (let i = 0; i < 5; i++) await loadAndSearch(2500, 2500);
await park();
await prompt(8, "Report the explore with genclass_explore, and sum up in three lines what you found, proved and fixed.");

// ---------------------------------------------------------------------------------------------------- act 6: the closed loop on the dashboard
say("act 6: the dashboard's closed loop");
await front();
await sleep(2000);
await go(`${dash}#loop`);
await sleep(10000);
await page.evaluate(() => window.scrollTo({ top: (document.querySelector("#agentlog")?.getBoundingClientRect().top ?? 0) + window.scrollY - 60, behavior: "smooth" })).catch(() => {});
await sleep(9000);
await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })).catch(() => {});
await sleep(4000);

// ---------------------------------------------------------------------------------------------------- end
say("end");
writeFileSync(join(SIG, "stop"), "");
await sleep(1500);
rec.kill("SIGINT");
await new Promise((r) => rec.on("exit", r));
await browser.close();
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ live, dash: "(in .dashboard-page)", link: "(in .dashboard-link, not committed)" }, null, 2));
console.log("recording:", join(OUT, "demo-raw.mov"));
process.exit(0);
