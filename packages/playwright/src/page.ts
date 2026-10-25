// The part of the fixture that runs inside the page (install.ts puts it in page.addInitScript, serialised with
// Function.prototype.toString, so this file imports nothing and the function below references only its parameters
// and the page's globals). What it does, before any script of the app runs:
//
//   1. sets window.GENCLASS_CONFIG: observe mode, telemetry off, no visual checks, no devtools, the model as the
//      fixture chose;
//   2. runs the runtime's script-tag build (dist/genclass.global.js) with a stand-in for `document.currentScript`
//      (an init script has no tag, and the build reads `data-base` from its own tag: the stand-in points it at the
//      fixture's virtual path, so everything it loads later comes from the same place);
//   3. holds the runtime to observe: if the URL or localStorage switch (?genclass=heal, localStorage.genclass) raised
//      the mode, it is set back with rt.setMode("observe") and the file says so;
//   4. hands every likely detection to Node from the runtime's "decide" event, synchronously (with the model's
//      diagnosis confidence and the console line the runtime printed);
//   5. loads the agent entry (dist/agent.js) and connects it with every hold off, so the runtime records the two
//      happens-before witnesses (overwrote-newer, identical-in-flight) that need no model, and hands each new one to
//      Node as it appears. connectAgent binds the page's fetch once, when it is called: for that call only, fetch is
//      a stand-in that answers the agent's own URL with "null" without a request (so the link stays unconnected and
//      sends nothing, no console error, no failed request, no CSP report) and passes every other call to the real one;
//   6. reports the runtime's mode and model status, at start, on every status change, when the page goes away, and
//      on request (window.__GENCLASS_PLAYWRIGHT__.collect(), which the fixture calls at the end of the test), with
//      whether a service worker controls the page (page.route does not see what it handles).
//
// Observe only: nothing here holds, delays or changes anything in the page; the agent link is connected with
// `hold: false` and never reaches a bridge. Top frame only, and only on http(s) pages (about:blank and
// page.setContent get nothing). Never throws into the page.

/** What install.ts passes to the page script. */
export interface PageScriptConfig {
  /** The virtual path the runtime's dist/ is served on ("/__genclass__/"). */
  base: string;
  /** The runtime's `model` option: false (skip) or its options (load). */
  model: false | { baseUrl?: string };
  /** The loopback URL the agent link is pointed at (the fixture aborts requests to it). */
  agentUrl: string;
  /** The name of the function Node exposed (page.exposeFunction) that receives every item. */
  binding: string;
}

/** The agent entry's connection, as far as this script uses it. */
interface AgentConnection {
  reason: string | null;
  witnesses(): unknown[];
}

/**
 * The page script. `runGlobal` is the runtime's script-tag build wrapped in a function (install.ts builds the
 * source text). Serialised with toString(): keep it free of imports, closures over module scope and TypeScript-only
 * runtime features.
 */
