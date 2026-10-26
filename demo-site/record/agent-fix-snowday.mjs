// Can the closed loop fix the snow day site's five planted bugs in the code? The integrated copy verify-snowday.mjs
// leaves behind (--keep) gets the agent link (the runtime's agent module, loaded as an ES module next to the
// script-tag build) and a GenClass MCP bridge of its own; a headless Chromium plays the five bugs in observe mode so
// GenClass records them; Claude Code (print mode, Opus) is asked to fix every problem GenClass found, with the GenClass
// MCP tools; then verify-snowday.mjs --src runs the five-bug check on the fixed code: all five fixed in observe.
// Usage: node demo-site/record/verify-snowday.mjs --keep && node demo-site/record/agent-fix-snowday.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const FROM = join(REC, "out", "verify-snowday");
const WORK = join(REC, "out", "agent-snowday");
const PORT = 8788;
const BRIDGE = "47400";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (!existsSync(FROM)) throw new Error("run verify-snowday.mjs --keep first (it leaves out/verify-snowday)");

// ---------------------------------------------------------------------------------------------------- the site with the agent link
rmSync(WORK, { recursive: true, force: true });
sh(`rsync -a --exclude .wrangler --exclude .genclass "${FROM}/" "${WORK}/"`);
let html = readFileSync(join(WORK, "index.html"), "utf8");
html = html.replace("<head>", `<head>
    <script>globalThis.__GENCLASS_AGENT_URL__ = "http://127.0.0.1:${BRIDGE}";</script>
    <script type="module">import { connectAgent } from "/genclass-dist/agent.js"; const go = () => GenClass.runtime ? connectAgent(GenClass.runtime) : setTimeout(go, 50); go();</script>`);
writeFileSync(join(WORK, "index.html"), html);
writeFileSync(join(WORK, ".mcp.json"), JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.0"], env: { GENCLASS_AGENT_PORT: BRIDGE } } } }, null, 2));
for (const p of [PORT, BRIDGE]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
await sleep(500);
const dev = spawn("npx", ["--yes", "wrangler@4", "dev", "--port", String(PORT)], { cwd: WORK, stdio: "ignore", detached: true });
const bridge = spawn("bash", ["-c", "sleep 1000000 | npx -y @genclass/mcp@0.2.0"], { cwd: WORK, env: { ...process.env, GENCLASS_AGENT_PORT: BRIDGE }, stdio: ["ignore", "ignore", "pipe"], detached: true });
let blog = "";
bridge.stderr.on("data", (d) => (blog += String(d)));
const waitHttp = async (url, ms = 60000) => { const s = Date.now(); while (Date.now() - s < ms) { try { if ((await fetch(url)).status < 500) return true; } catch {} await sleep(400); } return false; };
if (!(await waitHttp(`http://localhost:${PORT}/`))) throw new Error("wrangler dev did not come up");
await sleep(5000);
if (!/bridge listening/.test(blog)) throw new Error("the bridge did not come up: " + blog);
const stop = () => { for (const p of [dev, bridge]) { try { process.kill(-p.pid); } catch {} } for (const p of [PORT, BRIDGE]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`); };

// ---------------------------------------------------------------------------------------------------- the bugs, recorded
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
await page.goto(`http://localhost:${PORT}/?mode=observe`, { waitUntil: "domcontentloaded" });
await sleep(10000);
await page.click("#board-q");
for (const ch of "halton") { await page.type("#board-q", ch); await sleep(60); }
await sleep(3000);
await page.evaluate(() => document.querySelector("#vote-yes").scrollIntoView({ block: "center" }));
await sleep(300);
const sub = await page.locator("#vote-yes").boundingBox();
await page.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
await sleep(100);
await page.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
await sleep(1500);
await page.evaluate(() => { document.querySelector("#notice-ok").click(); window.scrollTo(0, 0); });
await sleep(300);
await page.mouse.move(380, 450);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await sleep(600); }
await sleep(2500);
await page.evaluate(() => window.scrollTo(0, 0)); await page.fill("#postal-code", "L6H"); await page.evaluate(() => document.querySelector("#predict-btn").click());
await sleep(9000);
const agent = await page.evaluate(() => { const a = globalThis.__GENCLASS_AGENT__; return a ? { connected: a.connected, run: a.run } : null; }).catch(() => null);
console.log("agent link:", JSON.stringify(agent));
await page.evaluate(() => globalThis.__GENCLASS_AGENT__?.whenSettled?.()).catch(() => {});
await sleep(1500);
await browser.close();

// ---------------------------------------------------------------------------------------------------- Claude fixes the code
const prompt = `Users of this snow day site report five problems: the school board search sometimes shows boards for an older query; a double click on a poll button votes twice; the alert bar at the top is unreadable; after a mistyped postal code nothing on the page can be clicked any more; after the notice's OK the page cannot scroll. GenClass has recorded a session with all of them on this site's dev page. Use genclass_status, then genclass_findings and genclass_explain on the findings, and fix the cause of each of the five in index.html (its inline script and styles; keep the GenClass lines in <head> and the boards atom as they are, and do not add dependencies). Keep each fix small and idiomatic: ignore stale search responses; prevent the duplicate post; readable alert bar text; release the click block on every path of the prediction, including errors; unlock scrolling when the notice closes. Then list the five fixes in one line each.`;
console.log("asking Claude Code (Opus)…");
const t0 = Date.now();
const claude = spawnSync("bash", ["-lc", `export PATH="$HOME/.local/bin:$PATH"; claude -p ${JSON.stringify(prompt)} --model opus --output-format json --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,mcp__genclass__*" --mcp-config .mcp.json --strict-mcp-config`], { cwd: WORK, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
let answer = "";
try { answer = JSON.parse(claude.stdout).result ?? claude.stdout; } catch { answer = claude.stdout; }
console.log(`Claude done in ${Math.round((Date.now() - t0) / 1000)} s\n---\n${answer.slice(0, 2500)}\n---`);
if (claude.stderr.trim()) console.log("stderr:", claude.stderr.slice(-600));
stop();
// the agent link and the bridge's port line stay out of the copy that is re-verified
let fixed = readFileSync(join(WORK, "index.html"), "utf8");
fixed = fixed.replace(/\n    <script>globalThis\.__GENCLASS_AGENT_URL__[^\n]*<\/script>\n    <script type="module">import \{ connectAgent \}[^\n]*<\/script>/, "");
writeFileSync(join(WORK, "index.html"), fixed);

// ---------------------------------------------------------------------------------------------------- the five bugs on the fixed code
console.log("\nverifying the fixed code (observe must show no bug now, guard too):");
const v = spawnSync(process.execPath, [join(REC, "verify-snowday.mjs"), "--src", WORK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
console.log(v.stdout.split("\n").filter((l) => /==|fixed|BROKEN|observe \(|guard:/.test(l)).join("\n"));
process.exit(v.status ?? 1);
