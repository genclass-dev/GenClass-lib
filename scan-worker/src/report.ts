// Turns a scan result into the report the page shows and the cache keeps: findings merged across views and grouped
// by category and rule, numbered in a fixed order, with their words, the standard each is judged by, and fixes; the
// category scores and the overall score; the top issues; what was measured; and the measured "with GenClass" pass.
// A finding counts as fixed only when the re-check in the same browser session shows it gone and a GenClass action is
// on record for it (a visual fix the chunk applied, or guard's own action on the clicked request). Nothing here
// estimates or projects a fix. Every other finding is reported for the developer with its suggested fix. A finding
// that may come from the scanner's own stand-in answers (or from requests it refused) is listed but not scored, and so
// is a finding in a category this scan did not measure.

import { categoryOf, describe, isAudit, isVisual, KINDS, ruleOf, severityOf, standardsOf, suggestFix, type Kind, type RawFinding, type Source } from "./catalog.ts";
import { FAMILY_WORDS, FIND_THRESHOLD, JUDGE_EVAL, JUDGE_LABEL, JUDGE_MODEL, JUDGE_NAME, JUDGE_PLATFORM, JUDGE_PROMPT, judgeCost, KEEP_THRESHOLD, NOT_JUDGED, VERDICT_WORDS, type JudgeResult } from "./judge.ts";
import type { JudgeRun, ProbeResult, ScanResult, VisualFixes } from "./scan.ts";
import { LCP_GOOD_MS, LCP_POOR_MS, TIMING_NOTE } from "./audits.ts";
import { CATEGORIES, ruleImpact, score, SEVERITY_ORDER, type Category, type ScoreBreakdown, type Severity } from "./score.ts";
import type { Standard } from "./standards.ts";
import type { Target } from "./target.ts";
import { FIX_KINDS, RUNTIME_VERSION, visualKey, visualStatus } from "./visual.ts";
import { VISION_EVAL, VISION_LINE, VISION_MODEL, VISION_NAME, VISION_ORT, VISION_THRESHOLD } from "./vision.ts";

/**
 * The version of the checks and the report. Bump it whenever a change would give a different report for the same
 * page: cached reports from another version are not served (store.ts cachedReport).
 */
export const REPORT_VERSION = 16;

export interface Finding {
  n: number;
  kind: Kind;
  /** The rule it belongs to: the kind, or "axe:<rule id>". Findings are grouped and scored by rule. */
  rule: string;
  /** Which part of the scanner measured it. */
  source: Source;
  category: Category;
  severity: Severity;
  /** How many elements or instances it stands for (the most found in any one view). */
  count: number;
  views: string[];
  selector: string;
  /** More elements with the same problem (axe-core rules and the audits), up to 5. */
  examples: string[];
  boxes: Record<string, { x: number; y: number; w: number; h: number }>;
  measured: string;
  what: string;
  why: string;
  /** The standards it is judged by (a WCAG success criterion, a web.dev metric), each with its link. */
  standards: Standard[];
  /** axe-core's guide for the rule (dequeuniversity.com), when there is one. */
  guide: string | null;
  fix: string;
  /** How GenClass fixed it, measured in the with-GenClass pass; null when it did not. */
  fixed: { how: string } | null;
  /**
   * What GenClass does about it: "fixed" (measured above), "not-fixed" (a kind GenClass can fix in the page, not
   * fixed in this run, with why), or "reported" (GenClass reports it for the developer and never changes it).
   */
  genclass: { status: "fixed" | "not-fixed" | "reported"; text: string };
  /** Why the finding is listed but not scored (it may come from the scanner's stand-in answers); null when scored. */
  unscored: string | null;
  /** What the model judge said about it (src/judge.ts), when it was asked; null otherwise. */
  judge: FindingJudge | null;
  /**
   * GenClass Vision's second opinion (src/vision.ts): its any-problem score on the crop the judge took, the highest over
   * the views it answered in, and whether that reaches VISION_THRESHOLD. Null when it did not see the element. It never
   * changes `unscored` or the score.
   */
  vision: FindingVision | null;
}

/** GenClass Vision on one finding. */
export interface FindingVision {
  score: number;
  flagged: boolean;
  views: { view: string; score: number }[];
}

/** The model judge on one finding: what it said in each view it was asked in, with the crop it saw. */
export interface FindingJudge {
  /**
   * "kept": it agreed with a measured finding; "fine": it judged the element as probably fine in every view the
   * finding appeared in, so the finding is listed, not scored; "unanswered": it did not answer in every view, so the
   * finding stands as measured; "found": a finding of the model's own.
   */
  outcome: "kept" | "fine" | "unanswered" | "found";
  name: string;
  model: string;
  /** The threshold that applied: KEEP_THRESHOLD for a measured finding, FIND_THRESHOLD for the model's own. */
  threshold: number;
  /** The highest score over the views it answered in. */
  score: number | null;
  text: string;
  views: {
    view: string;
    score: number | null;
    verdict: string;
    verdictP: number;
    fineP: number;
    family: string;
    familyP: number;
    noneP: number;
    /** The crop the model saw (a screenshot URL on this origin), its size, and the element's box inside it. */
    crop: string | null;
    cropSize: [number, number];
    inCrop: [number, number, number, number];
    error: string | null;
  }[];
}

