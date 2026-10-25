# @genclass/runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![npm beta](https://img.shields.io/npm/v/@genclass/runtime/beta?label=beta)](https://www.npmjs.com/package/@genclass/runtime?activeTab=versions)
[![CI](https://github.com/genclass-dev/GenClass-lib/actions/workflows/ci.yml/badge.svg)](https://github.com/genclass-dev/GenClass-lib/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/genclass-dev/GenClass-lib/blob/main/LICENSE)

### Reports race conditions, stale responses and double submits in your web app while they happen.

GenClass Runtime (`@genclass/runtime`) is an open-source (Apache-2.0) browser library that reports race conditions in
web apps while they happen: stale responses that land over newer data, duplicate requests such as double submits,
inconsistent state and failure storms. A small model runs on the user's device, in a Web Worker on WebGPU or WASM,
and each report comes with its evidence. By default it only reports (`observe`): it never holds, delays or changes a
request, a response or a state write. The opt-in `guard` mode can prevent a few of these failures, and `heal` is
experimental.

It is for front-end apps in React, Next.js, Vue, SvelteKit, Angular, Solid or plain HTML, and for the timing bugs
tests rarely catch: a slow response landing after a fast one, a button clicked twice, a save racing an edit, an
endpoint that starts failing at 2 a.m. Stale responses are reported for state it can see
([which](#automatic-state-discovery)). It runs in the browser only: during SSR or in Node, `/auto` installs nothing.

[Docs](https://genclass.dev/docs) · [Questions](https://github.com/genclass-dev/GenClass-lib/blob/main/FAQ.md) ·
[Measured results](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) ·
[API](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md) ·
[Changelog](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/CHANGELOG.md) ·
[Discord](https://discord.gg/kN9kRnFtZm)

## Quick start

```bash
npx @genclass/runtime@beta init   # finds your framework, shows the diff, then adds one import
```

Once you approve the diff, `init` also creates your app's free dashboard at genclass.dev and sends it your
`package.json` `name`; `--no-token`, `--token`, `--no-telemetry` and `--dry-run` create no dashboard and never contact
genclass.dev ([Your dashboard](#your-dashboard)).

Or by hand:

```bash
npm install @genclass/runtime@beta
```

```ts
import "@genclass/runtime/auto"; // first line of your entry file (Next.js 15.3+: instrumentation-client.ts)
```

Or with no build step, first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.1"></script>
```

That is the whole setup. Network traffic, user actions, errors and timing are observed, and so is your app's state:
React component state, Redux and Redux Toolkit stores, and Zustand stores with `devtools` are found automatically
([Automatic state discovery](#automatic-state-discovery)). Pinia, Svelte stores, signals and a plain HTML page's DOM
are not: there, stale responses are reported only for stores you register (double submits need no state).

**Versions:** this README describes `0.3.0` with model `@genclass/runtime-model@0.2.0`. On 2026-10-22, `0.2.2` was
npm `latest` and `0.3.0-beta.0` was `beta` (`npm view @genclass/runtime dist-tags` shows them now); features marked
`0.3.0-beta.1` are not in `0.3.0-beta.0`. Keep `@beta` in npm and npx commands while `0.3.0` is in beta, and pin the
script tag: the unversioned URL serves `latest`, and `0.2.x` ignores a token and its CLI has no `login` or `--sink`.

> **Anonymous diagnostics are on by default** on public hosts: GenClass's decisions and counts, no text from your
> page, sent to the GenClass maintainers to improve the model. Off on `localhost` and other local hosts from `0.2.2`
> (`0.1.0-beta.3` to `0.2.1` send from them too). Opt out with `GenClass.init({ telemetry: false })`,
> `?genclass=no-telemetry`, `localStorage["genclass.telemetry"] = "off"` or
> `npx @genclass/runtime@beta init --no-telemetry`; browsers sending Global Privacy Control are never collected.
> Details: [Privacy and telemetry](#privacy-and-telemetry) and [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).

## Contents

[At a glance](#at-a-glance) · [Modes](#modes) ·
[What it looks for](#what-it-looks-for) · [Safety and cost](#safety-and-cost-measured) ·
[Model quality](#model-quality) · [Costs](#costs) · [Privacy and telemetry](#privacy-and-telemetry) ·
[Known limitations](#known-limitations) · [Install](#install) ·
[For AI coding agents](#for-ai-coding-agents-installing-genclass) ·
[Your coding agent](#your-coding-agent-replay-and-explore) ·
[protect()](#function-specific-protect) · [Your dashboard](#your-dashboard) ·
[Automatic state discovery](#automatic-state-discovery) · [State it can protect](#state-it-can-protect) ·
[Visual and CSS checks](#visual-and-css-checks-new-in-030) · [Observability](#observability) ·
[Configuration](#configuration) · [Performance](#performance) ·
[Content-Security-Policy and self-hosting](#content-security-policy-and-self-hosting)

## What it looks like

When the model flags something, the console gets one plain-English line per detection or intervention, followed by a
collapsed group with the evidence. Here a typeahead's slow response for "rea" lands after the response for "reac".
This is real output (format unchanged since `0.1.0-beta.0`; q8 on WASM, in Node) in the default observe mode. The
response reaches the app at once, exactly as without GenClass, and the decision is made in the background:

```
[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.43s). Mode: observe.
[GenClass] Flagged a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). (stale, 0.96)
```

The same run in guard mode (captured with model 0.1.0; how often model 0.2.0 acts: [Model quality](#model-quality)).
The results for "reac" stayed:

```
[GenClass] Prevented a stale response: search.results was written twice by other operations since its operation (#6)
started (version 1 → 3), last 0.69s ago by GET /api/search?q=reac (#8), which started 0.09s after #6, from a later
user action (#7). Delivered the response to GET /api/search?q=rea (#6) and dropped the state changes it makes over
newer data (search.results). (stale, 0.97; discard 0.98)
```

## At a glance

| | |
|---|---|
| Default | `observe`: reports only; never holds, delays or changes a request, response or state write |
| Opt-in | `guard`: drop a stale response's writes, reuse a duplicate's result, defer, back off. `heal` (experimental): also retry, serve cached, block, hedge, roll back, resync |
| Detects (observe, `balanced`, held-out real apps, scored offline) | 75% of duplicate submits, 30% of stale overwrites (`situation-v2.3` slice; 21% on `situation-v2`), 6% of broken state, with the right diagnosis; report gate fitted to keep false detections at or below 2% (real apps) / 3% (simulated) of clean decisions, met on held-out test (exact rate not published) |
| Acts (guard, `balanced`) | on 7.8% of clear simulated and 7.5% of actionable real-app cases where acting would help; false interventions 0.13% (held-out simulated), 0.00% (held-out real apps) |
| First-load JavaScript | 108.25 KB gzip with `/auto`, 100.13 KB with `GenClass.init()` (`0.3.0-beta.0`; [Performance](#performance)) |
| Model | 10.2 MB (q8: WASM, and WebGPU without `shader-f16`) or 13.6 MB (fp16: WebGPU with `shader-f16`), downloaded once at idle and cached; about 180 ms per decision on one WASM thread (estimated in Node, not in a browser); not loaded on devices reporting 2 GB of memory or less, or on Save-Data |
| Memory | +190 to 280 MB in the renderer while the model is loaded (one pilot app, `0.1.0-beta.3`) |
| Browsers | measured in Chromium only |
| Data sent | anonymous diagnostics without page text, on by default on public hosts, off on local hosts; `telemetry: false` turns them off |
| License | Apache-2.0, the model package too |

Sources: [RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#current-numbers-in-one-place)
§1, §2, §10, §11 and §17, and the
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).

## Modes

| mode | what it does | non-passive actions |
|---|---|---|
| `observe` (**default**) | Finds and reports what it sees and what it would have done. Never holds a request or a response, never runs an action. | none |
| `guard` (opt-in) | Also prevents failures with minimal guard-tier actions: `discard`, `defer`, `coalesce`, `delay` (drop a stale response's writes, reuse a duplicate's result, back off). Only when the model's gain gate says acting beats doing nothing by the profile's margin and the top diagnosis is not `expected` ([model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)). | guard tier |
| `heal` (**experimental**) | Also recovers: `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync`, plus your own actions. | guard + heal tier |

`GenClass.init()` with no `mode`, `/auto` and the script tag without `data-mode` observe only (`0.1.0-alpha.0` and
`0.1.0-beta.1` defaulted to `guard`). Pass `mode: "guard"` or `init --mode guard` to let it act.

**Detections in observe (`0.3.0`).** A detection is *likely* when the model's top diagnosis is not `expected` and its
probability reaches the report gate (0.90 at `balanced` with model 0.2.0): one console line with its evidence. Observe
also reports *possible* detections, from the `eager` report value (0.70) up to the gate: on `console.debug`, counted
apart (`summary().possibleDetections`) and sent in the anonymous diagnostics as `detect` events with `tier: "possible"`.
`rt.on("detect")` and `report` get them only when you set `detect: "possible"` explicitly, sinks only with
`possible: true`; `detect: "likely"` turns them off. Situations raised while the model loads or the tab is hidden are
decided once it can (at most 32 wait), at the possible tier at most
([RESULTS.md §11](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#11-observe-mode-detection-in-030-the-possible-tier-and-deferred-situations)).

### How eager should it be?

Once you opt into `guard` or `heal`, GenClass only acts when the model is confident enough. You choose how confident:

```ts
GenClass.init({ aggressiveness: "cautious" }); // "cautious" | "balanced" (default) | "eager", or a number 0 to 1
GenClass.runtime.setAggressiveness("eager");   // change it later (the devtools have a selector too)
```

`cautious` acts less often; `eager` fixes more at a higher risk of acting when it did not need to (numbers under
[Model quality](#model-quality)). In observe, aggressiveness only moves the report gate: 0.95 / 0.90 / 0.70 for
cautious / balanced / eager. The thresholds ship in the model's `meta.json`, fitted on held-out dev data.
`policy.thresholds` overrides them (with model 0.2.0's gain gate, `guard` and `heal` are margins in cost units, not
probabilities); `rt.gates(trigger)` shows what is in force.

**Limits and switches.** Actions are limited to 60 per minute, 10 per minute on the same subject and 200 per session
(`policy.actionLimits`). `?genclass=off` (or `localStorage.genclass = "off"`) installs nothing. `GenClass.init()`
never throws, and outside a browser it returns a runtime with no observers and no model; for tests, use
`createRuntime(options)`.

## What it looks for

Actions other than flagging need `guard` or `heal`:

| situation | example | what GenClass can do |
|---|---|---|
| Stale response | an old search response lands after a newer one | deliver it but drop its writes over newer data, or defer it (guard) |
| Race / conflict | a server echo would overwrite what the user just typed | drop the stale part, defer (guard) |
| Duplicate | a double click sends the same order twice | reuse the first response (`coalesce`, guard) |
| Inconsistent state | the cart total no longer equals the sum of the lines | roll back or resync (heal) |
| Failure pattern | an endpoint fails 5 times in a row | serve the last good response (heal) |
| Transient failure | a one-off 503 | retry (heal) |
| Slow or flooding | 8× slower than usual; a render loop hammering an API | hedge (heal), delay (guard) |
| Unusual behaviour | an operation writes different fields than it usually does | flag; roll back (heal) |
| Your own question | "is now a good moment to start the upload?" | `rt.ask()` / `rt.decide()` |

The runtime decides at nine **triggers**: `delivery` (a response or WebSocket/EventSource message is about to reach
the app), `request`, `failure`, `stall`, `mutation` (a salient store write no delivery decision covered),
`inconsistency` (a learned relation such as `total == sum(items[*].price × qty)` broke), `transition` (an operation
wrote different fields than usual), `error` and `ask` (your own question, always asked). By default the others reach
the model only when salient; the rest is a cheap fact computation. The model gives a diagnosis (`expected`, `stale`,
`conflict`, `duplicate`, `inconsistent`, `failing`, `slow`, `overload`, `unusual` or `transient`) and picks an
action. The runtime has no list of known bugs: triage picks the situations, the model decides. Every trigger's actions:
[API.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md#triggers-and-actions).

**Delivery decisions.** In guard and heal, GenClass decides about responses *at the network boundary*, before the app
sees them (observe decides in the background), and never holds or reorders the app's store writes. A delivery is
salient only when a field it is predicted to write already holds **newer applied data**, or it would **revert a
pending local change** or **replace text the user typed**. The model then reads facts such as these:

```
The response has search.results = 1 item ["rea-1"]: neither the current value 1 item ["react-1"], nor the value when #4 started.
The response to GET /api/search?q=rea (#4) arrived after 1.80s (200); the app has not seen it yet.
This request comes from user typed "rea" into input "Search" (#3), started 1.80s ago.
```

Clean in-order typeahead and autosave make no model calls and hold nothing. The model does not catch logic that is
consistently wrong, CSS or security bugs, and it never rewrites your code; some visual and CSS bugs are covered by
[measured checks](#visual-and-css-checks-new-in-030). Opt-in flow expectations (`learn: { expectations: true }`)
report a usual step that did not happen; off by default until their false-report rate is measured
([EXPECTATIONS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/EXPECTATIONS.md)).

<a id="why-its-an-easy-yes-measured"></a>

## Safety and cost (measured)

These hold for the runtime; whether the model's decisions are good is under [Model quality](#model-quality).

- **It is not expected to make a working app worse.** Decisions about responses happen at the network boundary, which
  looks like ordinary latency to your app, and the default never holds or reorders your app's own store writes. With a
  model that never intervenes (heal mode, compared against observe mode), GenClass changed the outcome in **0 of 396**
  clean runs across **66 real apps in 23 frameworks** (including 14 open-source RealWorld front-ends), 6 seeds each
  (runtime as of `0.1.0-alpha.1`; not re-run since). The check compares final page text (inputs and alerts excluded) and
  server state, not request timing, store contents or observe against no GenClass. With network chaos, 3 of 198 runs
  differed: a request held about 25 ms changed the simulated network's draws
  ([RESULTS.md §4](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#4-never-make-a-correct-app-worse-runtime-design-comparison)).
- **Every mode, on seven idiomatic apps** (runtime commit `d04eff3`, the 0.1.0-beta.4 code: the matrix has not run
  0.2.0's other changes or anything since; model 0.2.0 at `balanced`, 2026-10-10). The
  [compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md) (six frameworks,
  React, Next.js, Vue, SvelteKit, Angular and Solid, and plain HTML; 15 data layers; 10 seeds per cell) found 0 bugs
  introduced in 3,510 runs with GenClass and 0 actions in 1,760 guard and heal runs on correct apps. Observe left page
  and server state identical to the run without GenClass in every cell but one, an app's own timing race (SWR's
  optimistic rollback) that came out right with GenClass, with no action taken: observe holds nothing, but its
  main-thread work is not zero. Observe reported 49 false findings in 880 correct-app runs, all in one polling and
  fan-out scenario.
- **Normal traffic costs little.** The model is consulted only for salient situations ([Performance](#performance)).
- **The model runs in the browser**, cached after the first load: no inference server, no API key, and decisions
  never wait on the network.
- **You can see what it did, and undo it.** Every detection and action gets one console line with its evidence;
  `rt.explain(id)` shows what the model read; discards and rollbacks can be undone.

## Model quality

The default model is `genclass-runtime-r17` 2.0.0-rc4t (`@genclass/runtime-model@0.2.0`, training run `r17-v2dT`): an
encoder of 8.1M parameters plus 0.7M of heads, trained on simulated apps and on real apps driven in headless
Chromium. It ships a gain gate with one fitted profile per aggressiveness level. FIR, the false-intervention rate, is
the share of cases where doing nothing was best but the gate fired anyway. Held-out test,
[RESULTS.md §1](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#1-model-stages-compared-held-out-simulated-apps):

| profile | guard FIR | guard recall (clear / real) | heal FIR | heal recall (clear / real) | report threshold | detected (duplicate / stale / broken) |
|---|---|---|---|---|---|---|
| `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 | 72% / 28% / 0% |
| **`balanced` (default)** | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 | 75% / 30% / 6% |
| `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 | 77% / 45% / 13% |

FIR is on simulated apps; on held-out real apps it was 0.00% for every profile. The targets are 0.1% (guard) and 0.5%
(heal): `cautious` meets both, `balanced` is slightly over both, `eager` trades well over them for about twice
`balanced`'s recall. Pick `cautious` if a wrong intervention costs more than a missed one.

- **Observe (default).** At `balanced`, scored offline per situation on held-out real apps, it reports 75% of duplicate
  submits, 30% of stale overwrites (`situation-v2.3`; 21% on `situation-v2`) and 6% of broken state with the right
  diagnosis. End to end in the compatibility matrix (commit `d04eff3`), it made 10 duplicate-submit detections
  over 10 seeds in each of the 14 data layers with that bug, and 10 stale-response detections in all over the 110
  stale-typeahead runs (none in 7 of those 11 layers), with 49 false findings in 880 correct-app runs. The 0.2.0
  report gate was fitted on dev data to keep false detections at or below 2% (real apps) / 3% (simulated) of clean
  decisions, and met that on held-out test; the exact rate is not published (RESULTS.md §11; model 0.1.0's exact rates:
  §1). One recurring pattern in your app can produce many more; `policy.thresholds.report` raises the bar. With the
  possible tier, the fit held false detections to at most 5% / 6%; the share of possible ones that are false is not
  measured. Three 0.3.0 runtime fixes (overwritten writes decided in observe on slow devices, the body wait, the idle
  unload) can add likely reports, false ones included, at a rate not measured yet; `detect: "likely"` does not turn them
  off.
- **Guard (opt-in).** It rarely acts and misses most problems (the `balanced` row: it acts on 7.8% of clear
  simulated cases at a FIR of 0.13%). Precision among its actions was not measured for 0.2.0.
- **Heal (experimental).** Its FIR at `balanced`, 0.59%, is over the 0.5% target, and it acts on 7.1% of clear
  simulated cases.
- **Not yet met:** diagnosis ≥ 95% and clear-case recall ≥ 80%; recall is the open problem (training data:
  RESULTS.md §6).
- **Format.** Trained on `situation-v2` and `situation-v2.3` data; this runtime renders `situation-v2.3`.

On the six demo apps under network chaos, the shipped gates did not lower the bug rate (72% with GenClass off, 70%
observe, 72% guard, 73% heal), with 0 false interventions on clean trials
([RESULTS.md §5](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#5-demos)). Its main
value today is observe mode: plain-English detections with the evidence.

## Costs

Measured on a pilot app (2026-10-09: a Next.js 16 ordering site, production build, Playwright Chromium at 390×844,
4× CPU throttling, medians of 5 runs, observe, `0.1.0-beta.3` with model 0.2.0) against the same build with
`?genclass=off` ([RESULTS.md §17](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10)):

| | with GenClass |
|---|---|
| JavaScript on every page (first load, gzip) | +97 KB with `0.1.0-beta.3` (today: [Performance](#performance)) |
| Main thread: load event, LCP, long tasks | no measurable change; main JS heap +0.4 MB |
| **Memory: renderer process (holds the model worker)** | **+190 to 280 MB RSS** while the model is loaded (cold and warm) |
| **First visit download** | **about 13 MB** on WASM after the load event (12.7 MB measured: q8 model, ONNX Runtime wasm, tokenizer); WebGPU: a 5.5 MB brotli ONNX Runtime build, and with `shader-f16` the 13.6 MB fp16 model instead of the q8 |
| Later visits | about 1 KB (`model.json` revalidated); the rest comes from Cache Storage, checked with sha256 |
| Model load | WASM (1 thread): 0.9 to 1.3 s cold, 0.4 s warm. WebGPU (Apple M-series): 12 s cold, 2 s warm |

**On phones** the memory and the download are what matter. **By default the model is not loaded on devices that
report 2 GB of memory or less, nor on Save-Data connections** (since `0.3.0`; `model.loadIf` defaults to
`{ minDeviceMemoryGB: 4, saveData: "skip" }`; Safari and Firefox do not report device memory and load). The runtime
then keeps observing without a model (nothing is detected or prevented on that device) and says why in one console
line. `model.loadIf` also takes a function, such as `(env) => !env.mobile` for no model on phones;
`model.preload: "lazy"` downloads on the first salient situation, and `model.unloadAfterIdleMs` frees the worker's
memory (guard and heal actions after a reload: FIR not measured, RESULTS.md §11). `model: false` keeps the runtime
observing with no download and no worker.

## Privacy and telemetry

- **Decisions are local.** Situations are built and decided in the browser; nothing is sent to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()` in a browser (and so with `/auto`, the script
  tag and `init` setups), except on local and private hosts (`localhost`, `*.localhost`, `*.local`, `*.test`,
  `127.0.0.1`, `::1`, private IP ranges), in Node/SSR, and in `createRuntime()`. `0.1.0-beta.3` to `0.2.1` send from
  local hosts too (fixed in `0.2.2`), and `0.1.0-beta.3` to `0.2.0` send the redacted situation text by default. They
  go to the GenClass maintainers' collector
  ([`telemetry-worker/`](https://github.com/genclass-dev/GenClass-lib/tree/main/telemetry-worker), a Cloudflare
  Worker writing to a private R2 bucket) and are used to improve the model. One console notice per page says it is on.
- **By default no text from your page is sent.** Sent: a random per-page session id, versions, mode, device class,
  the app's hostname and id-normalised path, and per decision (every detection and every decision whose diagnosis is
  not `expected`, every action and veto; of the routine ones, one in four and at most 200 per page load; counts are
  exact) the trigger, the diagnosis and its confidence, the action and gate, the outcome and latency. The collector
  adds the visitor's coarse country (two letters) and stores no IP address or user agent.
- **Opt out:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`,
  `localStorage.setItem("genclass.telemetry", "off")`, or `npx @genclass/runtime@beta init --no-telemetry`, which
  writes the opt-out into your project (`telemetry=off` in the meta tag or `data-telemetry="off"` on the script tag
  do the same). Browsers sending Global Privacy Control are never collected. `runtime.telemetry` says whether it is
  on and why not.
- **The situation text the model read is sent only if you opt in** with
  `GenClass.init({ telemetry: { include: { situation: true } } })`. It is redacted by field meaning, but can still
  contain route names with query strings, short error messages and short field values; read TELEMETRY.md first.
- **With a token** (`0.3.0`), each batch also carries your app's public token, so the same diagnostics show on your
  app's private dashboard, and decisions about `protect()`ed functions carry the function's name. Without a token
  neither is sent; without telemetry, a token does nothing.
- **Interaction analytics are off unless you turn them on** (new in `0.3.0-beta.1`; `0.3.0-beta.0` does not have
  them). `GenClass.init({ token, analytics: true })` also sends, per page view, the route, engaged time, scroll depth,
  and clicks, rage clicks and dead clicks per element (the element named from markup, never its text). They need
  telemetry on and the app's token (or your own `telemetry.endpoint`); no visitor id exists and nothing is stored on
  the device; they never feed a decision or the model. Every opt-out above turns them off. Where consent is needed
  (the EU, EEA and UK), leave `analytics` unset and call `runtime.analytics.start()` once the visitor consents. Details:
  [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md#interaction-analytics).
- **The measured visual checks send nothing**, and sinks send only where you point them.
- **The CLI** contacts genclass.dev only for the command you run: `init` creates a dashboard only after you approve
  its diff (it sends `package.json`'s `name`); `login`, `connect`, `whoami` and `logout` talk to your account
  ([DASHBOARD.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/DASHBOARD.md#what-does-the-cli-send-to-genclassdev)).
- **Privacy policy** for the diagnostics and for genclass.dev accounts (what is collected, how long it is kept, your
  rights): [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). `telemetry: { endpoint, ... }` sends
  to your own collector instead. Full schema, storage, every opt-out and guidance:
  [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md).
- **Inputs and redaction.** Typed values of password, `cc-*` and `one-time-code` fields, and of fields whose name or
  label names a secret, are never recorded. The default redactor works by the leaf field's meaning (`auth.token`,
  `payment.card.number`; `auth.loading` stays visible); booleans and null are never redacted. Under a container named
  for a secret, strings, numbers and arrays are all redacted, so a word that is a secret in another sense hides numbers
  too (`map.pin.lat`). The "would replace text the user typed" fact shows a character diff only when neither value is
  redacted, else `[redacted] → [redacted]`. Pass your own `redact(path, value)` for app-specific secrets; the default
  has gaps (below).

## Known limitations

- **The model is new and imperfect.** It misses most problems, it was not evaluated on your app, and in observe mode
  it makes some false flags ([Model quality](#model-quality)). It is not a substitute for tests. Watch observe mode
  before turning on `guard` or `heal`.
- **Browsers.** Every browser measurement here ran in Chromium (headless or Playwright); model latency, the perf
  tests and the simulated apps ran in Node. Firefox and Safari are not tested. Layout shifts and failed CSS
  background images are checked in Chromium only.
- **Redaction gaps.** A container named by a two-word secret (`cardNumber`, `apiKey`, `creditCard`) counts as broad,
  like `auth`, so `payment.cardNumber.value = "4111 1111 1111 1111"` is shown in the situation text, `explain()`, the
  console evidence and devtools, and the telemetry situation text if you opted in (a leaf with such a name,
  `settings.apiKey`, is redacted). "X changed since #N started and is back to V" compares rendered text, so two
  different redacted values read as "back to [redacted]". Pass a custom `redact`, and keep secrets out of observed
  stores.
- **The discard mark lasts 10 s.** After a `discard`, writes by operations chained from the discarded one (a
  `setTimeout`-driven poll, a saga) to the protected fields are also dropped for 10 s, even when they carry fresh
  data. The marks also outlive `rt.pause()` and `setMode("observe")`.
- **`defer` can wait long.** A delivery may be deferred twice, each time until the related operations finish or 10 s
  pass. A deferred WebSocket/EventSource message holds back the messages queued behind it, and is still dispatched if
  the app closed the socket meanwhile. EventSource `open` events are not kept in order behind held messages. XHR
  listeners of a held response run after the original dispatch, so `e.currentTarget` is `null`: read the `xhr`
  object itself.
- **`retry` (heal) trusts HTTP semantics.** It is offered for idempotent methods, and for POST / PATCH only with an
  idempotency key (`policy.idempotencyHeaders`). An endpoint that is not idempotent despite its method (a `PUT` that
  appends) can still be retried. A 502 is described to the model as a status usually returned without processing the
  request, which is not always true behind proxies. `coalesce`, `retry`, `hedge` and failure/stall `serve_cached` are
  fetch-only.
- **`policy.holdWrites: true` (opt-in).** A held write that a later write flushed early can be recorded as dropped
  while it stays applied.
- **Synthetic events** (`isTrusted === false`: `el.click()`, `dispatchEvent`, in-page test drivers) are not user
  actions unless you pass `observe: { untrustedEvents: true }`.
- **Causality** across `await` is tracked by instrumenting fetch, XHR, timers, message events and Response bodies.
  This is best effort; wrap important work in `rt.op(name, fn)` for exact attribution.
- **Store state.** Discovered React and Zustand state is observed only
  ([Automatic state discovery](#automatic-state-discovery)). The first response of each kind after a page load is
  never a delivery decision: GenClass has not yet seen what that request writes.
- **Install and CDN.** Read the diff `init` and `remove` show before you confirm. SRI covers only the script-tag file;
  what it loads is not integrity-checked by the browser (the runtime checks the model files' sha256), so pin a
  version, or self-host. A page that lets untrusted HTML into `<head>` should not use `<meta name="genclass">`.

## Install

Pick one; all start the same runtime, in observe mode unless you choose otherwise. Every `init` and `remove` flag, the
token and dashboard `init` creates, page configuration and the tested setups:
[INSTALL.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/INSTALL.md).

**1. One command.** `init` finds your framework and package manager, installs the package, adds one import as the
first line of your entry file (plus a dev-only devtools line), and shows you the diff before writing anything.

```bash
npx @genclass/runtime@beta init               # observe; shows the diff, asks, then writes
npx @genclass/runtime@beta init --mode guard  # let GenClass act (also: --mode heal); run again later to switch
npx @genclass/runtime@beta init --dry-run     # show the diff, write nothing, send nothing
npx @genclass/runtime@beta remove             # undo exactly what init added
```

Other flags: `--yes`, `--no-telemetry`, `--no-token`, `--token gc_...`, `--sink`, `--model-url`, `--no-install`,
`--no-devtools`.

**2. One import** (any bundler), first in your entry file, so it is installed before your framework:

```ts
import "@genclass/runtime/auto";          // observe (the default); also /auto/guard, /auto/heal
```

Options go in `window.GENCLASS_CONFIG = { ... }` (any `InitOptions`, set before the import runs) or
`<meta name="genclass" content="mode=guard, devtools=local">` in `<head>`.

**3. One script tag** (no build step), first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.1" data-mode="observe" data-devtools="local"></script>
```

It exposes `window.GenClass` and loads the model worker and the overlay on demand from the same version; `data-mode`,
`data-devtools`, `data-telemetry`, `data-token`, `data-scope`, `data-sink` and more configure it
([every attribute](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/INSTALL.md#which-attributes-does-the-script-tag-take)).
Keep the version pinned.

**4. By hand:** `npm install @genclass/runtime@beta`, then first in your entry file:

```ts
import { GenClass } from "@genclass/runtime";

const rt = GenClass.init(); // observe; GenClass.init({ mode: "guard" }) to let it act
```

`GenClass.init()` does not discover state on its own: register stores ([State it can protect](#state-it-can-protect)),
or import `@genclass/runtime/discover` first and pass `autoState: true`.

**ESM only.** No `require` build. Jest needs a `transformIgnorePatterns` entry such as
`["/node_modules/(?!@genclass/runtime)"]`. The unscoped `genclass-runtime` alias is deprecated.

## For AI coding agents installing GenClass

1. Run `npx @genclass/runtime@beta init --dry-run` (it shows the diff and sends nothing). Tell the user that
   anonymous diagnostics are on by default on public hosts, and that applying `init` creates the app's dashboard at
   genclass.dev from `package.json`'s `name` unless they pass `--no-token`.
2. Apply it with `--yes` only once they agree. Telemetry is the user's decision: add `--no-telemetry` or
   `telemetry: false` only if they ask.
3. Keep the default observe mode. Use `--mode guard` only on request, and then keep payment and sign-in endpoints
   observe-only: `requests: { protect: ["preset:payments", "preset:auth"] }` in `window.GENCLASS_CONFIG` (the
   `genclass.config.ts` that `init` writes), or `protect: protectPreset("payments", "auth")` with `GenClass.init()`.
4. `.genclass.local` holds the private dashboard link and is gitignored: never paste it into code, docs, commits or
   pull requests. The token (`gc_...`) is public and belongs in the code.
5. Check: the console shows `[GenClass] Model ready (...). Mode: observe.`; undo with
   `npx @genclass/runtime@beta remove`.

To change GenClass itself, read [AGENTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/AGENTS.md).

## Your coding agent: replay and explore

A race depends on the network's timing, so it rarely shows on your fast machine and never in a test where mocked APIs
answer in order. `@genclass/runtime/agent` connects your development build to `@genclass/mcp`, an MCP server for
Claude Code and other coding agents, and lets the agent:

- **see what happened, in order:** clicks, requests, the order their responses were delivered, the state each one
  wrote, errors with the click and request behind them, and this runtime's detections;
- **replay** the exact delivery order that produced a bug, on any machine, before the fix (reproduced) and after it
  (not reproduced);
- **explore**: run the same steps with overlapping responses delivered in different seeded orders, optionally slower,
  and report what ends differently from the run where responses came back in order;
- **keep the proof:** a generated Playwright test that sets the same order and fails while the bug is there.

```bash
claude mcp add genclass -- npx -y @genclass/mcp@0.1.0
```

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // development builds only
```

`connectAgent` is its own entry (no first-load cost), runs only on pages served from your machine, talks only to a
loopback address, and holds a response only when you or your agent set a schedule (each at most 1.5 s beyond its
emulated delay; never changed; protected requests never). Without one it only records (a page load's first responses
wait for the bridge's hello, at most 0.6 s). Design and measurements: [AGENT.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md).

## Function-specific: protect()

**New in `0.3.0`** (`0.2.x` has no `protect` export). Use it when you want GenClass on a few functions that matter (a
checkout submit, a search, a save) rather than on the whole app.

```ts
import { GenClass, protect } from "@genclass/runtime";

GenClass.init({ token: "gc_...", scope: "functions" }); // early in your entry file (with /auto or the script tag: see below)

// Wrap at module level; calls made before GenClass.init() run fn directly.
export const submitOrder = protect("checkout submit", async (cart: Cart) => {
  const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) });
  if (!res.ok) throw new Error(`order failed: ${res.status}`);
  return res.json();
});
```

- **Same function.** Same signature: `this`, arguments, return value and thrown errors pass through, and a sync
  function stays sync. `protect` itself never throws.
- **Each call is tracked** as an operation named `name`, the same as `runtime.op(name, fn)`: the requests, state
  writes, timers and errors it starts are linked to it; work started elsewhere (a WebSocket message) is not.
- **Decisions name the function**: `fn: name` on `rt.on("decide")`, and, with a token, in telemetry and on your
  dashboard (without a token the name is never sent). Use a fixed name: a label that looks like data (such as an
  e-mail address, a URL or 4 or more digits in a row) is sent as `[redacted]`. With the script tag, use
  `window.GenClass.protect`.

**`scope: "functions"`** (also `data-scope="functions"` or `scope=functions` in the meta tag): GenClass still observes
the whole app as context, but raises decisions only for activity inside protected functions and never holds or acts
on anything else; `rt.ask()` and `rt.decide()` are still answered everywhere. The default, `scope: "app"`, decides
about the whole app. There is no per-function mode: narrow where GenClass acts with `routes` or `requests.protect`.
With `/auto` or the script tag, GenClass starts before your code, so a later `GenClass.init({ token, scope })` is
ignored (the console says so once): set them in `window.GENCLASS_CONFIG` (the `genclass.config.ts` that `init`
writes), the meta tag or the script tag.

## Your dashboard

**New in `0.3.0`** (`0.2.x` ignores a token). Each web app gets a public **project key** (token: `gc_` + 22 letters and
digits) that groups its diagnostics on a dashboard at genclass.dev, kept in a GenClass account (the CLI's `login`,
then `connect`, `whoami`, `logout`) or behind one private link per app (anyone with the link can open it), which
`init` saves in `.genclass.local`. The dashboard is free for every app, with 90 days of history (1 year on
Enterprise), and so is your own classifier, which a person from GenClass trains on your app's traffic, bug reports or
labelled examples once you ask ([pricing](https://genclass.dev/pricing)). It needs telemetry on and a deployed host:
local hosts do not send by default. Pass a key with `GenClass.init({ token })`, `data-token`, `token=` in the meta tag
or `window.GENCLASS_CONFIG = { token }`. Accounts, the private link and what the CLI sends:
[DASHBOARD.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/DASHBOARD.md).

## Automatic state discovery

With the one line (`@genclass/runtime/auto*` or the script tag) GenClass finds the app's state on its own. It
installs itself before your framework loads, the way React DevTools and Redux DevTools do, and records every state
change with the operation that caused it (the response, timer or user action whose callback called `setState` or
`dispatch`). Delivery decisions need those writes: without them, GenClass could only see the network.

| state | how it is found | what GenClass can do with it |
|---|---|---|
| React ≥ 16.8 (development and production builds): `useState`, `useReducer`, `useSyncExternalStore`, class state | the React DevTools global hook (installed, or chained onto the real extension's); each commit, only re-rendered components are compared | **observed only**: detections and delivery decisions (`deliver` / `defer`); never dropped or rolled back |
| Redux / Redux Toolkit (`configureStore` with `devTools` on, its default; `createStore` with the Redux DevTools enhancer) | the Redux DevTools globals (forwarded to the real extension) | **controllable**: as with GenClass's Redux enhancer: `discard`, late revert, `rollback`, `resync` |
| Zustand with the `devtools` middleware | the Redux DevTools `connect` API; off in production builds unless you pass `enabled: true` (or wrap the store with `genclass` from `@genclass/runtime/zustand`) | **observed only** |

- **Names.** A component's store is named after the component (`SearchPage.state0`); in production builds, after the
  element it renders (`id`, `data-testid`, `aria-label`). At most 3 instances per component and 48 component stores;
  a store appears on its first state change. Framework internals and values that are not app data (functions,
  promises, DOM nodes, class instances) are skipped.
- **Secrets.** Field names are redacted as usual, and a `useState` whose string equals what a password, card-number
  or one-time-code input holds is redacted from then on. Discovered state reaches telemetry only if you opt into
  sending situation text.
- **Turn it off:** `<meta name="genclass" content="autostate=off">`, `data-autostate="off"`,
  `window.GENCLASS_CONFIG = { autoState: false }`, or one source: `autoState: { react: false }` (also `redux`,
  `zustand`). With `GenClass.init()` it is off unless you import `@genclass/runtime/discover` first and pass
  `autoState: true`.
- **Not covered yet:** Vue / Pinia, MobX, Jotai, Recoil, signals, Svelte stores, and state outside these libraries.
  A React renderer that loaded before GenClass is observed without exact causes, and one that rendered before it is
  not observed at all. With `GenClass.init()` and `@genclass/runtime/discover`, Redux stores created before the
  runtime starts are observed only. Register such state with `rt.atom` / `rt.guard`
  ([State it can protect](#state-it-can-protect)).
- **Cost** (a pilot app): about 7 KB gzip in `/auto`; a React commit walk of p95 1.8 ms at 4× CPU throttling
  ([RESULTS.md §17](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#17-browser-cost-on-a-pilot-app-2026-10-09-and-2026-10-10)).

<a id="connect-your-state-optional"></a>

## State it can protect

Fetch, XHR, WebSocket, EventSource, DOM user events, errors, navigation, storage, long tasks and timers are observed
with no code, and with the one line React, Redux and Zustand state is found too. To let GenClass also protect your
state (roll back an inconsistent cart, revert a stale write), create it through GenClass or wrap the store you
already have; a write can be dropped or reverted only when the store goes through GenClass. Each option is one line:

```ts
const rt = GenClass.init({ mode: "guard" });

// Built-in atom
const cart = rt.atom("cart", { items: [], total: 0 }, { resync: () => loadCart() });
cart.set((c) => ({ ...c, items: [...c.items, item] }));

// React (uses GenClass.runtime, or the runtime from <GenClassProvider runtime={…}>; plain useState without one)
import { useGenClassState } from "@genclass/runtime/react";
const [results, setResults] = useGenClassState("searchResults", []);

// Redux / Redux Toolkit (put the enhancer last in compose())
import { genclassEnhancer } from "@genclass/runtime/redux";
const store = configureStore({ reducer, enhancers: (e) => e().concat(genclassEnhancer(rt, { name: "app" })) });

// Zustand
import { genclass } from "@genclass/runtime/zustand";
const useBoard = create(genclass(rt, "board")((set) => ({ cards: [], move: () => set(/* … */) })));

// Any store with get/set (and optionally subscribe)
const prefs = rt.guard("prefs", { get: () => store.prefs, set: (v) => store.setPrefs(v) });
```

| protection | how | works with |
|---|---|---|
| delivery `discard` | the response is delivered; its chain's writes to the protected fields are dropped synchronously inside each write, and its other fields (loading flags, counts) apply | atoms, `rt.guard`, `useGenClassState`, Redux and Zustand adapters, discovered Redux stores. Not offered when every field the response would write is observed only: `defer` still is |
| late revert | a background `mutation` decision to `discard` reverts the write if it was decided at most 800 ms after the write applied (`LATE_REVERT_MS`), its fields are unchanged since, and no later write of the same chain followed | any GenClass-aware store |
| `rollback` (heal) | restores the last settled snapshot where every learned relation held | stores GenClass can write |
| `resync` (heal) | calls your `resync` handler | stores registered with `{ resync }` |

The default never holds a store write: `set(x); get()` always returns `x` (write holds are opt-in,
`policy.holdWrites: true`).

## Visual and CSS checks (new in 0.3.0)

GenClass also measures visual bugs that never throw an error, in 23 kinds: text nearly the colour of its background,
images, fonts, stylesheets and media that failed to load, pages that scroll sideways on a phone, invisible layers
that swallow clicks, dialogs hidden behind other elements, and leaks such as "[object Object]" or "$NaN". Each report
names the element, what was measured and the threshold, and suggests a CSS change:

```
[GenClass] Check (measured): text contrast 1.04:1 on p.hero__subtitle "Ship faster with fewer bugs", below 1.5:1 (WCAG 2.2 contrast formula; unreadable-text threshold): #fafafa on #ffffff from section.hero. Suggested CSS: p.hero__subtitle { color: #737373; }
```

These are measured checks with fixed thresholds, reported as kind `"check"`; the model never sees them and they never
feed a decision. They skip what they cannot know (text over photos, video, canvases, gradients). They run by default
on development hosts (a dev server's port on `localhost` and similar, `*.test` names) and when the devtools overlay
mounts; elsewhere turn them on with `visual: true`. First-load cost is about 0.5 KB gzip; the checks load 1.5 s after
`load`, read the page in idle slices of 8 ms and send nothing. Opt-in fixes (`visual: { on: true, fix: true }` in
guard or heal mode) are re-measured and undoable. `checkPage()` from `@genclass/runtime/visual` runs one pass in a test.

On the demos, templates and compat apps: 0 false reports in 128 page views, and in the bench's run 5 recall 1.00 on
planted faults for 19 of the 23 kinds (0.67 to 0.96 for the other four; the planted forms are the checks' author's).
The checks were tuned on 40 public home pages, where run 5's 6 findings in 97 loads were not reviewed, so there is no
false-report rate for other sites yet
([RESULTS.md §14](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#14-visual-bench-false-reports-recall-and-cost-github-runners-chromium-153-2026-10-13-branch-wave2visual)).
Every kind: [API.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md#measured-visual-checks);
thresholds: [VISUAL.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/VISUAL.md).

## Observability

- **Console:** one line per detection and per intervention, with the evidence collapsed below it; identical repeats
  within a minute are summarised. `report: "silent"` or `report: (r) => …` to route them yourself.
- **Events and introspection:** `rt.on("detect" | "decide" | "act" | "report", fn)`; `rt.explain(id)` gives the exact
  situation text the model read, every answer with probabilities, and what changed; `rt.decisions()`,
  `rt.interventions()`.
- **Undo and audit:** `ActionRecord.undo()` for `discard`, late reverts, `rollback` and custom actions with `onUndo`;
  altered responses carry an `x-genclass` header. `rt.audit()` records every decision, action, undo and mode change
  with the gate, the probabilities and the model's sha256.
- **What it touches:**
  [INTERCEPTION.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/INTERCEPTION.md) lists
  every API GenClass wraps or listens to, what each mode may change, and every action's undo (a unit test keeps it in
  sync with the code).
- **Devtools overlay** with six views: Interventions (with Undo), Detections, Checks, Activity (requests, writes,
  user actions and errors with their causal links), Expectations and Now. It is a separate chunk, so load it in
  development only (`init` does this for you):

```ts
if (import.meta.env.DEV) {
  const { mountDevtools } = await import("@genclass/runtime/devtools");
  mountDevtools(rt);
}
```

### See it where you already look

In production the console lines print in your users' browsers. Sinks also send every detection, intervention, undo
and error to your side: JSON console lines for a log shipper (`console-json`), batched POSTs to your endpoint
(`webhook`), or a function or `{ send }` object of yours. `npx @genclass/runtime@beta init --sink webhook:/genclass`,
`data-sink="webhook:/genclass"`, or `sinks: [consoleJson(), webhook({ url: "/genclass" })]` from
`@genclass/runtime/sinks` (adapters and names: new in `0.3.0`). A sink never gets the situation text, bodies, headers
or cookies. Forwarding to Sentry, PostHog or Datadog is not part of the runtime: for an app in a GenClass account
with telemetry on and a token, the genclass.dev collector forwards likely detections once you turn it on in the
dashboard (every plan, Free included). Details:
[SINKS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/SINKS.md).

## Configuration

GenClass runs with safe defaults (`mode: "observe"`, a `"balanced"` gate once you opt into guard or heal, circuit
breaker on). The options narrow where it acts, cap how much it does, and send findings to your tools; none of them
tell the model what a bug looks like.

- **Your app** (`0.3.0`): `token` ([Your dashboard](#your-dashboard)), `scope` ([protect()](#function-specific-protect)).
- **Activation**: `enabled` (a boolean, a predicate or a feature flag; while false the model is never downloaded),
  `rt.disable({ undo: true })` (remote kill that also rolls back recent actions), `sample` (the share of sessions
  allowed to act).
- **Scope**: `routes` (per-route mode, which can only be lowered), `requests.ignore`, `requests.protect` (endpoints
  never held, retried, cached or discarded), `requests.labels`.
- **Safety**: `breaker` (automatic downgrade after undos or errors), `shadow` (records what a higher mode would have
  done), `onBeforeAction` (a synchronous veto), `policy.actionLimits`, `policy.holdBudgetMs`.
- **Reporting and loading**: `sinks`, `session` (tags, never shown to the model), `report: "interventions"`,
  `rt.summary()`; `model.loadIf`, `model.preload`, `model.maxDecisionsPerMinute`, `model.unloadAfterIdleMs`.

URL overrides can only lower settings. `?genclass=observe|guard|heal` may also raise the mode with `debug: true` or on
a development host (`localhost`, `*.local`, `*.test`, private networks); `?genclass-mode`, `?genclass-aggr` and
`?genclass-sample=1` may raise only with `debug: true`. `rt.status.effectiveMode` is the mode in force now.

```ts
import { GenClass, protectPreset } from "@genclass/runtime";

const rt = GenClass.init({
  mode: "guard",
  aggressiveness: "cautious",
  sample: 0.1,                                       // 10% of sessions act, 90% observe
  routes: [{ match: "/checkout/*", mode: "observe" }, { match: /^\/admin/, mode: "off" }],
  requests: { ignore: [/sentry\.io/], protect: [...protectPreset("payments", "auth"), "/api/cart"] },
  breaker: { undos: 2, errorsAfterAction: 3, downgradeTo: "observe" },
  shadow: "heal",
  report: import.meta.env.PROD ? "interventions" : "console",
});
```

**Payments, checkout and sign-in: keep them observe-only.** Automatic intervention in money and identity flows is not
recommended. `requests.protect` is checked first, in every mode, and covers the request, its response and everything
its response callbacks cause. `protectPreset("payments", "auth")` (in JSON configs, `"preset:payments"`,
`"preset:auth"`) matches checkout, payment, billing, order, Stripe-style and sign-in URLs;
`npx @genclass/runtime@beta init` suggests them when your project uses a payment SDK
([INTERCEPTION.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/INTERCEPTION.md#money-and-identity-flows)).

**Rollout recipe:** start with `mode: "observe", shadow: "guard"`, then `mode: "guard", sample: 0.05`, and widen
`sample` while `rt.summary().undos` and `breaker` events stay quiet. Every option:
[API.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md#options); why each exists:
[OPTIONS-SPEC.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/OPTIONS-SPEC.md).

## Ask it questions

The model answers typed questions about what is happening now:

```ts
const busy = await rt.ask({ type: "noul", instructions: "Is a save in flight or failing?" });
// { type: "noul", noul: <calibrated P(true)> }

const when = await rt.decide("Which upload strategy fits what is happening now?", {
  now: "start the upload immediately",
  later: "wait until the network is calm and the user is idle",
});
// "now" | "later"
```

Without a model both reject with `GenClassUnavailableError`. Short factual questions about the current situation work
best; it is not a general-purpose reasoner.

## Extend it

Plugins (`rt.use({ name, setup, actions, ... })`) can add observers, facts, actions, standing questions and diagnosis
labels. The model reads each action's description; the goal is that clearly described actions work without
retraining, which has not been measured
([API.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md#plugins)).

## Performance

- **Most work never reaches the model.** `test/review-perf.test.ts` (run in CI, reported, not blocking) holds a
  keystroke write into a store with a 5,000-item array under 1 ms, a Redux-style dispatch on 5,000 entities under
  1 ms (2 ms for a write from async work) and a settled-point check under 16 ms. Its last recorded run (a shared VM,
  2026-10-07, the runtime just before `0.1.0-alpha.1`, commit `bac4409`; not re-recorded since) measured 0.22 ms,
  about 0.7 ms and 0.3 ms.
- **Bundle:** the published `0.3.0-beta.0` measured 108.25 KB gzip for `/auto` and 100.13 KB for the main entry
  ([RESULTS.md §10](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#10-release-030-beta0-first-load-and-telemetry-volume-ci)).
  The interaction-analytics stub measured about 108.5 / 100.4 KB on its branch (§15); `main`, the coming
  `0.3.0-beta.1`, is not re-measured, and `test/bundle.test.ts` caps it at 108.6 / 100.48 KB. The model worker, ONNX
  Runtime, the devtools, the sinks and the visual checks load on demand; ONNX Runtime's `.wasm` (3.1 MB brotli; 5.5 MB
  with WebGPU, per the install tests) is never part of your build. The script-tag file is about 129 KB gzip.
- **Model:** with onnxruntime-web 1.30 on single-thread WASM, a forward pass takes an estimated 182 / 330 / 599 ms at
  500 / 780 / 1,170 tokens (fitted to runs in Node on the training VM, not in a browser), so about 180 ms per decision
  at the single-thread situation budget (1,000 characters). Serving the page with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` enables WASM threads
  (about 3× faster with 4 threads in headless Chromium, measured with GenClass 0.1's 32M-parameter model; not
  re-measured for model 0.2.0; model card).
- **Holds are bounded.** A held response or request waits at most the hold budget (by default 1.5 × the median of
  the last 20 model latencies, clamped to 150 to 800 ms), then proceeds unchanged. Background decisions have a 5 s
  deadline.

## Content-Security-Policy and self-hosting

By default the model files and ONNX Runtime's wasm come from `https://cdn.jsdelivr.net`, fetched by a worker. A policy
whose `connect-src` does not allow that origin blocks them: GenClass then keeps observing without a model and prints
**one** console warning naming the blocked origin and the fix. Either allow `https://cdn.jsdelivr.net` in
`connect-src`, or self-host (no third-party origin):

```bash
npx @genclass/runtime@beta fetch-model public/genclass-model   # model + ONNX Runtime files (into public/genclass-model/ort/)
npx @genclass/runtime@beta init --model-url /genclass-model/   # or pass the options yourself:
```

```ts
GenClass.init({ model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" } });
```

- `fetch-model` downloads every model variant and both ONNX Runtime builds (about 64 MB); `--variant q8 --ort wasm` is
  about 24 MB (then set `model.device: "wasm"`; `init --model-url` does this when it finds only the WASM build). The
  WebGPU build's wasm is 27 MB, over the 25 MiB per-file limit of some static hosts such as Cloudflare: use
  `--ort wasm` there. `info <dir>` verifies a downloaded directory's files.
- The policy also needs `'wasm-unsafe-eval'` in `script-src` and `worker-src 'self'` (or `blob:` for the script tag).
  When the worker cannot start, the model runs on the main thread (about 180 ms of blocking per decision on
  single-thread WASM) unless you pass `model: { inlineFallback: false }`.
- Anonymous diagnostics (on by default on public hosts) go to `https://genclass.dev/api/v1/events`: add
  `https://genclass.dev` to `connect-src`, or pass `telemetry: false`. A blocked page stops after 3 failed requests.
- A webhook sink on another origin needs that origin in `connect-src`.

CLI: `init`, `remove`, `login`, `connect`, `whoami`, `logout`, `fetch-model <dir>` (self-hosting) and `info <dir>`;
`npx @genclass/runtime@beta --help` lists them, and `init --help` and `login --help` give every flag (Next.js-only
`--strategy`: INSTALL.md).

## Questions

Short answers to the common questions (how to find race conditions in a React app, whether it changes what the app
does, how accurate it is, what it costs, what it sends) are in the
[FAQ](https://github.com/genclass-dev/GenClass-lib/blob/main/FAQ.md). Ask anything else, or report a bug or a false
detection, on [GitHub Issues](https://github.com/genclass-dev/GenClass-lib/issues) or
[Discord](https://discord.gg/kN9kRnFtZm). Security reports:
[SECURITY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/SECURITY.md).

## Documentation

- [Install](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/INSTALL.md): every `init` flag, tested setups
- [Dashboard and CLI](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/DASHBOARD.md): accounts, `login`, `.genclass.local`
- [Configuration](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/OPTIONS-SPEC.md) and [API](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/API.md): every option and export
- [Sinks](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/SINKS.md) · [Visual checks](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/VISUAL.md) · [Threat model](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/THREAT-MODEL.md)
- [What it intercepts](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/INTERCEPTION.md) · [Telemetry](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md)
- [Measured results](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) · [Compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md) · [Model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)
- [Changelog](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/CHANGELOG.md) · [All documents and the glossary](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/README.md#glossary)

## License

Apache-2.0. The model package, `@genclass/runtime-model` (Apache-2.0), comes with its own
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).
