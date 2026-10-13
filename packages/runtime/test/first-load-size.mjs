// First-load cost of `@genclass/runtime/auto` and of `GenClass.init()` from the main entry, minified + gzip, as an
// app's bundler ships them (the same measurement as test/bundle.test.ts). Run by the visual-browser CI job against
// this branch's dist/ and main's (the merge base), so the growth is measured, not estimated.
//
//   node test/first-load-size.mjs <dist> [<base dist>] [--max-growth-kb 0.5]
//
// Prints one line per entry and, under GitHub Actions, a table in the job summary. Exits 1 when a growth limit is
// given and an entry grew by that much or more.

import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const args = process.argv.slice(2);
const flag = args.indexOf("--max-growth-kb");
const maxGrowth = flag >= 0 ? Number(args[flag + 1]) : undefined;
const dirs = args.filter((a, i) => !a.startsWith("--") && (flag < 0 || i !== flag + 1));
if (!dirs.length) {
  console.error("usage: node test/first-load-size.mjs <dist> [<base dist>] [--max-growth-kb 0.5]");
  process.exit(2);
}

async function firstLoad(dist, entry) {
  const pkg = dirname(resolve(dist));
  const spec = JSON.stringify(join(resolve(dist), entry));
  const contents = entry === "auto.js" ? `import ${spec};` : `import { GenClass } from ${spec};\nGenClass.init({});`;
  const r = await build({
    stdin: { contents, resolveDir: pkg, loader: "js" },
    bundle: true,
    splitting: true,
    format: "esm",
    minify: true,
    write: false,
    outdir: "/out",
    metafile: true,
    platform: "browser",
    external: ["react", "redux", "zustand"],
    logLevel: "silent",
    absWorkingDir: pkg,
  });
  const outs = r.metafile.outputs;
  const byPath = new Map(r.outputFiles.map((f) => [f.path, f.contents]));
  const first = new Set();
  const walk = (k) => {
    if (first.has(k)) return;
    first.add(k);
    for (const i of outs[k].imports) if (i.kind === "import-statement" && outs[i.path]) walk(i.path);
  };
  walk(Object.keys(outs).find((k) => outs[k].entryPoint === "<stdin>") ?? Object.keys(outs).find((k) => outs[k].entryPoint));
  return [...first].reduce((n, k) => n + gzipSync(byPath.get(resolve(pkg, k)) ?? byPath.get(resolve("/", k)), { level: 9 }).length, 0) / 1024;
}

const rows = [];
let failed = false;
for (const entry of ["auto.js", "index.js"]) {
  const sizes = [];
  for (const d of dirs) {
    if (!existsSync(join(d, entry))) throw new Error(`${join(d, entry)} does not exist: build the runtime first`);
    sizes.push(await firstLoad(d, entry));
  }
  const [head, base] = sizes;
  const growth = base === undefined ? undefined : head - base;
  const over = growth !== undefined && maxGrowth !== undefined && growth >= maxGrowth;
  if (over) failed = true;
  rows.push({ entry, head, base, growth, over });
  console.log(
    `[first-load] ${entry}: ${head.toFixed(3)} KB gzip${base === undefined ? "" : `, main ${base.toFixed(3)} KB, growth ${(growth * 1024).toFixed(0)} B (${growth.toFixed(3)} KB)${maxGrowth !== undefined ? `, limit ${maxGrowth} KB` : ""}${over ? " OVER" : ""}`}`,
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = ["### First-load size (minified + gzip)", "", "| entry | this branch | main (merge base) | growth |", "|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.entry} | ${r.head.toFixed(3)} KB | ${r.base === undefined ? "-" : `${r.base.toFixed(3)} KB`} | ${r.growth === undefined ? "-" : `${(r.growth * 1024).toFixed(0)} B${r.over ? " (over the limit)" : ""}`} |`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}
process.exit(failed ? 1 : 0);
