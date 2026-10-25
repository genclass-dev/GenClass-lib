// What the bench measures: the strategies (one page each), the network profiles, the GenClass conditions and the
// user's behaviour. The server, the runner and the report all read this file, so a number in RESULTS.md always
// matches the setup that produced it.

/** Network profiles. Latency is drawn per request from the run's seed (lib/rng.mjs, server.mjs). */
export const PROFILES = {
  fast: { label: "20 to 60 ms, answered in request order", latency: [20, 60], inOrder: true, failRate: 0 },
  jittery: { label: "50 to 900 ms, any order", latency: [50, 900], inOrder: false, failRate: 0 },
  lossy: { label: "50 to 900 ms, any order, 5% of requests fail", latency: [50, 900], inOrder: false, failRate: 0.05 },
  // real APIs have long tails: one request in ten takes 1.5 to 4 s instead
  tail: { label: "50 to 900 ms, 10% of requests take 1.5 to 4 s, any order", latency: [50, 900], inOrder: false, failRate: 0, slow: { rate: 0.1, latency: [1500, 4000] } },
};

/** The fixes compared. `kind` "search": type a query; "submit": double-click a create button. */
export const STRATEGIES = [
  { id: "a", kind: "search", stack: "React 19", name: "no guard", file: "a-none.tsx", correct: false },
  { id: "b", kind: "search", stack: "React 19", name: "debounce 300 ms only", file: "b-debounce.tsx", correct: false },
  { id: "c", kind: "search", stack: "React 19", name: "ignore flag in useEffect cleanup", file: "c-ignore.tsx", correct: true },
  { id: "d", kind: "search", stack: "React 19", name: "AbortController in useEffect cleanup", file: "d-abort.tsx", correct: true },
  { id: "e", kind: "search", stack: "React 19", name: "request id (sequence counter)", file: "e-seq.tsx", correct: true },
  { id: "f", kind: "search", stack: "TanStack Query 5", name: "useQuery with the term in the key", file: "f-tanstack.tsx", correct: true },
  { id: "g", kind: "search", stack: "SWR 2", name: "useSWR with the term in the key", file: "g-swr.tsx", correct: true },
  { id: "h", kind: "search", stack: "RxJS 7", name: "switchMap", file: "h-rxjs.ts", correct: true },
  { id: "i", kind: "search", stack: "Vue 3.5", name: "watch with onCleanup", file: "i-vue.ts", correct: true },
  { id: "j", kind: "search", stack: "Svelte 5", name: "$effect with AbortController", file: "j-svelte.ts", correct: true },
  { id: "k", kind: "submit", stack: "React 19", name: "no guard", file: "k-none.tsx", correct: false },
  { id: "l", kind: "submit", stack: "React 19", name: "button disabled while pending", file: "l-disabled.tsx", correct: true },
  { id: "m", kind: "submit", stack: "React 19", name: "idempotency key checked by the server", file: "m-idempotency.tsx", correct: true },
  { id: "n", kind: "submit", stack: "TanStack Query 5", name: "useMutation, disabled while isPending", file: "n-mutation.tsx", correct: true },
];

/**
 * GenClass conditions. "off": no GenClass on the page. The others add the one script tag, first in <head>, in observe
 * mode with telemetry off (window.GENCLASS_CONFIG); the model is served from this machine.
 */
export const CONDITIONS = {
  off: { label: "no GenClass", gc: null },
  model: { label: "GenClass observe, model 0.2.0 at the default profile (balanced)", gc: "model" },
  skipped: { label: "GenClass observe, model skipped (loadIf false)", gc: "skipped" },
};

/** Search queries: two words, as people refine a search. */
export const QUERIES = [
  "react query", "vue router", "svelte store", "date picker", "form schema", "state machine", "virtual list",
  "drag drop", "http client", "css modules", "web socket", "image crop", "rich text", "color picker", "test runner",
  "file upload", "auth token", "chart axis", "toast queue", "markdown parser",
];

/** The user's behaviour. Every value is drawn from the run's seed (run.mjs). */
export const USER = {
  keyDelayMs: [60, 150], // between keystrokes
  wordPauseMs: [150, 1200], // after the first word, before the space: the user glances at the first results
  doubleClickGapMs: [0, 150], // between the two clicks of a double submit
};

/**
 * When a run is over: nothing in flight, no new request and no change on the page for this long, and nothing on the
 * page marked aria-busy (a library waiting to retry keeps its loading state, so the run waits for the retry).
 */
export const SETTLE_QUIET_MS = 1000;
/** At most this long after the last keystroke or click. */
export const SETTLE_CAP_MS = 15000;

/** Diagnoses that name a race (the bugs measured here); the others name network trouble. */
export const RACE_DIAGNOSES = ["stale", "duplicate", "conflict", "inconsistent"];
