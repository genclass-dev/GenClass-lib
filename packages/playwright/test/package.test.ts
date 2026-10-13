// Package invariants: no runtime dependencies, nothing imported from Playwright or @genclass/runtime, the pure
// entries use no Node APIs, the exports map names what tsup builds, the README shows the fixture's exact report.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as summarizeEntry from "../src/summarize.js";
import { FIXTURE_REPORT, here } from "./helpers.js";

const pkgDir = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as Record<string, unknown>;
const src = (f: string) => readFileSync(join(pkgDir, "src", f), "utf8");
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

describe("package: dependencies and imports", () => {
  it("has no runtime or peer dependencies", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.license).toBe("Apache-2.0");
  });

  it("imports only its own modules and Node built-ins (and the pure entries not even those)", () => {
    for (const f of ["index.ts", "summarize.ts", "schema.ts", "types.ts"]) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^\.\/[a-z]+\.js$/);
    for (const f of ["reporter.ts", "files.ts", "cli.ts"]) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^(\.\/[a-z]+\.js|node:[a-z]+)$/);
  });

  it("the exports map and the bin name what tsup builds; every entry also has a default condition", () => {
    // "default" because Playwright resolves a reporter id with CommonJS require.resolve, which never matches "import"
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
      "./summarize": { types: "./dist/summarize.d.ts", import: "./dist/summarize.js", default: "./dist/summarize.js" },
      "./reporter": { types: "./dist/reporter.d.ts", import: "./dist/reporter.js", default: "./dist/reporter.js" },
      "./package.json": "./package.json",
    });
    expect(pkg.bin).toEqual({ "genclass-playwright-report": "bin/genclass-playwright-report.mjs" });
    const tsup = readFileSync(join(pkgDir, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", cli: "src/cli.ts" }');
  });

  it("the root entry and /summarize export the same pure API", () => {
    expect(Object.keys(root).sort()).toEqual(Object.keys(summarizeEntry).sort());
    for (const k of ["summarize", "buildSummary", "renderMarkdown", "parseRaces", "validateRaces", "RACES_SCHEMA", "REPORT_MARKER"]) expect(Object.keys(root)).toContain(k);
  });

  it("the root package-lock.json has the workspace entry, matching package.json", () => {
    const lock = JSON.parse(readFileSync(join(pkgDir, "..", "..", "package-lock.json"), "utf8")) as { packages: Record<string, Record<string, unknown>> };
    expect(lock.packages["node_modules/@genclass/playwright"]).toEqual({ resolved: "packages/playwright", link: true });
    const entry = lock.packages["packages/playwright"];
    expect(entry.name).toBe(pkg.name);
    expect(entry.version).toBe(pkg.version);
    expect(entry.dependencies).toBeUndefined();
    expect(entry.devDependencies).toEqual(pkg.devDependencies);
    expect(entry.bin).toEqual(pkg.bin);
  });
});

// Playwright loads a reporter named by module id with require.resolve(id, { paths: [configDir] }) (CommonJS
// conditions: require, node, default) and then import()s the file it found. This needs the build: CI builds before
// the tests (and fails here if it did not); a local run without dist/ skips it. playwright-reporter.yml also runs
// a real Playwright run that loads the reporter this way (test/playwright-smoke).
const built = existsSync(join(pkgDir, "dist", "reporter.js"));

describe("package: how Playwright finds the reporter", () => {
  it.runIf(built || Boolean(process.env.CI))("require.resolve from the repository root finds dist/reporter.js, whose default export is the reporter", async () => {
    const require = createRequire(import.meta.url);
    const repoRoot = join(pkgDir, "..", "..");
    const resolved = require.resolve("@genclass/playwright/reporter", { paths: [repoRoot] });
    expect(realpathSync(resolved)).toBe(realpathSync(join(pkgDir, "dist", "reporter.js")));
    const mod = (await import(pathToFileURL(resolved).href)) as { default: unknown };
    expect(typeof mod.default).toBe("function");
    const reporter = new (mod.default as new (o: object) => { printsToStdio(): boolean; onEnd(): void })({ quiet: true, outputFile: false });
    expect(reporter.printsToStdio()).toBe(false);
    expect(typeof reporter.onEnd).toBe("function");
    for (const id of ["@genclass/playwright", "@genclass/playwright/summarize"]) expect(realpathSync(require.resolve(id, { paths: [repoRoot] }))).toMatch(/[\\/]dist[\\/](index|summarize)\.js$/);
  });
});

describe("README", () => {
  it("shows the exact report of the unit-test fixture", () => {
    const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
    expect(readme).toContain("```markdown\n" + FIXTURE_REPORT + "```\n");
  });
});
