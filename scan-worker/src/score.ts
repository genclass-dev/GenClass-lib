// The scan score (scan-score/3): six categories, each scored 0 to 100 from its own findings, and an overall score that
// is their weighted mean. Pure and deterministic: the same findings always give the same score. The formula and every
// number below are published on /scan/about (page.ts renders them from these constants).
//
// Inside a category the findings are grouped by rule (a visual check's kind, an axe-core rule, an audit). A rule
// takes points by its severity, scaled up by how many elements it found, at most twice its base:
//     points(rule) = base(severity) * min(2, 1 + log10(instances))
// and the rules of a category combine by multiplication, so each further rule takes a share of what is left and a
// category never goes below 0:
//     category = 100 * product over rules of (1 - points(rule) / 100)
// The overall score is the weighted mean of the categories that were measured on this scan:
//     overall = sum(weight * category) / sum(weight)
// A category that was not measured (axe-core did not finish, the race probe found nothing to try) is left out of the
// mean and shown as "not measured", never as 100.

export type Category = "visual" | "accessibility" | "phone" | "reliability" | "speed" | "races";
export type Severity = "critical" | "serious" | "moderate" | "minor";

export const SCORE_VERSION = "scan-score/3";

export const CATEGORIES: { id: Category; label: string; weight: number; covers: string }[] = [
  {
    id: "visual",
    label: "Visual bugs",
    weight: 25,
    covers: "Text that cannot be read, template or placeholder text, garbled characters, images, stylesheets, fonts and media that failed, stretched images, a blank page, a page that ignores clicks or cannot scroll, controls under fixed bars, covered dialogs (the GenClass visual checks); and elements a model (Clef) judged from the screenshot as visibly broken where the measured checks cannot judge, labelled as judged by a model",
  },
  {
    id: "accessibility",
    label: "Accessibility",
    weight: 25,
    covers: "axe-core's WCAG 2.2 A and AA rules and its best practices in all three views, and focus hidden under sticky bars (WCAG 2.4.11)",
  },
  {
    id: "phone",
    label: "Phone",
    weight: 20,
    covers: "Tap targets under 24 by 24 px (WCAG 2.5.8), zoom turned off (WCAG 1.4.4), no viewport meta tag, text under 12 px, sideways scrolling at 390, 360 and 320 px (WCAG 1.4.10)",
  },
  {
    id: "reliability",
    label: "Reliability",
    weight: 15,
    covers: "Uncaught JavaScript errors and console.error while the page loads, same-site requests that failed with 4xx or 5xx, mixed content",
  },
  {
    id: "speed",
    label: "Speed",
    weight: 10,
    covers: "Largest Contentful Paint against the web.dev thresholds, images far bigger than they are shown, images without dimensions that moved the content below them (layout shift itself is listed, not scored)",
  },
  {
    id: "races",
    label: "Races",
    weight: 5,
    covers: "A double click that sends a request twice, and problems GenClass's model diagnosed while the probe typed and clicked",
  },
];

/** Base points a rule takes from its category's 100, by severity (before the instance factor). */
export const SEVERITY_POINTS: Record<Severity, number> = { critical: 30, serious: 15, moderate: 7, minor: 3 };
/** A rule's points grow with the log of its instances and stop at this multiple of its base. */
export const INSTANCE_CAP = 2;
export const SEVERITY_ORDER: Severity[] = ["critical", "serious", "moderate", "minor"];

export interface Scorable {
  category: Category;
  severity: Severity;
  /** The rule the finding belongs to: the visual kind, the axe-core rule id, or the audit. */
  rule: string;
  /** How many elements or instances the finding stands for (default 1). */
  count?: number;
}

export interface RuleScore {
  rule: string;
  severity: Severity;
  instances: number;
  findings: number;
  points: number;
}

export interface CategoryScore {
  id: Category;
  label: string;
  weight: number;
  measured: boolean;
  /** 0 to 100, rounded; null when the category was not measured. */
  value: number | null;
  /** Unrounded, for the overall mean. */
  raw: number | null;
  count: number;
  rules: RuleScore[];
}

