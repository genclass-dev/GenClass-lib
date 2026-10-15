// The scan score (scan-score/4, strict): eight categories, each scored 0 to 100 from its own findings, and an overall
// score on a strict curve: the weighted geometric mean of the categories, squared (on a 0 to 1 scale), then capped
// when the page has critical or serious findings. Pure and deterministic: the same findings always give the same
// score. The formula and every number below are published on /scan/about (page.ts renders them from these constants).
//
// Inside a category the findings are grouped by rule (a visual check's kind, an axe-core rule, an audit). A rule takes
// points by its severity, scaled up by how many elements it found, at most three times its base:
//     points(rule) = base(severity) * min(3, 1 + log10(instances))
// and the rules of a category combine by multiplication, so each further rule takes a share of what is left:
//     category = 100 * product over rules of (1 - min(points(rule), 100) / 100)
// The overall score takes the weighted geometric mean of the categories measured on this scan (each counted as at least
// 10), so one badly failing category pulls the whole score down instead of being averaged away, and squares it on a
// 0 to 1 scale (the strict curve: a mean of 90 gives 81, 70 gives 49, 50 gives 25):
//     mean    = product over measured categories of (max(category, 10) / 100) ^ (weight / sum of weights)
//     overall = 100 * mean ^ 2
// and then caps it: a critical finding caps it at 59, two or more critical rules at 35, and three or more serious or
// critical rules at 69 (CAPS). Every point lost traces to a listed finding: a rule's cost is the mean without it minus the mean with
// it (ruleImpact), and a cap names the rules that set it.
// A category that was not measured (axe-core did not finish, the race probe found nothing to try) is left out and shown
// as "not measured", never as 100.

export type Category = "visual" | "accessibility" | "phone" | "reliability" | "speed" | "security" | "seo" | "races";
export type Severity = "critical" | "serious" | "moderate" | "minor";

export const SCORE_VERSION = "scan-score/4";

export const CATEGORIES: { id: Category; label: string; weight: number; covers: string }[] = [
  {
    id: "visual",
    label: "Visual bugs",
    weight: 20,
    covers: "Text that cannot be read, template or placeholder text, garbled characters, images, stylesheets, fonts and media that failed, stretched images, a blank page, a page that ignores clicks or cannot scroll, controls under fixed bars, covered dialogs (the GenClass visual checks); and elements a model (Clef) judged from the screenshot as visibly broken where the measured checks cannot judge, labelled as judged by a model",
  },
  {
    id: "accessibility",
    label: "Accessibility",
    weight: 22,
    covers: "axe-core's WCAG 2.2 A and AA rules and its best practices in all three views, focus hidden under sticky bars (WCAG 2.4.11), elements that show no visible change when focused by keyboard (WCAG 2.4.7), and a long run of links before the main content without a skip link",
  },
  {
    id: "phone",
    label: "Phone",
    weight: 14,
    covers: "Tap targets under 24 by 24 px (WCAG 2.5.8), zoom turned off (WCAG 1.4.4), no viewport meta tag, text under 12 px, sideways scrolling at 390, 360 and 320 px (WCAG 1.4.10) and on a 768 px tablet",
  },
  {
    id: "reliability",
    label: "Reliability",
    weight: 12,
    covers: "Uncaught JavaScript errors and console.error while the page loads, same-site requests that failed with 4xx or 5xx, mixed content, deprecated browser APIs Chrome reported, a page in quirks mode",
  },
  {
    id: "speed",
    label: "Speed",
    weight: 12,
    covers: "Largest Contentful Paint against the web.dev thresholds, total page weight, images far bigger than they are shown or not in a modern format, images without dimensions that moved the content below them, web fonts without font-display (layout shift itself is listed, not scored)",
  },
  {
    id: "security",
    label: "Security",
    weight: 10,
    covers: "The page over HTTPS, http:// redirecting to https://, and the main document's headers: Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options, protection against framing (X-Frame-Options or frame-ancestors), cookies without Secure, session cookies without HttpOnly",
  },
  {
    id: "seo",
    label: "Search and sharing",
    weight: 5,
    covers: "A meta description, a page search engines may index, link previews (og:title, og:image), a favicon, and links whose whole text is \"click here\" or \"learn more\"",
  },
  {
    id: "races",
    label: "Races",
    weight: 5,
    covers: "A double click that sends a request twice, and problems GenClass's model diagnosed while the probe typed and clicked",
  },
];

/** Base points a rule takes from its category's 100, by severity (before the instance factor). */
export const SEVERITY_POINTS: Record<Severity, number> = { critical: 50, serious: 25, moderate: 15, minor: 12 };
/** A rule's points grow with the log of its instances and stop at this multiple of its base. */
export const INSTANCE_CAP = 3;
/** The lowest a category counts for in the overall geometric mean (a category at 0 would make the whole score 0). */
export const CATEGORY_FLOOR = 10;
/** The strict curve: the geometric mean (0 to 1) is raised to this power. */
export const CURVE = 2;
/**
 * Caps on the overall score: a page with at least `rules` scored rules of this severity (or worse, for "serious")
 * scores at most `cap`. The lowest cap that applies wins.
 */
