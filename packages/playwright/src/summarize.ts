// `@genclass/playwright/summarize`: "genclass-races/1" files -> one markdown report. Pure: no I/O, no clock, no
// randomness, so the same files always give the same bytes (the input order does not matter either), which is what
// lets a CI job post it as a sticky pull-request comment and a unit test assert it exactly.
//
// What the report says, and what it does not:
//   - per test, one line per signature ("trigger|diagnosis|op"), grouped as duplicate submits, stale responses,
//     failing endpoints and other detections, with the evidence line the runtime printed and the model's
//     confidence. The grouping is by the model's diagnosis label only; nothing here looks at facts or decides what
//     is a bug.
//   - a signature flagged in at least `minSeeds` seeds of the same test (default 2, the fixture's 2-seed rule) is
//     marked reproducible; one seen in fewer may depend on that seed's timing.
//   - totals per group.
//   - nothing about interventions or false interventions: the files do not carry what an action did to the app, so
//     the report makes no claim either way.

import { parseRaces, validateRaces } from "./schema.js";
import type { GenClassRacesFile, RacesFileInput, RacesParseResult } from "./types.js";

/** The report groups, in report order. */
export type RaceCategory = "duplicate" | "stale" | "failing" | "other";

export const CATEGORIES: readonly RaceCategory[] = ["duplicate", "stale", "failing", "other"];

export const CATEGORY_TITLES: Readonly<Record<RaceCategory, string>> = {
  duplicate: "Duplicate submits",
  stale: "Stale responses",
  failing: "Failing endpoints",
  other: "Other detections",
};

/** The default number of seeds a signature must be seen in to count as reproducible. */
export const DEFAULT_MIN_SEEDS = 2;
/** The marker the report starts with, so a CI step can find and update its own comment. */
export const REPORT_MARKER = "<!-- genclass-report -->";

/**
 * The group of a diagnosis label: "duplicate", "stale" and "failing" have their own; everything else (transient,
 * inconsistent, conflict, overload, slow, unusual, a plugin's own labels) is "other". "expected" is not a detection
 * and is left out of the report.
 */
export function categoryOf(diagnosis: string): RaceCategory {
  return diagnosis === "duplicate" || diagnosis === "stale" || diagnosis === "failing" ? diagnosis : "other";
}

export interface SummarizeOptions {
  /** Seeds a signature must be seen in to be marked reproducible. Default 2; values below 1 count as 1. */
  minSeeds?: number;
  /** The report's heading. Default "GenClass race report". */
  title?: string;
  /** Where the files were looked for (shown in the report, e.g. ["test-results/genclass"]). */
  sources?: string[];
  /** Evidence lines longer than this are cut (with "…"). Default 400. */
  maxEvidenceChars?: number;
}

export interface SignatureSummary {
  sig: string;
  trigger: string;
  diagnosis: string;
  op: string;
  category: RaceCategory;
  /** Highest confidence over the seeds it was seen in. */
  confidence: number;
  /** The evidence line of the most confident occurrence (the earliest file by name on a tie). */
  evidence: string;
  /** The seeds it was seen in, sorted. */
  seeds: number[];
  reproducible: boolean;
}

export interface TestSummary {
  test: string;
  /** Every seed the test ran with, as far as the files tell (file seeds and signature seeds), sorted. */
  seeds: number[];
  /** Files read for this test. */
  files: number;
  /** Signatures, in report order: by group, reproducible first, then more seeds, higher confidence, then by sig. */
  signatures: SignatureSummary[];
  /** Modes the files report (when they carry one), sorted. */
  modes: string[];
  /** Files whose model was not "ready" when the fixture collected (they could not flag anything), and the states. */
  modelNotReady: { files: number; states: string[] };
  /** The chaos of the first file (by name) that carries one. */
  chaos?: GenClassRacesFile["chaos"];
}

export interface CategoryTotals {
  signatures: number;
  reproducible: number;
}

