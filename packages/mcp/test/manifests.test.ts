// Every version and pinned launcher that ships with this package or that directories read (the server's VERSION, the
// MCP Registry entry, the Claude Code plugin and its marketplace entry, the repo-root manifests, the README's
// install section) equals package.json's version, and no launcher is unpinned. With GENCLASS_SYNC=1
// (`npm run sync -w @genclass/mcp`) the test rewrites those files from package.json instead of failing. The same sync
// keeps the repo-root copy of the skill (skills/genclass/SKILL.md, what skill directories such as skills.sh read)
// byte-identical to the plugin's. The second describe checks the skill and the server's instructions: the
// instructions carry the triggers, the skill the procedure (docs/runtime/AGENT.md section 4.2).
// The plugin folder also ships the launcher's lockfile for Anthropic's directory (its "Launcher lock missing" warning:
// a package.json and package-lock.json next to the manifest that declares the server, with exact versions, registry
// sources and hashes): plugin/package.json names @genclass/mcp at package.json's version, plugin/package-lock.json
// what npm resolved that to. Only `npm install --package-lock-only --ignore-scripts` in packages/mcp/plugin writes the
// lock, and only once npm serves the version, so a version bump leaves it at the previous release until the new one
// is published: the lock pin allows that while npm does not serve package.json's version (asked with `npm view` in
// that state only; an unreachable npm counts as unknown, and the lagging lock passes with a note that vitest shows
// with --silent=false), fails once npm serves it, and the sync regenerates the lock with that npm command. A release
// is therefore: bump, sync, tag; after the publish, sync again and commit.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** A file and what it must hold for version V: a JSON edit (compared as data), a text edit (compared as text), or
 * the launcher's lockfile, which only npm writes (checkLock; the header says when it may lag). */
interface Pin {
  file: string;
  json?: (cur: Json) => Json;
  text?: (cur: string) => string;
  lock?: true;
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
  // the launcher's lockfile (see the header): package.json names the version, the lock what npm resolved it to
  { file: "packages/mcp/plugin/package.json", json: (j) => ({ ...j, dependencies: { ...j.dependencies, [PACKAGE]: V } }) },
  { file: "packages/mcp/plugin/package-lock.json", lock: true },
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

const PLUGIN_DIR = join(pkgDir, "plugin");
const REGISTRY = "https://registry.npmjs.org/";
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
/** npm's codes for a version the registry does not serve (`npm view`: E404; `npm install`: ETARGET). */
const UNPUBLISHED = new Set(["E404", "ETARGET"]);

/** Runs npm in `cwd` with its output captured: `code` is "ok", npm's error code, or "unknown" when it gave none. */
function npm(args: string[], cwd: string): { code: string; out: string } {
  try {
    return { code: "ok", out: execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 60_000, shell: process.platform === "win32" }).toString() };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
    return { code: /(?:npm (?:error|ERR!) code |"code":\s*")(E[A-Z0-9_]+)/.exec(out)?.[1] ?? "unknown", out };
  }
}

/** Whether npm serves @genclass/mcp at `v`; null when npm could not say (unreachable, for one). */
function npmServes(v: string): boolean | null {
  const r = npm(["view", `${PACKAGE}@${v}`, "version", "--json"], PLUGIN_DIR);
  if (r.code === "ok") return r.out.includes(`"${v}"`);
  if (UNPUBLISHED.has(r.code)) return false;
  console.warn(`manifests.test: npm could not say whether ${PACKAGE}@${v} is published (${r.code}), so the plugin's lockfile is checked at its own version only\n${r.out}`);
  return null;
}

/** What the lock must hold at version `v` (the directory's words: exact versions, registry sources and hashes):
 * lockfileVersion 3, the root's one dependency on @genclass/mcp at v, that entry resolved to v's registry tarball, and
 * every entry with an exact version, a registry source and a sha512 integrity. The problems; none when it holds. */
function lockProblems(lock: Json, v: string): string[] {
  const out: string[] = [];
  if (lock.lockfileVersion !== 3) out.push(`lockfileVersion ${JSON.stringify(lock.lockfileVersion)}, want 3`);
  const deps = lock.packages?.[""]?.dependencies;
  if (JSON.stringify(deps) !== JSON.stringify({ [PACKAGE]: v })) out.push(`root dependencies ${JSON.stringify(deps)}, want ${PACKAGE} at ${v}`);
  const main = `node_modules/${PACKAGE}`;
  const entries = Object.entries(lock.packages ?? {}).filter(([k]) => k !== "") as [string, Json][];
  if (!entries.some(([k]) => k === main)) out.push(`no ${main} entry`);
  for (const [k, e] of entries) {
    if (!EXACT.test(String(e.version))) out.push(`${k}: version ${JSON.stringify(e.version)} is not exact`);
    if (typeof e.resolved !== "string" || !e.resolved.startsWith(REGISTRY)) out.push(`${k}: resolved ${JSON.stringify(e.resolved)} is not a registry source`);
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(e.integrity))) out.push(`${k}: no sha512 integrity`);
  }
  const m = lock.packages?.[main];
  if (m && m.version !== v) out.push(`${main}: version ${m.version}, want ${v}`);
  const tarball = `${REGISTRY}${PACKAGE}/-/${PACKAGE.split("/")[1]}-${v}.tgz`;
  if (m && m.resolved !== tarball) out.push(`${main}: resolved ${m.resolved}, want ${tarball}`);
  return out;
}

