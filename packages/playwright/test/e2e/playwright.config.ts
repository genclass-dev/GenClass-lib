// The fixture's end-to-end check (run.mjs drives it): the search page from server.mjs, the fixture with seeded chaos,
// five seeds per test (repeatEach: the fixture adds the repeat index to the seed), and this package's reporter, so
// the run ends with test-results/genclass/*.json and genclass-report.md in this directory. Chromium only.
import { defineConfig } from "@playwright/test";

const port = Number(process.env.GENCLASS_E2E_PORT ?? 47431);

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  outputDir: "test-results",
  workers: 1,
  repeatEach: 5,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"], ["@genclass/playwright/reporter"]],
  webServer: {
    command: `node server.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    genclass: {
      chaos: { seed: 1, delayMs: [0, 600], reorder: true },
    },
  },
});