export interface RaceSummary {
  minSeeds: number;
  /** Tests in report order: more reproducible signatures first, then more signatures, then by name. */
  tests: TestSummary[];
  /** Files that could not be read, with why (in name order). */
  skipped: { name: string; errors: string[] }[];
  /** Valid files read. */
  files: number;
  sources: string[];
  totals: {
    tests: number;
    testsWithSignatures: number;
    signatures: number;
    reproducible: number;
    byCategory: Record<RaceCategory, CategoryTotals>;
  };
}

interface Acc {
  test: string;
  seeds: Set<number>;
  files: number;
  sigs: Map<string, SignatureSummary>;
  modes: Set<string>;
  notReady: number;
  states: Set<string>;
  chaos?: GenClassRacesFile["chaos"];
}

function byName(a: RacesFileInput, b: RacesFileInput): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Validates the files and groups them by test and by signature. Pure; never throws. */
export function buildSummary(inputs: readonly RacesFileInput[], options: SummarizeOptions = {}): RaceSummary {
  const minSeeds = Math.max(1, Math.floor(typeof options.minSeeds === "number" && Number.isFinite(options.minSeeds) ? options.minSeeds : DEFAULT_MIN_SEEDS));
  const sorted = [...inputs].sort(byName);
  const skipped: RaceSummary["skipped"] = [];
  const tests = new Map<string, Acc>();
  let files = 0;
  for (const input of sorted) {
    const r: RacesParseResult = input.error ? { ok: false, errors: [input.error] } : typeof input.content === "string" ? parseRaces(input.content) : validateRaces(input.content);
    if (!r.ok) {
      skipped.push({ name: input.name, errors: r.errors });
      continue;
    }
    files++;
    const f = r.file;
    const t: Acc = tests.get(f.test) ?? { test: f.test, seeds: new Set(), files: 0, sigs: new Map(), modes: new Set(), notReady: 0, states: new Set() };
    tests.set(f.test, t);
    t.files++;
    t.seeds.add(f.seed);
    if (f.mode) t.modes.add(f.mode);
    const m = f.model;
    if (m === null) {
      t.notReady++;
      t.states.add("not started");
    } else if (m && m.state !== undefined && m.state !== "ready") {
      t.notReady++;
      t.states.add(m.state);
    }
    if (f.chaos && t.chaos === undefined) t.chaos = f.chaos;
    for (const s of f.signatures) {
      if (s.diagnosis === "expected") continue;
      const seeds = s.seeds.length ? s.seeds : [f.seed];
      for (const n of seeds) t.seeds.add(n);
      const prev = t.sigs.get(s.sig);
      if (!prev) {
        t.sigs.set(s.sig, { sig: s.sig, trigger: s.trigger, diagnosis: s.diagnosis, op: s.op, category: categoryOf(s.diagnosis), confidence: s.confidence, evidence: s.evidence, seeds: [...seeds], reproducible: false });
        continue;
      }
      prev.seeds = [...new Set([...prev.seeds, ...seeds])];
      if (s.confidence > prev.confidence) {
        prev.confidence = s.confidence;
        prev.evidence = s.evidence;
      }
    }
  }

  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, { signatures: 0, reproducible: 0 }])) as Record<RaceCategory, CategoryTotals>;
  let signatures = 0;
  let reproducible = 0;
  const out: TestSummary[] = [];
  for (const t of tests.values()) {
    const sigs = [...t.sigs.values()];
    for (const s of sigs) {
      s.seeds.sort((a, b) => a - b);
      s.reproducible = s.seeds.length >= minSeeds;
      byCategory[s.category].signatures++;
      signatures++;
      if (s.reproducible) {
        byCategory[s.category].reproducible++;
        reproducible++;
      }
    }
    sigs.sort(
      (a, b) =>
        CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
        Number(b.reproducible) - Number(a.reproducible) ||
        b.seeds.length - a.seeds.length ||
        b.confidence - a.confidence ||
        cmpStr(a.sig, b.sig),
    );
    const ts: TestSummary = {
      test: t.test,
      seeds: [...t.seeds].sort((a, b) => a - b),
      files: t.files,
      signatures: sigs,
      modes: [...t.modes].sort(),
      modelNotReady: { files: t.notReady, states: [...t.states].sort() },
    };
    if (t.chaos !== undefined) ts.chaos = t.chaos;
    out.push(ts);
  }
  const rep = (t: TestSummary) => t.signatures.filter((s) => s.reproducible).length;
  out.sort((a, b) => rep(b) - rep(a) || b.signatures.length - a.signatures.length || cmpStr(a.test, b.test));
  return {
    minSeeds,
    tests: out,
    skipped,
    files,
    sources: options.sources ? [...options.sources] : [],
    totals: { tests: out.length, testsWithSignatures: out.filter((t) => t.signatures.length > 0).length, signatures, reproducible, byCategory },
  };
}

