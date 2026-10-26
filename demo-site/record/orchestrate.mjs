// One seamless recording of the demo (demo-site/DEMO.md), driven end to end on this screen:
//   - a Chromium window on the left (Playwright, headed) plays the user: the shop, genclass.dev/start, the dashboard;
//   - Terminal.app on the right runs record/terminal.command, which feeds the real `claude` CLI the prompts (the
//     first one is the dashboard's own "Copy the prompt for your coding agent" text) and renders its work;
//   - ffmpeg records the built-in display the whole time.
// The two sides hand over through files in out/signals: the orchestrator writes prompt-N.txt, the terminal script
// runs Claude Code on it and writes done-N. Run from the repository root: node demo-site/record/orchestrate.mjs
import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const BEFORE = join(ROOT, "demo-site", "tiny-shop-before");
const OUT = join(REC, "out");
const SIG = join(OUT, "signals");
const SCREEN = process.env.DEMO_SCREEN ?? "4"; // ffmpeg avfoundation index of the built-in display
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${String(Math.floor((Date.now() - t0) / 60000)).padStart(2, "0")}:${String(Math.floor(((Date.now() - t0) / 1000) % 60)).padStart(2, "0")}`;
const chapters = [];
const say = (s) => {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  chapters.push(line);
  appendFileSync(join(OUT, "chapters.txt"), line + "\n");
};
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(SIG, { recursive: true });

// ---------------------------------------------------------------------------------------------------- 0. a pristine shop
say("reset tiny-shop-before to its committed state");
for (const f of ["src/main.js", "package.json", "vite.config.js", "index.html"]) {
  const r = sh(`git show HEAD:demo-site/tiny-shop-before/${f}`);
  if (r.status === 0) writeFileSync(join(BEFORE, f), r.stdout);
}
for (const f of ["src/genclass.config.js", ".mcp.json", ".genclass.local", "package-lock.json"]) rmSync(join(BEFORE, f), { force: true });
rmSync(join(BEFORE, ".genclass"), { recursive: true, force: true });
rmSync(join(BEFORE, "node_modules", "@genclass"), { recursive: true, force: true });
sh("npm install --no-audit --no-fund", BEFORE);
// ports: the shop, its API, and the GenClass bridge (this machine's other GenClass MCP server owns the default port)
for (const p of [5173, 8788, 47400]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
// This machine's own Claude Code session owns the default bridge port (47357) and comes back when killed, so the demo's
// bridge lives on 47400: the page is pointed there with the agent link's documented global (injected here, locally;
// the committed app has no such line), and the agent's servers get the same port through .mcp.json's env below.
const AGENT_PORT = "47400";
{
  const ih = join(BEFORE, "index.html");
  const html = readFileSync(ih, "utf8");
  if (!html.includes("__GENCLASS_AGENT_URL__")) writeFileSync(ih, html.replace("<head>", `<head>\n    <script>globalThis.__GENCLASS_AGENT_URL__ = "http://127.0.0.1:${AGENT_PORT}";</script>`));
}
await sleep(500);
const dev = spawn(process.execPath, ["dev.mjs"], { cwd: BEFORE, stdio: "ignore" });
const waitHttp = async (url, ms = 30000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if ((await fetch(url)).status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
};
await waitHttp("http://localhost:5173/");
await waitHttp("http://localhost:5173/api/search?q=r"); // the API behind the proxy too, so act 1 shows the race, not an empty list
writeFileSync(join(BEFORE, ".vercelignore"), ".mcp.json\n.genclass.local\n.genclass/\nnode_modules\n");
// One GenClass MCP server owns the bridge for the whole demo (as a live Claude Code session's would); each `claude -p`
// run's server finds the port taken and shares it. Its env mirrors the agent's steps to the dashboard once the link
// is known (set below, after the project is created); it starts here so the page can connect from the first load.
let bridge = null;
const startBridge = (env) => {
  if (bridge) { try { bridge.stdin.end(); bridge.kill(); } catch {} }
  bridge = spawn("npx", ["-y", "@genclass/mcp@0.2.0"], { cwd: BEFORE, env: { ...process.env, GENCLASS_AGENT_PORT: AGENT_PORT, ...env }, stdio: ["pipe", "ignore", "pipe"] });
  bridge.stderr.on("data", (d) => appendFileSync(join(OUT, "bridge.log"), String(d)));
};
startBridge({});
await sleep(4000);
let rec = null, browser = null;
const fail = async (e) => {
  say(`FAILED: ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
  try { writeFileSync(join(SIG, "stop"), ""); } catch {}
  try { rec?.kill("SIGINT"); await new Promise((r) => rec ? rec.on("exit", r) : r()); } catch {}
  try { await browser?.close(); } catch {}
  try { dev.kill(); } catch {}
  try { bridge.stdin.end(); bridge.kill(); } catch {}
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
{
  const log = existsSync(join(OUT, "bridge.log")) ? readFileSync(join(OUT, "bridge.log"), "utf8") : "";
  if (!/listening|owns|bridge on/i.test(log) || /another session/.test(log)) throw new Error(`the demo's bridge does not own port ${AGENT_PORT}:\n${log}`);
}

