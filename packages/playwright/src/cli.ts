// `genclass-playwright-report`: the reporter's last step as a command, for runs where the reporter is not in the
// Playwright config or where shards ran on several machines and their `test-results/genclass/` folders were
// collected into one place:
//
//   npx genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--title <text>] [--quiet]
//
// Default dir `test-results/genclass`, default out `genclass-report.md` (`-`: print only). Exit code 0 whenever the
// report was written, even with nothing flagged or files skipped (a report never fails a build); 1 when the report
// file could not be written; 2 on a usage error.

import { DEFAULT_RACES_DIR, DEFAULT_REPORT_FILE, writeReport } from "./files.js";

export const USAGE = "usage: genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--title <text>] [--quiet]\n";

export interface CliIo {
  cwd: string;
  out(s: string): void;
  err(s: string): void;
}

/** Runs the command with `argv` (without node and the script). Returns the exit code. Never throws. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const dirs: string[] = [];
  let out: string | null = DEFAULT_REPORT_FILE;
  let minSeeds: number | undefined;
  let title: string | undefined;
  let quiet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | null => (i + 1 < argv.length ? argv[++i] : null);
    if (a === "--help" || a === "-h") {
      io.out(USAGE);
      return 0;
    } else if (a === "--out" || a === "-o") {
      const v = value();
      if (v === null || v === "") return usage(io, `${a} needs a file name (or - to print only)`);
      out = v === "-" ? null : v;
    } else if (a === "--min-seeds") {
      const v = value();
      const n = v === null ? NaN : Number(v);
      if (!Number.isInteger(n) || n < 1) return usage(io, `--min-seeds needs a whole number of at least 1, got ${v === null ? "nothing" : JSON.stringify(v)}`);
      minSeeds = n;
    } else if (a === "--title") {
      const v = value();
      if (v === null) return usage(io, "--title needs a text");
      title = v;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else if (a.startsWith("-") && a !== "-") {
      return usage(io, `unknown option ${a}`);
    } else {
      dirs.push(a);
    }
  }
  try {
    const r = writeReport({ dirs: dirs.length ? dirs : [DEFAULT_RACES_DIR], base: io.cwd, outputFile: out, minSeeds, title });
    if (!quiet || r.path === null) io.out(r.markdown);
    if (r.path) io.err(`GenClass report written to ${r.path}\n`);
    return 0;
  } catch (e) {
    io.err(`genclass-playwright-report: could not write the report: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function usage(io: CliIo, why: string): number {
  io.err(`genclass-playwright-report: ${why}\n${USAGE}`);
  return 2;
}