export interface Report {
  v: number;
  id: string;
  key: string;
  url: string;
  host: string;
  display: string;
  scannedAt: string;
  runtime: string;
  chrome: string;
  /** The axe-core version that ran. */
  axe: string;
  ms: ScanResult["ms"];
  timedOut: boolean;
  views: {
    id: string; label: string; width: number; height: number; ok: boolean; status: number | null; ms: number; notes: string[]; shot: string | null; shotHeight: number; error?: string; checks: unknown; standIns: number;
    coverage: ScanResult["views"][number]["coverage"];
    /** What the page could read about its window: innerWidth, innerHeight, outerWidth, outerHeight, screen.width, screen.height, clientWidth. */
    env?: number[];
    /** What the page showed at network quiet (the bot-check read: text length, elements, title, markers). */
    wall?: ScanResult["views"][number]["wall"];
  }[];
  findings: Finding[];
  score: ScoreBreakdown;
  /** When a cap lowered the score: the cap and the findings that set it ("Capped at 49: a critical finding (#3)."). */
  scoreNote: string | null;
  /** The rules that cost the overall score the most, at most 5: the first finding's number and the points they cost. */
  top: { rule: string; category: Category; what: string; severity: Severity; count: number; n: number; points: number }[];
  /** Why a category was not measured on this scan (absent when it was). */
  notMeasured: Partial<Record<Category, string>>;
  /** Measured once on this load: the desktop's Largest Contentful Paint and layout shift, its JavaScript, and the light phone's LCP for comparison. */
  metrics: {
    lcpMs: number | null; cls: number | null; jsBytes: number | null; phoneLcpMs: number | null; phoneCls: number | null; axeIncomplete: number; axePasses: number; whoAsks: number;
    /** First Contentful Paint on the desktop and the light phone, and what the light phone downloaded by network quiet. */
    fcpMs?: number | null; phoneFcpMs?: number | null; phoneBytes?: number | null; phoneRequests?: number | null;
    /** The keyboard focus check's counts on the desktop (scan.ts focusCheck). */
    focus?: NonNullable<ScanResult["views"][number]["metrics"]["focus"]> | null;
    /** The main document the security checks read on the light phone (header names only). */
    doc?: NonNullable<ScanResult["views"][number]["metrics"]["doc"]> | null;
  };
  withGenClass: { shown: boolean; value: number | null; breakdown: ScoreBreakdown | null; fixed: number; note: string };
  /**
   * Set when the scanner's browser was shown a bot check, a wall or a blank error page instead of the real page in
   * every view (blockedOf): the report then has no score and no findings, only this message. Null otherwise.
   */
  blocked: { message: string; status: number | null; marks: string[] } | null;
  probe: {
    observe: ProbeResult | null; guard: ProbeResult | null; guardHoldMs: number | null; guardAggressiveness: string; guardMargin: number | null;
    /** How the guard pass was configured, in words: the shipped default, or what differs from it. */
    guardSetting: string;
    /** Whether GenClass guard measurably stopped the double click's repeat, tied to its own action on that request. */
    guardClick: { acted: boolean; how: string | null };
  };
  /** The model judge over the scan (src/judge.ts): its calls, answers, cost and what it changed. */
  judge: {
    on: boolean; name: string; model: string; platform: string; prompt: string;
    calls: number; answered: number; timeouts: number; failed: number; tokens: number; usd: number;
    msMedian: number | null; msMax: number | null; wallMs: number | null; prepMs: Record<string, number>;
    keepThreshold: number; findThreshold: number;
    /** Measured findings it agreed with, judged as probably fine, did not answer on; findings of its own. */
    kept: number; fine: number; unanswered: number; found: number;
    note: string;
    /** Every element it was asked about, with its answer (no crop): what it was shown, and what it said. */
    asked: { view: string; cls: string; kind: string; selector: string; score: number | null; verdict: string; family: string; error: string | null; ms: number; crop: string | null; state?: string }[];
  };
  /**
   * GenClass Vision (beta, src/vision.ts): whether it ran, how long it took, its score on each finding it saw, and the
   * findings it flags that are not scored (`beta`). Not part of any score.
   */
  vision: {
    on: boolean; started: boolean; ran: boolean; name: string; model: string; stage: "beta"; ort: string; threshold: number;
    error: string | null; loadMs: number | null; msMedian: number | null; msMax: number | null;
    scored: number; failed: number; varsUnmeasured: number; flagged: number;
    line: string;
    eval: { ref: string; testCrops: number; ap: number; apClef: number; apOpenAI: number; behindRules: { kept: number; real: number; precision: number }; labels: string };
    findings: { n: number; score: number; flagged: boolean }[];
    beta: { n: number; kind: string; what: string; selector: string; view: string; score: number; crop: string | null }[];
  };
  /** The worker's own requests about the site: where http:// ended up, and /favicon.ico's status (src/site.ts). */
  site: { http: string | null; favicon: number | null; preloaded: boolean | null; page: { url: string; status: number; headers: string[] } | null };
  notes: string[];
}

const SEV_ORDER = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i])) as Record<Severity, number>;
const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i])) as Record<Category, number>;
const VIEW_ORDER: Record<string, number> = { desktop: 0, phone: 1, "phone-dark": 2, probe: 3 };
const VIEW_WORDS: Record<string, string> = { desktop: "desktop", phone: "phone", "phone-dark": "dark phone" };

/**
 * The identity of a finding across views. A visual finding is one element with one problem; an axe-core rule or an
 * audit is one finding per scan, whatever views it showed in (its count is the most found in one view).
 */
function identity(f: RawFinding): string {
  const d = f.detail ?? {};
  if (f.kind === "genclass-detection") return `${f.kind}|${String(d.diagnosis)}|${String(d.subject)}`;
  if (f.kind === "axe") return `axe|${String(d.rule)}`;
  if (f.kind === "visual-judged") return `${f.kind}|${f.selector}|${String(d.at ?? "")}`;
  if (isAudit(f.kind)) return `audit|${f.kind}`;
  if (isVisual(f.kind)) return visualKey(f);
  return `${f.kind}|${f.selector}`;
}
/** Findings that stand for many elements: merged across views by rule rather than by element. */
const aggregate = (f: RawFinding): boolean => f.kind === "axe" || isAudit(f.kind);
const countOf = (f: RawFinding): number => {
  const c = f.detail?.count;
  return typeof c === "number" && Number.isFinite(c) && c >= 1 ? Math.round(c) : 1;
};

const MOVES: Record<string, string> = { coalesce: "merging the two", discard: "dropping it", defer: "holding it back", retry: "retrying it", cancel: "cancelling it" };
/** A diagnosis with its article ("a duplicate", "an inconsistency"); the page uses the same words. */
export const DIAGNOSIS_ARTICLE: Record<string, string> = { duplicate: "a duplicate", stale: "a late response", conflict: "a conflict", inconsistent: "an inconsistency", failing: "a failing request" };

/** What the guard pass's double click sent, in words, from its measured counts (never assumed). */
export function guardSent(guard: ProbeResult | null): string {
  const c = guard?.clicked;
  if (!c) return "";
  const n = c.identical >= 2 ? c.identical : c.sent;
  if (!n) return "the page sent nothing";
  const what = c.identical >= 2 ? `${n} identical requests` : n === 1 ? "1 request" : `${n} requests`;
  return `the page sent ${what} (the scanner answered ${n === 1 ? "it" : "them"}; ${n === 1 ? "it did not reach" : "none reached"} the site)`;
}

/**
 * When guard diagnosed the race finding's request but did not act, why: its expected gain did not clear the safety
 * margin. Null when guard did not diagnose it, or acted.
 */
export function heldBack(f: RawFinding, observe: ProbeResult | null, guard: ProbeResult | null, isDefault: boolean): string | null {
  if (!guard || !guard.ran) return null;
  let match: (d: ProbeResult["detections"][number]) => boolean;
  if (f.kind === "duplicate-submit") {
    const req = observe?.clicked?.requests[0];
    if (!req) return null;
    match = (d) => d.trigger === "request" && subjectNames(d.subject, req.method, req.path);
  } else {
    const subject = bareSubject(String(f.detail?.subject ?? ""));
    if (!subject) return null;
    match = (d) => bareSubject(d.subject) === subject;
  }
  const d = guard.detections.find((x) => match(x) && !x.executed && !!x.candidate && typeof x.gain === "number" && typeof x.margin === "number");
  if (!d || d.gain === null || d.gain === undefined || d.margin === null || d.margin === undefined) return null;
  const move = MOVES[String(d.candidate)] ?? String(d.candidate);
  const sent = f.kind === "duplicate-submit" ? guardSent(guard) : "";
  const what = DIAGNOSIS_ARTICLE[d.diagnosis] ?? d.diagnosis;
  return `Flagged, held back at ${isDefault ? "the default safety margin" : "this setting's safety margin"}: in the guard pass GenClass was ${Math.round(d.p * 100)}% sure this was ${what}, but ${move} had an expected gain of ${Math.round(d.gain * 100) / 100} against a margin of ${d.margin}, so it did not act${sent ? `: ${sent}` : ""}. The suggested fix above removes it.`;
}

const sentenceStart = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** The kind's words for what GenClass does with a finding it did not fix. */
function notFixedText(kind: Kind, why: string | null): string {
  if (kind === "duplicate-submit" || kind === "genclass-detection") return why ?? "Not fixed in this run. The suggested fix above removes it.";
  if (FIX_KINDS.has(kind)) return `${sentenceStart(visualStatus().fixes)} can fix this kind in the page, but not here: ${why ?? "the with-GenClass pass did not run on this view."} The suggested fix above removes it for every visitor.`;
  return "Reported for the developer. GenClass does not change this in the page; the suggested fix above removes it.";
}

