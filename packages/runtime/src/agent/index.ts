// @genclass/runtime/agent: connect a page to a coding agent through the local GenClass MCP bridge (packages/mcp;
// docs/runtime/AGENT.md). Development builds only:
//
//   import { GenClass } from "@genclass/runtime";
//   import { connectAgent } from "@genclass/runtime/agent";
//   const rt = GenClass.init();
//   if (import.meta.env.DEV) connectAgent(rt);
//
// What it does on the page:
//   - records the run: user actions, requests (by key, "GET /api/search#3"), the order their responses were delivered,
//     state writes, errors with their stack and causal chain, and two happens-before facts as witnesses (a response
//     that overwrote newer data; identical requests in flight from separate clicks) (./record.ts);
//   - delivers responses on a schedule when one is set (the agent's genclass_explore / genclass_replay, a test's
//     page global, or ?genclass-schedule=): the same requests and responses, only their delivery order and timing
//     change, so a race shows up on a fast machine and replays exactly (./schedule.ts);
//   - at quiet points sends a snapshot of the app's state (store fields, page text, form values), which the bridge
//     compares across runs;
//   - streams the runtime's detections, interventions, checks and expectations as they happen.
//
// Invariants: it runs only on the developer's own machine (localhost, *.localhost, 127.x, ::1) unless asked
// (`anyHost`), talks only to a loopback URL, adds nothing to the first-load bundle (apps import it from a dev-only
// branch), and holds responses only with a schedule; without one, only a page load's first responses wait for the
// bridge's hello (at most `helloTimeoutMs`), and `hold: false` turns every hold off. Protected requests and routes in
// mode "off" are never held (`holdProtected` opts in). Every response is delivered, unchanged. While connected it wraps
// the runtime's delivery gate (RuntimeImpl.runDelivery), the request ignore list (its own requests are never
// observed) and the page's setTimeout/clearTimeout (to see pending debounces); disconnect() restores all three and
// delivers anything held. Nothing it records feeds the model, a situation, the gate or the event log. Time comes from
// the runtime's injected clock. It never throws into the page.

import type { RtEvent, Runtime } from "../types.js";
import type { RuntimeImpl } from "../runtime.js";
import type { OpRec } from "../trace/ops.js";
import { Recorder, type ErrorRec, type RecordedSchedule, type Witness } from "./record.js";
import { LONG_RUNNING_MS, Scheduler, parseSpec, type ScheduleSpec } from "./schedule.js";
import { DEFAULT_AGENT_URL, Link, isDevHost, isLoopbackUrl } from "./link.js";

export type { ScheduleSpec, ScheduleOrder } from "./schedule.js";
export type { RecordedSchedule, Step, ActStep, Witness, ErrorRec } from "./record.js";
export { parseSpec, hash32 } from "./schedule.js";
export { AGENT_SCHEMA, DEFAULT_AGENT_URL, isLoopbackUrl, isDevHost } from "./link.js";
export { SCHEDULE_SCHEMA } from "./record.js";

export interface AgentOptions {
  /** The bridge (loopback only). Default `globalThis.__GENCLASS_AGENT_URL__`, else http://127.0.0.1:47357. */
  url?: string;
  /**
   * This page load's schedule. Default: `globalThis.__GENCLASS_SCHEDULE__` (a test's addInitScript), then the URL's
   * `genclass-schedule` parameter ("fifo", "seeded:7", JSON), then what the bridge assigns at hello.
   */
  schedule?: ScheduleSpec | string;
  /** Also run on a public host (a staging build you test from your own machine). Default false. */
  anyHost?: boolean;
  /** Quiet time (no events, nothing in flight or held) before a snapshot. Default 400 ms. */
  settleMs?: number;
  /** Page text lines and form values in snapshots. Default true. */
  dom?: boolean;
  /** How long a page load's first responses wait for the bridge's hello (when no schedule is set). Default 600 ms. */
  helloTimeoutMs?: number;
  /** false: never hold a response, even with a schedule (record and stream only). Default true. */
  hold?: boolean;
  /**
   * Also hold responses of protected requests (`requests.protect`, presets) and of routes whose mode is "off". Default
   * false: those are recorded but always delivered at once, as the runtime itself never holds them.
   */
  holdProtected?: boolean;
}

