# @genclass/runtime: configuration extensions spec (v0.3 options), final

Status: ready for implementation. Branch `runtime`, package `packages/runtime`. I read only `types.ts`, `API.md`, README and the CONTRACT sections. Nothing was run. `aggressiveness` is already in flight, so it is not proposed here. Today's documented default is `"balanced"`, and this spec does not change it.

## 0. Design rules

1. **Every new option narrows behaviour or exports data. None of them widens it.** A few defaults differ from today, and every difference makes things safer. They are all listed in §8: the breaker is on, per-subject and per-session limits exist, `holdBudgetMs` is a hard ceiling, model loading is skipped on small devices and Save-Data connections, hidden tabs skip background evaluation in guard and heal (observe decides those situations when the tab is visible again, §5.1), and query values are redacted in what the model sees. One default widens what is *reported*, never what is done: observe reports "possible" detections too (`detect`, §4.19), and decides situations raised while the model loads or the tab is hidden later, reporting them at the possible tier at most (§5.3); `detect: "likely"` turns both off. Three 0.3.0 fixes also widen what observe reports, with no option (the idle-unload reload §4.18, overwritten writes decided on slow devices, the 100 ms body wait): they can add likely reports, false ones included, at a rate not measured yet.
2. **There is no bug knowledge in config.** Options control where the runtime watches or acts, how much it may do, and where findings go. The model alone decides what is wrong. Labels go to reports only by default (§4.4). Tags and correlation ids never reach the model or the gate.
3. **One effective-mode function, and every term can only demote:**
```
effectiveMode(op) = state ∈ {disabled} ? off
                  : min( globalMode        // InitOptions.mode / rt.setMode / URL param (URL may only demote unless debug:true)
                       , sample cap        // 'observe' if sampled out
                       , breaker cap       // breaker.downgradeTo once tripped
                       , route rule.mode ) // first matching routes[] rule
order: off < observe < guard < heal
```
   `effectiveAggressiveness` is the min of the global value (including `?genclass-aggr`, which may only demote unless `debug:true`) and the route value. Explicit `policy.thresholds` still win. The scope is **snapshotted when an op or mutation is created** (`OpRec.scope`) and is never re-classified later. `status.mode` keeps reporting the *requested* mode. `status.effectiveMode`, `Report.mode` and `SinkRecord.mode` report the effective mode.
4. **Gate order per decision** (`decide/policy.ts gate()`). The first step that stops the action wins, and its reason goes into `Decision.reason` and `explain()`:
   1. the subject, or the action's target op, is `protected` → passive, `protected`
   2. the subject is cross-origin → passive, `cross-origin` (not configurable)
   3. the target op's snapshotted scope is `off`/`observe` → not offered (`notOffered`), reason `scope`
   4. `modeAllows(effectiveMode, tier)`, then the existing allow/deny (`restriction`) and requireDiagnosis
   5. thresholds (aggressiveness profile; explicit `policy.thresholds` win)
   6. `policy.actionLimits` → `limit:perMinute|perSubject|perSession`
   7. `onBeforeAction` veto → `vetoed`; if the hook's time pushes a held item past its hold budget → released unchanged, `limit:hold`
   8. execute

   `shadow` runs steps **1–6** at the shadow mode, with a dry-run limit check, against the same model answer. It skips steps 7 and 8.

## 1. Option summary

| # | Option | Group | Default | New / extended |
|---|---|---|---|---|
| 1 | `enabled` (+ `rt.disable()`) | activation | `true` | new |
| 2 | `sample` | activation | `1` | new |
| 3 | `routes` | scope | `[]` | new |
| 4 | `requests` `{ignore, protect, crossOrigin, labels, labelsToModel, correlate}` | scope / safety | `{ignore:[], protect:[], crossOrigin:"observe", labels:[], labelsToModel:false}` | new |
| 5 | `breaker` (+ `rt.breaker.reset()`) | safety | on | new |
| 6 | `shadow` | safety | `false` | new |
| 7 | `onBeforeAction`, `vetoMode` | safety | unset, `"enforce"` | new |
| 8 | `policy.actionLimits` (`maxActionsPerMinute` = deprecated alias) | safety | `{perMinute:60, perSubject:10, perSession:200}` | new / extended |
| 9 | `policy.holdBudgetMs` | safety | `"auto"` | semantics tightened |
| 10 | `redact` | privacy | built-in | extended (`kind` arg) |
| 11 | `sinks` + `rt.summary()` | telemetry | `[]` | new |
| 12 | `session` + `rt.setSession()` | telemetry | random id, `{}` | new |
| 13 | `report` | telemetry | `"console"` | extended (`"interventions"`) |
| 14 | `learn` (+ `rt.learn.clear()`, `rt.learned()`) | persistence | `{persist:unset, expectations:false}`: nothing stored; with `expectations: true`, flows stored, profiles in memory (EXPECTATIONS.md §4) | extended |
| 15 | `model.loadIf`, `model.inlineFallback` | load | `{minDeviceMemoryGB:4, saveData:"skip"}`, `true` | new |
| 16 | `model.threads`, `model.timeoutMs` | load | `"auto"`, `10000` | promoted from internal |
| 17 | `model.maxDecisionsPerMinute` | load | `30` | new |
| 18 | `model.unloadAfterIdleMs` | load | `false` | new |
| 19 | `rt.on()` typed events: `shadow`, `breaker`, `limit`, `modelBudget` | API | — | extended |
| 20 | `detect` (0.3.0) | reporting | `"possible"` where the effective mode is observe and `policy.thresholds.report` is unset, else `"likely"` | new |
| 21 | `visual` (+ `rt.checks()`, `rt.checkNow()`, the `check` event) | measured visual checks | `"local"` in `GenClass.init()` in a browser, `false` in `createRuntime()` | new (§4.20); `checks.stallMs` (issue 94) |
| 22 | `requestTimeoutMs` | heal | off | **proposed only, not implemented** (§4.21) |

Built in, with no option: hidden tabs (§5.1): guard and heal skip background situations; observe defers them until
the tab is visible. Observe also defers situations raised while the model loads (§5.3).

## 2. Types (add to `types.ts`)

