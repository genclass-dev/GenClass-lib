// Reading race files from disk and writing the report (Node only; used by the reporter and the CLI). Reads only
// `*.json` directly inside the given directories, never follows anything else, and sends nothing anywhere.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { summarize, type SummarizeOptions } from "./summarize.js";
import type { RacesFileInput } from "./types.js";

/** Where the fixture writes, relative to the Playwright config's directory. */
export const DEFAULT_RACES_DIR = join("test-results", "genclass");
/** The default report file name. */
export const DEFAULT_REPORT_FILE = "genclass-report.md";

/** A path for display: relative to `base` when inside it, with forward slashes. */
export function displayPath(path: string, base: string): string {
  const r = relative(base, path);
  const shown = r && !r.startsWith("..") && !isAbsolute(r) ? r : path;
  return shown.split(sep).join("/");
}

export interface ReadResult {
  files: RacesFileInput[];
  /** The directories looked in (display paths, de-duplicated, in order). */
  searched: string[];
}

/**
 * Reads every `*.json` file directly inside each directory (missing directories are skipped; the same directory
 * given twice is read once). A file that cannot be read becomes an input with `error`, so the report lists it as
 * skipped instead of dropping it silently. Never throws.
 */
export function readRacesDirs(dirs: readonly string[], base: string): ReadResult {
  const seen = new Set<string>();
  const searched: string[] = [];
  const files: RacesFileInput[] = [];
  for (const d of dirs) {
    const abs = resolve(base, d);
    if (seen.has(abs)) continue;
    seen.add(abs);
    searched.push(displayPath(abs, base));
    let names: string[] = [];
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      names = readdirSync(abs).filter((n) => n.toLowerCase().endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(abs, n);
      try {
        if (!statSync(p).isFile()) continue;
        files.push({ name: displayPath(p, base), content: readFileSync(p, "utf8") });
      } catch (e) {
        files.push({ name: displayPath(p, base), content: null, error: `could not be read (${e instanceof Error ? e.message : String(e)})` });
      }
    }
  }
  return { files, searched };
}

export interface WriteReportOptions extends SummarizeOptions {
  /** Directories to read (relative to `base`). */
  dirs: readonly string[];
  /** Base directory for relative paths. */
  base: string;
  /** Report path (relative to `base`), or null to write no file. */
  outputFile: string | null;
}

/** Reads the files, renders the markdown and writes it (creating the directory). Returns the markdown and where it went. */
export function writeReport(o: WriteReportOptions): { markdown: string; path: string | null; files: number } {
  const { files, searched } = readRacesDirs(o.dirs, o.base);
  const markdown = summarize(files, { ...o, sources: o.sources ?? searched });
  let path: string | null = null;
  if (o.outputFile !== null) {
    path = resolve(o.base, o.outputFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, markdown);
  }
  return { markdown, path, files: files.length };
}