/** The app's state at a quiet point (compared across runs by the bridge). */
export interface Snapshot {
  t: number;
  /** Store fields (registered or discovered): path → redacted summary. */
  state: Record<string, string>;
  /** Store fields left out of `state` (its budget), and how many there were; set only when some were left out. */
  stateLeft?: number;
  stateTotal?: number;
  /** Visible page text, one entry per line (dom: true). */
  text?: string[];
  /** Form fields by label → value (dom: true; sensitive fields left out). */
  fields?: Record<string, string>;
  /** Requests sent so far, per signature. */
  requests: Record<string, number>;
  witnesses: number;
  errors: number;
  /** Responses the schedule delivered only because their hold ran out. */
  forced: number;
}

export interface AgentConnection {
  /** The bridge URL. */
  readonly url: string;
  /** Why it is not connected ("not-dev-host", "not-loopback", "no-runtime", "disconnected"), or null. */
  readonly reason: string | null;
  /** The bridge answered hello. */
  readonly connected: boolean;
  /** The bridge's id for this page load. */
  readonly run: string | null;
  /** The schedule in force (null while waiting for hello). */
  readonly schedule: ScheduleSpec | null;
  /** True at a quiet point (until the next event). */
  readonly settled: boolean;
  recorded(): RecordedSchedule;
  witnesses(): Witness[];
  errors(): ErrorRec[];
  snapshot(): Snapshot;
  /** Resolves true at the next quiet point, false after `timeoutMs` (default 10 s). */
  whenSettled(timeoutMs?: number): Promise<boolean>;
  /** Stop recording and holding; deliver anything held; restore the runtime's delivery gate. */
  disconnect(): void;
}

type Gate = RuntimeImpl["runDelivery"];
type IgnoreMatcher = { match(r: { url: string }): true | undefined; size?: number; hits?: number };
/**
 * The RuntimeImpl members the agent uses beyond its public surface: the delivery gate (public) and the request ignore
 * list it wraps, and the app's redactor it reads (private).
 */
type Seams = { runDelivery: Gate; mIgnore?: IgnoreMatcher; redactFn?: (path: string, value: unknown, kind?: string) => unknown };
type TimerFn = (fn: unknown, ms?: number, ...args: unknown[]) => unknown;
/** App timers up to this delay (debounces, short hops) keep a page from looking quiet; longer ones (polls) do not. */
const SHORT_TIMER_MS = 1000;
/**
 * Store fields per snapshot, and their budget in characters (paths and summaries): a snapshot stays far inside the
 * bridge's 1 MB body limit. Fields are taken in an order that does not depend on when they were written: registered
 * stores, then discovered component state, then other discovered stores (Redux, Zustand, devtools); shallower paths
 * first (a cache's deep records last), then by path.
 */
