// The command (AGENT.md §4.4): init merges config, the hook stays silent without a bridge and adds new findings.
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENTS } from "../src/clients.js";
import { SKILL_MARK, SKILL_PATH, configCmd, hookCmd, init, runCli, skillText } from "../src/cli.js";
import { VERSION } from "../src/http.js";
import { startBridge, type Bridge } from "../src/http.js";
import { Store } from "../src/store.js";
import { makeApi } from "../src/api.js";
import { page, tokenDir } from "./helpers.js";

function io(cwd: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd, env, out: (s: string) => void out.push(s), err: (s: string) => void err.push(s), o: out, e: err };
}

let b: Bridge | null = null;
afterEach(async () => {
  await b?.close();
  b = null;
});

describe("cli (AGENT.md §4.4)", () => {
  it("init adds the server to .mcp.json, keeps other servers, and --hook adds the prompt hook once", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "7" } }));
    const x = io(dir);
    expect(init(x, true)).toBe(0);
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["other", "genclass"]);
    // pinned to the version that ran init, like every other launcher of the package
    expect(mcp.mcpServers.genclass).toEqual({ command: "npx", args: ["-y", `@genclass/mcp@${VERSION}`] });
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`npx -y @genclass/mcp@${VERSION} hook`);
    expect(x.o.join("")).toContain("import.meta.env.DEV");
    // twice: no duplicates
    expect(init(io(dir), true)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("init recognizes a prompt hook it added before, pinned or not, and does not add a second", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    mkdirSync(join(dir, ".claude"));
    for (const command of ["npx -y @genclass/mcp hook", "npx -y @genclass/mcp@0.0.9 hook"]) {
      writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } }));
      const x = io(dir);
      expect(init(x, true)).toBe(0);
      expect(x.o.join("")).toContain("already in .claude/settings.json");
      expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
    }
  });

  it("config prints one client's block, every block without an argument, and refuses an unknown client", () => {
    const one = io(tmpdir());
    expect(configCmd(one, "cursor")).toBe(0);
    expect(one.o.join("")).toContain(`"@genclass/mcp@${VERSION}"`);
    expect(one.o.join("")).toContain("cursor://anysphere.cursor-deeplink/mcp/install?name=genclass&config=");
    const named = io(tmpdir());
    expect(configCmd(named, "Claude Code")).toBe(0);
    expect(named.o.join("")).toContain("/plugin install genclass@genclass");
    const all = io(tmpdir());
    expect(configCmd(all, undefined)).toBe(0);
    for (const c of CLIENTS) expect(all.o.join("")).toContain(`### ${c.label}`);
    const bad = io(tmpdir());
    expect(configCmd(bad, "notepad")).toBe(2);
    expect(bad.e.join("")).toContain("unknown client");
  });

  it("init writes the genclass skill to .claude/skills (the package's copy with the init marker after the frontmatter), with only a CLAUDE.md there", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# notes\n");
    const x = io(dir);
    expect(init(x, false)).toBe(0);
    const file = join(dir, SKILL_PATH);
    expect(file).toBe(join(dir, ".claude", "skills", "genclass", "SKILL.md"));
    const text = readFileSync(file, "utf8");
    expect(text).toBe(skillText(VERSION));
    const source = readFileSync(join(__dirname, "..", "plugin", "skills", "genclass", "SKILL.md"), "utf8");
    const [front, body] = source.split("\n---\n");
    expect(text.startsWith(`${front}\n---\n<!-- ${SKILL_MARK}: written by \`npx -y @genclass/mcp@${VERSION} init\`;`)).toBe(true);
    expect(text.endsWith(body)).toBe(true); // the body verbatim: the marker is the one line added
    expect(text.split("\n").filter((l) => l.includes(SKILL_MARK))).toHaveLength(1);
    expect(x.o.join("")).toContain(`Wrote the genclass skill (the procedure Claude Code loads for timing bugs) to ${file}`);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false); // no hook without --hook
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.genclass.args).toEqual(["-y", `@genclass/mcp@${VERSION}`]);
  });

  it("init again replaces a skill file that carries the marker and leaves one that does not, saying which", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    const file = join(dir, SKILL_PATH);
    mkdirSync(join(dir, ".claude", "skills", "genclass"), { recursive: true });
    // an older init's file (marker present, body stale): replaced
    writeFileSync(file, `---\nname: genclass\ndescription: old\n---\n<!-- ${SKILL_MARK}: written by an older init -->\n\n# stale\n`);
    const a = io(dir);
    expect(init(a, false)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(skillText(VERSION));
    expect(a.o.join("")).toContain(`Replaced the genclass skill at ${file}`);
    // the user's own file (no marker): left alone
    writeFileSync(file, "---\nname: genclass\ndescription: mine\n---\n\n# mine\n");
    const b = io(dir);
    expect(init(b, false)).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("---\nname: genclass\ndescription: mine\n---\n\n# mine\n");
    expect(b.o.join("")).toContain(`${SKILL_PATH} exists without the ${SKILL_MARK} marker (yours, or edited); leaving it.`);
  });

  it("init --no-skill writes .mcp.json and nothing under .claude", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    expect(init(io(dir), false, false)).toBe(0);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    // the flag through the command line
    const dir2 = mkdtempSync(join(tmpdir(), "gc-init-"));
    const x = io(dir2);
    expect(await runCli(["init", "--no-skill"], { ...x, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })).toBe(0);
    expect(existsSync(join(dir2, ".claude"))).toBe(false);
    expect(x.o.join("")).not.toContain("skill");
    expect(JSON.parse(readFileSync(join(dir2, ".mcp.json"), "utf8")).mcpServers.genclass).toBeTruthy();
  });

  it("init refuses to rewrite a .mcp.json it cannot parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-init-"));
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    const x = io(dir);
    expect(init(x, false)).toBe(1);
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe("{ not json");
  });

  it("hook: silent without a bridge; with one, the first prompt sets the cursor and later prompts get new findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-hook-"));
    mkdirSync(join(dir, ".genclass"), { recursive: true });
    const tdir = tokenDir();
    const none = io(dir, { GENCLASS_AGENT_PORT: "1", GENCLASS_TOKEN_DIR: tdir });
    expect(await hookCmd(none)).toBe(0);
    expect(none.o).toEqual([]);
    const store = new Store();
    let api: ReturnType<typeof makeApi> | null = null;
    b = await startBridge(store, { port: 0, api: (m, p) => api!(m, p), tokenDir: tdir });
    api = makeApi(store, { url: b.url, port: b.port });
    const env = { GENCLASS_AGENT_PORT: String(b.port), GENCLASS_TOKEN_DIR: tdir };
    const first = io(dir, env);
    await hookCmd(first);
    expect(first.o).toEqual([]);
    const p = await page(b.port, "/cart");
    await p.send([{ t: "error", error: { t: 1, name: "TypeError", message: "boom", chain: [] } }]);
    const second = io(dir, env);
    await hookCmd(second);
    const out = JSON.parse(second.o.join(""));
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain('f1 [error] "/cart"');
    const third = io(dir, env);
    await hookCmd(third);
    expect(third.o).toEqual([]);
    // a restarted bridge (another epoch) counts from the start again: its findings are not skipped
    await b.close();
    const store2 = new Store();
    let api2: ReturnType<typeof makeApi> | null = null;
    b = await startBridge(store2, { port: 0, api: (m, p) => api2!(m, p), tokenDir: tdir });
    api2 = makeApi(store2, { url: b.url, port: b.port });
    const env2 = { GENCLASS_AGENT_PORT: String(b.port), GENCLASS_TOKEN_DIR: tdir };
    const p2 = await page(b.port, "/pay");
    await p2.send([{ t: "error", error: { t: 1, name: "Error", message: "again", chain: [] } }]);
    const fourth = io(dir, env2);
    await hookCmd(fourth);
    expect(JSON.parse(fourth.o.join("")).hookSpecificOutput.additionalContext).toContain('[error] "/pay"');
  });
});
