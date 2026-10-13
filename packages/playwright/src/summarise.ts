// The summariser: `genclass` attachments (one per test) -> a Summary -> markdown. Pure (no I/O), unit-tested.
// Rules, from the audit of what makes a PR comment trustworthy:
//   - Findings are the race-class diagnoses (duplicate, stale, conflict, inconsistent). failing, transient, overload,
//     slow and unusual are Info: they usually describe an injected failure or a polling page, and they are collapsed.
//   - One line per (diagnosis, subject with ids normalised) per test, with a count, the exact evidence line the
//     runtime printed (explain().message) and the model's confidence.
//   - A diagnosis that repeats on more than `maxSubjectsPerDiagnosis` distinct subjects in one run is a recurring
//     pattern of the app, not N findings: it is listed once, as such.
//   - "0 false interventions" is stated only where it is known: observe mode never acts, and a run with no
//     intervention has none. With interventions, the report says it cannot tell a right one from a wrong one.
//   - Every number is labelled with the model and the report threshold it was produced with.

import type { ActionSnapshot, DecisionSnapshot, GenClassAttachment } from "./types.js";

export const FINDING_DIAGNOSES: readonly string[] = ["duplicate", "stale", "conflict", "inconsistent"];
export const INFO_DIAGNOSES: readonly string[] = ["failing", "transient", "overload", "slow", "unusual"];
export const DEFAULT_MAX_SUBJECTS = 8;
export const ISSUES_URL = "https://github.com/genclass-dev/GenClass-lib/issues";

const NOUN: Record<string, [string, string]> = {
  duplicate: ["duplicate submit", "duplicate submits"],
  stale: ["stale response", "stale responses"],
  conflict: ["conflicting write", "conflicting writes"],
  inconsistent: ["inconsistent state", "inconsistent states"],
  failing: ["failing endpoint", "failing endpoints"],
  transient: ["transient failure", "transient failures"],
  overload: ["overload", "overloads"],
  slow: ["slow operation", "slow operations"],
  unusual: ["unusual behaviour", "unusual behaviours"],
};

export interface TestInput {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  /** Playwright's outcome of the test itself. */
  status: string;
  attachment: GenClassAttachment | null;
}

export interface Finding {
  diagnosis: string;
  trigger: string;
  /** The subject of the first occurrence (ids kept). */
  subject: string;
  /** Subject with ids normalised: the dedupe key within a test. */
  key: string;
  count: number;
  /** Highest diagnosis confidence among the occurrences. */
  confidence: number;
  /** explain(id).message of the most confident occurrence ("" when the runtime no longer kept it). */
  message: string;
  decisionId: string;
  facts: string[];
  /** The runtime acted on at least one occurrence (guard/heal). */
  acted: boolean;
}

export interface EndpointFailure {
  subject: string;
  key: string;
  count: number;
  diagnoses: Record<string, number>;
}

export interface TestSummary {
  id: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  status: string;
  /** A runtime was read from the page. */
  present: boolean;
  /** When not present: why, in words. */
  absent?: string;
  mode?: string;
  effectiveMode?: string;
  model?: { state: string; name?: string; version?: string; device?: string; variant?: string; error?: string; reason?: string };
  thresholds?: { report: number; guard: number; heal: number; profile?: string };
  decisions: number;
  /** Decisions whose diagnosis was `expected` or below the report threshold. */
  unremarkable: number;
  findings: Finding[];
  info: Finding[];
  failingEndpoints: EndpointFailure[];
  interventions: ActionSnapshot[];
  chaos: GenClassAttachment["chaos"];
  warnings: string[];
}

export interface Summary {
  package: string;
  runtimeVersion: string;
  tests: TestSummary[];
  totals: {
    tests: number;
    withRuntime: number;
    decisions: number;
    findings: Record<string, number>;
    info: Record<string, number>;
    failingEndpoints: number;
    interventions: number;
  };
  /** Model and gate in force, when every test with a runtime agrees; otherwise the most common values. */
  model: { name?: string; version?: string; device?: string; variant?: string; states: Record<string, number> };
  thresholds: { report?: number; guard?: number; heal?: number; profile?: string };
  modes: Record<string, number>;
  /** Diagnoses that repeated on more than maxSubjectsPerDiagnosis distinct subjects: listed once, not as findings. */
  recurring: { diagnosis: string; subjects: number; occurrences: number; example: string }[];
}

export interface SummariseOptions {
  maxSubjectsPerDiagnosis?: number;
}

