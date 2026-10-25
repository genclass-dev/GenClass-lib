import { defineConfig } from "vitest/config";

// Two projects. `unit`: the edit functions, in milliseconds, no network. `e2e`: sv's own add-on test harness
// (sv/testing) scaffolds SvelteKit projects in ts and js, applies the add-on, installs with pnpm, builds them and
// boots each once in Chromium (test/e2e/README in addon.test.ts). `npx vitest run --project unit` runs the first only.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/*.test.ts"],
          environment: "node",
          testTimeout: 20000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/*.test.ts"],
          environment: "node",
          globalSetup: ["test/e2e/global.ts"],
          testTimeout: 5 * 60_000,
          hookTimeout: 10 * 60_000,
          expect: { requireAssertions: true },
        },
      },
    ],
  },
});
