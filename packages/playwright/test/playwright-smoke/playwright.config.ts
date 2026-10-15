// A real Playwright run with no browser, run by .github/workflows/playwright-reporter.yml after the build. The test in
// races.spec.ts writes the unit-test fixture's race files where the GenClass fixture will write them, and Playwright
// loads this package's reporter by its module name, the way a user's config does (Playwright resolves a reporter id
// with require.resolve from the config's directory, so the "./reporter" export must resolve without the "import"
// condition). Only this reporter is listed: it does not claim stdout, so Playwright adds its own line/dot reporter.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  workers: 1,
  reporter: [["@genclass/playwright/reporter"]],
});
