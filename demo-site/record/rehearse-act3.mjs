// A rehearsal of the demo's act 3 on a copy of demo-site/snowday-before: a fresh genclass.dev project (/start), its real
// Connect prompt plus the script's static-site line, then the script's three-change prompt (3c), both through Claude
// Code on Opus exactly as the recording does; then what Claude wrote is checked, and the five bugs are played on the
// result in guard (verify-snowday.mjs --src). No deploy: the copy stays in out/rehearsal-snowday.
// Usage: node demo-site/record/rehearse-act3.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const WORK = join(REC, "out", "rehearsal-snowday");
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
const SCRIPT = readFileSync(join(ROOT, "demo-site", "DEMO-SCRIPT.md"), "utf8");
const block = (after) => { const i = SCRIPT.indexOf(after); const a = SCRIPT.indexOf("```text\n", i) + 8; return SCRIPT.slice(a, SCRIPT.indexOf("\n  ```", a)).trim(); };
const STATIC_LINE = block("- **3a.**");
const PROMPT_3C = block("- **3c.**");

// ---------------------------------------------------------------------------------------------------- the project and its prompt
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://genclass.dev/start", { waitUntil: "domcontentloaded" });
await page.fill("#name", "snowday-rehearsal");
await page.click("#go");
await page.waitForSelector("#dash", { state: "visible", timeout: 30000 });
const link = (await page.$eval("#dash", (a) => a.textContent)).trim();
await page.goto(`${link}#connect`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const copied = (await page.locator('button:has-text("Copy the prompt for your coding agent")').first().getAttribute("data-copy")) ?? "";
await browser.close();
const token = (copied.match(/gc_[A-Za-z0-9]{22}/) ?? [""])[0];
console.log(`project: key ${token ? "found" : "MISSING"}, prompt ${copied.length} chars, overlay line ${copied.includes("mountDevtools") ? "yes" : "no"}`);

// ---------------------------------------------------------------------------------------------------- Claude, twice
rmSync(WORK, { recursive: true, force: true });
sh(`rsync -a --exclude .wrangler --exclude node_modules "${join(ROOT, "demo-site", "snowday-before")}/" "${WORK}/"`);
const claude = (prompt, cont) => {
  const t0 = Date.now();
  const r = sh(`export PATH="$HOME/.local/bin:$PATH"; claude -p ${JSON.stringify(prompt)} ${cont ? "--continue" : ""} --model opus --output-format json --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch,mcp__genclass__*"`, WORK);
  let out = ""; try { out = JSON.parse(r.stdout).result ?? r.stdout; } catch { out = r.stdout || r.stderr; }
  console.log(`\n--- Claude (${Math.round((Date.now() - t0) / 1000)} s):\n${out.slice(0, 1800)}`);
};
claude(`${copied}\n\n${STATIC_LINE}`, false);
claude(PROMPT_3C, true);
for (const p of [8788, 8787, 5173]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);

// ---------------------------------------------------------------------------------------------------- what Claude wrote
const html = readFileSync(join(WORK, "index.html"), "utf8");
const has = (name, ok) => console.log(`  ${ok ? "ok    " : "MISSING"} ${name}`);
console.log("\nindex.html:");
has("the project key", html.includes(token));
has("the GenClass runtime from the CDN", /cdn\.jsdelivr\.net\/npm\/@genclass\/runtime@/.test(html));
has("guard mode", /guard/.test(html));
has("eager", /eager/.test(html));
has("visual fixes", /fix:\s*true|data-visual|visual/.test(html));
has("the devtools overlay", /devtools/.test(html));
has("the boards atom", /atom\(\s*["']boards["']/.test(html));
has("the agent link for localhost", /connectAgent/.test(html));
has(".mcp.json", (() => { try { return readFileSync(join(WORK, ".mcp.json"), "utf8").includes("@genclass/mcp"); } catch { return false; } })());
writeFileSync(join(REC, "out", "rehearsal-head.txt"), html.slice(0, html.indexOf("</head>")));

// ---------------------------------------------------------------------------------------------------- the five bugs on Claude's integration
console.log("\nthe five bugs on Claude's integration (its own mode: guard):");
const v = spawnSync(process.execPath, [join(REC, "verify-snowday.mjs"), "--src", WORK, "--keep"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log(v.stdout.split("\n").filter((l) => /^==|fixed|BROKEN|raw/.test(l)).join("\n"));