// ---------------------------------------------------------------------------------------------------- the terminal script
const allowed = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,mcp__genclass__*";
writeFileSync(join(OUT, "terminal.command"), `#!/bin/bash
# The demo's terminal: waits for each prompt the orchestrator writes, shows it as if typed, runs the real Claude Code
# CLI on it (print mode, its events rendered by pretty.mjs), and hands back when done.
cd "${BEFORE}"
SIG="${SIG}"
export PATH="$HOME/.local/bin:$PATH"
clear; printf '\\033[3J'
printf '\\033[1m%s\\033[0m\\n\\n' "tiny-shop  ·  Claude Code"
n=1
while [ ! -f "$SIG/stop" ]; do
  if [ -f "$SIG/prompt-$n.txt" ]; then
    PROMPT="$(cat "$SIG/prompt-$n.txt")"
    printf '\\033[32m❯\\033[0m '
    # the prompt, as if typed
    while IFS= read -r line || [ -n "$line" ]; do
      for ((i=0; i<\${#line}; i++)); do printf '%s' "\${line:$i:1}"; sleep 0.004; done
      printf '\\n  '
    done <<< "$PROMPT"
    printf '\\n'
    CONT=""; [ "$n" -gt 1 ] && CONT="--continue"
    MCP=""; [ -f .mcp.json ] && MCP="--mcp-config .mcp.json --strict-mcp-config"
    claude -p "$PROMPT" $CONT --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "${allowed}" $MCP 2>>"$SIG/claude-stderr.log" | PRETTY_LOG="$SIG/events-$n.log" node "${REC}/pretty.mjs"
    touch "$SIG/done-$n"
    n=$((n+1))
    printf '\\n'
  fi
  sleep 0.5
done
printf '\\n\\033[2m(end of the demo)\\033[0m\\n'
sleep 5
`);
execSync(`chmod +x "${join(OUT, "terminal.command")}"`);

const prompt = async (n, text) => {
  say(`prompt ${n}: ${text.split("\n")[0].slice(0, 80)}`);
  writeFileSync(join(SIG, `prompt-${n}.txt`), text);
  while (!existsSync(join(SIG, `done-${n}`))) await sleep(1000);
  say(`prompt ${n} done`);
  return existsSync(join(SIG, `events-${n}.log`)) ? readFileSync(join(SIG, `events-${n}.log`), "utf8") : "";
};

// ---------------------------------------------------------------------------------------------------- a clean stage
// Hide every other app and close Terminal's old windows (window placement and visibility only; no input is sent).
sh(`osascript -e 'tell application "Terminal" to close every window' 2>/dev/null; osascript -e 'tell application "System Events" to set visible of (every process whose visible is true and name is not "Finder" and name is not "Terminal") to false' 2>/dev/null; true`);
await sleep(1500);

// ---------------------------------------------------------------------------------------------------- recording
rec = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-pixel_format", "nv12", "-capture_cursor", "1", "-i", `${SCREEN}:none`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(OUT, "demo-raw.mov")], { stdio: "ignore" });
await sleep(1500);
say("recording started");

