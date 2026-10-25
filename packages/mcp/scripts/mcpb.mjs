// Builds the MCP Bundle (.mcpb) of this server, for clients that install a local server from one file (Claude
// Desktop; Smithery's local install): `npm run build && npm run bundle` → .mcpb/genclass-<version>.mcpb. The bundle
// holds the built command (bin/genclass-mcp.mjs and dist/cli.js, which bundles everything it imports, Node built-ins
// only, so no node_modules), a package.json that makes dist/ ESM, the README and the license. The manifest is written
// from package.json and the tool list, validated and packed with @anthropic-ai/mcpb (a devDependency; nothing of it
// ships), and the unpacked server must answer an MCP initialize before the bundle counts as built. Nothing is
// published: the release workflow uploads the file as an artifact.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

/** The manifest (MCPB manifest_version 0.3, the current version of MANIFEST.md) for this package and its tools. */
export function manifestFor(pkg, server, tools) {
  return {
    manifest_version: "0.3",
    name: "genclass",
    display_name: "GenClass",
    version: pkg.version,
    description: server.description,
    long_description:
      "GenClass records what happens inside the web pages of your app running on this machine (each click, request and response, the order responses were delivered, what each response wrote into the app's state, uncaught errors), re-runs a page with the network answering in different orders to find race conditions, replays one exact order to prove a fix, and writes a Playwright regression test. The page connects through @genclass/runtime's agent link in a development build. Everything stays on your machine: the bridge listens on 127.0.0.1 only.",
    author: { name: "GenClass", url: "https://genclass.dev" },
    repository: { type: "git", url: "https://github.com/genclass-dev/GenClass-lib" },
    homepage: "https://genclass.dev",
    documentation: "https://github.com/genclass-dev/GenClass-lib/tree/main/packages/mcp#readme",
    support: "https://github.com/genclass-dev/GenClass-lib/issues",
    server: {
      type: "node",
      entry_point: "bin/genclass-mcp.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/bin/genclass-mcp.mjs"],
        // a desktop app starts servers outside any project: keep findings in the user's home, not the app's directory
        env: { GENCLASS_STATE_DIR: "${HOME}/.genclass/agent" },
      },
    },
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    keywords: ["race-condition", "debugging", "playwright", "frontend", "stale-response", "double-submit"],
    license: pkg.license,
    privacy_policies: ["https://github.com/genclass-dev/GenClass-lib/blob/main/packages/mcp/README.md#privacy"],
    compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: pkg.engines.node } },
  };
}

function mcpb(args, cwd) {
  // npx is a .cmd shim on Windows, which Node spawns only through a shell
  execFileSync("npx", ["--no-install", "mcpb", ...args], { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(pkgDir, "server.json"), "utf8"));
  const { TOOLS, VERSION } = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);
  if (VERSION !== pkg.version) throw new Error(`dist/ is version ${VERSION}, package.json ${pkg.version}: run npm run build`);
  const out = join(pkgDir, ".mcpb");
  const stage = join(out, "stage");
  rmSync(out, { recursive: true, force: true });
  for (const [from, to] of [
    ["bin/genclass-mcp.mjs", "bin/genclass-mcp.mjs"],
    ["dist/cli.js", "dist/cli.js"],
    ["README.md", "README.md"],
    ["LICENSE", "LICENSE"],
  ]) {
    mkdirSync(dirname(join(stage, to)), { recursive: true });
    copyFileSync(join(pkgDir, from), join(stage, to));
  }
  writeFileSync(join(stage, "package.json"), `${JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", license: pkg.license, private: true }, null, 2)}\n`);
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifestFor(pkg, server, TOOLS), null, 2)}\n`);
  mcpb(["validate", "manifest.json"], stage);
  const file = join(out, `genclass-${pkg.version}.mcpb`);
  mcpb(["pack", stage, file], pkgDir);

  // the unpacked bundle runs on its own: an MCP initialize gets the server's answer
  const unpacked = join(out, "unpacked");
  mcpb(["unpack", file, unpacked], pkgDir);
  const init = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-check", version: "1" } } })}\n`;
  const r = spawnSync(process.execPath, [join(unpacked, "bin", "genclass-mcp.mjs")], { input: init, env: { ...process.env, GENCLASS_STATE_DIR: "none", GENCLASS_AGENT_PORT: String(40000 + (process.pid % 20000)), GENCLASS_TOKEN_DIR: join(out, "token") }, timeout: 15000, encoding: "utf8" });
  const first = (r.stdout ?? "").split("\n")[0];
  if (!first.includes('"serverInfo":{"name":"genclass"')) throw new Error(`the unpacked bundle did not answer initialize: ${first || r.stderr}`);
  rmSync(unpacked, { recursive: true, force: true });

  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${sha}  genclass-${pkg.version}.mcpb\n`);
  process.stdout.write(`built ${file}\nsha256 ${sha}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`[mcpb] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
