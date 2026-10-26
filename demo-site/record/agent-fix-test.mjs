// Can the closed loop fix the shop's five planted bugs in the code? The integrated copy that verify-fixes.mjs leaves
// behind (--keep) gets the agent link and a GenClass MCP bridge of its own; a headless Chromium plays the five bugs
// on the dev page in observe mode so GenClass records them; then Claude Code (print mode, Opus) is asked to fix every
// problem GenClass found, with the GenClass MCP tools; finally verify-fixes.mjs --src runs the five-bug check on the
// fixed code: all five must be fixed in observe (no guard, no runtime fixes).
// Usage: node demo-site/record/verify-fixes.mjs --keep && node demo-site/record/agent-fix-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const FROM = join(REC, "out", "verify-shop");
const WORK = join(REC, "out", "agent-shop");
const PORT = "47400";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (!existsSync(FROM)) throw new Error("run verify-fixes.mjs --keep first (it leaves out/verify-shop)");

// ---------------------------------------------------------------------------------------------------- the shop with the agent link
rmSync(WORK, { recursive: true, force: true });
sh(`rsync -a --exclude .genclass "${FROM}/" "${WORK}/"`);
writeFileSync(join(WORK, "src", "genclass.js"), `import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";
export const rt = GenClass.init({ token: "gc_verify_only", telemetry: false, mode: globalThis.__GC_MODE__ ?? "guard", visual: { on: true, fix: true } });
globalThis.__rt = rt;
if (import.meta.env.DEV) connectAgent(rt);
`);
let html = readFileSync(join(WORK, "index.html"), "utf8");
if (!html.includes("__GENCLASS_AGENT_URL__")) html = html.replace("<head>", `<head>\n    <script>globalThis.__GENCLASS_AGENT_URL__ = "http://127.0.0.1:${PORT}";</script>`);
writeFileSync(join(WORK, "index.html"), html);
writeFileSync(join(WORK, ".mcp.json"), JSON.stringify({ mcpServers: { genclass: { command: "npx", args: ["-y", "@genclass/mcp@0.2.0"], env: { GENCLASS_AGENT_PORT: PORT } } } }, null, 2));
for (const p of [5173, 8788, PORT]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
await sleep(500);
const dev = spawn(process.execPath, ["dev.mjs"], { cwd: WORK, stdio: "ignore" });
const bridge = spawn("bash", ["-c", "sleep 1000000 | npx -y @genclass/mcp@0.2.0"], { cwd: WORK, env: { ...process.env, GENCLASS_AGENT_PORT: PORT }, stdio: ["ignore", "ignore", "pipe"] });
let blog = "";
bridge.stderr.on("data", (d) => (blog += String(d)));
const waitHttp = async (url, ms = 40000) => { const s = Date.now(); while (Date.now() - s < ms) { try { if ((await fetch(url)).status < 500) return true; } catch {} await sleep(300); } return false; };
if (!(await waitHttp("http://localhost:5173/api/search?q=r"))) throw new Error("the dev server did not come up");
await sleep(5000);
if (!/bridge listening/.test(blog)) throw new Error("the bridge did not come up: " + blog);
const stop = () => { dev.kill(); try { process.kill(-bridge.pid); } catch {} bridge.kill(); for (const p of [5173, 8788, PORT]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`); };

// ---------------------------------------------------------------------------------------------------- the bugs, recorded
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
await page.goto("http://localhost:5173/?mode=observe", { waitUntil: "domcontentloaded" });
await sleep(10000);
await page.click("#q");
for (const ch of "react") { await page.type("#q", ch); await sleep(60); }
await sleep(3000);
await page.click('button.add[data-item="Retro keyboard"]');
await sleep(80);
await page.click('button.add[data-item="Retro keyboard"]');
await sleep(1500);
await page.evaluate(() => document.querySelector("#ok").click());
await sleep(300);
await page.mouse.move(380, 450);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 300); await sleep(600); }
await sleep(2500);
await page.evaluate(() => document.querySelector("#reviews").click());
await sleep(9000);
await page.evaluate(() => globalThis.__GENCLASS_AGENT__?.whenSettled?.()).catch(() => {});
await sleep(1500);
const status = await fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.text()).catch((e) => String(e));
console.log("bridge status:", status.slice(0, 300));
await browser.close();

// ---------------------------------------------------------------------------------------------------- Claude fixes the code
const prompt = `Users of this shop report five problems: the search sometimes shows results for an older query; a double click on Add to cart adds twice; the banner at the top is unreadable; after "Load reviews" nothing on the page can be clicked any more; after the cookie notice's OK the page cannot scroll. GenClass has recorded a session with all of them on this app's dev page. Use genclass_status, then genclass_findings and genclass_explain on the findings, and fix the cause of each of the five in the code (src/main.js, src/style.css; keep the GenClass integration in src/genclass.js and the atom as they are, and do not add dependencies). Keep each fix small and idiomatic: cancel or ignore stale search responses; prevent the duplicate post; readable banner text; release the click block when the reviews arrive (and on failure); unlock scrolling when the notice closes. Then list the five fixes in one line each.`;
console.log("asking Claude Code (Opus)…");
const t0 = Date.now();
const claude = spawnSync("bash", ["-lc", `export PATH="$HOME/.local/bin:$PATH"; claude -p ${JSON.stringify(prompt)} --model opus --output-format json --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,mcp__genclass__*" --mcp-config .mcp.json --strict-mcp-config`], { cwd: WORK, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
let answer = "";
try { answer = JSON.parse(claude.stdout).result ?? claude.stdout; } catch { answer = claude.stdout; }
console.log(`Claude done in ${Math.round((Date.now() - t0) / 1000)} s\n---\n${answer.slice(0, 3000)}\n---`);
if (claude.stderr.trim()) console.log("stderr:", claude.stderr.slice(-800));
console.log("diff:\n" + sh(`diff -ru "${FROM}/src" "${WORK}/src" | grep -E '^[+-][^+-]' | head -60`).stdout);
stop();

// ---------------------------------------------------------------------------------------------------- the five bugs on the fixed code
console.log("\nverifying the fixed code (observe must show no bug now, guard too):");
const v = spawnSync(process.execPath, [join(REC, "verify-fixes.mjs"), "--src", WORK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
console.log(v.stdout.split("\n").filter((l) => /==|fixed|BROKEN|observe \(|guard:/.test(l)).join("\n"));
process.exit(v.status ?? 1);
