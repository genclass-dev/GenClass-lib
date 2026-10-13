import { defineConfig } from "tsup";

// Four ESM entries: the pure summariser (`@genclass/playwright` and `@genclass/playwright/summarize`), the
// Playwright reporter (`@genclass/playwright/reporter`, loaded by Playwright by module name, default export) and the
// command (`bin/genclass-playwright-report.mjs` imports dist/cli.js). No splitting: each entry is one file. Nothing
// is external because nothing is imported besides Node built-ins.
export default defineConfig({
  entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
});