/** Findings from the race probe: a double click that sent identical requests, and what GenClass diagnosed. */
export function probeFindings(p: ProbeResult | null): RawFinding[] {
  if (!p || !p.ran) return [];
  const out: RawFinding[] = [];
  // a GenClass "duplicate" on an outgoing request during the click is the same problem as the double submit itself
  const dupFlag = p.detections.find((d) => d.diagnosis === "duplicate" && d.trigger === "request");
  const doubled = !!(p.clicked && p.clicked.identical >= 2);
  if (p.clicked && doubled) {
    const r = p.clicked.requests[0];
    out.push({
      kind: "duplicate-submit",
      selector: p.clicked.target,
      box: null,
      measured: (`${p.clicked.identical} identical ${r ? `${r.method} ${r.path}` : ""} requests from one double click (answered locally, never sent)` +
        (dupFlag ? `; GenClass flagged the second as a duplicate (${Math.round(dupFlag.p * 100)}% confidence)` : "")).replace(/\s+/g, " "),
      detail: { sent: p.clicked.sent, identical: p.clicked.identical, genclass: dupFlag ? dupFlag.p : null },
    });
  }
  const seen = new Set<string>();
  for (const d of p.detections) {
    const k = `${d.diagnosis}|${d.subject}`;
    if (doubled && d === dupFlag) continue;
    if (doubled && d.diagnosis === "duplicate" && d.trigger === "request") continue;
    if (seen.has(k) || out.length >= 6) continue;
    seen.add(k);
    out.push({
      kind: "genclass-detection",
      selector: d.subject,
      box: null,
      measured: `GenClass diagnosed ${d.diagnosis} (${Math.round(d.p * 100)}% confidence) on ${d.subject}`,
      detail: { diagnosis: d.diagnosis, p: d.p, subject: d.subject, trigger: d.trigger },
    });
  }
  return out;
}

/** Whether a GenClass subject ("POST /api/subscribe (#12)") names this request (method and path, any host). */
export function subjectNames(subject: string, method: string, path: string): boolean {
  const slash = path.indexOf("/");
  const pathname = slash >= 0 ? path.slice(slash) : path;
  const s = subject.trim();
  if (!s.toUpperCase().startsWith(`${method.toUpperCase()} `)) return false;
  const rest = s.slice(method.length + 1);
  const i = rest.indexOf(pathname);
  if (i < 0) return false;
  const after = rest.charAt(i + pathname.length);
  return after === "" || after === "?" || after === "#" || after === " " || after === "(";
}

/**
 * What GenClass guard did to the double click, when it measurably did something: an action of its own (coalesce, defer
 * or discard) on a decision about the clicked request, with fewer requests sent than without GenClass, at least one
 * of them sent, and none identical. Else null.
 */
export function guardClickFix(observe: ProbeResult | null, guard: ProbeResult | null): { how: string } | null {
  if (!guard || !guard.ran) return null;
  const before = observe?.clicked;
  const after = guard.clicked;
  if (!before || !after || after.sent < 1 || after.sent >= before.sent || after.identical >= 2) return null;
  const req = before.requests[0];
  if (!req) return null;
  const decisions = new Set(guard.detections.filter((d) => d.trigger === "request" && subjectNames(d.subject, req.method, req.path)).map((d) => d.id));
  const acted = guard.acts.find((a) => a.ok && a.trigger === "request" && (a.action === "coalesce" || a.action === "defer" || a.action === "discard") && decisions.has(a.decisionId));
  if (!acted) return null;
  return { how: `GenClass guard ${acted.action === "coalesce" ? "coalesced the second request into the first" : `ran ${acted.action}`}: ${after.sent} sent instead of ${before.sent}.` };
}

/**
 * How the guard pass fixed a race finding; else null. A double submit: guard's own action on the clicked request, with
 * fewer requests sent (guardClickFix). A late response GenClass diagnosed: guard's discard or defer recorded on a
 * response to that same subject (never on an unnamed one), and the guard pass's own diagnoses no longer include an
 * unacted one on that subject. The words are the action GenClass recorded; the page was not re-checked for the stale
 * write itself.
 */
export function raceFix(f: RawFinding, observe: ProbeResult | null, guard: ProbeResult | null): { how: string } | null {
  if (!guard || !guard.ran) return null;
  if (f.kind === "duplicate-submit") return guardClickFix(observe, guard);
  if (f.kind === "genclass-detection") {
    const subject = bareSubject(String(f.detail?.subject ?? ""));
    if (!subject) return null;
    const acted = guard.acts.find((a) => a.ok && a.trigger === "delivery" && (a.action === "discard" || a.action === "defer") && bareSubject(a.subject) === subject);
    if (!acted) return null;
    const unacted = guard.detections.some((d) => bareSubject(d.subject) === subject && !d.executed && !guard.acts.some((a) => a.ok && a.decisionId === d.id));
    if (unacted) return null;
    const changed = cutWords(acted.changed);
    const on = /^response to /i.test(subject) ? `the ${subject}` : `the late response to ${subject}`;
    return { how: `GenClass guard ran ${acted.action} on ${on} (its recorded action${changed ? `: ${changed}` : ""}).` };
  }
  return null;
}

