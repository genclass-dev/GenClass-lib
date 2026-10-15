// `@genclass/playwright/reporter`: a Playwright reporter that, when the run ends, reads the race files the GenClass
// fixture wrote (`test-results/genclass/*.json`, format "genclass-races/1"), writes `genclass-report.md` and prints
// it. It implements Playwright's Reporter interface by shape (onBegin, onEnd, printsToStdio), so it imports nothing
// from Playwright and needs no dependency at run time. It never changes the run's status, never throws into
// Playwright, and reads and writes local files only.
//
//   // playwright.config.ts
//   reporter: [["list"], ["@genclass/playwright/reporter", { outputFile: "genclass-report.md" }]],
//
// Playwright finds a reporter named by module id with require.resolve from the config's directory, so the package's
// "./reporter" export carries a "default" condition (CommonJS resolution does not match "import"); Playwright then
// loads the file with import(), since the package is ESM. printsToStdio() is false, like Playwright's html reporter:
// the report is printed once at the end, so when this is the only reporter listed Playwright still adds its own
// line (or, on CI, dot) reporter for progress and failures.

import { dirname, join } from "node:path";
import { DEFAULT_RACES_DIR, DEFAULT_REPORT_FILE, writeReport } from "./files.js";

export interface GenClassReporterOptions {
  /**
   * Directories with the fixture's files, relative to the config's directory. Default: `test-results/genclass`
   * and `genclass` inside each project's `outputDir` (the same directory unless a project moves it).
   */
  dir?: string | string[];
  /** The report file, relative to the config's directory. Default "genclass-report.md". `false`: print only. */
  outputFile?: string | false;
  /** Do not print the report at the end of the run. Default false. */
  quiet?: boolean;
  /** Seeds a signature must be seen in to be marked reproducible. Default 2 (the fixture's 2-seed rule). */
  minSeeds?: number;
  /** The report's heading. Default "GenClass race report". */
  title?: string;
  /**
   * Keep the report under this many characters so it fits in one GitHub comment. Default 60000; 0: no limit. What is
   * left out, and the note that says so: see SummarizeOptions.maxChars.
   */
  maxChars?: number;
}

/** The parts of Playwright's FullConfig this reporter reads. */
export interface ReporterConfigLike {
  configFile?: string;
  rootDir?: string;
  projects?: readonly { outputDir?: string }[];
}

/** Where messages go (process.stdout / process.stderr by default; replaceable in tests). */
export interface ReporterIo {
  out(s: string): void;
  err(s: string): void;
}

const processIo: ReporterIo = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

export default class GenClassReporter {
  private readonly options: GenClassReporterOptions;
  private readonly io: ReporterIo;
  private base = process.cwd();
  private projectDirs: string[] = [];
  /** The last report written by onEnd (for tests and programmatic use). */
  markdown: string | null = null;
  /** Where onEnd wrote it (null: not written). */
  path: string | null = null;

  constructor(options: GenClassReporterOptions = {}, io: ReporterIo = processIo) {
    this.options = options && typeof options === "object" ? options : {};
    this.io = io;
  }

  /**
   * Always false: this reporter prints only the report, once, at the end. Playwright adds its line/dot reporter when
   * no listed reporter prints to stdio, so listing this one alone still shows progress and failures.
   */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: ReporterConfigLike): void {
    try {
      if (config.configFile) this.base = dirname(config.configFile);
      else if (config.rootDir) this.base = config.rootDir;
      this.projectDirs = (config.projects ?? []).map((p) => p.outputDir).filter((d): d is string => typeof d === "string" && d !== "").map((d) => join(d, "genclass"));
    } catch {
      /* keep the defaults */
    }
  }

  onEnd(): void {
    try {
      const o = this.options;
      const dirs = o.dir !== undefined ? (Array.isArray(o.dir) ? o.dir : [o.dir]) : [DEFAULT_RACES_DIR, ...this.projectDirs];
      const r = writeReport({
        dirs,
        base: this.base,
        outputFile: o.outputFile === false ? null : o.outputFile || DEFAULT_REPORT_FILE,
        minSeeds: o.minSeeds,
        title: o.title,
        maxChars: o.maxChars,
      });
      this.markdown = r.markdown;
      this.path = r.path;
      if (!o.quiet) {
        this.io.out(`\n${r.markdown}\n`);
        if (r.path) this.io.out(`GenClass report written to ${r.path}\n`);
      }
    } catch (e) {
      this.io.err(`[@genclass/playwright] could not write the report: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

export { GenClassReporter };
export { readRacesDirs, writeReport, DEFAULT_RACES_DIR, DEFAULT_REPORT_FILE } from "./files.js";