// ------------------------------------------------------------------------------------------------ rendering

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Escapes text for one line of markdown prose (GitHub flavoured): inline markup (\ ` * _ [ ] < | ~), entity
 * references, and what would start a block at the beginning of the line (# + - = > and "1." / "1)"). Whitespace runs
 * become one space.
 */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<|~])/g, "\\$1")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/^([#+\-=>])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Inline code that survives backticks in the text. */
function code(s: string): string {
  const t = s.replace(/\s+/g, " ").trim() || " ";
  const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(run + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
}

function seedList(seeds: readonly number[]): string {
  return seeds.join(", ");
}

function chaosText(c: NonNullable<GenClassRacesFile["chaos"]>): string {
  const parts: string[] = [];
  if (c.latencyMs) parts.push(c.latencyMs[0] === c.latencyMs[1] ? `latency ${c.latencyMs[0]} ms` : `latency ${c.latencyMs[0]}–${c.latencyMs[1]} ms`);
  if (c.reorder) parts.push("reorder");
  if (typeof c.failRate === "number" && c.failRate > 0) parts.push(`fail rate ${c.failRate}`);
  return parts.length ? parts.join(", ") : "none";
}

function signatureLines(s: SignatureSummary, t: TestSummary, maxEvidence: number): string[] {
  const seen = `${s.seeds.length} of ${plural(t.seeds.length, "seed")} (${seedList(s.seeds)})`;
  const head = `${s.reproducible ? "**Reproducible**: " : ""}${seen} · ${code(s.op || s.sig)} · ${code(`${s.trigger}:${s.diagnosis}`)} · confidence ${s.confidence.toFixed(2)}`;
  const lines = [`- ${head}`];
  const ev = clip(s.evidence, maxEvidence);
  lines.push(ev ? `  > ${escapeMarkdown(ev)}` : "  > (no evidence line in the file)");
  return lines;
}

/** Renders a summary as markdown (what the reporter writes to genclass-report.md and a CI step posts on the PR). */
export function renderMarkdown(s: RaceSummary, options: SummarizeOptions = {}): string {
  const title = options.title?.trim() || "GenClass race report";
  const maxEvidence = typeof options.maxEvidenceChars === "number" && options.maxEvidenceChars > 0 ? Math.floor(options.maxEvidenceChars) : 400;
  const where = s.sources.length ? ` in ${s.sources.map(code).join(", ")}` : "";
  const L: string[] = [REPORT_MARKER, `## ${escapeMarkdown(title)}`, ""];

  if (s.files === 0 && s.skipped.length === 0) {
    L.push(`No GenClass race files were found${where}. This report reads the files the GenClass Playwright fixture writes (one per test, format \`genclass-races/1\`): is the fixture installed, and did the tests run?`);
    return L.join("\n") + "\n";
  }

  const T = s.totals;
  const rule = s.minSeeds === 1 ? "at least 1 seed" : `${s.minSeeds} or more seeds`;
  const head =
    s.files === 0
      ? "**No race file could be read**"
      : T.signatures === 0
        ? `**Nothing flagged** in ${plural(T.tests, "test")}`
        : `**${plural(T.signatures, "signature")}** in ${plural(T.testsWithSignatures, "test")}, **${T.reproducible} reproducible** (flagged in ${rule} of the same test)`;
  const modes = [...new Set(s.tests.flatMap((t) => t.modes))].sort();
  const skipped = s.skipped.length ? `, ${s.skipped.length} skipped` : "";
  L.push(`${head} · ${plural(s.files, "file")} read${where}${skipped}${modes.length ? ` · mode ${modes.join(", ")}` : ""}`);
  L.push("");

  if (T.signatures > 0) {
    L.push("| | signatures | reproducible |");
    L.push("|---|---:|---:|");
    for (const c of CATEGORIES) L.push(`| ${CATEGORY_TITLES[c]} | ${T.byCategory[c].signatures} | ${T.byCategory[c].reproducible} |`);
    L.push("");
  }

  const flagged = s.tests.filter((t) => t.signatures.length > 0);
  const quiet = s.tests.filter((t) => t.signatures.length === 0);
  for (const t of flagged) {
    L.push(`### ${escapeMarkdown(t.test)}`);
    L.push("");
    const meta = [`${plural(t.seeds.length, "seed")} (${seedList(t.seeds)})`, plural(t.signatures.length, "signature")];
    if (t.chaos) meta.push(`chaos: ${chaosText(t.chaos)}`);
    L.push(meta.join(" · "));
    L.push("");
    for (const c of CATEGORIES) {
      const list = t.signatures.filter((x) => x.category === c);
      if (!list.length) continue;
      L.push(`**${CATEGORY_TITLES[c]}**`);
      L.push("");
      for (const x of list) L.push(...signatureLines(x, t, maxEvidence));
      L.push("");
    }
    if (t.modelNotReady.files > 0) {
      L.push(`Note: the model was not ready in ${t.modelNotReady.files} of ${plural(t.files, "file")} for this test (${t.modelNotReady.states.map(escapeMarkdown).join(", ")}); those runs could not flag anything.`);
      L.push("");
    }
  }

  if (quiet.length) {
    L.push(`<details><summary>${plural(quiet.length, "test")} with nothing flagged</summary>`);
    L.push("");
    for (const t of quiet) {
      const notReady = t.modelNotReady.files > 0 ? `; model not ready in ${t.modelNotReady.files} of ${plural(t.files, "file")} (${t.modelNotReady.states.map(escapeMarkdown).join(", ")})` : "";
      L.push(`- ${escapeMarkdown(t.test)} (${plural(t.seeds.length, "seed")}: ${seedList(t.seeds)}${notReady})`);
    }
    L.push("");
    L.push("</details>");
    L.push("");
  }

  if (s.skipped.length) {
    L.push(`### Files skipped (${s.skipped.length})`);
    L.push("");
    for (const k of s.skipped) L.push(`- ${code(k.name)}: ${k.errors.map(code).join("; ")}`);
    L.push("");
  }

  if (T.signatures > 0) {
    L.push("---");
    L.push("");
    L.push(
      `Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). ` +
        `Reproducible: flagged in ${rule} of the same test. ` +
        `A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. ` +
        `Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.`,
    );
  }
  while (L.length && L[L.length - 1] === "") L.pop();
  return L.join("\n") + "\n";
}

/** Files -> markdown: buildSummary + renderMarkdown. Pure; never throws on bad input (bad files are listed as skipped). */
export function summarize(inputs: readonly RacesFileInput[], options: SummarizeOptions = {}): string {
  return renderMarkdown(buildSummary(inputs, options), options);
}

// The format and its validator, so this entry alone is enough for a CI script.
export { RACES_SCHEMA } from "./types.js";
export type { GenClassRacesFile, RaceSignature, RacesFileInput, RacesParseResult } from "./types.js";
export { parseRaces, validateRaces, MAX_ERRORS } from "./schema.js";
