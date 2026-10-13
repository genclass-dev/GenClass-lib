// The scan score: 100 minus a weighted count of findings, with a cap per category so one noisy category cannot
// zero the page. Pure and deterministic: the same findings always give the same score. The formula and every
// weight below are published on /scan/about (page.ts renders them from these constants).

export type Category = "readability" | "media" | "layout" | "interaction";
export type Severity = "high" | "medium" | "low";

export const SCORE_VERSION = "scan-score/1";

export const CATEGORIES: { id: Category; label: string; cap: number; covers: string }[] = [
  { id: "readability", label: "Readability", cap: 25, covers: "Text that cannot be read, template text that leaked onto the page, fonts that failed to load" },
  { id: "media", label: "Images and media", cap: 25, covers: "Images that failed to load" },
  { id: "layout", label: "Layout", cap: 25, covers: "Sideways scrolling on a phone, stylesheets that failed to load" },
  { id: "interaction", label: "Interaction and races", cap: 25, covers: "Controls covered by another element, a double click that sends a request twice, a response GenClass flagged as landing over newer data" },
];

export const SEVERITY_POINTS: Record<Severity, number> = { high: 10, medium: 5, low: 2 };

export interface Scorable {
  category: Category;
  severity: Severity;
}

export interface ScoreBreakdown {
  version: string;
  value: number;
  categories: { id: Category; label: string; cap: number; raw: number; deducted: number; count: number }[];
}

/** score = 100 - sum over categories of min(cap, sum of severity points of its findings). */
export function score(findings: readonly Scorable[]): ScoreBreakdown {
  const categories = CATEGORIES.map((c) => {
    const mine = findings.filter((f) => f.category === c.id);
    const raw = mine.reduce((s, f) => s + SEVERITY_POINTS[f.severity], 0);
    return { id: c.id, label: c.label, cap: c.cap, raw, deducted: Math.min(c.cap, raw), count: mine.length };
  });
  const value = Math.max(0, 100 - categories.reduce((s, c) => s + c.deducted, 0));
  return { version: SCORE_VERSION, value, categories };
}