export function genclassPageScript(cfg: PageScriptConfig, runGlobal: () => void): void {
  const w = window as unknown as Record<string, unknown>;
  try {
    if (window.top !== window) return;
  } catch {
    return;
  }
  if (!/^https?:$/.test(location.protocol)) return;
  if (w.__GENCLASS_PLAYWRIGHT__) return;

  const push = (item: Record<string, unknown>): void => {
    try {
      const f = w[cfg.binding];
      if (typeof f === "function") void (f as (x: unknown) => unknown)(item);
    } catch {
      /* never into the page */
    }
  };

  // 1. the runtime's configuration (read by the script-tag build at init, before the app's own scripts run)
  w.GENCLASS_CONFIG = { mode: "observe", telemetry: false, visual: false, analytics: false, devtools: false, report: "silent", model: cfg.model };

  // 2. the script-tag build, with a tag of its own to read data-base from
  let rt: Record<string, unknown> | null = null;
  try {
    const tag = document.createElement("script");
    tag.dataset.base = cfg.base;
    Object.defineProperty(document, "currentScript", { configurable: true, get: () => tag });
    try {
      runGlobal();
    } finally {
      delete (document as unknown as Record<string, unknown>).currentScript;
    }
    const g = w.GenClass as { runtime?: Record<string, unknown> | null } | undefined;
    rt = g && g.runtime ? g.runtime : null;
  } catch (e) {
    push({ t: "status", mode: null, model: null, error: String((e as Error)?.message ?? e) });
    return;
  }

  const status = (): Record<string, string> | null => {
    if (!rt) return null;
    const s = (rt.status ?? {}) as Record<string, unknown>;
    const m: Record<string, string> = { state: String(s.state ?? "off") };
    if (typeof s.model === "string") m.name = s.model;
    if (typeof s.version === "string") m.version = s.version;
    if (typeof s.device === "string") m.device = s.device;
    return m;
  };
  let overridden: string | null = null;
  const report = (): void => push({ t: "status", mode: rt ? String(rt.mode) : null, model: status(), ...(overridden ? { overridden } : {}) });
  const serviceWorker = (): boolean => {
    try {
      return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    } catch {
      return false;
    }
  };

  // 5. witnesses through the agent entry (hands each new one over as it appears)
  let conn: AgentConnection | null = null;
  let handed = 0;
  let queued = false;
  const drain = (): void => {
    if (!conn) return;
    try {
      const list = conn.witnesses();
      for (; handed < list.length; handed++) push({ t: "witness", witness: list[handed] });
    } catch {
      /* ignore */
    }
  };
  const api = {
    collect(): Record<string, unknown> {
      drain();
      return { mode: rt ? String(rt.mode) : null, model: status(), agent: conn ? conn.reason : "not-loaded", serviceWorker: serviceWorker() };
    },
  };
  w.__GENCLASS_PLAYWRIGHT__ = api;
  if (!rt) {
    report();
    return;
  }
  // 3. observe only, whatever a URL or localStorage switch asked for
  try {
    if (String(rt.mode) !== "observe" && typeof rt.setMode === "function") {
      overridden = String(rt.mode);
      (rt.setMode as (m: string) => void).call(rt, "observe");
    }
  } catch {
    /* ignore */
  }
  report();
  const on = rt.on as ((type: string, fn: (v: unknown) => void) => () => void) | undefined;
  // 4. likely detections, with the model's diagnosis confidence (a sink record's `p` is the action's probability)
  try {
    on?.call(rt, "decide", (v: unknown) => {
      try {
        const d = v as { id?: string; trigger?: string; diagnosis?: string; diagnosisConfidence?: number; detection?: string; subject?: string };
        if (!d || d.detection !== "likely") return;
        let message = "";
        try {
          const x = (rt!.explain as (id: string) => { message?: string } | null).call(rt, String(d.id));
          message = x && typeof x.message === "string" ? x.message : "";
        } catch {
          /* no explanation */
        }
        push({ t: "record", record: { kind: "detection", trigger: d.trigger, diagnosis: d.diagnosis, p: d.diagnosisConfidence, detection: d.detection, evidence: { message, subject: d.subject } } });
      } catch {
        /* never into the page */
      }
    });
  } catch {
    /* an older runtime without this event */
  }
  try {
    on?.call(rt, "status", report);
    // a witness is computed inside the runtime's event dispatch: look after it, once per burst
    on?.call(rt, "event", () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        drain();
      });
    });
  } catch {
    /* an older runtime without these events */
  }
  try {
    import(/* @vite-ignore */ /* webpackIgnore: true */ `${cfg.base}agent.js`).then(
      (m: { connectAgent?: (r: unknown, o: Record<string, unknown>) => AgentConnection }) => {
        // connectAgent binds the page's fetch now: a stand-in for this call answers the agent URL without a request
        const realFetch = w.fetch as ((u: unknown, i?: unknown) => Promise<unknown>) | undefined;
        const own = (u: unknown): boolean => {
          try {
            const s = typeof u === "string" ? u : u instanceof URL ? u.href : String((u as { url?: string })?.url ?? "");
            return s === cfg.agentUrl || s.indexOf(cfg.agentUrl + "/") === 0;
          } catch {
            return false;
          }
        };
        const standIn = function (this: unknown, u: unknown, i?: unknown): Promise<unknown> {
          if (own(u)) return Promise.resolve(new Response("null", { status: 200, headers: { "content-type": "application/json" } }));
          return (realFetch as (u: unknown, i?: unknown) => Promise<unknown>).call(this, u, i);
        };
        try {
          if (typeof realFetch === "function") w.fetch = standIn;
          conn = typeof m.connectAgent === "function" ? m.connectAgent(rt, { url: cfg.agentUrl, hold: false, anyHost: true, dom: false }) : null;
          push({ t: "agent", ok: !!conn && conn.reason === null, reason: conn ? conn.reason : "no-connectAgent" });
          drain();
        } catch (e) {
          push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) });
        } finally {
          if (w.fetch === standIn) w.fetch = realFetch;
        }
      },
      (e: unknown) => push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) }),
    );
  } catch (e) {
    push({ t: "agent", ok: false, reason: String((e as Error)?.message ?? e) });
  }

  // 6. when the page goes away
  try {
    addEventListener("pagehide", () => {
      drain();
      report();
    });
  } catch {
    /* ignore */
  }
}
