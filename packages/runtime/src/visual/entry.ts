// @genclass/runtime/visual: the measured visual checks without a runtime, for your own Playwright or Cypress tests
// and for CI scans (docs/runtime/VISUAL.md 9.3).
//
//   import { checkPage } from "@genclass/runtime/visual";
//   const findings = await checkPage();          // in the page: report-only, never changes anything
//
// The checks themselves load on demand (dist/visual/index.js), so importing this entry costs almost nothing.

import { browserClock } from "../clock.js";
import type { CheckFinding, Clock, VisualOptions } from "../types.js";

export type { CheckFinding, CheckKind, CheckSeverity, VisualOptions, VisualFixKind, VisualSummary } from "../types.js";

export interface CheckPageOptions extends Omit<VisualOptions, "fix" | "on"> {
  /** Default: the runtime's browser clock. */
  clock?: Clock;
  /** The window to check (default globalThis). */
  global?: Record<string, unknown>;
  /** Element descriptions for findings (default: the tag and its first words). */
  describe?: (el: Element) => string;
}

/**
 * Run the measured visual checks once on the current page and resolve with what they confirmed: settle, one pass,
 * the persistence re-checks (about 2 s). Report-only: nothing on the page changes, and nothing is printed or sent.
 * Interaction checks (clicks, focus, hover) need a running runtime and are not part of a single pass.
 */
export async function checkPage(options: CheckPageOptions = {}): Promise<CheckFinding[]> {
  const m = await import("./index.js");
  return m.checkPageWith({ ...options, clock: options.clock ?? browserClock });
}
