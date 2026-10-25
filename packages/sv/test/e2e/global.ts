// Global setup for the end-to-end test: sv/testing scaffolds its project templates (kit-js, kit-ts, vite-js,
// vite-ts) into .test-output/.templates, offline, from the templates inside the `sv` package. Before that, the
// runtime this repository builds is packed into .test-output/genclass-runtime.tgz, and the test projects install
// @genclass/runtime from it (a pnpm override), so the test covers the runtime release the add-on asks for even
// before it is on npm. GENCLASS_SV_RUNTIME=registry installs it from npm instead (a check after a release).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { setupGlobal } from "sv/testing";

export const TEST_DIR = path.resolve(import.meta.dirname, "..", "..", ".test-output");
export const RUNTIME_TARBALL = path.join(TEST_DIR, "genclass-runtime.tgz");
const RUNTIME_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "runtime");

export default setupGlobal({
  TEST_DIR,
  pre: async () => {
    if (process.env.GENCLASS_SV_RUNTIME === "registry") return;
    if (!existsSync(path.join(RUNTIME_DIR, "dist", "auto.js"))) {
      throw new Error("The end-to-end test installs the runtime built from this repository: run `npm run build -w @genclass/runtime` first.");
    }
    mkdirSync(TEST_DIR, { recursive: true });
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", TEST_DIR], { cwd: RUNTIME_DIR, encoding: "utf8" });
    const [{ filename }] = JSON.parse(out) as Array<{ filename: string }>;
    renameSync(path.join(TEST_DIR, path.basename(filename)), RUNTIME_TARBALL);
  },
});
