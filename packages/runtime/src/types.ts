// Public and shared types of @genclass/runtime. CORE owns this file; the model-facing section is the seam
// between the runtime (CORE) and the model host (MODEL, src/model/**). Change that section only together.

// ----------------------------------------------------------------------------------------------- model seam

/** Jev wire state: an object of named text segments (strings, string arrays, or nested JSON-able values). */
export type JevState = Record<string, unknown>;

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface NoulAnswer {
  type: "noul";
  /** Calibrated P(true). */
  noul: number;
}
export interface ChoiceAnswer<L extends string = string> {
  type: "choice";
  choice: L;
  /** (k * max p - 1) / (k - 1): 0 for a uniform distribution, 1 for a certain one. */
  confidence: number;
  /** Calibrated probability per label, in criteria order. */
  probabilities: Record<L, number>;
}
export interface ScoreAnswer {
  type: "score";
  /** Expected level (sum of i * p_i). */
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type AnswerOf<Q extends Question> = Q extends { type: "noul" }
  ? NoulAnswer
  : Q extends { type: "choice"; criteria: infer C }
    ? ChoiceAnswer<Extract<keyof C, string>>
    : Q extends { type: "score" }
      ? ScoreAnswer
      : never;

export type TriggerKind =
  | "mutation"
  | "request"
  | "delivery"
  | "failure"
  | "stall"
  | "inconsistency"
  | "transition"
  | "error"
  | "ask";

export interface ModelStatus {
  state: "off" | "loading" | "ready" | "error" | "skipped" | "unloaded" | "disabled";
  /** skipped / unloaded / disabled: why. */
  reason?: string;
  /** runtime.status only: the effective mode (requested mode demoted by sample, breaker, route). */
  effectiveMode?: ModeOrOff;
  /** runtime.status only: this session may act (false when sampled out). */
  sampled?: boolean;
  breaker?: { tripped: boolean; at?: number; reason?: string };
  /**
   * runtime.status only: what is in force on the current route. `mode` is the effective mode there (the same as
   * effectiveMode: the requested mode, demoted by sampling, the breaker and the matching `routes[]` rule) and
   * `aggressiveness` the effective level (min of the global and the rule's). With a matching rule: `rule` (its
   * index in `routes`) and `ceiling` (the mode that rule caps the route at; rules only ever lower the mode).
   */
  scope?: { route?: string; mode: ModeOrOff; aggressiveness: number; rule?: number; ceiling?: ModeOrOff };
  modelBudget?: { decisionsLastMinute: number; dropped: number };
  /** Download progress while loading (bytes). */
  progress?: { loaded: number; total: number };
  device?: "webgpu" | "wasm";
  variant?: string;
  /** Model card name. */
  model?: string;
  loadMs?: number;
  error?: string;
  /** What the load is doing now (model host). */
  phase?: "card" | "download" | "runtime" | "session" | "warmup";
  /** Model card version. */
  version?: string;
  /** Size of the loaded variant file. */
  bytes?: number;
  /**
   * The loaded variant's sha256 as listed in the model card (model.json), which the download (or the Cache Storage
   * entry) was verified against; absent when the card lists none. Recorded in every audit entry (rt.audit()).
   */
  sha256?: string;
  /** The variant came from Cache Storage (no download). */
  fromCache?: boolean;
  /** WASM threads (1 unless the page is crossOriginIsolated). */
  threads?: number;
  /** Duration of the first (cold) warm-up forward pass. */
  warmupMs?: number;
  /**
   * Model latency: the second, warm warm-up pass ("warmup"; the first pass is cold on every device, so it is not
   * timed for this), then a window of real evaluations.
   */
  latency?: { p50: number; p90: number; n: number; tokensP50?: number; msPerToken?: number; source?: "warmup" | "evaluations" };
  /** Inference runs in a Worker (false: inline on the main thread). */
  worker?: boolean;
  /** Why the Worker was not used (inline fallback). */
  workerError?: string;
  /**
   * state "error" only: the browser blocked a model or onnxruntime-web download (a Content-Security-Policy, else
   * probably one: see src/model/blocked.ts). The runtime then prints one warning naming the origin and the fix.
   */
  blocked?: { url: string; origin: string; csp: boolean; directive?: string };
  /** What the WebGPU probe found. */
  gpu?: string;
  /** Plans that failed before the one that loaded (or all of them, on error). */
  attempts?: { variant: string; device: string; error: string }[];
  /** onnxruntime-web version. */
  ort?: string;
  /** Data-derived gate thresholds shipped with the model (meta.json `gate`), validated. */
  gate?: ModelGate;
  /** runtime.status only: the aggressiveness level in force (0 cautious … 1 eager). */
  aggressiveness?: number;
}

/** Thresholds of one tier: a default and optional per-trigger values. */
export interface GateTier {
  default?: number;
  byTrigger?: Partial<Record<TriggerKind, number>>;
}

/**
 * The model's own gate (meta.json `gate`). `kind: "mass"` (default): guard/heal are probability thresholds for the
 * summed probability of the permitted actions. `kind: "gain"`: guard/heal are margins in cost units for the best
 * action's estimated gain over the passive action, ĝ(a) = tauGain · ln(p(a) / p(passive)).
 */
export interface ModelGate {
  kind?: GateKind;
  /** Per-aggressiveness gates; when present they replace the top-level values (see InitOptions.aggressiveness). */
  profiles?: GateProfiles;
  /** gain kind: τ, the scale from log-probability ratios to cost units (default 1). */
  tauGain?: number;
  report?: number;
  guard?: GateTier;
  heal?: GateTier;
}

export type GateKind = "mass" | "gain";

/** How eagerly GenClass acts: a named level or a number in [0, 1] (0 cautious, 0.5 balanced, 1 eager). */
export type Aggressiveness = "cautious" | "balanced" | "eager" | number;

/** meta.json `gate.profiles`: one gate per named level (each mass or gain kind, report included). */
export interface GateProfiles {
  cautious?: ModelGate;
  balanced?: ModelGate;
  eager?: ModelGate;
}

/** Where an effective threshold comes from: the app's policy.thresholds, the model's meta gate, or the defaults. */
export type GateSource = "policy" | "model" | "default";

/**
 * The thresholds the §8 gate uses (for one trigger kind, or the defaults when none is given). `kind` "mass": guard/heal
 * are probability thresholds; "gain": margins in cost units (and `tauGain`). `report` is always a probability.
 */
export interface EffectiveGates {
  kind: GateKind;
  /** runtime.gates() only: the effective mode on the current route (observe/off: no gate here leads to an action). */
  mode?: ModeOrOff;
  /** The aggressiveness level in force (0 cautious … 1 eager) and its name when it is one of the three. */
  aggressiveness: number;
  level?: "cautious" | "balanced" | "eager";
  /** "profiles": the model's per-level gates; "scaled": its single gate (or the defaults) shifted by the level. */
  levelSource: "profiles" | "scaled";
  /** gain kind only. */
  tauGain?: number;
  trigger?: TriggerKind;
  /** Detections ("likely") need the top diagnosis's probability to reach this. */
  report: number;
  /**
   * The "possible" detection gate when it is in force (InitOptions.detect): the eager profile's report value from the
   * model's meta gate, below `report`. A top diagnosis other than `expected` at or above it, and below `report`, is a
   * possible detection. Unset when there is no possible tier (guard and heal by default, `detect: "likely"`, an
   * explicit `policy.thresholds.report`, or a model without a lower eager report value). Reporting only: no action
   * gate reads it.
   */
  possible?: number;
  guard: number;
  heal: number;
  source: { report: GateSource; guard: GateSource; heal: GateSource };
}

/**
 * Structured reference to what is being decided. For non-model providers (tests, the sim); never serialized into
 * `state`, and the model host ignores it.
 */
export interface SubjectRef {
  kind: TriggerKind;
  /**
   * request / failure / stall / transition / delivery: the subject op (delivery: the fetch op or the WebSocket /
   * EventSource message op); error: the ambient op when it was thrown.
   */
  op?: number;
  /** mutation: the held mutation id. */
  mutation?: number;
  /** mutation / inconsistency / transition: the store concerned (first one when several). */
  store?: string;
  /** Fields involved. */
  paths?: string[];
  /** mutation: the op that caused the write. */
  cause?: number;
  /** error: the raw error object (identity preserved). */
  error?: unknown;
  /** inconsistency: the violated relation, as text. */
  invariant?: string;
}

export interface EvaluateRequest {
  trigger: TriggerKind;
  state: JevState;
  questions: Record<string, Question>;
  /** Higher runs first when several requests are queued (held writes/requests use 2, background 0). */
  priority?: number;
  /** What is being decided (tests/sim). Never part of the model input. */
  subject?: SubjectRef;
  /**
   * Built-in actions of this trigger that are not offered here, with the reason (= `Situation.notOffered`; tests/sim).
   * Never part of the model input; the model host ignores it.
   */
  notOffered?: Record<string, string>;
  /** Drop the request if it cannot be answered within this many ms (queued requests are not computed). */
  timeoutMs?: number;
}

/** The seam between the runtime and whatever answers its questions: the local model, a test double, the sim. */
export interface DecisionProvider {
  readonly status: ModelStatus;
  /** Resolves when evaluate() can be called; rejects if the model cannot load. */
  ready(): Promise<void>;
  evaluate(req: EvaluateRequest): Promise<Record<string, Answer>>;
  onStatus?(fn: (s: ModelStatus) => void): () => void;
  dispose?(): void;
}

// ------------------------------------------------------------------------------------------- clock (§3)

/** All time and scheduling used by the runtime. The sim injects a virtual clock; browsers use `browserClock`. */
export interface Clock {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  /** Run fn after the current macrotask's microtasks drain. */
  afterTask(fn: () => void): void;
}

// --------------------------------------------------------------------------------------- trace (§3)

export type EventKind =
  | "user"
  | "op.start"
  | "op.end"
  | "state"
  | "error"
  | "nav"
  | "perf"
  | "storage"
  | "custom"
  | "decision"
  | "action";

export interface RtEvent {
  seq: number;
  t: number;
  kind: EventKind;
  name: string;
  /** The op this event belongs to (op.start/op.end: the op; state: the writing op; user: the user op). */
  op?: number;
  /** The causal parent op. */
  cause?: number;
  data?: Record<string, unknown>;
}

export type OpKind = "user" | "fetch" | "xhr" | "ws" | "task" | "timer" | "genclass";
export type OpStatus = "ok" | "error" | "aborted" | "blocked";

export interface Op {
  id: number;
  kind: OpKind;
  /** Signature with ids normalised, e.g. "GET /api/items/:id", 'click button "Add"'. */
  name: string;
  /** e.g. "?q=rea" or a body summary. */
  detail?: string;
  start: number;
  end?: number;
  status?: OpStatus;
  /** HTTP status, or an error name such as "TypeError" / "timeout". */
  code?: number | string;
  /** Parent op (the ambient op when this one started). */
  cause?: number;
  /** Root op of the causal chain (itself when it has no cause). */
  root?: number;
  attempt: number;
  /** store.path -> field version when this op started. Filled lazily for the fields the runtime looks at. */
  reads: Map<string, number>;
  /** Hash of method + url + body for requests. */
  identity?: string;
  meta?: Record<string, unknown>;
}

/** A user action, recorded as an instantaneous op. The DOM observer and the sim use the same entry point. */
export interface UserAction {
  kind: "click" | "type" | "change" | "submit" | "key" | "nav" | (string & {});
  /** Element description, e.g. 'button "Place order"', 'input "Search"'. */
  target?: string;
  /** Typed/selected value (already redacted by the caller when sensitive). */
  value?: string;
  key?: string;
  /** True when the value is sensitive (password field): it is never recorded. */
  sensitive?: boolean;
  /** Clicks: the browser's click count (MouseEvent.detail; 2 for the second click of a double click). */
  clicks?: number;
  data?: Record<string, unknown>;
}

// --------------------------------------------------------------------------------------- state (§4)

export interface StoreOptions<T> {
  /** App capability: reload this store from its source. Enables the `resync` action for the store. */
  resync?: () => Promise<unknown> | unknown;
  /** Default true. false: writes to this store are never held (still traced). */
  hold?: boolean;
  /** Custom one-line description of the value for situations. */
  describe?: (v: T) => string;
}

export interface Atom<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(fn: (prev: T) => T): void;
  subscribe(fn: (v: T) => void): () => void;
}

