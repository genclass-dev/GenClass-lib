// End to end through genclass.dev: a new project from genclass.dev/start (its private link and key), the snow day
// site integrated with that key (telemetry on, guard, the visual fixes, the agent link), the five bugs played in a
// headless Chromium, then the dashboard's own API must show the page loads, the problems and what GenClass did; and the
// GenClass MCP server, started with GENCLASS_DASHBOARD and GENCLASS_REPORT=on and driven over stdio like a coding
// agent would (status, findings, explain), must mirror its steps into the project's Loop log.
// Usage: node demo-site/record/verify-snowday.mjs --keep && node demo-site/record/dashboard-e2e.mjs
// The private link is written to out/.e2e-link only (never logged).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const FROM = join(REC, "out", "verify-snowday");
const WORK = join(REC, "out", "e2e-snowday");
const PORT = 8790;
const BRIDGE = "47410";
const ORIGIN = "https://genclass.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`  ${ok ? "ok    " : "FAILED"} ${name}${detail ? ` (${detail})` : ""}`); };
if (!existsSync(FROM)) throw new Error("run verify-snowday.mjs --keep first (it leaves out/verify-snowday)");

// ---------------------------------------------------------------------------------------------------- 1. a project on genclass.dev
console.log("1. a new project on genclass.dev/start");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(`${ORIGIN}/start`, { waitUntil: "domcontentloaded" });
await page.fill("#name", "snowday-e2e");
await page.click("#go");
await page.waitForSelector("#dash", { state: "visible", timeout: 30000 });
const link = (await page.$eval("#dash", (a) => a.textContent)).trim();
writeFileSync(join(REC, "out", ".e2e-link"), link);
const secret = link.split("/dashboard/")[1];
await page.goto(`${link}#connect`, { waitUntil: "domcontentloaded" });
await sleep(3000);
const prompt = (await page.locator('button:has-text("Copy the prompt for your coding agent")').first().getAttribute("data-copy")) ?? "";
const token = (prompt.match(/gc_[A-Za-z0-9]{22}/) ?? [""])[0];
check("project created, key and Connect prompt read", !!secret && !!token, `prompt ${prompt.length} chars`);
check("the Connect prompt mounts the devtools overlay in development", prompt.includes("mountDevtools"));

// ---------------------------------------------------------------------------------------------------- 2. the site with that key
rmSync(WORK, { recursive: true, force: true });
sh(`rsync -a --exclude .wrangler --exclude .genclass "${FROM}/" "${WORK}/"`);
let html = readFileSync(join(WORK, "index.html"), "utf8");
html = html.replace(/token: "gc_verify_only", telemetry: false,/, `token: "${token}", telemetry: true,`);
html = html.replace("<head>", `<head>
    <script>globalThis.__GENCLASS_AGENT_URL__ = "http://127.0.0.1:${BRIDGE}";</script>
    <script type="module">import { connectAgent } from "/genclass-dist/agent.js"; const go = () => GenClass.runtime ? connectAgent(GenClass.runtime) : setTimeout(go, 50); go();</script>`);
