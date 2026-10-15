// @genclass/runtime public facade (CONTRACT §2).
//
//   import { GenClass } from "@genclass/runtime";
//   GenClass.init();

import { isLocalHost } from "./telemetry/config.js";
import type { Clock, CreateOptions, DecisionProvider, DeviceEnv, EvaluateRequest, InitOptions, Mode, ModelOptions, ModelStatus, ObserverName, Runtime } from "./types.js";
import { browserClock } from "./clock.js";
import { RuntimeImpl } from "./runtime.js";
import { createModelHost } from "./model/host.js";
import { deviceEnv, evalLoadIf } from "./model/device.js";
import { startTelemetry } from "./telemetry/index.js";
import { telemetryOff } from "./telemetry/client.js";
import { resolveToken } from "./token.js";
import { protect, setProtectResolver } from "./protect.js";
import { startVisual } from "./visual/start.js";

export * from "./types.js";
export { browserClock } from "./clock.js";
export { GenClassUnavailableError } from "./errors.js";
export { createModelHost, DEFAULT_MODEL_BASE_URL } from "./model/host.js";
export type { ModelHost, ModelHostOptions, ModelHostStatus, ModelHostStats, ModelEvaluateRequest } from "./model/host.js";
export {
  GenClassModelError,
  ModelNotReadyError,
  MaxTokensExceededError,
  ModelInputError,
  ModelUnsupportedError,
  ModelTimeoutError,
  ModelAbortedError,
  ModelBusyError,
  ModelDisposedError,
  ModelLoadError,
  ModelIntegrityError,
  ModelInferenceError,
} from "./model/errors.js";
export type { ModelErrorCode, LoadAttempt } from "./model/errors.js";
export { stateText, stateChars, sectionLimits, STATE_CHAR_BUDGET, COMPACT_BUDGET } from "./situation/serialize.js";
export { BUILTIN_ACTIONS, TRIGGER_ACTIONS, PASSIVE, DEFAULT_DIAGNOSES } from "./situation/questions.js";
export { describeElement } from "./observe/dom-user.js";
export { RuntimeImpl } from "./runtime.js";
export { DEFAULT_TELEMETRY_ENDPOINT, TELEMETRY_SCHEMA, TELEMETRY_NOTICE } from "./telemetry/index.js";
export { RUNTIME_VERSION } from "./version.js";
export { PROTECT_PRESETS, PRESET_PREFIX, protectPreset } from "./presets.js";
export type { ProtectPresetName } from "./presets.js";
export { AUDIT_SCHEMA } from "./decide/audit.js";
export { protect } from "./protect.js";
export { TOKEN_PATTERN, isValidToken } from "./token.js";

/** fetch as it was when this module loaded: the model host downloads with it, so GenClass never observes itself. */
const NATIVE_FETCH: typeof fetch | undefined =
  typeof (globalThis as { fetch?: unknown }).fetch === "function" ? (globalThis.fetch as typeof fetch).bind(globalThis) : undefined;

function failedProvider(message: string): DecisionProvider {
  const err = new Error(message);
  const status: ModelStatus = { state: "error", error: message };
  return {
    status,
    ready: () => Promise.reject(err),
    evaluate: () => Promise.reject(err),
  };
}

function skippedProvider(reason: string): DecisionProvider {
  const err = new Error(`model skipped: ${reason}`);
  return { status: { state: "skipped", reason }, ready: () => Promise.reject(err), evaluate: () => Promise.reject(err) };
}

export { deviceEnv, evalLoadIf, DEFAULT_LOAD_IF } from "./model/device.js";

function hostOptions(m: ModelOptions, env: DeviceEnv): Record<string, unknown> {
  const { loadIf: _l, inlineFallback: _i, threads, timeoutMs, maxDecisionsPerMinute: _d, unloadAfterIdleMs: _u, ...rest } = m;
  const out: Record<string, unknown> = { ...rest };
  if (typeof threads === "number" && threads >= 1) out.maxThreads = Math.floor(threads);
  else if (threads === "auto" && typeof env.cores === "number") out.maxThreads = Math.min(4, Math.max(1, env.cores - 1));
  if (typeof timeoutMs === "number" && timeoutMs > 0) out.timeoutMs = timeoutMs;
  // inlineFallback:false: the host then never runs the model on the main thread (status "skipped", worker-unavailable)
  if (m.inlineFallback === false) out.inlineFallback = false;
  return out;
}

