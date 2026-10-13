// `@genclass/playwright/reporter`: a Playwright reporter that collects the `genclass` attachment of every test,
// writes the markdown report (and its JSON) and prints it. It never changes the run's status.
//
//   reporter: [["list"], ["@genclass/playwright/reporter", { outputFile: "genclass-report.md" }]]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import { ATTACHMENT_NAME } from "./constants.js";
import { renderMarkdown, summarise, type Summary, type TestInput } from "./summarise.js";
import type { GenClassAttachment } from "./types.js";

export interface GenClassReporterOptions {
  /** Where the markdown goes, relative to the config's rootDir. Default "genclass-report.md". */
  outputFile?: string;
  /** Also write the Summary as JSON: true = next to the markdown (.json), a string = that path, false = no JSON. Default true. */
  json?: boolean | string;
  /** Do not print the report to stdout. Default false. */
  quiet?: boolean;
  /** A diagnosis flagged on more than this many distinct subjects in one run is reported once as a recurring pattern. Default 8. */
  maxSubjectsPerDiagnosis?: number;
}

/** Reads the `genclass` attachment of a test result (body or file), or null. */
export function readAttachment(result: Pick<TestResult, "attachments">): GenClassAttachment | null {
  for (const a of result.attachments) {
    if (a.name !== ATTACHMENT_NAME) continue;
    try {
      const text = a.body ? a.body.toString("utf8") : a.path ? readFileSync(a.path, "utf8") : "";
      if (!text) continue;
      const v = JSON.parse(text) as GenClassAttachment;
      if (v && typeof v === "object" && v.schema === 1) return v;
    } catch {
      /* a broken attachment counts as none */
    }
  }
  return null;
}

export default class GenClassReporter implements Reporter {
  private rootDir = process.cwd();
  private readonly tests = new Map<string, TestInput>();
  private readonly options: GenClassReporterOptions;
  /** The last summary built by onEnd (for tests and programmatic use). */
  summary: Summary | null = null;

  constructor(options: GenClassReporterOptions = {}) {
    this.options = options && typeof options === "object" ? options : {};
  }

  printsToStdio(): boolean {
    return !this.options.quiet;
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    if (config.rootDir) this.rootDir = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      // retries: the last result wins
      this.tests.set(test.id, {
        id: test.id,
        title: test.title,
        titlePath: test.titlePath().filter((s) => s !== ""),
        file: test.location.file,
        line: test.location.line,
        status: result.status,
        attachment: readAttachment(result),
      });
    } catch {
      /* never break the run */
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    try {
      const summary = summarise([...this.tests.values()], { maxSubjectsPerDiagnosis: this.options.maxSubjectsPerDiagnosis });
      this.summary = summary;
      const md = renderMarkdown(summary);
      const mdPath = resolve(this.rootDir, this.options.outputFile || "genclass-report.md");
      mkdirSync(dirname(mdPath), { recursive: true });
      writeFileSync(mdPath, md);
      const json = this.options.json === undefined ? true : this.options.json;
      if (json) {
        const jsonPath = typeof json === "string" ? resolve(this.rootDir, json) : mdPath.replace(/\.md$/i, "") + ".json";
        mkdirSync(dirname(jsonPath), { recursive: true });
        writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
      }
      if (!this.options.quiet) {
        process.stdout.write(`\n${md}\n`);
        process.stdout.write(`GenClass report written to ${mdPath}\n`);
      }
    } catch (e) {
      process.stderr.write(`[@genclass/playwright] could not write the report: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}
