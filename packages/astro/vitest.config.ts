import { defineConfig } from "vitest/config";

// The build test (test/integration.test.ts) runs a real `astro build` of test/fixtures/basic; the timeouts allow for a
// cold cache.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