/** A store the app owns (any get/set/subscribe source) whose writes go through the GenClass pipeline. */
export type Guarded<T> = Atom<T>;

export interface StoreIO<T> {
  get(): T;
  set(v: T): void;
  subscribe?(fn: () => void): () => void;
}

/** A store owned by a state library (redux, zustand): GenClass reads it and the adapter commits writes. */
export interface AdapterIO<T> {
  get(): T;
  /** Optional: lets GenClass write the store directly (rollback). Without it, rollback skips this store. */
  set?(v: T): void;
  /** Changes made outside `propose` are recorded (never held). */
  subscribe?(fn: () => void): () => void;
}

export interface AdapterHandle<T> {
  readonly name: string;
  /**
   * Propose a write: `fn` (or `value`) previews the next state; `commit` performs it on the library store
   * (called synchronously when the write is not held, later when it is, never when it is discarded).
   */
  propose(w: { fn?: (prev: T) => T; value?: T; commit: (next: T) => void }): void;
  dispose(): void;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

// ------------------------------------------------------------------------------------- options (§2, §8)

export type Mode = "observe" | "guard" | "heal";
export type Tier = "passive" | "guard" | "heal";
export type ObserverName = "fetch" | "xhr" | "user" | "errors" | "nav" | "storage" | "perf" | "websocket" | "eventsource" | "timers";

export interface PolicyOptions {
  /**
   * Overrides of the gate thresholds, in the active gate kind: with the default "mass" gate guard/heal are
   * probabilities (defaults 0.9 / 0.8); when the model ships a "gain" gate they are margins in cost units (defaults
   * 2 / 2). `report` is always a probability (default 0.6). Unset values use the model's own gate (meta.json `gate`,
   * per trigger kind then its default), else the defaults. Setting `report` also turns observe's "possible" detection
   * tier off unless `detect: "possible"` asks for it (InitOptions.detect).
   */
  thresholds?: { report?: number; guard?: number; heal?: number };
  /** Action names. When set, only these non-passive actions may run. */
  allow?: string[];
  deny?: string[];
  /**
   * Max time a write/request waits for the model. Default "auto": clamp(1.5 × median of the last 20 model
   * latencies (the model's warm-up time before any), 150, 800) ms.
   */
  holdBudgetMs?: number | "auto";
  /** Default false. */
  holdUserWrites?: boolean;
  /**
   * Request headers that make a non-idempotent request (POST, PATCH, ...) safe to repeat, so that `retry` may be
   * offered for it (case-insensitive). Default ["Idempotency-Key", "X-Idempotency-Key"]. Request-id or tracing
   * headers are not idempotency keys.
   */
  idempotencyHeaders?: string[];
  /**
   * Opt-in (default none): top-level JSON body fields that carry an idempotency key the server deduplicates on (for
   * example ["request_id"] when a repeated POST with the same request_id is answered from the first one). A
   * non-idempotent request whose JSON object body has one of them may be repeated, so `retry` may be offered.
   * Only name fields the server really deduplicates on: a retry of a request that already committed is otherwise a
   * duplicate.
   */
  idempotencyBodyFields?: string[];
  /**
   * Default false: store writes are never held (decisions about responses and messages are taken at the network
   * boundary; salient writes not covered by such a decision are decided in the background and may be reverted
   * under the late-revert rules). true (opt-in): salient writes wait for the model, without ever reordering a
   * store's writes, and reads inside the writing chain see the pending value.
   */
  holdWrites?: boolean;
  /** Default 60 non-passive actions per minute; beyond it the passive action runs and a warning is emitted. */
  /** @deprecated use actionLimits.perMinute */
  maxActionsPerMinute?: number;
  /** Default { perMinute: 60, perSubject: 10, perSession: 200 }. */
  actionLimits?: ActionLimits;
  /**
   * Default true: a non-passive action also requires the model's top diagnosis to be something other than
   * `expected`. The sim passes false to force actions on benign situations when measuring counterfactuals.
   */
  requireDiagnosis?: boolean;
}

/** Overrides of the wording the model sees. */
export interface Vocabulary {
  /** Replaces the diagnosis vocabulary (label -> description). Plugin labels are still added. */
  diagnoses?: Record<string, string>;
  /** Replaces descriptions of built-in actions (name -> description). */
  actions?: Partial<Record<string, string>>;
}

/** Synchronous creation hooks (advanced: tests and the sim). */
export interface RuntimeHooks {
  /** Called synchronously when an op is created (inside the instrumented fetch call, before any await). */
  opCreated?(op: Op): void;
  /** Called synchronously inside atom.set / guarded set / adapter writes, before gating. */
  mutationProposed?(m: { id: number; store: string; paths: string[]; cause?: number; changes: Change[] }): void;
}

export interface ModelOptions {
  baseUrl?: string;
  device?: "auto" | "webgpu" | "wasm";
  worker?: boolean;
  preload?: "eager" | "idle" | "lazy";
  ortWasmPaths?: string;
  cacheName?: string;
  /**
   * Whether to load the model on this device. Default `{ minDeviceMemoryGB: 4, saveData: "skip" }`: no model on
   * devices whose `navigator.deviceMemory` is under 4 GB (the value is quantised to powers of two, so that is
   * exactly "2 GB or less"; browsers that do not report it load) nor on Save-Data connections. The runtime then
   * observes without a model (status.state "skipped" with `reason` "device-memory" / "save-data" / "loadIf") and
   * prints one console line. `() => true` forces the load everywhere. false / "skip" → no download; "lazy" →
   * preload "lazy"; `saveData: "ignore"` loads on Save-Data connections. Unknown values count as allowed.
   */
  loadIf?: { minDeviceMemoryGB?: number; saveData?: "skip" | "lazy" | "ignore" } | ((env: DeviceEnv) => boolean | "lazy");
  /**
   * Run inference on the main thread when the model worker cannot start or crashes before it is up (default true).
   * `false`: the model is then not loaded at all (status.state "skipped", reason "worker-unavailable", one console
   * line naming the worker error) and the runtime observes without it; `worker: false` still runs inline, since
   * that asks for the main thread explicitly.
   */
  inlineFallback?: boolean;
  /** WASM threads (default "auto" = min(4, max(1, cores - 1))). */
  threads?: number | "auto";
  /** Per-evaluation timeout in ms (default 10,000). */
  timeoutMs?: number;
  /** Model evaluations per sliding minute (default 30; Infinity disables). Over it, decisions fail open. */
  maxDecisionsPerMinute?: number;
  /**
   * Tear the model down after this long without an evaluation (default false; hidden-tab time counts as idle); the
   * next salient situation in a visible tab reloads it from cache (OPTIONS-SPEC §4.18; in observe that situation is
   * decided once the model is back, elsewhere it fails open), as does the tab becoming visible with deferred
   * situations waiting. Before 0.3.0 nothing reloaded it, so guard and heal stopped acting for good; now they act
   * again after the reload.
   */
  unloadAfterIdleMs?: number | false;
}

export interface DeviceEnv {
  deviceMemoryGB?: number;
  /** navigator.userAgentData.mobile (Chromium browsers; undefined elsewhere, e.g. Safari). */
  mobile?: boolean;
  saveData?: boolean;
  effectiveType?: string;
  cores?: number;
  webgpu: boolean;
}

export type ModeOrOff = Mode | "off";

/** URL prefix or glob ("https://api.x/v1/orders*" or "/v1/orders*", which also matches the path), RegExp, or predicate. */
export type RequestMatcher = string | RegExp | ((r: { url: string; method: string; channel: "fetch" | "xhr" | "ws" | "sse" }) => boolean);

export interface RouteRule {
  /** Exact path or glob ("/admin/*"), RegExp, or predicate over the route. */
  match: string | RegExp | ((route: string) => boolean);
  /** Demote only. */
  mode?: ModeOrOff;
  /** Demote only. */
  aggressiveness?: Aggressiveness;
}

export interface RequestScope {
  /** Pass-through: not observed at all (no op, no hold). */
  ignore?: RequestMatcher[];
  /**
   * Observed and reported, but never held, delayed, retried, replayed, hedged, coalesced, served from cache or
   * discarded; neither are the state writes its response callbacks make (the request's causal chain). Recommended for
   * payment, checkout and sign-in endpoints. A string "preset:payments" or "preset:auth" stands for that preset's
   * matchers (`protectPreset()`, `PROTECT_PRESETS`), for JSON configs.
   */
  protect?: Array<RequestMatcher | `preset:${string}`>;
  /** Cross-origin requests are always passive; "ignore" also stops observing them. Default "observe". */
  crossOrigin?: "observe" | "ignore";
  /** Names for endpoints in reports and sinks ([A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars). */
  labels?: Array<{ match: RequestMatcher; label: string }>;
  /** Show labels to the model (default false). */
  labelsToModel?: boolean;
  /** Your trace id for a request, stamped on reports and sink records; never shown to the model. */
  correlate?: (r: { url: string; method: string; headers: Record<string, string> }) => string | undefined;
}

export interface EnabledSource {
  get(): boolean;
  subscribe(cb: (on: boolean) => void): () => void;
}

export interface BreakerOptions {
  /** Undos within windowMs that trip it (default 2). */
  undos?: number;
  /** Errors on an acted-on subject within attributionMs after the action (default 3). */
  errorsAfterAction?: number;
  attributionMs?: number;
  windowMs?: number;
  downgradeTo?: "observe" | "guard";
  persist?: "session" | false;
}

export interface ActionLimits {
  /** Max non-passive actions across the session within any 60 s (default 60). */
  perMinute?: number;
  /** Max non-passive actions on the same subject (store field / endpoint signature) within any 60 s (default 10). */
  perSubject?: number;
  /** Absolute cap on non-passive actions per session (default 200). */
  perSession?: number;
}

export interface ActionRequest {
  action: string;
  tier: "guard" | "heal";
  trigger: TriggerKind;
  subject: string;
  diagnosis: string;
  p: number;
  decisionId: string;
  route?: string;
  label?: string;
}

/**
 * `"check"`: a measured visual check (InitOptions.visual), delivered only to sinks whose `kinds` lists it, so an
 * existing sink without a `kinds` filter sees no new record kind.
 */
export type SinkKind = "detection" | "intervention" | "undo" | "breaker" | "summary" | "error" | "expectation" | "check";

export interface SinkRecord {
  schema: 1;
  kind: SinkKind;
  id: string;
  ts: number;
  sessionId: string;
  tags: Record<string, string | number | boolean>;
  correlationId?: string;
  mode: ModeOrOff;
  sampled: boolean;
  diagnosis?: string;
  p?: number;
  /**
   * kind "detection": "likely" (at the report gate) or "possible" (observe's lower tier, InitOptions.detect). A sink
   * receives possible ones only with `possible: true`.
   */
  detection?: "likely" | "possible";
  action?: string;
  tier?: Tier;
  trigger?: TriggerKind;
  label?: string;
  /**
   * The page path (`location.pathname`) the subject's operation was created on, else the current one (kind "check":
   * the route the check ran on), normalised as telemetry sends it: id-like segments (numbers, UUIDs, long hex and
   * tokens) and email segments as ":id", ≤ 200 chars.
   */
  route?: string;
  changed?: string[];
  undone?: boolean;
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  reason?: string;
  summary?: SessionSummary;
  /** expectation: the learned step that did not happen (no page text: the action label is in `evidence.message` only). */
  expectation?: { kind: ExpectationKind; route: string; signature?: string; field?: string; after?: string; to?: string; seen: number; of: number; sessions: number; waitedMs: number };
  /** kind "check": the measured check, its severity and whether a runtime fix was applied. Never selectors or text. */
  check?: { kind: CheckKind; severity: CheckSeverity; fixed: boolean };
  /** With `evidence: true`; for "check" records also the element description and its selector (built locally). */
  evidence?: { message?: string; trigger?: TriggerKind; subject?: string; timeline?: string[]; target?: string; selector?: string };
}

export type SinkFn = (r: SinkRecord) => void | Promise<void>;
export interface SinkObject {
  send: SinkFn;
  kinds?: SinkKind[];
  /** Session-deterministic; never drops intervention / undo / breaker. */
  sampleRate?: number;
  /** Add redacted evidence (message, trigger, subject, timeline). Default false. */
  evidence?: boolean;
  /**
   * Also receive "possible" detections (observe's lower tier: `SinkRecord.detection` "possible"; InitOptions.detect).
   * Default false: a sink gets the likely ones only, as before 0.3.0. A plain function sink never gets possible ones
   * (`detect: "possible"` does not change what sinks get).
   */
  possible?: boolean;
  flush?(): Promise<void>;
}
export type Sink = SinkFn | SinkObject;

export interface SessionSummary {
  startedAt: number;
  durationMs: number;
  /** Likely detections (at the report gate) per diagnosis, as before 0.3.0. */
  detections: Record<string, number>;
  /** Possible detections (observe's lower tier, InitOptions.detect) per diagnosis. */
  possibleDetections: Record<string, number>;
  interventions: Record<string, number>;
  undos: number;
  lateReverts: number;
  denied: Record<string, number>;
  shadow: Record<string, number>;
  /**
   * `hiddenSkipped`: situations not evaluated because the tab was hidden (guard and heal; in observe, those dropped
   * from the full hidden-tab queue).
   */
  model: { state: ModelStatus["state"]; p50Ms?: number; p95Ms?: number; decisions: number; dropped: number; hiddenSkipped: number };
  heldMs: { total: number; max: number };
  errors: number;
  /**
   * Measured visual checks (InitOptions.visual): findings per kind and per route, fixes, cost and coverage. Present
   * only once the checks have run, so a summary without them is unchanged.
   */
  visual?: VisualSummary;
}

/** What an audit entry records (rt.audit()). */
/** `"fix"`: a measured visual check's runtime fix was applied, undone or dropped (no model fields). */
export type AuditKind = "decision" | "action" | "undo" | "breaker" | "control" | "fix";

/** The model an audit entry was decided with (from rt.status at the time). */
export interface AuditModel {
  /** Model card name, else the provider's variant or "custom"; "none" without a provider. */
  name: string;
  state: ModelStatus["state"];
  version?: string;
  variant?: string;
  device?: "webgpu" | "wasm";
  /** The sha256 the loaded variant was verified against (model.json), when the card lists one. */
  sha256?: string;
}

/** The gate values a decision was compared with (OPTIONS-SPEC §0.4; decide/policy.ts -> gate). */
export interface AuditGate {
  kind: GateKind;
  /** The report threshold and the tier thresholds (mass) or margins (gain) in force for this trigger. */
  thresholds: { report: number; guard: number; heal: number };
  /** Where each came from: the app's policy, the model's meta gate, or the defaults. */
  source: { report: GateSource; guard: GateSource; heal: GateSource };
  /** The most probable action the mode and policy permitted. */
  candidate?: string;
  /** Summed probability of the permitted actions (mass kind). */
  mass?: number;
  /** The threshold the candidate's tier needed (mass kind). */
  threshold?: number;
  /** gain kind: ĝ of the candidate and the margin it needed. */
  gain?: number;
  margin?: number;
}

/**
 * One entry of the audit trail (rt.audit(), InitOptions.audit.sink). JSON-serialisable (no functions), built from
 * values the runtime already has; it never feeds a decision, never changes what the model reads and is never sent
 * anywhere by GenClass. URL query and fragment values in `subject`, `changed` and `error` are replaced with "…".
 */
export interface AuditEntry {
  schema: 1;
  /** 1, 2, 3, … per runtime, without gaps (the in-memory buffer drops the oldest entries first). */
  seq: number;
  /** Runtime clock time (ms). */
  at: number;
  kind: AuditKind;
  sessionId: string;
  /** The effective mode for the subject (decision, action, undo) or for the session (breaker, control). */
  mode: ModeOrOff;
  /** The mode the app asked for (rt.mode). */
  requestedMode: Mode;
  /** The aggressiveness level in force (0 cautious … 1 eager) and its name when it is a named profile. */
  aggressiveness: number;
  profile?: "cautious" | "balanced" | "eager";
  model: AuditModel;
  decisionId?: string;
  actionId?: string;
  trigger?: TriggerKind;
  subject?: string;
  label?: string;
  correlationId?: string;
  /** decision: the model's diagnosis and its probability, the action it ranked first and its probabilities. */
  diagnosis?: string;
  diagnosisConfidence?: number;
  proposed?: string;
  probabilities?: Record<string, number>;
  /** decision: the action that ran (the passive one unless the gate let `candidate` through); action/undo: the action. */
  ran?: string;
  executed?: boolean;
  tier?: Tier;
  /** Why the passive action ran instead (protected, cross-origin, scope, vetoed, limit:*, threshold, mode, ...). */
  reason?: string;
  gate?: AuditGate;
  /** decision: whether the subject waited for it, the hold budget then, the model's latency. */
  held?: boolean;
  holdBudgetMs?: number;
  latencyMs?: number;
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  /** action: whether it worked, what it changed, whether it can be undone, late revert, the paths it dropped. */
  ok?: boolean;
  error?: string;
  changed?: string;
  undoable?: boolean;
  late?: boolean;
  dropped?: string[];
  /** undo: true when rt.disable({ undo: true }) rolled it back (not counted by the breaker). */
  byRuntime?: boolean;
  breaker?: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  /** control: what changed (setMode, setAggressiveness, pause, resume, enabled, disable) and from/to. */
  control?: { what: "setMode" | "setAggressiveness" | "pause" | "resume" | "enabled" | "disable"; from?: string | number; to?: string | number };
  /** fix: a visual check's runtime fix (InitOptions.visual.fix): applied, undone or dropped, and the CSS involved. */
  fix?: { what: "apply" | "undo" | "drop"; checkId: string; kind: CheckKind; css: string; reason?: string };
}

/** InitOptions.audit: the in-memory audit trail and an optional sink for the app's own logging. */
export interface AuditOptions {
  /** Entries kept in memory for rt.audit() (default 1,000, at most 10,000; 0 keeps none, the sink still gets all). */
  size?: number;
  /** Receives every entry, in order, on a microtask after it is recorded (never on a hold path); errors are swallowed. */
  sink?: (e: AuditEntry) => void;
}

/** Where an op was created: its effective mode and aggressiveness, protection, and report-only names. */
export interface OpScope {
  mode: ModeOrOff;
  aggressiveness: number;
  protected: boolean;
  crossOrigin: boolean;
  label?: string;
  /** requests.labelsToModel: the label may appear in situation text. */
  labelToModel?: boolean;
  route?: string;
  correlationId?: string;
}

export interface InitOptions {
  /**
   * Default "observe": reports what GenClass sees and would do, and never holds, delays or changes anything.
   * "guard" (opt-in) takes minimal guard-tier actions at very high confidence; "heal" is experimental. The URL
   * switches (`?genclass=`, `?genclass-mode=`) and `localStorage.genclass` may only lower it, with or without `debug`;
   * `?genclass=` and `localStorage.genclass` may raise it only on a development host (http(s) on localhost, 127.0.0.1,
   * [::1] or *.localhost with an explicit port, or *.test).
   */
  mode?: Mode;
  /** false: no model (observe-only). */
  model?: ModelOptions | false;
  /** Bring your own decision provider instead of the local model. */
  decider?: DecisionProvider | null;
  /**
   * Default "console". "interventions": the console prints only actions, undos, breaker trips and errors. A function
   * receives every report; a possible detection (InitOptions.detect) only with `detect: "possible"` set explicitly.
   */
  report?: "console" | "interventions" | "silent" | ((r: Report) => void);
  /** Default true. A predicate / Promise / subscribable flag; while false nothing is decided or downloaded. */
  enabled?: boolean | (() => boolean | Promise<boolean>) | EnabledSource;
  /**
   * Fraction of sessions allowed to act (default 1); the rest observe. `?genclass-sample=0` makes a session observe; no
   * URL value makes it act.
   */
  sample?: number;
  /** Per-route mode and aggressiveness (demote only); the first matching rule wins. */
  routes?: RouteRule[];
  requests?: RequestScope;
  /** Automatic downgrade after undos or errors that follow actions (default on). */
  breaker?: BreakerOptions | false;
  /** Record what this higher mode would have done, without doing it (default false). */
  shadow?: "guard" | "heal" | false;
  /** Synchronous last veto before an action runs: return false (or throw) to veto. */
  onBeforeAction?: (a: ActionRequest) => boolean | void;
  /** "report": call the hook and record its verdict but act anyway (default "enforce"). */
  vetoMode?: "enforce" | "report";
  /**
   * Structured, redacted records for your own side (OPTIONS-SPEC §4.11): a function, a `{ send }` object, or a
   * ready-made, vendor-neutral adapter with no dependencies: `@genclass/runtime/sinks/console-json` (one JSON line per
   * record on the console) and `@genclass/runtime/sinks/webhook` (batched POSTs to a URL you configure). The zero-code
   * entries also take them by name (`console-json:noevidence` sends no evidence text): `window.GENCLASS_CONFIG = {
   * sinks: ["webhook:/genclass"] }`, `<meta name="genclass" content="sink=console-json">`, `data-sink="console-json"`
   * on the script tag, or `npx @genclass/runtime init --sink webhook:/genclass`. Forwarding to Sentry, PostHog or
   * Datadog is not part of the runtime (on every genclass.dev plan, Free included, the GenClass collector forwards to
   * them once turned on: https://genclass.dev/pricing); a page config that names `sentry`, `posthog` or `datadog` gets one console warning
   * that says so and nothing else.
   */
  sinks?: Sink[];
  /** Session id and tags stamped on records (never shown to the model). */
  session?: { id?: string; tags?: Record<string, string | number | boolean> };
  /**
   * The audit trail (rt.audit()): every decision, action, undo, breaker event and control change, with the mode,
   * profile, gate values and model hash in force. Always on in memory (1,000 entries); `sink` ships entries to your
   * own logging. Never shown to the model and never sent anywhere by GenClass. packages/runtime/INTERCEPTION.md.
   */
  audit?: AuditOptions;
  /**
   * Observers to install (default: all, `timers` only with a document). `untrustedEvents` (default false): record
   * synthetic DOM events (isTrusted false) as user actions too, for in-page test harnesses.
   */
  observe?: Partial<Record<ObserverName | "untrustedEvents", boolean>>;
  /** Default "salient". */
  triage?: "salient" | "always";
  /**
   * Which detections are reported (CONTRACT §8). "likely": a top diagnosis other than `expected` at or above the
   * report gate (`gates().report`: the aggressiveness profile's report value from the model's meta gate, 0.90 at
   * balanced with model 0.2.0, or `policy.thresholds.report`). "possible": also those at or above the eager profile's
   * report value (0.70 with model 0.2.0) and below the report gate, as `Decision.detection` "possible": a
   * `console.debug` line ending in "(possible)" (hidden at Chrome's default console level), a secondary card in the
   * devtools, `summary().possibleDetections`, the telemetry `detect` event with `tier: "possible"`, and sinks that set
   * `possible: true`. Default: "possible" where the subject's effective mode is observe and `policy.thresholds.report`
   * is not set, else "likely". Possible detections reach the "detect" event, "report" listeners and a `report`
   * function only when `detect: "possible"` is set explicitly (by default those get the likely ones, as in 0.2.x).
   * Where the possible tier is in force in observe, situations raised while the model loads or the tab is hidden are
   * kept and decided later, reported at the possible tier at most (OPTIONS-SPEC §5.3); "likely" skips them, as 0.2.x
   * did. Reporting only: no action gate changes.
   */
  detect?: "likely" | "possible";
  policy?: PolicyOptions;
  /**
   * Default: values whose leaf field names a secret (password, token, secret, cvv, card number, ssn, iban, api key,
   * ...), never a whole store by its name (`auth.loading` stays visible, `auth.token` is redacted).
   */
  redact?: (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown;
  plugins?: Plugin[];
  /** Events kept, default 500. */
  historySize?: number;
  /**
   * Console logging of every decision. Logging only: it never lets a URL or localStorage switch raise the mode, the
   * aggressiveness or the sampling.
   */
  debug?: boolean;
  /** Learned state (transition profiles, flow expectations) and its persistence; see LearnOptions. */
  learn?: LearnOptions;
  /** Override the diagnosis vocabulary and action descriptions the model sees. */
  vocabulary?: Vocabulary;
  /** Quiet time after the last mutation before a settled point (default 60 ms). */
  settleMs?: number;
  /**
   * How eagerly GenClass fixes client-side errors (default "balanced"). A number in [0, 1] interpolates (0 cautious,
   * 0.5 balanced, 1 eager). Selects the model's gate profile; explicit policy.thresholds still win. The URL parameter
   * `?genclass-aggr=cautious|balanced|eager|<number>` may only lower it (on every host, with or without `debug`);
   * `runtime.setAggressiveness()` changes it later.
   */
  aggressiveness?: Aggressiveness;
  /**
   * Size of the situation text the model reads, in characters. Default "auto": by device from the model status
   * (webgpu 2,400; wasm 1,000 at 1 thread to 2,000 at 4 threads, linear; unknown device 2,400).
   */
  situation?: { budget?: number | "auto" };
  /**
   * Anonymous diagnostics sent to the GenClass maintainers to improve the model (packages/runtime/TELEMETRY.md):
   * session info, decisions (trigger, its calibrated answers, the gate and what ran: every detection, near-miss,
   * action and veto; a `decisionSample` share of routine ones; the redacted situation text the model read only with
   * `include: { situation: true }`), action outcomes, detections, model errors and periodic counts. Never raw input
   * values, cookies, headers or storage. **Default: on with `GenClass.init()` in a browser on a public host** (one
   * console notice per page; the default is off on localhost and private networks, where `true` or an options
   * object is an explicit opt-in that sends from them too); off in
   * Node/SSR and with `createRuntime()` unless set here. Off with `false`, `?genclass=no-telemetry` (or `off`),
   * `localStorage["genclass.telemetry"] = "off"`, or when the browser sends Global Privacy Control
   * (`navigator.globalPrivacyControl === true`).
   */
  telemetry?: boolean | TelemetryOptions;
  /**
   * Interaction analytics for the app's dashboard (docs/runtime/ANALYTICS.md, TELEMETRY.md "Interaction analytics"):
   * per page view, the page route, page views, engaged time (the tab visible, at most 30 s after the last input),
   * scroll depth (25 / 50 / 75 / 100 %) and clicks, rage clicks and dead clicks per element, the element named from
   * markup only (`data-genclass-name`, `data-testid`, an id, a link's target, stable class names or a short
   * structural path; never its text). Per visit (page views with no gap over 30 minutes) also a random visit id, the
   * referring host, the utm_source / utm_medium / utm_campaign values without ids, the device class, browser and OS
   * families (buckets, never the user agent) and whether the browser visited before. Sent as `interactions`
   * telemetry events, never fed to a decision or the model.
   * **Default: off.** Needs telemetry on and the app's `token` (or your own `telemetry.endpoint`); every telemetry
   * opt-out and Global Privacy Control turn it off too. While it runs, one `localStorage` entry
   * (`genclass.analytics.<token>`) holds the visit id and the visited-before flag. Where analytics need consent
   * (the EU, EEA and UK), leave it off and call `runtime.analytics.start()` once the visitor agrees. Also
   * `data-analytics="on"`, `<meta name="genclass" content="analytics=on">`, `window.GENCLASS_CONFIG.analytics`.
   */
  analytics?: boolean;
  /**
   * Automatic state discovery: find the app's state without registering stores. **Default: on in the zero-code
   * entries** (`@genclass/runtime/auto*`, the script tag); off with `GenClass.init()` / `createRuntime()` unless set
   * here. Must be installed before the framework loads (the one line first). Covers React ≥ 16.8 component state
   * (useState, useReducer, useSyncExternalStore, class state, via the React DevTools hook), Redux / Redux Toolkit stores
   * (via the Redux DevTools compose/enhancer globals: full adapters) and Zustand `devtools` stores (via the Redux
   * DevTools `connect` API). Discovered React and Zustand state is observed only: GenClass sees its writes and their
   * causes (detections, delivery decisions) but never holds, drops or reverts them. `false` or an object turning
   * single sources off (`{ react: false }`). Also `<meta name="genclass" content="autostate=off">`.
   */
  autoState?: boolean | AutoStateOptions;
  /**
   * Measured visual checks (docs/runtime/VISUAL.md): text you cannot read against its background, images, fonts,
   * stylesheets and media that failed to load, pages that scroll sideways, layers that swallow clicks, dialogs
   * covered by other elements, "[object Object]" and similar leaks. These are deterministic measurements with fixed,
   * documented thresholds, reported as kind "check" (`rt.on("check")`, `rt.checks()`); the model is not involved and
   * they never feed a decision. **Default: "local" with `GenClass.init()` in a browser** (on for development hosts:
   * http(s) on localhost, 127.0.0.1, [::1] or a *.localhost name with a port, and *.test names; and when the devtools
   * overlay is mounted; off elsewhere); off in `createRuntime()`. Nothing about them is sent. `true` turns report-only
   * checks on everywhere. `?genclass-visual=off` turns them off; `?genclass-visual=on` turns on report-only checks on
   * any host (never fixes). Runtime fixes need `{ on: true, fix: true }` and guard or heal mode; observe never changes
   * the page. `rt.summary().visual` has the counts; `@genclass/runtime/visual` exports `checkPage()` for your tests.
   */
  visual?: boolean | "local" | VisualOptions;
  /**
   * Your app's GenClass token (`gc_` + 22 letters/digits; get one with `npx @genclass/runtime init` or at
   * https://genclass.dev/start). Public: it only lets this app's telemetry batches be grouped under your private
   * dashboard link. It does nothing while telemetry is off (opt-outs and Global Privacy Control still win). An invalid
   * value logs one console warning and is ignored. Also `data-token`, `<meta name="genclass" content="token=...">`,
   * `window.GENCLASS_CONFIG.token`. Fixed when GenClass starts: a later GenClass.init() on a running runtime (one
   * started by `/auto` or the script tag) ignores it, with one console warning.
   */
  token?: string;
  /**
   * Where GenClass raises decisions. "app" (default): the whole app. "functions": only for activity inside functions
   * wrapped with `protect()` (their fetches, state writes, timers and errors); everything else is still observed
   * and recorded as context, but the runtime raises no decision about it and never acts on it; standing questions
   * (`runtime.question()`, plugin `questions`) are only asked about protected activity too. Explicit questions
   * (`runtime.ask()`, `runtime.decide()`) are still answered everywhere. Fixed when GenClass starts, like `token`
   * (also `data-scope`, `scope=functions` in the meta tag, `window.GENCLASS_CONFIG.scope`).
   */
  scope?: "app" | "functions";
}

/**
 * InitOptions.learn: what GenClass learns about the page (transition profiles per operation, flow expectations per
 * user action; docs/runtime/EXPECTATIONS.md) and where it keeps it between visits.
 */
export interface LearnOptions {
  /**
   * Keep learned state per origin between page loads. Unset (the default): the flows behind `expectation` reports
   * (reporting only) are kept in localStorage; transition profiles, which feed the model, stay in memory (CONTRACT
   * §4). true / "local": flows and transition profiles in localStorage; "session": both in sessionStorage; false:
   * nothing is stored. Without working storage, or by default in a DOM test environment (jsdom, happy-dom), nothing
   * is stored either. What is stored: request signatures, routes and field names (id-like segments and keys
   * normalised; other path segments and map keys as they are), hashes of user-action labels, counts and delay
   * samples; never element text or values. Capped at `maxBytes`; discarded when `version` or the runtime version
   * changes.
   */
  persist?: boolean | "local" | "session";
  /** Storage key. Default "genclass:learn". */
  key?: string;
  /** Discards stored state learned under another version (as does a new runtime version). Default: session.tags.release at init. */
  version?: string;
  /**
   * Size cap of the stored state in characters: the most-used flows and the profiles with the most completions are
   * kept; only the stored copy is trimmed, never what is in memory. Default 200,000.
   */
  maxBytes?: number;
  /**
   * Flow expectations (`expectation` reports, rt.learned().flows). Default false (opt-in until their false-report rate
   * is measured, docs/runtime/RESULTS.md): nothing is learned, stored or reported, and src/learn/flows.ts is never
   * loaded. true: the layer is imported on the next task after init (a lazy chunk, no first-load cost) and learns from then on.
   */
  expectations?: boolean;
  /**
   * Observations of a flow (or completions of a request) before a step is expected of it. Default 8 while all of
   * them are from this page load, 20 once stored observations from earlier page loads count; a number sets both.
   */
  minSupport?: number;
  /** Share of observations in which a step must have occurred to be expected. Default 0.95. */
  minShare?: number;
  /**
   * Distinct sessions a flow must have been seen in before anything is expected of it (for `response`: sessions on
   * this origin, this one included). A session is a browsing session of a tab: a reload continues it. Default 3
   * when learned state is kept in localStorage, else 1.
   */
  minSessions?: number;
}

/** A learned step that did not happen this time (reporting only; never an action). */
export type ExpectationKind = "request" | "response" | "write" | "follow-up" | "navigation";

/**
 * An `expectation` report (rt.on("expectation"), Report.expectation, docs/runtime/EXPECTATIONS.md): a step that the
 * same user action on the same route usually produces (`seen` of `of` observations across `sessions` sessions) and
 * this time did not within the learned bound. Counts are learned, never decided by the model.
 */
export interface Expectation {
  kind: ExpectationKind;
  /** Normalised route the flow was learned on. */
  route: string;
  /** The user action, e.g. 'clicking button "Add to cart"' (`response`: the request signature). */
  action: string;
  /** The user op (`response`: the request op). */
  op: number;
  /** request / follow-up / write / response: the request signature. */
  signature?: string;
  /** write: the field(s) usually written. */
  field?: string;
  /** follow-up: the request after whose completion `signature` usually follows. */
  after?: string;
  /** navigation: the route the action usually leads to. */
  to?: string;
  /** Times the step was seen, out of the observations it is measured against, and the sessions behind them. */
  seen: number;
  of: number;
  sessions: number;
  /** How long GenClass waited before reporting (ms). */
  waitedMs: number;
  /** The learned bound the wait was compared with (p95 of the step's delay; p99 of the latency for `response`). */
  usualMs?: number;
  at: number;
  /** The console line. */
  message: string;
}

/** One learned flow (rt.learned().flows): what a user action on a route usually does. */
export interface LearnedFlow {
  route: string;
  /** e.g. 'click button "Place order"' (a label not seen this session shows as `button #<hash>`). */
  action: string;
  /** Observations, those that repeated the action within a page load, and distinct sessions. */
  n: number;
  repeats: number;
  sessions: number;
  /** Time from the action to its last request's end. */
  settleMs?: { p50: number; p95: number };
  /**
   * Requests the action starts (`onRepeat`: of them, in repeats). `expected`: its absence is reported the first time
   * the action happens in a page load (support, share and session thresholds met, a method that changes data, not
   * protected, not `missed`); `expectedOnRepeat`: also on a repeat (the share holds among `repeats` too). `missed`:
   * its absence was reported, and it is not expected again until it is seen again (on every step kind below too).
   */
  children: { signature: string; n: number; share: number; onRepeat: number; expected: boolean; expectedOnRepeat: boolean; protected?: boolean; missed?: boolean; delayMs?: { p50: number; p95: number } }[];
  /**
   * Fields each request's response handler writes (a refetch's writes are the refetch's). `expected`: a missing write
   * is reported (thresholds met and the request changes data: not GET, HEAD or OPTIONS).
   */
  writes: { signature: string; field: string; n: number; of: number; share: number; expected: boolean; missed?: boolean }[];
  /** Requests that start after another one of the flow answers ok; `expected` needs one of the pair to change data. */
  followUps: { after: string; then: string; n: number; of: number; share: number; expected: boolean; missed?: boolean; delayMs?: { p50: number; p95: number } }[];
  /** Routes the action leads to. */
  nav: { to: string; n: number; share: number; expected: boolean; missed?: boolean }[];
}

/** rt.learned(): what GenClass learned about the page (reporting only). */
export interface Learned {
  /** The current route (normalised). */
  route: string;
  /** Flow expectations are on (learn.expectations: true); false: `flows` and `deviations` stay empty. */
  expectations: boolean;
  /**
   * This session's ordinal on this origin: 1 + the sessions that stored learned state before it, or, after a reload
   * in the same tab, the ordinal the tab already had (kept in sessionStorage). Always 1 when nothing is stored.
   */
  session: number;
  /** Learned flows, the current route's first. */
  flows: LearnedFlow[];
  /** Recent expectation reports (last 50), oldest first. */
  deviations: Expectation[];
  /** Learned relations between fields (invariants), as text, with the settled points they held at. */
  relations: { text: string; held: number }[];
}

// --------------------------------------------------------------------------- measured visual checks (VISUAL.md)

/** The v1 measured visual checks (docs/runtime/VISUAL.md section 3). */
export type CheckKind =
  | "image-broken"
  | "image-css-broken"
  | "media-failed"
  | "stylesheet-failed"
  | "font-failed"
  | "icon-font-failed"
  | "csp-blocked"
  | "text-invisible"
  | "text-template-leak"
  | "text-placeholder"
  | "text-encoding"
  | "css-var-undefined"
  | "image-distorted"
  | "page-overflow-x"
  | "viewport-meta-missing"
  | "layout-shift"
  | "page-blank"
  | "click-blocked"
  | "pointer-events-leak"
  | "scroll-lock-stuck"
  | "control-unreachable"
  | "focus-obscured"
  | "dialog-covered";

/** The checks that may apply a runtime fix (opt-in, reversible, never in observe). */
export type VisualFixKind = "text-invisible" | "pointer-events-leak" | "scroll-lock-stuck";

/** high: content or controls cannot be read, seen or used; medium: visibly wrong but usable; low: small visible effect. */
export type CheckSeverity = "high" | "medium" | "low";

/** InitOptions.visual as an object. */
export interface VisualOptions {
  /** Same values as the shorthand. Default "local" in GenClass.init() (browser), false in createRuntime(). */
  on?: boolean | "local";
  /** Turn single kinds on or off. Default: every v1 kind on. */
  checks?: Partial<Record<CheckKind, boolean>>;
  /**
   * Runtime fixes (VISUAL.md section 11). Default false. true allows the three fix kinds; or a list of them. Needs
   * `on: true` (the "local" default and ?genclass-visual=on never fix) and guard or heal mode (heal alone never turns
   * fixes on); a sampled-out session never fixes. Every fix is undone on setMode("observe"), the breaker, disable(),
   * pause() (within 2 s) and destroy(), and by `finding.fix.undo()`; a colour fix also when the background it was made
   * for changes. A scroll lock held since the page loaded, with no dialog ever open, is reported but not removed.
   */
  fix?: boolean | VisualFixKind[];
  /** Selectors (and image hosts, for text-placeholder) never checked, for example third-party widgets. */
  ignore?: string[];
  /** Per idle slice, ms. Default 8, clamped to 2..16. */
  budgetMs?: number;
  /** Check time per pass, ms. Default 100; the pass then ends as partial. */
  passBudgetMs?: number;
  /** Candidate elements per pass. Default 2,000. */
  maxElements?: number;
  /** Low-end devices: "light" (default) runs only the near-free checks; "full" runs all; "off" runs none. */
  lowEnd?: "light" | "full" | "off";
  /** Fraction of sessions that run the measured layout and text checks (default 1); deterministic per session id. */
  sample?: number;
  /** Console lines per pass before folding (default 10). */
  maxConsoleLines?: number;
}

/**
 * One measured visual check (VISUAL.md section 9.1). A measurement against a fixed threshold, never a model finding:
 * `source` is always "check".
 */
export interface CheckFinding {
  /** "c1", "c2", ... per runtime (a counter). */
  id: string;
  /** Always "check": a measurement, never a model finding. */
  source: "check";
  basis?: "measurement" | "baseline";
  kind: CheckKind;
  severity: CheckSeverity;
  /** Clock time. */
  at: number;
  /** Normalised route the finding was made on. */
  route?: string;
  /** Element description, for example 'paragraph "Ship faster with"'. */
  target: string;
  /** A CSS selector for the element, built locally for the developer; never sent anywhere unless the app opts in. */
  selector: string;
  /** The element while it is still connected, else null. */
  element(): Element | null;
  /** What was measured, for example { ratio: 1.04, fg: "#ffffff", bg: "#fafafa", fontPx: 16 }. */
  measured: Record<string, number | string | boolean>;
  /** The threshold the measurement was compared with, and where it comes from. */
  threshold: { value: number | string; unit: string; source: string };
  context: {
    scheme: "light" | "dark";
    state?: "rest" | "hover" | "focus" | "touch";
    viewport: { w: number; h: number };
    coarse: boolean;
    tier: "full" | "light";
  };
  /** The console line. */
  message: string;
  /** The collapsed console group: measured values, threshold source, selector, how to ignore. */
  details: string[];
  /** A CSS change for the developer. */
  suggestion?: { selector: string; css: string; note?: string };
  /** A runtime fix (visual.fix, guard or heal mode only). */
  fix?: { id: string; applied: boolean; css?: string; reason?: string; undo(): boolean };
  /** Elements folded into this finding (same kind and same suggested selector). */
  count?: number;
}

/** SessionSummary.visual: what the visual checks found, fixed, cost and covered in this session. */
export interface VisualSummary {
  /** Findings reported, per kind. */
  checks: Partial<Record<CheckKind, number>>;
  /** The same counts per normalised route (at most 20 routes). */
  checksByRoute: Record<string, Partial<Record<CheckKind, number>>>;
  /** Runtime fixes applied and undone (by the developer or automatically). */
  fixes: { applied: number; undone: number };
  /** Passes run (a pass measures the page or the subtrees that changed). */
  passes: number;
  /** Candidate elements measured. */
  elements: number;
  /** Total check time (Clock ms) and the longest slice. */
  ms: number;
  maxSliceMs: number;
  /** Passes that ran out of their budget. */
  partial: number;
  /** Measurements that abstained (for example text over an image or a gradient), counted, never reported. */
  abstained: number;
  /** Kinds this browser cannot measure (no browser signal), recorded instead of a zero. */
  unsupported: CheckKind[];
  /** "light" on low-end devices and sampled-out sessions: only the near-free checks ran. */
  tier: "full" | "light";
  /** The session budget ran out: incremental checks stopped for the rest of the window. */
  stopped?: boolean;
}

/** InitOptions.autoState as an object: each source defaults to on. */
export interface AutoStateOptions {
  /** React state via the React DevTools hook. Default true. */
  react?: boolean;
  /** Redux / Redux Toolkit stores via the Redux DevTools compose and enhancer globals (full adapter). Default true. */
  redux?: boolean;
  /** Zustand `devtools` stores (and other stores reporting to the Redux DevTools `connect` API). Default true. */
  zustand?: boolean;
  /** Vue 3 + Pinia: not implemented yet (ignored). */
  pinia?: boolean;
}

/** runtime.stores(): one registered or discovered store. */
export interface StoreInfo {
  readonly name: string;
  /** atom, guard, adapter (registered or a discovered Redux store), observed (discovered, observed only). */
  readonly kind: "atom" | "guard" | "adapter" | "observed";
  /** How it was discovered: "react", "redux", "devtools" (a Redux DevTools `connect` client such as Zustand); unset when registered by the app. */
  readonly source?: string;
  /** GenClass can write it (rollback, chain revert); false for observed-only stores. */
  readonly writable: boolean;
  /** Fields (flattened paths) and the number of recorded writes. */
  readonly fields: number;
  readonly version: number;
}

/** InitOptions.telemetry as an object (enables telemetry). */
export interface TelemetryOptions {
  /** Collector URL (default DEFAULT_TELEMETRY_ENDPOINT). */
  endpoint?: string;
  /** Fraction of page sessions that send (0..1, default 1), drawn once per page load. */
  sample?: number;
  /** Batch interval in ms (default 10,000). Batches are also sent on pagehide / when the tab is hidden. */
  flushMs?: number;
  /** Max events per request (default 100; requests are also kept under 60 KB for keepalive/sendBeacon). */
  maxBatch?: number;
  /** situation (default false): include the redacted situation text the model read in decision events. */
  include?: { situation?: boolean };
  /**
   * Share of routine decisions (top diagnosis "expected", no action, no veto, no shadow pass) whose `decision` record
   * is sent (0..1, default 0.25), drawn per decision from a hash of the session and decision ids. Every other
   * decision, every detection among them, is always sent and never capped. `summary` counts every decision whatever
   * the share.
   */
  decisionSample?: number;
  /**
   * Most routine decisions per page load whose `decision` records are sent (default 200; `Infinity` for no cap).
   * Detections and the other decisions are never capped; `summary` events (counts) continue, so an open tab's upload
   * stays bounded for routine traffic.
   */
  maxDecisions?: number;
  /** Advanced (tests, custom pipelines): replaces the network transport. Errors are swallowed. */
  transport?: TelemetryTransport;
}

export interface TelemetryTransport {
  /**
   * `beacon`: the page is going away (pagehide / hidden); prefer navigator.sendBeacon. Reject to report a failed
   * request: an error whose `status` is 429, or 503 with `retryAfterMs` (a Retry-After header, in ms), is a back-off
   * (the batch is queued again and sending pauses for 30 s doubling per back-off in a row, or the Retry-After when it
   * is longer, at most 5 min); after 8 back-offs in a row a refusal counts as a failure. Any other rejection (a network
   * error, another status) counts as a failure; three in a row stop telemetry for the page.
   */
  send(url: string, body: string, o: { beacon: boolean }): void | Promise<unknown>;
}

/** runtime.telemetry: whether this page sends diagnostics, and why not. */
export interface TelemetryStatus {
  readonly enabled: boolean;
  /** Off: "option", "headless", "url", "localStorage", "gpc", "sampled-out", "no-crypto", "no-transport", "kill-switch". */
  readonly reason?: string;
  readonly endpoint?: string;
  /** Random per page load (not persisted). */
  readonly sessionId?: string;
  /**
   * The app token sent with each batch (InitOptions.token), when one is configured and valid and telemetry is on;
   * undefined while telemetry is off, even with a token configured.
   */
  readonly token?: string;
  /** Send what is queued now (resolves when the requests settle; never rejects). */
  flush(): Promise<void>;
}

/** runtime.analytics: whether interaction analytics are recorded on this page (InitOptions.analytics), and why not. */
export interface AnalyticsStatus {
  readonly enabled: boolean;
  /**
   * Off: "option" (not turned on), "telemetry-off" (telemetry is off: an opt-out, Global Privacy Control, a local
   * host), "no-token" (no app token and the default endpoint), "stopped" (`stop()`), "error" (the analytics code did
   * not load).
   */
  readonly reason?: string;
  /**
   * Start recording now (after the visitor consented, or to turn analytics on without the init option). Returns
   * whether they are on; does nothing while telemetry is off or without a token.
   */
  start(): boolean;
  /**
   * Stop recording, drop the counts not sent yet and remove the visit entry from `localStorage` (the visitor withdrew
   * consent). `start()` turns it on again.
   */
  stop(): void;
}

export interface CreateOptions extends InitOptions {
  /** Default browserClock. */
  clock?: Clock;
  /** The object whose fetch/XMLHttpRequest/addEventListener/... are instrumented. Default globalThis. */
  global?: object;
  /** App title and route for situations. Default: global.document.title and global.location.pathname. */
  app?: () => { title?: string; route?: string };
  /** Synchronous creation hooks (advanced: tests and the sim). */
  hooks?: RuntimeHooks;
}

// ----------------------------------------------------------------------------------------- questions (§2)

export interface AskOptions {
  about?: "now" | number | string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------- situations (§5, §6)

export type FactKind =
  | "provenance"
  | "versions"
  | "inputs"
  | "concurrency"
  | "repetition"
  | "outcome"
  | "baseline"
  | "invariant"
  | "transition"
  | "error"
  | "delta"
  | "cache"
  | "request"
  | "plugin";

export interface Fact {
  text: string;
  kind: FactKind;
  /** Neutral facts never make a situation salient (triage). */
  neutral: boolean;
}

/** What the model sees for a trigger. */
export interface Situation {
  trigger: TriggerKind;
  /** One sentence naming the subject. */
  subject: string;
  state: JevState;
  questions: Record<string, Question>;
  /** Applicable actions, passive first. */
  actions: string[];
  /** Built-in actions of this trigger that are not offered here, with the reason (debugging; not sent to the model). */
  notOffered?: Record<string, string>;
  /** Whether triage would consult the model. */
  salient: boolean;
  facts: string[];
  /** Compact questions (budget ≤ 1,400 chars): bare diagnosis labels and action names. */
  compact: boolean;
  /** The situation budget in characters. */
  budget: number;
}

export interface RequestInfo {
  method: string;
  url: string;
  signature: string;
  identity: string;
  idempotent: boolean;
  replayable: boolean;
  /** The request carries one of `policy.idempotencyHeaders` (it may be repeated safely although its method is not idempotent). */
  idempotencyKey?: boolean;
  /** Ops of identical requests in flight. */
  identicalInFlight: number[];
  /** A cached good response exists for this request. */
  cached: boolean;
}

/** The draft situation handed to plugins (facts and applicability). */
export interface SituationDraft {
  trigger: TriggerKind;
  subject: string;
  now: number;
  /** Subject op (request/failure/stall/transition), cause op (mutation), ambient op (error). */
  op?: Op;
  root?: Op;
  /** Stores concerned by the subject. */
  stores: string[];
  mutation?: { id: number; store: string; changes: Change[] };
  request?: RequestInfo;
  /** delivery: the fields the operation is predicted to write (normalised paths) and those with newer data. */
  delivery?: { channel: "response" | "websocket" | "eventsource"; predicted: string[]; conflicts: string[] };
  failure?: { kind: "network" | "timeout" | "http"; status?: number; message?: string };
  error?: { name: string; message: string; source?: string };
  invariants?: { id: string; text: string }[];
  facts: Fact[];
  inFlight: Op[];
}

// -------------------------------------------------------------------------------------- decisions (§8)

export interface Decision {
  /** "d<n>" */
  id: string;
  trigger: TriggerKind;
  subject: string;
  at: number;
  latencyMs: number;
  model: string;
  diagnosis: string;
  diagnosisConfidence: number;
  diagnosisProbabilities: Record<string, number>;
  /** The action the model chose (highest probability). */
  action: string;
  /** probabilities[action]. */
  confidence: number;
  probabilities: Record<string, number>;
  /** True when `action` ran as chosen. */
  executed: boolean;
  /** Why the passive action ran instead (mode, threshold, diagnosis, deny, rate, budget). */
  reason?: string;
  facts: string[];
  /** Tier of `action`. */
  tier: Tier;
  /** The most probable action the mode and policy permit (what GenClass would have done). */
  candidate?: string;
  /** Summed probability of the permitted actions (the gate compares it with the candidate's tier threshold). */
  mass?: number;
  /** The gate kind in force ("mass" or "gain", from the model's meta.json). */
  gateKind?: GateKind;
  /** mass kind: the threshold `mass` was compared with (the candidate's tier, for this trigger kind). */
  threshold?: number;
  /** gain kind: ĝ of the candidate, tauGain · ln(p(candidate) / p(passive)), and the margin it was compared with. */
  gain?: number;
  margin?: number;
  /** Where the threshold or margin came from. */
  thresholdSource?: GateSource;
  /** The effective mode for this decision's subject. */
  effectiveMode?: ModeOrOff;
  /** shadow option: what the shadow mode would have done with the same answer. */
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  /** The action that actually ran. */
  ran: string;
  /** Every answer the model gave (including plugin standing questions). */
  answers: Record<string, Answer>;
  /** Structured reference to the subject (same as EvaluateRequest.subject). */
  subjectRef?: SubjectRef;
  /** The protect()ed function the subject ran inside (the outermost one in its cause chain); unset otherwise. */
  fn?: string;
  /**
   * Set when this decision is a detection: "likely" (top diagnosis not `expected`, probability ≥ the report gate) or
   * "possible" (≥ the possible gate, below the report gate; InitOptions.detect; also any detection decided late from a
   * deferred situation, OPTIONS-SPEC §5.3). `explain()`, the console line, the devtools and telemetry read it.
   */
  detection?: "likely" | "possible";
}

export type Detection = Decision;

export interface ActionRecord {
  /** "a<n>" */
  id: string;
  decisionId: string;
  action: string;
  tier: Tier;
  trigger: TriggerKind;
  subject: string;
  at: number;
  ok: boolean;
  error?: string;
  /** Exactly what GenClass altered, in one sentence. */
  changed: string;
  /** Reverses the action when it is reversible (discard: apply the dropped write now; rollback: restore). */
  undo?: () => void;
  /** The subject had already proceeded (hold budget expired): the action reverted it afterwards. */
  late?: boolean;
  /** delivery `discard`: store paths whose writes by the delivered operation's chain were dropped so far. */
  dropped?: string[];
}

export interface Report {
  /**
   * `expectation`: a learned step did not happen (Report.expectation; reporting only). "check": a measured visual
   * check or one of its runtime fixes (never a model finding).
   */
  kind: "detect" | "intervene" | "status" | "undo" | "breaker" | "error" | "expectation" | "check";
  message: string;
  /** kind "check": the finding. */
  check?: CheckFinding;
  decision?: Decision;
  action?: ActionRecord;
  expectation?: Expectation;
  /** Effective mode at the decision. */
  mode?: ModeOrOff;
  correlationId?: string;
  label?: string;
  session?: { id: string; tags: Record<string, string | number | boolean> };
}

export interface Explanation {
  /** The console line for this decision/action (as printed with report: "console"). */
  message: string;
  decision: Decision;
  situationText: string;
  facts: string[];
  timeline: string[];
  answers: Record<string, Answer>;
  action?: ActionRecord;
  changed?: string;
  /** The gate thresholds in force for this decision's trigger when it was decided. */
  gates?: EffectiveGates;
}

// ----------------------------------------------------------------------------------------- plugins (§9)

export interface ActionContext {
  readonly trigger: TriggerKind;
  readonly decision: Decision;
  readonly situation: SituationDraft;
  readonly runtime: Runtime;
  /** Run a built-in action applicable to this trigger (e.g. "discard", "retry") from a custom action. */
  builtin(name: string): Promise<boolean>;
  /** Describe exactly what this action altered (ActionRecord.changed). */
  describe(changed: string): void;
  /** Register how to undo this action (ActionRecord.undo). */
  onUndo(fn: () => void): void;
}

export interface ActionDef {
  name: string;
  description: string;
  on: TriggerKind[];
  /** Default "heal". */
  tier?: Exclude<Tier, "passive">;
  risk?: "low" | "medium" | "high";
  applicable?(sit: SituationDraft): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}

export interface StandingQuestionContext {
  decision: Decision;
  situation: SituationDraft;
  runtime: Runtime;
}

export interface StandingQuestion {
  id: string;
  on: TriggerKind[];
  question: Question;
  /** true: ask on every trigger of these kinds, even when triage finds nothing salient. */
  always?: boolean;
  onAnswer?(a: Answer, ctx: StandingQuestionContext): void;
}

export interface PluginApi {
  readonly runtime: Runtime;
  readonly clock: Clock;
  emit(name: string, data?: Record<string, unknown>): void;
  /** Start an op (cause = the ambient op). Returns its id. */
  recordOp(kind: OpKind, name: string, meta?: { detail?: string; identity?: string; data?: Record<string, unknown> }): number;
  endOp(id: number, status?: OpStatus, info?: { code?: number | string; error?: unknown }): void;
  /** Run fn with the given op as the ambient op. */
  runInOp<T>(id: number, fn: () => T): T;
  user: Runtime["user"];
  reportError: Runtime["reportError"];
  on: Runtime["on"];
  stores: { names(): string[]; get(name: string): unknown };
}

export interface Plugin {
  name: string;
  setup?(api: PluginApi): void | (() => void);
  facts?(sit: SituationDraft): string[];
  actions?: ActionDef[];
  questions?: StandingQuestion[];
  diagnoses?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------- runtime (§2)

export interface RuntimeEvents {
  /**
   * A detection: likely ones, and possible ones only with `detect: "possible"` set explicitly (`Decision.detection`;
   * every detection is also on "decide" with `detection` set).
   */
  detect: Detection;
  decide: Decision;
  act: ActionRecord;
  event: RtEvent;
  status: ModelStatus;
  report: Report;
  shadow: { decisionId: string; action: string; tier: Tier; wouldPass: boolean; reason?: string };
  breaker: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  limit: { kind: "perMinute" | "perSubject" | "perSession"; subject: string };
  modelBudget: { decisionsLastMinute: number; dropped: number };
  /** A learned step did not happen (also a Report of kind "expectation"). */
  expectation: Expectation;
  /** A measured visual check was confirmed (InitOptions.visual). Never fires `detect`. */
  check: CheckFinding;
}

export interface Runtime {
  /** Resolves when the model is loaded (immediately when there is no model). Accessing it starts a lazy load. */
  readonly ready: Promise<void>;
  readonly status: ModelStatus;
  readonly mode: Mode;

  atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T>;
  guard<T>(name: string, io: StoreIO<T>, opts?: StoreOptions<T>): Guarded<T>;
  /** For state-library adapters (redux, zustand): register a store whose writes the adapter commits. */
  adapter<T>(name: string, io: AdapterIO<T>, opts?: StoreOptions<T>): AdapterHandle<T>;
  expect(name: string, predicate: () => boolean): () => void;

  ask<Q extends Question>(q: Q, opts?: AskOptions): Promise<AnswerOf<Q>>;
  decide<L extends string>(question: string, options: Record<L, string>, opts?: AskOptions): Promise<L>;

  on<K extends keyof RuntimeEvents>(type: K, fn: (v: RuntimeEvents[K]) => void): () => void;

  op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>;
  emit(name: string, data?: Record<string, unknown>): void;
  user<T>(action: UserAction, handler?: () => T): T | undefined;
  reportError(error: unknown, info?: { source?: string }): void;

  use(plugin: Plugin): () => void;
  action(def: ActionDef): () => void;
  question(def: StandingQuestion): () => void;

  situation(trigger?: TriggerKind): Situation;
  explain(id: string): Explanation | null;
  history(n?: number): RtEvent[];
  decisions(n?: number): Decision[];
  interventions(n?: number): ActionRecord[];
  /**
   * The audit trail, oldest first (the last `n` entries; all kept by default, up to InitOptions.audit.size, 1,000):
   * every decision, action, undo, breaker trip/reset and control change (setMode, setAggressiveness, pause, resume,
   * enabled, disable) as JSON-serialisable AuditEntry copies, each with the mode, profile, gate values and the
   * model's name, version and sha256 in force. Keeps working after destroy(); `JSON.stringify(rt.audit())` exports it.
   */
  audit(n?: number): AuditEntry[];
  /** In-flight ops (introspection). */
  inflight(): Op[];
  /** Registered and automatically discovered stores (introspection). */
  stores(): StoreInfo[];
  /** The current hold budget in ms (policy.holdBudgetMs, "auto" by default). */
  holdBudgetMs(): number;
  /** The current situation size in characters (situation.budget, "auto" by default). */
  situationBudget(): number;
  /** The gate thresholds in force for a trigger kind (policy overrides, else the model's meta gate, else defaults). */
  gates(trigger?: TriggerKind): EffectiveGates;
  /** The aggressiveness level in force (0 cautious … 1 eager). */
  readonly aggressiveness: number;
  /** Change how eagerly GenClass acts (a named level or a number in [0, 1]). */
  setAggressiveness(a: Aggressiveness): void;
  setMode(mode: Mode): void;
  /** Turn GenClass off for this page: releases holds, uninstalls observers; `undo: true` rolls back recent actions. */
  disable(o?: { undo?: boolean }): void;
  /** Counts for this session. */
  summary(): SessionSummary;
  /** Replace the session id and merge tags (later records only). */
  setSession(p: { id?: string; tags?: Record<string, string | number | boolean> }): void;
  readonly breaker: { reset(): void; readonly tripped: boolean };
  /** `clear()` forgets everything learned (profiles, flows) in memory and in storage. */
  readonly learn: { clear(): void };
  /** What GenClass learned about the page: flows per user action and route, recent deviations, relations. */
  learned(): Learned;
  pause(): void;
  resume(): void;
  destroy(): void;
  /** Anonymous diagnostics for this page (InitOptions.telemetry). */
  readonly telemetry?: TelemetryStatus;
  /** Interaction analytics for this page (InitOptions.analytics): whether they are recorded, and the consent switch. */
  readonly analytics?: AnalyticsStatus;
  /**
   * The last `n` measured visual check findings (InitOptions.visual), oldest first; at most 200 are kept. An empty
   * list until the checks have run (or when they are off).
   */
  checks(n?: number): CheckFinding[];
  /**
   * Run a measured visual check pass now (loads the checks if needed; a URL or the option set to off still wins) and
   * resolve with the findings it confirmed. Report-only unless the fix gate allows (InitOptions.visual.fix).
   */
  checkNow(): Promise<CheckFinding[]>;
}