/** The lock pin: at V, or, between a version bump and its release while npm does not serve V, at the previous release
 * and consistent at that version. With GENCLASS_SYNC=1 a lock that is not at V is regenerated by npm first. */
function checkLock(file: string): void {
  const path = join(repo, file);
  const lock = (): Json => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  let problems = lockProblems(lock(), V);
  let unpublished = false;
  if (problems.length && SYNC) {
    const r = npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], PLUGIN_DIR);
    if (r.code === "ok") problems = lockProblems(lock(), V);
    else if (UNPUBLISHED.has(r.code)) unpublished = true;
    else throw new Error(`npm could not regenerate ${file} (${r.code}):\n${r.out}`);
  }
  if (problems.length) {
    const own = lock().packages?.[`node_modules/${PACKAGE}`]?.version as string | undefined;
    if (own && own !== V && EXACT.test(own) && (unpublished || npmServes(V) !== true)) {
      console.warn(`manifests.test: ${file} is at ${own} while npm does not serve ${PACKAGE}@${V}; after the release, npm run sync -w @genclass/mcp regenerates it`);
      expect(lockProblems(lock(), own), `${file} at ${own}`).toEqual([]);
      return;
    }
  }
  expect(problems, `${file}: npm install --package-lock-only --ignore-scripts in packages/mcp/plugin writes it (npm run sync -w @genclass/mcp does that once npm serves ${PACKAGE}@${V})`).toEqual([]);
}

describe("versions and pinned launchers (every manifest names package.json's version)", () => {
  for (const p of PINS) {
    it(p.file, () => {
      if (p.lock) return checkLock(p.file);
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
    }, p.lock ? 120_000 : undefined); // the lock pin may run npm twice
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
    expect(skill).not.toContain("\u2014");
  });

  it("the root copy for skill directories (skills/genclass/SKILL.md) is byte-identical to the plugin's", () => {
    expect(read("skills/genclass/SKILL.md")).toBe(skill);
  });

  it("the instructions stay under 4,096 characters, put the symptom words in the first 500 and name the skill", () => {
    expect(INSTRUCTIONS.length).toBeLessThan(4096);
    for (const w of SYMPTOMS) expect(INSTRUCTIONS.slice(0, 500), w).toContain(w);
    expect(INSTRUCTIONS).toContain("genclass skill");
    expect(INSTRUCTIONS).not.toContain("\u2014");
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

describe("the plugin's own repository (packages/mcp/scripts/plugin-repo.mjs assembles genclass-dev/genclass-plugin)", () => {
  const out = mkdtempSync(join(tmpdir(), "genclass-plugin-repo-"));
  execFileSync(process.execPath, [join(pkgDir, "scripts", "plugin-repo.mjs"), out], { stdio: "pipe" });
  const at = (f: string) => readFileSync(join(out, f), "utf8");

  it("is the plugin folder at the root, byte for byte, plus the licence and the Gemini manifest", () => {
    const plugin = join(pkgDir, "plugin");
    for (const f of walk(plugin)) expect(readFileSync(join(out, f)), f).toEqual(readFileSync(join(plugin, f)));
    expect(at("LICENSE")).toBe(read("LICENSE"));
    expect(at("gemini-extension.json")).toBe(read("gemini-extension.json"));
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

  it("has nothing Anthropic's directory blocks or holds: no symlinks, no system files, every non-image file under 256 KiB, 512 files or fewer", () => {
    // claude.com/docs/plugins/pre-submission-checklist
    const files = walk(out);
    expect(files.length).toBeLessThanOrEqual(512);
    for (const f of files) {
      expect(lstatSync(join(out, f)).isSymbolicLink(), `${f} is a symlink`).toBe(false);
      expect(/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)/.test(f), f).toBe(false);
      if (!/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf)$/i.test(f)) expect(statSync(join(out, f)).size, `${f} over 256 KiB`).toBeLessThanOrEqual(256 * 1024);
    }
  });

  it("its workflow re-runs this script from GenClass-lib and touches nothing by hand", () => {
    const y = at(".github/workflows/sync.yml");
    expect(y).toContain("repository: genclass-dev/GenClass-lib");
    expect(y).toContain("node lib/packages/mcp/scripts/plugin-repo.mjs out");
    expect(y).toContain("--exclude .git --exclude .github");
  });
});
