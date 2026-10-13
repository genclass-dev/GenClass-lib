# @genclass/runtime API reference

GenClass Runtime watches a web app from the inside (user actions, async operations, network, state changes,
errors, timing and causality) and asks a small local model, running in the browser, about situations that look
risky. Depending on the mode it reports what it saw, or prevents the failure with a minimal, reversible action.

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init();                          // observe mode, local model, console reports
const cart = rt.atom("cart", { items: [], total: 0 }); // state GenClass can protect
```

Contents: [init and modes](#init-and-modes) · [options](#options) · [state](#state) ·
[operations and user actions](#operations-and-user-actions) · [questions](#asking-the-model) ·
[events](#events) · [introspection](#introspection-and-control) · [triggers and actions](#triggers-and-actions) ·
[policy](#policy) · [reports](#reports-explain-and-undo) · [plugins](#plugins) · [headless use](#headless-use-tests-ssr-simulation) ·
[adapters and devtools](#adapters-and-devtools) · [types](#types)

## Init and modes

```ts
GenClass.init(options?: InitOptions): Runtime   // idempotent: a second call returns the same runtime
GenClass.runtime: Runtime | null
GenClass.destroy(): void                        // uninstall observers, restore globals, terminate the model worker
GenClass.protect: typeof protect                // the same as the named export below (0.3.0: not in 0.2.x)

// named exports (0.3.0: not in 0.2.x)
protect<F extends (...args: never[]) => unknown>(name: string, fn: F): F   // see "Protected functions"
TOKEN_PATTERN: RegExp                           // /^gc_[A-Za-z0-9]{22}$/
isValidToken(v: unknown): v is string
```

| mode | what it does |
|---|---|
| `observe` (default) | Watches and reports detections. Never changes execution: nothing is held, no action runs. |
| `guard` (opt-in) | Also takes *guard-tier* actions at very high confidence: `discard`, `defer`, `coalesce`, `delay`. These withhold, deduplicate or slow something down; they never invent data or fail a request. |
| `heal` (experimental) | Also takes *heal-tier* actions: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`, plugin actions. |

Kill switch, for "is my app broken or did GenClass change something?":

- `?genclass=off` in the page URL, or `localStorage.genclass = "off"`: `init` installs nothing and logs one line.
- `?genclass=observe|guard|heal`: overrides the mode, within limits (`src/index.ts` -> `initUnsafe`; a missing
  `mode` counts as `guard` there): `observe` always; `guard` when no mode, `guard` or `heal` is configured (the
  default `/auto` and script tag included, not `/auto/observe`); `heal` only when `heal` is configured, or with
  `debug: true`.