export const CAPS: { severity: Severity; rules: number; cap: number }[] = [
  { severity: "critical", rules: 2, cap: 35 },
  { severity: "critical", rules: 1, cap: 59 },
  { severity: "serious", rules: 3, cap: 69 },
];
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

export interface ScoreCap {
  /** The cap that applied. */
  at: number;
  severity: Severity;
  /** How many rules of that severity (or worse) it takes. */
  rules: number;
  /** The rules that set it, as "category|rule". */
  by: string[];
}

export interface ScoreBreakdown {
  version: string;
  /** 0 to 100, rounded; null when no category was measured. */
  value: number | null;
  /** The score before any cap: the curved weighted geometric mean (two decimals); null when no category was measured. */
  mean: number | null;
  /** The cap that lowered the score, when one did. */
  cap: ScoreCap | null;
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
 * The weighted geometric mean of category values (unrounded, 0 to 100), each at least CATEGORY_FLOOR; null when there
 * are none. One category at 25 with a quarter of the weight takes it from 100 to about 71, where a mean would give 81.
 */
export function geometricMean(cats: readonly { weight: number; value: number }[]): number | null {
  const w = cats.reduce((s, c) => s + c.weight, 0);
  if (w <= 0) return null;
  const log = cats.reduce((s, c) => s + (c.weight / w) * Math.log(Math.max(CATEGORY_FLOOR, Math.min(100, c.value)) / 100), 0);
  return 100 * Math.exp(log);
}

/** The cap that applies to these scored rules (as "category|rule" with their severity), or null. */
export function capOf(rules: readonly { key: string; severity: Severity }[]): ScoreCap | null {
  let best: ScoreCap | null = null;
  for (const c of CAPS) {
    const hit = rules.filter((r) => sevRank(r.severity) <= sevRank(c.severity)).map((r) => r.key).sort();
    if (hit.length >= c.rules && (!best || c.cap < best.at)) best = { at: c.cap, severity: c.severity, rules: c.rules, by: hit };
  }
  return best;
}

/** The strict curve: a 0 to 100 mean squared on a 0 to 1 scale (90 gives 81, 70 gives 49). */
export const curved = (mean: number): number => 100 * Math.pow(Math.max(0, Math.min(100, mean)) / 100, CURVE);

/** The overall score from measured categories and their rules, unrounded, with the cap that applied. */
function overall(categories: readonly CategoryScore[]): { exact: number | null; mean: number | null; cap: ScoreCap | null } {
  const used = categories.filter((c) => c.raw !== null);
  const g = geometricMean(used.map((c) => ({ weight: c.weight, value: categoryValue(c.rules) })));
  if (g === null) return { exact: null, mean: null, cap: null };
  const mean = curved(g);
  const cap = capOf(used.flatMap((c) => c.rules.map((r) => ({ key: `${c.id}|${r.rule}`, severity: r.severity }))));
  const capped = cap && cap.at < mean ? cap : null;
  return { exact: capped ? capped.at : mean, mean, cap: capped };
}

/**
 * The score. `measured` says which categories this scan measured; a category it did not is left out of the overall
 * score and has no value. Findings in an unmeasured category are not possible in practice, and are ignored if given.
 */
export function score(findings: readonly Scorable[], measured: Partial<Record<Category, boolean>>): ScoreBreakdown {
  const categories: CategoryScore[] = CATEGORIES.map((c) => {
    const isMeasured = measured[c.id] === true;
    const mine = findings.filter((f) => f.category === c.id);
    const rules = isMeasured ? rulesOf(mine) : [];
    const raw = isMeasured ? categoryValue(rules) : null;
    return { id: c.id, label: c.label, weight: c.weight, measured: isMeasured, value: raw === null ? null : Math.round(raw), raw: raw === null ? null : round2(raw), count: isMeasured ? mine.length : 0, rules };
  });
  const o = overall(categories);
  return { version: SCORE_VERSION, value: o.exact === null ? null : Math.round(o.exact), mean: o.mean === null ? null : round2(o.mean), cap: o.cap, categories };
}

/**
 * What each rule costs the score before caps: the curved mean without that rule's findings, minus the curved mean with
 * them (unrounded, two decimals). The report's "top issues" are the rules that cost the most. A cap is named
 * separately (ScoreBreakdown.cap, with the rules that set it): under a cap, removing one other rule would change
 * nothing, so its cost is given before the cap.
 */
export function ruleImpact(findings: readonly Scorable[], measured: Partial<Record<Category, boolean>>): { category: Category; rule: string; points: number }[] {
  const exact = (fs: readonly Scorable[]): number => overall(score(fs, measured).categories).mean ?? 100;
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
