import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// the build-time version constant the ESM build defines (tsup.config.ts), for src/sinks/webhook.ts in tests
// (__GENCLASS_VERSION__, the script tag's, stays undefined here: test/install/cli.test.ts expects its fallback)
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  define: { __GENCLASS_PKG_VERSION__: JSON.stringify(version) },
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**"],
    environment: "node",
    testTimeout: 20000,
  },
});