Outside a browser (no `window`/`document`, e.g. SSR), `GenClass.init()` returns an inert runtime: no observers,
no model. Use [`createRuntime`](#headless-use-tests-ssr-simulation) for headless work.

**Telemetry (privacy-relevant).** In a browser on a public host, `GenClass.init()` sends anonymous diagnostics
(decisions, action outcomes, detections, model status and counts; no page text unless
`telemetry: { include: { situation: true } }`) to `DEFAULT_TELEMETRY_ENDPOINT` and prints one console notice per
page. Off with `telemetry: false`, `?genclass=no-telemetry` (or `?genclass=off`),
`localStorage["genclass.telemetry"] = "off"`, or Global Privacy Control; off by default on localhost and private
hosts (`0.2.1` sends from them too, by mistake; fixed in `0.2.2`), outside a browser and in
`createRuntime()`. An explicit `telemetry: true` also sends from local hosts. Schema and details:
[packages/runtime/TELEMETRY.md](../../packages/runtime/TELEMETRY.md).

**App token and dashboard** (0.3.0: `0.2.x` ignores `token`). `token: "gc_..."` (from
`npx @genclass/runtime init` or https://genclass.dev/start) is sent with each telemetry batch so the app's diagnostics
show up on its private dashboard (`https://genclass.dev/dashboard/<secret>`); with a token, decision events also
carry `fn` (see "Protected functions"). Public; malformed values log one warning and are ignored; it does nothing
while telemetry is off (on a local host the console says so once). `rt.telemetry.token` reports it while telemetry
is on. `token` and `scope` are fixed when GenClass starts: on a runtime already started by `/auto` or the script tag,
`GenClass.init({ token, scope })` is ignored with one console warning (set them in `window.GENCLASS_CONFIG`, the meta
tag or `data-token` / `data-scope`).

## Options

```ts
interface InitOptions {
  mode?: "observe" | "guard" | "heal";                 // default "observe"; "guard" is opt-in, "heal" experimental
  model?: {                                             // or false: no model (observe only)
    baseUrl?: string;                                   // directory with model.json (default: jsDelivr CDN)
    device?: "auto" | "webgpu" | "wasm";                // default "auto"
    worker?: boolean;                                   // default true
    preload?: "eager" | "idle" | "lazy";                // default "idle"
  } | false;
  decider?: DecisionProvider | null;                   // bring your own decision provider instead of the model
  report?: "console" | "silent" | ((r: Report) => void); // default "console"
  observe?: Partial<Record<"fetch"|"xhr"|"user"|"errors"|"nav"|"storage"|"perf"|"websocket"|"eventsource"|"timers"|"untrustedEvents", boolean>>;
                                                        // untrustedEvents (default false): record synthetic DOM events (isTrusted false) as user actions (test harnesses)
  triage?: "salient" | "always";                        // default "salient"
  detect?: "likely" | "possible";                       // (0.3.0) which detections are reported; default "possible" in observe
                                                        // without policy.thresholds.report, else "likely" (see "Reports, explain and undo")
  policy?: PolicyOptions;                               // see Policy
  redact?: (path: string, value: unknown) => unknown;   // default: values whose leaf field names a secret (password, token, card number, cvv, ssn, iban, ...); never a whole store by its name
  plugins?: Plugin[];
  historySize?: number;                                 // events kept, default 500
  debug?: boolean;                                      // console.debug every decision
  learn?: LearnOptions;                                 // learned state and flow expectations; see "Learned flows and expectations"
  aggressiveness?: "cautious" | "balanced" | "eager" | number; // how eagerly to act (default "balanced"; see Policy)
  vocabulary?: { diagnoses?: Record<string, string>; actions?: Record<string, string> };
  settleMs?: number;                                    // quiet time that makes a settled point, default 60
  situation?: { budget?: number | "auto" };             // size of what the model reads, in characters (default "auto")
  telemetry?: boolean | {                               // anonymous diagnostics (TELEMETRY.md); default: on in GenClass.init in a browser, else off
    endpoint?: string;                                  // [DEFAULT_TELEMETRY_ENDPOINT]
    sample?: number;                                    // [1] fraction of page loads that send
    flushMs?: number;                                   // [10000] batch interval; also sent on pagehide / hidden tab (sendBeacon)
    maxBatch?: number;                                  // [100] events per request (requests also ≤ 60 KB)
    include?: { situation?: boolean };                  // [false]; true: include the redacted situation text
    decisionSample?: number;                            // [0.25] share of routine decisions (top diagnosis "expected", nothing acted) whose record is sent; every other decision always; counts exact
    maxDecisions?: number;                              // [200] most routine decisions' records per page load (Infinity: no cap); detections are never capped; summaries continue
    transport?: { send(url: string, body: string, o: { beacon: boolean }): void | Promise<unknown> }; // tests / custom pipelines; a rejection with `status` 429 or `retryAfterMs` is a back-off (0.3.0)
  };
  autoState?: boolean | { react?: boolean; redux?: boolean; zustand?: boolean; pinia?: boolean };
                                                        // automatic state discovery: default on in @genclass/runtime/auto* and the script tag,
                                                        // off in GenClass.init / createRuntime (there it needs import "@genclass/runtime/discover" first)
  token?: string;                                       // (0.3.0) app token, gc_ + 22 letters/digits: groups telemetry under your private dashboard
  scope?: "app" | "functions";                          // (0.3.0) ["app"]; "functions": decisions and standing questions only for activity inside protect()ed functions (rt.ask() still answered)

  // batch 12 (docs/runtime/OPTIONS-SPEC.md); defaults in brackets
  enabled?: boolean | (() => boolean | Promise<boolean>) | { get(): boolean | Promise<boolean>; subscribe?(cb: () => void): () => void };
                                                        // [true]; false: nothing installed, model never downloaded; a predicate/source forces preload "lazy"
  sample?: number;                                      // [1] fraction of sessions that act (stable per session); the rest observe
  routes?: { match: string | RegExp | ((route: string) => boolean); mode?: Mode | "off"; aggressiveness?: Aggressiveness }[];
                                                        // first match wins; demote only
  requests?: {
    ignore?: RequestMatcher[];                          // not observed at all (native pass-through)
    protect?: (RequestMatcher | `preset:${string}`)[];  // observed, never held/retried/cached/discarded, nor what its response causes;
                                                        // a throwing predicate = protected; "preset:payments" / "preset:auth" = protectPreset(...)
    crossOrigin?: "observe" | "ignore";                 // ["observe"]; cross-origin is always passive
    labels?: { match: RequestMatcher; label: string }[];// names for reports/sinks ([A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars)
    labelsToModel?: boolean;                            // [false] labels appear in situation text only when true
    correlate?: (r: { url: string; method: string; headers: Record<string, string> }) => string | undefined; // redacted, ≤ 128 chars
  };
  breaker?: { undos?: number; errorsAfterAction?: number; attributionMs?: number; windowMs?: number; downgradeTo?: "observe" | "guard"; persist?: "session" | false } | false;
                                                        // [{2, 3, 5000, 600000, "observe", "session"}]
  shadow?: "guard" | "heal" | false;                    // [false] dry-run gate at a higher mode; Decision.shadow, "shadow" event
  onBeforeAction?: (a: ActionRequest) => boolean | void;// final sync veto (false or throw); counts against the hold budget
  vetoMode?: "enforce" | "report";                      // ["enforce"]; "report" records would-veto and runs the action
  sinks?: (SinkFn | { send: SinkFn; kinds?: SinkKind[]; sampleRate?: number; evidence?: boolean; possible?: boolean; flush?(): Promise<void> })[];
                                                        // possible (0.3.0) [false]: also "possible" detections
                                                        // adapters: @genclass/runtime/sinks ("See it where you already look" below)
  session?: { id?: string; tags?: Record<string, string | number | boolean> }; // never shown to the model
  audit?: { size?: number; sink?: (e: AuditEntry) => void }; // [1000 kept in memory] the audit trail (rt.audit()); sink: your own logging
  redact?: (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown; // runs after built-in redaction; a throw → "[redacted]"
  report?: "console" | "interventions" | "silent" | ((r: Report) => void);    // "interventions": console prints interventions, undos, breaker only
  learn?: { persist?: boolean | "local" | "session"; key?: string; version?: string; maxBytes?: number; // persist [unset: profiles in memory; flows in localStorage when expectations are on; true/"local"/"session": both; false: nothing]; key ["genclass:learn"]; version [session.tags.release]: mismatch discards; maxBytes [200000]
            expectations?: boolean; minSupport?: number; minShare?: number; minSessions?: number }; // [false: opt-in until its false-report rate is measured], [8 in one page load, 20 with stored counts], [0.95], [3 with localStorage, else 1] (docs/runtime/EXPECTATIONS.md)
  // model: also loadIf [{ minDeviceMemoryGB: 4, saveData: "skip" }: no model on devices reporting ≤ 2 GB or on Save-Data; () => true forces],
  //        inlineFallback [true; false: a failed worker means no model, never the main thread], threads ["auto"], timeoutMs [10000],
  //        maxDecisionsPerMinute [30], unloadAfterIdleMs [false]
}
```

Runtime additions: `rt.audit(n?)` (the audit trail, below), `rt.disable({ undo? })` (permanent; `undo: true` rolls back the last minute's actions),
`rt.summary(): SessionSummary` (0.3.0: `possibleDetections` per diagnosis next to `detections`, the likely ones), `rt.setSession({ id?, tags? })`, `rt.breaker.{tripped, reset()}`, `rt.learn.clear()`,
`rt.learned()` (below), events `shadow`, `breaker`, `limit`, `modelBudget`, `expectation`. `status` adds `effectiveMode`, `sampled`, `breaker`, `scope`,
`modelBudget`, and states `"disabled" | "skipped" | "unloaded"`. `status.scope` is what is in force on the current
route: `mode` is the effective mode there (equal to `effectiveMode`: the requested mode demoted by sampling, the breaker
and the matching `routes[]` rule) and `aggressiveness` the effective level; with a matching rule it also has `rule`
(its index) and `ceiling` (the mode that rule caps the route at; rules only lower the mode). Before 0.2.0,
`scope.mode` was that ceiling ("heal" when no rule matched). `rt.gates()` carries `mode` (the same effective mode).
`status.blocked` (state "error"): `{ url, origin, csp, directive? }` when the browser blocked a model or ORT download.
`status.sha256` (state "ready"): the sha256 from `model.json` that the loaded variant was verified against.
`status.reason` (state "skipped", since 0.3.0): `"device-memory"`, `"save-data"` or `"loadIf"` when `model.loadIf`
kept the model from loading on this device (the default is the exported `DEFAULT_LOAD_IF`,
`{ minDeviceMemoryGB: 4, saveData: "skip" }`), and `"worker-unavailable"` when the model worker could not start and
`model.inlineFallback` is `false` (`status.workerError` says why). The runtime keeps observing without a model and
prints one console line either way.

Gate order (each request/decision): protected → cross-origin → op scope (created under off/observe) →
mode/allow/deny/requireDiagnosis (at the effective mode) → thresholds → `policy.actionLimits`
(`limit:perMinute|perSubject|perSession`; defaults 60/min global, 10/min per subject, 200 per session) → `onBeforeAction` (`vetoed`, `would-veto`, or
`limit:hold` past the budget) → execute. effectiveMode = min(mode, sample cap, breaker cap, route rule); URL overrides
(`?genclass`, `?genclass-mode`, `?genclass-aggr`, `?genclass-sample`, `localStorage.genclass`) only demote, from the
app's mode or from `observe` when it sets none; they may raise only with `debug: true` or on a development host
(`localhost`, `*.local`, `*.test`, private networks). Before 0.2.2, `?genclass=guard` opted a visitor into guard when
the app set no mode. `policy.holdBudgetMs` is a hard ceiling that includes defers, the
wait for a response or request body, a held write's deferred re-decisions and the veto hook.

Protected requests (`requests.protect`) are never held, never wait for their body to be read, and neither they nor
anything their response callbacks cause (writes, timers, follow-up requests: the ops inherit the protection) are
acted on. Presets for money and identity flows: `import { protectPreset, PROTECT_PRESETS } from "@genclass/runtime"`;
`protectPreset("payments", "auth")` returns fresh RegExps (`payments`: checkout, payment(s), payment intents, billing,
invoices, charges, refunds, subscriptions, orders, purchases, transactions, transfers, payouts, wallets, Stripe,
PayPal, Braintree, Adyen, Klarna, Square; `auth`: login/logout, sign-in/up/out, register, oauth, tokens, sessions, SSO,
SAML, OIDC, MFA, 2FA, OTP, passwords, verify). Recommended for payment, checkout and sign-in flows in every mode
(packages/runtime/INTERCEPTION.md, "Money and identity flows"). Hidden tabs release held items unevaluated; in
guard and heal they skip background evaluation, and in observe (0.3.0) each salient situation is built at once and
decided when the tab is visible again (at most 32 wait; OPTIONS-SPEC §5.1, §5.3).

Performance: GenClass computes cheap facts for every write and request, and asks the model only about salient ones.
The situation the model reads is sized to the device (`situation.budget: "auto"`): 2,400 characters (about 1,000
tokens) on WebGPU, 2,000 on 4-thread WASM (crossOriginIsolated pages), 1,000 on single-thread WASM; at 1,400
characters or less the questions are compact (bare diagnosis labels and action names). State writes are never held
by default. Held responses, messages and requests wait at most the hold budget (`policy.holdBudgetMs: "auto"`: 1.5 ×
the model's recent median latency, 150 to 800 ms), then proceed unchanged; nothing is held when the model is not
expected to answer within that budget. Serving your page with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` enables WASM threads (about 3× faster without WebGPU).

Self-hosting the model: `npx @genclass/runtime fetch-model public/genclass-model` then
`GenClass.init({ model: { baseUrl: "/genclass-model/" } })`.

## State

GenClass protects state it can see. Register stores with `atom` (owned by GenClass), `guard` (owned by you) or an
adapter (Redux, Zustand, React hooks).

**Automatic state discovery** (`autoState`, on with the one line: `import "@genclass/runtime/auto"` or the script tag)
finds React component state (`useState`, `useReducer`, `useSyncExternalStore`, class state; through the React
DevTools hook), Redux / Redux Toolkit stores (through the Redux DevTools compose and enhancer globals) and Zustand
`devtools` stores (through the Redux DevTools `connect` API; Zustand disables `devtools` in production builds unless
`enabled: true` is passed, so such builds are not discovered). Each write is recorded with the operation that made it.
Discovered Redux stores get the Redux adapter (controllable, kind `adapter`). Discovered React and Zustand state is
**observed only** (kind `observed`): it feeds facts, triage, detections and delivery decisions (`deliver` / `defer`),
but GenClass never holds, drops, reverts or rolls back its writes, so `discard` and `rollback` are not offered for it.
React stores are named after the component (`SearchPage.state0`, `SearchPage.external0`, class state keys; in
production builds after the element the component renders). Opt out with `autoState: false` or
`<meta name="genclass" content="autostate=off">`; `?genclass=off` installs nothing. With `GenClass.init`, import
`@genclass/runtime/discover` before React / Redux / Zustand and pass `autoState: true`.

```ts
rt.atom<T>(name: string, initial: T, opts?: StoreOptions<T>): Atom<T>
rt.guard<T>(name: string, io: { get(): T; set(v: T): void; subscribe?(fn: () => void): () => void }, opts?): Guarded<T>
rt.expect(name: string, predicate: () => boolean): () => void   // developer invariant, checked at settled points

interface Atom<T> {
  readonly name: string;
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  update(fn: (prev: T) => T): void;
  subscribe(fn: (v: T) => void): () => void;
}
interface StoreOptions<T> {
  resync?: () => Promise<unknown> | unknown;   // "reload this store from its source": enables the resync action
  hold?: boolean;                              // default true; false: writes are never held
  describe?: (v: T) => string;                 // one-line description used in situations
}
```

```ts
const search = rt.atom("search", { query: "", results: [] as Item[] }, {
  resync: async () => search.set({ ...search.get(), results: await api.search(search.get().query) }),
});
input.oninput = () => search.set((s) => ({ ...s, query: input.value }));   // user write: applied at once
const res = await fetch(`/api/search?q=${q}`);                          // a stale response may be held briefly
search.set((s) => ({ ...s, results: data }));                           // applied at once (stale fields may be dropped)
```

How writes flow: GenClass decides at the network boundary and enforces synchronously at the store. A response
(fetch or XHR) or a pushed message (WebSocket, EventSource) is checked before the app sees it: GenClass predicts
which fields it will write (from what the same operation wrote before) and consults the model only when it would
overwrite newer data (an operation that started later already wrote it, and no newer request of the same kind is
still on its way), put back the value of an unconfirmed local change (a user action's optimistic write whose own
request is still in flight), or replace text the user typed meanwhile. The model may let it through (`deliver`), let it
through but drop the writes it makes over newer data (`discard`: each later `set()` of that response's chain applies
its other fields and skips those), or hold it until the related requests finish and decide again (`defer`). Holding
only adds latency; messages of one socket or stream keep their order. Before asking, it reads the response (a
clone, ≤ 256 KB of JSON) and compares it with the store: a response that equals the current values changes nothing and is let through without
a model call. The situation then says what the response would do: put back a value a newer operation replaced (per
field, or per item cell of a list joined by id), replace text the user typed since the request started (with a
preview centred on the difference), or reload a list without the item a recent create returned.

`set()` always applies at once (`set(x); get()` returns x) and notifies subscribers; writes to one store apply in the
order they were made. A write that looks wrong on its own (not covered by a delivery decision) is decided in the
background: if the model answers `discard` within 2 s after the write applied, nothing has overwritten it and the
same operation made no other write since, GenClass reverts exactly that write (a "late revert", reported as such and
undoable).

`policy.holdWrites: true` (opt-in) holds salient writes until the model answers (at most the hold budget): a later
write to the same store first applies the earlier held ones in order, and `get()` inside the writing operation
returns the pending value. An updater that changes the stored value in place never changes live state before the
decision (GenClass works on a detached copy, or applies at once when it cannot restore the live value exactly); a
functional update runs again on the value at apply time; a held value write is re-applied as a patch of the fields
it changed. Reads that bypass GenClass (a Redux middleware's `store.getState()`) do not see held writes: keep
`holdWrites` off for such stores or pass `hold: false`.

GenClass also learns, at *settled* points (no requests in flight, `settleMs` of quiet), generic relations between
your fields (`a == b` for fields with related names, `a == len(B)`, `a == sum(B[*].f)`, `a == sum(B[*].f * B[*].g)`,
`a == count(B[*].k == v)`, `a >= 0`, `a ∈ B[*].k`, `B[*].id unique`, stable types, non-null) and each operation's usual
effects on state (after about 20 completions of the same operation; kept between visits only with `learn.persist`, see below). When a learned
relation breaks, or an operation changes state unlike it normally does, the model is
consulted. To avoid false alarms on correct apps: a selection holding 0, -1, "" or null means nothing is selected;
uniqueness is only learned for id columns; pagination metadata (page, offset, limit, cursor, and a total next to them)
never enters a relation; stores you are typing into are checked once typing pauses for a second; counters that change
on nearly every write are left out unless they are a learned sum or count of a list.

### Learned flows and expectations

**Opt-in in 0.3.0** (`learn: { expectations: true }`): off by default until its false-report rate on correct apps is
measured (docs/runtime/RESULTS.md, "Flow expectations"). Off, nothing below is learned, stored or reported, and its
code (`src/learn/flows.ts`) is never loaded; on, the runtime imports it on the next task after init (a 0 ms timer on
the injected clock; a lazy chunk, so it adds nothing to the first load) and learns from then on.

For every user action on a route (a click, a submit, a change, Enter; never typing) GenClass learns which requests it
starts and how soon, which request follows which, what each response writes, where the page navigates and how long
the flow takes to settle. Once a step was seen in at least 95% of 20 or more observations spread over 3 or more
visits (with the default persistence; 8 or more observations in one page load when nothing is stored:
`learn.minShare`, `learn.minSupport`, `learn.minSessions`), a flow in which it did not happen is reported:

```
[GenClass] Expected a request on /cart: clicking button "Add to cart" usually sends POST /api/cart (41 of 41 times across 6 sessions, within 0.4 s); this time nothing was sent in 2.0 s.
[GenClass] Expected a follow-up on /checkout: after POST /api/orders completes, clicking button "Place order" usually sends GET /api/orders (40 of 41 times, within 0.1 s); this time nothing followed in 1.0 s.
[GenClass] Expected a state change on /cart: the response to POST /api/cart after clicking button "Add to cart" usually writes cart.items (41 of 41 times); this time it wrote nothing.
[GenClass] Expected a navigation on /checkout: clicking button "Place order" usually leads to /confirmation (41 of 41 times, within 1.2 s); this time the page stayed on /checkout for 3.0 s.
[GenClass] Expected a response: GET /api/items usually answers within 0.4 s (p99 of the last 64; 20 of 20 recent requests answered); this one has been waiting 2.1 s (bound 1.0 s).
```

These are deterministic reports from learned counts: the model is not consulted and nothing is held, retried or
changed in any mode. Only a request that changes data (not GET, HEAD or OPTIONS) is expected to start or to write
after its answer; a step is checked only on the branch of the handler it was learned on (the same fields written, so
a submit that showed a validation error and sent nothing is not a gap); a repeat of the action within a page load is
held to what earlier repeats did. They are skipped while the page is hidden or offline or the runtime is paused, for
requests under `requests.protect`, for answers with status 400 or above, for the second click of a double click, for
disabled controls, and for an action repeated while its flow is still open. Deadlines come from the learned delays
(twice the p95, at least 1 s; a response needs twice the p99, at least 1 s, and the third visit with persistence). A
step reported missing is not expected again until it is seen again, so an app whose behaviour changed gets one line,
not one per visit, and a flow's counts are halved at 64 observations, so what the app does now outweighs what it did
long ago. The counts are illustrations of the format, not measurements. Design, false-positive controls and what v2
may do with them: [EXPECTATIONS.md](EXPECTATIONS.md).

```ts
rt.learned(): Learned                 // { route, expectations, session, flows: LearnedFlow[], deviations: Expectation[], relations }
rt.on("expectation", (e: Expectation) => void)   // also a Report of kind "expectation" (report option, "report" event, sinks)
GenClass.init({ learn: { expectations: true } })  // opt in (default false: learn and report nothing of this)
```

**Sinks.** An `expectation` record reaches a sink that forwards every kind (a function, `{ send }` without `kinds`,
the webhook and console-json adapters) only while the layer is on; the Sentry, PostHog and Datadog adapters leave it
out of their default kinds (add `"expectation"` to `kinds` to forward it).

**Persistence.** With `learn.expectations` on, the learned flows (they only produce reports) are kept per origin in `localStorage` by default;
transition profiles, which the model reads, stay in memory unless `learn.persist` is set (`true` or `"local"`:
both in `localStorage`; `"session"`: both in sessionStorage; `false`: nothing is stored). Nothing is stored by
default in a DOM test environment (jsdom, happy-dom) or when storage does not work. The value lives under
`learn.key` (`genclass:learn`), is discarded when its format, the runtime version or `learn.version` (default
`session.tags.release`) changes, is capped at `learn.maxBytes` (200,000 characters; the most-used flows and largest
profiles are kept, and only the stored copy is trimmed), is written 5 s after a change, when the page is hidden or
unloads and on `rt.destroy()`, and is cleared by `rt.learn.clear()`. A tab's sessionStorage keeps its session
ordinal (`genclass:learn:session`), so a reload is not a new visit. It holds request signatures, routes and field
names (id-like path segments and keys normalised, other segments and map keys as they are, secret-named fields
never), counts and delay samples; user action labels are stored only as hashes, and values never. The devtools
overlay shows what was learned under its **Expectations** tab.

## Operations and user actions

The DOM, fetch, XHR, WebSocket and timers are observed automatically. These entry points cover anything else:

```ts
rt.op<T>(name: string, fn: () => Promise<T> | T, meta?: Record<string, unknown>): Promise<T>   // a named async task
rt.user<T>(action: UserAction, handler?: () => T): T | undefined   // a user action (cause of what follows)
rt.emit(name: string, data?: Record<string, unknown>): void        // a custom event in the timeline
rt.reportError(error: unknown, info?: { source?: string }): void   // a handled error worth knowing about

interface UserAction { kind: "click"|"type"|"change"|"submit"|"key"|"nav"|string; target?: string; value?: string; key?: string; sensitive?: boolean; clicks?: number /* MouseEvent.detail */ }
```

```ts
await rt.op("loadProfile", async () => profile.set(await (await fetch("/api/me")).json()));
rt.user({ kind: "click", target: 'button "Sync"' }, () => startSync());
```

The DOM observer describes the element the user actually interacted with, also inside open shadow roots (Lit,
custom elements): `button "Send reply"`, `select "Status"`. Names come from `aria-label`, `aria-labelledby`, the
label (its own text, without the options or values of controls nested in it), rendered text (following slots),
placeholder, title, name, or the custom element host's `label`/`aria-label`.

Causality is tracked through `await` on a best-effort basis: the operation that is running is "ambient" while a
user handler or `rt.op` body runs, after a fetch/XHR settles and when its body (`json()`, `text()`, ...) is read,
and inside timers scheduled during an operation; it is cleared at the end of the task. Writes record the ambient
operation as their cause; operations started while another is ambient get it as their parent.

### Protected functions

0.3.0 (not in `0.2.x`).

```ts
import { GenClass, protect } from "@genclass/runtime";
GenClass.init({ token: "gc_...", scope: "functions" });

const submitOrder = protect("checkout submit", async (cart: Cart) => { /* fetch, writes, ... */ });
```

`protect(name, fn)` returns a function with `fn`'s signature. Each call runs as a `"task"` operation named `name`
(like `rt.op`), so what it starts is linked to it, and decisions about that carry `Decision.fn = name` (the
outermost protected function when they nest; also `fn` on telemetry `decision` events when a token is set, as
`"[redacted]"` when the label looks like data: an e-mail address, a URL, 4+ digits in a row, 12+ hex digits). `this`, arguments, return
value and thrown errors pass through; a sync function stays sync; an async function's promise is replaced by one
that settles the same way; other thenables are returned untouched. It looks up `GenClass.runtime` on every call and
calls `fn` directly when there is none. It never throws on its own. With `scope: "functions"` everything is still
recorded, but decisions are raised only for subjects inside a protected call, and standing questions
(`rt.question()`, plugin `questions`) are asked only about them (explicit `rt.ask()` / `rt.decide()` are answered as
before). For an async `fn` the operation and the situation are the same as with `rt.op(name, fn)`; a sync `fn`'s
operation ends when it returns. There is no per-function `mode` option yet.

## Asking the model

```ts
rt.ask<Q extends Question>(q: Q, opts?: { about?: "now" | number /* op id */ | string /* store */; timeoutMs?: number }): Promise<AnswerOf<Q>>
rt.decide<L extends string>(question: string, options: Record<L, string>, opts?): Promise<L>
```

The question is answered against the current situation (what the app is doing now, or about one op or store).

```ts
const mode = await rt.decide("How should the editor save right now?", {
  now: "save immediately, the user paused",
  later: "wait, the user is still typing quickly",
});
const busy = await rt.ask({ type: "score", instructions: "How busy is the app right now?", criteria: ["idle", "light", "busy"] });
const risky = await rt.ask({ type: "noul", instructions: "Did the last checkout request fail?" });   // risky.noul = P(true)
```

`ask`/`decide` wait for the model to load (bounded by `timeoutMs`) and reject with `GenClassUnavailableError`
(`reason`: `"off" | "error" | "timeout" | "destroyed"`) when no model can answer.

Question shapes (Jev wire format):

```ts
type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
// AnswerOf: noul -> { noul }, choice -> { choice, confidence, probabilities }, score -> { score, confidence, probabilities }
```

## Events

```ts
rt.on("detect", (d: Detection) => void)      // the model diagnosed a problem: d.detection "likely" (diagnosis != expected, p >= the report gate)
                                             // or, in observe (0.3.0), "possible" (p >= gates().possible, below the report gate)
rt.on("decide", (d: Decision) => void)       // every model decision
rt.on("act", (a: ActionRecord) => void)      // every non-passive action that ran
rt.on("event", (e: RtEvent) => void)         // every traced event
rt.on("status", (s: ModelStatus) => void)    // model loading progress and state
rt.on("report", (r: Report) => void)         // every report line (even with report: "silent")
rt.on("expectation", (e: Expectation) => void) // a learned step did not happen (see "Learned flows and expectations")
// each returns an unsubscribe function
```

## Introspection and control

```ts
rt.status: ModelStatus             // { state: "off"|"loading"|"ready"|"error", progress?, device?, variant?, threads?, phase?, error?, ... }
rt.ready: Promise<void>            // resolves when the model is ready (immediately with no model); reading it starts a lazy load
rt.mode: "observe" | "guard" | "heal"
rt.situation(trigger?): Situation  // what the model would see: { trigger, subject, state, questions, actions, salient, facts }
rt.explain(id): Explanation | null // a decision ("d3") or action ("a1") id -> { message, decision, situationText, facts, timeline, answers, action?, changed? }
rt.holdBudgetMs(): number          // the current hold budget
rt.situationBudget(): number       // the current situation size in characters
rt.gates(trigger?): EffectiveGates // the gate thresholds in force (see Policy); `possible` when observe's possible tier is in force
rt.history(n?): RtEvent[]          // recent events, oldest first
rt.decisions(n?): Decision[]       // last 200 decisions
rt.interventions(n?): ActionRecord[]
rt.audit(n?): AuditEntry[]         // the audit trail, oldest first (see Reports, explain and undo)
rt.inflight(): Op[]
rt.stores(): StoreInfo[]           // registered and discovered stores: { name, kind: "atom"|"guard"|"adapter"|"observed", source?, writable, fields, version }
rt.learned(): Learned              // learned flows per user action and route, recent deviations, learned relations
rt.setMode(mode); rt.pause(); rt.resume(); rt.destroy()
rt.telemetry?: { enabled; reason?; endpoint?; sessionId?; flush(): Promise<void> } // reason when off: option, headless, url, localStorage, gpc, sampled-out, kill-switch, disabled, ...
```

`pause()` stops consulting the model (everything proceeds unchanged, tracing continues); `destroy()` uninstalls
every observer and restores the globals it wrapped.

## Triggers and actions

| trigger | when | actions (passive first) |
|---|---|---|
| `delivery` | a response (fetch/XHR) or a WebSocket/EventSource message is about to reach the app and, judged from its body (read from a clone), would change newer data already applied (no newer request of the same signature in flight), put back the value of an unconfirmed local change, or replace text the user typed since the request started | `deliver`, `discard`, `defer` |
| `mutation` | a salient state write not covered by a delivery decision (decided in the background unless `holdWrites`) | `apply`, `discard`, `defer` |
| `request` | a fetch/XHR is about to be sent | `send`, `coalesce`, `delay`, `block`, `serve_cached` |
| `failure` | a request failed (network, timeout, 5xx, 429, 408) before the app sees it | `deliver`, `retry`, `serve_cached` |
| `stall` | a request is far past its usual latency, or has been in flight 10 s without a latency baseline yet | `wait`, `hedge`, `serve_cached` |
| `inconsistency` | a learned relation between fields broke | `ignore`, `rollback`, `resync` |
| `transition` | an operation changed state unlike it usually does | `ignore`, `rollback`, `resync` |
| `error` | an uncaught error or unhandled rejection | `ignore`, `rollback` |

| action | tier | effect |
|---|---|---|
| `discard` | guard | delivery: deliver it, but drop the state changes its operation makes over newer data (`ActionRecord.dropped` lists them; undo: apply them now). mutation: revert exactly that write if decided ≤ 2 s after it applied, nothing overwrote it and its operation wrote nothing else since (undo: re-apply); with `holdWrites`, drop the held write |
| `defer` | guard | hold the response/message (or held write) until related requests finish, then decide again (twice at most) |
| `coalesce` | guard | do not send; reuse the response of the identical request in flight or just finished (`x-genclass: coalesced`) |
| `delay` | guard | wait min(250 ms · 2^failure streak, 8 s), then send |
| `block` | heal | do not send; answer 503 (`x-genclass: blocked`) |
| `serve_cached` | heal | answer with the last good response for this GET (`x-genclass: cached`; ≤ 256 KB, ≤ 64 entries, memory only) |
| `retry` | heal | re-send after min(200 ms · 2^(attempt-1), 5 s) when the body can be replayed and repeating is safe by HTTP semantics: GET, HEAD, OPTIONS, PUT, DELETE, or another method (POST, PATCH, ...) only when the request carries an idempotency key header (`policy.idempotencyHeaders`; request ids and tracing headers are not keys) or, opt-in, a JSON body field named in `policy.idempotencyBodyFields` |
| `hedge` | heal | send a second identical GET and use whichever answers first |
| `rollback` | heal | inconsistency: restore the involved stores to their last consistent snapshot; error/transition: restore only the fields the operation's own chain wrote to their earlier values (undo: restore the replaced values) |
| `resync` | heal | call the store's `resync` handler |

Diagnoses the model chooses from (`vocabulary.diagnoses` replaces them; plugins add labels): `expected` (normal
behaviour), `stale` (outdated data about to replace newer state), `conflict` (concurrent operations competing),
`duplicate` (the same change or request again without a new intent), `inconsistent` (state contradicts itself),
`failing` (keeps failing), `slow` (far slower than usual), `overload` (triggered far more often than usual),
`unusual` (unlike how the same operation normally behaves), `transient` (a one-off failure likely to succeed if
tried again).

Actions are offered only when they apply (`situation().notOffered` lists the built-in actions left out and why;
an identical request exists, a cached response exists, the body can be
replayed, a consistent snapshot exists, a `resync` handler exists, the failing operation wrote state). Responses
are always cloned before the app reads them. GenClass's own requests and writes are never gated; `keepalive`
requests and synchronous XHRs are never held; nothing is held when the mode and policy permit no action for it or
when the model is not expected to answer within the hold budget. A queued decision whose subject was superseded (the
response was released, the write overwritten, the request aborted) runs behind fresh ones; in guard and heal it is
skipped when decisions take over 300 ms (it could delay a held one), in observe (0.3.0) it is always computed. In
observe a queued decision also gains one priority level per second it waits, up to the background level, so error and
transition decisions are not starved by a burst of writes. XHR:
the app's completion listeners (`readystatechange`, `progress`, `load`, `loadend`, and the matching `on*`
handlers) are wrapped so a held response reaches them, in order, once delivered; `on*` getters return that wrapper.

Two requests are "identical" when method, URL, headers (tracing ids such as `traceparent` or `x-request-id`
excluded) and body content match. Bodies GenClass cannot read cheaply (streams, files, bodies over 64 KB) never
match anything.

## Policy

```ts
interface PolicyOptions {
  thresholds?: { report?: number; guard?: number; heal?: number };  // overrides; else the model's own gate, else 0.6 / 0.9 / 0.8
  allow?: string[];                 // only these non-passive actions may run
  deny?: string[];                  // these never run
  holdBudgetMs?: number | "auto";   // default "auto": clamp(1.5 × median recent model latency, 150, 800) ms
  holdUserWrites?: boolean;         // default false
  idempotencyHeaders?: string[];    // default ["Idempotency-Key", "X-Idempotency-Key"]: a POST/PATCH carrying one may be retried
  idempotencyBodyFields?: string[]; // opt-in, default []: top-level JSON body fields (e.g. "request_id") the server dedupes on
  holdWrites?: boolean;             // default false: state writes apply at once (decided at the network boundary)
  maxActionsPerMinute?: number;     // default 60
  requireDiagnosis?: boolean;       // default true
}
```

Thresholds: the model's action probabilities are calibrated against the gate it ships with (`gate` in its
meta.json, visible as `runtime.status.gate`). Two gate kinds exist:
- `kind: "mass"` (the default, also when meta.json has no kind): the most probable permitted action runs when the
  summed probability of the permitted actions reaches its tier's threshold (`{ report?, guard: { default,
  byTrigger? }, heal: {...} }`, probabilities; defaults 0.9 / 0.8).
- `kind: "gain"` (`{ kind: "gain", tauGain, guard: { default, byTrigger? }, heal: {...}, report? }`): for the most
  probable permitted action a, ĝ(a) = tauGain · ln(p(a) / p(passive)) estimates its gain over the passive action in
  cost units; a runs when ĝ(a) is above its tier's margin (defaults 2 / 2; tauGain default 1). Probabilities are
  clamped to ≥ 1e-6; when the model gives no probability for the passive action, the mass it left over is used.
Aggressiveness (`InitOptions.aggressiveness`: "cautious" | "balanced" | "eager" | 0–1, default "balanced";
`runtime.setAggressiveness(x)`; URL `?genclass-aggr=…`) selects the gate: when meta.json has `gate.profiles: {
cautious, balanced, eager }` (each a gate of either kind, report included), a named level uses its profile and a
number interpolates thresholds/margins, report and tauGain linearly between the neighbouring profiles (the nearer
profile's kind when they differ). Without profiles the single gate (or the defaults) is shifted: cautious +0.05 on
thresholds / +1 on margins, eager −0.05 / −1 (linear in between, clamped). `runtime.aggressiveness`,
`runtime.status.aggressiveness` and `runtime.gates()` (`aggressiveness`, `level`, `levelSource`) show the level.
For each trigger kind the effective value is your `policy.thresholds` value when set, read in the active kind
(probabilities for "mass", margins for "gain"; `report` is always a probability), else the model's value for that
trigger kind, else its tier default, else the defaults. `runtime.gates(trigger?)` returns the kind, values and where
each comes from (`policy`, `model`, `default`); every decision records `gateKind`, and `threshold` (mass) or `gain`
and `margin` (gain), with `thresholdSource`; `explain(id).gates` has the full set.

The permitted actions are the applicable non-passive actions the mode allows (observe: none; guard: guard tier;
heal: both), minus denied ones (only allowed ones when `allow` is set). GenClass runs the most probable permitted
action only if all of these hold, otherwise the passive action runs and the decision's `reason` says why: the
summed probability of the permitted actions reaches that action's tier threshold; the model's top diagnosis is not
`expected` (unless `requireDiagnosis: false`); fewer than `maxActionsPerMinute` actions ran in the last minute; the
decision arrived within the hold budget (a late `discard` may still revert the write, see State). While the model is
loading, everything proceeds unchanged: in guard and heal each salient situation fails open (failOpen `not-ready`); in
observe (0.3.0) it is built at its trigger and decided once the model is ready, for detection only (at most 32 wait,
oldest dropped and counted as `not-ready`; a lazy model starts loading at the first one, and an idle-unloaded one,
`model.unloadAfterIdleMs`, reloads). Such a deferred decision never acts, whatever the mode is by then.

## Reports, explain and undo

With `report: "console"` every detection and intervention prints one line, followed by a collapsed group with the
evidence: the facts, the timeline, the exact situation text sent to the model, the answer probabilities, what
changed, how to undo it and how to deny that action. Identical repeats within a minute are folded into one line
printed when the minute ends ("×N more in the last minute"). A detection that did not act says what GenClass would
have done and why not.

Detections have a tier (0.3.0, `InitOptions.detect`, `Decision.detection`). **Likely**: the top diagnosis is not
`expected` and its probability is at least the report gate (`rt.gates().report`: the aggressiveness profile's
report value from the model's meta, 0.90 at balanced with model 0.2.0, or `policy.thresholds.report`); printed as
above. **Possible** (by default only where the effective mode is observe and `policy.thresholds.report` is unset;
`detect: "possible"` turns it on elsewhere, `detect: "likely"` off): at least the eager profile's report value from
the same meta (`rt.gates().possible`, 0.70 with model 0.2.0) and below the report gate. A possible detection is the same
line ending in `(possible)`, printed with `console.debug` only (shown at Chrome's "Verbose" level), and its evidence is
in `rt.explain(id)`; it reaches `rt.on("detect")` and `rt.on("report")` with `decision.detection: "possible"`, the
devtools as a dimmed card left out of the counts, `rt.summary().possibleDetections`, telemetry's `detect` event with
`tier: "possible"`, and sinks that set `possible: true`. `explain()`, the console and the devtools all read the tier
recorded with the decision. The tiers are reporting only: no action gate reads them.

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6) started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over newer data (search.results). (stale, 0.97; discard 0.97)
```

```ts
const a = rt.interventions().at(-1)!;
a.changed;          // "Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over newer data (search.results)."
a.dropped;          // ["search.results"]
a.undo?.();         // discard: applies the dropped values now; late revert: re-applies the write; rollback: restores the values it replaced
rt.explain(a.id);   // { decision, situationText, facts, timeline, answers, action, changed }
```

A custom `report` function receives `{ kind: "detect" | "intervene" | "status" | "undo" | "breaker" | "error" | "expectation", message, decision?, action?, expectation? }`.
`explain(id).message` is the same line for any decision or action, also when it was not printed. An `expectation`
report (a learned step that did not happen) carries no decision: its evidence is the learned counts in
`report.expectation` and the console group prints them.

Your own debug UI: GenClass ignores user events from inside any element marked `data-genclass-ignore` (the devtools
overlay uses it), so debugging tools never become causes in situations.

### See it where you already look

0.3.0 (CHANGELOG): the adapters, the `@genclass/runtime/sinks` exports, sinks by name and `init --sink` are not
in `0.2.x`.

`sinks` receive a `SinkRecord` per report (OPTIONS-SPEC §4.11): `kind`, `id`, `ts`, `sessionId`, `tags`, `mode`,
`sampled`, `diagnosis`, `p`, `detection` (kind `detection`: `"likely"`, or `"possible"` for a sink with
`possible: true`), `action`, `tier`, `trigger`, `label`, `route` (the page path the subject's operation was
created on, normalised as telemetry sends it: id-like and email segments as `:id`, at most 200 chars), `changed`
(paths), `reason`, `shadow`, `correlationId`, and with `evidence: true` the redacted `message`,
`subject` and `timeline` (URL query and fragment values as `…`; timeline lines can hold short fragments of app data,
as the console does: a store value summary, an error message, text typed into an ordinary input). Five adapters, no
dependencies, each a function returning that sink shape, each finding the SDK on the page at send time (or taking the
client you pass), never throwing, and sending nothing beyond the record. Each takes `kinds`, `sampleRate`,
`evidence` (default true; false sends the structured fields only) and `possible` (0.3.0, default false: likely
detections only; sinks by name never get possible ones):

```ts
import { consoleJson, datadog, posthog, sentry, webhook } from "@genclass/runtime/sinks"; // or @genclass/runtime/sinks/<name>

sentry({ sentry: Sentry, as: "event", level: "warning", kinds, sampleRate, maxPerSignature: 10 });
// Sentry.captureMessage(line, { level, tags: { genclass: diagnosis, "genclass.kind", "genclass.mode", "genclass.action",
//   "genclass.trigger", "genclass.route" }, extra: { genclass: record }, fingerprint: ["genclass", <per-bug signature>] });
// as: "breadcrumb" → Sentry.addBreadcrumb({ category: "genclass", message: line, data: record }) only.
// Default SDK: globalThis.Sentry (the loader / CDN bundles); the npm SDK sets no global, so pass it.

posthog({ posthog: client, prefix: "genclass_" });
// posthog.capture("genclass_detection" | "genclass_intervention" | "genclass_undo" | "genclass_breaker" | "genclass_error",
//   { ...record, message, subject, timeline, signature }). Default client: globalThis.posthog (the snippet's stub queues too).

datadog({ rum: datadogRum, as: "error" });
// detections and interventions: DD_RUM.addError(Error named GenClassDetection / GenClassIntervention, { genclass: record });
// undo, breaker, error: DD_RUM.addAction("genclass_<kind>", { genclass: record }); as: "action" sends everything as actions.
// Default SDK: globalThis.DD_RUM (the async stub's onReady is honoured).

consoleJson({ method: "log", kinds });
// console.log('{"source":"genclass","schema":1,"kind":"detection",...}'), one line per record, every kind (summary too).

webhook({ url: "/genclass", maxBatch: 50, maxPerSignature: 10, headers, kinds, sampleRate, clock, flushMs: 5000 });
// POST { schema: "genclass-sink/1", version, records: SinkRecord[] } by navigator.sendBeacon, else fetch keepalive, as JSON
// in a text/plain body; at most one POST per idle-time delivery round (a microtask after it; with a clock: flushMs after
// the first record, or at once at maxBatch), holding at most maxBatch records and 32,000 UTF-8 bytes of them (about half
// the page's 64 KiB keepalive budget, which the app's own beacons share). The rest waits, oldest first, for the next
// round (with a clock: flushMs later; without: the next records' round, or the previous fetch settling); on page hide
// one batch goes, the session summary first, and what is left is dropped. At most 500 records wait. The records and
// nothing else (route, diagnosis, action, ..., the evidence text above): never the situation text, bodies, headers or
// cookies. With headers (fetch only) or no sendBeacon, list the URL in requests.ignore.
```

The tool adapters (sentry, posthog, datadog) default to `kinds: ["detection", "intervention", "undo", "breaker",
"error"]`; they and `webhook` cap repeats of one bug (same kind, trigger, diagnosis, action and subject shape, with op
ids, numbers and id-like path segments such as UUIDs, hex, tokens, slug ids and emails as one) at `maxPerSignature` 10
per page load (the webhook never caps its `summary` record); `consoleJson` and `webhook` forward every kind. A tool
adapter that finds no SDK when a record arrives prints one console warning naming the fix.

Sinks by name, with no code, in the zero-code entries (`/auto`, the script tag): `window.GENCLASS_CONFIG = { sinks:
["sentry", "webhook:/genclass"] }`, `<meta name="genclass" content="sink=sentry+posthog">` (`+` joins names, since
commas separate the meta keys), `data-sink="sentry,posthog"` on the script tag, or `npx @genclass/runtime init --sink
sentry`. A name finds its SDK as a page global (`window.Sentry`, `window.posthog`, `window.DD_RUM`); `<name>:noevidence`
(`sentry:noevidence`) makes its adapter with `evidence: false`. `init` suggests the flag when `package.json` depends on
a Sentry browser SDK (`@sentry/react`, `@sentry/vue`, `@sentry/nextjs`, ...; not its build plugins or server SDKs),
`posthog-js` or `@datadog/browser-rum`, and in an option file it writes a `sentry` or `posthog` sink whose SDK comes
from npm (which sets no global) as the adapter with that SDK passed in: `import * as Sentry from "@sentry/vue"; import
{ sentry as sentrySink } from "@genclass/runtime/sinks/sentry"; globalThis.GENCLASS_CONFIG = { sinks: [sentrySink({
sentry: Sentry })] };` (GENCLASS_CONFIG passes sink objects through). The names become one proxy sink at init that
queues records (at most 200) and loads the adapters on the first record (never before: a page that reports nothing,
or runs with `?genclass=off`, fetches none): a lazy chunk of `/auto`, `dist/sinks/<name>.js` from the CDN for the
script tag. Only the proxy is in the first-load bundle. A webhook URL is made absolute at init (against
`document.baseURI`) and its endpoint (origin and path) joins `requests.ignore` as an exact match; from a `<meta>` tag it
must be same-origin as the browser resolves it, against the page and `document.baseURI` (a cross-origin one is ignored
with one warning, as for the model and ORT URLs). An unknown name, or an adapter that cannot load, is one console
warning. A name handed to `GenClass.init({ sinks })` directly is ignored with one warning: import the adapter there.
The console default is unchanged.

### Audit trail

`rt.audit(n?)` returns the last `n` entries (all kept by default) of a structured, JSON-serialisable record of
everything the runtime decided and did; `JSON.stringify(rt.audit())` exports it, and it keeps working after
`destroy()`. One entry per decision (acted on or not), action, undo, breaker trip or reset, and control change:

```ts
interface AuditEntry {
  schema: 1; seq: number;              // 1, 2, 3, ... without gaps
  at: number;                          // runtime clock (ms)
  kind: "decision" | "action" | "undo" | "breaker" | "control";
  sessionId: string;
  mode: "off" | "observe" | "guard" | "heal";  // effective mode for the subject (or the session)
  requestedMode: "observe" | "guard" | "heal";
  aggressiveness: number; profile?: "cautious" | "balanced" | "eager";
  model: { name: string; state: string; version?: string; variant?: string; device?: "webgpu" | "wasm"; sha256?: string };
  decisionId?: string; actionId?: string; trigger?: TriggerKind; subject?: string; label?: string; correlationId?: string;
  // decision
  diagnosis?: string; diagnosisConfidence?: number; proposed?: string; probabilities?: Record<string, number>;
  ran?: string; executed?: boolean; tier?: "passive" | "guard" | "heal"; reason?: string;
  gate?: { kind: "mass" | "gain"; thresholds: { report: number; guard: number; heal: number };
           source: { report: GateSource; guard: GateSource; heal: GateSource };
           candidate?: string; mass?: number; threshold?: number; gain?: number; margin?: number };
  held?: boolean; holdBudgetMs?: number; latencyMs?: number; shadow?: { action; tier; wouldPass; reason? };
  // action
  ok?: boolean; error?: string; changed?: string; undoable?: boolean; late?: boolean; dropped?: string[];
  // undo: byRuntime (true for rt.disable({ undo: true }), which the breaker does not count)
  byRuntime?: boolean;
  breaker?: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  control?: { what: "setMode" | "setAggressiveness" | "pause" | "resume" | "enabled" | "disable"; from?: string | number; to?: string | number };
}

GenClass.init({
  requests: { ignore: ["/my-log"] },
  audit: { size: 5000, sink: (e) => navigator.sendBeacon("/my-log", JSON.stringify(e)) },
});
```

`audit.size` (default 1,000, at most 10,000; 0 keeps none) bounds memory; `audit.sink` gets a copy of every entry, in
order, on a microtask after it was recorded (never while a subject is held); a throwing sink is contained (one warning
a minute). Query and fragment values in `subject`, `changed` and `error` are replaced with "…". The trail is built from
values the runtime already has: it never feeds a decision, never changes what the model reads, and GenClass never
sends it anywhere. A sink that ships entries with `fetch` should send to an endpoint listed in `requests.ignore` (or
use `navigator.sendBeacon`, which GenClass does not wrap): otherwise its requests are observed like any app request
and may themselves be decided about. `AUDIT_SCHEMA` is exported.

## Plugins

```ts
rt.use(plugin: Plugin): () => void
rt.action(def: ActionDef): () => void
rt.question(def: StandingQuestion): () => void

interface Plugin {
  name: string;
  setup?(api: PluginApi): void | (() => void);   // api: emit, recordOp/endOp, runInOp, user, reportError, on, clock, stores, runtime
  facts?(sit: SituationDraft): string[];          // extra facts about your domain, added to every situation
  actions?: ActionDef[];
  questions?: StandingQuestion[];
  diagnoses?: Record<string, string>;             // extra diagnosis labels
}
interface ActionDef {
  name: string; description: string; on: TriggerKind[];
  tier?: "guard" | "heal";                        // default "heal"
  applicable?(sit: SituationDraft): boolean;
  run(ctx: ActionContext): void | Promise<void>;
}
interface ActionContext {
  trigger; decision; situation; runtime;
  builtin(name: string): Promise<boolean>;        // run a built-in action, e.g. "discard" or "retry"
  describe(changed: string): void;                // what this action altered (shown in reports)
  onUndo(fn: () => void): void;
}
interface StandingQuestion { id: string; on: TriggerKind[]; question: Question; always?: boolean; onAnswer?(a: Answer, ctx): void }
```

```ts
rt.use({
  name: "presence",
  setup(api) {
    const ws = new WebSocket("/presence");
    ws.onmessage = (e) => api.emit("presence", { users: JSON.parse(e.data).length });
    return () => ws.close();
  },
  facts: (s) => (s.trigger === "mutation" ? [`${onlineUsers()} other users are editing this document.`] : []),
  actions: [{
    name: "ask_to_reload", description: "keep the write and ask the user to reload the document", on: ["inconsistency"], tier: "heal",
    run: (ctx) => { showReloadBanner(); ctx.describe("Showed the reload banner."); },
  }],
});
```

If a custom action does not call `ctx.builtin(...)`, the passive action runs after it (the held write applies,
the request is sent).

## Headless use (tests, SSR, simulation)

```ts
import { createRuntime } from "@genclass/runtime";
const rt = createRuntime({
  clock,      // { now(), setTimeout(fn, ms), clearTimeout(h), afterTask(fn) }; default: the real clock
  global,     // the object whose fetch / XMLHttpRequest / WebSocket / addEventListener / ... are instrumented; default globalThis
  decider,    // any DecisionProvider; default none (createRuntime never loads the model unless model: {...} is given)
              // telemetry is off in createRuntime unless telemetry: true / {...} is given
  app: () => ({ title: "Shop", route: "/cart" }),   // default: global.document.title and global.location.pathname
  hooks: { opCreated(op) {}, mutationProposed(m) {} },
});

interface DecisionProvider {
  readonly status: ModelStatus;
  ready(): Promise<void>;
  evaluate(req: { trigger; state; questions; priority?; subject?; notOffered?; timeoutMs? }): Promise<Record<string, Answer>>;
  onStatus?(fn): () => void;
  dispose?(): void;
}
```

The runtime only uses the injected clock (no `Date.now`, `Math.random` or global timers), so a virtual clock makes
runs deterministic: the same inputs give byte-identical situations. Pass `situation: { budget }` to fix the
situation size.

The local model host is exported for direct use: `createModelHost(options)` (a `DecisionProvider` with `measure()`,
`evaluateDetailed()`, `stats`), `DEFAULT_MODEL_BASE_URL`, and the model errors (`ModelNotReadyError`,
`MaxTokensExceededError`, `ModelTimeoutError`, `ModelBusyError`, `ModelLoadError`, ...; each has a `code`). Any
provider error makes the runtime fail open. The device floor is exported too: `deviceEnv(globalThis)` (what the page
can tell about the device: `deviceMemoryGB`, `saveData`, `mobile`, `cores`, `webgpu`, `effectiveType`),
`evalLoadIf(modelOptions, env, warn)` (`"load" | "lazy" | { skip: "device-memory" | "save-data" | "loadIf" }`) and
`DEFAULT_LOAD_IF` (`{ minDeviceMemoryGB: 4, saveData: "skip" }`, since 0.3.0; `navigator.deviceMemory` is quantised
to powers of two, so 4 skips exactly the devices reporting 2 GB or less).

## Adapters and devtools

Subpath exports: `@genclass/runtime/react` (`useGenClassState(name, initial, opts?)`, `useAtom(atom)`,
`useGenClass()`), `@genclass/runtime/redux` (`genclassEnhancer(runtime, { name })`), `@genclass/runtime/zustand`
(`genclass(runtime, name)(stateCreator)`), `@genclass/runtime/devtools` (`mountDevtools(runtime, opts?)`),
`@genclass/runtime/discover` (automatic state discovery for `GenClass.init({ autoState: true })`; import it first),
`@genclass/runtime/sinks` (`sentry`, `posthog`, `datadog`, `consoleJson`, `webhook`; 0.3.0) and one subpath per
adapter, `@genclass/runtime/sinks/{sentry,posthog,datadog,console-json,webhook}` (each also its default export; see
"See it where you already look"). They are documented with their source. To integrate another state library use:

```ts
rt.adapter<T>(name: string, io: { get(): T; set?(v: T): void; subscribe?(fn: () => void): () => void }, opts?): {
  propose(w: { fn?: (prev: T) => T; value?: T; commit: (next: T) => void }): void;   // commit runs when (and if) the write applies
  dispose(): void;
}
```

## Types

```ts
interface Decision {
  id: string; trigger: TriggerKind; subject: string; at: number; latencyMs: number; model: string;
  diagnosis: string; diagnosisConfidence: number; diagnosisProbabilities: Record<string, number>;
  action: string /* the action that ran, else the model's choice */; confidence: number /* probabilities[action] */;
  probabilities: Record<string, number>; executed: boolean; reason?: string; facts: string[];
  tier: "passive" | "guard" | "heal"; ran: string; answers: Record<string, Answer>; subjectRef?: SubjectRef;
  candidate?: string /* most probable permitted action */; mass?: number /* summed probability of the permitted actions */;
  gateKind?: "mass" | "gain"; threshold?: number /* mass gate: what mass was compared with */;
  gain?: number; margin?: number /* gain gate: ĝ of the candidate and its tier margin */; thresholdSource?: "policy" | "model" | "default";
  detection?: "likely" | "possible" /* 0.3.0: set on detections (see "Reports, explain and undo") */;
}
type Detection = Decision;
interface ActionRecord { id: string; decisionId: string; action: string; tier; trigger; subject: string; at: number; ok: boolean; error?: string; changed: string; undo?: () => void; late?: boolean; dropped?: string[] /* delivery discard: fields dropped */ }
type SubjectRef = { kind: "delivery"; op: number; paths?: string[]; store?: string } | { kind: "mutation"; ... } | ...
interface Explanation { message: string; decision: Decision; situationText: string; facts: string[]; timeline: string[]; answers: Record<string, Answer>; action?: ActionRecord; changed?: string; gates?: EffectiveGates }
interface Expectation { kind: "request" | "response" | "write" | "follow-up" | "navigation"; route: string; action: string; op: number; signature?: string; field?: string; after?: string; to?: string; seen: number; of: number; sessions: number; waitedMs: number; usualMs?: number; at: number; message: string }
interface LearnedFlow { route: string; action: string; n: number; repeats: number; sessions: number; settleMs?: { p50; p95 }; children: { signature; n; share; onRepeat; expected; expectedOnRepeat; protected?; missed?; delayMs? }[]; writes: { signature; field; n; of; share; expected; missed? }[]; followUps: { after; then; n; of; share; expected; missed?; delayMs? }[]; nav: { to; n; share; expected; missed? }[] } // missed: reported missing, not expected until seen again
interface Learned { route: string; session: number; flows: LearnedFlow[]; deviations: Expectation[]; relations: { text: string; held: number }[] }
interface EffectiveGates { kind: "mass" | "gain"; tauGain?: number; trigger?: TriggerKind; report: number; possible?: number /* 0.3.0: observe's possible tier */; guard: number; heal: number; source: { report: "policy" | "model" | "default"; guard: …; heal: … } }
interface RtEvent { seq: number; t: number; kind: "user"|"op.start"|"op.end"|"state"|"error"|"nav"|"perf"|"storage"|"custom"|"decision"|"action"; name: string; op?: number; cause?: number; data?: Record<string, unknown> }
interface Op { id: number; kind: "user"|"fetch"|"xhr"|"ws"|"task"|"timer"|"genclass"; name: string /* e.g. "GET /api/x", "WS message /live", "SSE update /stream" */; detail?: string; start: number; end?: number; status?: "ok"|"error"|"aborted"|"blocked"; code?: number | string; cause?: number; root?: number; attempt: number; reads: Map<string, number>; identity?: string }
```

Privacy: values are summarised and redacted before they reach a situation. A value is redacted when its leaf field
names a secret (password, passcode, pin, token, secret, cvv/cvc, ssn, iban, otp, cookie, authorization, card number,
credit card, api key, session id, ...; `payment.card.number` counts), never because of the store's name: in an `auth`
store, `auth.token` is redacted and `auth.loading` or `auth.user.name` are not. Under a container that names a secret
(`credentials.password.value`) strings are redacted too, and under `auth`/`session`/`cookie` only opaque
credential-like strings (JWTs, API keys). Query parameters and body keys follow the same rule; password inputs and
inputs with `autocomplete` cc-* / one-time-code are never recorded. Element text such as a kanban "card" is not a
secret. Response bodies are read only from a clone the runtime already keeps (≤ 256 KB) and only to compare them with
the store. Decisions are made in the browser by the local model; the only data GenClass sends is its anonymous
telemetry (on by default with `GenClass.init()` in a browser; [TELEMETRY.md](../../packages/runtime/TELEMETRY.md)),
which includes the redacted situation text.