// The MCP Bundle manifest (scripts/mcpb.mjs): valid against @anthropic-ai/mcpb's own strict schema for the
// manifest_version it declares, every tool listed, the entry point inside the bundle, the version from package.json.
// The bundle itself (pack, unpack, initialize) is built by `npm run bundle` in the release workflow.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb";
// @ts-expect-error a plain .mjs script without types
import { manifestFor } from "../scripts/mcpb.mjs";
import { TOOLS } from "../src/tools.js";

const pkgDir = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(pkgDir, "server.json"), "utf8"));

describe("MCP Bundle manifest (manifest.json)", () => {
  const m = manifestFor(pkg, server, TOOLS);

  it("passes mcpb's strict schema for its manifest_version", () => {
    const schema = (MANIFEST_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; error?: unknown } }>)[m.manifest_version];
    expect(schema, `mcpb has no schema for ${m.manifest_version}`).toBeDefined();
    const r = schema.safeParse(m);
    expect(r.success, JSON.stringify(r.error)).toBe(true);
  });

  it("runs the bundled command with node, names every tool, and takes the version and description from the package", () => {
    expect(m.version).toBe(pkg.version);
    expect(m.description).toBe(server.description);
    expect(m.server).toEqual({ type: "node", entry_point: "bin/genclass-mcp.mjs", mcp_config: { command: "node", args: ["${__dirname}/bin/genclass-mcp.mjs"], env: { GENCLASS_STATE_DIR: "${HOME}/.genclass/agent" } } });
    expect(m.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
});
