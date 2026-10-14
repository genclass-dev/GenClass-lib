// The scan score: 100 minus a weighted count of findings, with a cap per category so one noisy category cannot
// zero the page. Pure and deterministic: the same findings always give the same score. The formula and every
// weight below are published on /scan/about (page.ts renders them from these constants).

export type Category = "readability" | "media" | "layout" | "interaction";
export type Severity = "high" | "medium" | "low";

export const SCORE_VERSION = "scan-score/2";

export const CATEGORIES: { id: Category; label: string; cap: number; covers: string }[] = [
  { id: "readability", label: "Readability", cap: 25, covers: "Text that cannot be read, template or placeholder text, garbled characters, fonts and icon fonts that failed to load" },
  { id: "media", label: "Images and media", cap: 25, covers: "Images, background images, video and audio that failed to load, stretched images" },
  { id: "layout", label: "Layout", cap: 25, covers: "Stylesheets that failed or were blocked, CSS variables defined nowhere, sideways scrolling, no viewport meta tag, layout shifts, an empty page" },
  { id: "interaction", label: "Interaction and races", cap: 25, covers: "A page that ignores clicks or cannot scroll, controls under fixed bars, hidden focus, covered dialogs, a double click that sends a request twice, problems GenClass's model diagnosed" },
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
