// Findings and their console text (docs/runtime/VISUAL.md 9.1, 9.2). Every line starts
// "[GenClass] Check (measured):" and never shows a probability, so it cannot be read as model output.

import type { CheckFinding } from "../types.js";
import type { Draft } from "./draft.js";

export const PREFIX = "[GenClass] Check (measured): ";
const FIXABLE = new Set(["text-invisible", "pointer-events-leak", "scroll-lock-stuck"]);

/**
 * Merge drafts that describe the same thing: the same kind and suggested selector (or the same key). The merged
 * draft lists every element; `folded` is how many elements were folded into it.
 */
export function fold(drafts: Draft[]): (Draft & { folded?: number })[] {
  const byKey = new Map<string, Draft & { folded?: number }>();
  for (const d of drafts) {
    const k = d.suggestion ? `${d.kind}|${d.suggestion.selector}|${d.state ?? ""}` : d.key;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...d, els: [...(d.els ?? (d.el ? [d.el] : []))] });
      continue;
    }
    const els = prev.els ?? [];
    for (const e of d.els ?? (d.el ? [d.el] : [])) if (!els.includes(e)) els.push(e);
    prev.els = els;
    prev.folded = els.length;
    prev.count = Math.max(prev.count ?? 1, els.length);
  }
  return [...byKey.values()];
}

export interface FindingContext {
  id: string;
  at: number;
  route: string;
  scheme: "light" | "dark";
  viewport: { w: number; h: number };
  coarse: boolean;
  tier: "full" | "light";
  target: string;
  selector: string;
  structural: boolean;
}

function measuredLine(m: Draft["measured"]): string {
  return Object.entries(m)
    .map(([k, v]) => `${k} ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(", ");
}

/** Build the finding for a confirmed draft. */
export function toFinding(d: Draft & { folded?: number }, c: FindingContext): CheckFinding {
  const W = (globalThis as { WeakRef?: new (v: Element) => { deref(): Element | undefined } }).WeakRef;
  const el = d.el;
  const ref = el && W ? new W(el) : null;
  const strong = ref ? null : el;
  const count = d.count && d.count > 1 ? d.count : undefined;
  let line = `${PREFIX}${d.text}`;
  if (d.folded && d.folded > 1) line += ` (${d.folded} elements with this selector)`;
  if (d.suggestion) line += ` Suggested CSS: ${d.suggestion.selector} { ${d.suggestion.css} }`;
  else if (d.fixText) line += ` Fix: ${d.fixText}.`;
  const details = [
    `Measured: ${measuredLine(d.measured)}.`,
    `Threshold: ${d.threshold.value} ${d.threshold.unit} (${d.threshold.source}).`,
    `Element: ${c.selector}${c.target && c.target !== c.selector ? ` (${c.target})` : ""}${d.folded && d.folded > 1 ? `, ${d.folded} elements in all` : ""}.${c.structural ? " The selector is structural: apply the change in the component that renders this element." : ""}`,
  ];
  if (d.suggestion) {
    details.push(`Suggested CSS: ${d.suggestion.selector} { ${d.suggestion.css} }${d.suggestion.note ? ` ${d.suggestion.note}` : ""}`);
    if (d.fixText) details.push(`Fix: ${d.fixText}.`);
  }
  for (const x of d.details ?? []) details.push(x);
  if (FIXABLE.has(d.kind) && d.plan) details.push("Runtime fix: available with GenClass.init({ mode: \"guard\", visual: { fix: true } }); observe mode never changes the page.");
  details.push("This is a measured check with a fixed threshold, not a model finding.");
  details.push(`Ignore: add data-genclass-ignore to the element, or GenClass.init({ visual: { ignore: [${JSON.stringify(c.selector)}] } }).`);
  const f: CheckFinding = {
    id: c.id,
    source: "check",
    basis: "measurement",
    kind: d.kind,
    severity: d.severity,
    at: c.at,
    route: c.route,
    target: c.target,
    selector: c.selector,
    element: () => {
      const e = ref ? ref.deref() ?? null : strong;
      return e && e.isConnected ? e : null;
    },
    measured: { ...d.measured },
    threshold: { ...d.threshold },
    context: { scheme: c.scheme, ...(d.state ? { state: d.state } : {}), viewport: { ...c.viewport }, coarse: c.coarse, tier: c.tier },
    message: line,
    details,
  };
  if (d.suggestion) f.suggestion = { ...d.suggestion };
  if (count) f.count = count;
  return f;
}
