// A rehearsal of the demo's act 3 on a copy of demo-site/snowday-before: a fresh genclass.dev project (/start), its
// Connect dialog with the act's choices ticked (Guard, Eager, Badge on the live site, Connect my coding agent to
// production; never Deploy), the prompt its Copy button holds, given to Claude Code on Opus exactly as the recording
// pastes it; then what Claude wrote is checked, and the five bugs are played on it in guard (verify-snowday.mjs --src,
// on port 8791 so the demo's dev server on 8788 keeps running). No deploy: the copy stays in out/rehearsal-snowday, and
// the MCP entry Claude adds for the agent link is removed at the end.
// Usage: node demo-site/record/rehearse-act3.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const WORK = join(REC, "out", "rehearsal-snowday");
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });

// ---------------------------------------------------------------------------------------------------- the project and its prompt
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://genclass.dev/start", { waitUntil: "domcontentloaded" });
await page.fill("#name", "snowday-rehearsal");
await page.click("#go");
await page.waitForSelector("#dash", { state: "visible", timeout: 30000 });
const link = (await page.$eval("#dash", (a) => a.textContent)).trim();
await page.goto(`${link}#connect`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#cchoices", { state: "visible", timeout: 15000 });
for (const k of ["guard", "eager", "badge", "agent"]) await page.check(`#cchoices [data-choice="${k}"]`);
const copied = (await page.getAttribute("#cpinstall", "data-copy")) ?? "";
await browser.close();
const token = (copied.match(/gc_[A-Za-z0-9]{22}/) ?? [""])[0];
console.log(`project: key ${token ? "found" : "MISSING"}, prompt ${copied.length} chars, guard ${copied.includes('data-mode="guard"') ? "yes" : "no"}, agent link ${copied.includes("GENCLASS_DASHBOARD=") ? "yes" : "no"}, deploy ${copied.includes("Deploy it") ? "YES (should not be)" : "no"}`);

// ---------------------------------------------------------------------------------------------------- Claude, once, with the copied prompt
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
sh(`git archive HEAD demo-site/snowday-before | tar -x -C "${WORK}" --strip-components=2`);
copyFileSync(join(ROOT, "demo-site", "snowday-before", "package.json"), join(WORK, "package.json"));
const t0 = Date.now();
const r = sh(`export PATH="$HOME/.local/bin:$PATH"; claude -p ${JSON.stringify(copied)} --model opus --output-format json --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch"`, WORK);
let out = "";
try { out = JSON.parse(r.stdout).result ?? r.stdout; } catch { out = r.stdout || r.stderr; }
console.log(`\n--- Claude (${Math.round((Date.now() - t0) / 1000)} s):\n${out.slice(0, 1800)}`);
// leave nothing behind: the MCP entry with the agent link, servers started from the copy
sh(`export PATH="$HOME/.local/bin:$PATH"; claude mcp remove genclass -s local`, WORK);
for (const pid of sh("lsof -nP -iTCP -sTCP:LISTEN -Fp | tr -d p").stdout.split("\n").filter(Boolean)) {
  if (sh(`lsof -a -p ${pid} -d cwd -Fn | grep ^n | cut -c2-`).stdout.trim().startsWith(WORK)) sh(`kill ${pid}`);
}

// ---------------------------------------------------------------------------------------------------- what Claude wrote
const html = readFileSync(join(WORK, "index.html"), "utf8");
const has = (name, ok) => console.log(`  ${ok ? "ok    " : "MISSING"} ${name}`);
console.log("\nindex.html:");
has("the project key", !!token && html.includes(token));
has("the GenClass runtime from the CDN", /cdn\.jsdelivr\.net\/npm\/@genclass\/runtime@/.test(html));
has("guard mode", /data-mode="guard"|mode:\s*["']guard/.test(html));
has("eager", /eager/.test(html));
has("visual fixes", /data-visual="fix"|fix:\s*true/.test(html));
has("the overlay on every host", /data-devtools(?!="local")|mountDevtools|devtools:\s*true/.test(html));
has("the board search as one atom", /atom\(\s*["'][^"']+["']\s*,\s*\{\s*query/.test(html));
has("the agent link for local hosts", /connectAgent/.test(html));
writeFileSync(join(REC, "out", "rehearsal-head.txt"), html.slice(0, html.indexOf('<meta name="viewport"')));

// ---------------------------------------------------------------------------------------------------- the five bugs on Claude's integration
console.log("\nthe five bugs on Claude's integration (its own mode: guard):");
const v = spawnSync(process.execPath, [join(REC, "verify-snowday.mjs"), "--src", WORK, "--keep", "--port", "8791"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log(v.stdout.split("\n").filter((l) => /^==|fixed|BROKEN|guard:/.test(l)).join("\n"));