// ---------------------------------------------------------------------------------------------------- the windows
spawn("open", ["-a", "Terminal", join(OUT, "terminal.command")], { stdio: "ignore" });
await sleep(2500);
// the font first, then the bounds: the other way round Terminal keeps its column count and widens past the screen's edge
sh(`osascript -e 'tell application "Terminal" to set font size of front window to 14' -e 'tell application "Terminal" to set bounds of front window to {846, 30, 1512, 980}'`);
browser = await chromium.launch({ headless: false, args: ["--window-position=0,30", "--window-size=840,950"], ignoreDefaultArgs: ["--enable-automation"] });
const context = await browser.newContext({ viewport: null, colorScheme: "light" });
const page = await context.newPage();
const front = async () => { await page.bringToFront(); };
const typeSearch = async (text) => {
  await page.fill("#q", "");
  await page.click("#q");
  for (const ch of text) { await page.type("#q", ch); await sleep(60); }
};
const overlay = async (tab) => {
  try {
    if ((await page.locator("genclass-devtools").count()) === 0) { say(`overlay ${tab}: no overlay on this page`); return; }
    await page.locator("genclass-devtools").locator("text=GenClass").first().click({ timeout: 4000 });
    await sleep(600);
    await page.locator("genclass-devtools").locator(`text=${tab}`).first().click({ timeout: 4000 });
  } catch (e) { say(`overlay ${tab}: ${e.message.split("\n")[0]}`); }
};
const closeOverlay = async () => { try { await page.locator("genclass-devtools").locator('[title="Minimize"], button:has-text("−")').first().click({ timeout: 2000 }); } catch {} };

// ---------------------------------------------------------------------------------------------------- act 1: the shop
say("act 1: the shop as it is");
await front();
await page.goto("http://localhost:5173/?genclass=off", { waitUntil: "domcontentloaded" });
await sleep(4000);
await typeSearch("react");
await sleep(2500);
await page.dblclick('button.add[data-item="Retro keyboard"]');
await sleep(2000);
await page.mouse.wheel(0, 500);
await sleep(2000);
await page.mouse.wheel(0, -500);
await sleep(1000);

