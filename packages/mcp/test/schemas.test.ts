// The manifests that registries and directories read, each valid against the published schema it names: the copy kept
// in test/fixtures and the live file at the schema's URL (fetched; skipped with a note when the network is
// unreachable). The MCP Registry entry (server.json) is also consistent with package.json: the registry checks that
// the npm package's mcpName equals the entry's name and refuses a description over 100 characters.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validate } from "./jsonschema.js";

const pkgDir = join(__dirname, "..");
const repo = join(pkgDir, "..", "..");
const read = (file: string) => JSON.parse(readFileSync(join(repo, file), "utf8"));
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const pkg = read("packages/mcp/package.json");
const server = read("packages/mcp/server.json");

/** Each manifest, the schema URL it must name (in `$schema`, or fixed by the directory), and the kept copy. */
const MANIFESTS = [
  { file: "packages/mcp/server.json", url: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", kept: "mcp-registry.server.schema.2025-12-11.json" },
  { file: "packages/mcp/plugin/plugin.json", url: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", kept: "agent-plugins.plugin.schema.1.0.0.json" },
  { file: "packages/mcp/plugin/mcp.json", url: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", kept: "agent-plugins.mcp.schema.1.0.0.json" },
  { file: "glama.json", url: "https://glama.ai/mcp/schemas/server.json", kept: "glama.server.schema.json" },
];

async function live(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  } catch (e) {
    console.warn(`schemas.test: could not fetch ${url} (${(e as Error).message}); checked against the kept copy only`);
    return null;
  }
}

describe("manifests against their published schemas", () => {
  for (const m of MANIFESTS) {
    it(`${m.file} names ${m.url} and is valid against the kept copy`, () => {
      const doc = read(m.file);
      const schema = fixture(m.kept);
      expect(doc.$schema).toBe(m.url);
      expect(schema.$id).toBe(m.url);
      expect(validate(schema, doc)).toEqual([]);
    });

    it(`${m.file} is valid against the live schema`, async (ctx) => {
      const schema = await live(m.url);
      if (!schema) return ctx.skip();
      expect(validate(schema, read(m.file))).toEqual([]);
    });
  }
});

describe("server.json (official MCP Registry, schema 2025-12-11)", () => {
  const schema = fixture("mcp-registry.server.schema.2025-12-11.json");

  it("the validator catches what the registry would reject", () => {
    expect([...server.description].length).toBeLessThanOrEqual(100);
    expect(validate(schema, { ...server, description: "x".repeat(101) })).toEqual(["$.description: 101 characters, more than 100"]);
    expect(validate(schema, { ...server, name: "genclass" })[0]).toMatch(/\$\.name: does not match/);
    expect(validate(schema, { ...server, packages: [{ ...server.packages[0], version: "latest" }] })).toEqual(["$.packages[0].version: matches a schema it must not match"]);
    const { version: _v, ...noVersion } = server;
    expect(validate(schema, noVersion)).toEqual(["$: missing version"]);
  });

  it("matches package.json: mcpName, version, npm identifier, stdio", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } });
    expect(pkg.files).toContain("server.json");
  });
});

describe("Agent Plugins 1.0.0 (plugin.json, mcp.json)", () => {
  it("the validator catches what a conforming client would reject", () => {
    const p = fixture("agent-plugins.plugin.schema.1.0.0.json");
    const m = fixture("agent-plugins.mcp.schema.1.0.0.json");
    const plugin = read("packages/mcp/plugin/plugin.json");
    const mcp = read("packages/mcp/plugin/mcp.json");
    expect(validate(p, { ...plugin, name: "GenClass" })[0]).toMatch(/\$\.name: does not match/);
    expect(validate(p, { ...plugin, channels: [] })[0]).toBe("$.channels: no value allowed");
    const { type: _t, ...untyped } = mcp.mcpServers.genclass;
    expect(validate(m, { ...mcp, mcpServers: { genclass: untyped } })).toEqual(["$.mcpServers.genclass: does not match exactly one of oneOf"]);
    expect(validate(m, { ...mcp, mcpServers: { genclass: { ...mcp.mcpServers.genclass, env: { PLUGIN_ROOT: "x" } } } })).toEqual(["$.mcpServers.genclass: does not match exactly one of oneOf"]);
  });
});

describe("directory manifests without a published schema (checked against their documented fields)", () => {
  it("gemini-extension.json: documented keys only, a lowercase dashed name, the server as in every other client", () => {
    // google-gemini/gemini-cli docs/extensions/reference.md
    const g = read("gemini-extension.json");
    const KEYS = ["name", "version", "description", "mcpServers", "contextFileName", "excludeTools", "migratedTo", "plan", "settings"];
    expect(Object.keys(g).filter((k) => !KEYS.includes(k))).toEqual([]);
    expect(g.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(g.description).toBe(server.description);
    expect(Object.keys(g.mcpServers)).toEqual(["genclass"]);
    if (g.contextFileName) expect(existsSync(join(repo, g.contextFileName))).toBe(true);
  });

  it(".cursor-plugin/marketplace.json: required fields, and its source holds an Agent Plugins plugin.json", () => {
    // cursor.com/docs/reference/plugins.md, "Marketplace manifest fields"
    const c = read(".cursor-plugin/marketplace.json");
    expect(c.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof c.owner.name).toBe("string");
    for (const p of c.plugins) {
      expect(p.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.source).not.toMatch(/(^|\/)\.\.(\/|$)|^\//);
      expect(read(join(p.source, "plugin.json")).name).toBe(p.name);
    }
  });

  it(".claude-plugin/marketplace.json: its plugin source holds the Claude Code plugin", () => {
    const c = read(".claude-plugin/marketplace.json");
    for (const p of c.plugins) expect(read(join(p.source, ".claude-plugin", "plugin.json")).name).toBe(p.name);
  });

  it("the Agent Plugins and Claude Code manifests describe the same plugin", () => {
    const a = read("packages/mcp/plugin/plugin.json");
    const c = read("packages/mcp/plugin/.claude-plugin/plugin.json");
    for (const k of ["name", "version", "description", "homepage", "repository", "license"]) expect(a[k], k).toEqual(c[k]);
    const { type, ...entry } = read("packages/mcp/plugin/mcp.json").mcpServers.genclass;
    expect(type).toBe("stdio");
    expect(entry).toEqual(read("packages/mcp/plugin/.mcp.json").mcpServers.genclass);
  });
});
