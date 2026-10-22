# GenClass Runtime: architecture

GenClass Runtime (`@genclass/runtime`) is a browser library. It watches what a web app does (requests, pushed
messages, user actions, timers, state writes, errors) and, for the few situations that look risky, asks a small
on-device model whether something is going wrong and what to do. This page explains how the parts fit together and
why they are built this way, for `@genclass/runtime` on `main` (version string 0.3.0-beta.0, plus the changes the
CHANGELOG lists under 0.3.0-beta.1, unreleased; npm `latest` is 0.2.2, `beta` is 0.3.0-beta.0) with model
`@genclass/runtime-model` 0.2.0. Items marked 0.3.0 are in the 0.3.0 line (0.3.0-beta.0 and later) and not in
0.2.x. How to use it: [API.md](API.md). Binding rules: [CONTRACT.md](CONTRACT.md). Every measured number:
[RESULTS.md](RESULTS.md). Terms: the [glossary](README.md#glossary).

## Design principles

1. **No hardcoded bugs.** The runtime contains no rule like "if a stale response arrives, drop it". It computes
   generic facts and asks the model. Every app gets the same kinds of facts: happens-before order, versions,
   repetition, failure streaks, latency against learned baselines, learned relations between fields and learned
   transition profiles. The diagnosis and the action come from the model. The measured visual checks are the one
   documented exception, and they stay outside the model ([What runs outside the
   model?](#what-runs-outside-the-model)).
2. **Precision first.** A false intervention costs more than a missed bug. The default `observe` mode only
   reports. The opt-in `guard` mode takes only minimal actions, and only when the model's gate clears and its own
   diagnosis says something is wrong. `heal` is experimental.
3. **Observable.** Every detection and intervention is reported in plain English with its evidence, can be
   explained after the fact, and can be undone where possible. A kill switch (`?genclass=off`) rules GenClass out
   in one step.
4. **Cheap by default.** Facts are cheap and always on. The model runs only for salient situations, off the main
   thread, with a situation sized to the device.
5. **Train what you run.** The training data comes from the real runtime code, so the model sees exactly the text
   it will see in production.

<a id="data-flow"></a>

## How does data flow through the runtime?

```
 app code ──► observers ──► trace (events, ops, causality) ──► stores (field versions)
                                   │                                │
                                   ▼                                ▼
                 learned baselines, cadence, relations between fields, transition profiles
                                   │
          trigger (a response or pushed message about to reach the app, a state write, a request about
                   to be sent, a failure, a stall, a broken relation, an unusual transition, an error,
                   a developer question)
                                   │
                                   ▼
                        facts ──► triage ──(salient)──► situation + standing questions
                                   │                                │
                             (not salient)                          ▼
                                   │                 model host (Web Worker, ONNX on WebGPU or WASM)
                                   ▼                                │
                            passive action                          ▼
                                                    answers: diagnosis + action probabilities
                                                                    │
                                                                    ▼
                         policy gate (protection, mode, allow/deny, diagnosis, model gate, limits, veto)
                                                                    │
                                                                    ▼
                                    action (or passive) ──► report / explain / undo / audit / events
```

### Observers and the trace (`src/observe`, `src/trace`)

- **Instrumented sources:** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, the timers, DOM user events
  (capture phase, trusted events only unless `observe.untrustedEvents` is set), errors and unhandled rejections,
  history navigation, storage (key names only) and long tasks.
- **Operations:** every asynchronous operation becomes an *op* with a signature (`GET /api/items/:id`), a cause and
  a root. User actions are instantaneous ops, so they can be causes.
- **Causality across `await`:** an "ambient op" is set during user handlers and `rt.op`, re-established when a
  wrapped request or its body settles and inside timers scheduled during an operation, and cleared after the task.
  State writes record the ambient op as their cause. This is best effort, and it is enough to say "this write
  comes from the response to the request the user started by typing *rea*".

<a id="stores-and-the-mutation-pipeline-srcstate"></a>

### Where are decisions made? The network boundary and the stores (`src/observe`, `src/state`)

- **Writes apply at once by default** (`policy.holdWrites: false`). `set(x); get()` returns `x`, and writes to one
  store apply in the order they were made.
- **Decisions happen at the network boundary** (the `delivery` trigger). GenClass predicts which fields a response
  (fetch, XHR) or a WebSocket or EventSource message will write, from what the same operation wrote before, and
  decides only when it would overwrite newer data, put back the value of an unconfirmed local change, or replace
  text the user typed meanwhile. In guard and heal, when an action is permitted and the model can answer within the
  hold budget, the delivery waits for the model, which may deliver it, drop the writes it makes over newer data
  (`discard`), or hold it until related requests finish and decide again (`defer`, at most twice). Holding only adds
  latency, at most the hold budget, and messages of one socket or stream keep their order. In observe, and whenever
  no hold is possible (no permitted action, the model not ready or not expected to answer within the hold budget),
  the delivery is released at once, exactly as without GenClass, and decided in the background (`runDelivery` in
  `runtime.ts`).
- **Late revert.** A write that looks wrong on its own (the `mutation` trigger, not covered by a delivery decision)
  is decided in the background. If the model answers `discard` and the gate clears (guard or heal), the write is
  reverted only within 800 ms of applying (`LATE_REVERT_MS` in `runtime.ts`), if nothing has overwritten it and the
  same operation chain has written nothing else since. A late revert is reported as such and can be undone.
- **Why not hold store writes?** The first design (v1) held salient writes from asynchronous code until the model
  answered. With a model that always chose the passive action, it still changed 4 of 198 clean real-app runs, the
  React/Redux RealWorld app never rendered its home feed, and the demos showed card jump-backs and overwritten
  keystrokes. Deciding at the network boundary (v2) changed 0 of 396 clean runs (66 real apps × 6 seeds, runtime
  0.1.0-alpha.1, compared with observe mode and not re-run since; with network chaos 3 of 198 runs changed;
  [RESULTS.md section 4](RESULTS.md#4-never-make-a-correct-app-worse-runtime-design-comparison)). The later
  compatibility matrix, which compares every mode with no GenClass, found 0 bugs introduced in 3,510 runs
  ([section 16](RESULTS.md#16-compatibility-matrix-summary)). Holding writes is still available as an opt-in,
  `policy.holdWrites: true`; even then, writes made synchronously by a user handler apply at once unless
  `policy.holdUserWrites: true` (`src/state/hub.ts`).
- **Field versions:** state registered through `atom`, `guard` or the Redux, Zustand and React adapters, or found
  by automatic state discovery, gets per-field versions with writer history. Discovered React and Zustand state is
  observed only: GenClass never holds, drops, reverts or rolls back its writes.
- **Relations between fields** (`src/state/invariants.ts`): at settled points the runtime learns relations that
  keep holding, such as `total == sum(price·qty)`, `count == len(items)` and membership. A learned relation that
  breaks raises an `inconsistency`.
- **Transition profiles** (`src/learn/profiles.ts`): these learn which fields each operation usually writes. A
  deviation such as "wrote only `cart.items`, unlike the last 317 times" raises a `transition`.
- **Baselines and cadence** (`src/learn/baselines.ts`, `src/learn/cadence.ts`): latency, error rate and failure
  streaks per request signature, and whether a signature runs on a schedule (polling, debounced saves), so the
  model can tell whether a stale value will be replaced by itself soon.

### Situations and triage (`src/situation`)

- **Situation:** a Jev-style state object with `app`, `trigger`, `facts`, `in_flight`, `timeline`, `state` and
  `stats`, plus two standing questions:
  - `diagnosis`: expected, stale, conflict, duplicate, inconsistent, failing, transient, slow, overload or unusual;
  - `action`: one option per applicable generic action, with its description.
  The format is frozen under the tag `situation-v2.3`: any change to it means new training data and a new model.
- **Facts:** short sentences with explicit relations and numbers, for example "written once by other operations
  since this write's cause started (v0 → v1), last 0.69 s ago by GET …?q=reac, which started 0.09 s after it,
  from a later user action".
- **Triage:** the model is asked only when some fact is non-neutral (concurrency, repetition, failure, an anomaly
  against a baseline, a broken relation, an error). Plain traffic never reaches it. Facts only decide whether to
  ask; no fact selects a diagnosis or an action.
- **Device-sized budget:** 2,400 characters (about 1,000 tokens) on WebGPU; on WASM from 1,000 characters with one
  thread to 2,000 with four (crossOriginIsolated pages). At 1,400 characters or less the questions are compact
  (bare labels and action names).

### Decisions and actions (`src/decide`, `src/runtime.ts`)

- **Actions are capabilities, not rules.**
  - Guard tier: `discard`, `defer`, `coalesce`, `delay`.
  - Heal tier: `block`, `serve_cached`, `retry`, `hedge`, `rollback`, `resync`.
  - Passive: `apply`, `send`, `deliver`, `wait`, `ignore`.
  - Plugins can add their own; the model reads each action's description. An action is offered only when its
    preconditions hold (for example, `retry` only when repeating the request is safe by HTTP semantics or an
    idempotency key).
- **Gate.** Let *A* be the permitted non-passive actions: the applicable ones the mode allows (observe: none;
  guard: guard tier; heal: both), minus `policy.deny` (only `policy.allow` when it is set). A protected or
  cross-origin subject, or one whose operation started under an `off` or `observe` route rule, has none
  (`blockOf` in `runtime.ts`). GenClass runs the most probable action in *A* only when all of these hold:
  - the model's gate clears. Model 0.2.0 ships a gain gate: the estimated gain of the best permitted action over
    doing nothing, in cost units, must be above a margin per tier and trigger, taken from the `cautious`,
    `balanced` (default) or `eager` profile in the model's `meta.json`. A model without a gate of its own uses a
    summed probability over *A* of 0.9 (guard) or 0.8 (heal) at `balanced`, 0.05 more at `cautious` and 0.05 less
    at `eager`. The app's `policy.thresholds` override either, read in the gate kind the model ships;
  - the model's top diagnosis is not `expected`;
  - the decision is within the action limits (by default 60 a minute, 10 per subject a minute, 200 per session)
    and, for a held subject, within the hold budget;
  - the app's `onBeforeAction` hook, if any, does not veto it.

  Otherwise the passive action runs and the decision records why. The hold budget is 1.5 times the model's recent
  median latency, between 150 and 800 ms (`policy.holdBudgetMs: "auto"`).
- **Breaker.** After 2 undos, or 3 errors that follow actions, the session drops to `observe`.
- **Detections.** A decision whose top diagnosis is not `expected` is reported when its probability reaches the
  profile's report gate (likely), or, in observe from 0.3.0, the `eager` profile's lower report value (possible).
  The detection tiers are reporting only: no action gate reads them.

### Model host (`src/model`)

- **Engine:** a TypeScript port of the GenClass engine (byte-level BPE tokenizer, packer, calibration). It is
  bit-exact with the Python packer.
- **Inference:** runs in a module Web Worker, with an inline fallback on the main thread unless
  `model.inlineFallback: false` (0.3.0; 0.2.x ignores `false`). The load order is WebGPU with the fp16 file when
  the GPU has `shader-f16`, then WebGPU with the q8 file, then WASM with the q8 file. The WASM-only ONNX Runtime
  build is used when WebGPU is unavailable.
- **Loading:** by default the model loads when the browser is idle after the page's `load` event, from a pinned
  npm version on jsDelivr (`@genclass/runtime-model@0.2.0`), is verified with sha256 and is cached in Cache Storage.
  It is not loaded on devices reporting 2 GB of memory or less, nor on Save-Data connections (`model.loadIf`;
  0.3.0; 0.2.x loads lazily on Save-Data and has no memory floor). While it loads, guard and heal fail open at once
  (the passive action runs). In observe (0.3.0), where the possible tier is in force (by default; not with `detect: "likely"`, nor with `policy.thresholds.report` unless
  `detect: "possible"` is set), up to 32 salient situations wait and are decided once the model is ready, reported
  at the possible tier at most. Otherwise observe skips them, as in 0.2.x.

## What runs outside the model?

Three layers are deterministic or counting layers, separate from the model. They never feed situations, facts, the
gate or the model (the visual checks have one indirect path, below), and their code is in lazy chunks that load
only when the layer is on. All three keep some code in the first load of `/auto`: the visual checks a 550 B stub and
analytics a 288 B stub (the script-tag build loads their chunks by URL), and flow expectations 3.22 KB when they were
added for 0.3.0-beta.0 (102.94 to 106.16 KB at `fcefedb`: their hooks, the console line, learned-state persistence
and the overhead of splitting the util code they share with their lazy chunk into a 3.05 KB chunk of its own; the
console text later moved into the lazy chunk). The script-tag build carries the flow layer inline
([RESULTS.md section 10](RESULTS.md#10-release-030-beta0-first-load-and-telemetry-volume-ci),
[section 11](RESULTS.md#11-observe-mode-detection-in-030-the-possible-tier-and-deferred-situations) and
[section 15](RESULTS.md#15-interaction-analytics-first-load-cost-train-vm-2026-10-18-branch-featinteraction-analytics)).

- **Measured visual checks** (`src/visual/`, [VISUAL.md](VISUAL.md)): measurements of visual and CSS bugs that
  never throw (unreadable text, broken images, a stuck scroll lock, and others) with documented thresholds,
  reported as kind `"check"`, never as a model finding. Report-only by default, and on by default only on local
  development URLs (http(s) on `localhost`, `127.0.0.1`, `[::1]` or `*.localhost` with a port, and `*.test` names;
  `devHost` in `src/visual/start.ts`) and wherever the devtools overlay mounts (`visual: "local"`). Their three
  runtime fixes are opt-in, run only in guard or heal, are re-measured and undone if they do not clear the
  threshold. One indirect path remains: a page read that makes the browser lay out a very heavy page can take 50 ms
  or more, and the runtime records such a long task as a `perf` event the model can read (VISUAL.md section 1).
- **Flow expectations** (opt-in, `learn: { expectations: true }`, [EXPECTATIONS.md](EXPECTATIONS.md)): learned
  counts of what each user action usually causes (a request, a write, a navigation), and a report when a step did
  not happen. The model is not consulted, and nothing is held, retried or changed in any mode.
- **Interaction analytics** (opt-in, `analytics: true` with the app's token, 0.3.0-beta.1, not on npm yet;
  [ANALYTICS.md](ANALYTICS.md)): page views, engaged time, scroll depth and clicks per element key, counted for the
  app's dashboard with their own passive listeners, outside the event log.

Reports leave the runtime through the console, `rt.on(...)` events, the audit trail, sinks the app configures and
the anonymous telemetry ([TELEMETRY.md](../../packages/runtime/TELEMETRY.md)). None of these outputs feeds a
decision.

<a id="the-model-and-how-it-is-trained"></a>

## What is the model, and how is it trained?

The model is a Jev-style typed-decision encoder: one forward pass reads the state and answers several typed
questions (choice, yes/no, score). Each option attends only to the state and its own question, so option order
cannot change the answer.

One model ships: R17 (`genclass-runtime-r17`, in `@genclass/runtime-model` 0.2.0). It is initialised from
`jhu-clsp/ettin-encoder-17m` and, after vocabulary pruning to 16,364 tokens, has 8.8M parameters (8.1M encoder and
0.7M heads). The q8 file is 10.16 MB and the fp16 file 13.57 MB
([model card](../../packages/runtime-model/MODEL_CARD.md)). R32 was compared and not shipped: R17 matched its
accuracy at about a third of the latency and under half the size (q8 9.58 MB against 22.5 MB, round-1 exports;
[RESULTS.md section 2](RESULTS.md#2-r17-vs-r32-choosing-the-shipping-model)).

Training data (`sim/`, `realapps/`, `training/`):

1. **Simulator** (`sim/`). Random apps across 115 domains are built from 46 feature combinators: search, lists,
   forms, carts, boards, chat, autosave, polling, uploads, offline queues, websocket reconnects, payments,
   multi-tab sync and more ([sim/README.md](../../sim/README.md)). They mix correct guards with realistic defects,
   and run real `async` code against the **real runtime** in a deterministic virtual world (clock, network with
   latency, failures and outages, push channels, users who type, double-click and change their minds).
2. **Real apps** (`realapps/`). 158 apps (144 written for the corpus and 14 open-source RealWorld front-ends) run
   in headless Chromium with the real runtime ([realapps/README.md](../../realapps/README.md)). They give training
   rows, a held-out evaluation set and the never-worse sweep.
3. **Labels from outcomes, not rules.** At a sampled decision point, the scenario is re-run with each applicable
   action forced there, scored over several sampled futures. The cost of each run is how far the app drifts from
   what the user intended, which is the same session in an ideal serial, zero-latency, exactly-once world. It also
   counts persistent server damage, user-visible errors, wasted requests and added latency. For model 0.2.0 the
   action label is `softmax(gain / τ)` with τ = 1, where gain is the expected cost each action saves over doing
   nothing. The diagnosis label comes from the simulator's knowledge of user intents.
4. **On-policy rows.** 1,248,131 situations from an earlier model (`r17-v2a`) acting inside the simulator,
   including 448k at its shipping gate and 672k at an exploratory gate of 0.5, labelled the same way. Round b's
   rows (from `r17-v2b`) were not trained on; the shipping-gate rows of both rounds were used to fit and test the
   gates ([model card](../../packages/runtime-model/MODEL_CARD.md), "Training data and licence").
5. **Curriculum.** Programmatic error-detection-and-fixing exercises: ordering, causality, versions, duplicates,
   streaks, baselines, invariants, and HTTP and JavaScript error semantics.
6. **Held out for testing.** Domains, feature combinators, program families and real apps that never appear in
   training. The demos are written independently of the simulator and act as an external test.

<a id="evaluation"></a>

## How is it evaluated?

- **Simulator test split:** action and diagnosis accuracy, plus the false-intervention rate (FIR), harm and recall
  of the guard and heal gates, per trigger and per profile.
- **Real-app evaluation set:** detections and actions on held-out real apps, with the FIR on clean and benign
  traffic. For model 0.2.0 the gate fit held each profile's false detections under a limit, and every profile met
  its limits on held-out test; the exact 0.2.0 false-detection rates are not published
  ([model card](../../packages/runtime-model/MODEL_CARD.md), "Observe-mode false detections").
- **Never worse:** real apps run with an always-passive model in each runtime design, counting clean runs whose
  outcome changed (RESULTS.md section 4).
- **Demos:** six small apps covering typeahead, autosave, checkout, a flaky dashboard, a live kanban board and
  real-time decisions. Each is driven by Playwright under chaos and on clean runs with GenClass off and in each
  mode. Reports cover bug rate, false interventions on clean runs and added latency.
- **Compatibility:** the framework matrix in [compat/RESULTS.md](../../compat/RESULTS.md).

Every result, with its FIR next to its recall, is in [RESULTS.md](RESULTS.md).
