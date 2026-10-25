// `@genclass/playwright/fixture`: Playwright's `test` with GenClass on every page, and the `expect` that goes with it.
//
//   // playwright.config.ts
//   use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },
//   reporter: [["list"], ["@genclass/playwright/reporter"]],
//
//   // a spec
//   import { test, expect } from "@genclass/playwright/fixture";
//
// For each test it puts @genclass/runtime on the page before the app's first script (observe mode, telemetry off,
// the model skipped unless asked), applies the seeded chaos when one is given, and at the end writes one
// "genclass-races/1" file to `outDir` (default test-results/genclass next to the config) with what the runtime saw
// and the seed and chaos that produced it, which the reporter turns into the pull-request comment. Observe only: the
// fixture never holds, delays or changes anything the app does; chaos changes when a response arrives, never what
// it says. A test's outcome is never changed by a finding. `enabled: false` makes the fixture inert: the page is
// Playwright's own and nothing is written.

import { test as base, expect } from "@playwright/test";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DEFAULT_SEED, describeMatch, resolveChaos, type ChaosMatch, type ChaosMatchFn, type ChaosOptions } from "./chaos.js";
import { install, type Collected, type PageLike } from "./install.js";
import { buildRacesFile, racesFileName, writeRacesFile } from "./races.js";
import type { GenClassRacesFile } from "./types.js";

export interface GenClassOptions {
  /** false: the fixture does nothing (no runtime on the page, no file). Default true. */
  enabled?: boolean;
  /** Only "observe": the runtime reports and never holds, delays or changes anything. Guard and heal are not for tests. */
  mode?: "observe";
  /**
   * "skip" (default): no model download (13 MB), so the file carries the runtime's witnesses (overwrote-newer,
   * identical-in-flight), facts computed without the model, and no model diagnoses or confidences. "load": the
   * runtime loads its model (from `modelUrl`, else the package default on jsDelivr) and the file also carries its
   * detections with their confidence.
   */
  model?: "skip" | "load";
  /** With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). */
  modelUrl?: string;
  /** Seeded network chaos (ChaosOptions; `true` for the defaults). Off unless given. */
  chaos?: ChaosOptions | true | false;
  /** Where the files go, relative to the Playwright config's directory. Default "test-results/genclass". */
  outDir?: string;
  /** @genclass/runtime's dist/ directory. Default: the installed package's. */
  runtimeDir?: string;
}

export interface GenClassFixtures {
  genclass: GenClassOptions;
}

/** The parts of Playwright's TestInfo the fixture reads. */
export interface TestInfoLike {
  titlePath: readonly string[];
  file: string;
  testId: string;
  repeatEachIndex: number;
  project: { name: string; testDir: string };
  config: { configFile?: string; rootDir: string };
}

/** The test's name in the file: "[project] file.spec.ts > describe > title" (the project only when it has a name). */
export function testName(info: TestInfoLike): string {
  const path = [...info.titlePath];
  // Playwright's title path is ["", project, file, ...describes, title]; find the file to be safe about the shape
  const rel = relative(info.project.testDir, info.file).split(sep).join("/");
  let at = path.findIndex((t) => t === rel || t.split(sep).join("/") === rel);
  if (at < 0) at = path.findIndex((t) => t.endsWith(".ts") || t.endsWith(".js") || t.endsWith(".mjs") || t.endsWith(".tsx") || t.endsWith(".jsx"));
  const titles = at >= 0 ? path.slice(at) : path.filter(Boolean);
  if (at >= 0 && titles[0] !== rel && rel) titles[0] = rel;
  const name = titles.join(" > ") || info.testId;
  const project = info.project.name;
  return project ? `[${project}] ${name}` : name;
}

/** The directory the file goes to: `outDir` against the config's directory (else the root dir). */
export function outDirOf(info: TestInfoLike, outDir?: string): string {
  const base = info.config.configFile ? dirname(info.config.configFile) : info.config.rootDir;
  if (!outDir) return join(base, "test-results", "genclass");
  return isAbsolute(outDir) ? outDir : join(base, outDir);
}

export interface GenClassRun {
  /** What the page reported and the file written for it (null while the test runs or when disabled). */
  readonly collected: Collected | null;
  readonly file: GenClassRacesFile | null;
  readonly path: string | null;
}

/**
 * Starts the fixture on a page for one test: installs the runtime (and chaos), and returns what to call when the
 * test ends. Exported for tests and for custom fixtures; `test` below does this on its `page`.
 */
export async function startGenClass(page: PageLike, options: GenClassOptions | undefined, info: TestInfoLike): Promise<{ finish(): Promise<GenClassRun> }> {
  const o = options ?? {};
  const empty: GenClassRun = { collected: null, file: null, path: null };
  if (o.enabled === false) return { finish: async () => empty };
  if (o.mode !== undefined && o.mode !== "observe") throw new Error(`@genclass/playwright: genclass.mode must be "observe" (got ${JSON.stringify(o.mode)}): guard and heal are not for tests`);
  if (o.model !== undefined && o.model !== "skip" && o.model !== "load") throw new Error(`@genclass/playwright: genclass.model must be "skip" or "load" (got ${JSON.stringify(o.model)})`);
  const chaos = o.chaos ? resolveChaos(o.chaos, info.repeatEachIndex) : null;
  const seed = chaos ? chaos.seed : DEFAULT_SEED + Math.max(0, Math.floor(info.repeatEachIndex) || 0);
  const session = await install(page, { runtimeDir: o.runtimeDir, model: o.model ?? "skip", modelUrl: o.modelUrl, chaos });
  return {
    async finish(): Promise<GenClassRun> {
      const collected = await session.finish();
      const file = buildRacesFile({
        test: testName(info),
        seed,
        mode: collected.mode,
        model: collected.model,
        chaos: chaos ? { latencyMs: chaos.delayMs, reorder: chaos.reorder, routes: describeMatch(chaos.match) } : null,
        records: collected.records,
        witnesses: collected.witnesses,
      });
      const path = writeRacesFile(outDirOf(info, o.outDir), racesFileName(file.test, info.testId, seed), file);
      return { collected, file, path };
    },
  };
}

/**
 * Playwright's `test` with GenClass on its `page`. Options come from `use: { genclass: {...} }` in the config or
 * `test.use({ genclass: {...} })` in a spec. Pages opened another way (`context.newPage()`, popups) are not
 * instrumented.
 */
export const test = base.extend<GenClassFixtures>({
  genclass: [{}, { option: true }],
  page: async ({ page, genclass }, use, testInfo) => {
    const run = await startGenClass(page as unknown as PageLike, genclass, testInfo);
    try {
      await use(page);
    } finally {
      try {
        await run.finish();
      } catch (e) {
        // a file that cannot be written is one line, never a failed test
        process.stderr.write(`[@genclass/playwright] could not write the race file: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  },
});

export { expect };
export type { ChaosMatch, ChaosMatchFn, ChaosOptions, Collected };
export { RUNTIME_PATH } from "./chaos.js";