```ts
export type ModeOrOff = Mode | "off";

export type RequestMatcher =
  | string   // URL prefix or glob ("*/v1/orders*"); strings starting with "/" also match the path
  | RegExp
  | ((r: { url: string; method: string; channel: "fetch" | "xhr" | "ws" | "sse" }) => boolean);

export interface RouteRule {
  match: string | RegExp | ((route: string) => boolean);  // string = exact path or glob ("/admin/*")
  mode?: ModeOrOff;                // demote only
  aggressiveness?: Aggressiveness; // demote only
}

export interface RequestScope {
  ignore?: RequestMatcher[];                    // pass-through, no OpRec
  protect?: RequestMatcher[];                   // never held/retried/replayed/cached/discarded
  crossOrigin?: "observe" | "ignore";           // default "observe"; always passive
  labels?: Array<{ match: RequestMatcher; label: string }>; // names only: [A-Za-z0-9 _-], ≤ 5 words, ≤ 40 chars
  labelsToModel?: boolean;                      // default false (labels only in reports/sinks)
  correlate?: (r: { url: string; method: string; headers: Record<string,string> }) => string | undefined;
}

export interface EnabledSource { get(): boolean; subscribe(cb: (on: boolean) => void): () => void; }

export interface BreakerOptions {
  undos?: number;              // default 2
  errorsAfterAction?: number;  // default 3
  attributionMs?: number;      // default 5000: window after an action in which subject errors count
  windowMs?: number;           // default 600_000
  downgradeTo?: "observe" | "guard"; // default "observe"
  persist?: "session" | false; // default "session"
}

export interface ActionLimits { perMinute?: number; perSubject?: number; perSession?: number; }

export interface ActionRequest {
  action: string; tier: "guard" | "heal"; trigger: TriggerKind;
  subject: string; diagnosis: string; p: number; decisionId: string;
  route?: string; label?: string;
}

export type SinkKind = "detection" | "intervention" | "undo" | "breaker" | "summary" | "error";

export interface SinkRecord {
  schema: 1;
  kind: SinkKind;
  id: string; ts: number;
  sessionId: string;
  tags: Record<string, string | number | boolean>;
  correlationId?: string;      // from requests.correlate; never model-visible
  mode: ModeOrOff;             // effective mode at decision
  route?: string;              // the path the subject's op was created on (else the current one), id-like and email segments as :id, <= 200 chars
  sampled: boolean;
  diagnosis?: string; p?: number;
  detection?: "likely" | "possible"; // kind "detection" (0.3.0, §4.19)
  action?: string; tier?: Tier;
  changed?: string[];          // paths only
  undone?: boolean;
  shadow?: { action: string; tier: Tier; wouldPass: boolean; reason?: string };
  reason?: string;             // protected | cross-origin | scope | vetoed | would-veto | limit:* | ...
  summary?: SessionSummary;
  evidence?: { message?: string; trigger?: TriggerKind; subject?: string; timeline?: string[] };
}

export type SinkFn = (r: SinkRecord) => void | Promise<void>;
export interface SinkObject {
  send: SinkFn;
  kinds?: SinkKind[];
  sampleRate?: number;   // session-deterministic; never drops intervention/undo/breaker
  evidence?: boolean;    // default false
  possible?: boolean;    // 0.3.0, default false: also "possible" detections (§4.19)
  flush?(): Promise<void>;
}
export type Sink = SinkFn | SinkObject;

export interface SessionSummary {
  startedAt: number; durationMs: number;
  detections: Record<string, number>;      // likely detections, by diagnosis
  possibleDetections: Record<string, number>; // 0.3.0: possible detections (§4.19), by diagnosis
  interventions: Record<string, number>;
  undos: number; lateReverts: number;
  denied: Record<string, number>;          // by reason
  shadow: Record<string, number>;
  model: { state: ModelStatus["state"]; p50Ms?: number; p95Ms?: number; decisions: number; dropped: number; hiddenSkipped: number };
  heldMs: { total: number; max: number };
  errors: number;
}

export interface DeviceEnv { deviceMemoryGB?: number; saveData?: boolean; effectiveType?: string; cores?: number; webgpu: boolean; }

export interface RuntimeEvents {
  detect: Detection; decide: Decision; act: ActionRecord;            // existing
  shadow: { decisionId: string; action: string; tier: Tier; wouldPass: boolean; reason?: string };
  breaker: { tripped: boolean; reason: "undos" | "errors" | "reset"; decisionIds: string[]; counts: { undos: number; errors: number } };
  limit: { kind: "perMinute" | "perSubject" | "perSession"; subject: string };
  modelBudget: { decisionsLastMinute: number; dropped: number };
}
```

Additions to existing interfaces:

```ts
export interface ModelOptions {
  // existing: baseUrl, device, worker, preload, ortWasmPaths, cacheName
  loadIf?: { minDeviceMemoryGB?: number; saveData?: "skip" | "lazy" | "ignore" }
         | ((env: DeviceEnv) => boolean | "lazy");
  inlineFallback?: boolean;           // default true
  threads?: number | "auto";          // default min(4, max(1, cores-1))
  timeoutMs?: number;                 // default 10000
  maxDecisionsPerMinute?: number;     // default 30
  unloadAfterIdleMs?: number | false; // default false
}

export interface PolicyOptions {
  // existing ...
  actionLimits?: ActionLimits;
  /** @deprecated use actionLimits.perMinute */
  maxActionsPerMinute?: number;
}

export interface InitOptions {
  // existing ...
  enabled?: boolean | (() => boolean | Promise<boolean>) | EnabledSource;
  sample?: number;
  routes?: RouteRule[];
  requests?: RequestScope;
  breaker?: BreakerOptions | false;
  shadow?: "guard" | "heal" | false;
  onBeforeAction?: (a: ActionRequest) => boolean | void;
  vetoMode?: "enforce" | "report";    // default "enforce"
  report?: "console" | "interventions" | "silent" | ((r: Report) => void);
  redact?: (path: string, value: unknown, kind?: "state" | "url" | "header" | "input") => unknown;
  sinks?: Sink[];
  session?: { id?: string; tags?: Record<string, string | number | boolean> };
  learn?: { persist?: boolean | "local" | "session"; key?: string; version?: string };
}
```

Runtime API:
- New methods: `rt.on<K extends keyof RuntimeEvents>(k, cb): () => void`, `rt.summary()`, `rt.setSession(p)`, `rt.disable({ undo?: boolean })`, `rt.breaker.reset()`, `rt.learn.clear()`.
- New `status` fields: `state: …|"disabled"`, `effectiveMode`, `sampled`, `breaker: {tripped, at?, reason?}`, `scope: {route?, rule?, mode, aggressiveness}`, `model.state: …|"skipped"|"unloaded"` (+`reason`), `modelBudget: {decisionsLastMinute, dropped}`.

## 3. Shared infrastructure

- **`util/match.ts`** (new): `compileMatchers(list, onThrow: "match" | "nomatch")`.
  - A string containing `*` is a glob. Any other string is a prefix, matched against the absolute URL and also against the path when it starts with `/`. A RegExp is used as given.
  - Predicates run inside try/catch. `protect` treats a throw as a match, while `ignore`, `labels` and routes treat it as no match.
  - Results go in an LRU cache keyed by `method+" "+url`, 256 entries. Matchers are compiled once, in the `runtime.ts` constructor.
- **`OpRec.scope`**: `{ mode, aggressiveness, protected, crossOrigin, label?, route?, correlationId? }`, set in `NetHost.startOp`.
- **`runtime.ts computeScope()`** runs on init, on nav, on `setMode`/`setAggressiveness`, on a breaker trip or reset, and when `enabled` changes. It stores `this.scope`, which is snapshotted per op or mutation.
- **URL overrides** (`?genclass-mode`, `?genclass-aggr`, `?genclass-sample=0|1`) may only demote. With `debug:true` they may also raise the value, for QA. `?genclass-sample=1` under debug forces the session into the act cohort.

## 4. Options

### 4.1 `enabled` and `rt.disable()`
**Type** `boolean | (() => boolean|Promise<boolean>) | EnabledSource`. **Default** `true`.

**Semantics.**
- A `false` value means the model is not downloaded, observers are not installed, and `status.state="disabled"`. All methods become no-ops that return empty values.
- While a Promise is pending, the runtime runs in pure pass-through: OpRecs are recorded, but nothing is held, decided or acted on. A rejection or a throw counts as `false`.
- An `EnabledSource` is read at init and then followed through `subscribe`. Flipping it to false behaves like `rt.disable({ undo:false })`. Flipping it back to true re-enables the runtime and loads the model lazily.
- `rt.disable({ undo })` releases every hold unchanged and uninstalls observers. With `undo:true` it also calls `undo()` on every ActionRecord still inside its undo window, newest first, and emits one `undo` record per action. The model is disposed.
- `pause()`/`resume()` keep their existing meaning.

**Precedence.** It beats every other control, including the URL overrides.

