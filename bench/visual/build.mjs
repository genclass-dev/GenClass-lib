#!/usr/bin/env node
// Bundles the page side of the visual bench (page.ts, faults.ts and the engine sources they import from
// packages/runtime/src/visual) into one IIFE, bench/visual/.out/page.js, for page.addInitScript. Harness-only: it
// is never shipped, and the runtime's own build (tsup) does not include it. esbuild comes with tsup (no new
// dependency).

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(HERE, "page.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: join(HERE, ".out/page.js"),
  legalComments: "none",
  logLevel: "warning",
});
console.log("bench/visual/.out/page.js built");
