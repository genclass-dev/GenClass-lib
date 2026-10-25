// Wire and store types of the GenClass MCP bridge (docs/runtime/AGENT.md). The page side is
// @genclass/runtime/agent (packages/runtime/src/agent/*); these types mirror its messages (genclass-agent/1) and its
// recorded schedules (genclass-schedule/1) on purpose, without importing the runtime: the server stays a
// zero-dependency Node package, and everything a page sends is validated here as untrusted input.

export const AGENT_SCHEMA = "genclass-agent/1";
export const SCHEDULE_SCHEMA = "genclass-schedule/1";
export const DEFAULT_PORT = 47357;

export type ScheduleOrder = "natural" | "fifo" | "seeded" | "given";

export interface ScheduleSpec {
  order: ScheduleOrder;
  seed?: number;
  given?: string[];
  focus?: string[];
  delay?: { minMs: number; maxMs: number };
  maxHoldMs?: number;
  gapMs?: number;
  id?: string;
  label?: string;
}

export interface ActStep {
  k: "act";
  i: number;
  t: number;
  kind: string;
  target?: string;
  value?: string;
  key?: string;
  clicks?: number;
  count?: number;
  dur?: number;
}

export type Step =
  | ActStep
  | { k: "send"; t: number; key: string; detail?: string; act?: number; via?: string }
  | { k: "recv"; t: number; key: string; held?: number; forced?: boolean }
  | { k: "end"; t: number; key: string; status: string; code?: number | string }
  | { k: "write"; t: number; store: string; paths: string[]; by?: string; act?: number; summary?: string[] }
  | { k: "error"; t: number; message: string; by?: string; act?: number };

export interface Witness {
  kind: "overwrote-newer" | "identical-in-flight";
  t: number;
  subject: string;
  by: string;
  byDetail?: string;
  over: string;
  overKind: "request" | "user";
  byAct?: number;
  overAct?: number;
  gapMs?: number;
  change?: string;
}

export interface ErrorRec {
  t: number;
  name: string;
  message: string;
  source?: string;
  stack?: string;
  chain: string[];
  act?: number;
}

export interface Snapshot {
  t: number;
  state: Record<string, string>;
  /** Store fields the page left out of `state` (its budget), and how many it had. */
  stateLeft?: number;
  stateTotal?: number;
  text?: string[];
  /** The lines of `text` inside ARIA live regions (announcements: status messages, alerts, toasts). */
  live?: string[];
  fields?: Record<string, string>;
  requests: Record<string, number>;
  witnesses: number;
  errors: number;
  forced: number;
}

export interface DecisionRec {
  id?: string;
  trigger?: string;
  subject?: string;
  diagnosis?: string;
  diagnosisConfidence?: number;
  action?: string;
  confidence?: number;
  executed?: boolean;
  detection?: string;
  reason?: string;
  facts?: string[];
}

export interface ExplainRec {
  message?: string;
  timeline?: string[];
  situation?: string;
  changed?: string;
}

/** Why a run got its schedule. */
export interface Assignment {
  kind: "explore" | "replay";
  /** Explore session id or finding id. */
  ref: string;
  /** Position in the explore plan (0-based) or the replay attempt. */
  index: number;
  label: string;
}

/** One page load connected to the bridge. */
export interface Run {
  id: string;
  /** The page origin that registered it; events from another origin are refused. */
  origin?: string;
  /** A secret the page got at hello and sends with its events (never persisted). */
  token?: string;
  /** Wall-clock ms (the bridge's own clock). */
  started: number;
  lastSeen: number;
  page: { url: string; route: string; title?: string };
  ua?: string;
  runtime?: { mode?: string; model?: string };
  schedule: ScheduleSpec | null;
  assignment?: Assignment;
  steps: Step[];
  /** Steps the page dropped before sending (its buffer is bounded). */
  lost: number;
  order: string[];
  forced: number;
  witnesses: Witness[];
  errors: ErrorRec[];
  detections: { at: number; decision: DecisionRec; explain?: ExplainRec }[];
  interventions: { at: number; action: Record<string, unknown>; explain?: ExplainRec }[];
  checks: { at: number; check: Record<string, unknown> }[];
  expectations: { at: number; expectation: Record<string, unknown> }[];
  /** The latest snapshot at a quiet point (and the page's last one on exit). */
  snapshot?: Snapshot;
  snapshots: number;
  learned?: unknown;
  baselines?: { sig: string; count: number; median?: number; p95?: number; errorRate: number; failStreak: number }[];
  ended: boolean;
}

export type FindingKind = "race" | "stale-write" | "error" | "duplicate-request" | "detection" | "intervention" | "check" | "expectation";

export interface Finding {
  id: string;
  key: string;
  kind: FindingKind;
  /** One line, built by the bridge from recorded fields (page text inside it is quoted). */
  title: string;
  route: string;
  count: number;
  runs: string[];
  first: number;
  last: number;
  /** The replay that reproduces it (a recorded order or an explore seed), when there is one. */
  replay?: ScheduleSpec;
  /** The run to replay from (its steps are the scenario). */
  run?: string;
  evidence: Record<string, unknown>;
  /** Replay results, newest last. */
  replays: { run: string; at: number; reproduced: boolean | null; note: string }[];
}

export interface ExploreSession {
  id: string;
  created: number;
  route?: string;
  plan: ScheduleSpec[];
  next: number;
  runs: string[];
  state: "armed" | "collecting" | "stopped";
  focus?: string[];
  /** "runId|findingKey" pairs already counted, so reporting twice does not count a race twice. */
  counted?: string[];
}

export interface ReplayArm {
  finding: string;
  spec: ScheduleSpec;
  route?: string;
  remaining: number;
  created: number;
  runs: string[];
}
