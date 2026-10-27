// Measured visual checks: the first-load stub (docs/runtime/VISUAL.md sections 7, 8 and 13).
//
// It resolves InitOptions.visual. Off means nothing at all: no listener, no timer, no download. On means: buffer
// securitypolicyviolation events (violations during page load cannot be queried later), wait for `load` (at most
// 6.5 s) and 1.5 s more, and for a visible tab that is not prerendering, then import the chunk (src/visual/index.ts);
// the chunk does all its work in idle callbacks. "local" means on for development hosts (devHost, src/devhost.ts)
// only; elsewhere it loads the chunk only when the devtools overlay mounts or checkNow() is called. Everything else
// (the host the checks see, checks, messages, colour maths, selectors) lives in the chunk, so this file stays small:
// the first-load budget is 0.5 KB gzip for all of visual (test/bundle.test.ts). All timing uses the runtime's Clock
// (AGENTS.md rule 5).

import type { RuntimeImpl } from "../runtime.js";
import type { CheckFinding, InitOptions, VisualOptions } from "../types.js";
import type { VisualChunk, VisualController } from "./host.js";
import { devHost } from "../devhost.js";
import { describeElement } from "../observe/dom-user.js";
import { normalizePath } from "../util.js";
import { visualRegistry } from "./registry.js";

export interface VisualStub {
  /** "on": the checks start after load; "local": only when the devtools overlay mounts or checkNow() is called. */
  readonly setting: "local" | "on";
  /** The app turned runtime fixes on (`visual: { on: true, fix }`); they run only in guard or heal. Telemetry's session event. */
  readonly fix: boolean;
  /** The findings so far (rt.checks()), at most 200. */
  readonly b: CheckFinding[];
  /** The chunk's controller once it has loaded. */
  c?: VisualController | null;
  /** Load the chunk if needed and run a pass now. */
  now(): Promise<CheckFinding[]>;
  /** Load the chunk if needed (the devtools overlay mounted). */
  start(): unknown;
}

type Loc = { protocol?: string; hostname?: string; port?: string };
type G = Record<string, unknown> & {
  document?: Document & { prerendering?: boolean };
  location?: Loc;
  addEventListener?: (t: string, fn: () => void) => void;
};

// The development host, where the "local" default turns the checks on (VISUAL.md 7.2), is src/devhost.ts's devHost
// (http(s) on a loopback name with an explicit port, or *.test; never Capacitor, Tauri, Electron or intranet hosts),
// re-exported here for the existing imports.
export { devHost };

/**
 * Called by createRuntime (src/index.ts) once the runtime exists. `init`: the GenClass.init() default ("local")
 * applies when the option is unset; createRuntime() leaves it off.
 */
export function startVisual(rt: RuntimeImpl, opt: InitOptions["visual"], init: boolean): VisualStub | null {
  const g = rt.global as G;
  const doc = g.document;
  if (!doc?.addEventListener) return null;
  const o: VisualOptions = typeof opt == "object" && opt ? { ...opt } : { on: opt };
  const q = (rt as unknown as { urlParams(): URLSearchParams }).urlParams().get("genclass-visual");
  const base = o.on ?? (init && "local");
  if (q == "off" || !base) return null;
  const local = devHost(g.location);
  const early: Event[] = [];
  const csp = (e: Event) => void (early.length < 50 && early.push(e));
  const clock = rt.clock;
  let p: Promise<VisualController | null> | undefined;
  let dead = false;
  const load = () =>
    (p ??= (visualRegistry.loader ?? (() => import("./index.js") as Promise<VisualChunk>))().then(
      (m) => (dead ? null : (v.c = m.startVisual(rt, o, early, describeElement, normalizePath))),
      (e) => {
        p = undefined;
        (g.console as Console | undefined)?.warn("[GenClass]", e);
        return null;
      },
    ));
  const v: VisualStub = {
    setting: base === true || local || q == "on" ? "on" : "local",
    fix: o.on === true && (o.fix === true || (Array.isArray(o.fix) && o.fix.length > 0)),
    b: [],
    now: () => load().then((c) => c?.now() ?? []),
    start: load,
  };
  rt.addTeardown(() => {
    dead = true;
    doc.removeEventListener("securitypolicyviolation", csp, true);
  });
  if (v.setting != "local") {
    doc.addEventListener("securitypolicyviolation", csp, true);
    // enabled false or pending (effective mode "off"), a hidden tab or a prerendered page: no download until that
    // changes (checked every 5 s). load() runs once, so the 1.5 s after `load` and the 6.5 s cap (a `load` held up by
    // a slow request) may both call it.
    const go = (): unknown => dead || (rt.effectiveMode() != "off" && doc.visibilityState != "hidden" && !doc.prerendering ? load() : clock.setTimeout(go, 5000));
    const soon = () => clock.setTimeout(go, 1500);
    if (doc.readyState == "complete") soon();
    else {
      g.addEventListener?.("load", soon);
      clock.setTimeout(go, 6500);
    }
  }
  return v;
}
