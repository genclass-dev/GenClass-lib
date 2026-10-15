// axe-core in the scanned page. The scanner runs the unmodified axe-core build (src/axe-source.ts, MPL-2.0) in
// Puppeteer's isolated world of each view, the same way it runs the GenClass visual checks: the page's scripts cannot
// see, replace or patch it. The installer takes axe only when the embedded source itself defined it, moves it to a
// per-scan random, non-writable name and deletes window.axe.
//
// The run: WCAG 2.2 A and AA rule tags plus best practices, violations only, no iframes (each frame would need its own
// copy), no network (preload off), scroll restored. Three rules are turned off because the scanner measures the same
// thing itself and would otherwise count it twice: target-size (the phone tap-target audit, WCAG 2.5.8), meta-viewport
// and meta-viewport-large (the pinch-zoom audit, WCAG 1.4.4). Rules axe-core cannot decide ("incomplete", needs review)
// are never findings: the report gives their count only.
//
// What comes back is plain data, checked again here (axeFindings): a rule id of the right shape, a known impact, tags
// of the right shape, help text cut to size, a helpUrl on dequeuniversity.com only, short selectors, numeric boxes.

import { AXE_RULE, type RawFinding } from "./catalog.ts";
import type { Severity } from "./score.ts";
import { isWcagRule } from "./standards.ts";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] as const;
/** Rules the scanner measures itself (see the header); turned off in axe so nothing is counted twice. */
export const AXE_OFF = ["target-size", "meta-viewport", "meta-viewport-large"] as const;
/** Element selectors kept per rule in the report. */
export const AXE_EXAMPLES = 5;
/** Element boxes read per rule (for the screenshot marks and to match the visual checks' invisible-text findings). */
const AXE_BOXES = 50;

/** The installer: true when axe-core is installed under `name` (also when it already was). */
export function installAxeSource(name: string, axeSource: string): string {
  const n = JSON.stringify(name);
  return `(() => {
  if (Object.getOwnPropertyDescriptor(window, ${n})) return true;
  if (Object.getOwnPropertyDescriptor(window, "axe")) return false;
  try {
${axeSource}
  } catch (e) { try { delete window.axe; } catch (x) {} return false; }
  const d = Object.getOwnPropertyDescriptor(window, "axe");
  const ax = d && "value" in d && d.value && typeof d.value.run === "function" ? d.value : null;
  try { delete window.axe; } catch (e) {}
  if (!ax) return false;
  Object.defineProperty(window, ${n}, { value: ax, writable: false, configurable: false, enumerable: false });
  return true; })()`;
}

/** One axe run in the page, returned as a JSON string: the violations with up to 50 element targets and boxes each. */
export function runAxeSource(name: string): string {
  const options = {
    runOnly: { type: "tag", values: [...AXE_TAGS] },
    rules: Object.fromEntries(AXE_OFF.map((r) => [r, { enabled: false }])),
    resultTypes: ["violations"],
    iframes: false,
    preload: false,
    restoreScroll: true,
    selectors: true,
    ancestry: false,
    xpath: false,
    absolutePaths: false,
    elementRef: false,
    performanceTimer: false,
  };
  return `(async () => {
  const ax = window[${JSON.stringify(name)}];
  if (!ax || typeof ax.run !== "function") return JSON.stringify({ ok: false, error: "axe-core is not installed" });
  const t0 = performance.now();
  try { ax.configure({ noHtml: true }); } catch (e) {}
  let r;
  try { r = await ax.run(document, ${JSON.stringify(options)}); }
  catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  const sx = window.scrollX, sy = window.scrollY;
  const target = (t) => {
    if (!Array.isArray(t) || !t.length) return "";
    const last = t[t.length - 1];
    return Array.isArray(last) ? last.map(String).join(" >>> ") : String(last);
  };
  const find = (t) => {
    if (!Array.isArray(t) || t.length !== 1 || typeof t[0] !== "string") return null;
    try { return document.querySelector(t[0]); } catch (e) { return null; }
  };
  const box = (t) => {
    const el = find(t);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0)) return null;
    return { x: Math.round(b.left + sx), y: Math.round(b.top + sy), w: Math.round(b.width), h: Math.round(b.height) };
  };
  // WCAG 1.4.3's exceptions: incidental text (inside an element the author marked as a picture or as decoration) and
  // logotypes (text that is only the site's own name, such as a brand-name watermark)
  const label = String(location.hostname || "").replace(/^www\\./, "").split(".")[0].replace(/[^a-z0-9]/g, "");
  const brand = (el) => label.length >= 3 && String(el.textContent || "").toLowerCase().replace(/[^a-z0-9]/g, "") === label;
  const picture = (t) => { const el = find(t); return !!(el && ((el.closest && el.closest('[role="img"], [aria-hidden="true"]')) || brand(el))); };
  const violations = (r.violations || []).slice(0, 80).map((v) => ({
    id: v.id, impact: v.impact, tags: v.tags, help: v.help, description: v.description, helpUrl: v.helpUrl,
    count: (v.nodes || []).length,
    nodes: (v.nodes || []).slice(0, ${AXE_BOXES}).map((n, i) => ({ target: target(n.target), box: box(n.target), picture: v.id === "color-contrast" ? picture(n.target) : false, summary: i < 5 ? String(n.failureSummary || "").slice(0, 600) : "" })),
  }));
  return JSON.stringify({ ok: true, ms: Math.round(performance.now() - t0), version: String(ax.version || ""), violations, incomplete: (r.incomplete || []).length, passes: (r.passes || []).length });
})()`;
}