const cutWords = (t: string): string => t.trim().replace(/\.$/, "").slice(0, 200);
/** A GenClass subject without its sequence number ("GET /api/a (#7)" is "GET /api/a"): the observe and guard pages number requests apart. */
export const bareSubject = (s: string): string => s.replace(/\s*\(#\d+\)\s*$/, "").trim();

/** The guard pass's configuration in words, so the report never passes a demo setting off as the default. */
export function guardSetting(aggr: string, margin: number | null, holdMs: number | null): string {
  const gates =
    margin === null
      ? aggr === "balanced"
        ? "its default settings"
        : `the ${aggr} profile (not the default)`
      : `a demo setting that lowers its safety margin to ${margin}${aggr !== "balanced" ? `, ${aggr} profile` : ""} (not the default)`;
  return `GenClass in guard mode with ${gates}${holdMs ? `, holding requests for up to ${holdMs} ms while it decides` : ""}`;
}


/** Kinds whose evidence can come from the scanner's stand-in answer to a POST made while the page loaded. */
const STAND_IN_KINDS = new Set<Kind>(["text-template-leak", "text-placeholder", "image-broken", "page-blank", "js-error", "console-error", "visual-judged", "page-weight"]);

// ------------------------------------------------------------------------------------------ the model judge

/** Why a measured finding the model judged as probably fine is listed and not scored. */
export const JUDGE_FINE_NOTE = `Listed, not scored (a model judged it as probably fine): ${JUDGE_NAME}, a model on ${JUDGE_PLATFORM}, scored a crop of the screenshot below ${KEEP_THRESHOLD} in every view this appeared in. The finding is shown as it was measured; look at the crop before deciding.`;

const pct = (p: number): string => `${Math.round(p * 100)}%`;
const s4 = (x: number): string => x.toFixed(4);

/** Results the report shows a crop for: every measured finding the judge was asked about, and the model's own findings. */
export function judgeCropsToKeep(r: ScanResult): JudgeResult[] {
  return r.views.flatMap((v) => (v.judged ?? []).filter((j) => j.cls === "finding" || (j.answer !== null && j.answer.score >= FIND_THRESHOLD)));
}

/** How much of the smaller of two boxes the other covers (0 to 1). */
function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const small = Math.min(a.w * a.h, b.w * b.h);
  return w > 0 && h > 0 && small > 0 ? (w * h) / small : 0;
}

/** A finding of the model's own: what it said, in words that never claim a measurement. */
export function judgedFinding(j: JudgeResult): RawFinding | null {
  const a = j.answer;
  if (!a) return null;
  const verdict = a.verdict ? `that ${VERDICT_WORDS[a.verdict] ?? a.verdict} (${pct(a.verdictP)})` : "that something is wrong";
  const family = a.family ? `, a problem of ${FAMILY_WORDS[a.family] ?? a.family} (${pct(a.familyP)})` : "";
  return {
    kind: "visual-judged",
    selector: j.selector,
    box: j.box,
    measured: `${JUDGE_LABEL}, not measured. It answered ${verdict}${family}, and gave ${pct(a.noneP)} to nothing being wrong: score ${s4(a.score)}, where the model's own findings start at ${FIND_THRESHOLD}.`,
    detail: { verdict: a.verdict, family: a.family, score: a.score, at: `${Math.round(j.box.x)},${Math.round(j.box.y)}` },
  };
}

/** One view's answer about a finding, for the report, with the crop's URL. */
function judgeViewOf(j: JudgeResult, cropUrl: (id: string) => string | null): FindingJudge["views"][number] {
  const a = j.answer;
  return {
    view: j.view,
    score: a ? a.score : null,
    verdict: a?.verdict ?? "",
    verdictP: a?.verdictP ?? 0,
    fineP: a?.fineP ?? 0,
    family: a?.family ?? "",
    familyP: a?.familyP ?? 0,
    noneP: a?.noneP ?? 0,
    crop: cropUrl(j.id),
    cropSize: [j.crop.w, j.crop.h],
    inCrop: j.crop.inCrop,
    error: a ? null : j.error ?? "timeout",
  };
}

/**
 * What the model judge said about one merged finding, from its results in the views the finding appeared in. A
 * measured finding is "fine" only when every one of those views was answered and scored below KEEP_THRESHOLD; "kept"
 * when one reached it; otherwise "unanswered". Null when the judge was not asked about it.
 */
export function findingJudge(raw: RawFinding, views: readonly string[], r: ScanResult, cropUrl: (id: string) => string | null): FindingJudge | null {
  const byView = new Map(r.views.map((v) => [v.id as string, v.judged ?? []]));
  if (raw.kind === "visual-judged") {
    const at = String(raw.detail?.at ?? "");
    const res = views.map((v) => (byView.get(v) ?? []).find((j) => j.cls !== "finding" && j.selector === raw.selector && `${Math.round(j.box.x)},${Math.round(j.box.y)}` === at && j.answer)).filter((j): j is JudgeResult => !!j);
    if (!res.length) return null;
    const best = res.reduce((x, y) => ((y.answer?.score ?? 0) > (x.answer?.score ?? 0) ? y : x));
    return {
      outcome: "found", name: JUDGE_NAME, model: JUDGE_MODEL, threshold: FIND_THRESHOLD, score: best.answer?.score ?? null,
      text: `${JUDGE_LABEL}, on ${JUDGE_PLATFORM}. Not a measured check: on the labelled crops of its evaluation, an element it scored at ${FIND_THRESHOLD} or more was a real problem ${JUDGE_EVAL.find.real} times in ${JUDGE_EVAL.find.flagged} (labels by AI labeller agents, not people).`,
      views: res.map((j) => judgeViewOf(j, cropUrl)),
    };
  }
  if (!isVisual(raw.kind) || NOT_JUDGED.has(raw.kind)) return null;
  const key = identity(raw);
  const per = views.map((v) => (byView.get(v) ?? []).find((j) => j.cls === "finding" && j.key === key) ?? null);
  const asked = per.filter((j): j is JudgeResult => j !== null);
  if (!asked.length) return null;
  const scores = per.map((j) => j?.answer?.score ?? null);
  const answered = scores.filter((s): s is number => s !== null);
  const top = answered.length ? Math.max(...answered) : null;
  const outcome: FindingJudge["outcome"] = top !== null && top >= KEEP_THRESHOLD ? "kept" : scores.every((s) => s !== null && s < KEEP_THRESHOLD) ? "fine" : "unanswered";
  const best = asked.reduce((x, y) => ((y.answer?.score ?? -1) > (x.answer?.score ?? -1) ? y : x));
  const a = best.answer;
  const said = a ? (outcome === "fine" ? `${VERDICT_WORDS.fine} (${pct(a.fineP)})` : `${a.verdict ? VERDICT_WORDS[a.verdict] ?? a.verdict : "something is wrong"} (${pct(a.verdictP)})`) : "";
  const text =
    outcome === "kept"
      ? `${JUDGE_NAME}, a model on ${JUDGE_PLATFORM}, looked at a crop of the screenshot and agreed something is wrong: score ${s4(top as number)}; a measured finding stays scored from ${KEEP_THRESHOLD}. It answered that ${said}.`
      : outcome === "fine"
        ? `${JUDGE_NAME}, a model on ${JUDGE_PLATFORM}, judged it as probably fine from a crop of the screenshot: score ${s4(top as number)}${asked.length > 1 ? " at most" : ""}, below the ${KEEP_THRESHOLD} a measured finding needs to stay scored. It answered that ${said}.`
        : `${JUDGE_NAME}, a model on ${JUDGE_PLATFORM}, was asked about this element but did not answer in every view it appeared in, so it stands as measured.`;
  return { outcome, name: JUDGE_NAME, model: JUDGE_MODEL, threshold: KEEP_THRESHOLD, score: top, text, views: asked.map((j) => judgeViewOf(j, cropUrl)) };
}

/**
 * GenClass Vision on one merged finding: its score in each view it answered in (on the crop the judge took of that
 * view's element), the highest of them, and the judge result that score came from (for its crop). Null when it did not
 * answer in any view.
 */
export function findingVision(raw: RawFinding, views: readonly string[], r: ScanResult): { v: FindingVision; best: JudgeResult } | null {
  if (!isVisual(raw.kind) || NOT_JUDGED.has(raw.kind)) return null;
  const key = identity(raw);
  const byView = new Map(r.views.map((v) => [v.id as string, v.judged ?? []]));
  const got = views
    .map((v) => (byView.get(v) ?? []).find((j) => j.cls === "finding" && j.key === key && j.vision) ?? null)
    .filter((j): j is JudgeResult => j !== null && !!j.vision);
  if (!got.length) return null;
  const best = got.reduce((x, y) => ((y.vision?.any ?? 0) > (x.vision?.any ?? 0) ? y : x));
  const score = best.vision!.any;
  return { v: { score, flagged: score >= VISION_THRESHOLD, views: got.map((j) => ({ view: j.view, score: j.vision!.any })) }, best };
}

/** The judge's line under the findings: what it was asked, what it changed, and how it was measured. */
export function judgeNote(run: JudgeRun | undefined, list: readonly Finding[]): string {
  if (!run || !run.on) return "The model judge is off in this copy of the scanner, so every finding comes from the measured checks.";
  if (!run.calls) return "The model judge was on but asked about nothing on this load (no element it could crop, or no time left), so every finding comes from the measured checks.";
  const n = (o: FindingJudge["outcome"]) => list.filter((f) => f.judge?.outcome === o).length;
  const parts = [
    `A model, ${JUDGE_NAME} on ${JUDGE_PLATFORM}, was asked about ${run.calls} ${run.calls === 1 ? "element" : "elements"} from crops of the screenshots and answered ${run.answered}${run.timeouts ? ` (${run.timeouts} not in time)` : ""}${run.failed ? `, ${run.failed} failed` : ""}.`,
    `Of the measured findings it saw, it agreed with ${n("kept")} and judged ${n("fine")} as probably fine (listed, not scored); it made ${n("found")} ${n("found") === 1 ? "finding" : "findings"} of its own, each labelled "${JUDGE_LABEL}".`,
    "Every other finding comes from the measured checks.",
  ];
  return parts.join(" ");
}
export const STAND_IN_NOTE =
  "The page sent requests other than GET while loading and the scanner answered them itself, so this may come from that stand-in answer rather than from the site.";
/** Kinds whose evidence can come from files the scanner refused to load (a lookup that failed, a private answer). */
const REFUSED_KINDS = new Set<Kind>(["js-error", "console-error"]);
export const REFUSED_NOTE =
  "The scanner did not load some of this page's files (their hostnames could not be looked up, or pointed to private addresses), so this may come from those missing files rather than from the site.";
export const JS_NOTE =
  "A note, not scored: the transferred size alone does not make a page slow, and the Speed score already measures when the main content shows (LCP).";
/**
 * Layout shift measured in the scanner's browser is listed, never scored. Every request there waits for the scanner's
 * own checks before it continues, so content that scripts add after the first paint (a cookie banner, a fundraising
 * banner) moves the page more than it does for most visitors: on the three public pages of the calibration where the
 * scanner measured a shift, a desktop browser loading the same page measured none (scan-worker/CALIBRATION.md).
 */
const SHIFT_KINDS = new Set<Kind>(["cls-high", "layout-shift"]);
export const SHIFT_NOTE =
  "Listed, not scored: in the scanner's browser every request waits for the scanner's own checks, so content that scripts add after the first paint moves the page more than it does for most visitors. Compare with Chrome's field data (CrUX) or a Lighthouse run before acting on it.";
const notMeasuredNote = (label: string): string => `Listed, not scored: ${label} was not measured on this scan.`;

/** The with-GenClass note, from what this scan measured: only the steps that ran are named. */
export function withNote(r: ScanResult, aggr: string, margin: number | null, holdMs: number | null): string {
  const st = visualStatus();
  const parts: string[] = [`The with-GenClass score uses ${st.fixes} and, for the race probe, runtime ${RUNTIME_VERSION} in guard mode.`];
  const views = r.views.filter((v) => v.ok && v.checks !== null);
  const rechecked = views.some((v) => v.fixes?.rechecked);
  const applied = views.some((v) => (v.fixes?.applied ?? 0) > 0);
  if (rechecked)
    parts.push("In the same browser session the visual checks ran in guard mode with their fixes on, and a second set of the same checks re-measured the page with the fixes in place. A visual finding counts as fixed only when that re-check no longer found it.");
  else if (applied) parts.push("The visual fixes were applied, but no re-check finished, so none of them is counted as fixed.");
  else if (views.length) parts.push("The visual checks ran in guard mode with their fixes on; nothing they fix was fixed on this load, so no re-check ran.");
  if (r.guard?.ran) parts.push(`The race probe ran again in a fresh page with ${guardSetting(aggr, margin, holdMs)}.`);
  const uncovered = new Map<string, string>();
  for (const v of views) for (const u of v.fixes?.uncovered ?? []) uncovered.set(u.key, u.kind);
  if (uncovered.size) {
    const kinds = [...new Set(uncovered.values())].join(", ");
    parts.push(`With the fixes in place the re-check also found ${uncovered.size} ${uncovered.size === 1 ? "problem" : "problems"} the first pass did not report (${kinds}); neither score counts ${uncovered.size === 1 ? "it" : "them"}.`);
  }
  parts.push("The visual fixes change three kinds in the page (invisible text colour, a leaked pointer-events: none, a leaked scroll lock); everything else, including every accessibility, phone, reliability and speed finding, is reported for the developer.");
  return parts.join(" ");
}

/** Statuses a real page answers with; any other status together with a blank page means the scanner did not see it. */
const REAL_STATUS = new Set([200, 203, 304]);
/** A challenge or captcha marker counts only on a page this small (real pages may load a captcha or a WAF script too). */
export const WALL_MAX_TEXT = 1500;
export const WALL_MAX_ELEMENTS = 400;
/** A page with less visible text than this counts as blank for the status rule. */
export const WALL_BLANK_TEXT = 200;

/** Whether one view saw a bot check, a wall or a blank error page instead of the real page; its signals when it did. */
export function viewBlocked(v: ScanResult["views"][number]): { status: number | null; marks: string[] } | null {
  const w = v.wall ?? null;
  // text -1: the page had 1,500+ elements, so its text was not read (audits.ts "wall"); such a page is never small or blank by text
  const small = !!w && w.text >= 0 && w.text < WALL_MAX_TEXT && w.elements < WALL_MAX_ELEMENTS;
  const marks = small && w ? w.marks : [];
  const blank = v.findings.some((f) => f.kind === "page-blank") || (!!w && w.text >= 0 && w.text < WALL_BLANK_TEXT);
  // 204 is the scanner's own answer to a form navigation (src/policy.ts): page.goto() can hand it back when the page
  // submitted a form while it loaded, and a 204 never replaces the page, so it is not the page's status
  const odd = v.status !== null && !REAL_STATUS.has(v.status) && v.status !== 204;
  return marks.length || (odd && blank) ? { status: v.status, marks } : null;
}

/**
 * Whether the scanner could not see the real page: every view that loaded shows a known bot-check or captcha marker on
 * a small page, or answered with a status other than 200, 203 or 304 and was blank. A real blank page answered 200
 * without such markers is not blocked: it keeps its score (and its page-blank finding). Null when the page was seen.
 */
export function blockedOf(r: ScanResult, display: string): Report["blocked"] {
  const ok = r.views.filter((v) => v.ok);
  if (!ok.length) return null;
  const per = ok.map(viewBlocked);
  if (per.some((x) => x === null)) return null;
  const status = per.map((x) => x?.status ?? null).find((x) => x !== null && !REAL_STATUS.has(x)) ?? per[0]?.status ?? null;
  const marks = [...new Set(per.flatMap((x) => x?.marks ?? []))];
  const said = [marks[0] ?? "", status !== null && !REAL_STATUS.has(status) ? `HTTP ${status}` : ""].filter(Boolean).join(", ");
  const what = `${marks.length ? "a bot-check page" : "a blank or bot-check page"}${said ? ` (${said})` : ""}`;
  return { message: `We couldn't check ${display}: it showed our browser ${what} instead of the real page. Scores only count pages we can see.`, status, marks };
}
export const BLOCKED_NOTE = "Not measured: the scanner's browser was shown a bot check or a blank page instead of the real page.";

/** Which categories this scan measured, and why the others were not. */
export function coverageOf(r: ScanResult): { measured: Record<Category, boolean>; notMeasured: Partial<Record<Category, string>> } {
  const ok = r.views.filter((v) => v.ok);
  const measured: Record<Category, boolean> = {
    visual: ok.some((v) => v.checks !== null),
    accessibility: ok.some((v) => v.coverage?.axe.ran === true),
    phone: ok.some((v) => v.coverage?.phone === true),
    reliability: ok.some((v) => v.coverage?.reliability === true),
    speed: ok.some((v) => v.id === "desktop" && v.coverage?.vitals === true),
    security: ok.some((v) => v.coverage?.security === true),
    seo: ok.some((v) => v.coverage?.seo === true),
    races: !!(r.probe?.ran && (r.probe.typed || r.probe.clicked)),
  };
  const notMeasured: Partial<Record<Category, string>> = {};
  const axeError = ok.map((v) => v.coverage?.axe.error).find((e) => !!e);
  if (!measured.visual) notMeasured.visual = ok.length ? "The visual checks did not run in any view." : "No view loaded.";
  if (!measured.accessibility) notMeasured.accessibility = ok.length ? `axe-core did not finish in any view${axeError ? ` (${axeError})` : ""}.` : "No view loaded.";
  if (!measured.phone) notMeasured.phone = "The phone audits did not run on the phone view.";
  if (!measured.reliability) notMeasured.reliability = "The browser's own record of errors and requests could not be read.";
  if (!measured.speed) notMeasured.speed = "The desktop view's timings could not be read.";
  if (!measured.security) notMeasured.security = "The main document's response headers could not be read (or it did not answer 2xx).";
  if (!measured.seo) notMeasured.seo = "The page's head could not be read on the phone view.";
  if (!measured.races) notMeasured.races = !r.probe?.ran ? "The race probe did not run." : "The page has no search box and no form that posts, so the race probe had nothing to try.";
  return { measured, notMeasured };
}

/**
 * Largest Contentful Paint is judged on the faster of two loads in the same browser: the desktop view and the light
 * phone, which loads without GenClass. One load in the scanner's browser can be much slower than a visitor's (measured
 * in calibration: 2.64 s for a text heading that a desktop browser painted at 0.59 s, while the light phone measured
 * 2.13 s). When the faster load is within web.dev's 2.5 s there is no finding; otherwise the severity follows the faster
 * load and the finding names both. When the phone's LCP could not be read, the desktop's stands alone and says so.
 */
function lcpOnFasterLoad(merged: Map<string, { raw: RawFinding; severity: Severity; views: string[] }>, r: ScanResult): void {
  const k = "audit|lcp-slow";
  const e = merged.get(k);
  if (!e) return;
  const desk = typeof e.raw.detail?.ms === "number" ? (e.raw.detail.ms as number) : null;
  const phone = r.views.find((v) => v.id === "phone" && v.ok)?.metrics?.lcpMs ?? null;
  if (desk === null) return;
  const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  if (phone === null) {
    e.raw = { ...e.raw, measured: `${e.raw.measured} The phone view's LCP could not be read, so this is one load.` };
    return;
  }
  const faster = Math.min(desk, phone);
  if (faster <= LCP_GOOD_MS) {
    merged.delete(k);
    return;
  }
  const poor = faster > LCP_POOR_MS;
  const el = e.raw.selector ? ` (${e.raw.selector})` : "";
  e.severity = poor ? "moderate" : "minor";
  e.raw = {
    ...e.raw,
    measured: `Largest Contentful Paint at ${s(desk)} on the desktop view${el} and ${s(phone)} on the phone view; the faster load is ${poor ? "poor (above 4 s)" : "above 2.5 s (needs improvement)"}. ${TIMING_NOTE}`,
    detail: { ...e.raw.detail, severity: e.severity, phoneMs: phone },
  };
}

/** The words for a cap that lowered the score, naming the first finding of each rule that set it. */
export function capNote(s: ScoreBreakdown, list: readonly Finding[]): string | null {
  const c = s.cap;
  if (!c) return null;
  const ns = c.by
    .map((k) => list.find((f) => !f.unscored && `${f.category}|${f.rule}` === k)?.n ?? 0)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
    .map((n) => `#${n}`);
  const what = c.rules === 1 ? `a ${c.severity} finding` : `${c.by.length} ${c.severity === "serious" ? "serious or critical" : c.severity} rules`;
  return `Capped at ${c.at} by ${what} (${ns.join(", ")}); without the cap it would be ${Math.round(s.mean ?? c.at)}.`;
}

const helpUrl = (v: unknown): string | null => (typeof v === "string" && /^https:\/\/dequeuniversity\.com\/rules\/axe\//.test(v) ? v : null);
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function buildReport(
  target: Target,
  ids: {
    id: string; key: string; at: Date; runtime: string; axe?: string; shotUrl: (view: string) => string | null; guardHoldMs: number | null; guardAggressiveness?: string; guardMargin?: number | null;
    /** The URL of a judged element's crop ("<view>-j<n>"), when it was saved. */
    cropUrl?: (id: string) => string | null;
  },
  r: ScanResult,
  flags: { withGenClass: boolean; judgeDetail?: boolean },
): Report {
  type Entry = { raw: RawFinding; views: string[]; boxes: Finding["boxes"]; counts: Record<string, number>; examples: string[]; severity: Severity; best: number };
  const merged = new Map<string, Entry>();
  const add = (f: RawFinding, view: string) => {
    const k = identity(f);
    const sev = severityOf(f);
    const n = countOf(f);
    const ex = Array.isArray(f.detail?.examples) ? (f.detail.examples as unknown[]).filter((x): x is string => typeof x === "string" && x !== "") : [];
    const cur = merged.get(k);
    if (!cur) {
      merged.set(k, { raw: f, views: [view], boxes: f.box ? { [view]: f.box } : {}, counts: { [view]: n }, examples: ex.slice(0, 5), severity: sev, best: n });
      return;
    }
    if (!cur.views.includes(view)) cur.views.push(view);
    if (f.box && !cur.boxes[view]) cur.boxes[view] = f.box;
    cur.counts[view] = Math.max(cur.counts[view] ?? 0, n);
    for (const e of ex) if (!cur.examples.includes(e) && cur.examples.length < 5) cur.examples.push(e);
    if (SEV_ORDER[sev] < SEV_ORDER[cur.severity]) cur.severity = sev;
    // a finding that stands for many elements takes its words from the view where it found the most
    if (aggregate(f) && n > cur.best) {
      cur.raw = f;
      cur.best = n;
    }
  };
  for (const v of r.views) {
    for (const f of v.findings) if (Object.hasOwn(KINDS, f.kind)) add(f, v.id);
    for (const f of v.audits ?? []) if (Object.hasOwn(KINDS, f.kind)) add(f, v.id);
  }
  // the model judge's own findings: elements the measured checks abstain on that it scored at FIND_THRESHOLD or more,
  // unless a measured finding in that view is about the same place
  for (const v of r.views) {
    for (const j of v.judged ?? []) {
      if (j.cls === "finding" || !j.answer || j.answer.score < FIND_THRESHOLD) continue;
      if ([...v.findings, ...(v.audits ?? [])].some((f) => f.box && overlap(f.box, j.box) >= 0.6)) continue;
      const f = judgedFinding(j);
      if (f) add(f, v.id);
    }
  }
  const cropUrl = ids.cropUrl ?? (() => null);
  // a phone view laid out wider than the phone because there is no viewport meta tag, when the visual checks did not say so
  if (![...merged.values()].some((e) => e.raw.kind === "viewport-meta-missing")) {
    const wide = r.views.find((v) => v.ok && (v.id === "phone" || v.id === "phone-dark") && v.checks?.viewportMeta === false && v.width > 390);
    if (wide)
      add({ kind: "viewport-meta-missing", selector: "head", box: null, measured: `The page has no viewport meta tag, so a phone lays it out ${wide.width} px wide and shows it zoomed out on a 390 px screen.`, detail: { severity: "high" } }, wide.id);
  }
  for (const f of probeFindings(r.probe)) add(f, "probe");
  lcpOnFasterLoad(merged, r);

  const { measured, notMeasured } = coverageOf(r);
  // a bot check or a wall instead of the real page: no findings and no score, only the message
  const blocked = blockedOf(r, target.display);
  if (blocked) {
    merged.clear();
    for (const c of CATEGORIES) {
      measured[c.id] = false;
      notMeasured[c.id] = BLOCKED_NOTE;
    }
  }
  // views whose page got stand-in answers while loading (the probe ran on the desktop page), or had files refused
  const standIn = new Set(r.views.filter((v) => (v.standIns?.count ?? 0) > 0).map((v) => v.id as string));
  if (standIn.has("desktop") || (r.probe?.loadStandIns ?? 0) > 0) standIn.add("probe");
  const refused = new Set(r.views.filter((v) => (v.metrics?.skippedHosts ?? 0) > 0).map((v) => v.id as string));
  // each view's with-GenClass pass: a visual finding is fixed only when it was fixed and re-checked in every view it
  // appeared in
  const viewFixes = new Map<string, VisualFixes | null>(r.views.map((v) => [v.id as string, v.fixes ?? null]));
  const visualFix = (key: string, views: string[]): { fixed: { how: string } | null; why: string | null } => {
    const per = views.map((v) => viewFixes.get(v) ?? null);
    const hows = per.map((x) => x?.fixed.find((y) => y.key === key)?.how ?? null);
    if (hows.length && hows.every((h) => h !== null)) return { fixed: { how: String(hows[0]) }, why: null };
    for (let i = 0; i < per.length; i++) {
      const nf = per[i]?.notFixed.find((y) => y.key === key);
      if (nf) return { fixed: null, why: nf.why };
      if (hows[i] === null && per[i] === null) return { fixed: null, why: "the with-GenClass pass did not run on this view." };
    }
    return { fixed: null, why: "it was fixed in one view but not re-checked in every view it appeared in, so it is not counted." };
  };
  const visionBest = new Map<Finding, JudgeResult>();
  const list: Finding[] = [...merged.values()].map(({ raw, views, boxes, counts, examples, severity }) => {
    const words = describe(raw);
    let fixed: { how: string } | null = null;
    let why: string | null = null;
    if (raw.kind === "duplicate-submit" || raw.kind === "genclass-detection") {
      fixed = raceFix(raw, r.probe, r.guard);
      why = heldBack(raw, r.probe, r.guard, (ids.guardMargin ?? null) === null && (ids.guardAggressiveness ?? "balanced") === "balanced");
    } else if (FIX_KINDS.has(raw.kind) && flags.withGenClass) ({ fixed, why } = visualFix(identity(raw), views));
    const sorted = views.sort((a, b) => (VIEW_ORDER[a] ?? 9) - (VIEW_ORDER[b] ?? 9));
    const category = categoryOf(raw.kind, sorted);
    const count = Math.max(1, ...Object.values(counts));
    const fromStandIn = (STAND_IN_KINDS.has(raw.kind) || (raw.kind === "genclass-detection" && String(raw.detail?.diagnosis) !== "duplicate")) && sorted.every((v) => standIn.has(v));
    const fromRefused = !fromStandIn && REFUSED_KINDS.has(raw.kind) && sorted.every((v) => refused.has(v) || standIn.has(v));
    const label = CATEGORIES.find((c) => c.id === category)!.label;
    const judge = findingJudge(raw, sorted, r, cropUrl);
    const unscored =
      raw.kind === "js-heavy" ? JS_NOTE
      : SHIFT_KINDS.has(raw.kind) ? SHIFT_NOTE
      : fromStandIn ? STAND_IN_NOTE
      : fromRefused ? REFUSED_NOTE
      : !measured[category] ? notMeasuredNote(label)
      : judge?.outcome === "fine" ? JUDGE_FINE_NOTE
      : null;
    let text = raw.measured;
    if (raw.kind === "axe") {
      const per = sorted.filter((v) => counts[v]).map((v) => `${counts[v]} on the ${VIEW_WORDS[v] ?? v}`);
      text = `${count === 1 && per.length === 1 ? "1 element" : `Elements: ${listWords(per)}`}.${raw.measured ? ` First: ${raw.measured}` : ""}`;
    } else if (aggregate(raw) && sorted.length > 1) {
      const others = sorted.filter((v) => !raw.measured.includes(`the ${VIEW_WORDS[v] ?? v} view`)).map((v) => VIEW_WORDS[v] ?? v);
      if (others.length && others.length < sorted.length) text = `${raw.measured} Also on the ${listWords(others)} view.`;
    }
    const vis = findingVision(raw, sorted, r);
    const out: Finding = {
      n: 0,
      kind: raw.kind,
      rule: ruleOf(raw),
      source: KINDS[raw.kind].source,
      category,
      severity,
      count,
      views: sorted,
      selector: raw.selector,
      examples: examples.slice(0, 5),
      boxes,
      measured: text,
      what: words.what,
      why: words.why,
      standards: standardsOf(raw),
      guide: raw.kind === "axe" ? helpUrl(raw.detail?.helpUrl) : null,
      fix: suggestFix(raw),
      fixed,
      genclass: fixed
        ? { status: "fixed", text: `Fixed. ${fixed.how}` }
        : { status: FIX_KINDS.has(raw.kind) || raw.kind === "duplicate-submit" || raw.kind === "genclass-detection" ? "not-fixed" : "reported", text: notFixedText(raw.kind, why) },
      unscored,
      judge,
      vision: vis ? vis.v : null,
    };
    if (vis) visionBest.set(out, vis.best);
    return out;
  });

  const scorable = (fs: readonly Finding[]) => fs.filter((f) => !f.unscored).map((f) => ({ category: f.category, severity: f.severity, rule: f.rule, count: f.count }));
  const without = score(scorable(list), measured);
  const points = new Map<string, number>();
  for (const c of without.categories) for (const rule of c.rules) points.set(`${c.id}|${rule.rule}`, rule.points);
  const pts = (f: Finding) => points.get(`${f.category}|${f.rule}`) ?? 0;
  list.sort(
    (a, b) =>
      CAT_ORDER[a.category] - CAT_ORDER[b.category] ||
      pts(b) - pts(a) ||
      a.rule.localeCompare(b.rule) ||
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      (VIEW_ORDER[a.views[0]] ?? 9) - (VIEW_ORDER[b.views[0]] ?? 9) ||
      a.selector.localeCompare(b.selector) ||
      a.measured.localeCompare(b.measured),
  );
  list.forEach((f, i) => (f.n = i + 1));

  const top = ruleImpact(scorable(list), measured)
    .filter((t) => t.points > 0)
    .slice(0, 5)
    .map((t) => {
      const mine = list.filter((f) => f.category === t.category && f.rule === t.rule && !f.unscored);
      const sev = mine.map((f) => f.severity).sort((a, b) => SEV_ORDER[a] - SEV_ORDER[b])[0] ?? "minor";
      return { rule: t.rule, category: t.category, what: mine[0]?.what ?? t.rule, severity: sev, count: mine.reduce((s, f) => s + f.count, 0), n: mine[0]?.n ?? 0, points: t.points };
    });

  const scoreNote = capNote(without, list);
  const fixedCount = list.filter((f) => !f.unscored && f.fixed).length;
  const withBreakdown = score(scorable(list.filter((f) => !f.fixed)), measured);
  const guardRan = !!r.guard?.ran;
  const visualRan = r.views.some((v) => v.ok && v.checks !== null);
  const measuredWith = guardRan || visualRan;
  const note = blocked
    ? "No score with or without GenClass: the scanner did not see the real page."
    : !flags.withGenClass
    ? "The with-GenClass score is switched off in this copy of the scanner."
    : measuredWith
      ? withNote(r, ids.guardAggressiveness ?? "balanced", ids.guardMargin ?? null, ids.guardHoldMs)
      : "GenClass could not be measured on this page, so nothing is counted as fixed.";
  const desk = r.views.find((v) => v.id === "desktop" && v.ok);
  const phone = r.views.find((v) => v.id === "phone" && v.ok);
  const axeViews = r.views.filter((v) => v.coverage?.axe.ran);

  return {
    v: REPORT_VERSION,
    id: ids.id,
    key: ids.key,
    url: target.url,
    host: target.host,
    display: target.display,
    scannedAt: ids.at.toISOString(),
    runtime: ids.runtime,
    chrome: r.chrome,
    axe: ids.axe ?? "",
    ms: r.ms,
    timedOut: r.timedOut,
    views: r.views.map((v) => ({
      id: v.id, label: v.label, width: v.width, height: v.height, ok: v.ok, status: v.status, ms: v.ms, notes: v.notes,
      shot: v.shot ? ids.shotUrl(v.id) : null, shotHeight: v.shotHeight, ...(v.error ? { error: v.error } : {}), checks: v.checks, standIns: v.standIns?.count ?? 0,
      coverage: v.coverage,
      ...(v.metrics?.env ? { env: v.metrics.env } : {}),
      ...(v.wall ? { wall: v.wall } : {}),
    })),
    findings: list,
    score: without,
    scoreNote,
    top,
    notMeasured,
    blocked,
    metrics: {
      lcpMs: desk?.metrics?.lcpMs ?? null,
      cls: desk?.metrics?.cls ?? null,
      jsBytes: desk?.metrics?.jsBytes ?? null,
      phoneLcpMs: phone?.metrics?.lcpMs ?? null,
      phoneCls: phone?.metrics?.cls ?? null,
      axeIncomplete: Math.max(0, ...axeViews.map((v) => v.coverage.axe.incomplete)),
      axePasses: Math.max(0, ...axeViews.map((v) => v.coverage.axe.passes)),
      whoAsks: Math.max(0, ...r.views.map((v) => v.metrics?.whoAsks ?? 0)),
      fcpMs: desk?.metrics?.fcpMs ?? null,
      phoneFcpMs: phone?.metrics?.fcpMs ?? null,
      phoneBytes: phone?.metrics?.bytes ?? null,
      phoneRequests: phone?.metrics?.requests ?? null,
      focus: desk?.metrics?.focus ?? null,
      doc: phone?.metrics?.doc ?? null,
    },
    withGenClass: {
      shown: flags.withGenClass && measuredWith && !blocked,
      value: flags.withGenClass && measuredWith && !blocked ? withBreakdown.value : null,
      breakdown: flags.withGenClass && measuredWith && !blocked ? withBreakdown : null,
      fixed: fixedCount,
      note,
    },
    probe: {
      observe: r.probe,
      guard: r.guard,
      guardHoldMs: ids.guardHoldMs,
      guardAggressiveness: ids.guardAggressiveness ?? "balanced",
      guardMargin: ids.guardMargin ?? null,
      guardSetting: guardSetting(ids.guardAggressiveness ?? "balanced", ids.guardMargin ?? null, ids.guardHoldMs),
      guardClick: (() => {
        const g = guardClickFix(r.probe, r.guard);
        return { acted: g !== null, how: g ? g.how : null };
      })(),
    },
    judge: (() => {
      const run = r.judge;
      const n = (o: FindingJudge["outcome"]) => list.filter((f) => f.judge?.outcome === o).length;
      const tokens = run?.tokens ?? 0;
      return {
        on: !!run?.on, name: JUDGE_NAME, model: JUDGE_MODEL, platform: JUDGE_PLATFORM, prompt: JUDGE_PROMPT,
        calls: run?.calls ?? 0, answered: run?.answered ?? 0, timeouts: run?.timeouts ?? 0, failed: run?.failed ?? 0,
        tokens, usd: Math.round(judgeCost(tokens) * 1e6) / 1e6,
        msMedian: run?.msMedian ?? null, msMax: run?.msMax ?? null, wallMs: run?.wallMs ?? null, prepMs: run?.prepMs ?? {},
        keepThreshold: KEEP_THRESHOLD, findThreshold: FIND_THRESHOLD,
        kept: n("kept"), fine: n("fine"), unanswered: n("unanswered"), found: n("found"),
        note: judgeNote(run, list),
        asked: r.views.flatMap((v) =>
          (v.judged ?? []).map((j) => ({ view: j.view, cls: j.cls, kind: j.kind, selector: j.selector, score: j.answer?.score ?? null, verdict: j.answer?.verdict ?? "", family: j.answer?.family ?? "", error: j.answer ? null : j.error ?? "timeout", ms: j.ms, crop: cropUrl(j.id), ...(flags.judgeDetail && j.state ? { state: j.state } : {}) })),
        ),
      };
    })(),
    vision: (() => {
      const run = r.vision;
      const seen = list.filter((f) => f.vision);
      return {
        on: !!run?.on, started: !!run?.started, ran: !!run?.ran, name: VISION_NAME, model: VISION_MODEL, stage: "beta" as const, ort: run?.ort ?? VISION_ORT.version, threshold: VISION_THRESHOLD,
        error: run?.error ?? null, loadMs: run?.loadMs ?? null, msMedian: run?.msMedian ?? null, msMax: run?.msMax ?? null,
        scored: run?.scored ?? 0, failed: run?.failed ?? 0, varsUnmeasured: run?.varsUnmeasured ?? 0, flagged: seen.filter((f) => f.vision!.flagged).length,
        line: VISION_LINE,
        eval: { ref: VISION_EVAL.ref, testCrops: VISION_EVAL.testCrops, ap: VISION_EVAL.ap, apClef: VISION_EVAL.apClef, apOpenAI: VISION_EVAL.apOpenAI, behindRules: { ...VISION_EVAL.behindRules }, labels: VISION_EVAL.labels },
        findings: seen.map((f) => ({ n: f.n, score: f.vision!.score, flagged: f.vision!.flagged })),
        // what it flags that the score does not count: measured findings listed, not scored (most often because Clef
        // judged them as probably fine), at Vision's operating point, highest first
        beta: seen
          .filter((f) => f.unscored && f.vision!.flagged)
          .sort((a, b) => b.vision!.score - a.vision!.score || a.n - b.n)
          .map((f) => {
            const j = visionBest.get(f);
            return { n: f.n, kind: f.kind, what: f.what, selector: f.selector, view: j?.view ?? f.views[0], score: f.vision!.score, crop: j ? cropUrl(j.id) : null };
          }),
      };
    })(),
    site: {
      http: r.site?.http ? `${r.site.http.end} after ${r.site.http.hops} ${r.site.http.hops === 1 ? "hop" : "hops"}` : null,
      favicon: r.site?.favicon?.status ?? null,
      preloaded: r.site?.preloaded ?? null,
      page: r.site?.page ? { url: r.site.page.url.slice(0, 200), status: r.site.page.status, headers: Object.keys(r.site.page.headers) } : null,
    },
    notes: [...r.notes],
  };
}
