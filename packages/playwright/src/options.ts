// Fixture options: defaults, validation and the chaos option parser. Pure (no Playwright, no Node APIs), so it
// is unit-tested without a browser. Invariant: never throws on a bad option; the option is corrected or dropped
// and a warning is recorded, which the report prints. A typo in a config must never fail the user's suite.

import type { ChaosOptions, GenClassOptions, ResolvedChaos, ResolvedOptions } from "./types.js";

export const DEFAULT_HANDLES: readonly string[] = ["GenClass.runtime", "__genclass"];
export const DEFAULT_ROUTES: readonly RegExp[] = [/\/api\//];
/** `chaos: true`. */
export const DEFAULT_CHAOS: Required<Pick<ChaosOptions, "latencyMs" | "reorder" | "failRate">> = { latencyMs: [50, 800], reorder: true, failRate: 0.05 };
export const DEFAULT_SETTLE = { quietMs: 1500, maxMs: 6000 } as const;

const MODES: readonly string[] = ["observe", "guard", "heal"];

type Warn = (s: string) => void;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A `*` glob as a string ("/api/*", "*graphql*") or a RegExp -> RegExp tested against the whole URL. */
export function routePattern(p: RegExp | string): RegExp | null {
  if (p instanceof RegExp) return p;
  if (typeof p !== "string" || !p) return null;
  const src = p
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

function latency(v: ChaosOptions["latencyMs"], warn: Warn): [number, number] {
  if (v === undefined) return [0, 0];
  if (finite(v)) {
    if (v < 0) {
      warn(`chaos.latencyMs ${v} is negative: using 0`);
      return [0, 0];
    }
    return [v, v];
  }
  if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1])) {
    const a = v[0];
    const b = v[1];
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.max(0, Math.max(a, b));
    if (a > b) warn(`chaos.latencyMs [${a}, ${b}] is reversed: using [${lo}, ${hi}]`);
    else if (a < 0 || b < 0) warn(`chaos.latencyMs has a negative bound: using [${lo}, ${hi}]`);
    return [lo, hi];
  }
  warn(`chaos.latencyMs ${JSON.stringify(v)} is not a number or [min, max]: no latency added`);
  return [0, 0];
}

function rate(v: unknown, name: string, warn: Warn): number {
  if (v === undefined) return 0;
  if (!finite(v)) {
    warn(`chaos.${name} ${JSON.stringify(v)} is not a number: using 0`);
    return 0;
  }
  if (v < 0 || v > 1) {
    const c = Math.min(1, Math.max(0, v));
    warn(`chaos.${name} ${v} is outside [0, 1]: using ${c}`);
    return c;
  }
  return v;
}

/** The chaos option -> ResolvedChaos, or null when chaos is off. */
export function resolveChaos(c: GenClassOptions["chaos"], warn: Warn): ResolvedChaos | null {
  if (c === undefined || c === false || c === null) return null;
  let o: ChaosOptions;
  if (c === true) o = { ...DEFAULT_CHAOS };
  else if (typeof c === "object") o = c;
  else {
    warn(`chaos ${JSON.stringify(c)} is not an object or true: chaos is off`);
    return null;
  }
  const routes: RegExp[] = [];
  if (o.routes !== undefined) {
    if (!Array.isArray(o.routes)) warn("chaos.routes must be an array of RegExp or strings: using the default [/\\/api\\//]");
    else {
      for (const p of o.routes) {
        const re = routePattern(p);
        if (re) routes.push(re);
        else warn(`chaos.routes entry ${JSON.stringify(String(p))} is not a RegExp or a glob string: ignored`);
      }
    }
  }
  let failStatus = 503;
  if (o.failStatus !== undefined) {
    if (finite(o.failStatus) && o.failStatus >= 400 && o.failStatus <= 599) failStatus = Math.floor(o.failStatus);
    else warn(`chaos.failStatus ${JSON.stringify(o.failStatus)} is not a 4xx/5xx status: using 503`);
  }
  let seed: number | string | null = null;
  if (o.seed !== undefined) {
    if (finite(o.seed) || (typeof o.seed === "string" && o.seed !== "")) seed = o.seed;
    else warn(`chaos.seed ${JSON.stringify(o.seed)} is not a number or a non-empty string: using the test title`);
  }
  return {
    latencyMs: latency(o.latencyMs, warn),
    reorder: !!o.reorder,
    failRate: rate(o.failRate, "failRate", warn),
    failStatus,
    routes: routes.length ? routes : [...DEFAULT_ROUTES],
    seed,
  };
}

const HANDLE_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function handles(h: GenClassOptions["handle"], warn: Warn): string[] {
  const own: string[] = [];
  const list: unknown[] = h === undefined ? [] : Array.isArray(h) ? h : [h];
  for (const x of list) {
    if (typeof x === "string" && HANDLE_RE.test(x)) own.push(x.replace(/^window\./, ""));
    else warn(`handle ${JSON.stringify(x)} is not a dotted window path (like "__app.genclass"): ignored`);
  }
  const out: string[] = [];
  for (const x of [...own, ...DEFAULT_HANDLES]) if (!out.includes(x)) out.push(x);
  return out;
}

/** Fills defaults and corrects what it can; the result is what the fixture actually runs with. */
export function resolveOptions(input: GenClassOptions = {}): ResolvedOptions {
  const warnings: string[] = [];
  const warn: Warn = (s) => warnings.push(s);
  let o: GenClassOptions = input;
  if (o === null || typeof o !== "object") {
    o = {};
    warn("options must be an object: using the defaults");
  }
  let mode = o.mode;
  if (mode !== undefined && !MODES.includes(mode)) {
    warn(`mode ${JSON.stringify(mode)} is not observe|guard|heal: using observe`);
    mode = undefined;
  }
  let install = o.install;
  if (install !== undefined && install !== "inject" && install !== "app") {
    warn(`install ${JSON.stringify(install)} is not inject|app: using inject`);
    install = undefined;
  }
  let runtime = o.runtime;
  if (runtime !== undefined && (typeof runtime !== "string" || runtime === "")) {
    warn(`runtime ${JSON.stringify(runtime)} is not cdn|local|<path>: using local`);
    runtime = undefined;
  }
  let config: Record<string, unknown> = {};
  if (o.config !== undefined) {
    if (o.config && typeof o.config === "object" && !Array.isArray(o.config)) config = { ...o.config };
    else warn("config must be an object of InitOptions: ignored");
  }
  for (const k of ["mode", "telemetry"]) {
    if (k in config) {
      warn(`config.${k} is set by the fixture (${k === "mode" ? "use the mode option" : "telemetry is always off in tests"}): ignored`);
      delete config[k];
    }
  }
  const s = o.settle && typeof o.settle === "object" ? o.settle : {};
  const quietMs = finite(s.quietMs) && s.quietMs >= 0 ? s.quietMs : DEFAULT_SETTLE.quietMs;
  const maxMs = finite(s.maxMs) && s.maxMs >= 0 ? Math.max(s.maxMs, quietMs) : Math.max(DEFAULT_SETTLE.maxMs, quietMs);
  return {
    mode: mode ?? "observe",
    install: install ?? "inject",
    runtime: runtime ?? "local",
    handle: handles(o.handle, warn),
    chaos: resolveChaos(o.chaos, warn),
    config,
    settle: { quietMs, maxMs },
    attach: o.attach !== false,
    annotate: o.annotate !== false,
    warnings,
  };
}