**Hooks.** `auto.ts`, the `runtime.ts` constructor, and `exec.ts gated(op)`.

**Tests.**
- `false` → no model fetch, and app fetches are identical.
- An async `true` after 200 ms → nothing is held in the first 200 ms.
- A rejecting or throwing predicate → disabled, with a warning.
- An EnabledSource flipped to false mid-session → holds released, mode `off`.
- `disable({undo:true})` reverts in-window actions and leaves expired ones alone.

### 4.2 `sample`
**Type** `number` in [0,1], clamped with a warning. **Default** `1`.

**Semantics.** Sessions outside the fraction get an `observe` cap. The model still loads, so they form the comparison group. The bucket is **decided once at init** as `hash(session.id)/2^32 < sample`, then frozen and stored in `sessionStorage["genclass:bucket"]` (wrapped in try/catch). A later `setSession({id})` does not change it. An app that passes a stable user id gets the same bucket in every tab, which is the intended behaviour. `?genclass-sample=0` always forces observe, and `=1` only works under debug.

**Precedence.** It is one term of the min. `setMode` cannot lift it.

**Tests.**
- `sample:0` → no actions, and detections are still reported.
- 10k ids at 0.05 → 5% ± 0.5%.
- Reload → same bucket.
- Storage throws → deterministic within the page.
- `setSession({id})` → bucket unchanged.

### 4.3 `routes`
**Type** `RouteRule[]`. **Default** `[]`.

**Semantics.**
- Rules are evaluated at init and on every `installNav` callback. The first match wins. A rule can only demote, and a rule that asks for a higher mode is clamped, with one warning.
- `mode:"off"` means ops created on that route are pass-through, though they are still recorded in the timeline.
- Ops created under `off` or `observe` scope **are never the target of an action** later, even from another route (gate step 3).
- The scope is snapshotted per op, so a write held under heal on route A is decided under heal after navigating to route B.
- Per-route allow/deny is out of scope.

**Hooks.** `observe/nav.ts` → `computeScope()`. `exec.ts startOp`. `policy.ts gate()` reads `g.scope`. `effectiveGates(c, raw, trigger, level)`.

**Tests.**
- A `/checkout` observe rule under global heal → no actions on checkout ops.
- A rule above the global mode is clamped and warns.
- An op held on route A is decided with A's scope.
- An op from an `off` route is not offered as a target from route B.
- RegExp, glob and predicate rules all work, and a throwing predicate is skipped.

### 4.4 `requests`
**Type** `RequestScope`. **Default** `{ ignore:[], protect:[], crossOrigin:"observe", labels:[], labelsToModel:false }`.

