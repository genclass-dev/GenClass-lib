// The command (AGENT.md §4.4): init merges config, the hook stays silent without a bridge and adds new findings.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookCmd, init } from "../src/cli.js";
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
    expect(mcp.mcpServers.genclass).toEqual({ command: "npx", args: ["-y", "@genclass/mcp"] });
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("npx -y @genclass/mcp hook");
    expect(x.o.join("")).toContain("import.meta.env.DEV");
    // twice: no duplicates
    expect(init(io(dir), true)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.UserPromptSubmit).toHaveLength(1);
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