const IMPACT: Record<string, Severity> = { critical: "critical", serious: "serious", moderate: "moderate", minor: "minor" };
const LOWER: Record<Severity, Severity> = { critical: "serious", serious: "moderate", moderate: "minor", minor: "minor" };
const HELP_URL = /^https:\/\/dequeuniversity\.com\/rules\/axe\/[\w.\/-]{1,120}(?:\?[\w=&.%-]{0,120})?$/;
/** The tags kept with a finding: WCAG levels and success criteria, and best-practice. */
const KEEP_TAG = /^(?:wcag2(?:1|2)?a{1,3}|wcag\d{3,4}|best-practice)$/;

const cut = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : "";
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) : clean;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
type Box = { x: number; y: number; w: number; h: number };
const boxOf = (v: unknown): Box | null => {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const [x, y, w, h] = [num(b.x), num(b.y), num(b.w), num(b.h)];
  return x !== null && y !== null && w !== null && h !== null && w >= 0 && h >= 0 ? { x, y, w, h } : null;
};

/**
 * The severity of an axe-core rule: its impact, one level lower for a rule that is only a best practice (no WCAG A or
 * AA tag), since a best practice is advice rather than a requirement.
 */
export function axeSeverity(impact: unknown, tags: readonly string[]): Severity {
  const base = typeof impact === "string" && Object.hasOwn(IMPACT, impact) ? IMPACT[impact] : "moderate";
  return isWcagRule(tags) ? base : LOWER[base];
}

/**
 * axe-core's failure summary for one element ("Fix any of the following:\n  Element has ...\n  aria-label ...") as one
 * sentence: its messages joined with semicolons, the "Fix any/all of the following" headings left out.
 */
export function axeSummary(s: string): string {
  const parts = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l && !/^Fix (?:any|all) of the following:?$/i.test(l))
    .map((l) => l.replace(/[.;]+$/, ""));
  return parts.length ? `${parts.join("; ")}.` : "";
}

/** The first summary among the elements, cut to the size the report keeps. */
const firstSummary = (nodes: readonly { summary: string }[]): string => (nodes.find((n) => n.summary)?.summary ?? "").slice(0, 300);

export interface AxeRule {
  rule: string;
  severity: Severity;
  impact: string;
  tags: string[];
  help: string;
  description: string;
  helpUrl: string | null;
  /** How many elements failed the rule in this view. */
  count: number;
  /** Up to 50 elements: their selector, box (null when it could not be read) and, for the first 5, axe-core's failure summary. */
  nodes: { target: string; box: Box | null; summary: string }[];
  /** The first element's failure summary, as one sentence. */
  summary: string;
}

export interface AxeView {
  ok: boolean;
  error: string | null;
  ms: number | null;
  version: string;
  rules: AxeRule[];
  /** Rules axe-core could not decide (needs review): counted, never findings. */
  incomplete: number;
  passes: number;
}

