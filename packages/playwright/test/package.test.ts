// Package invariants: no runtime dependencies (the fixture's needs, @playwright/test and @genclass/runtime, are
// optional peer dependencies), nothing but the fixture imports Playwright, the pure entries use no Node APIs, the
// page script imports nothing at all, the exports map names what tsup builds, the README shows the fixture's exact
// report.

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
  it("has no runtime dependencies; Playwright and the runtime are optional peer dependencies (the fixture's)", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toEqual({ "@genclass/runtime": ">=0.3.0-beta.1", "@playwright/test": ">=1.40.0" });
    expect(pkg.peerDependenciesMeta).toEqual({ "@genclass/runtime": { optional: true }, "@playwright/test": { optional: true } });
    expect(pkg.license).toBe("Apache-2.0");
  });

  it("imports only its own modules and Node built-ins (the pure entries not even those); only the fixture imports Playwright", () => {
    for (const f of ["index.ts", "summarize.ts", "schema.ts", "types.ts", "chaos.ts", "page.ts"]) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^\.\/[a-z]+\.js$/);
    expect(imports(src("page.ts"))).toEqual([]);
    for (const f of ["reporter.ts", "files.ts", "cli.ts", "install.ts", "races.ts"]) for (const i of imports(src(f))) expect(i, `${f}: ${i}`).toMatch(/^(\.\/[a-z]+\.js|node:[a-z]+)$/);
    for (const i of imports(src("fixture.ts"))) expect(i, `fixture.ts: ${i}`).toMatch(/^(\.\/[a-z]+\.js|node:[a-z]+|@playwright\/test)$/);
    // the runtime is never imported: the fixture reads its dist/ from disk and the page loads it from there
    for (const f of ["fixture.ts", "install.ts", "page.ts", "races.ts", "chaos.ts"]) expect(src(f)).not.toMatch(/from "@genclass\/runtime/);
  });

  it("the exports map and the bin name what tsup builds; every entry also has a default condition", () => {
    // "default" because Playwright resolves a reporter id with CommonJS require.resolve, which never matches "import"
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js", default: "./dist/index.js" },
      "./summarize": { types: "./dist/summarize.d.ts", import: "./dist/summarize.js", default: "./dist/summarize.js" },
      "./reporter": { types: "./dist/reporter.d.ts", import: "./dist/reporter.js", default: "./dist/reporter.js" },
      "./fixture": { types: "./dist/fixture.d.ts", import: "./dist/fixture.js", default: "./dist/fixture.js" },
      "./package.json": "./package.json",
    });
    expect(pkg.bin).toEqual({ "genclass-playwright-report": "bin/genclass-playwright-report.mjs" });
    const tsup = readFileSync(join(pkgDir, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('entry: { index: "src/index.ts", summarize: "src/summarize.ts", reporter: "src/reporter.ts", fixture: "src/fixture.ts", cli: "src/cli.ts" }');
    expect(tsup).toContain('external: ["@playwright/test", "@genclass/runtime"]');
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
    expect(entry.peerDependencies).toEqual(pkg.peerDependencies);
    expect(entry.peerDependenciesMeta).toEqual(pkg.peerDependenciesMeta);
    expect(entry.bin).toEqual(pkg.bin);
  });
});

// Playwright loads a reporter named by module id with require.resolve(id, { paths: [configDir] }) (CommonJS
// conditions: require, node, default) and then import()s the file it found. This needs the build: CI builds before
// the tests (and fails here if it did not); a local run without dist/ skips it. playwright-reporter.yml also runs
// a real Playwright run that loads the reporter this way (test/playwright-smoke).
const built = existsSync(join(pkgDir, "dist", "reporter.js"));

describe("package: how Playwright finds the reporter and the fixture", () => {
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
    for (const id of ["@genclass/playwright", "@genclass/playwright/summarize", "@genclass/playwright/fixture"]) expect(realpathSync(require.resolve(id, { paths: [repoRoot] }))).toMatch(/[\\/]dist[\\/](index|summarize|fixture)\.js$/);
  });

  it.runIf(built || Boolean(process.env.CI))("dist/fixture.js exports test and expect, and carries the page script as source text", async () => {
    const mod = (await import(pathToFileURL(join(pkgDir, "dist", "fixture.js")).href)) as Record<string, unknown>;
    expect(typeof mod.test).toBe("function");
    expect(typeof mod.expect).toBe("function");
    expect(typeof mod.startGenClass).toBe("function");
    const text = readFileSync(join(pkgDir, "dist", "fixture.js"), "utf8");
    // the page script is serialised with toString() at run time: the bundle must keep it a plain function
    expect(text).toContain("function genclassPageScript(cfg, runGlobal)");
    expect(text).toContain("__GENCLASS_PLAYWRIGHT__");
  });
});

describe("README", () => {
  it("shows the exact report of the unit-test fixture", () => {
    const readme = readFileSync(join(pkgDir, "README.md"), "utf8");
    expect(readme).toContain("```markdown\n" + FIXTURE_REPORT + "```\n");
  });
});