// ---------------------------------------------------------------------------------------------------- act 2: genclass.dev, the prompt
say("act 2: genclass.dev/start, a token, the Connect prompt");
await page.goto("https://genclass.dev/start", { waitUntil: "domcontentloaded" });
await sleep(2500);
await page.click("#name");
for (const ch of "tiny-shop") { await page.type("#name", ch); await sleep(70); }
await sleep(800);
await page.click("#go");
await page.waitForSelector("#dash", { state: "visible", timeout: 30000 });
await sleep(2500);
const link = (await page.$eval("#dash", (a) => a.textContent)).trim();
writeFileSync(join(OUT, ".dashboard-link"), link);
say("dashboard link created (kept out of the log)");
startBridge({ GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on" });
await page.goto(`${link}#connect`, { waitUntil: "domcontentloaded" });
await sleep(3500);
let copied = "";
try {
  const btn = page.locator('#m-connect button:has-text("Copy the prompt for your coding agent")').first();
  await btn.scrollIntoViewIfNeeded();
  await sleep(500);
  copied = await btn.getAttribute("data-copy");
  await btn.click();
} catch (e) { say(`copy button: ${e.message.split("\n")[0]}`); }
if (!copied) copied = await page.locator('button:has-text("Copy the prompt for your coding agent")').first().getAttribute("data-copy");
await sleep(2500);
say("prompt copied: " + copied.length + " characters");

if (process.env.DEMO_SMOKE) {
  say("smoke run: stopping before Claude");
  writeFileSync(join(SIG, "stop"), "");
  await sleep(2000);
  rec.kill("SIGINT");
  await new Promise((r) => rec.on("exit", r));
  await browser.close();
  dev.kill();
  try { bridge.stdin.end(); bridge.kill(); } catch {}
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------- act 2b: Claude integrates
await prompt(1, copied);
// the MCP server the agent added: its env, the dashboard link and the mirror (what the dashboard's MCP page prints)
try {
  const mcpPath = join(BEFORE, ".mcp.json");
  const cfg = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf8")) : { mcpServers: {} };
  cfg.mcpServers = cfg.mcpServers ?? {};
  const name = Object.keys(cfg.mcpServers)[0] ?? "genclass";
  cfg.mcpServers[name] = { command: "npx", args: ["-y", "@genclass/mcp@0.2.0"], ...(cfg.mcpServers[name] ?? {}), env: { ...(cfg.mcpServers[name]?.env ?? {}), GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on", GENCLASS_AGENT_PORT: AGENT_PORT } };
  writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + "\n");
  say(".mcp.json: the dashboard link and GENCLASS_REPORT=on");
} catch (e) { say(`mcp.json: ${e.message}`); }
await waitHttp("http://localhost:5173/");
await front();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await sleep(12000);
await overlay("Checks");
await sleep(5000);
await closeOverlay();

// ---------------------------------------------------------------------------------------------------- act 3: guard, the hot fix (local)
await prompt(2, 'Three small changes for this demo. (1) Wherever GenClass.init is called, set mode: "guard", aggressiveness: "eager" and visual: { on: true, fix: true }. (2) Load the devtools overlay on every build, not only in development, so the audience sees what GenClass does: import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)) (rt is what GenClass.init returned). (3) Keep the search state in one GenClass atom instead of separate store keys: const search = rt.atom("search", { query: "", results: [] }); the search handler writes it once per response with search.set((s) => ({ ...s, results: data.results, query: data.q })), and the results list renders from search.subscribe. Keep everything else as it is. Tell me the lines you changed.');
await front();
for (let i = 0; i < 20; i++) { const s = await (await fetch("http://localhost:5173/src/genclass.config.js")).text().catch(() => ""); if (s.includes("guard")) break; await sleep(500); }
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
say("act 3: guard mode on the dev server, the hot fix");
await sleep(15000);
await typeSearch("react");
await sleep(3000);
await overlay("Interventions");
await sleep(7000);
await closeOverlay();

// ---------------------------------------------------------------------------------------------------- act 4: deploy, the live site, the dashboard
const ev = await prompt(3, "Deploy this to Vercel production with the Vercel CLI, non-interactively (vercel --prod --yes), and tell me the production URL.");
// the project's alias (the shortest URL), never a hashed deployment URL: those sit behind Vercel's own sign-in
const liveUrls = [...new Set(ev.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) ?? [])].sort((a, b) => a.length - b.length);
let live = "";
for (const u of liveUrls) { try { if ((await fetch(u + "/", { redirect: "manual" })).status === 200) { live = u; break; } } catch {} }
say(`live: ${live || "(none reachable: " + liveUrls.join(" ") + ")"}`);
await front();
if (live) {
  say("act 4: the live site in observe, then guard; the dashboard");
  await page.goto(`${live}/?genclass=observe`, { waitUntil: "domcontentloaded" });
  await sleep(14000);
  await typeSearch("react");
  await sleep(3000);
  await overlay("Detections");
  await sleep(6000);
  await closeOverlay();
  await page.goto(`${live}/`, { waitUntil: "domcontentloaded" });
  await sleep(14000);
  await typeSearch("react");
  await sleep(2500);
  await page.dblclick('button.add[data-item="Retro keyboard"]');
  await sleep(2000);
  await overlay("Interventions");
  await sleep(6000);
  await closeOverlay();
  await sleep(12000); // the telemetry batch
  await page.goto(`${link}#top`, { waitUntil: "domcontentloaded" });
  await sleep(6000);
  await page.goto(`${link}#found`, { waitUntil: "domcontentloaded" });
  await sleep(6000);
}

// ---------------------------------------------------------------------------------------------------- act 5: the agent closes the loop (dev server, observe)
say("act 5: the agent's loop on the dev server");
// a fresh store for the loop (today's earlier runs would otherwise sit in the findings list)
startBridge({ GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on", GENCLASS_STATE_DIR: join(OUT, "agent-state-loop") });
await sleep(5000);
const DEV = "http://localhost:5173/?genclass=observe";
// one recorded load with the race on it, the model ready before the typing
const loadAndSearch = async (settleMs = 3500, readyMs = 6000) => {
  await page.goto(DEV, { waitUntil: "domcontentloaded" });
  await sleep(readyMs);
  await typeSearch("react");
  await sleep(settleMs);
  await page.evaluate(() => globalThis.__GENCLASS_AGENT__?.whenSettled?.()).catch(() => {});
};
// the page leaves before the agent edits files: a Vite reload would otherwise use up an armed replay or explore slot
const park = async () => { await page.goto("about:blank"); };
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
await sleep(3000);
await page.goto(`${link}#loop`, { waitUntil: "domcontentloaded" });
await sleep(7000);
await page.evaluate(() => window.scrollTo(0, (document.querySelector("#agentlog")?.getBoundingClientRect().top ?? 0) + window.scrollY - 60));
await sleep(6000);
await page.evaluate(() => window.scrollTo(0, 0));
await sleep(3000);

// ---------------------------------------------------------------------------------------------------- end
say("end");
writeFileSync(join(SIG, "stop"), "");
await sleep(1500);
rec.kill("SIGINT");
await new Promise((r) => rec.on("exit", r));
await browser.close();
dev.kill();
try { bridge.stdin.end(); bridge.kill(); } catch {}
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ live, chapters, link: "(in .dashboard-link, not committed)" }, null, 2));
console.log("recording:", join(OUT, "demo-raw.mov"));
process.exit(0);
