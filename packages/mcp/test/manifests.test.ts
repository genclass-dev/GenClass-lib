// Every version and pinned launcher that ships with this package or that directories read (the server's VERSION, the
// MCP Registry entry, the Claude Code plugin and its marketplace entry, the repo-root manifests, the README's
// install section) equals package.json's version, and no launcher is unpinned. With GENCLASS_SYNC=1
// (`npm run sync -w @genclass/mcp`) the test rewrites those files from package.json instead of failing. The same sync
// keeps the repo-root copy of the skill (skills/genclass/SKILL.md, what skill directories such as skills.sh read)
// byte-identical to the plugin's. The second describe checks the skill and the server's instructions: the
// instructions carry the triggers, the skill the procedure (docs/runtime/AGENT.md section 4.2). The last describe
// checks what scripts/plugin-repo.mjs assembles for the plugin's own repository, genclass-dev/genclass-plugin: the
// plugin folder byte for byte except the two Claude Code launchers, which there run the server vendored under
// server/ (the package's bin and dist/cli.js: from `--server <package dir>` here, this package when it is built and a
// stub otherwise; from npm in the daily sync), and nothing Anthropic's directory holds a plugin for: no package.json,
// no lockfile, nothing to install.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENTS, PACKAGE, hookCommand, installMarkdown, pinned, serverConfig } from "../src/clients.js";
import { VERSION } from "../src/http.js";
import { INSTRUCTIONS, TOOLS } from "../src/tools.js";

