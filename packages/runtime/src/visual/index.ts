// The lazily loaded visual chunk (dist/visual/index.js; docs/runtime/VISUAL.md section 13): startVisual for the
// runtime's stub (src/visual/start.ts), and checkPageWith for checkPage (src/visual/entry.ts) and tools without a
// runtime. It imports only src/visual/* (types excepted), so it builds to one file the script-tag build can load.

import type { CheckFinding, Clock, VisualOptions } from "../types.js";
import type { VisualController, VisualHost } from "./host.js";
import { follow, hostFor } from "./bridge.js";
import { Visual } from "./engine.js";

export { judgeContrast } from "./checks/text.js";
export { parseColor, contrast, suggestColor } from "./math.js";

/** Start the checks for a runtime (called by the stub once the chunk has loaded). */
export function startVisual(rt: unknown, options: VisualOptions, early: Event[], describe: (el: Element) => string, normalize: (path: string) => string): VisualController {
  const v = new Visual(hostFor(rt, describe, normalize), options, early);
  follow(rt, v);
  return v;
}

export interface CheckPageOptions extends Omit<VisualOptions, "fix" | "on"> {
  /** The clock to time slices with (checkPage passes the runtime's browser clock). */
  clock: Clock;
  /** The window to check (default globalThis). */
  global?: Record<string, unknown>;
  /** Element descriptions for findings (default: the tag and its first words). */
  describe?: (el: Element) => string;
}

function shortDescribe(el: Element): string {
  const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
  const tag = el.tagName.toLowerCase();
  return name ? `${tag} "${name}"` : tag;
}

/** One report-only pass over the page without a runtime; resolves with the confirmed findings. */
export async function checkPageWith(o: CheckPageOptions): Promise<CheckFinding[]> {
  const g = (o.global ?? globalThis) as Record<string, unknown> & { location?: { pathname?: string } };
  const host: VisualHost = {
    clock: o.clock,
    global: g,
    seed: "",
    mode: () => "observe",
    sampled: () => true,
    active: () => true,
    inflight: () => 0,
    errors: () => 0,
    describe: o.describe ?? shortDescribe,
    route: () => String(g.location?.pathname ?? "/"),
    report: () => undefined,
    note: () => undefined,
    audit: () => undefined,
  };
  const { clock: _c, global: _g, describe: _d, ...rest } = o;
  const v = new Visual(host, { ...rest, on: true, fix: false }, [], false);
  try {
    return await v.once();
  } finally {
    v.stop();
  }
}
