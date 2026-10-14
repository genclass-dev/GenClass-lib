// Turns a scan result into the report the page shows and the cache keeps: findings merged across views, numbered
// in a fixed order, with their words and fixes; the score and its breakdown; and the measured "with GenClass" pass.
// A finding counts as fixed only when the re-check in the same browser session shows it gone and a GenClass
// action is on record for it (a visual fix the chunk applied, or guard's own action on the clicked request). Nothing
// here estimates or projects a fix. Every other finding is reported for the developer with its suggested fix. A finding that may come from the scanner's own
// stand-in answer to the page's POST requests is listed but not scored.

import { describe, isVisual, KINDS, severityOf, suggestFix, type Kind, type RawFinding } from "./catalog.ts";
import type { ProbeResult, ScanResult, VisualFixes } from "./scan.ts";
import { CATEGORIES, score, type Category, type ScoreBreakdown, type Severity } from "./score.ts";
import type { Target } from "./target.ts";
import { FIX_KINDS, visualKey } from "./visual.ts";

/**
 * The version of the checks and the report. Bump it whenever a change would give a different report for the same
 * page: cached reports from another version are not served (store.ts cachedReport).
 */
export const REPORT_VERSION = 4;

export interface Finding {
  n: number;
  kind: Kind;
  category: Category;
  severity: Severity;
  views: string[];
  selector: string;
  boxes: Record<string, { x: number; y: number; w: number; h: number }>;
  measured: string;
  what: string;
  why: string;
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
  ms: ScanResult["ms"];
  timedOut: boolean;
  views: { id: string; label: string; width: number; height: number; ok: boolean; status: number | null; ms: number; notes: string[]; shot: string | null; shotHeight: number; error?: string; checks: unknown; standIns: number }[];
  findings: Finding[];
  score: ScoreBreakdown;
  withGenClass: { shown: boolean; value: number | null; breakdown: ScoreBreakdown | null; fixed: number; note: string };
  probe: {
    observe: ProbeResult | null; guard: ProbeResult | null; guardHoldMs: number | null; guardAggressiveness: string; guardMargin: number | null;
    /** How the guard pass was configured, in words: the shipped default, or what differs from it. */
    guardSetting: string;
    /** Whether GenClass guard measurably stopped the double click's repeat, tied to its own action on that request. */
    guardClick: { acted: boolean; how: string | null };
  };
  notes: string[];
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i])) as Record<Category, number>;
const VIEW_ORDER: Record<string, number> = { desktop: 0, phone: 1, "phone-dark": 2, probe: 3 };

/** The identity of a finding across views: the same element with the same problem is one finding. */
function identity(f: RawFinding): string {
  const d = f.detail ?? {};
  if (f.kind === "genclass-detection") return `${f.kind}|${String(d.diagnosis)}|${String(d.subject)}`;
  if (isVisual(f.kind)) return visualKey(f);
  return `${f.kind}|${f.selector}`;
}

const MOVES: Record<string, string> = { coalesce: "merging the two", discard: "dropping it", defer: "holding it back", retry: "retrying it", cancel: "cancelling it" };

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
    const subject = String(f.detail?.subject ?? "");
    match = (d) => d.subject === subject;
  }
  const d = guard.detections.find((x) => match(x) && !x.executed && !!x.candidate && typeof x.gain === "number" && typeof x.margin === "number");
  if (!d || d.gain === null || d.gain === undefined || d.margin === null || d.margin === undefined) return null;
  const move = MOVES[String(d.candidate)] ?? String(d.candidate);
  return `Flagged, held back at ${isDefault ? "the default safety margin" : "this setting's safety margin"}: in the guard pass GenClass was ${Math.round(d.p * 100)}% sure this was a ${d.diagnosis}, but ${move} had an expected gain of ${Math.round(d.gain * 100) / 100} against a margin of ${d.margin}, so it did not act${f.kind === "duplicate-submit" ? " and both requests went out" : ""}. The suggested fix above removes it.`;
}