const pkgDir = join(__dirname, "..");
const repo = join(pkgDir, "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string; version: string; description: string };
const V = pkg.version;
const SYNC = process.env.GENCLASS_SYNC === "1";

type Json = Record<string, any>;

/** A file and what it must hold for version V: a JSON edit (compared as data) or a text edit (compared as text). */
interface Pin {
  file: string;
  json?: (cur: Json) => Json;
  text?: (cur: string) => string;
}

/** `@genclass/mcp@<any version>` in prose and code blocks. */
const PINNED = /@genclass\/mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g;

const START = "<!-- install:start";
const END = "<!-- install:end -->";

/** Replace the generated part of a Markdown file (between the install markers) with `body`. */
function section(cur: string, body: string): string {
  const a = cur.indexOf(START);
  const b = cur.indexOf(END);
  if (a < 0 || b < a) throw new Error(`no ${START} ... ${END} markers`);
  const open = cur.indexOf("-->", a) + 3;
  return `${cur.slice(0, open)}\n\n${body}\n\n${cur.slice(b)}`;
}

const PINS: Pin[] = [
  { file: "packages/mcp/src/http.ts", text: (s) => s.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${V}";`) },
  {
    file: "packages/mcp/server.json",
    json: (j) => ({ ...j, version: V, packages: j.packages.map((p: Json) => (p.identifier === pkg.name ? { ...p, version: V } : p)) }),
  },
  { file: "packages/mcp/plugin/.claude-plugin/plugin.json", json: (j) => ({ ...j, version: V }) },
  { file: ".claude-plugin/marketplace.json", json: (j) => ({ ...j, plugins: j.plugins.map((p: Json) => (p.name === "genclass" ? { ...p, version: V } : p)) }) },
  { file: "packages/mcp/plugin/.mcp.json", json: (j) => ({ ...j, mcpServers: { ...j.mcpServers, genclass: serverConfig(V) } }) },
  {
    file: "packages/mcp/plugin/hooks/hooks.json",
    json: (j) => ({ ...j, hooks: { ...j.hooks, UserPromptSubmit: j.hooks.UserPromptSubmit.map((g: Json) => ({ ...g, hooks: g.hooks.map((h: Json) => (/@genclass\/mcp\b/.test(h.command) ? { ...h, command: hookCommand(V) } : h)) })) } }),
  },
  { file: "packages/mcp/plugin/plugin.json", json: (j) => ({ ...j, version: V }) },
  { file: "packages/mcp/plugin/mcp.json", json: (j) => ({ ...j, mcpServers: { ...j.mcpServers, genclass: { type: "stdio", ...serverConfig(V) } } }) },
  { file: ".cursor-plugin/marketplace.json", json: (j) => ({ ...j, plugins: j.plugins.map((p: Json) => (p.name === "genclass" ? { ...p, version: V } : p)) }) },
  { file: "gemini-extension.json", json: (j) => ({ ...j, version: V, mcpServers: { ...j.mcpServers, genclass: serverConfig(V) } }) },
  { file: "packages/mcp/README.md", text: (s) => section(s, installMarkdown(V)).replace(PINNED, pinned(V)) },
  { file: "packages/mcp/plugin/README.md", text: (s) => s.replace(PINNED, pinned(V)) },
  { file: "packages/mcp/plugin/skills/genclass/SKILL.md", text: (s) => s.replace(PINNED, pinned(V)) },
  // the root copy for skill directories: equal to the plugin's skill (read at check time: after the sync pinned it)
  { file: "skills/genclass/SKILL.md", text: () => read("packages/mcp/plugin/skills/genclass/SKILL.md") },
  { file: "llms-install.md", text: (s) => s.replace(PINNED, pinned(V)) },
  { file: "docs/adoption/listings/mcp.md", text: (s) => s.replace(PINNED, pinned(V)) },
  { file: "docs/runtime/AGENT.md", text: (s) => s.replace(PINNED, pinned(V)) },
  { file: "README.md", text: (s) => s.replace(PINNED, pinned(V)) },
  { file: "packages/runtime/README.md", text: (s) => s.replace(PINNED, pinned(V)) },
];

function read(file: string): string {
  return readFileSync(join(repo, file), "utf8");
}

describe("versions and pinned launchers (every manifest names package.json's version)", () => {
  for (const p of PINS) {
    it(p.file, () => {
      const cur = read(p.file);
      if (p.json) {
        const want = p.json(JSON.parse(cur));
        if (SYNC && JSON.stringify(want) !== JSON.stringify(JSON.parse(cur))) writeFileSync(join(repo, p.file), `${JSON.stringify(want, null, 2)}\n`);
        else expect(JSON.parse(cur)).toEqual(want);
      } else {
        const want = p.text!(cur);
        if (SYNC && want !== cur) writeFileSync(join(repo, p.file), want);
        else expect(cur).toBe(want);
      }
    });
  }

  it("the server reports package.json's version", () => {
    if (!SYNC) expect(VERSION).toBe(V);
  });

  it("no launcher of @genclass/mcp is left unpinned", () => {
    const unpinned = /npx(?: -y)? @genclass\/mcp(?![@\w/-])|"@genclass\/mcp"(?=\s*[\],])/;
    for (const p of PINS) {
      if (p.file.endsWith(".ts") || p.file.endsWith("server.json")) continue;
      const body = read(p.file);
      if (/(\.md|mcp\.json|hooks\.json|gemini-extension\.json)$/.test(p.file)) expect(body, p.file).toContain(`@genclass/mcp@${V}`);
      expect(unpinned.test(body), `${p.file} has an unpinned @genclass/mcp launcher`).toBe(false);
    }
  });

  it("the plugin folder has what Anthropic's directory blocks without: a README of 40 words or more, a license, version, author, description", () => {
    // claude.com/docs/plugins/pre-submission-checklist: people who install a plugin get only its folder
    const words = read("packages/mcp/plugin/README.md").split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(40);
    const p = JSON.parse(read("packages/mcp/plugin/.claude-plugin/plugin.json"));
    for (const k of ["license", "version", "description", "author"]) expect(p[k], k).toBeTruthy();
    for (const k of ["homepage", "documentationUrl", "supportUrl", "privacyPolicyUrl"]) expect(p[k], k).toMatch(/^https:\/\//);
  });

  it("the plugin folder ships no package.json, lockfile or node_modules (the directory holds a lockfile install for review; the plugin's repository vendors the server instead)", () => {
    for (const f of ["package.json", "package-lock.json", "node_modules"]) expect(existsSync(join(pkgDir, "plugin", f)), f).toBe(false);
  });

  it("every client block names the pinned package and nothing else", () => {
    for (const c of CLIENTS) {
      const b = c.block(V);
      expect(b, c.id).toContain(`@genclass/mcp@${V}`);
      expect(/@genclass\/mcp(?![@\w/-])/.test(b.replace(/@genclass\/mcp@\d[^\s"'\],)]*/g, "")), c.id).toBe(false);
    }
  });
});

/** The symptom words a client matches on: in the instructions' first 500 characters and early in the skill's description. */
const SYMPTOMS = ['"sometimes"', '"randomly"', '"only in production"', '"on slow connections"', '"flips back"', "stale or old results", "lost edits", "double submits", "scrolls sideways"];

describe("the genclass skill and the server's instructions (AGENT.md section 4.2: the instructions carry the triggers, the skill the procedure)", () => {
  const skill = read("packages/mcp/plugin/skills/genclass/SKILL.md");
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  const fields: Record<string, string> = {};
  for (const line of parts?.[1].split("\n") ?? []) {
    const i = line.indexOf(":");
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = parts?.[2] ?? "";

  it("the frontmatter parses: name genclass, one-line description of at most 1,024 characters (Claude Code's limit) with the symptom words early", () => {
    expect(parts, "frontmatter between --- lines").not.toBeNull();
    expect(fields.name).toBe("genclass");
    expect(fields.description.length).toBeGreaterThan(80);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    // a plain YAML scalar: no ": " or " #" inside it, not opened with a quote it does not close
    expect(fields.description).not.toMatch(/: | #/);
    expect(fields.description).not.toMatch(/^["']/);
    for (const w of SYMPTOMS) expect(fields.description.slice(0, 400), w).toContain(w);
  });

  it("every genclass_* name in the body is a tool the server registers", () => {
    const names = [...new Set(body.match(/\bgenclass_[a-z_]+/g))];
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const n of names) expect(TOOLS.map((t) => t.name), n).toContain(n);
  });

  it("the body is the procedure (not the triggers again), with the fallback when the tools are missing, and no em-dash", () => {
    for (const s of ["runs: 6, slow_ms: 600", "--repeat-each 8 --workers 1", "Compared: 6 of 6", "No verdict", "0 compared", "Internal state only", "Along the way only", '"not reproduced"', '"no race in N orders"', 'not "fixed"']) expect(body).toContain(s);
    expect(body).toContain(`claude mcp add genclass -- npx -y @genclass/mcp@${V}`);
    expect(body).toContain("npx @genclass/runtime@beta scan <url> --json");
    expect(body).toMatch(/needs\s+Claude Code/);
    expect(body).toContain("the chat app cannot");
    // the triggers live in the description and in INSTRUCTIONS; the body does not restate them
    expect(body).not.toContain('"sometimes"');
    expect(body).not.toMatch(/\bUse when\b/);
    expect(skill).not.toContain("—");
  });

  it("the root copy for skill directories (skills/genclass/SKILL.md) is byte-identical to the plugin's", () => {
    expect(read("skills/genclass/SKILL.md")).toBe(skill);
  });

  it("the instructions stay under 4,096 characters, put the symptom words in the first 500 and name the skill", () => {
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
    for (const w of SYMPTOMS) expect(INSTRUCTIONS.slice(0, 500), w).toContain(w);
    expect(INSTRUCTIONS).toContain("genclass skill");
    expect(INSTRUCTIONS).not.toContain("—");
  });
});

describe("the Codex marketplace at the repository root (.agents/plugins/marketplace.json)", () => {
  it("points at the plugin folder with Codex's required policy fields", () => {
    // developers.openai.com/plugins/build/plugins: source.path starts with ./ and stays inside the root; policy.installation,
    // policy.authentication (ON_INSTALL or ON_USE) and category are required on each entry
    const m = JSON.parse(read(".agents/plugins/marketplace.json"));
    expect(m.name).toBe("genclass");
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: "genclass", source: { source: "local", path: "./packages/mcp/plugin" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" } });
    expect(typeof m.plugins[0].category).toBe("string");
  });
});

/** Every file under `dir`, as paths relative to it (symlinks are listed, not followed). */
function walk(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel)).flatMap((n) => {
    const r = rel ? `${rel}/${n}` : n;
    return lstatSync(join(dir, r)).isDirectory() ? walk(dir, r) : [r];
  });
}

/** A package folder with the shape plugin-repo.mjs vendors (package.json, bin/genclass-mcp.mjs, dist/cli.js) at V,
 * whose runCli only prints the version. For when this package is not built. */
function stubPackage(): string {
  const dir = mkdtempSync(join(tmpdir(), "genclass-mcp-stub-"));
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PACKAGE, version: V }));
  writeFileSync(join(dir, "dist", "cli.js"), `var VERSION = "${V}";\nasync function runCli(args, io) {\n  io.out(\`\${VERSION}\\n\`);\n  return 0;\n}\nexport { runCli };\n//# sourceMappingURL=cli.js.map\n`);
  writeFileSync(join(dir, "bin", "genclass-mcp.mjs"), readFileSync(join(pkgDir, "bin", "genclass-mcp.mjs")));
  return dir;
}

describe("the plugin's own repository (packages/mcp/scripts/plugin-repo.mjs assembles genclass-dev/genclass-plugin)", () => {
  const plugin = join(pkgDir, "plugin");
  const script = join(pkgDir, "scripts", "plugin-repo.mjs");
  // the server to vendor: this package when it is built (CI builds before the tests), a stub of the same shape otherwise
  const server = existsSync(join(pkgDir, "dist", "cli.js")) ? pkgDir : stubPackage();
  const out = mkdtempSync(join(tmpdir(), "genclass-plugin-repo-"));
  execFileSync(process.execPath, [script, out, "--server", server], { stdio: "pipe" });
  const at = (f: string) => readFileSync(join(out, f), "utf8");
  /** The two files the repository changes from the plugin folder. */
  const LAUNCHERS = [".mcp.json", "hooks/hooks.json"];
  const BIN = "${CLAUDE_PLUGIN_ROOT}/server/genclass-mcp.mjs";

  it("is the plugin folder at the root, byte for byte except the two Claude Code launchers, plus the licence and the Gemini manifest", () => {
    const files = walk(plugin);
    for (const f of LAUNCHERS) expect(files).toContain(f);
    for (const f of files) if (!LAUNCHERS.includes(f)) expect(readFileSync(join(out, f)), f).toEqual(readFileSync(join(plugin, f)));
    expect(at("LICENSE")).toBe(read("LICENSE"));
    expect(at("gemini-extension.json")).toBe(read("gemini-extension.json"));
  });

  it(".mcp.json and the hook run the vendored server from ${CLAUDE_PLUGIN_ROOT}, and nothing else in them changes", () => {
    const mcp = JSON.parse(at(".mcp.json"));
    const srcMcp = JSON.parse(readFileSync(join(plugin, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.genclass).toEqual({ command: "node", args: [BIN] });
    expect({ ...mcp, mcpServers: { ...mcp.mcpServers, genclass: srcMcp.mcpServers.genclass } }).toEqual(srcMcp);
    const hooks = JSON.parse(at("hooks/hooks.json"));
    const srcHooks = JSON.parse(readFileSync(join(plugin, "hooks/hooks.json"), "utf8"));
    const entries = hooks.hooks.UserPromptSubmit.flatMap((g: Json) => g.hooks);
    expect(entries.map((h: Json) => h.command)).toEqual([`node "${BIN}" hook`]);
    expect(entries[0]).toMatchObject({ type: "command", timeout: srcHooks.hooks.UserPromptSubmit[0].hooks[0].timeout });
    for (const f of LAUNCHERS) {
      expect(at(f), f).not.toContain("npx");
      expect(at(f), f).not.toContain("@genclass/mcp");
    }
  });

  it("server/cli.mjs is the package's dist/cli.js byte for byte, server/genclass-mcp.mjs its bin importing that file", () => {
    expect(readFileSync(join(out, "server/cli.mjs"))).toEqual(readFileSync(join(server, "dist", "cli.js")));
    const bin = at("server/genclass-mcp.mjs");
    const orig = readFileSync(join(server, "bin", "genclass-mcp.mjs"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(bin).toContain(`Vendored from ${PACKAGE}@${V}`);
    expect(bin).toContain('from "./cli.mjs"');
    expect(bin).not.toContain("../dist/cli.js");
    // the two note lines after the shebang are the only addition
    const lines = bin.split("\n");
    expect([lines[0], ...lines.slice(3)].join("\n")).toBe(orig.replace('from "../dist/cli.js"', 'from "./cli.mjs"'));
  });

  it("the vendored server runs: --version prints package.json's version", () => {
    const v = execFileSync(process.execPath, [join(out, "server/genclass-mcp.mjs"), "--version"], { stdio: "pipe" }).toString().trim();
    expect(v).toBe(V);
  });

  it("the Agent Plugins mcp.json keeps the pinned npx launcher (that format has no plugin-root variable; Codex and Cursor read it)", () => {
    expect(JSON.parse(at("mcp.json")).mcpServers.genclass).toEqual({ type: "stdio", ...serverConfig(V) });
  });

  it("its marketplace files point at the root and carry package.json's version", () => {
    const claude = JSON.parse(at(".claude-plugin/marketplace.json"));
    expect(claude.name).toBe("genclass");
    expect(claude.plugins[0]).toMatchObject({ name: "genclass", source: "./", version: V });
    const codex = JSON.parse(at(".agents/plugins/marketplace.json"));
    expect(codex.plugins[0]).toMatchObject({ name: "genclass", source: { source: "local", path: "./" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" } });
    const cursor = JSON.parse(at(".cursor-plugin/marketplace.json"));
    expect(cursor.plugins[0]).toMatchObject({ name: "genclass", source: "./", version: V });
  });

  it("has nothing Anthropic's directory blocks or holds: no symlinks, no system files, no package.json, lockfile or node_modules, every non-image file under 256 KiB, 512 files or fewer", () => {
    // claude.com/docs/plugins/pre-submission-checklist, and the directory's hold texts of 2026-10-28
    const files = walk(out);
    expect(files.length).toBeLessThanOrEqual(512);
    for (const f of files) {
      expect(lstatSync(join(out, f)).isSymbolicLink(), `${f} is a symlink`).toBe(false);
      expect(/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX|package\.json|package-lock\.json|node_modules)(\/|$)/.test(f), f).toBe(false);
      if (!/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(f)) expect(statSync(join(out, f)).size, `${f} over 256 KiB`).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("its workflow re-runs this script from GenClass-lib, stands still while npm does not serve the version, and touches nothing by hand", () => {
    const y = at(".github/workflows/sync.yml");
    expect(y).toContain("repository: genclass-dev/GenClass-lib");
    expect(y).toContain("node lib/packages/mcp/scripts/plugin-repo.mjs out");
    expect(y).toContain("--exclude .git --exclude .github");
    expect(y).toContain('[ "$rc" = 3 ]');
    expect(y).toContain("rm -rf lib out");
  });

  it("without --server, vendors the release from npm (or exits 3 while npm does not serve package.json's version)", () => {
    const dir = mkdtempSync(join(tmpdir(), "genclass-plugin-repo-npm-"));
    try {
      execFileSync(process.execPath, [script, dir], { stdio: "pipe", timeout: 120_000 });
    } catch (e) {
      const err = e as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
      const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (err.status === 3) {
        console.warn(`manifests.test: ${text.trim()}`);
        return;
      }
      if (/E(?:NOTFOUND|AI_AGAIN|CONNRESET|TIMEDOUT|NETUNREACH|CONNREFUSED)|FETCH_ERROR/.test(text)) {
        console.warn(`manifests.test: npm is unreachable, so the fetch path of plugin-repo.mjs is not checked\n${text}`);
        return;
      }
      throw e;
    }
    const cli = readFileSync(join(dir, "server/cli.mjs"), "utf8");
    expect(cli).toContain(`VERSION = "${V}"`);
    expect(cli.length).toBeGreaterThan(10_000);
    expect(existsSync(join(dir, "server/genclass-mcp.mjs"))).toBe(true);
  }, 150_000);
});
