// What a check produces before it is confirmed and reported (docs/runtime/VISUAL.md section 9), and the context
// every check reads through. Types and small helpers only.

import type { CheckFinding, CheckKind, CheckSeverity, VisualFixKind } from "../types.js";
import type { Reader, Win } from "./measure.js";

/** A runtime fix a check proposes; fix.ts applies it only when the fix gate allows (VISUAL.md section 11). */
export type FixPlan =
  | {
      type: "color";
      kind: Extract<VisualFixKind, "text-invisible">;
      el: Element;
      color: string;
      fill: boolean;
      target: number;
      /** The resolved background ("#rrggbb") the colour was computed against: the fix holds only while it is unchanged. */
      bg: string;
    }
  | { type: "inline"; kind: Exclude<VisualFixKind, "text-invisible">; el: HTMLElement; props: string[] };

export interface Draft {
  kind: CheckKind;
  /** The element the finding is about (null for page-level findings without one). */
  el: Element | null;
  /** Dedupe key: one report per key per route. */
  key: string;
  /** The finding's target when it has no element (request-stalled: the request). */
  target?: string;
  severity: CheckSeverity;
  measured: Record<string, number | string | boolean>;
  threshold: CheckFinding["threshold"];
  /** The console sentence after "[GenClass] Check (measured): ", with what was measured and the threshold. */
  text: string;
  /** What to change when CSS is not the fix (a URL, a header, HTML, code): printed as "Fix: ...". */
  fixText?: string;
  suggestion?: { selector: string; css: string; note?: string };
  /** Extra lines for the collapsed console group. */
  details?: string[];
  state?: "rest" | "hover" | "focus" | "touch";
  plan?: FixPlan;
  /** Elements folded into this draft (count = their number). */
  els?: Element[];
  count?: number;
  /** Persistence (VISUAL.md 2.3): re-measure this long after the first measurement; the same verdict confirms it. */
  persistMs?: number;
  /** Wait for network quiet before re-measuring (template leaks, placeholders, encoding). */
  quiet?: boolean;
  recheck?: (r: Reader) => Draft | null | Promise<Draft | null>;
}

/** Everything a check reads. */
export interface Ctx {
  r: Reader;
  win: Win;
  /** Clock time now. */
  now: number;
  scheme: "light" | "dark";
  /** The runtime's element description. */
  describe(el: Element): string;
  /** The developer selector (VISUAL.md 2.6). */
  sel(el: Element): string;
  /** Count a measurement that abstained (never reported). */
  abstain(why: string): void;
  /** The kind is on (visual.checks) for this pass's tier. */
  on(kind: CheckKind): boolean;
  /** Elements per step (maxElements, halved after a slow read). */
  max: number;
  /** visual.ignore entries (hosts for text-placeholder). */
  ignore: string[];
}

/** 'button "Save"' -> 'button.save "Save"' style target text for messages: the selector plus the quoted name. */
export function named(ctx: Ctx, el: Element): string {
  const d = ctx.describe(el);
  const q = d.indexOf('"');
  return q >= 0 ? `${ctx.sel(el)} ${d.slice(q)}` : ctx.sel(el);
}

export const px = (n: number): string => `${Math.round(n)} px`;
export const fixed2 = (n: number): string => (Math.floor(n * 100) / 100).toFixed(2);
