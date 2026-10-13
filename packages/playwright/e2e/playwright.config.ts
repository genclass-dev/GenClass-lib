import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The reporter workflow's run (.github/workflows/playwright-reporter.yml): the built demos (demos/dist, served the
// way `npm run preview -w @genclass/demos` serves them) and one self-contained page, driven with real input in
// headless Chromium, with the built @genclass/playwright fixture and reporter. The report lands next to this file.
// Not part of the main CI job; run it on a machine that can build the demos and run Chromium.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["@genclass/playwright/reporter", { outputFile: "genclass-report.md" }]],
  outputDir: "test-results",
  use: { browserName: "chromium", headless: true, baseURL: "http://127.0.0.1:4173/genclass/" },
  webServer: {
    command: "node --experimental-strip-types demos/e2e/serve.ts demos/dist --base /genclass/ --port 4173",
    cwd: REPO,
    url: "http://127.0.0.1:4173/genclass/",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