/** "GET /api/items/42 (#7)" -> "GET /api/items/n (#n)": the dedupe key of a subject. */
export function normaliseSubject(s: string): string {
  return s
    .replace(/#\d+/g, "#n")
    .replace(/\b[0-9a-f]{8,}\b/gi, "n")
    .replace(/\b\d+\b/g, "n")
    .replace(/\s+/g, " ")
    .trim();
}

function reportThreshold(att: GenClassAttachment): number | null {
  const g = att.runtime?.gates;
  if (g && typeof g.report === "number") return g.report;
  for (const e of att.runtime?.audit ?? []) if (e.gate && typeof e.gate.thresholds?.report === "number") return e.gate.thresholds.report;
  return null;
}

function isDetection(d: DecisionSnapshot, report: number | null): boolean {
  if (d.diagnosis === "expected") return false;
  return report === null ? true : d.diagnosisConfidence >= report;
}

function group(decisions: DecisionSnapshot[]): Finding[] {
  const map = new Map<string, Finding>();
  for (const d of decisions) {
    const key = `${d.diagnosis}|${normaliseSubject(d.subject)}`;
    const f = map.get(key);
    const acted = d.executed && d.tier !== "passive";
    if (!f) {
      map.set(key, { diagnosis: d.diagnosis, trigger: d.trigger, subject: d.subject, key: normaliseSubject(d.subject), count: 1, confidence: d.diagnosisConfidence, message: d.message ?? "", decisionId: d.id, facts: d.facts, acted });
      continue;
    }
    f.count++;
    f.acted = f.acted || acted;
    if (d.diagnosisConfidence > f.confidence) {
      f.confidence = d.diagnosisConfidence;
      f.message = d.message ?? f.message;
      f.decisionId = d.id;
      f.facts = d.facts;
      f.subject = d.subject;
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence || b.count - a.count);
}

/** One test's attachment -> its summary (null attachment: the fixture never ran for it). */
export function summariseAttachment(att: GenClassAttachment | null, test?: Partial<Pick<TestInput, "id" | "title" | "titlePath" | "file" | "line" | "status">>): TestSummary {
  const base: TestSummary = {
    id: test?.id ?? "",
    title: test?.title ?? att?.test.title ?? "",
    titlePath: test?.titlePath ?? att?.test.titlePath ?? [],
    file: test?.file ?? att?.test.file ?? "",
    line: test?.line ?? att?.test.line ?? 0,
    status: test?.status ?? "",
    present: false,
    decisions: 0,
    unremarkable: 0,
    findings: [],
    info: [],
    failingEndpoints: [],
    interventions: [],
    chaos: att?.chaos ?? null,
    warnings: att?.warnings ? [...att.warnings] : [],
  };
  if (!att) {
    base.absent = "the genclass fixture did not run for this test";
    return base;
  }
  const rt = att.runtime;
  if (!rt) {
    if (att.injected && !att.injected.ok) base.absent = `the runtime could not be injected${att.injected.error ? `: ${att.injected.error}` : ""}`;
    else if (att.options.install === "app") base.absent = `no runtime at window.${att.options.handle.join(", window.")}`;
    else base.absent = "no runtime was found on the page";
    return base;
  }
  base.present = true;
  base.mode = rt.mode;
  base.effectiveMode = rt.status?.effectiveMode ?? rt.mode;
  base.model = {
    state: rt.status?.state ?? "unknown",
    name: rt.status?.model,
    version: rt.status?.version,
    device: rt.status?.device,
    variant: rt.status?.variant,
    error: rt.status?.error,
    reason: rt.status?.reason,
  };
  const g = rt.gates;
  if (g) base.thresholds = { report: g.report, guard: g.guard, heal: g.heal, profile: g.level };
  const report = reportThreshold(att);
  base.decisions = rt.decisions.length;
  const detected = rt.decisions.filter((d) => isDetection(d, report));
  base.unremarkable = rt.decisions.length - detected.length;
  base.findings = group(detected.filter((d) => FINDING_DIAGNOSES.includes(d.diagnosis)));
  base.info = group(detected.filter((d) => !FINDING_DIAGNOSES.includes(d.diagnosis)));
  const ep = new Map<string, EndpointFailure>();
  for (const d of detected) {
    if (d.trigger !== "failure" && d.diagnosis !== "failing" && d.diagnosis !== "transient") continue;
    const key = normaliseSubject(d.subject);
    const e = ep.get(key) ?? { subject: d.subject, key, count: 0, diagnoses: {} };
    e.count++;
    e.diagnoses[d.diagnosis] = (e.diagnoses[d.diagnosis] ?? 0) + 1;
    ep.set(key, e);
  }
  base.failingEndpoints = [...ep.values()].sort((a, b) => b.count - a.count);
  base.interventions = rt.interventions.filter((a) => a.tier !== "passive");
  if (base.model.state !== "ready" && base.model.state !== "off") base.warnings.push(`model ${base.model.state}${base.model.error ? `: ${base.model.error}` : base.model.reason ? ` (${base.model.reason})` : ""}: no decisions were possible`);
  if (base.model.state === "off") base.warnings.push("no model (model: false or no provider): the runtime only observed, nothing was decided");
  return base;
}

function inc(r: Record<string, number>, k: string, n = 1): void {
  r[k] = (r[k] ?? 0) + n;
}

function mostCommon<T extends string | number>(values: (T | undefined)[]): T | undefined {
  const c = new Map<T, number>();
  for (const v of values) if (v !== undefined) c.set(v, (c.get(v) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [v, k] of c) if (k > n) (best = v), (n = k);
  return best;
}

export function summarise(inputs: TestInput[], opts: SummariseOptions = {}): Summary {
  const max = typeof opts.maxSubjectsPerDiagnosis === "number" && opts.maxSubjectsPerDiagnosis > 0 ? opts.maxSubjectsPerDiagnosis : DEFAULT_MAX_SUBJECTS;
  const tests = inputs.map((t) => summariseAttachment(t.attachment, t));
  // recurring patterns: a diagnosis on more than `max` distinct subjects across the run
  const bySubject = new Map<string, { subjects: Set<string>; occurrences: number; example: string }>();
  for (const t of tests)
    for (const f of [...t.findings, ...t.info]) {
      const r = bySubject.get(f.diagnosis) ?? { subjects: new Set<string>(), occurrences: 0, example: f.message || f.subject };
      r.subjects.add(f.key);
      r.occurrences += f.count;
      bySubject.set(f.diagnosis, r);
    }
  const recurring: Summary["recurring"] = [];
  const suppressed = new Set<string>();
  for (const [diagnosis, r] of bySubject)
    if (r.subjects.size > max) {
      recurring.push({ diagnosis, subjects: r.subjects.size, occurrences: r.occurrences, example: r.example });
      suppressed.add(diagnosis);
    }
  const totals: Summary["totals"] = { tests: tests.length, withRuntime: 0, decisions: 0, findings: {}, info: {}, failingEndpoints: 0, interventions: 0 };
  const modes: Record<string, number> = {};
  const states: Record<string, number> = {};
  for (const t of tests) {
    if (suppressed.size) {
      t.findings = t.findings.filter((f) => !suppressed.has(f.diagnosis));
      t.info = t.info.filter((f) => !suppressed.has(f.diagnosis));
    }
    if (!t.present) continue;
    totals.withRuntime++;
    totals.decisions += t.decisions;
    for (const f of t.findings) inc(totals.findings, f.diagnosis, f.count);
    for (const f of t.info) inc(totals.info, f.diagnosis, f.count);
    totals.failingEndpoints += t.failingEndpoints.length;
    totals.interventions += t.interventions.length;
    inc(modes, t.effectiveMode ?? t.mode ?? "unknown");
    inc(states, t.model?.state ?? "unknown");
  }
  const present = tests.filter((t) => t.present);
  const att = inputs.find((i) => i.attachment)?.attachment;
  return {
    package: att?.package ?? "",
    runtimeVersion: att?.runtimeVersion ?? "",
    tests,
    totals,
    model: {
      name: mostCommon(present.map((t) => t.model?.name)),
      version: mostCommon(present.map((t) => t.model?.version)),
      device: mostCommon(present.map((t) => t.model?.device)),
      variant: mostCommon(present.map((t) => t.model?.variant)),
      states,
    },
    thresholds: {
      report: mostCommon(present.map((t) => t.thresholds?.report)),
      guard: mostCommon(present.map((t) => t.thresholds?.guard)),
      heal: mostCommon(present.map((t) => t.thresholds?.heal)),
      profile: mostCommon(present.map((t) => t.thresholds?.profile)),
    },
    modes,
    recurring,
  };
}

// ------------------------------------------------------------------------------------------------ rendering

function plural(diagnosis: string, n: number): string {
  const nn = NOUN[diagnosis];
  const noun = nn ? (n === 1 ? nn[0] : nn[1]) : diagnosis;
  return `${n} ${noun}`;
}

function countsLine(counts: Record<string, number>, order: readonly string[]): string {
  const parts: string[] = [];
  for (const k of order) if (counts[k]) parts.push(plural(k, counts[k]));
  for (const k of Object.keys(counts)) if (!order.includes(k) && counts[k]) parts.push(plural(k, counts[k]));
  return parts.join(", ");
}

function fmtConf(c: number): string {
  return (Math.round(c * 100) / 100).toFixed(2);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function md(s: string): string {
  return s.replace(/([\\`*_[\]<>])/g, "\\$1");
}

/** The per-test annotation: one line. */
export function oneLine(t: TestSummary): string {
  if (!t.present) return `GenClass: ${t.absent ?? "no runtime"}`;
  const parts: string[] = [];
  const f = countsLine(countFindings(t.findings), FINDING_DIAGNOSES);
  const i = countsLine(countFindings(t.info), INFO_DIAGNOSES);
  parts.push(f ? `findings: ${f}` : "no findings");
  if (i) parts.push(`info: ${i}`);
  parts.push(`${t.decisions} decision${t.decisions === 1 ? "" : "s"}`);
  if (t.interventions.length) parts.push(`${t.interventions.length} intervention${t.interventions.length === 1 ? "" : "s"}`);
  const m = t.model;
  parts.push(`model ${m?.state ?? "unknown"}${m?.device ? ` (${m.device})` : ""}`);
  return `GenClass: ${parts.join(" · ")}`;
}

function countFindings(fs: Finding[]): Record<string, number> {
  const r: Record<string, number> = {};
  for (const f of fs) inc(r, f.diagnosis, f.count);
  return r;
}

function interventionsLine(s: Summary): string {
  const n = s.totals.interventions;
  const observeOnly = Object.keys(s.modes).every((m) => m === "observe" || m === "off");
  if (n === 0 && observeOnly && s.totals.withRuntime > 0) return "Interventions: 0 (observe mode never holds, delays or changes anything)";
  if (n === 0) return "Interventions: 0";
  return `Interventions: ${n} (listed per test; this report cannot tell a correct intervention from a wrong one, your test's own assertions can)`;
}

function modelLine(s: Summary): string {
  const m = s.model;
  const parts: string[] = [];
  if (s.runtimeVersion) parts.push(`@genclass/runtime ${s.runtimeVersion}`);
  if (m.name || m.version) parts.push(`model ${[m.name, m.version].filter(Boolean).join(" ")}${m.device || m.variant ? ` (${[m.device, m.variant].filter(Boolean).join(", ")})` : ""}`);
  const t = s.thresholds;
  if (typeof t.report === "number") parts.push(`report threshold ${t.report}${typeof t.guard === "number" ? `, guard ${t.guard}` : ""}${t.profile ? ` (${t.profile})` : ""}`);
  const states = Object.entries(m.states).filter(([k]) => k !== "ready");
  if (states.length) parts.push(`model not ready in ${states.map(([k, v]) => `${v} test${v === 1 ? "" : "s"} (${k})`).join(", ")}`);
  return parts.join(" · ");
}

function findingLines(fs: Finding[]): string[] {
  const out: string[] = [];
  for (const f of fs) {
    out.push(`- **${f.diagnosis}** ${fmtConf(f.confidence)} · \`${clip(f.subject, 120).replace(/`/g, "'")}\`${f.count > 1 ? ` ×${f.count}` : ""}${f.acted ? " · acted" : ""}`);
    if (f.message) out.push(`  ${md(clip(f.message, 600))}`);
    else if (f.facts.length) out.push(`  ${md(clip(f.facts.slice(0, 4).join("; "), 600))}`);
  }
  return out;
}

function chaosLine(c: GenClassAttachment["chaos"]): string | null {
  if (!c) return null;
  const parts: string[] = [];
  if (c.delayed) parts.push(`${c.delayed} request${c.delayed === 1 ? "" : "s"} delayed ${c.latencyMs[0] === c.latencyMs[1] ? `${c.latencyMs[0]} ms` : `${c.latencyMs[0]}–${c.latencyMs[1]} ms`}`);
  if (c.failed) parts.push(`${c.failed} answered with an injected failure`);
  if (c.reordered) parts.push(`${c.reordered} response${c.reordered === 1 ? "" : "s"} reordered`);
  if (!parts.length) parts.push(`${c.matched} matched request${c.matched === 1 ? "" : "s"}, nothing injected`);
  return `Chaos: ${parts.join(", ")} (seed ${JSON.stringify(c.seed)}).`;
}

/** The markdown report (what the reporter writes and what a CI job posts on the PR). */
export function renderMarkdown(s: Summary): string {
  const L: string[] = [];
  L.push("## GenClass report");
  L.push("");
  const f = countsLine(s.totals.findings, FINDING_DIAGNOSES);
  const i = countsLine(s.totals.info, INFO_DIAGNOSES);
  if (s.totals.withRuntime === 0) L.push(`**GenClass was not on the page in any of the ${s.totals.tests} test${s.totals.tests === 1 ? "" : "s"}.** See below.`);
  else L.push(`**${f ? `Findings: ${f}` : "No findings"}**${i ? ` · Info: ${i}` : ""} · ${interventionsLine(s)}`);
  L.push("");
  const head: string[] = [`${s.totals.tests} test${s.totals.tests === 1 ? "" : "s"}, ${s.totals.withRuntime} with GenClass on the page, ${s.totals.decisions} decision${s.totals.decisions === 1 ? "" : "s"}`];
  const ml = modelLine(s);
  if (ml) head.push(ml);
  const modes = Object.entries(s.modes);
  if (modes.length) head.push(`mode ${modes.map(([m, n]) => (modes.length > 1 ? `${m} ×${n}` : m)).join(", ")}`);
  L.push(head.join(" · "));
  L.push("");
  for (const r of s.recurring) {
    L.push(`> **${r.diagnosis}** was flagged on ${r.subjects} distinct subjects (${r.occurrences} times) in this run. That is a recurring pattern of the app rather than ${r.subjects} separate findings, so it is not counted above. Example: ${md(clip(r.example, 300))}`);
    L.push("");
  }
  const withFindings = s.tests.filter((t) => t.present && (t.findings.length || t.info.length || t.failingEndpoints.length || t.interventions.length));
  const quiet = s.tests.filter((t) => t.present && !withFindings.includes(t));
  const absent = s.tests.filter((t) => !t.present);
  for (const t of withFindings) {
    L.push(`### ${md(t.titlePath.length ? t.titlePath.slice(-2).join(" › ") : t.title)}${t.file ? ` — ${md(shortFile(t.file))}${t.line ? `:${t.line}` : ""}` : ""}`);
    L.push("");
    if (t.findings.length) L.push(...findingLines(t.findings));
    else L.push(`- no findings (${t.decisions} decision${t.decisions === 1 ? "" : "s"})`);
    if (t.failingEndpoints.length) {
      L.push(`- failing endpoints: ${t.failingEndpoints.map((e) => `\`${clip(e.subject, 100).replace(/`/g, "'")}\` ×${e.count} (${Object.entries(e.diagnoses).map(([d, n]) => `${d} ${n}`).join(", ")})`).join("; ")}`);
    }
    if (t.interventions.length) {
      L.push(`- interventions (${t.interventions.length}):`);
      for (const a of t.interventions) L.push(`  - ${a.action} on \`${clip(a.subject, 100).replace(/`/g, "'")}\`${a.ok ? "" : " (failed)"}${a.late ? " (late)" : ""}: ${md(clip(a.changed || "", 300))}`);
    }
    if (t.info.length) {
      L.push("");
      L.push(`<details><summary>Info: ${countsLine(countFindings(t.info), INFO_DIAGNOSES)}</summary>`);
      L.push("");
      L.push(...findingLines(t.info));
      L.push("");
      L.push("</details>");
    }
    const c = chaosLine(t.chaos);
    if (c) L.push("", c);
    if (t.warnings.length) L.push("", ...t.warnings.map((w) => `- ⚠ ${md(w)}`));
    L.push("");
  }
  if (quiet.length) {
    L.push(`<details><summary>Tests with GenClass and no findings (${quiet.length})</summary>`);
    L.push("");
    for (const t of quiet) L.push(`- ${md(t.titlePath.length ? t.titlePath.slice(-2).join(" › ") : t.title)} — ${t.decisions} decision${t.decisions === 1 ? "" : "s"}, model ${t.model?.state ?? "unknown"}${t.warnings.length ? ` ⚠ ${md(t.warnings.join("; "))}` : ""}`);
    L.push("");
    L.push("</details>");
    L.push("");
  }
  if (absent.length) {
    L.push(`<details open><summary>GenClass was not on the page (${absent.length})</summary>`);
    L.push("");
    for (const t of absent) L.push(`- ${md(t.titlePath.length ? t.titlePath.slice(-2).join(" › ") : t.title)} — ${md(t.absent ?? "no runtime")}${t.warnings.length ? ` ⚠ ${md(t.warnings.join("; "))}` : ""}`);
    L.push("");
    L.push("</details>");
    L.push("");
  }
  L.push("---");
  L.push(`Findings come from the runtime's local model (observe mode reports, it never changes the app). Wrong finding? Open an issue with the evidence line above: ${ISSUES_URL} · @genclass/playwright ${s.package || ""}`.trim());
  return L.join("\n") + "\n";
}

function shortFile(f: string): string {
  const parts = f.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join("/") : f;
}
