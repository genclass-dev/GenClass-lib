import { defineConfig } from "tsup";

// Five ESM entries: the pure summariser (`@genclass/playwright` and `@genclass/playwright/summarize`), the
// Playwright reporter (`@genclass/playwright/reporter`, loaded by Playwright by module name, default export), the
// fixture (`@genclass/playwright/fixture`: `test` and `expect`; it imports @playwright/test, a peer dependency, and
// reads @genclass/runtime's dist/ from disk at run time) and the command (`bin/genclass-playwright-report.mjs`
// imports dist/cli.js). No splitting: each entry is one file. Only the peer dependency is external; nothing else is
// imported besides Node built-ins.
export default defineConfig({
  entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", fixture: "src/fixture.ts", cli: "src/cli.ts" },
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