const SNAPSHOT_FIELDS = 1000;
const SNAPSHOT_CHARS = 96_000;
/** A final snapshot sent while the page unloads rides a keepalive request (64 KB for all of them): at most this much. */
const EXIT_SNAPSHOT_CHARS = 48_000;
const SECRET = /pass|pwd|secret|token|card|cc-?num|cvv|cvc|ssn|iban|\bpin\b|otp|one.?time|security.?code|account.?num/i;
type NetFetch = (u: string, i: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const NET = new Set(["fetch", "xhr"]);
const conns = new WeakMap<object, AgentConnection>();
const G = globalThis as unknown as Record<string, unknown>;

function inert(url: string, reason: string): AgentConnection {
  const empty: RecordedSchedule = { schema: "genclass-schedule/1", route: "", spec: null, steps: [], order: [], forced: 0, truncated: false };
  return {
    url,
    reason,
    connected: false,
    run: null,
    schedule: null,
    settled: false,
    recorded: () => empty,
    witnesses: () => [],
    errors: () => [],
    snapshot: () => ({ t: 0, state: {}, requests: {}, witnesses: 0, errors: 0, forced: 0 }),
    whenSettled: () => Promise.resolve(false),
    disconnect: () => undefined,
  };
}

function urlParam(g: Record<string, unknown>, name: string): string | null {
  try {
    const href = (g.location as { href?: string } | undefined)?.href;
    return href ? new URL(href).searchParams.get(name) : null;
  } catch {
    return null;
  }
}

/**
 * A field whose value never leaves the page: password, hidden and file inputs, card and one-time-code autocomplete
 * tokens, anything inside `[data-genclass-ignore]`, and names, ids, labels or placeholders that name a secret (the DOM
 * observer's isSensitiveField, widened: a false positive only hides a value from the agent).
 */
function secretField(el: Element): boolean {
  const i = el as HTMLInputElement;
  const type = (i.type || "").toLowerCase();
  if (type === "password" || type === "hidden" || type === "file") return true;
  const ac = String(i.autocomplete || el.getAttribute("autocomplete") || "").toLowerCase().trim().split(/\s+/).pop() ?? "";
  if (/^(cc-|one-time-code$|current-password$|new-password$)/.test(ac)) return true;
  try {
    if (el.closest("[data-genclass-ignore]")) return true;
  } catch {
    /* ignore */
  }
  let labels = "";
  try {
    labels = i.labels ? Array.from(i.labels).map((l) => l.textContent || "").join(" ") : "";
  } catch {
    /* ignore */
  }
  return SECRET.test(`${i.name || ""} ${i.id || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${labels}`);
}

function fieldLabel(el: Element): string {
  const i = el as HTMLInputElement;
  const lab = i.labels && i.labels[0] ? (i.labels[0].textContent || "").trim() : "";
  return (el.getAttribute("aria-label") || lab || el.getAttribute("placeholder") || i.name || i.id || el.tagName.toLowerCase()).replace(/\s+/g, " ").slice(0, 80);
}


/**
 * Connect this page's runtime to the local GenClass MCP bridge. Returns at once; the hello happens in the background.
 * A second call for the same runtime returns the same connection. On a public host (unless `anyHost`) or with a
 * non-loopback `url` it returns an inert connection that records nothing.
 */
export function connectAgent(runtime: Runtime | null | undefined, opts: AgentOptions = {}): AgentConnection {
  let url = String(opts.url ?? G.__GENCLASS_AGENT_URL__ ?? DEFAULT_AGENT_URL).replace(/\/+$/, "");
  if (!runtime) return inert(url, "no-runtime");
  const prev = conns.get(runtime);
  if (prev) return prev;
  const impl = runtime as unknown as RuntimeImpl;
  const seams = runtime as unknown as Seams;
  const ints = impl.internals;
  if (!ints || typeof seams.runDelivery !== "function") return inert(url, "no-runtime");
  const g = impl.global;
  const con = (g.console as Console | undefined) ?? (G.console as Console | undefined);
  if (!isLoopbackUrl(url)) {
    con?.warn?.(`[GenClass] agent: ${url} is not a loopback address; not connecting.`);
    return inert(url, "not-loopback");
  }
  // one spelling of the bridge URL, the one the fetch observer compares (new URL(...).href)
  {
    const u = new URL(url);
    url = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  }
  const loc = g.location as { hostname?: string; href?: string; pathname?: string } | undefined;
  let hostname = loc?.hostname;
  if (hostname === undefined && loc?.href)
    try {
      hostname = new URL(loc.href).hostname;
    } catch {
      /* no host: not a development page */
    }
  if (!opts.anyHost && !isDevHost(hostname)) return inert(url, "not-dev-host");

  const clock = ints.clock;
  const ops = ints.ops;
  const t0 = clock.now();
  const settleMs = Math.max(50, opts.settleMs ?? 400);
  const dom = opts.dom !== false;
  const holding = opts.hold !== false;
  const holdProtected = opts.holdProtected === true;
  const helloMs = Math.max(0, opts.helloTimeoutMs ?? 600);
  let live = true;
  let settled = false;
  let settleTimer: unknown = null;
  const waiters: ((ok: boolean) => void)[] = [];

  // the schedule: the caller's, a test's page global, the URL, else the bridge's (pending until hello)
  const local = parseSpec(opts.schedule ?? G.__GENCLASS_SCHEDULE__ ?? urlParam(g, "genclass-schedule"));
  const initial: ScheduleSpec | null = holding ? local : { order: "natural" };

  const rec = new Recorder(ints, (op) => sched.started(op).key, (path, v) => {
    try {
      return String(ints.hub.describeValue(path, v));
    } catch {
      return "?";
    }
  });
  const sched: Scheduler = new Scheduler(clock, initial, (d) => rec.delivered(d), initial ? 0 : helloMs);

  const nativeFetch = typeof g.fetch === "function" ? (g.fetch as NetFetch).bind(g) : undefined;
  const nav = g.navigator as { sendBeacon?: (u: string, b: string) => boolean; userAgent?: string } | undefined;
  const link = new Link(url, nativeFetch, clock, typeof nav?.sendBeacon === "function" ? (u, b) => nav.sendBeacon!(u, b) : undefined);
  const reqCount = new Map<string, number>();
  const route = () => String(loc?.pathname ?? "/");

  // ------------------------------------------------------------------ the app's short timers (debounces)
  // A debounced request has not started yet when the user stops typing: while a short timer the app scheduled is
  // pending, the page is not quiet. Polls (longer delays) and intervals do not count; a page that keeps short timers
  // pending without pause for LONG_RUNNING_MS stops counting them.
  const pendingTimers = new Set<unknown>();
  let timerBusySince: number | null = null;
  const origSetTimeout = g.setTimeout as TimerFn | undefined;
  const origClearTimeout = g.clearTimeout as ((id: unknown) => void) | undefined;
  let wSetTimeout: TimerFn | null = null;
  let wClearTimeout: ((id: unknown) => void) | null = null;
  if (typeof origSetTimeout === "function" && typeof origClearTimeout === "function") {
    wSetTimeout = function (this: unknown, fn: unknown, ms?: number, ...args: unknown[]) {
      if (!live || typeof fn !== "function" || Math.max(0, Number(ms) || 0) > SHORT_TIMER_MS) return origSetTimeout.call(g, fn, ms, ...args);
      let id: unknown = null;
      const cb = function (this: unknown, ...a: unknown[]) {
        pendingTimers.delete(id);
        return (fn as (...x: unknown[]) => unknown).apply(this, a);
      };
      id = origSetTimeout.call(g, cb, ms, ...args);
      pendingTimers.add(id);
      if (pendingTimers.size > 1000) pendingTimers.delete(pendingTimers.values().next().value);
      return id;
    };
    wClearTimeout = function (this: unknown, id: unknown) {
      pendingTimers.delete(id);
      return origClearTimeout.call(g, id);
    };
  }

  // ------------------------------------------------------------------ quiet points and snapshots
  const busy = (): boolean => {
    if (!sched.current || sched.held().length) return true;
    const now = clock.now();
    for (const op of ops.inFlight) if (NET.has(op.kind) && !op.genclass && now - op.start < LONG_RUNNING_MS) return true;
    if (pendingTimers.size) {
      timerBusySince ??= now;
      if (now - timerBusySince < LONG_RUNNING_MS) return true;
    } else timerBusySince = null;
    return false;
  };
  const fieldValue = (label: string, v: string): string => {
    try {
      const r = seams.redactFn?.(label, v, "input");
      return r !== undefined && r !== v ? "[redacted]" : v;
    } catch {
      return "[redacted]";
    }
  };
  const snapshot = (): Snapshot => {
    const state: Record<string, string> = {};
    let total = 0;
    let kept = 0;
    try {
      const all: { rank: number; depth: number; path: string; value: unknown }[] = [];
      for (const s of ints.hub.stores.values()) {
        const rank = s.source === undefined ? 0 : s.source === "react" ? 1 : 2;
        for (const [path, leaf] of s.leaves) all.push({ rank, depth: path.split(".").length, path, value: leaf.value });
      }
      all.sort((a, b) => a.rank - b.rank || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      total = all.length;
      let chars = 0;
      for (const f of all) {
        if (kept >= SNAPSHOT_FIELDS) break;
        const v = String(ints.hub.describeValue(f.path, f.value)).slice(0, 200);
        if (chars + f.path.length + v.length > SNAPSHOT_CHARS) break;
        chars += f.path.length + v.length;
        state[f.path] = v;
        kept++;
      }
    } catch {
      /* ignore */
    }
    const snap: Snapshot = { t: Math.round(clock.now() - t0), state, requests: Object.fromEntries(reqCount), witnesses: rec.witnesses.length, errors: rec.errors.length, forced: sched.forced };
    if (total > kept) {
      snap.stateLeft = total - kept;
      snap.stateTotal = total;
    }
    const doc = g.document as Document | undefined;
    if (dom && doc?.body) {
      try {
        const text = String((doc.body as HTMLElement).innerText ?? doc.body.textContent ?? "");
        snap.text = text
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 300)
          .map((l) => l.slice(0, 160));
        const fields: Record<string, string> = {};
        let k = 0;
        for (const el of Array.from(doc.querySelectorAll("input,textarea,select"))) {
          if (k++ >= 100 || secretField(el)) continue;
          const i = el as HTMLInputElement;
          const label = fieldLabel(el);
          const v = i.type === "checkbox" || i.type === "radio" ? (i.checked ? "checked" : "unchecked") : fieldValue(label, String(i.value ?? ""));
          fields[label] = v.slice(0, 160);
        }
        snap.fields = fields;
      } catch {
        /* ignore */
      }
    }
    return snap;
  };
  let lastSnap = "";
  let sentSteps = 0;
  let lastLearned = -Infinity;
  const flushSteps = () => {
    // steps recorded since the last send (the recorder keeps the newest ones), and actions a typing burst changed since
    const fresh = Math.min(rec.pushed - sentSteps, rec.steps.length);
    const freshSteps = fresh > 0 ? rec.steps.slice(rec.steps.length - fresh) : [];
    const changed = [...rec.updated].map((i) => rec.acts.get(i)).filter((a): a is NonNullable<typeof a> => !!a && !freshSteps.includes(a));
    rec.updated.clear();
    if (freshSteps.length || changed.length) link.send({ t: "steps", steps: [...changed, ...freshSteps], order: rec.order.slice(-400), forced: sched.forced, lost: rec.pushed - sentSteps - fresh });
    sentSteps = rec.pushed;
  };
  const quiet = (): void => {
    settleTimer = null;
    if (!live) return;
    if (busy()) {
      settleTimer = clock.setTimeout(quiet, settleMs);
      return;
    }
    settled = true;
    flushSteps();
    const snap = snapshot();
    const { t: _t, ...cmp } = snap;
    const key = JSON.stringify(cmp);
    if (key !== lastSnap) {
      lastSnap = key;
      link.send({ t: "snapshot", snapshot: snap });
    }
    const now = clock.now();
    if (now - lastLearned >= 5000) {
      lastLearned = now;
      try {
        link.send({ t: "learned", learned: JSON.parse(JSON.stringify(runtime.learned())), baselines: ints.base.snapshot() });
      } catch {
        /* ignore */
      }
    }
    for (const w of waiters.splice(0)) w(true);
  };
  const unsettle = (): void => {
    if (!live) return;
    settled = false;
    if (settleTimer !== null) clock.clearTimeout(settleTimer);
    settleTimer = clock.setTimeout(quiet, settleMs);
  };

  // ------------------------------------------------------------------ events: actions, requests, writes, errors
  const seen = new Set<number>();
  let errSeq = 0;
  const stacks: { n: number; key: string; stack: string }[] = [];
  const sent = (op: OpRec): void => {
    sched.started(op);
    rec.sent(op);
    if ((op.attempt ?? 1) === 1) reqCount.set(op.name, (reqCount.get(op.name) ?? 0) + 1);
  };
  const onEvent = (e: RtEvent, backfill = false): void => {
    if (!live) return;
    const touched = seen.has(e.seq);
    if (!touched) {
      seen.add(e.seq);
      if (seen.size > 5000) seen.delete(seen.values().next().value as number);
    }
    try {
      if (e.kind === "user") rec.user(e, touched);
      else if (touched) {
        /* only typing bursts are updated in place */
      } else if (e.kind === "op.start") {
        const op = ops.get(e.op);
        if (op && NET.has(op.kind) && !op.genclass) sent(op);
      } else if (e.kind === "state") rec.wrote(e, backfill);
      else if (e.kind === "custom" && e.name === "xhr.aborted-while-held") {
        // the app aborted an XHR whose response the schedule held: it is dropped, never delivered
        const op = ops.get(e.op);
        if (op) {
          sched.ended(op.id);
          rec.endedWithout(op);
        }
      } else if (e.kind === "error") {
        if (backfill) rec.error(e);
        else {
          // the page's own error listener (below) runs after the runtime's for the same dispatch: match only stacks
          // pushed after this event, take one and consume it
          const base = errSeq;
          clock.setTimeout(() => {
            const msg = String(e.data?.message ?? "");
            const i = msg ? stacks.findIndex((s) => s.n > base && s.key.slice(0, 100) === msg.slice(0, 100)) : -1;
            const hit = i >= 0 ? stacks.splice(i, 1)[0] : undefined;
            rec.error(e, hit?.stack);
          }, 0);
        }
      }
    } catch {
      /* recording never breaks the page */
    }
    if (!backfill && (!touched || e.kind === "user")) unsettle();
  };
  const onErr = (ev: Event): void => {
    try {
      const err = (ev as ErrorEvent).error ?? (ev as PromiseRejectionEvent).reason;
      const name = (err as { name?: string } | null)?.name ?? "Error";
      const message = (err as { message?: string } | null)?.message ?? String(err);
      const stack = (err as { stack?: string } | null)?.stack;
      if (typeof stack === "string") {
        stacks.push({ n: ++errSeq, key: `${name}: ${String(message).slice(0, 120)}`, stack });
        if (stacks.length > 20) stacks.shift();
      }
    } catch {
      /* ignore */
    }
  };
  // a request that ended: failed or aborted ones never reach the delivery gate; identical requests in flight together
  const onEnd = (op: OpRec): void => {
    if (!live || !NET.has(op.kind) || op.genclass) return;
    try {
      const s = sched.started(op);
      if (op.status !== "ok") {
        sched.ended(op.id);
        rec.endedWithout(op);
      } else
        clock.afterTask(() => {
          // a response that reached the app without the delivery gate (GenClass paused, an answered retry)
          if (!s.go && s.released === undefined && !s.done) {
            sched.ended(op.id);
            rec.delivered({ key: s.key, op: op.id, at: op.end ?? clock.now(), heldMs: 0, forced: false });
          }
        });
      if (op.identity) {
        const same: OpRec[] = [];
        for (const o of ops.byId.values()) if (o !== op && o.identity === op.identity && NET.has(o.kind)) same.push(o);
        if (same.length) rec.identical(op, same);
      }
    } catch {
      /* ignore */
    }
    unsettle();
  };

  // ------------------------------------------------------------------ runtime findings (as they happen)
  const at = () => Math.round(clock.now() - t0);
  const explainOf = (id: string) => {
    try {
      const x = impl.explain(id);
      return x ? { message: x.message.slice(0, 600), timeline: x.timeline.slice(-16).map((l) => l.slice(0, 200)), situation: x.situationText.slice(0, 4000), ...(x.changed ? { changed: x.changed.slice(0, 400) } : {}) } : undefined;
    } catch {
      return undefined;
    }
  };
  const offs: (() => void)[] = [];
  const listen = (fn: () => () => void) => {
    try {
      offs.push(fn());
    } catch {
      /* an older runtime without this event */
    }
  };
  listen(() =>
    runtime.on("decide", (d) => {
      if (!d.detection) return;
      link.send({
        t: "detection",
        at: at(),
        decision: {
          id: d.id,
          trigger: d.trigger,
          subject: d.subject.slice(0, 300),
          diagnosis: d.diagnosis,
          diagnosisConfidence: d.diagnosisConfidence,
          action: d.action,
          confidence: d.confidence,
          executed: d.executed,
          detection: d.detection,
          ...(d.reason ? { reason: d.reason } : {}),
          facts: d.facts.slice(0, 12).map((f) => f.slice(0, 300)),
        },
        explain: explainOf(d.id),
      });
    }),
  );
  listen(() =>
    runtime.on("act", (a) =>
      link.send({ t: "intervention", at: at(), action: { id: a.id, decisionId: a.decisionId, action: a.action, tier: a.tier, trigger: a.trigger, subject: a.subject.slice(0, 300), ok: a.ok, changed: a.changed.slice(0, 400) }, explain: explainOf(a.id) }),
    ),
  );
  listen(() => runtime.on("check", (c) => link.send({ t: "check", at: at(), check: JSON.parse(JSON.stringify(c)) })));
  listen(() => runtime.on("expectation", (x) => link.send({ t: "expectation", at: at(), expectation: JSON.parse(JSON.stringify(x)) })));
  rec.onWitness = (w) => link.send({ t: "witness", witness: w });
  rec.onError = (e) => link.send({ t: "error", error: e });

  // ------------------------------------------------------------------ install: ignore list, gate, timers, history
  // GenClass's fetch observer passes the bridge's requests straight through (no op, no hold, no event)
  const ignore = seams.mIgnore;
  const base = `${url}/`;
  if (ignore && typeof ignore.match === "function") {
    seams.mIgnore = {
      get size() {
        return (ignore.size ?? 0) + 1;
      },
      get hits() {
        return ignore.hits ?? 0;
      },
      match: (r) => (typeof r?.url === "string" && r.url.startsWith(base) ? true : ignore.match(r)),
    };
  }
  const origGate: Gate = seams.runDelivery;
  const wrapped = function (o: Parameters<Gate>[0], release: () => void, defers = 0, heldSince?: number): void {
    // re-entries (a defer decided again) and anything that is not a response pass as before
    if (!live || defers || heldSince !== undefined || !o?.op || o.channel !== "response" || !NET.has(o.op.kind) || o.op.genclass) return origGate.call(impl, o, release, defers, heldSince);
    // the app received it when the runtime releases it (the runtime may hold it further in guard or heal)
    const deliver = (landed: () => void) => {
      let once = false;
      origGate.call(impl, o, () => {
        if (once) return;
        once = true;
        release();
        landed();
      });
    };
    // protected requests and routes in mode "off" are never held by the runtime; the schedule leaves them alone too
    if (!holdProtected && (o.op.scope?.protected || o.op.scope?.mode === "off")) sched.pass(o.op, deliver);
    else sched.gate(o.op, deliver);
    unsettle();
  } as Gate;
  seams.runDelivery = wrapped;
  if (wSetTimeout && wClearTimeout) {
    g.setTimeout = wSetTimeout;
    g.clearTimeout = wClearTimeout;
  }
  // what happened before connectAgent ran, in time order, through the same handlers (nothing of it can be held now):
  // requests from the ops registry (it reaches further back than the event log), actions, writes and errors from the log
  {
    const back: { t: number; k: number; n: number; run: () => void }[] = [];
    for (const op of ops.byId.values())
      if (NET.has(op.kind) && !op.genclass)
        back.push({
          t: op.start,
          k: 1,
          n: op.id,
          run: () => {
            sent(op);
            if (op.end !== undefined) sched.ended(op.id);
          },
        });
    for (const e of ints.events.last()) {
      if (e.kind === "op.start") continue;
      back.push({ t: e.t, k: e.kind === "user" ? 0 : 2, n: e.seq, run: () => onEvent(e, true) });
    }
    back.sort((a, b) => a.t - b.t || a.k - b.k || a.n - b.n);
    for (const b of back) b.run();
  }
  const offEvents = ints.events.onEvent((e) => onEvent(e));
  const offEnd = ops.onEnd(onEnd);
  const target = g as unknown as EventTarget;
  const onHide = (): void => {
    if (!live) return;
    flushSteps();
    // a final snapshot only from a quiet page: a run unloaded mid-flight keeps its last quiet snapshot (or none); one
    // the bridge already has, or one too big for a keepalive request, is not sent again (the last quiet one stands)
    let end: Record<string, unknown> = { t: "end", settled: false };
    if (settled && !busy()) {
      const snap = snapshot();
      const { t: _t, ...cmp } = snap;
      const key = JSON.stringify(cmp);
      end = key !== lastSnap && key.length <= EXIT_SNAPSHOT_CHARS ? { t: "end", settled: true, snapshot: snap } : { t: "end", settled: true };
    }
    link.send(end);
    link.flush(true);
  };
  try {
    target.addEventListener?.("error", onErr);
    target.addEventListener?.("unhandledrejection", onErr);
    target.addEventListener?.("pagehide", onHide);
  } catch {
    /* no window */
  }

  // ------------------------------------------------------------------ hello
  const title = (g.document as Document | undefined)?.title;
  // a reply after the timeout: the page already runs what it fell back to; tell the bridge which schedule it applied
  link.onLate = () => {
    if (!live) return;
    link.send({ t: "schedule", spec: sched.current ?? { order: "natural" }, late: true });
  };
  void link
    .hello(
      {
        page: { url: String(loc?.href ?? "").slice(0, 2000), route: route(), ...(title ? { title: String(title).slice(0, 200) } : {}) },
        runtime: { mode: runtime.mode, model: runtime.status.state },
        // the schedule in force when the page set its own (or natural, with hold: false): the bridge assigns none then
        ...(initial ? { schedule: initial } : {}),
        ...(nav?.userAgent ? { ua: String(nav.userAgent).slice(0, 300) } : {}),
      },
      helloMs,
    )
    .then((r) => {
      if (!live) return;
      if (!sched.current) sched.setSpec(parseSpec(r?.schedule) ?? { order: "natural" });
      if (!r) return;
      flushSteps();
      link.flush(false);
      unsettle();
    });

  const disconnect = (): void => {
    if (!live) return;
    onHide();
    live = false;
    if (seams.runDelivery === wrapped) seams.runDelivery = origGate;
    if (ignore) seams.mIgnore = ignore;
    if (wSetTimeout && g.setTimeout === wSetTimeout) g.setTimeout = origSetTimeout;
    if (wClearTimeout && g.clearTimeout === wClearTimeout) g.clearTimeout = origClearTimeout;
    sched.dispose();
    offEvents();
    offEnd();
    for (const f of offs) f();
    try {
      target.removeEventListener?.("error", onErr);
      target.removeEventListener?.("unhandledrejection", onErr);
      target.removeEventListener?.("pagehide", onHide);
    } catch {
      /* ignore */
    }
    if (settleTimer !== null) clock.clearTimeout(settleTimer);
    for (const w of waiters.splice(0)) w(false);
    conns.delete(runtime);
    if (G.__GENCLASS_AGENT__ === conn) delete G.__GENCLASS_AGENT__;
  };
  impl.addTeardown(disconnect);

  const conn: AgentConnection = {
    url,
    get reason() {
      return live ? null : "disconnected";
    },
    get connected() {
      return live && link.run !== null && !link.dead;
    },
    get run() {
      return link.run;
    },
    get schedule() {
      return sched.current;
    },
    get settled() {
      return settled;
    },
    recorded: () => rec.schedule(route(), sched.current, sched.forced),
    witnesses: () => rec.witnesses.slice(),
    errors: () => rec.errors.slice(),
    snapshot,
    whenSettled: (timeoutMs = 10_000) =>
      settled
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            let done = false;
            const fin = (ok: boolean) => {
              if (done) return;
              done = true;
              resolve(ok);
            };
            waiters.push(fin);
            clock.setTimeout(() => fin(false), timeoutMs);
          }),
    disconnect,
  };
  conns.set(runtime, conn);
  G.__GENCLASS_AGENT__ = conn;
  unsettle();
  return conn;
}
