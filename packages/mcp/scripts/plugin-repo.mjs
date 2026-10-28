#!/usr/bin/env node
// Assembles the plugin's own repository, genclass-dev/genclass-plugin, from this package: the plugin folder
// (packages/mcp/plugin) at the repository root with the server vendored into it, the marketplace files that point at
// that root (Claude Code, Codex, Cursor), the Gemini CLI manifest, the licence, and the workflow that re-runs this
// script there daily. Why a second repository: Anthropic's directory stops validating a repository whose GitHub
// archive is over 50 MiB (GenClass-lib's is 51), and Codex, Gemini CLI, `gh skill` and the skills CLI clone or read a
// whole repository for one plugin. Why the server is vendored there: the directory holds a plugin whose launcher runs
// `npx <package>` for a reviewer, and a lockfile next to that launcher adds a second hold; its own text names the way
// out, the package's built files inside the plugin (each under 256 KiB) run from ${CLAUDE_PLUGIN_ROOT}, with no
// package.json or lockfile. So in that repository `.mcp.json` and the hook run
// `node ${CLAUDE_PLUGIN_ROOT}/server/genclass-mcp.mjs`: server/cli.mjs is the published package's dist/cli.js at
// package.json's version, byte for byte (fetched from npm with nothing run; `--server <package dir>` takes a local
// build instead, for the tests and offline runs), and server/genclass-mcp.mjs is the package's bin/genclass-mcp.mjs
// with its import pointed at that file. The plugin folder in GenClass-lib keeps the npx launchers (the marketplace
// there lists it too, and nothing built is committed here), and the Agent Plugins mcp.json keeps npx everywhere,
// because that format has no plugin-root variable (Codex and Cursor read it).
// Invariants: everything in that repository comes from here (its sync.yml overwrites all but .git and .github); the
// copied files are byte-identical to the package's except the two Claude Code launchers; every version is
// package.json's; the vendored server is the release of that version. Exit code 3 means npm does not serve
// package.json's version yet (between a bump and its release): the repository then stays at its previous sync.
// No dependencies.
// Usage: node packages/mcp/scripts/plugin-repo.mjs <out-dir> [--server <package dir>]   (the directory is emptied first)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const V = pkg.version;

/** The repository on GitHub. */
export const REPO = "genclass-dev/genclass-plugin";
/** The published package the server is vendored from. */
export const PACKAGE = pkg.name;
/** The vendored server's folder in that repository and its two files: the package's bin, and its dist/cli.js (as
 * .mjs, so Node runs it as a module without a package.json next to it). */
export const SERVER_DIR = "server";
export const SERVER_BIN = `${SERVER_DIR}/genclass-mcp.mjs`;
export const SERVER_JS = `${SERVER_DIR}/cli.mjs`;
/** The bin's path as `.mcp.json` and the hook write it: Claude Code expands ${CLAUDE_PLUGIN_ROOT} to the installed
 * plugin's folder in both. */
export const SERVER_PATH = "${CLAUDE_PLUGIN_ROOT}/" + SERVER_BIN;
/** The hook's command (a shell line, so the path is quoted). */
export const HOOK_COMMAND = `node "${SERVER_PATH}" hook`;
/** The directory reads no file over this size; a larger one is held for review. */
export const FILE_LIMIT = 256 * 1024;
/** The exit code for a version npm does not serve yet. */
export const EXIT_UNPUBLISHED = 3;
/** The plugin's description in the marketplace entries (the monorepo's marketplace says the same). */
const DESCRIPTION = "The GenClass MCP server, a prompt hook that brings new findings to each prompt, and a skill for intermittent and timing-dependent frontend bugs.";
/** Never copied from the plugin folder: system files, and anything that would make the directory install something. */
const SKIPPED = /(^|[\\/])(\.DS_Store|Thumbs\.db|package\.json|package-lock\.json|node_modules)$/;
/** npm's codes for a version the registry does not serve (`npm install`: ETARGET; `npm view`: E404). */
const UNPUBLISHED = new Set(["ETARGET", "E404"]);

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

/** Thrown when npm does not serve the package at the wanted version. */
export class Unpublished extends Error {}