**Semantics.**
- **`ignore`**: the request is pure pass-through. There is no OpRec, no hold, no budget count, and no added microtask before the native call. The docs must warn that an ignored request can no longer be seen as a cause.
- **`protect`**: the request is observed and reported but, in every mode, it is **never held, delayed, retried, replayed, hedged, coalesced, answered from cache or discarded**. Its hold is skipped at the network boundary, so it adds zero latency. Any action that targets it goes in `notOffered`, and the gate reason is `protected`. A throwing predicate counts as protected. `onBeforeAction` is never called for it. Writes to the store caused by delivering its response are gated normally. *(Changed 2026-10-10, SAFETY, pending the owner's confirmation; recorded deviation: ops created while a protected op is ambient inherit the protection, so the writes, timers and follow-up requests its response causes are never acted on either. Presets for money and identity flows: `protectPreset("payments", "auth")`, or `"preset:payments"` / `"preset:auth"` strings; see packages/runtime/INTERCEPTION.md.)*
- **`crossOrigin`**: cross-origin requests are always passive, and this is not configurable. `"ignore"` treats all of them as `ignore`d.
- **`labels`**: the first match is attached as `scope.label`. Labels are sanitised to `[A-Za-z0-9 _-]`, at most 5 words and 40 chars. Anything else is stripped, with one warning. They appear in reports and sinks. They reach the model as `label (METHOD /path)` **only when `labelsToModel:true`**. Labels are names only. Only `policy.idempotencyHeaders` affects whether `retry` is offered, and no label text has any policy meaning.
- **`correlate`**: it is called once per op. Its result is redacted with `kind:"header"`, capped at 128 chars, and stored on `SinkRecord.correlationId` and `Report.correlationId`. **It never reaches the model or the gate.** A throw gives `undefined`.

**Precedence.** `ignore` comes first, then `protect`, then cross-origin. `protect` beats allow, heal, `eager`, thresholds and shadow (shadow records `wouldPass:false`). The hardcoded tracing-header skip list in `fetch.ts` stays.

**Hooks.**
- `observe/fetch.ts` (`parseRequest`, `installFetch`), `xhr.ts`, `websocket.ts`, `eventsource.ts`: call `host.scopeOf(req)` before `startOp`, then skip the hold when the op is protected.
- The situation op-label builder.
- `policy.ts` gate steps 1–3 and `permittedActions`.

**Tests.**
- An ignored URL → no OpRec and no added microtask.
- A protected POST in heal with `retry`@0.99 → passive with `protected`, and timing equal to baseline ±1 ms.
- A protected WS message is never discarded.
- A throwing protect predicate → protected.
- Cross-origin under heal → passive with `cross-origin`.
- A label with a newline, punctuation or 8 words is sanitised.
- With the default `labelsToModel:false`, the label is absent from the situation text.
- `correlate` output is on sink records and never in the situation.
- Same-origin relative URLs match `/api/*`.
- The match cache is hit on the second call.

### 4.5 `breaker` and `rt.breaker.reset()`
**Type** `BreakerOptions | false`. **Default** `{ undos:2, errorsAfterAction:3, attributionMs:5000, windowMs:600000, downgradeTo:"observe", persist:"session" }`. **It is on by default.**

**Semantics.** The breaker trips when either count is reached within `windowMs`:
- **`undos`** counts app or user calls to `ActionRecord.undo()`, plus late reverts the runtime flags itself. Undos from `rt.disable({undo:true})` and from the sim harness do not count.
- **`errorsAfterAction`** counts uncaught errors, unhandled rejections and failed requests (≥500 or a network error) on the **same subject** within `attributionMs` after a non-passive action on it. It correlates by subject and time only, which is a demotion signal and not a bug rule.

On a trip:
- The mode is capped at `downgradeTo`, and holds are released unchanged.
- A `breaker` event and a `breaker` record are emitted, with the decision ids and counts, plus one console warning.
- With `persist:"session"`, the trip survives a reload (try/catch).

Only `rt.breaker.reset()` clears a trip. `setMode` does not.

**Hooks.** New `decide/breaker.ts`. The `exec.ts` undo wrapper, `observe/errors.ts`, and `endOp` for errors. `computeScope()`.

**Tests.**
- 2 undos → capped at observe, the event fires, and the cap survives a reload.
- Errors on an unrelated subject → no trip.
- An error at 6 s with the default attributionMs → not counted.
- `attributionMs:10000` → counted.
- `false` → never trips.
- `reset()` restores the mode.
- `downgradeTo:"guard"` under heal → guard.
- Storage throws → the trip is kept in memory only.

### 4.6 `shadow`
**Type** `"guard" | "heal" | false`. **Default** `false`.

**Semantics.**
- For each decision, the gate re-runs **steps 1–6** at the shadow mode on the same model answer, with no extra inference and a dry-run limit check. Step 7 (veto) and step 8 (execute) are skipped.
- The result is stored on `Decision.shadow` and the `SinkRecord.shadow` field, and a `shadow` event fires.
- It is a no-op when the shadow mode is not above the effective mode.
- It ignores the sample, route and breaker caps on purpose, because it measures what the higher mode would do. It respects protect, cross-origin, op scope (step 3), allow/deny and thresholds.
- It prints to the console only under `debug`.

**Hooks.** `policy.ts gate(c, rate, g, { dryRun:true })`, `report.ts`, `summary.ts`.

**Tests.**
- guard + shadow heal → a would-act is recorded, nothing executes, and the limit counters are unchanged.
- A protected subject → `wouldPass:false, reason:"protected"`.
- Model call count is identical with and without shadow.
- shadow equal to the mode → no field.

### 4.7 `onBeforeAction` and `vetoMode`
**Type** `(a: ActionRequest) => boolean | void`, plus `vetoMode: "enforce" | "report"`. **Default** unset, `"enforce"`.

**Semantics.**
- The hook is called synchronously at gate step 7. Returning `false` or throwing vetoes the action: the passive action runs, with reason `vetoed`. `true` or `undefined` lets it proceed. Any other return value, including a Promise, also proceeds, with one warning.
- With `vetoMode:"report"`, the hook is called and its result recorded (reason `would-veto` on the decision and the sink record), but the action proceeds. Use this to try out a veto in staging.
- The call is timed. A warning is logged when it takes more than 5 ms (at most once a minute). Its time counts against the hold budget. If it pushes a held item past the budget, the item is released unchanged with reason `limit:hold`.
- It is not called for protected or cross-origin subjects, passive actions, observe mode, or shadow. It can only narrow.

**Hooks.** `decide/exec.ts`, just before `ctl.run(action)`.

**Tests.**
- false → `vetoed`.
- A throw → vetoed and logged.
- A Promise → proceeds and warns once.
- `report` mode with false → proceeds and records `would-veto`.
- A 10 ms hook → warning.
- A hook that exceeds the remaining budget → `limit:hold`.
- Not called for protected subjects.
- The decision id matches `explain()`.

### 4.8 `policy.actionLimits` (and deprecated `maxActionsPerMinute`)
**Type** `{ perMinute?, perSubject?, perSession? }`. **Default** `{ perMinute:60, perSubject:10, perSession:200 }`. (beta.1: perSubject raised from 5 to 10 per rolling minute after INSTALL e2e showed a typeahead hitting 5.)

**Semantics.**
- `maxActionsPerMinute: n` still works and maps to `actionLimits.perMinute`. If both are set, `actionLimits.perMinute` wins and a deprecation warning is logged once.
- `perSubject` counts non-passive actions per op signature or store path over a sliding 60 s.
- `perSession` counts actions over the page lifetime.
- When a limit is exceeded, the passive action runs with reason `limit:<kind>`, a `limit` event fires, and a warning is logged once per kind per minute.
- A coalesce or delay burst that answers one decision counts as one action.
- The docs note that a polling endpoint retried often may hit `perSubject:10`. Raise it for that subject class, or set it to `Infinity`.

**Hooks.** `policy.ts policyConfig` and `RateLimiter` (per-subject map plus a session counter), at gate step 6.

**Tests.**
- The alias keeps today's per-minute behaviour.
- An 11th action on the same subject within 60 s (and the 11th after the window slides is allowed) → `limit:perSubject`.
- The 201st action → `limit:perSession`.
- Shadow does not consume the limits.
- Window expiry restores the count.

### 4.9 `policy.holdBudgetMs` (semantics tightened)
**Type** unchanged: `number | "auto"`.

**Semantics.**
- The value is a **hard ceiling on total added latency per held item**, including deferred re-decisions and the time spent in `onBeforeAction`.
- The defer path computes `remaining = budget - elapsedHeld`. When `remaining ≤ 0`, the item is released unchanged with reason `limit:hold`.
- `"auto"` keeps its 150–800 ms clamp, and 800 ms becomes an absolute ceiling.
- A held item is released at `min(remaining, model.timeoutMs)`.

**Hooks.** The `exec.ts` defer path, `policy.ts holdBudget()`, and the observe hold release.

**Tests.**
- A model that always defers → total delay ≤ budget + 5 ms.
- Auto with slow latencies → ≤ 800 ms.
- Release is unchanged, with `limit:hold`.

### 4.10 `redact` (extended)
**Type** `(path, value, kind?) => unknown`.

**Semantics.**
- Built-in secret-name redaction always runs first. A custom function can only redact further, because it receives the already-redacted value.
- **`"url"`**: the default replaces query and fragment values with `…` and keeps the keys (`/search?q=…&page=…`). This applies **only to what the runtime records, labels, reports or shows the model. The URL actually sent is never modified.**
- **`"header"`**: header values, which have already had name-based redaction.
- **`"input"`**: DOM input values.
- `undefined` means `"state"`, so existing two-argument functions keep working.
- A throw replaces the value with `[redacted]`.

**Hooks.** The observe URL paths, `observe/dom-user.ts`, `trace/ops.ts`, `exec.ts host.redact()`.

**Tests.**
- A custom function cannot un-redact `auth.token`.
- `?token=abc&q=x` → neither `abc` nor `x` appears in situations, reports or sinks.
- The network request still carries `?token=abc&q=x`.
- A legacy two-argument function works.

### 4.11 `sinks` and `rt.summary()`
**Type** `Sink[]`. **Default** `[]`.

**Semantics.**
- Sinks are independent of `report`.
- Each `Report` maps to a `SinkRecord` (schema 1). By default the record is minimal: no situation text, no request URLs, no values, and only paths in `changed`; `route` is the page path normalised as telemetry sends it (id-like and email segments as `:id`, at most 200 chars). `evidence:true` adds redacted `message`, `trigger`, subject label and the `explain()` timeline.
- `kinds` filters records. `sampleRate` is deterministic per session (`hash(sessionId+index)`) and never drops `intervention`, `undo` or `breaker`.
- `possible: true` (0.3.0) also delivers "possible" detections (`SinkRecord.detection: "possible"`, §4.19); without it a sink, and every plain function sink, gets the likely ones only. The adapters take `possible` too; sinks by name never get possible ones.
- Dispatch is queued (a microtask batch, then `requestIdleCallback`) and never runs on the decision or hold path.
- Errors from a sink are swallowed, with at most one status event per sink per minute.
- On `pagehide`, or once on `visibilitychange→hidden` as a fallback, one `summary` record is emitted and each sink's `flush()` is called.
- `rt.summary().requests` (issue 94): request counts in total and per host (API.md). In a sink's `summary` record,
  `requests.hosts` is empty unless the sink sets `evidence: true` (host names are request URLs in part). Telemetry
  does not send `requests` (§4.21 proposes it).
- `rt.summary()` is always available. Two vendor-neutral adapters ship as entries of the package, outside the first-load bundle: `@genclass/runtime/sinks/{console-json,webhook}` (`src/sinks/`, each a function returning a `SinkObject` that never throws and sends only the record: one JSON line per record on the console, or batched POSTs to the URL the developer configures). The zero-code entries take them by name (`src/cdn/sinks.ts`: `window.GENCLASS_CONFIG.sinks: ["webhook:/genclass"]`, `<meta name="genclass" content="sink=console-json">`, `data-sink`, `init --sink`), as one proxy sink that queues records and loads the adapters on the first record, never before (`src/cdn/sinks-fanout.ts`, a lazy chunk of `/auto`; `dist/sinks/<name>.js` from the CDN for the script tag), so only the proxy is in the first load; a `webhook:<url>` is made absolute at init (against `document.baseURI`) and its endpoint (origin and path) joins `requests.ignore` as an exact match, and from a `<meta>` tag it must be same-origin as the browser resolves it (against the page and `document.baseURI`). Each adapter takes `evidence` (default true; false sends the structured fields only; `console-json:noevidence` in the no-code forms); the webhook caps repeats of one bug at `maxPerSignature` (10) per page load. A string in `GenClass.init({ sinks })` is ignored with one warning.
- No Sentry, PostHog or Datadog adapter (owner decision, 2026-10-13): forwarding to those tools is not part of the free runtime. The owner intends it as a paid, server-side feature; it is not built, and no plan on https://genclass.dev/pricing offers it yet. A page config that names `sentry`, `posthog` or `datadog` (any case, with or without an option) gets one console warning for them all that says so, with https://genclass.dev/pricing, and nothing is loaded or sent for those names (`applySinks`); `init --sink sentry` is a usage error that says the same.

**Hooks.** `report.ts` (`toSinkRecord`, `SinkDispatcher`), the new `decide/summary.ts`, and a pagehide listener in `runtime.ts`.

**Tests.**
- Three sinks and the console all receive records.
- A throwing sink, or one whose Promise takes 2 s, does not delay a hold release.
- Snapshot of the default record: no request URL (the page path only, normalised) and no situation text.
- `evidence:true` adds fields that are still redacted.
- `sampleRate:0` still delivers interventions.
- pagehide → exactly one summary and `flush` called.
- Schema field-presence snapshot.

### 4.12 `session` and `rt.setSession()`
**Type** `{ id?, tags? }`. **Default** a random UUID and `{}`.

**Semantics.**
- The id and tags are stamped on every SinkRecord, on `Report.session` and in `explain()`.
- `setSession` merges tags and replaces the id. The change applies to later records only, and the sample bucket stays frozen.
- Tags pass through `redact("session.tags.<k>", v, "state")`. They are capped at 20 keys and 64 chars per key and value. **Tags never enter the situation or the gate.**
- The docs warn against putting PII in tags.

**Tests.**
- Tags appear on records.
- A tag named `apiKey` is redacted.
- Situation text never contains a tag value.
- The caps are enforced.

### 4.13 `report` (extended)
**Type** `"console" | "interventions" | "silent" | fn`. **Default** `"console"`.

**Semantics.** `"interventions"` prints only actions, undos, breaker trips and runtime errors. **The filter applies to the console printer only.** `report: fn` and sinks always receive every record. `debug:true` adds every decision. There is no environment sniffing.

**Tests.**
- A detection is not printed under `"interventions"`, but sinks still receive it.
- An intervention is printed.

### 4.14 `learn` (extended) and `rt.learn.clear()`
**Type** `{ persist?: boolean|"local"|"session"; key?; version?; maxBytes?; expectations?; minSupport?; minShare?; minSessions? }`. **Defaults** `expectations: false` (opt-in in 0.3.0 until its false-report rate is measured; off, src/learn/flows.ts is never loaded and nothing is stored); `persist` unset: with `expectations: true` the learned flows (reporting only) are stored in localStorage, and transition profiles stay in memory either way (see `docs/runtime/EXPECTATIONS.md` §4); `key:"genclass:learn"`, `version` equal to `session.tags.release` **as read once at init**, `maxBytes:200000`.

**Semantics.**
- `true` means `"local"`, which matches the 0.2.2 behaviour for transition profiles, and stores the flows too. `false` stores nothing.
- Unset in jsdom / happy-dom, or with storage that throws on a probe write: nothing is stored.
- The stored value also carries a format number and the runtime version; a mismatch of either discards it.
- If the stored version differs from the configured one, the stored state is discarded at load. A later `setSession` change does not reload it.
- `rt.learn.clear()` clears both storage and memory.
- All storage access is wrapped in try/catch.

**Hooks.** A new `learn/store.ts`, used by profiles, baselines and cadence.

**Tests.**
- A version mismatch → baselines empty.
- `clear()` empties storage and memory.
- Two runtimes with different keys do not collide.
- Storage throws → in-memory only.
- Changing the release tag after init → no reload.

### 4.15 `model.loadIf` and `model.inlineFallback`
**Defaults** `loadIf: { minDeviceMemoryGB: 4, saveData: "skip" }` (0.3.0; 0.2.x: `{ saveData: "lazy" }`), `inlineFallback: true`.

**Semantics.**
- `loadIf` is evaluated before the ModelHost is constructed. Unknown device values count as allowed, and a throwing predicate counts as allowed, with a warning.
- The default is a device floor: the model (10 MB on the wire, a worker of 190 to 280 MB) is not loaded on devices whose `navigator.deviceMemory` is under 4 GB, nor on Save-Data connections. `deviceMemory` is quantised to powers of two (0.25 … 8), so the floor skips exactly the devices reporting 2 GB or less; browsers that do not report it (Safari, Firefox) load. `model: { loadIf: () => true }` forces the load.
- `false` or `"skip"` → no download, `status.state="skipped"` with a reason (`device-memory`, `save-data`, `loadIf`), the runtime behaves as if `model:false` (observes without a model) and prints one console status line saying so (`[GenClass] Model not loaded: …`; silent with `report: "silent"`).
- `"lazy"` → `preload` is forced to `"lazy"`.
- `inlineFallback:false` → if the worker cannot be created or fails before it is up, ORT does not run on the main thread: the state is `skipped` with reason `worker-unavailable` and one console line names the worker error. `worker:false` still runs inline (explicit).
- `loadIf` never affects decisions.

**Tests.**
- A 2 GB device (and 1, 0.5, 0.25) with the default → skipped; 4 GB, 8 GB and unknown → load; Save-Data with the default → skipped.
- `minDeviceMemoryGB:4` with a 2 GB device → skipped, with zero model fetches.
- Unknown device memory → loads.
- `loadIf: () => true` on a 0.5 GB Save-Data device → loads.
- A worker failure with `inlineFallback:false` → no ORT on the main thread, `skipped` / `worker-unavailable`.

### 4.16 `model.threads` and `model.timeoutMs`
**Defaults** `"auto"` = `min(4, max(1, cores-1))`, and `10000`.

**Semantics.**
- Both are the internal host options, now public.
- On a timeout, held items are released unchanged and background items are dropped.
- `situation.budget:"auto"` follows the thread count.
- `decider.ts MAX_QUEUE` imports the host's constant.

**Tests.**
- `threads:1` → ORT gets 1 thread and the auto budget is 1000.
- `timeoutMs:50` with a slow mock → released unchanged and no action.

### 4.17 `model.maxDecisionsPerMinute`
**Default** `30`. `Infinity` disables it.

**Semantics.**
- The limit is a sliding window over model evaluations.
- Over the limit, background situations are dropped, and held items (including writes held under `holdWrites`) are **released unchanged at once without evaluation**, so writes never wait on the limit.
- Cache hits are free.
- A `modelBudget` event fires at most once a minute, and `status.modelBudget` and `summary.model.dropped` are updated.

**Hooks.** A check in `decider.ts submit()`.

**Tests.**
- 100 salient situations a minute → ≤ 30 model calls.
- A held item over the limit is released in about 0 ms.
- The event is rate-limited.

### 4.18 `model.unloadAfterIdleMs`
**Default** `false`.

**Semantics.**
- The idle timer resets on every evaluation, and time with the tab hidden counts as idle.
- When the timer fires, the worker and session are torn down and the state becomes `"unloaded"`.
- The next situation reloads the model from `cacheName`: "unloaded" counts as consultable (like "off" for a lazy model), so the next salient situation in a visible tab asks for `ready()` again (until 0.3.0 it did not, and detection stopped for the rest of the page load after the first unload; guard and heal now act again after the reload). A hidden tab never asks: hidden-tab situations are deferred (§5.3) and the tab becoming visible asks for the model. During the reload, held items are released unchanged (failOpen `not-ready`); in observe the situation is deferred (§5.3) and decided once the model is back.

**Tests.**
- Idle → worker terminated, and the reload comes from the cache with no network.
- A held item during the reload is released unchanged.
- Runtime level (`test/deferred.test.ts`): after an unload the next salient situation reloads the model; in observe it is decided once the model is back, in guard it fails open and the next one is decided; a second unload reloads again; a hidden tab polling through an unload never reloads it, and the tab becoming visible reloads it and decides the queue.

### 4.19 `detect` (0.3.0)
**Type** `"likely" | "possible"`. **Default** `"possible"` where the subject's effective mode is `observe` and the app set no `policy.thresholds.report`; `"likely"` otherwise.

**Semantics.** Reporting only; no action gate reads it.
- A decision whose top diagnosis is not `expected` is a **likely** detection when its probability is at least the report gate (`gates().report`: the aggressiveness profile's `report` from the model meta, 0.90 at balanced with model 0.2.0; `policy.thresholds.report` when set), as before 0.3.0.
- With `"possible"`, it is a **possible** detection when its probability is at least the eager profile's `report` from the same meta (0.70 with model 0.2.0; `gates().possible`) and below the report gate. No possible tier when the meta has no lower eager value.
- `Decision.detection` records the tier when the decision is made; `explain()`, the console, the devtools (live, from `decide`, and backfill) and telemetry read it. A deferred situation's decision (§5.3) is possible at most.
- Likely: the console line and group, the `detect` event, `report` listeners and a `report` function exactly as before. Possible: the same line ending in `(possible)`, with `console.debug` only (hidden at Chrome's default level; repeats fold per tier), a dimmed devtools card left out of the badge counts and without the pill's pulse, `summary().possibleDetections`, the telemetry `detect` event with `tier: "possible"` (`summary.counts.possibleDetections`), and `rt.on("decide")` with `detection: "possible"`. The `detect` event, `report` listeners and a `report` function get possible ones only when `detect: "possible"` is set explicitly; sinks only with `possible: true` (§4.11), whatever `detect` says.
- The meta tag and `data-*` attributes take `detect=likely` / `detect=possible`.

**Tests.** `test/detect-tiers.test.ts`, `test/detect-tiers-devtools.test.ts`.

### 4.20 `visual` (measured visual checks)
**Default** `"local"` with `GenClass.init()`, `/auto` and the script tag in a browser; `false` with `createRuntime()`.
Design, every check and threshold: [VISUAL.md](VISUAL.md). Types: `VisualOptions`, `CheckKind`, `CheckFinding`,
`VisualSummary` in `types.ts`.

**Semantics.**
- `false` (or `?genclass-visual=off`): nothing is installed, no listener, no timer, no download.
- `"local"`: on for development hosts (`devHost` in `src/visual/start.ts`: http(s) on `localhost`, `127.0.0.1`,
  `[::1]` or a `*.localhost` name with an explicit port, or a `*.test` name; narrower than telemetry's `isLocalHost`,
  so Capacitor, Tauri, Electron and intranet hosts are off) and when the devtools overlay mounts or `rt.checkNow()`
  is called; off otherwise. `?genclass-visual=on` turns it on for that page load, report-only.
- `true` / `{ on: true }`: on everywhere, report-only unless `fix` is set.
- `fix: true` (or a list of `"text-invisible"`, `"pointer-events-leak"`, `"scroll-lock-stuck"`) needs `on: true` and an
  effective mode of guard or heal; a sampled-out session never fixes. A URL can never turn fixes on.
- The checks are measurements reported as kind `"check"`: they never change `effectiveMode`, never feed a decision,
  the gate, the breaker, a situation, a fact or the event log. In observe mode the page is never written to.
- `enabled` false or pending, a hidden tab or a prerendered page: no chunk download. A route whose mode is `"off"`:
  no checks there. `disable()`, `destroy()` and `setMode("observe")` undo every fix at once, `pause()` within 2 s.

`checks.stallMs` (after 0.3.0-beta.1, issue 94): how long a `fetch` or XHR request may stay pending before the
`request-stalled` check reports it; default 15,000, clamped to 1,000..600,000 (VISUAL.md 3.24).

**Precedence.** `?genclass-visual=off` > an explicit `visual: false` > `?genclass-visual=on` > the `"local"` default.

**Tests.** `test/visual-options.test.ts` (resolution, load timing, enabled pending), `test/visual-fix.test.ts` (the
fix gate, undo), `test/visual-purity.test.ts` (no effect on situations, history or decisions),
`test/browser/visual/visual.spec.ts` (Chromium, the CI `visual-browser` job).

### 4.21 PROPOSED, not implemented: `requestTimeoutMs` (heal), request health in telemetry, a dashboard alert

**Status: proposed in the issue 94 pull request; nothing below is in the code. Each part needs the owner's OK** (the
timeout because of AGENTS.md rules 1 and 2, the telemetry fields and the alert because of rule 8). What shipped for
issue 94 is local only: `rt.summary().requests` (API.md) and the `request-stalled` check (VISUAL.md 3.24).

**`requestTimeoutMs` (heal only).** `GenClass.init({ mode: "heal", requestTimeoutMs: 15000 })`, or
`{ ms, methods?: string[] }` (default methods `GET` and `HEAD`). Default off.

- *When.* Only where the request's effective mode is heal (route rules, sampling and the breaker apply as for every
  action); never in observe or guard; never for protected requests (`requests.protect`), GenClass's own requests,
  EventSource, WebSocket, or a signature the cadence layer knows as long-lived (the same exclusions as
  `request-stalled`); never for a method outside `methods` (a timed-out POST may still commit on the server, and the
  app's retry would then submit twice).
- *How.* fetch: the observer creates an `AbortController` per request and passes the native fetch a signal that
  aborts when either it or the app's own signal does (`AbortSignal.any([app, ours])`, or a listener on the app's
  signal where `any` is missing); a `Request` input is rebuilt with that signal, as retries already rebuild one. At
  `ms` on the injected Clock it calls `abort(new DOMException("GenClass requestTimeoutMs (15000 ms)", "TimeoutError"))`,
  so the app's promise rejects with a `TimeoutError` and its own `catch` and `finally` run: the spinner stops and the
  button is enabled again by the app's code, not by GenClass. XHR: when the app set no `xhr.timeout` (0), GenClass sets
  it before `send()`, so the browser fires `timeout` and `loadend` to the app's handlers; an app's own timeout is
  never changed.
- *Logged.* As an intervention: a console line (`[GenClass] Timed out GET api.example.com/v1/forecast after 15.0 s
  (requestTimeoutMs, heal): the app's catch and finally ran.`), a `Report` of kind `"intervention"` with action
  `"timeout"`, a sink record, `summary().interventions.timeout`, an audit entry of kind `"action"` whose `gate` says
  `source: "option"` (no model probability), and the op's `x-genclass`-style marker in `rt.explain()`.
- *Undone.* An aborted request cannot be un-aborted, so this is the one heal behaviour with no per-action undo:
  `setMode("observe" | "guard")`, the breaker, `pause()`, `disable()` and `destroy()` cancel every pending timeout at
  once (requests already in flight then run to their natural end), and the breaker counts errors that follow a
  timeout like errors that follow any action.
- *Why it needs the owner.* It acts without a model decision: the policy gate never sees it (rule 1), and a fixed
  "pending past N ms, abort" is an if/then from a measurement to an action (rule 2). The precedent is the visual
  checks' opt-in fixes (owner, 2026-10-13: measured, opt-in, reversible, never in observe). The alternative that keeps
  rules 1 and 2 as they are, giving the model an `abort` action on the existing `stall` trigger, changes the action
  vocabulary, which is model-visible text: a new situation tag, regenerated data and retraining (rule 3).

**Request health in telemetry.** A `runtime.requests` object on the summary event, built from `summary().requests`:
the totals (`requests`, `2xx`..`5xx`, `network`, `aborted`, `notJson`, `byGenClass`) and `latency` (`p50`, `p95`,
`n`), and the same per host for at most 10 hosts by request count (`"same-origin"` for the page's own origin, else
the bare host name; the rest folded into `"other"`). Never paths, queries, headers, bodies or the `request-stalled`
findings. Every opt-out keeps working (`telemetry: false`, `?genclass=no-telemetry`, localStorage, GPC), plus
`telemetry.include: { requests: false }`. What widens: the host names of the APIs a page calls. When approved:
TELEMETRY.md, both READMEs, the CHANGELOG, the console notice check and the collector's schema.

**Dashboard alert.** In the collector (telemetry-worker), per app and host, over a sliding hour: alert when at least
20 requests from at least 3 sessions show an error share (`5xx` + `network` + `notJson`, over `requests`) of 20% or
more, or a p95 latency of at least 3 times the host's 7-day median p95. Delivered to an email address or a webhook the
app owner sets in the dashboard, at most once per host per 6 hours, with the counts and a link to the app's page. It
depends on the telemetry fields above.

## 5. Built-in behaviours (no option)

1. **Hidden tabs.** While the tab is hidden:
   - guard and heal: background situations are neither built nor evaluated, and `summary.model.hiddenSkipped` counts them;
   - **held items are released unchanged at once, without evaluation**, so nothing waits behind a throttled worker;
   - observe (0.3.0; nothing is held there), where the possible tier is in force (§4.19): each salient situation is built at once, from the state at its trigger, and kept (§5.3) until the tab is visible again (`visibilitychange`), then decided in order, at the possible tier at most. Only the ones dropped from the full queue count in `summary.model.hiddenSkipped`. A hidden tab never starts loading or reloading the model; the tab becoming visible does. Before 0.3.0 observe skipped them like guard does, and with `detect: "likely"` it still does;
   - observers keep recording.

   Test: hidden polling in guard → zero model calls, holds released in about 0 ms, timeline still recorded; in observe → decided, in order, after `visibilitychange` (`test/deferred.test.ts`).
2. Internal buffers stay bounded by `historySize`.
3. **Deferred situations (observe only, 0.3.0).** Where the subject's effective mode is observe and the possible tier is in force (§4.19; not with `detect: "likely"` or an explicit `policy.thresholds.report`), a salient situation that cannot be decided yet, because the model is loading (or reloading, §4.18; a lazy model starts loading then, from a visible tab only) or the tab is hidden, is built at its trigger and kept in a queue of at most 32 (`DEFERRED_MAX`). It is built at the situation budget in force then: an automatic budget is the smallest one (1,000 characters) while the model's device is not known yet. When the model is ready and the tab visible (the `ready` resolution, `visibilitychange`, `resume()`, or the next fresh decision, which is submitted first) they are decided one at a time, oldest first, as background decisions with a detection-only deadline (30 s from submission, `DEFERRED_DEADLINE_MS`; the provider timeout still applies), gated as observe whatever the mode is by then: a deferred situation never acts, and one whose subject's effective mode is no longer observe is dropped. Its detection is reported at the possible tier at most (a likely one is recorded as possible) until a cold-start and hidden-tab clean run measures the false-report rate of these late decisions (RESULTS.md §11). Its telemetry decision record carries the page path at its trigger. A delivery covers its chain's writes while it waits, like any background delivery decision. The oldest is dropped when the queue is full, counted as failOpen `not-ready` (or `hiddenSkipped`, for one that waited for the tab); all are dropped, counted, when the model fails (`error`, `skipped`). Guard and heal never defer and, as before 0.3.0, build no situation while the model loads (a background decision there can still late-revert); an `unloaded` model is consultable like a lazy `off` one, so the first salient situation after an idle unload fails open as `not-ready` and starts the reload.

## 6. Precedence cheat-sheet

```
requests.ignore         → not observed at all
enabled false/pending   → off / pass-through; beats URL overrides; rt.disable({undo}) rolls back
requests.protect        → passive always, never held, not a target, no onBeforeAction
cross-origin            → passive always
op scope off/observe    → never an action target (notOffered)
effectiveMode           = min(mode|setMode|URL*, sample cap, breaker cap, route rule)  (snapshot per op)
effectiveAggressiveness = min(global|setAggressiveness|URL*, route rule); explicit policy.thresholds win
                          *URL overrides (mode, aggr, sample) demote only unless debug:true
policy.allow/deny       → unchanged, at effective mode
policy.actionLimits     → limit:perMinute / perSubject / perSession
onBeforeAction          → final sync veto (vetoMode "report" = record only); over hold budget → limit:hold
holdBudgetMs            → hard ceiling incl. defers + hook; release at min(remaining, timeoutMs)
shadow                  → gate steps 1–6 at higher mode, dry-run; ignores sample/route/breaker caps
visual                  → measurements only; ?genclass-visual=off > visual:false > ?genclass-visual=on > "local";
                          fixes need visual.on true + fix + effective mode guard/heal; never feeds the gate
model.loadIf / maxDecisionsPerMinute / timeoutMs / unload / hidden tab → availability only; held items release unchanged
                          (observe: situations raised while loading or hidden are deferred and decided later, §5.3)
detect                  → which detections are reported (likely / possible); reporting only
status.mode = requested; status.effectiveMode / Report.mode / SinkRecord.mode = effective
```

## 7. README / API.md text

> ### Configuration
>
> GenClass runs with safe defaults (`mode: "observe"`, a `"balanced"` gate that applies once you opt into guard or heal, circuit breaker on). The options below narrow where it acts, cap how much it does, and send findings to your tools. None of them tell the model what a bug looks like. They only scope and limit it.
>
> - **Activation**: `enabled` (a boolean, a predicate, or a subscribable feature flag; while it is false the model is never downloaded), `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the fraction of sessions allowed to act; the rest only observe).
> - **Scope**: `routes` (per-route mode and aggressiveness, which can only be lowered), `requests.ignore` (analytics traffic), `requests.protect` (endpoints that are never held, retried, cached or discarded), `requests.labels` (endpoint names for reports), `requests.correlate` (attach your trace id to records).
> - **Safety**: `breaker` (automatic downgrade after undos, or after errors that follow an action), `shadow` (records what a higher mode would have done), `onBeforeAction` + `vetoMode` (a synchronous veto, or a report-only trial of one), `policy.actionLimits` (per-minute, per-subject and per-session caps), `policy.holdBudgetMs` (a hard ceiling on added latency).
> - **Telemetry**: `sinks` (structured, redacted records), `session` (id and tags, never shown to the model), `report: "interventions"` (a quiet production console), `rt.summary()`, `rt.on("shadow" | "breaker" | "limit" | "modelBudget", cb)`.
> - **Loading and cost**: `model.loadIf`, `model.threads`, `model.timeoutMs`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.
>
> URL overrides (`?genclass-mode`, `?genclass-aggr`, `?genclass-sample`) can only lower settings, unless `debug: true` is set.
>
> ```ts
> import { init } from "@genclass/runtime";
>
> const rt = init({
>   mode: "guard",
>   aggressiveness: "cautious",
>   enabled: {                                         // live feature flag; flipping off disables mid-session
>     get: () => flags.isEnabled("genclass") && consent.analytics,
>     subscribe: (cb) => flags.onChange("genclass", cb),
>   },
>   sample: 0.1,                                       // 10% of sessions act, 90% observe
>   routes: [
>     { match: "/checkout/*", mode: "observe" },
>     { match: /^\/admin/,    mode: "off" },
>   ],
>   requests: {
>     ignore:  ["https://www.google-analytics.com/", /sentry\.io/, "*/rum/*"],
>     protect: ["/api/auth/", "/api/payments/", (r) => r.method !== "GET" && r.url.includes("/billing")],
>     crossOrigin: "observe",
>     labels: [{ match: "/api/orders", label: "place order" }],   // reports only by default
>     correlate: (r) => r.headers["x-request-id"],
>   },
>   breaker: { undos: 2, errorsAfterAction: 3, attributionMs: 5000, downgradeTo: "observe" },
>   shadow: "heal",
>   onBeforeAction: (a) => !(cart.isSubmitting && a.tier === "heal"),
>   vetoMode: "enforce",
>   policy: { actionLimits: { perMinute: 30, perSubject: 3, perSession: 100 }, holdBudgetMs: "auto" },
>   report: import.meta.env.PROD ? "interventions" : "console",
>   sinks: [
>     { send: (r) => navigator.sendBeacon("/genclass", JSON.stringify(r)),
>       kinds: ["intervention", "undo", "breaker", "summary"] },
>     { send: (r) => myLogger.info("genclass", r), sampleRate: 0.2 },
>   ],
>   session: { tags: { release: __RELEASE__, tenant: tenantTier } },
>   learn: { persist: "local", key: "genclass:shop" },  // version = session.tags.release at init
>   model: {
>     preload: "idle",
>     loadIf: { minDeviceMemoryGB: 8, saveData: "skip" },   // default { minDeviceMemoryGB: 4, saveData: "skip" }
>     threads: 2,
>     timeoutMs: 10_000,
>     maxDecisionsPerMinute: 30,
>     unloadAfterIdleMs: 300_000,
>   },
> });
>
> rt.on("breaker", (e) => log.warn("genclass downgraded", e));
> onLogin((u) => rt.setSession({ tags: { plan: u.plan } }));
> onLogout(() => rt.learn.clear());
> onIncident(() => rt.disable({ undo: true }));
> ```
>
> **Recommended `requests.protect` starter** (it is not built in; adapt it to your endpoints):
> `[/\/(auth|login|logout|oauth|token|session)\b/, /\/(payment|checkout|billing)\b/]`
>
> **Rollout recipe:** start with `mode: "observe", shadow: "guard"`, and compare the shadow records with your undo and complaint rates. Then switch to `mode: "guard", sample: 0.05`. Watch `rt.summary().undos` and `breaker` events, and widen `sample` as they stay quiet. For QA, `?genclass-sample=1` together with `debug: true` forces a session into the acting group.

## 8. Migration and compatibility

- **Nothing breaks.** `report` widens, and `redact` gains an optional third argument. `maxActionsPerMinute` stays as a deprecated alias of `actionLimits.perMinute`.
- **Behaviour changes, all toward safety (changelog):**
  1. `breaker` is on by default. Opt out with `breaker:false`.
  2. New `perSubject:10` (per rolling minute) and `perSession:200` limits. Opt out with `Infinity`. This may suppress frequent retries on polling endpoints.
  3. `holdBudgetMs` is now a hard ceiling that includes defers and `onBeforeAction` time.
  4. `model.loadIf` defaults to a device floor: no model on devices reporting 2 GB or less or on Save-Data connections (`{ minDeviceMemoryGB: 4, saveData: "skip" }`; the earlier draft said `saveData:"lazy"`).
  5. Hidden tabs skip background evaluation and release held items immediately (counted in `summary.model.hiddenSkipped`). 0.3.0: in observe they are deferred and decided when the tab is visible again (§5.1, §5.3).
  6. Query and fragment values in recorded URLs are now `…` in situation text. **Model input changes, so add this to the eval plan and re-measure accuracy before release.** Sent URLs are unchanged.
  7. URL overrides can no longer raise mode or aggressiveness without `debug:true`.
  8. Ops created under `off`/`observe` route scope can no longer be action targets.
- **Renames from the earlier draft:**

  | Earlier draft | Final |
  |---|---|
  | `protect` (top level) | `requests.protect` |
  | `model.when` | `model.loadIf` |
  | `budget:*` reasons | `limit:*` |
  | `hold-cap` reason | `limit:hold` |
  | `budget` event and status (model) | `modelBudget` |
  | sink kinds `detect`/`intervene` | `detection`/`intervention` |
  | `rt.resetBreaker()` | `rt.breaker.reset()` |

- **CONTRACT.md:** §2 gets the options, §7 the gate order from §0.4, and §8 the SinkRecord schema 1 and `RuntimeEvents`.
- **Files:**
  - **Hook points:** `types.ts`, `runtime.ts`, `auto.ts`, `decide/{policy,exec,report,decider}.ts`, `observe/{fetch,xhr,websocket,eventsource,nav,errors,dom-user}.ts`, `model/{host,backend}.ts`, `learn/*`.
  - **New files:** `util/match.ts`, `decide/breaker.ts`, `decide/summary.ts`, `learn/store.ts`.

Nothing was run. This spec comes from reading `packages/runtime/src/types.ts`, `docs/runtime/API.md`, the README and the CONTRACT sections. `types.ts` gives `"balanced"` as the default aggressiveness, so the README text now says "balanced". `API.md` already has `rt.on`, and the new events extend it.

## Dropped proposals

- [dx] env / preset: Auto-detecting the environment from hostname or NODE_ENV is magic that will silently go wrong (tunnels, staging), and production behaviour would change on upgrade. The defaults are already the safe production profile (guard, cautious), and dev is just mode:'observe', debug:true. A docs snippet works better than another layer of option resolution. A ?genclass-mode URL override is a production safety risk.
- [safety] policy.rules: This is a second policy language with ordering semantics, and a misordered rule can quietly widen permissions. protect already covers the main safety need, and per-scope mode/allow is rarely needed. If scoping is ever needed it should be narrow-only (deny-only), but leave it out for now to keep the library simple.
- [safety] rollout: Developers can hand-roll this in two lines around init (mode: inCohort ? 'guard' : 'observe'), and a key() hook adds a PII risk. It is better as docs, or a plugin that tags reports with the cohort.
- [integrations] devtools: mountDevtools already exists; an auto-mount with URL/localStorage flags exposes internals to end users in production and adds dev-build detection heuristics. A one-line conditional import is not burdensome. Better kept as the explicit opt-in subpath export (could document an `if (import.meta.env.DEV)` snippet).
- [perf] historySize (extend to per-buffer limits): Per-buffer limits and a byte cap are internals that almost no developer would tune. Bound the ops, store-version and report buffers internally in proportion to historySize, and show memory use in status. The existing number is enough.
- [perf] observe.sample: Body-size and rate limits on recording should be built-in safe defaults (a body cap and per-socket rate limiting, with a 'sampled' marker), not public options. timers 'long-only' starts to look like a heuristic rule. Developers who need more control can still turn individual observers off with observe.*.
