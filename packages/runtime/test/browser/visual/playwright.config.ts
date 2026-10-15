import { defineConfig } from "@playwright/test";

// Measured visual checks in real Chromium (docs/runtime/VISUAL.md section 14): fixture pages with one planted fault
// per marked element (data-expect="<kind>") and clean controls, served by ./server.mjs from the built dist/.
// Needs `npm run build -w @genclass/runtime` first. CI: the visual-browser job in .github/workflows/ci.yml.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 25_000 },
  workers: 2,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../../test-results/visual",
  use: { browserName: "chromium", headless: true, viewport: { width: 1280, height: 800 } },
});
