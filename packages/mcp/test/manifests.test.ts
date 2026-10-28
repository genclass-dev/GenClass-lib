// Every version and pinned launcher that ships with this package or that directories read (the server's VERSION, the
// MCP Registry entry, the Claude Code plugin and its marketplace entry, the repo-root manifests, the README's
// install section) equals package.json's version, and no launcher is unpinned. With GENCLASS_SYNC=1
// (`npm run sync -w @genclass/mcp`) the test rewrites those files from package.json instead of failing. The same sync
// keeps the repo-root copy of the skill (skills/genclass/SKILL.md, what skill directories such as skills.sh read)
// byte-identical to the plugin's. The second describe checks the skill and the server's instructions: the
// instructions carry the triggers, the skill the procedure (docs/runtime/AGENT.md section 4.2).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENTS, hookCommand, installMarkdown, pinned, serverConfig } from "../src/clients.js";
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
