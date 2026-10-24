import { defineConfig } from "vitest/config";

// The build test (test/module.test.ts) runs a real `nuxt build` of test/fixtures/basic and starts its server, which
// takes a minute on a cold cache: the timeouts allow for it.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