export interface ScoreBreakdown {
  version: string;
  /** 0 to 100, rounded; null when no category was measured. */
  value: number | null;
  categories: CategoryScore[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The instance factor: 1 for one instance, 1 + log10(n) after, at most INSTANCE_CAP. */
export function instanceFactor(n: number): number {
  return Math.min(INSTANCE_CAP, 1 + Math.log10(Math.max(1, n)));
}

/** A rule's points: its severity's base times the instance factor. */
export function rulePoints(severity: Severity, instances: number): number {
  return round2(SEVERITY_POINTS[severity] * instanceFactor(instances));
}

const sevRank = (s: Severity): number => SEVERITY_ORDER.indexOf(s);

/** The rules in one category's findings: severity is the most severe instance, instances the sum of counts. */
export function rulesOf(findings: readonly Scorable[]): RuleScore[] {
  const by = new Map<string, { severity: Severity; instances: number; findings: number }>();
  for (const f of findings) {
    const n = Math.max(1, Math.round(f.count ?? 1));
    const cur = by.get(f.rule);
    if (!cur) by.set(f.rule, { severity: f.severity, instances: n, findings: 1 });
    else {
      cur.instances += n;
      cur.findings += 1;
      if (sevRank(f.severity) < sevRank(cur.severity)) cur.severity = f.severity;
    }
  }
  return [...by.entries()]
    .map(([rule, r]) => ({ rule, ...r, points: rulePoints(r.severity, r.instances) }))
    .sort((a, b) => b.points - a.points || a.rule.localeCompare(b.rule));
}

/** One category's score from its rules: 100 times the product of (1 - points / 100). */
export function categoryValue(rules: readonly RuleScore[]): number {
  let v = 100;
  for (const r of rules) v *= 1 - Math.min(100, r.points) / 100;
  return v;
}

/**
 * The score. `measured` says which categories this scan measured; a category it did not is left out of the overall
 * mean and has no value. Findings in an unmeasured category are not possible in practice, and are ignored if given.
 */
export function score(findings: readonly Scorable[], measured: Partial<Record<Category, boolean>>): ScoreBreakdown {
  const categories: CategoryScore[] = CATEGORIES.map((c) => {
    const isMeasured = measured[c.id] === true;
    const mine = findings.filter((f) => f.category === c.id);
    const rules = isMeasured ? rulesOf(mine) : [];
    const raw = isMeasured ? categoryValue(rules) : null;
    return { id: c.id, label: c.label, weight: c.weight, measured: isMeasured, value: raw === null ? null : Math.round(raw), raw: raw === null ? null : round2(raw), count: isMeasured ? mine.length : 0, rules };
  });
  const used = categories.filter((c) => c.raw !== null);
  const w = used.reduce((s, c) => s + c.weight, 0);
  const value = w > 0 ? Math.round(used.reduce((s, c) => s + c.weight * (c.raw as number), 0) / w) : null;
  return { version: SCORE_VERSION, value, categories };
}

/**
 * What each rule costs the overall score: the overall score without that rule's findings, minus the overall score with
 * them (unrounded, two decimals). The report's "top issues" are the rules that cost the most.
 */
export function ruleImpact(findings: readonly Scorable[], measured: Partial<Record<Category, boolean>>): { category: Category; rule: string; points: number }[] {
  const exact = (fs: readonly Scorable[]): number => {
    const s = score(fs, measured);
    const used = s.categories.filter((c) => c.raw !== null);
    const w = used.reduce((t, c) => t + c.weight, 0);
    return w > 0 ? used.reduce((t, c) => t + c.weight * categoryValue(c.rules), 0) / w : 100;
  };
  const base = exact(findings);
  const keys = [...new Set(findings.map((f) => `${f.category}\u0000${f.rule}`))];
  return keys
    .map((k) => {
      const [category, rule] = k.split("\u0000") as [Category, string];
      const without = exact(findings.filter((f) => !(f.category === category && f.rule === rule)));
      return { category, rule, points: round2(without - base) };
    })
    .sort((a, b) => b.points - a.points || a.rule.localeCompare(b.rule));
}