function makeHost(m: ModelOptions, fetchFn: typeof fetch | undefined, clock: Clock | undefined, g: Record<string, unknown> = globalThis as never): DecisionProvider {
  try {
    const env = deviceEnv(g);
    const warn = (s: string) => (g.console as Console | undefined)?.warn?.(`[GenClass] ${s}`);
    const li = evalLoadIf(m, env, warn);
    if (typeof li === "object") return skippedProvider(li.skip);
    const mo: ModelOptions = li === "lazy" ? { ...m, preload: "lazy" } : m;
    const create = () => createModelHost({ ...(hostOptions(mo, env) as ModelOptions), ...(fetchFn ? { fetch: fetchFn } : {}), ...(clock ? { clock } : {}) });
    const idle = m.unloadAfterIdleMs;
    if (typeof idle === "number" && idle > 0) return new IdleUnloadProvider(create, idle, clock ?? browserClock);
    return create();
  } catch (e) {
    return failedProvider(`model host unavailable: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * model.unloadAfterIdleMs (OPTIONS-SPEC §4.18): tears the host down after `idleMs` without an evaluation (state
 * "unloaded"); `ready()` or the next evaluation starts a reload from the cache (an evaluation that finds it unloaded is
 * itself rejected: fail open, released unchanged). The runtime asks for `ready()` at the next salient situation
 * (runtime.ts consultable / trigger), which in observe is then decided once the model is back.
 */
export class IdleUnloadProvider implements DecisionProvider {
  private host: DecisionProvider | null;
  private timer: unknown = null;
  private subs = new Set<(s: ModelStatus) => void>();
  private unsub: (() => void) | null = null;
  constructor(
    private readonly create: () => DecisionProvider,
    private readonly idleMs: number,
    private readonly clock: Clock,
  ) {
    this.host = this.attach(create());
    this.arm();
  }
  private attach(h: DecisionProvider): DecisionProvider {
    this.unsub = h.onStatus?.((s) => this.subs.forEach((f) => f(s))) ?? null;
    return h;
  }
  private arm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => this.unload(), this.idleMs);
  }
  private unload(): void {
    this.timer = null;
    const h = this.host;
    if (!h) return;
    this.host = null;
    this.unsub?.();
    this.unsub = null;
    h.dispose?.();
    const s = this.status;
    this.subs.forEach((f) => f(s));
  }
  get status(): ModelStatus {
    return this.host ? this.host.status : { state: "unloaded" };
  }
  ready(): Promise<void> {
    // a reload asked for (the runtime's next salient situation, rt.ready): idle from now on until it is used
    if (!this.host) {
      this.host = this.attach(this.create());
      this.arm();
    }
    return this.host.ready();
  }
  evaluate(req: EvaluateRequest): ReturnType<DecisionProvider["evaluate"]> {
    this.arm();
    if (!this.host) {
      this.host = this.attach(this.create());
      return Promise.reject(new Error("model reloading after idle unload"));
    }
    return this.host.evaluate(req);
  }
  onStatus(fn: (s: ModelStatus) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.unsub?.();
    this.host?.dispose?.();
    this.host = null;
  }
}


/**
 * Advanced/headless runtime (sim, tests, SSR). No model unless `model` options or a `decider` are given. No
 * telemetry unless `telemetry` is set (GenClass.init turns it on by default in a browser).
 */
export function createRuntime(options: CreateOptions = {}): Runtime {
  return buildRuntime(options, false);
}

/** The valid token each runtime started with (GenClass.init's "already running" warning compares against it). */
const tokenOf = new WeakMap<Runtime, string>();

/**
 * createRuntime, with `telemetryDefaultOn` for GenClass.init in a browser: an unset `telemetry` option then means
 * "on, except where the default stays off" (local and private hosts, see resolveTelemetry). Passing `telemetry: true`
 * instead would read as an explicit opt-in and send from localhost too.
 */
function buildRuntime(options: CreateOptions, telemetryDefaultOn: boolean): Runtime {
  let decider: DecisionProvider | null | undefined = options.decider;
  let owns = false;
  if (decider === undefined && options.model && typeof options.model === "object") {
    owns = true;
    const g = (options.global ?? globalThis) as { fetch?: typeof fetch };
    const nf = options.global ? (typeof g.fetch === "function" ? g.fetch.bind(g) : undefined) : NATIVE_FETCH;
    decider = makeHost(options.model, nf, options.clock, (options.global ?? globalThis) as never);
  }
  const rt = new RuntimeImpl({ ...options, decider: decider ?? null, ownsDecider: owns });
  const con = () => (rt.global.console as Console | undefined) ?? (globalThis as { console?: Console }).console;
  const token = resolveToken(options.token, (m) => con()?.warn?.(`[GenClass] ${m}`));
  if (token) tokenOf.set(rt, token);
  if (options.enabled === false) rt.telemetry = telemetryOff("disabled");
  else {
    // measured visual checks (docs/runtime/VISUAL.md): "local" by default with GenClass.init() in a browser
    rt.vis = startVisual(rt, options.visual, telemetryDefaultOn);
    rt.telemetry = startTelemetry(
      rt,
      options.telemetry,
      telemetryDefaultOn,
      {
        model: owns ? "local" : decider ? "custom" : "off",
        ...(options.triage ? { triage: options.triage } : {}),
        ...(options.shadow ? { shadow: options.shadow } : {}),
        ...(options.policy?.holdWrites ? { holdWrites: true } : {}),
      },
      token,
    );
  }
  // a token with telemetry off: say so once in debug; on a local host always (a developer trying the dashboard from
  // localhost would otherwise wait for data that never comes)
  const local = rt.telemetry.reason === "local";
  if (token && !rt.telemetry.enabled && (options.debug || local)) {
    try {
      con()?.info?.(
        local
          ? "[GenClass] A token is set, but telemetry is off on local hosts (localhost, *.local, *.test, private networks), so this page does not feed your dashboard; your deployed site does."
          : `[GenClass] A token is set, but telemetry is off (${rt.telemetry.reason ?? "off"}), so nothing reaches your dashboard from this page.`,
      );
    } catch {
      /* ignore */
    }
  }
  return rt;
}

const MODES: readonly Mode[] = ["observe", "guard", "heal"];
const ALL_OFF: Record<ObserverName, boolean> = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, eventsource: false, timers: false };

/** `?genclass=off|observe|guard|heal` in the URL, or localStorage.genclass. */
function killSwitch(g: Record<string, unknown>): string | null {
  let v: string | null = null;
  try {
    const loc = g.location as { search?: string } | undefined;
    if (loc?.search) v = new URLSearchParams(loc.search).get("genclass");
  } catch {
    /* ignore */
  }
  if (!v) {
    try {
      const ls = g.localStorage as Storage | undefined;
      v = ls?.getItem("genclass") ?? null;
    } catch {
      /* ignore */
    }
  }
  return v ? v.trim().toLowerCase() : null;
}

let current: Runtime | null = null;
let warnedIgnored: Runtime | null = null;

export const GenClass = {
  /**
   * Install GenClass (idempotent: a second call returns the same runtime and ignores its options; asking for another
   * mode then logs one warning). Never throws.
   */
  init(options: InitOptions = {}): Runtime {
    if (current) {
      if (warnedIgnored !== current) {
        try {
          warnIgnored(current, options);
        } catch {
          /* a warning never breaks the app */
        }
      }
      return current;
    }
    try {
      return initUnsafe(options);
    } catch (e) {
      const g = globalThis as unknown as Record<string, unknown>;
      (g.console as Console | undefined)?.warn?.(`[GenClass] Could not start (${(e as Error)?.message ?? e}); running without it.`);
      current = createRuntime({ observe: ALL_OFF, decider: null, report: "silent", mode: "observe", telemetry: false });
      return current;
    }
  },
  get runtime(): Runtime | null {
    return current;
  },
  /** Uninstall observers, terminate the model worker. */
  destroy(): void {
    const r = current;
    current = null;
    r?.destroy();
  },
  /** The same as the named export protect(): wrap a function so GenClass tracks and protects each call. */
  protect,
};

setProtectResolver(() => (current instanceof RuntimeImpl ? current : null));

/**
 * GenClass.init on a running runtime ignores its options: one console warning per runtime when the call asks for a
 * different mode, token or scope, saying where each can be set instead (the zero-code entries start GenClass before
 * app code runs, so a later GenClass.init({ token, scope }) cannot reach them).
 */
function warnIgnored(rt: Runtime, options: InitOptions): void {
  const mode = !!options.mode && options.mode !== rt.mode;
  const token = typeof options.token === "string" && options.token.trim() !== "" && options.token.trim() !== (tokenOf.get(rt) ?? "");
  const runningScope = (rt as unknown as { scope?: string }).scope ?? "app";
  const scope = (options.scope === "app" || options.scope === "functions") && options.scope !== runningScope;
  if (!mode && !token && !scope) return;
  warnedIgnored = rt;
  const g = globalThis as unknown as Record<string, unknown>;
  const parts = [
    `[GenClass] Already running in ${rt.mode} mode (started by @genclass/runtime/auto, the script tag or an earlier GenClass.init()), so this call's options are ignored.`,
  ];
  if (mode) parts.push(`To change the mode: GenClass.runtime.setMode("${options.mode}"), or re-run \`npx @genclass/runtime init --mode ${options.mode}\`.`);
  if (token || scope) {
    const what = [token ? "token" : null, scope ? `scope "${options.scope}"` : null].filter(Boolean).join(" and ");
    parts.push(
      `The ${what} must be set where GenClass starts: GENCLASS_CONFIG = { ${token ? 'token: "gc_..."' : ""}${token && scope ? ", " : ""}${scope ? `scope: "${options.scope}"` : ""} } on window before the auto import (\`npx @genclass/runtime init\` writes it to genclass.config.ts/js), <meta name="genclass" content="${[token ? "token=gc_..." : null, scope ? `scope=${options.scope}` : null].filter(Boolean).join(", ")}"> in <head>, or ${[token ? "data-token" : null, scope ? "data-scope" : null].filter(Boolean).join(" / ")} on the script tag.`,
    );
  }
  (g.console as Console | undefined)?.warn?.(parts.join(" "));
}

function initUnsafe(options: InitOptions): Runtime {
  {
    const g = globalThis as unknown as Record<string, unknown>;
    const ks = killSwitch(g);
    if (ks === "off") {
      (g.console as Console | undefined)?.info?.('[GenClass] Disabled by ?genclass=off or localStorage.genclass = "off": nothing is installed.');
      current = createRuntime({ observe: ALL_OFF, model: false, decider: null, report: "silent", mode: "observe", telemetry: false });
      (current as RuntimeImpl).telemetry = telemetryOff("kill-switch");
      return current;
    }
    // The URL / localStorage switch may only demote from the app's mode (OPTIONS-SPEC §3; observe when the app sets
    // none), so a crafted link cannot raise a production site to guard or heal. It may raise only with `debug: true`
    // or on a development host (localhost, *.local, *.test, private networks), where nobody else's link reaches it.
    const rank = (m: string | undefined) => (m === "heal" ? 2 : m === "guard" ? 1 : 0);
    const base = options.mode ?? "observe";
    let devHost = false;
    try {
      devHost = isLocalHost((g.location as { hostname?: unknown } | undefined)?.hostname);
    } catch {
      devHost = false;
    }
    const mode = ks && (MODES as readonly string[]).includes(ks) && (options.debug || devHost || rank(ks) <= rank(base)) ? (ks as Mode) : options.mode;
    if (typeof g.window !== "object" || typeof g.document !== "object") {
      // Not a browser (SSR, Node, workers): never instrument a server's fetch or load the model there.
      current = createRuntime({ ...options, observe: ALL_OFF, model: false, decider: options.decider ?? null, report: options.report ?? "silent", ...(mode ? { mode } : {}) });
      return current;
    }
    const o: CreateOptions = { ...options };
    if (mode) o.mode = mode;
    // anonymous diagnostics: on by default in a browser (TELEMETRY.md), off by default on local and private hosts;
    // opt-outs are checked in resolveTelemetry. An unset option stays unset (an explicit `true` would send from
    // localhost too).
    if (options.decider === undefined && options.model !== false && options.enabled !== false) {
      o.model = options.model ?? {};
      // a dynamic enabled source: never download before it says on
      if (typeof options.enabled === "function" || (typeof options.enabled === "object" && options.enabled)) o.model = { ...o.model, preload: "lazy" };
    }
    current = buildRuntime(o, true);
    return current;
  }
}

export default GenClass;
