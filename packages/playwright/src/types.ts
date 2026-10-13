// Shared shapes of @genclass/playwright: the fixture options, what one test attaches (the `genclass` attachment,
// JSON) and what the reporter builds from those attachments. Everything here is JSON-serialisable: the fixture
// writes it with JSON.stringify, the reporter reads it back in another process.

import type { AuditEntry, EffectiveGates, Mode, ModelStatus, SessionSummary } from "@genclass/runtime";

/** Network chaos applied with page.route to the requests that match `routes`. */
export interface ChaosOptions {
  /** Added latency per matched request: one number, or [min, max] ms picked uniformly. Default 0. */
  latencyMs?: number | [number, number];
  /**
   * Let a newer request of the same method and path land before an older one still in flight: the older response
   * is held until just after the newer one (the classic stale-response race). Default false.
   */
  reorder?: boolean;
  /** Probability in [0, 1] that a matched request is answered with `failStatus` instead of reaching the server. Default 0. */
  failRate?: number;
  /** HTTP status of injected failures. Default 503. */
  failStatus?: number;
  /** Which requests chaos applies to: regular expressions (or `*` globs as strings) tested against the full URL. Default [/\/api\//]. */
  routes?: (RegExp | string)[];
  /** Seed of the chaos random stream, so a run can be replayed. Default: derived from the test title. */
  seed?: number | string;
}

export interface GenClassOptions {
  /** Mode of the injected runtime. Default "observe" (reports only, never holds or changes anything). */
  mode?: Mode;
  /**
   * "inject" (default): an init script puts the script-tag build of @genclass/runtime on every page before the
   * page's own scripts run. "app": the app already installs GenClass itself; nothing is injected and the runtime is
   * read from `handle`.
   */
  install?: "inject" | "app";
  /**
   * Where the injected build comes from. "cdn": jsDelivr, pinned to the installed @genclass/runtime version.
   * "local" (default): the installed @genclass/runtime package's own dist/, served through Playwright routing under
   * the same CDN URLs, so the runtime itself needs no network. A path: another checkout of the package (its root
   * directory, containing dist/). The model and ONNX Runtime still come from jsDelivr unless `config.model` says
   * otherwise.
   */
  runtime?: "cdn" | "local" | string;
  /**
   * Where to find the runtime on the page, as dotted paths from `window`, tried in order. The defaults
   * ("GenClass.runtime", the script-tag build; "__genclass") are always tried after yours. For an ESM install,
   * expose it in your app: `window.__genclass = GenClass.init(...)`.
   */
  handle?: string | string[];
  /** Chaos for the requests that match `chaos.routes`. `true` = { latencyMs: [50, 800], reorder: true, failRate: 0.05 }. Default off. */
  chaos?: ChaosOptions | boolean;
  /** Extra InitOptions for the injected runtime (window.GENCLASS_CONFIG): `model`, `requests`, `policy`, ... */
  config?: Record<string, unknown>;
  /** How long the fixture waits at the end of a test for decisions still in flight: quiet for `quietMs`, at most `maxMs`. */
  settle?: { quietMs?: number; maxMs?: number };
  /** Attach the collected JSON to the test (default true). The reporter needs it. */
  attach?: boolean;
  /** Add a one-line `genclass` annotation per test (default true). */
  annotate?: boolean;
}

export interface ResolvedChaos {
  latencyMs: [number, number];
  reorder: boolean;
  failRate: number;
  failStatus: number;
  routes: RegExp[];
  seed: number | string | null;
}

export interface ResolvedOptions {
  mode: Mode;
  install: "inject" | "app";
  runtime: "cdn" | "local" | string;
  handle: string[];
  chaos: ResolvedChaos | null;
  config: Record<string, unknown>;
  settle: { quietMs: number; maxMs: number };
  attach: boolean;
  annotate: boolean;
  /** Options that were ignored or corrected, in words; they end up in the report. */
  warnings: string[];
}

export interface ChaosStats {
  matched: number;
  delayed: number;
  failed: number;
  reordered: number;
}

/** A decision as the fixture copies it out of the page (Decision minus answers and probabilities). */
export interface DecisionSnapshot {
  id: string;
  trigger: string;
  subject: string;
  at: number;
  diagnosis: string;
  diagnosisConfidence: number;
  action: string;
  confidence: number;
  executed: boolean;
  ran: string;
  tier: string;
  reason?: string;
  candidate?: string;
  effectiveMode?: string;
  latencyMs: number;
  facts: string[];
  /** rt.explain(id).message: the console line with the evidence (absent when the runtime no longer keeps it). */
  message?: string;
  timeline?: string[];
}

/** An action that ran (rt.interventions()), minus its undo function. */
export interface ActionSnapshot {
  id: string;
  decisionId: string;
  action: string;
  tier: string;
  trigger: string;
  subject: string;
  at: number;
  ok: boolean;
  error?: string;
  changed: string;
  late?: boolean;
  dropped?: string[];
}

/** What the fixture reads from the runtime on the page at the end of a test. */
export interface RuntimeSnapshot {
  /** The dotted path the runtime was found at. */
  handle: string;
  href: string;
  title: string;
  mode: Mode;
  status: ModelStatus;
  gates: EffectiveGates | null;
  summary: SessionSummary | null;
  audit: AuditEntry[];
  decisions: DecisionSnapshot[];
  interventions: ActionSnapshot[];
}

/** The `genclass` attachment of one test (contentType application/json). */
export interface GenClassAttachment {
  schema: 1;
  package: string;
  runtimeVersion: string;
  test: { title: string; titlePath: string[]; file: string; line: number };
  options: { mode: Mode; install: "inject" | "app"; runtime: string; handle: string[] };
  /** install "inject": whether the init script managed to put the runtime on the last page (and why not). */
  injected: { ok: boolean; error?: string } | null;
  chaos: (ChaosStats & { latencyMs: [number, number]; reorder: boolean; failRate: number; seed: number | string }) | null;
  /** "[GenClass] Model ready" console lines seen in this test: more than one per page load means two runtimes. */
  modelReadyLines: number;
  warnings: string[];
  runtime: RuntimeSnapshot | null;
}

/** State of the model as reported by ready(): the runtime's ModelStatus.state, or why there is none. */
export type ReadyState = ModelStatus["state"] | "missing" | "timeout";

/** The value of the `genclass` fixture inside a test. */
export interface GenClassSession {
  readonly options: ResolvedOptions;
  /** Chaos counters so far (null when chaos is off). */
  readonly chaos: ChaosStats | null;
  /**
   * Waits until the runtime is found on the page and its model has finished loading (ready, or a terminal state:
   * error, skipped, off, disabled, unloaded). Resolves "missing" when no runtime appears within `timeout` ms
   * (default 120 s) and "timeout" when one did but its model never settled. Never throws.
   */
  ready(opts?: { timeout?: number }): Promise<ReadyState>;
  /** Waits until the audit trail and in-flight operations have been quiet for `quietMs` (defaults: the fixture's `settle` option). Never throws. */
  settle(opts?: { quietMs?: number; maxMs?: number }): Promise<void>;
  /** The runtime's state right now, or null when GenClass is not on the page. Never throws. */
  snapshot(): Promise<RuntimeSnapshot | null>;
}