/** What the page returned from runAxeSource, checked and cut to size. Rules turned off or misshapen are dropped. */
export function parseAxe(v: unknown): AxeView {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const base: AxeView = { ok: o.ok === true, error: o.ok === true ? null : cut(o.error, 200) || "axe-core did not run", ms: num(o.ms), version: cut(o.version, 20), rules: [], incomplete: Math.max(0, Math.round(num(o.incomplete) ?? 0)), passes: Math.max(0, Math.round(num(o.passes) ?? 0)) };
  if (!base.ok || !Array.isArray(o.violations)) return base;
  const seen = new Set<string>();
  for (const raw of o.violations.slice(0, 80)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const rule = typeof r.id === "string" && AXE_RULE.test(r.id) ? r.id : null;
    if (!rule || seen.has(rule) || (AXE_OFF as readonly string[]).includes(rule)) continue;
    seen.add(rule);
    const tags = (Array.isArray(r.tags) ? r.tags : []).filter((t): t is string => typeof t === "string" && KEEP_TAG.test(t)).slice(0, 8);
    const all = (Array.isArray(r.nodes) ? r.nodes : []).slice(0, AXE_BOXES).map((n) => {
      const x = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
      return { target: cut(x.target, 200), box: boxOf(x.box), summary: axeSummary(cut(x.summary, 600)), picture: x.picture === true };
    });
    // color-contrast: text WCAG 1.4.3 exempts, marked in the page: inside an element marked role="img" or aria-hidden="true"
    // (incidental: part of a picture, or decoration) or only the site's own name (a logotype); both measured in calibration
    const pictures = rule === "color-contrast" ? all.filter((n) => n.picture).length : 0;
    const nodes = all.filter((n) => !(rule === "color-contrast" && n.picture)).map(({ target, box, summary }) => ({ target, box, summary }));
    const count = Math.max(nodes.length, Math.round(num(r.count) ?? 0) - pictures);
    if (count < 1) continue;
    const helpUrl = typeof r.helpUrl === "string" && HELP_URL.test(r.helpUrl) ? r.helpUrl : null;
    base.rules.push({
      rule,
      severity: axeSeverity(r.impact, tags),
      impact: typeof r.impact === "string" && Object.hasOwn(IMPACT, r.impact) ? r.impact : "moderate",
      tags,
      help: cut(r.help, 200),
      description: cut(r.description, 400),
      helpUrl,
      count,
      nodes,
      summary: firstSummary(nodes),
    });
  }
  return base;
}

/** The same box, give or take `tol` px on each edge. */
const sameBox = (a: Box, b: Box, tol = 2): boolean => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

/**
 * The visual checks report text below 1.5:1 as invisible text (a visual bug); axe-core's color-contrast reports the same
 * element again (below 4.5:1). An element both found, in the same view, is counted once: in the visual finding. Returns
 * the rules with those elements taken out of color-contrast (and the rule dropped when nothing is left).
 */
export function withoutVisualDuplicates(rules: readonly AxeRule[], visual: readonly RawFinding[]): AxeRule[] {
  const boxes = visual.filter((f) => f.kind === "text-invisible" && f.box).map((f) => f.box as Box);
  if (!boxes.length) return [...rules];
  const out: AxeRule[] = [];
  for (const r of rules) {
    if (r.rule !== "color-contrast") {
      out.push(r);
      continue;
    }
    const dup = r.nodes.filter((n) => n.box && boxes.some((b) => sameBox(b, n.box as Box)));
    if (!dup.length) {
      out.push(r);
      continue;
    }
    const nodes = r.nodes.filter((n) => !dup.includes(n));
    const count = r.count - dup.length;
    // the summary is the first remaining element's
    if (count > 0) out.push({ ...r, nodes, count, summary: firstSummary(nodes) });
  }
  return out;
}

/** One view's axe-core rules as findings (kind "axe"), one per rule, ready for the report to merge across views. */
export function axeFindings(rules: readonly AxeRule[]): RawFinding[] {
  return rules.map((r) => {
    const first = r.nodes.find((n) => n.box) ?? r.nodes[0];
    const examples = [...new Set(r.nodes.map((n) => n.target).filter(Boolean))].slice(0, AXE_EXAMPLES);
    return {
      kind: "axe",
      selector: r.nodes[0]?.target ?? "",
      box: first?.box ?? null,
      measured: r.summary,
      detail: {
        rule: r.rule,
        severity: r.severity,
        impact: r.impact,
        tags: r.tags,
        help: r.help,
        description: r.description,
        ...(r.helpUrl ? { helpUrl: r.helpUrl } : {}),
        count: r.count,
        examples,
      },
    };
  });
}
