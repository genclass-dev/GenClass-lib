// The Playwright reporter and the command, on a temporary directory laid out like a Playwright project: the
// fixture's files in test-results/genclass, the report written next to the config. No browser, no Playwright.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, USAGE } from "../src/cli.js";
import { readRacesDirs } from "../src/files.js";
import GenClassReporter, { GenClassReporter as NamedReporter } from "../src/reporter.js";
import { FIXTURE_REPORT, here, racesDir } from "./helpers.js";

let root = "";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s: string) => void out.push(s), err: (s: string) => void err.push(s) } };
}

function project(): void {
  mkdirSync(join(root, "test-results"), { recursive: true });
  cpSync(racesDir, join(root, "test-results", "genclass"), { recursive: true });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genclass-playwright-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("reporter: reads test-results/genclass at the end of the run", () => {
  it("writes genclass-report.md next to the config and prints it", () => {
    project();
    const o = io();
    const r = new GenClassReporter({}, o.sink);
    // false, so that listed alone it does not stop Playwright from adding its own line/dot reporter
    expect(r.printsToStdio()).toBe(false);
    r.onBegin({ configFile: join(root, "playwright.config.ts"), rootDir: join(root, "tests"), projects: [{ outputDir: join(root, "test-results") }, { outputDir: join(root, "test-results") }] });
    r.onEnd();
    const path = join(root, "genclass-report.md");
    expect(readFileSync(path, "utf8")).toBe(FIXTURE_REPORT);
    expect(r.markdown).toBe(FIXTURE_REPORT);
    expect(r.path).toBe(path);
    expect(o.out).toEqual([`\n${FIXTURE_REPORT}\n`, `GenClass report written to ${path}\n`]);
    expect(o.err).toEqual([]);
  });

  it("also reads `genclass` inside a project's own outputDir", () => {
    mkdirSync(join(root, "out", "chromium"), { recursive: true });
    cpSync(racesDir, join(root, "out", "chromium", "genclass"), { recursive: true });
    const o = io();
    const r = new GenClassReporter({ quiet: true }, o.sink);
    r.onBegin({ configFile: join(root, "playwright.config.ts"), projects: [{ outputDir: join(root, "out", "chromium") }] });
    r.onEnd();
    expect(r.markdown).toContain("4 files read in `test-results/genclass`, `out/chromium/genclass`");
    expect(r.markdown).toContain("**1 reproducible**");
  });

  it("quiet: writes the file and prints nothing", () => {
    project();
    const o = io();
    const r = new GenClassReporter({ quiet: true, outputFile: "reports/races.md" }, o.sink);
    expect(r.printsToStdio()).toBe(false);
    r.onBegin({ configFile: join(root, "playwright.config.ts") });
    r.onEnd();
    expect(readFileSync(join(root, "reports", "races.md"), "utf8")).toBe(FIXTURE_REPORT);
    expect(o.out).toEqual([]);
  });

  it("outputFile false: prints only", () => {
    project();
    const o = io();
    const r = new GenClassReporter({ outputFile: false }, o.sink);
    r.onBegin({ configFile: join(root, "playwright.config.ts") });
    r.onEnd();
    expect(existsSync(join(root, "genclass-report.md"))).toBe(false);
    expect(r.path).toBeNull();
    expect(o.out).toEqual([`\n${FIXTURE_REPORT}\n`]);
  });

  it("dir, minSeeds and title options", () => {
    cpSync(racesDir, join(root, "races"), { recursive: true });
    const o = io();
    const r = new GenClassReporter({ dir: "races", minSeeds: 3, title: "Races", quiet: true }, o.sink);
    r.onBegin({ configFile: join(root, "playwright.config.ts") });
    r.onEnd();
    expect(r.markdown).toContain("## Races\n");
    expect(r.markdown).toContain("**0 reproducible** (flagged in 3 or more seeds of the same test) · 4 files read in `races`");
  });

  it("no files: a report that says where it looked", () => {
    const o = io();
    const r = new GenClassReporter({ quiet: true }, o.sink);
    r.onBegin({ configFile: join(root, "playwright.config.ts") });
    r.onEnd();
    expect(readFileSync(join(root, "genclass-report.md"), "utf8")).toContain("No GenClass race files were found in `test-results/genclass`.");
  });

  it("never throws into Playwright: a report it cannot write goes to stderr", () => {
    writeFileSync(join(root, "blocker"), "a file, not a directory");
    const o = io();
    const r = new GenClassReporter({ outputFile: "blocker/genclass-report.md" }, o.sink);
    r.onBegin({ configFile: join(root, "playwright.config.ts") });
    expect(() => r.onEnd()).not.toThrow();
    expect(o.err).toHaveLength(1);
    expect(o.err[0]).toMatch(/^\[@genclass\/playwright\] could not write the report: /);
    expect(() => new GenClassReporter(undefined, o.sink).onBegin({} as never)).not.toThrow();
  });

  it("is the default export and a named export", () => {
    expect(NamedReporter).toBe(GenClassReporter);
  });

  it("maxChars: the written report fits the limit (default 60000, what one GitHub comment holds)", () => {
    bigRaceFile(join(root, "test-results", "genclass"));
    const small = new GenClassReporter({ quiet: true, maxChars: 5000 }, io().sink);
    small.onBegin({ configFile: join(root, "playwright.config.ts") });
    small.onEnd();
    expect(readFileSync(join(root, "genclass-report.md"), "utf8")).toBe(small.markdown);
    expect(small.markdown!.length).toBeLessThanOrEqual(5000);
    expect(small.markdown).toContain("_Shortened to fit 5000 characters: ");
    expect(small.markdown).toContain("**200 signatures** in 1 test");

    const unlimited = new GenClassReporter({ quiet: true, outputFile: false, maxChars: 0 }, io().sink);
    unlimited.onBegin({ configFile: join(root, "playwright.config.ts") });
    unlimited.onEnd();
    expect(unlimited.markdown!.length).toBeGreaterThan(60000);
    expect(unlimited.markdown).not.toContain("Shortened");

    const byDefault = new GenClassReporter({ quiet: true, outputFile: false }, io().sink);
    byDefault.onBegin({ configFile: join(root, "playwright.config.ts") });
    byDefault.onEnd();
    expect(byDefault.markdown!.length).toBeLessThanOrEqual(60000);
    expect(byDefault.markdown).toContain("_Shortened to fit 60000 characters: ");
  });
});

/** One race file with 200 signatures and long evidence lines (well over 60000 characters of report). */
function bigRaceFile(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const signatures = Array.from({ length: 200 }, (_, i) => ({
    sig: `request|duplicate|POST /api/r${i}`,
    trigger: "request",
    diagnosis: "duplicate",
    op: `POST /api/r${i}`,
    confidence: 0.9,
    evidence: `request ${i}: ${"word ".repeat(70).trim()}`,
    seeds: [1],
  }));
  writeFileSync(join(dir, "big.json"), JSON.stringify({ schema: "genclass-races/1", test: "big", seed: 1, signatures, shadow: null }));
}

describe("readRacesDirs", () => {
  it("reads *.json directly inside each directory once, in name order, and lists unreadable files", () => {
    project();
    const dir = join(root, "test-results", "genclass");
    writeFileSync(join(dir, "notes.txt"), "not read");
    mkdirSync(join(dir, "nested.json"));
    const r = readRacesDirs(["test-results/genclass", join(root, "test-results", "genclass"), "missing"], root);
    expect(r.searched).toEqual(["test-results/genclass", "missing"]);
    expect(r.files.map((f) => f.name)).toEqual(["test-results/genclass/checkout-1.json", "test-results/genclass/checkout-2.json", "test-results/genclass/search-1.json", "test-results/genclass/search-2.json"]);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = join(dir, "zz-locked.json");
      writeFileSync(locked, "{}");
      chmodSync(locked, 0o000);
      const again = readRacesDirs(["test-results/genclass"], root);
      const last = again.files[again.files.length - 1];
      expect(last.name).toBe("test-results/genclass/zz-locked.json");
      expect(last.error).toMatch(/^could not be read \(/);
      chmodSync(locked, 0o644);
    }
  });
});

describe("genclass-playwright-report (the command)", () => {
  it("defaults: reads test-results/genclass, writes genclass-report.md, prints it", () => {
    project();
    const o = io();
    expect(runCli([], { cwd: root, ...o.sink })).toBe(0);
    expect(readFileSync(join(root, "genclass-report.md"), "utf8")).toBe(FIXTURE_REPORT);
    expect(o.out).toEqual([FIXTURE_REPORT]);
    expect(o.err).toEqual([`GenClass report written to ${join(root, "genclass-report.md")}\n`]);
  });

  it("several directories (collected shards), --out -, --min-seeds, --title, --quiet", () => {
    const names = readdirSync(racesDir).sort();
    mkdirSync(join(root, "shard-1"));
    mkdirSync(join(root, "shard-2"));
    names.forEach((n, i) => cpSync(join(racesDir, n), join(root, i % 2 ? "shard-2" : "shard-1", n)));
    const o = io();
    expect(runCli(["shard-1", "shard-2", "--out", "-"], { cwd: root, ...o.sink })).toBe(0);
    expect(o.out[0]).toContain("**1 reproducible** (flagged in 2 or more seeds of the same test) · 4 files read in `shard-1`, `shard-2`");
    expect(existsSync(join(root, "genclass-report.md"))).toBe(false);

    const q = io();
    expect(runCli(["shard-1", "shard-2", "--min-seeds", "3", "--title", "Shards", "-o", "r.md", "--quiet"], { cwd: root, ...q.sink })).toBe(0);
    expect(q.out).toEqual([]);
    const md = readFileSync(join(root, "r.md"), "utf8");
    expect(md).toContain("## Shards\n");
    expect(md).toContain("**0 reproducible**");
  });

  it("--max-chars: 0 means no limit, a number caps the report", () => {
    bigRaceFile(join(root, "test-results", "genclass"));
    const all = io();
    expect(runCli(["--max-chars", "0", "--out", "-"], { cwd: root, ...all.sink })).toBe(0);
    expect(all.out[0].length).toBeGreaterThan(60000);
    const capped = io();
    expect(runCli(["--max-chars", "3000", "--out", "-"], { cwd: root, ...capped.sink })).toBe(0);
    expect(capped.out[0].length).toBeLessThanOrEqual(3000);
    expect(capped.out[0]).toContain("_Shortened to fit 3000 characters: ");
    const byDefault = io();
    expect(runCli(["--out", "-"], { cwd: root, ...byDefault.sink })).toBe(0);
    expect(byDefault.out[0].length).toBeLessThanOrEqual(60000);
  });

  it("usage errors exit 2 and print the usage", () => {
    for (const argv of [["--min-seeds", "0"], ["--min-seeds"], ["--max-chars", "-1"], ["--max-chars", "1.5"], ["--max-chars"], ["--out"], ["--title"], ["--nope"]]) {
      const o = io();
      expect(runCli(argv, { cwd: root, ...o.sink }), argv.join(" ")).toBe(2);
      expect(o.err.join("")).toContain(USAGE);
    }
    const h = io();
    expect(runCli(["--help"], { cwd: root, ...h.sink })).toBe(0);
    expect(h.out).toEqual([USAGE]);
  });

  it("a report file it cannot write exits 1", () => {
    writeFileSync(join(root, "blocker"), "x");
    const o = io();
    expect(runCli(["--out", "blocker/r.md"], { cwd: root, ...o.sink })).toBe(1);
    expect(o.err[0]).toMatch(/^genclass-playwright-report: could not write the report: /);
  });

  it("the bin script is executable and runs dist/cli.js", () => {
    const bin = join(here, "..", "bin", "genclass-playwright-report.mjs");
    const text = readFileSync(bin, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text).toContain('from "../dist/cli.js"');
    if (process.platform !== "win32") expect(statSync(bin).mode & 0o111).not.toBe(0);
  });
});
