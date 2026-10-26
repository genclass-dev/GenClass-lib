// The demo stage, for a take driven by hand (or by an agent with browser and desktop tools) instead of by Playwright:
//   node demo-site/record/stage.mjs setup      resets tiny-shop-before, starts its dev server and the demo's GenClass
//                                              bridge (port 47400), writes out/terminal.command and the VS Code task
//                                              that runs it in the integrated terminal when the folder opens
//   node demo-site/record/stage.mjs record     starts the full-display recording (ffmpeg) and out/chapters.txt
//   node demo-site/record/stage.mjs mark "..." adds a chapter line at the current recording time
//   node demo-site/record/stage.mjs prompt N "..."  gives Claude Code (in the VS Code terminal) its next prompt and
//                                              waits for it to finish; prints the answer
//   node demo-site/record/stage.mjs bridge '{"GENCLASS_DASHBOARD":"...","GENCLASS_REPORT":"on"}' [fresh]
//                                              restarts the bridge with that env (fresh: a new state dir)
//   node demo-site/record/stage.mjs mcpenv     injects the bridge's env into the app's .mcp.json
//   node demo-site/record/stage.mjs stop       ends the terminal script, finalizes the recording, stops everything
// The dev server, the bridge and ffmpeg outlive each command (detached; pids in out/pids.json).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(REC, "..", "..");
const BEFORE = join(ROOT, "demo-site", "tiny-shop-before");
const OUT = join(REC, "out");
const SIG = join(OUT, "signals");
const PIDS = join(OUT, "pids.json");
const AGENT_PORT = "47400";
const SCREEN = process.env.DEMO_SCREEN ?? "4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, cwd = ROOT) => spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const pids = () => (existsSync(PIDS) ? JSON.parse(readFileSync(PIDS, "utf8")) : {});
const setPid = (k, v) => writeFileSync(PIDS, JSON.stringify({ ...pids(), [k]: v }));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid, sig = "SIGTERM") => { try { if (pid) process.kill(-pid, sig); } catch { try { if (pid) process.kill(pid, sig); } catch {} } };
const detached = (cmd, args, opts) => {
  const log = openSync(join(OUT, `${opts.name}.log`), "a");
  const p = spawn(cmd, args, { cwd: opts.cwd ?? BEFORE, env: { ...process.env, ...(opts.env ?? {}) }, detached: true, stdio: ["ignore", log, log] });
  p.unref();
  setPid(opts.name, p.pid);
  return p.pid;
};
const stamp = () => {
  const t0 = existsSync(join(OUT, "rec.json")) ? JSON.parse(readFileSync(join(OUT, "rec.json"), "utf8")).t0 : Date.now();
  const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const mark = (text) => {
  const line = `[${stamp()}] ${text}`;
  console.log(line);
  appendFileSync(join(OUT, "chapters.txt"), line + "\n");
};
const waitHttp = async (url, ms = 60000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if ((await fetch(url)).status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
};
const startBridge = (env, fresh = false) => {
  kill(pids().bridge);
  const e = { GENCLASS_AGENT_PORT: AGENT_PORT, ...env, ...(fresh ? { GENCLASS_STATE_DIR: join(OUT, `agent-state-${Date.now()}`) } : {}) };
  // an MCP server over stdio exits when its stdin closes, so a sleeping pipe keeps it open; the bridge is its own
  // process group (detached), killed as a group
  return detached("bash", ["-c", "sleep 1000000 | npx -y @genclass/mcp@0.2.0"], { name: "bridge", env: e });
};

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "setup") {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SIG, { recursive: true });
  for (const f of ["src/main.js", "src/store.js", "package.json", "vite.config.js", "index.html"]) {
    const r = sh(`git show HEAD:demo-site/tiny-shop-before/${f}`);
    if (r.status === 0) writeFileSync(join(BEFORE, f), r.stdout);
  }
  for (const f of ["src/genclass.config.js", "src/genclass.js", ".mcp.json", ".genclass.local", "package-lock.json"]) rmSync(join(BEFORE, f), { force: true });
  for (const d of [".genclass", "test", "dist", join("node_modules", "@genclass")]) rmSync(join(BEFORE, d), { recursive: true, force: true });
  sh("npm install --no-audit --no-fund", BEFORE);
  for (const p of [5173, 8788, AGENT_PORT]) sh(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t | xargs -r kill 2>/dev/null; true`);
  {
    const ih = join(BEFORE, "index.html");
    const html = readFileSync(ih, "utf8");
    if (!html.includes("__GENCLASS_AGENT_URL__")) writeFileSync(ih, html.replace("<head>", `<head>\n    <script>globalThis.__GENCLASS_AGENT_URL__ = "http://127.0.0.1:${AGENT_PORT}";</script>`));
  }
  writeFileSync(join(BEFORE, ".vercelignore"), ".mcp.json\n.genclass.local\n.genclass/\n.vscode/\nnode_modules\ntest/\n");
  await sleep(500);
  detached(process.execPath, ["dev.mjs"], { name: "dev" });
  if (!(await waitHttp("http://localhost:5173/"))) throw new Error("the dev server did not come up");
  if (!(await waitHttp("http://localhost:5173/api/search?q=r"))) throw new Error("the API did not come up");
  startBridge({});
  await sleep(5000);
  const log = existsSync(join(OUT, "bridge.log")) ? readFileSync(join(OUT, "bridge.log"), "utf8") : "";
  if (!/bridge listening/.test(log) || /another session/.test(log)) throw new Error(`the demo's bridge does not own port ${AGENT_PORT}:\n${log}`);

  // Claude Code in the terminal, on Opus: the same script as the Playwright take's, started by VS Code's task runner
  const allowed = "Bash,Edit,Write,Read,Glob,Grep,WebFetch,mcp__genclass__*";
  writeFileSync(join(OUT, "terminal.command"), `#!/bin/bash
cd "${BEFORE}"
SIG="${SIG}"
export PATH="$HOME/.local/bin:$PATH"
clear; printf '\\033[3J'
printf '\\033[1m%s\\033[0m\\n\\n' "tiny-shop  ·  Claude Code (Opus)"
n=1
while [ ! -f "$SIG/stop" ]; do
  if [ -f "$SIG/prompt-$n.txt" ]; then
    PROMPT="$(cat "$SIG/prompt-$n.txt")"
    printf '\\033[32m❯\\033[0m '
    while IFS= read -r line || [ -n "$line" ]; do
      for ((i=0; i<\${#line}; i++)); do printf '%s' "\${line:$i:1}"; sleep 0.004; done
      printf '\\n  '
    done <<< "$PROMPT"
    printf '\\n'
    CONT=""; [ "$n" -gt 1 ] && CONT="--continue"
    MCP=""; [ -f .mcp.json ] && MCP="--mcp-config .mcp.json --strict-mcp-config"
    claude -p "$PROMPT" $CONT --model opus --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools "${allowed}" $MCP 2>>"$SIG/claude-stderr.log" | PRETTY_LOG="$SIG/events-$n.log" node "${REC}/pretty.mjs"
    touch "$SIG/done-$n"
    n=$((n+1))
    printf '\\n'
  fi
  sleep 0.5
done
printf '\\n\\033[2m(end of the demo)\\033[0m\\n'
sleep 5
`);
  sh(`chmod +x "${join(OUT, "terminal.command")}"`);
  mkdirSync(join(BEFORE, ".vscode"), { recursive: true });
  writeFileSync(join(BEFORE, ".vscode", "tasks.json"), JSON.stringify({
    version: "2.0.0",
    tasks: [{
      label: "Claude Code", type: "shell", command: `bash "${join(OUT, "terminal.command")}"`,
      presentation: { reveal: "always", panel: "dedicated", focus: true, echo: false, showReuseMessage: false, clear: true },
      runOptions: { runOn: "folderOpen" }, problemMatcher: [],
    }],
  }, null, 2));
  writeFileSync(join(BEFORE, ".vscode", "settings.json"), JSON.stringify({
    "task.allowAutomaticTasks": "on", "workbench.startupEditor": "none", "editor.minimap.enabled": false,
    "terminal.integrated.fontSize": 13, "editor.fontSize": 13, "workbench.tips.enabled": false, "git.openRepositoryInParentFolders": "always",
  }, null, 2));
  console.log("ready: dev server, bridge on 47400, terminal.command and the VS Code task");
} else if (cmd === "record") {
  const pid = detached("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-pixel_format", "nv12", "-capture_cursor", "1", "-i", `${SCREEN}:none`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(OUT, "demo-raw.mov")], { name: "ffmpeg" });
  await sleep(1500);
  writeFileSync(join(OUT, "rec.json"), JSON.stringify({ t0: Date.now(), pid }));
  mark("recording started");
} else if (cmd === "mark") {
  mark(rest.join(" "));
} else if (cmd === "prompt") {
  const n = Number(rest[0]);
  const text = rest.slice(1).join(" ");
  mark(`prompt ${n}: ${text.split("\n")[0].slice(0, 80)}`);
  writeFileSync(join(SIG, `prompt-${n}.txt`), text);
  while (!existsSync(join(SIG, `done-${n}`))) await sleep(1000);
  mark(`prompt ${n} done`);
  const ev = existsSync(join(SIG, `events-${n}.log`)) ? readFileSync(join(SIG, `events-${n}.log`), "utf8") : "";
  for (const line of ev.split("\n")) { try { const e = JSON.parse(line); if (e.type === "result") console.log(e.result); } catch {} }
} else if (cmd === "bridge") {
  startBridge(JSON.parse(rest[0] ?? "{}"), rest[1] === "fresh");
  await sleep(5000);
  console.log(readFileSync(join(OUT, "bridge.log"), "utf8").split("\n").slice(-3).join("\n"));
} else if (cmd === "mcpenv") {
  const link = readFileSync(join(OUT, ".dashboard-link"), "utf8").trim();
  const p = join(BEFORE, ".mcp.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  const name = Object.keys(cfg.mcpServers ?? {})[0];
  cfg.mcpServers[name] = { ...cfg.mcpServers[name], env: { ...(cfg.mcpServers[name]?.env ?? {}), GENCLASS_DASHBOARD: link, GENCLASS_REPORT: "on", GENCLASS_AGENT_PORT: AGENT_PORT } };
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  console.log(".mcp.json: the dashboard link, GENCLASS_REPORT=on, the bridge port");
} else if (cmd === "stop") {
  mark("end");
  writeFileSync(join(SIG, "stop"), "");
  const { ffmpeg, dev, bridge } = pids();
  kill(ffmpeg, "SIGINT");
  for (let i = 0; i < 30 && alive(ffmpeg); i++) await sleep(500);
  kill(dev); kill(bridge);
  console.log("stopped; recording:", join(OUT, "demo-raw.mov"));
} else {
  console.error("usage: stage.mjs setup|record|mark|prompt|bridge|mcpenv|stop");
  process.exit(2);
}