/** The kind's words for what GenClass does with a finding it did not fix. */
function notFixedText(kind: Kind, why: string | null): string {
  if (kind === "duplicate-submit" || kind === "genclass-detection") return why ?? "Not fixed in this run. The suggested fix above removes it.";
  if (FIX_KINDS.has(kind)) return `GenClass can fix this kind in the page, but not here: ${why ?? "the with-GenClass pass did not run on this view."} The suggested fix above removes it for every visitor.`;
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

/** How the guard pass fixed a race finding, when the re-run measured it gone and GenClass acted; else null. */
export function raceFix(f: RawFinding, observe: ProbeResult | null, guard: ProbeResult | null): { how: string } | null {
  if (!guard || !guard.ran) return null;
  if (f.kind === "duplicate-submit") return guardClickFix(observe, guard);
  if (f.kind === "genclass-detection") {
    const subject = String(f.detail?.subject ?? "");
    const acted = guard.acts.find((a) => a.ok && a.trigger === "delivery" && (a.action === "discard" || a.action === "defer") && (!subject || a.subject === subject));
    return acted ? { how: `GenClass guard ran ${acted.action} on the late response: ${acted.changed || "its write was dropped"}` } : null;
  }
  return null;
}

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
const STAND_IN_KINDS = new Set<Kind>(["text-template-leak", "text-placeholder", "image-broken", "page-blank"]);
export const STAND_IN_NOTE =
  "The page sent requests other than GET while loading and the scanner answered them itself, so this may come from that stand-in answer rather than from the site.";

export function buildReport(
  target: Target,
  ids: { id: string; key: string; at: Date; runtime: string; shotUrl: (view: string) => string | null; guardHoldMs: number | null; guardAggressiveness?: string; guardMargin?: number | null },
  r: ScanResult,
  flags: { withGenClass: boolean },
): Report {
  const merged = new Map<string, { raw: RawFinding; views: string[]; boxes: Finding["boxes"] }>();
  const add = (f: RawFinding, view: string) => {
    const k = identity(f);
    const cur = merged.get(k);
    if (cur) {
      if (!cur.views.includes(view)) cur.views.push(view);
      if (f.box && !cur.boxes[view]) cur.boxes[view] = f.box;
      return;
    }
    merged.set(k, { raw: f, views: [view], boxes: f.box ? { [view]: f.box } : {} });
  };
  for (const v of r.views) for (const f of v.findings) if (Object.hasOwn(KINDS, f.kind)) add(f, v.id);
  for (const f of probeFindings(r.probe)) add(f, "probe");

  // views whose page got stand-in answers while loading (the probe ran on the desktop page)
  const standIn = new Set(r.views.filter((v) => (v.standIns?.count ?? 0) > 0).map((v) => v.id as string));
  if (standIn.has("desktop") || (r.probe?.loadStandIns ?? 0) > 0) standIn.add("probe");
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
  const list = [...merged.values()].map(({ raw, views, boxes }) => {
    const meta = KINDS[raw.kind];
    const words = describe(raw);
    let fixed: { how: string } | null = null;
    let why: string | null = null;
    if (raw.kind === "duplicate-submit" || raw.kind === "genclass-detection") {
      fixed = raceFix(raw, r.probe, r.guard);
      why = heldBack(raw, r.probe, r.guard, (ids.guardMargin ?? null) === null && (ids.guardAggressiveness ?? "balanced") === "balanced");
    }
    else if (FIX_KINDS.has(raw.kind) && flags.withGenClass) ({ fixed, why } = visualFix(identity(raw), views));
    const fromStandIn = (STAND_IN_KINDS.has(raw.kind) || (raw.kind === "genclass-detection" && String(raw.detail?.diagnosis) !== "duplicate")) && views.every((v) => standIn.has(v));
    return {
      n: 0,
      kind: raw.kind,
      category: meta.category,
      severity: severityOf(raw),
      views: views.sort((a, b) => (VIEW_ORDER[a] ?? 9) - (VIEW_ORDER[b] ?? 9)),
      selector: raw.selector,
      boxes,
      measured: raw.measured,
      what: words.what,
      why: words.why,
      fix: suggestFix(raw),
      fixed,
      genclass: fixed ? { status: "fixed", text: `Fixed. ${fixed.how}` } : { status: FIX_KINDS.has(raw.kind) || raw.kind === "duplicate-submit" || raw.kind === "genclass-detection" ? "not-fixed" : "reported", text: notFixedText(raw.kind, why) },
      unscored: fromStandIn ? STAND_IN_NOTE : null,
    } satisfies Finding;
  });
  list.sort(
    (a, b) =>
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      CAT_ORDER[a.category] - CAT_ORDER[b.category] ||
      (VIEW_ORDER[a.views[0]] ?? 9) - (VIEW_ORDER[b.views[0]] ?? 9) ||
      a.kind.localeCompare(b.kind) ||
      a.selector.localeCompare(b.selector) ||
      a.measured.localeCompare(b.measured),
  );
  list.forEach((f, i) => (f.n = i + 1));

  const scored = list.filter((f) => !f.unscored);
  const without = score(scored);
  const fixedCount = scored.filter((f) => f.fixed).length;
  const withBreakdown = score(scored.filter((f) => !f.fixed));
  const guardRan = !!r.guard?.ran;
  const visualRan = r.views.some((v) => v.ok && v.checks !== null);
  const measuredWith = guardRan || visualRan;
  const note = !flags.withGenClass
    ? "The with-GenClass score is switched off in this copy of the scanner."
    : measuredWith
      ? "Measured in the same browser session: GenClass's visual checks ran in guard mode with their fixes on, a second set of the same checks re-measured the page, and the race probe ran again with GenClass guard. A finding counts as fixed only when the re-check no longer found it. GenClass fixes three kinds in the page (invisible text colour, a leaked pointer-events: none, a leaked scroll lock); it reports the rest for the developer."
      : "GenClass could not be measured on this page, so nothing is counted as fixed.";

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
    ms: r.ms,
    timedOut: r.timedOut,
    views: r.views.map((v) => ({
      id: v.id, label: v.label, width: v.width, height: v.height, ok: v.ok, status: v.status, ms: v.ms, notes: v.notes,
      shot: v.shot ? ids.shotUrl(v.id) : null, shotHeight: v.shotHeight, ...(v.error ? { error: v.error } : {}), checks: v.checks, standIns: v.standIns?.count ?? 0,
    })),
    findings: list,
    score: without,
    withGenClass: {
      shown: flags.withGenClass && measuredWith,
      value: flags.withGenClass && measuredWith ? withBreakdown.value : null,
      breakdown: flags.withGenClass && measuredWith ? withBreakdown : null,
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
    notes: [...r.notes],
  };
}