if (!html.includes(token)) throw new Error("the key did not go in");
writeFileSync(join(WORK, "index.html"), html);
for (const p of [PORT, BRIDGE]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
const dev = spawn("npx", ["--yes", "wrangler@4", "dev", "--port", String(PORT)], { cwd: WORK, stdio: "ignore", detached: true });

// the MCP server, as a coding agent runs it: stdio JSON-RPC, owning the bridge, mirroring to the dashboard
const mcp = spawn("npx", ["-y", "@genclass/mcp@0.2.0"], { cwd: WORK, env: { ...process.env, GENCLASS_AGENT_PORT: BRIDGE, GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on", GENCLASS_STATE_DIR: "none" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
let mlog = "", buf = "", nextId = 1;
const pending = new Map();
mcp.stderr.on("data", (d) => (mlog += String(d)));
mcp.stdout.on("data", (d) => {
  buf += String(d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => pending.has(id) && rej(new Error(`${method} timed out`)), 60000); });
const tool = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return (r.result?.content ?? []).map((c) => c.text ?? "").join("\n"); };
const stop = () => { for (const p of [dev, mcp]) { try { process.kill(-p.pid); } catch {} } for (const p of [PORT, BRIDGE]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`); };
const waitHttp = async (url, ms = 60000) => { const s = Date.now(); while (Date.now() - s < ms) { try { if ((await fetch(url)).status < 500) return true; } catch {} await sleep(400); } return false; };
try {
  if (!(await waitHttp(`http://localhost:${PORT}/`))) throw new Error("wrangler dev did not come up");
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dashboard-e2e", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(3000);
  check("the MCP server owns the bridge and mirrors to the dashboard", /bridge listening/.test(mlog) && /mirroring/.test(mlog));

  // ---------------------------------------------------------------------------------------------------- 3. the five bugs, in guard
  console.log("2. the five bugs on the integrated site (guard, telemetry on)");
  const p2 = await browser.newPage({ viewport: { width: 760, height: 900 } });
  await p2.goto(`http://localhost:${PORT}/?mode=guard`, { waitUntil: "domcontentloaded" });
  await sleep(10000);
  await p2.click("#board-q");
  for (const ch of "halton") { await p2.type("#board-q", ch); await sleep(60); }
  await sleep(3000);
  const sub = await p2.locator("#vote-yes").boundingBox();
  await p2.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
  await sleep(100);
  await p2.mouse.click(sub.x + sub.width / 2, sub.y + sub.height / 2);
  await sleep(1500);
  await p2.evaluate(() => { document.querySelector("#notice-ok").click(); window.scrollTo(0, 0); });
  await p2.mouse.move(380, 450);
  for (let i = 0; i < 4; i++) { await p2.mouse.wheel(0, 300); await sleep(600); }
  await sleep(2500);
  await p2.evaluate(() => window.scrollTo(0, 0)); await p2.fill("#postal-code", "L6H"); await p2.evaluate(() => document.querySelector("#predict-btn").click());
  await sleep(9000);
  const local = await p2.evaluate(() => ({ interventions: GenClass.runtime.interventions().length, checks: GenClass.runtime.checks().filter((c) => c.fix?.applied).map((c) => c.kind), agent: !!globalThis.__GENCLASS_AGENT__?.connected }));
  check("guard intervened and applied the visual fixes on the page", local.interventions >= 1 && local.checks.length >= 3, `${local.interventions} intervention(s), fixes: ${local.checks.join(", ")}`);
  check("the page is connected to the agent bridge", local.agent);
  await p2.evaluate(() => globalThis.__GENCLASS_AGENT__?.whenSettled?.()).catch(() => {});
  await p2.close(); // the page hides: the runtime flushes its telemetry batch

  // ---------------------------------------------------------------------------------------------------- 4. the dashboard's API
  console.log("3. the dashboard");
  let stats = null;
  for (let i = 0; i < 12; i++) {
    stats = await fetch(`${ORIGIN}/api/projects/${encodeURIComponent(secret)}?range=24h`, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null);
    const s = JSON.stringify(stats ?? {});
    if (/stale/i.test(s) && /check/i.test(s)) break;
    await sleep(5000);
  }
  const s = JSON.stringify(stats ?? {});
  check("the dashboard shows the page loads", /"(pageLoads|sessions|loads)":\s*[1-9]/.test(s) || /page_?loads?\D{1,4}[1-9]/i.test(s), s.slice(0, 0));
  check("the dashboard shows the stale response", /stale/i.test(s));
  check("the dashboard shows what GenClass did (the stale write dropped)", (stats?.totals?.interventions ?? 0) >= 1 && /discard/.test(JSON.stringify(stats?.breakdowns?.intervention ?? [])));
  check("the dashboard shows the duplicate vote", /duplicate/.test(JSON.stringify(stats?.breakdowns?.diagnosis ?? [])));
  // the measured visual checks are never sent (TELEMETRY.md): their fixes are shown in the page's overlay only
  writeFileSync(join(REC, "out", "e2e-stats.json"), JSON.stringify(stats, null, 2));

  // ---------------------------------------------------------------------------------------------------- 5. the agent's steps on the Loop
  console.log("4. the agent's loop, mirrored");
  const st = await tool("genclass_status");
  check("genclass_status lists the page", /active page|recorded run/i.test(st), st.split("\n")[0].slice(0, 90));
  const fi = await tool("genclass_findings");
  const fid = (fi.match(/\b(f\d+)\b[^\n]*stale/) ?? fi.match(/\bf\d+\b/) ?? ["", ""])[1] ?? "";
  check("genclass_findings lists findings", !!fid, fi.split("\n")[0].slice(0, 90));
  if (fid) await tool("genclass_explain", { id: fid });
  let agent = null;
  for (let i = 0; i < 10; i++) {
    await sleep(4000);
    agent = (await fetch(`${ORIGIN}/api/projects/${encodeURIComponent(secret)}?range=24h`, { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => null))?.agent ?? null;
    if ((agent?.log ?? []).some((e) => e.t === "explain")) break;
  }
  writeFileSync(join(REC, "out", "e2e-agent.json"), JSON.stringify(agent, null, 2));
  const kinds = new Set((agent?.log ?? []).map((e) => e.t));
  check("the Loop log has the agent's steps (found, evidence read)", kinds.has("found") && kinds.has("explain"), `${(agent?.log ?? []).length} entries: ${[...kinds].join(", ")}; explained ${fid}`);

  // the dashboard pages render (Overview, Problems, Loop) without script errors
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  p3.on("pageerror", (e) => errors.push(String(e.message)));
  for (const anchor of ["top", "found", "acted", "loop"]) { await p3.goto(`${link}#${anchor}`, { waitUntil: "domcontentloaded" }); await sleep(3000); }
  const loopText = await p3.locator("body").innerText();
  check("the dashboard pages render without script errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  check("the Loop page shows the agent's steps", /Evidence read|Found/.test(loopText));
} finally {
  await browser.close();
  try { mcp.stdin.end(); } catch {}
  stop();
}
const ok = results.every(Boolean);
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(ok ? 0 : 1);
