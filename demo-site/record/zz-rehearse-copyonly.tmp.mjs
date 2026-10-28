// Temporary: the act 3 rehearsal for the copy-only Connect prompt (no typed lines). Not committed.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const WORK = join(REC, "out", "rehearsal-copyonly");
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
const PROMPT = readFileSync(process.argv[2], "utf8");
rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
sh(`git archive HEAD demo-site/snowday-before | tar -x -C "${WORK}" --strip-components=2`);
copyFileSync(join(ROOT, "demo-site", "snowday-before", "package.json"), join(WORK, "package.json"));
const t0 = Date.now();
const r = sh(`export PATH="$HOME/.local/bin:$PATH"; claude -p ${JSON.stringify(PROMPT)} --model opus --output-format json --permission-mode acceptEdits --allowedTools "Bash,Edit,Write,Read,Glob,Grep,WebFetch"`, WORK);
let out = ""; try { out = JSON.parse(r.stdout).result ?? r.stdout; } catch { out = r.stdout || r.stderr; }
console.log(`--- Claude (${Math.round((Date.now() - t0) / 1000)} s):\n${out.slice(0, 3000)}`);
// leave nothing behind: the local MCP entry for this folder, servers started from it
console.log(sh(`export PATH="$HOME/.local/bin:$PATH"; claude mcp get genclass 2>&1 | head -12; claude mcp remove genclass -s local 2>&1 | tail -1`, WORK).stdout);
for (const pid of sh(`lsof -nP -iTCP -sTCP:LISTEN -Fp | tr -d p`).stdout.split("\n").filter(Boolean)) {
  const cwd = sh(`lsof -a -p ${pid} -d cwd -Fn | grep ^n | cut -c2-`).stdout.trim();
  if (cwd.startsWith(WORK)) { sh(`kill ${pid}`); console.log("stopped a server Claude left running:", pid); }
}
const html = readFileSync(join(WORK, "index.html"), "utf8");
writeFileSync(join(REC, "out", "rehearsal-copyonly-head.txt"), html.slice(0, html.indexOf("<meta name=\"viewport\"")));
const has = (n, ok) => console.log(`  ${ok ? "ok     " : "MISSING"} ${n}`);
has("the key", html.includes("gc_RehearsalOnly00000000"));
has("guard", /data-mode="guard"|mode:\s*["']guard/.test(html));
has("eager", /eager/.test(html));
has("visual fixes", /data-visual="fix"|fix:\s*true/.test(html));
has("overlay on every host", /data-devtools(?!=)|data-devtools=""|devtools:\s*true|mountDevtools/.test(html) && !/data-devtools="local"/.test(html));
has("the board search as one atom", /atom\(\s*["'][^"']+["']\s*,\s*\{\s*query/.test(html));
has("the agent link on local hosts", /connectAgent/.test(html));
