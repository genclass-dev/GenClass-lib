import { defineConfig } from "tsup";

// Two ESM entries: the fixture (`@genclass/playwright`) and the reporter (`@genclass/playwright/reporter`).
// No splitting: each entry is one file, so Playwright can load the reporter by path without chunk lookups.
// The functions that run inside the browser (src/page.ts) are serialised by Playwright with toString(): they
// must survive bundling untouched, so no minification and no name mangling.
export default defineConfig({
  entry: { index: "src/index.ts", reporter: "src/reporter.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  treeshake: true,
  external: ["@playwright/test", "@genclass/runtime"],
});