/** The files the script writes, by path in the output directory. Pure: a function of the version. */
export function generated(version) {
  return {
    ".claude-plugin/marketplace.json": json({
      name: "genclass",
      owner: { name: "GenClass", url: "https://genclass.dev" },
      description: "GenClass for Claude Code: see the race, replay it, prove the fix.",
      plugins: [{ name: "genclass", source: "./", description: DESCRIPTION, version, category: "development" }],
    }),
    ".agents/plugins/marketplace.json": json({
      name: "genclass",
      interface: { displayName: "GenClass" },
      plugins: [
        {
          name: "genclass",
          source: { source: "local", path: "./" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
    }),
    ".cursor-plugin/marketplace.json": json({
      name: "genclass",
      owner: { name: "GenClass" },
      metadata: { description: "GenClass for coding agents: see the race, replay it, prove the fix." },
      plugins: [{ name: "genclass", source: "./", description: DESCRIPTION, version, category: "development" }],
    }),
    ".gitignore": ".DS_Store\nThumbs.db\n",
    ".github/workflows/sync.yml": `# Keeps this repository equal to what packages/mcp/scripts/plugin-repo.mjs in genclass-dev/GenClass-lib assembles
# (that script fetches the released server from npm and vendors it under server/). Nothing here is edited by hand:
# this workflow overwrites everything but .git and .github (the default token cannot change workflow files, so this
# file is updated from GenClass-lib by a person). Exit code 3 from the script means GenClass-lib's version is not on
# npm yet (between a bump and its release): the repository then stays as it is.
name: Sync from GenClass-lib
on:
  schedule:
    - cron: "23 6 * * *"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: genclass-dev/GenClass-lib
          ref: main
          path: lib
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Assemble from GenClass-lib
        run: |
          SHA=$(git -C lib rev-parse --short HEAD)
          rc=0; node lib/packages/mcp/scripts/plugin-repo.mjs out || rc=$?
          if [ "$rc" = 0 ]; then rsync -a --delete --exclude .git --exclude .github --exclude lib --exclude out out/ ./; fi
          rm -rf lib out
          if [ "$rc" = 3 ]; then echo "GenClass-lib's version is not on npm yet: nothing to do until the release"; exit 0; fi
          [ "$rc" = 0 ] || exit "$rc"
          echo "SHA=$SHA" >> "$GITHUB_ENV"
      - name: Commit and push when something changed
        run: |
          git add -A
          if git diff --cached --quiet; then echo "nothing changed"; exit 0; fi
          git -c user.name=genclass-sync -c user.email=noreply@genclass.dev commit -m "sync from GenClass-lib $SHA"
          git push
`,
  };
}

/** The two Claude Code launchers with the vendored server in place of npx: `.mcp.json`'s genclass server runs node on
 * the bin, the hook that mentions the package runs the same with `hook`; everything else in both files stays. Pure:
 * the plugin folder's manifests in (parsed), the repository's texts out. */
export function vendored(mcp, hooks) {
  const events = Object.fromEntries(
    Object.entries(hooks.hooks ?? {}).map(([event, groups]) => [
      event,
      groups.map((g) => ({ ...g, hooks: g.hooks.map((h) => (/@genclass\/mcp\b/.test(h.command ?? "") ? { ...h, command: HOOK_COMMAND } : h)) })),
    ]),
  );
  return {
    ".mcp.json": json({ ...mcp, mcpServers: { ...mcp.mcpServers, genclass: { command: "node", args: [SERVER_PATH] } } }),
    "hooks/hooks.json": json({ ...hooks, hooks: events }),
  };
}

/** The package's bin with its import pointed at the vendored cli.mjs, and a note after the shebang. Pure. */
export function vendoredBin(bin, version) {
  const from = 'from "../dist/cli.js"';
  if (!bin.includes(from)) throw new Error(`bin/genclass-mcp.mjs no longer imports ../dist/cli.js; update plugin-repo.mjs`);
  const note =
    `// Vendored from ${PACKAGE}@${version} by packages/mcp/scripts/plugin-repo.mjs in genclass-dev/GenClass-lib: cli.mjs next\n` +
    `// to this file is that package's dist/cli.js, byte for byte, and this file is its bin/genclass-mcp.mjs importing it.\n`;
  const i = bin.startsWith("#!") ? bin.indexOf("\n") + 1 : 0;
  return bin.slice(0, i) + note + bin.slice(i).replace(from, 'from "./cli.mjs"');
}

/** Runs npm with its output captured: `code` is "ok", npm's error code, or "unknown" when it gave none. */
function npm(args, cwd) {
  try {
    return { code: "ok", out: execFileSync("npm", args, { cwd, stdio: "pipe", timeout: 120_000, shell: process.platform === "win32" }).toString() };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
    return { code: /(?:npm (?:error|ERR!) code |"code":\s*")(E[A-Z0-9_]+)/.exec(out)?.[1] ?? "unknown", out };
  }
}

/** The published package at `version`, installed by npm into a temporary prefix with no script run (so what it
 * resolves is checked against the registry's integrity). Returns the package's folder and the prefix to remove.
 * Throws Unpublished when npm does not serve that version. */
export function fetchPackage(version) {
  const tmp = mkdtempSync(join(tmpdir(), "genclass-plugin-server-"));
  const r = npm(["install", `${PACKAGE}@${version}`, "--prefix", tmp, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save"], tmp);
  if (r.code !== "ok") {
    rmSync(tmp, { recursive: true, force: true });
    if (UNPUBLISHED.has(r.code)) throw new Unpublished(`npm does not serve ${PACKAGE}@${version} (${r.code}); after the release, the sync vendors it`);
    throw new Error(`npm could not fetch ${PACKAGE}@${version} (${r.code}):\n${r.out}`);
  }
  return { dir: join(tmp, "node_modules", ...PACKAGE.split("/")), tmp };
}

/** Writes the repository's tree to `out`: the plugin folder (minus what SKIPPED names), LICENSE, gemini-extension.json,
 * the generated files, the two vendored launchers and the server from `server` (a package folder with bin/ and dist/,
 * at `version`; fetched from npm when not given). */
export function assemble(out, { version = V, server } = {}) {
  const fetched = server ? null : fetchPackage(version);
  try {
    const src = server ?? fetched.dir;
    const srcVersion = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;
    if (srcVersion !== version) throw new Error(`${src} is ${PACKAGE}@${srcVersion}, not ${version}`);
    const cli = readFileSync(join(src, "dist", "cli.js"));
    if (cli.length > FILE_LIMIT) throw new Error(`dist/cli.js is ${cli.length} bytes; the directory reads nothing over ${FILE_LIMIT}`);
    const bin = vendoredBin(readFileSync(join(src, "bin", "genclass-mcp.mjs"), "utf8"), version);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(pkgDir, "plugin"), out, { recursive: true, filter: (p) => !SKIPPED.test(p) });
    for (const f of ["LICENSE", "gemini-extension.json"]) cpSync(join(repo, f), join(out, f));
    const mcp = JSON.parse(readFileSync(join(out, ".mcp.json"), "utf8"));
    const hooks = JSON.parse(readFileSync(join(out, "hooks", "hooks.json"), "utf8"));
    const files = { ...generated(version), ...vendored(mcp, hooks), [SERVER_BIN]: bin, [SERVER_JS]: cli };
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(out, file)), { recursive: true });
      writeFileSync(join(out, file), body);
    }
    return { server: src, serverBytes: statSync(join(out, SERVER_JS)).size };
  } finally {
    if (fetched) rmSync(fetched.tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--server");
  const server = i >= 0 ? args.splice(i, 2)[1] : undefined;
  const out = args[0];
  if (!out || (i >= 0 && !server)) {
    console.error("usage: node packages/mcp/scripts/plugin-repo.mjs <out-dir> [--server <package dir>]");
    process.exit(2);
  }
  try {
    const r = assemble(resolve(out), { server: server && resolve(server) });
    console.log(`assembled ${REPO} ${V} in ${resolve(out)} (server: ${server ? r.server : `${PACKAGE}@${V} from npm`}, ${r.serverBytes} bytes)`);
  } catch (e) {
    if (e instanceof Unpublished) {
      console.error(e.message);
      process.exit(EXIT_UNPUBLISHED);
    }
    throw e;
  }
}
