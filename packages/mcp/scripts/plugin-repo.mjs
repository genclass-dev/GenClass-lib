#!/usr/bin/env node
// Assembles the plugin's own repository, genclass-dev/genclass-plugin, from this package: the plugin folder
// (packages/mcp/plugin) at the repository root, the marketplace files that point at that root (Claude Code, Codex,
// Cursor), the Gemini CLI manifest, the licence, and the workflow that re-runs this script there daily. Why a second
// repository: Anthropic's directory stops validating a repository whose GitHub archive is over 50 MiB (GenClass-lib's
// is 51), and Codex, Gemini CLI, `gh skill` and the skills CLI clone or read a whole repository for one plugin.
// Invariants: everything in that repository comes from here (its sync.yml overwrites all but .git and .github), the
// copied files are byte-identical to the package's, and every version is package.json's. No dependencies.
// Usage: node packages/mcp/scripts/plugin-repo.mjs <out-dir>   (the directory is emptied first)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(pkgDir, "..", "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const V = pkg.version;

/** The repository on GitHub. */
export const REPO = "genclass-dev/genclass-plugin";
/** The plugin's description in the marketplace entries (the monorepo's marketplace says the same). */
const DESCRIPTION = "The GenClass MCP server, a prompt hook that brings new findings to each prompt, and a skill for intermittent and timing-dependent frontend bugs.";

const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

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
    ".github/workflows/sync.yml": `# Keeps this repository equal to what packages/mcp/scripts/plugin-repo.mjs in genclass-dev/GenClass-lib assembles.
# Nothing here is edited by hand: this workflow overwrites everything but .git and .github (the default token cannot
# change workflow files, so this file is updated from GenClass-lib by a person).
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
          node lib/packages/mcp/scripts/plugin-repo.mjs out
          rsync -a --delete --exclude .git --exclude .github --exclude lib --exclude out out/ ./
          rm -rf lib out
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

/** Writes the repository's tree to `out`: the plugin folder, LICENSE, gemini-extension.json, then the generated files. */
export function assemble(out, version = V) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(pkgDir, "plugin"), out, { recursive: true, filter: (p) => !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(p) });
  for (const f of ["LICENSE", "gemini-extension.json"]) cpSync(join(repo, f), join(out, f));
  for (const [file, body] of Object.entries(generated(version))) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    writeFileSync(join(out, file), body);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node packages/mcp/scripts/plugin-repo.mjs <out-dir>");
    process.exit(2);
  }
  assemble(resolve(out));
  console.log(`assembled ${REPO} ${V} in ${resolve(out)}`);
}
