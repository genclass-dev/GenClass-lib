# GenClass Runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=npm)](https://www.npmjs.com/package/@genclass/runtime)
[![npm beta](https://img.shields.io/npm/v/@genclass/runtime/beta?label=beta)](https://www.npmjs.com/package/@genclass/runtime?activeTab=versions)
[![CI](https://github.com/genclass-dev/GenClass-lib/actions/workflows/ci.yml/badge.svg)](https://github.com/genclass-dev/GenClass-lib/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/genclass-dev/GenClass-lib/blob/main/LICENSE)
[![model](https://img.shields.io/badge/model-runs%20in%20the%20browser-brightgreen)](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md)

**Website and docs: [genclass.dev](https://genclass.dev)** · [Docs](https://genclass.dev/docs) · [Guides](https://genclass.dev/guides) · [Benchmarks](https://genclass.dev/benchmarks) · [Pricing](https://genclass.dev/pricing) · [FAQ](FAQ.md) · [Discord](https://discord.gg/kN9kRnFtZm)

**GenClass Runtime (`@genclass/runtime`) is an open-source (Apache-2.0) browser library that reports race conditions
in web apps while they happen: stale responses that land over newer data, duplicate requests such as double submits,
inconsistent state and failure storms.** A small model runs on the user's device, in a Web Worker on WebGPU or WASM,
and each report comes with its evidence. By default it only reports (`observe`): it never holds, delays or changes a
request, a response or a state write. The opt-in `guard` mode may act on a few of them
([how often](#what-it-finds-measured)), and `heal` is experimental. It runs in React, Next.js, Vue, SvelteKit,
Angular, Solid and plain-HTML apps (measured in Chromium with an unpublished 0.1.0-beta.4 build and model 0.2.0 on
2026-10-10, not re-run on 0.2.2 or 0.3.0:
[compatibility matrix](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md)).

Versions (npm dist-tags on 2026-10-24): `0.2.2` is `latest` and `0.3.0-beta.0` is `beta`. This README describes the
`0.3.0` line; what is marked `0.3.0-beta.1` (the coding-agent link, interaction analytics) is tagged and not on npm yet.
Both load the model `@genclass/runtime-model@0.2.0`. AI coding agents working on this repository: start at
[AGENTS.md](AGENTS.md).

<a id="install"></a>

## Quick start

```bash
npx @genclass/runtime@beta init   # finds your framework and shows the diff before it writes anything
```

Once you approve, `init` installs the package, adds one import first in your entry file (plus a line that loads the
devtools overlay in development only) and creates your app's dashboard token (`--no-token` skips it; every flag:
[INSTALL.md](docs/runtime/INSTALL.md)).

Or by hand: `npm install @genclass/runtime@beta`, then first in your entry file (any bundler; Next.js 15.3 or later:
`instrumentation-client.ts`, earlier versions: a client component in the root layout or `pages/_app`):

```ts
import "@genclass/runtime/auto";
```

Or with no build step, first in `<head>`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.1"></script>
```

- **That covers network, user actions, errors and timing in the whole app, and its state where it can be found.**
  React component state, Redux / Redux Toolkit stores and Zustand stores with `devtools` (in production builds only
  with `devtools(..., { enabled: true })`) are discovered automatically; discovered React and Zustand state is
  observed only. Vue / Pinia, Svelte stores, signals, MobX, Jotai and Recoil are not discovered: register such state
  with `rt.atom` / `rt.guard`
  ([state it can protect](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#state-it-can-protect)).
  `GenClass.init()` is the explicit setup; it discovers state only if you import `@genclass/runtime/discover` first
  and pass `autoState: true`.
- **Pin the version in the script tag**, as above: the unversioned URL serves `latest`, and the CDN cache may serve an
  older release.
- **Keep `@beta` while `0.3.0` is in beta.** Without it npm installs the stable `0.2.x`, whose CLI has no `login`,
  `connect`, `whoami`, `logout`, `dashboard` or `--sink` and whose runtime ignores a token.
- **ESM only** (no `require`). Jest users need a `transformIgnorePatterns` entry that lets `@genclass/runtime` be
  transformed.

Full install guide, with every `init` and `remove` flag, the app token and the tested project setups:
[docs/runtime/INSTALL.md](docs/runtime/INSTALL.md). The short version, with page configuration and the script-tag
attributes, is in the
[package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#install).

## What it finds (measured)

Model `@genclass/runtime-model@0.2.0` at the default profile, `balanced`, on held-out data never used in training
([RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) §1, §11; every headline number is under
[current numbers in one place](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#current-numbers-in-one-place)):

| problem | reported with the right diagnosis (observe, held-out real apps; false detections limited to 2% per clean decision) |
|---|---|
| duplicate submits | 75% |
| stale responses written over newer data | 30% on the `situation-v2.3` slice the current runtime renders (21% on `situation-v2`) |
| broken state (a relation between fields stops holding) | 6% |

- **False reports.** The report gate was fitted on development data to at most 2% false detections per clean
  decision on real apps (3% on simulated apps) and met that limit on held-out test; the exact rate is not published.
  In `0.3.0`, three observe fixes (superseded writes, the response-body wait, the idle unload) can add likely reports,
  false ones included, at a rate not measured (§11). In the compatibility matrix (an unpublished 0.1.0-beta.4 build,
  commit `d04eff3`, 2026-10-10), observe made 49 false findings in 880 runs of correct apps, all in one polling and
  fan-out scenario
  ([RESULTS.md §16](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#16-compatibility-matrix-summary)).
- **Possible detections (0.3.0).** Observe in `0.3.0-beta.0` also records detections below the report gate, at the
  `eager` profile's gate (0.70), to `console.debug`, the devtools and telemetry. Likely and possible together are
  expected to match the `eager` profile's offline rates (77% of duplicate submits, 45% of stale overwrites, 40% on
  `situation-v2`, and 13% of broken state; false-detection limit 5% on real apps and 6% on simulated, met on held-out
  test). This was not measured end to end on `0.3.0`; how many false detections the possible tier adds, and what
  share of possible detections is false, are not measured (§11).
- **Effect on correct apps.** In the same matrix GenClass introduced 0 bugs in 3,510 runs. Observe is still not
  byte-identical to running without GenClass: in 1 of its 117 observe cells (Next.js + SWR, scenario d, on seed 7)
  its own work changed which side of the app's own race won, towards the correct result, without any action; the
  same happened in 3 guard and heal runs.
- **Acting (`guard`, opt-in).** It acts on 7.8% of clear simulated cases and 7.5% of real-app cases where acting
  would help. It fired on 0.13% of the simulated cases where doing nothing was best, and on 0.00% on held-out real
  apps. It reports far more than it fixes.
- **Visual and CSS checks** (new in 0.3.0; measured checks with fixed thresholds, not the model): 35 of 35 planted
  faults found on fixture pages written by the checks' author. On the bench, recall 1.00 for 20 of 23 planted fault
  kinds (19 of 23 after the review; `click-blocked` and `scroll-lock-stuck` 0.67) with 0 false reports in 128 page
  views of unmodified demo, template and compatibility apps. On public sites the false-report rate after the review
  is not known, and three of the proposed cost limits are not met (§13, §14).

The full tables, with every false-intervention rate next to its recall, are under [Measured results](#measured-results).

## What you will see in the first two minutes

- One console line saying anonymous diagnostics are on (`[GenClass] Sends anonymous diagnostics (decisions and
  counts, no page text) to improve the model. Opt out: …`). From `0.2.2` it does not appear on `localhost` or other
  local hosts; earlier versions (`0.1.0-beta.3` to `0.2.1`) send from them too.
- `[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.4s). Mode: observe.` once the model has loaded at idle.
- Then possibly nothing for a while. Observe mode reports only salient situations (a response landing over newer
  data, a repeat, a failure streak, a broken relation, an error), and the first response of each kind after a page
  load is never a delivery decision: the runtime first has to see what that request writes.
- The devtools overlay: `Alt+Shift+G` on localhost (the `init` command loads it in development only).
- The first-visit cost, measured on one pilot app with runtime 0.1.0-beta.3 and model 0.2.0
  ([RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) §17): about 13 MB
  downloaded from jsDelivr on WASM (12.7 MB measured, with the q8 model at 9.45 MB as recorded, ONNX Runtime's wasm
  at 3.07 MB brotli and the tokenizer; the q8 file itself is 10.2 MB); on WebGPU with `shader-f16`, the 13.6 MB fp16
  model plus a larger ONNX Runtime build. Both are cached afterwards. The renderer process uses 190 to 280 MB more
  memory while the model is loaded. Devices that report 2 GB of memory or less, and Save-Data connections, do not
  load the model by default (they observe without it and say so in one console line; new in `0.3.0`: `0.2.x` loads
  everywhere and only lazily on Save-Data). For phones and strict Content-Security-Policies see
  [self-hosting](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting)
  and [`loadIf`](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#costs).

## New: your coding agent can see the race, replay it, and prove the fix

`@genclass/mcp` (unreleased) is an MCP server for Claude Code and other coding agents. Your app's development build
(`@genclass/runtime` `0.3.0-beta.1` or later) connects to it with one line, and the agent gets every click, request, the order the responses arrived and what they
wrote, uncaught errors with the click and request behind them, and the on-device model's detections. It can run your
steps again with the network answering in different orders (and slower) to find what depends on timing, replay the
exact order that broke, and write a Playwright test that fails until the fix is in. Everything stays on your machine.

```bash
claude mcp add genclass -- npx -y @genclass/mcp@0.1.0
```

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // development builds only
```

On a real page in headless Chromium, it found a stale-results race in 5 of 6 reordered runs of a page that never
showed it on the developer's fast backend, with no false report on the fixed page ([AGENT.md](docs/runtime/AGENT.md),
[RESULTS.md](docs/runtime/RESULTS.md) section 18).

## New in 0.3.0: app dashboards and `protect()`

In `0.3.0-beta.0` (`@beta` on npm). `0.2.x` ignores `token`, has no `protect()` export (an import of it fails), and
its `init` creates no token. Details:
[CHANGELOG](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/CHANGELOG.md), 0.3.0-beta.0.

```ts
import { GenClass, protect } from "@genclass/runtime"; // 0.3.0

GenClass.init({ token: "gc_your_app_token", scope: "functions" }); // scope: decide only inside protect()ed functions
// what GenClass finds here (a double submit, overlapping calls, a failure) is reported under "checkout submit"
export const submitOrder = protect("checkout submit", (cart) => fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) }));
```

- **Token and dashboard.** A token (`gc_` plus 22 letters and digits, public) groups your app's diagnostics under a
  private dashboard link (`https://genclass.dev/dashboard/...`). The dashboard is free for every app, with or without
  an account. Get a token at [genclass.dev/start](https://genclass.dev/start), or let `init` create it after you
  approve its diff. To keep dashboards in an optional genclass.dev account, `npx @genclass/runtime@beta login` signs in
  from the terminal (device flow) and connects the app in the current folder; `connect`, `whoami` and `logout` do the
  rest, and `npx @genclass/runtime@beta dashboard` prints an app's link again (from `0.3.0-beta.2`). The dashboard fills from deployed pages with telemetry on. Local and private hosts (`localhost`, `*.local`,
  `*.test`, private networks) do not send by default; `telemetry: true` or any telemetry options object is an
  explicit opt-in that sends from them too, with the token. Data is kept for 90 days (a year on Enterprise). Details:
  [docs/runtime/DASHBOARD.md](docs/runtime/DASHBOARD.md).
- **`protect(name, fn)`** returns a function with the same signature (same `this`, arguments, return value and
  errors); decisions about what it causes carry `fn: name`. Without a runtime it just calls `fn`.
  [Package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#function-specific-protect).
- **More sensitive observe mode.** Observe also reports *possible* detections, below the report gate at the `eager`
  profile's value: one `console.debug` line each, ending in `(possible)`. Your `rt.on("detect")` and report function
  get them only with `detect: "possible"`; `detect: "likely"` turns them off. Situations raised while the model loads
  or the tab is hidden are decided once it can, and reported at the possible tier at most until their false-report
  rate is measured.
  [Package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#modes).

## How it works

GenClass Runtime records what the app does: user actions, async operations and their causal chains, network traffic
(fetch, XHR, WebSocket, EventSource), store writes with per-field versions, errors and timing. It computes generic
facts about each write, request and response, and asks the model only about salient situations and the questions you
ask it yourself (step 3). The model answers two questions: what is happening, and which available action is best.
The model path has no list of known bugs in the code; the separate visual and CSS checks are measured checks with
documented thresholds and do not feed the model. One indirect path remains: a check that makes the browser lay out a
very heavy page can cause a long task, which the runtime records as a `perf` event the model can read
([VISUAL.md](docs/runtime/VISUAL.md), section 1).

1. **Observe.** Fetch, XHR, WebSocket, EventSource, DOM events, errors, navigation, storage, long tasks and timers
   are instrumented. Async work is linked into causal chains. Stores created through GenClass, or wrapped with its
   Redux, Zustand, React or generic adapters, get per-field versions and write histories.
2. **Learn.** The runtime learns per-operation baselines (latency, failure rate, request rate) and which fields each
   operation usually writes. It also learns cadences (polling, debounced saves) and relations that keep holding
   (`total == sum(items[*].price × qty)`, `selectedId ∈ items[*].id`).
3. **Triage.** Cheap facts are computed for every write and request. By default only salient situations reach the
   model: a response landing over newer data, a repeated request, a failure streak, a broken relation, an error.
   Your own questions (`rt.ask()`, `rt.decide()`) and plugin questions marked `always` are asked regardless.
4. **Decide at the network boundary.** In `guard` and `heal`, responses and push messages are judged *before the app
   sees them*; in `observe` they reach the app at once and are judged in the background:
   - `deliver` (passive);
   - `discard` (deliver, but drop the writes it makes over newer data);
   - `defer` (wait for related in-flight work).

   Store writes are never held or reordered by default. Salient writes that no delivery decision covered are
   decided in the background; in `guard` and `heal` one can be reverted only if the decision comes within 800 ms of
   the write applying (`LATE_REVERT_MS`; 2 s before `0.2.0`) and nothing has overwritten it.
5. **Act by mode.**

   | mode | behaviour |
   |---|---|
   | `observe` (default) | reports only; never holds, delays or changes a request, a response or a state write |
   | `guard` (opt-in) | `discard`, `defer`, `coalesce`, `delay`, only when the model's gate for that trigger says acting beats doing nothing by the margin of the chosen `aggressiveness` profile |
   | `heal` (experimental) | also `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync` and plugin actions declared with `tier: "heal"` (the default; one declared `tier: "guard"` also runs in guard), at the heal margin of the profile |

   Detections are reported when the top diagnosis is not `expected` with probability at or above the profile's
   report threshold (0.95 / 0.90 / 0.70 for cautious / balanced / eager with model 0.2.0). `rt.gates()` shows what
   is in force.

6. **Explain.**
   - Every detection and intervention is logged in plain English, with the exact situation text the model read.
   - Reversible actions can be undone.
   - `?genclass=off` installs nothing.

## How GenClass compares

- **Error trackers and APM (Sentry, Datadog).** They collect exceptions, traces and timings. A stale response, a
  double submit or a write race usually throws nothing, so there is no error to collect. GenClass looks for those
  situations inside the page, decides on the user's device and reports what it saw. It does not replace an error
  tracker: from `0.3.0` its reports can go to your own logging through `sinks` ([SINKS.md](docs/runtime/SINKS.md)),
  and for apps in a genclass.dev account (any plan, Free included) the collector can forward likely detections to
  Sentry, PostHog, Datadog, Slack or a signed webhook.
- **Product analytics.** Analytics count what users do; GenClass reports what the app got wrong while they did it.
- **Tests and linters.** These bugs depend on response order and user timing. A test on a fast, ordered network can
  pass while production shows the bug. Use GenClass next to your tests, in development (the devtools overlay) and in
  production.
- **AbortController, request ids, TanStack Query or SWR deduplication, idempotency keys.** These are the fixes, and
  they work where they are used. GenClass reports places where one is missing; in `guard` it can discard a stale
  write or coalesce a repeated request when its gate clears.

<a id="measured-behaviour"></a><a id="results-so-far"></a>

## Measured results

Every recall is reported next to its false-intervention rate (FIR): the share of cases where doing nothing was best
but the gate fired anyway. Source and history:
[RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md).

**Shipped model:** `genclass-runtime-r17` 2.0.0-rc4t (`@genclass/runtime-model@0.2.0`, run `r17-v2dT`, gain gate),
10.2 MB q8, about 180 to 600 ms per model pass at 500 to 1,170 tokens on one WASM thread (estimated from runs in Node,
not in a browser), loaded from jsDelivr at idle and cached. The model and the
situation text it reads (`situation-v2.3`) are the same in `0.2.2` and `0.3.0-beta.0`. On held-out data (§1):

| profile | guard FIR | guard recall (clear / real) | heal FIR | heal recall (clear / real) | report threshold |
|---|---|---|---|---|---|
| `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 |
| `balanced` (default) | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 |
| `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 |

The FIR columns are on simulated apps; on held-out real apps FIR was 0.00% for every profile. Our targets are guard
FIR ≤ 0.1% and heal FIR ≤ 0.5%: `cautious` stays under both, `balanced` is slightly over both, `eager` is well over.
Recall is still low: at `balanced`, guard acts on under 8% of the cases where acting would help. Calibration error
is not yet measured for this model (r17-v2b: 0.021 to 0.023). See the
[model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).

| what | result |
|---|---|
| Compatibility matrix (7 apps: 6 frameworks and plain HTML; 15 data layers, 8 scenarios, 10 seeds; an unpublished 0.1.0-beta.4 build, commit `d04eff3`, which does not contain 0.2.0's audit trail, protect presets, hold-budget ceilings and invariant fixes (committed on another branch) and predates 0.2.1's first-request hold and telemetry defaults; model 0.2.0, `balanced`, 2026-10-10; not re-run on 0.2.2 or 0.3.0) | 0 bugs introduced in 3,510 runs; 0 actions on correct apps in 1,760 guard and heal runs; observe: 49 false findings in 880 correct-app runs; of 250 runs where the app's own bug showed, guard left 249 buggy and heal 240. 350 of 351 cells left the app at least as correct as without GenClass on every seed (observe: the same final page and server state); the other is observe on Next.js + SWR, scenario d, where on seed 7 GenClass's timing tipped the app's own race to the correct result without any action ([compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md), §16). |
| Never make a correct app worse (always-passive model, heal vs observe, 66 real apps × 6 seeds; runtime as of 0.1.0-alpha.1, not re-run) | 0 of 396 clean runs changed (final page text, inputs and alerts excluded, and server state). Request timing and store contents are not compared, nor is observe against no runtime. With chaos: 3 of 198. In the demos (guard, same runtime and model), a clean typeahead made 0 model calls and held for 0 ms (§4). |
| Six demo apps under network chaos (model 0.2.0, `balanced`, runtime 0.1.0-beta.4, an unpublished build of 2026-10-09; 10 chaos + 5 clean seeds per demo and mode) | Bug rate 72% off, 70% observe, 72% guard, 73% heal (differences under 5 points are noise): nothing is healed at the shipped gates, because candidate gains rarely clear the margins; 0 false interventions on clean runs (§5). |

**Training.** A 150M teacher was trained and scored below r17-v2b on every held-out set, so distillation was skipped
(§1). Data so far: 10.4M simulated gold rows plus a 2.1M `situation-v2.3` top-up, 2.3M on-policy rows, 51M unlabeled
rows and 837,623 real-browser rows (§6). Recall is the open problem.

<details>
<summary>Earlier models (not shipped today)</summary>

| what | result |
|---|---|
| Round 1 model, R17 (9.6 MB q8; format `situation-v1`, not compatible with this runtime), simulated apps | Diagnosis 90.5%, action 81.9%, guard FIR 0.05%, heal FIR 0.24%; recall on clear stale and duplicate cases only 7.7% (precise but timid) (§1). |
| Why round 1 was timid ([sim/SEPARABILITY.md](sim/SEPARABILITY.md), §3) | 62 to 82% of clear actionable rows had a benign twin with identical visible facts; 24% of clear rows were mislabelled `expected`; labels assumed knowledge a runtime cannot have. The v2 format adds measured facts, with relabelled data. |
| r17-v2b (shipped as `@genclass/runtime-model@0.1.0`) | Simulated apps: diagnosis 84.2%, action 77.8%. Real apps: diagnosis 83.6%, action 80.0%. Guard FIR 0.01% with guard recall 0.6% of clear simulated cases; heal FIR 0.07% with heal recall 5.7% of actionable real-app cases (§1; an earlier, stricter fit, not exactly like-for-like with 0.2.0). |
| The same never-worse check on the v1 runtime (store-write holds) | 4 of 198 clean runs changed (2 apps); the React/Redux RealWorld app never rendered its home feed (§4). |

</details>

## Privacy and telemetry

- **Decisions are local.** The model runs in the browser; nothing is sent to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()`, `/auto` and the script tag on public hosts,
  sent to the GenClass maintainers' collector ([`telemetry-worker/`](telemetry-worker), a Cloudflare Worker writing
  to a private R2 bucket) to improve the model. One console line per page says it is on. Off on local and private
  hosts (`localhost`, `*.local`, `*.test`, private networks) from `0.2.2` (`0.1.0-beta.3` to `0.2.1` send from them
  too), in Node/SSR and in `createRuntime()`.
- **By default no text from your page is sent.** Sent: a random per-page session id, versions, mode, device class,
  the page's hostname and id-normalised path, and per decision the trigger, the diagnosis and its confidence, the
  action and gate, the outcome and latency (every detection, every decision whose diagnosis is not `expected`, every
  action and veto; in `0.3.0` possible detections too, marked `tier: "possible"`, and routine decisions only one in
  four, at most 200 per page load, with exact counts; `0.2.2` and earlier send every decision). The collector adds a
  coarse country (two letters) and stores no IP address or user agent.
- **Opt out:** `GenClass.init({ telemetry: false })` (script tag: `data-telemetry="off"`; meta tag:
  `telemetry=off`; or `window.GENCLASS_CONFIG = { telemetry: false }`), `?genclass=no-telemetry`,
  `localStorage.setItem("genclass.telemetry", "off")` or `npx @genclass/runtime@beta init --no-telemetry`; browsers
  sending Global Privacy Control are never collected.
- **The situation text the model read is sent only if you opt in** (`telemetry: { include: { situation: true } }`;
  off by default since `0.2.1`, while `0.1.0-beta.3` to `0.2.0` send it by default). It is redacted by field
  meaning, but can still contain route names with query strings, short error messages and short field values; read
  TELEMETRY.md first.
- **With an app token** (`0.3.0`), batches also carry the token and the names of your `protect()`ed functions, so
  they show on your app's dashboard. Without telemetry, a token does nothing.
- **Interaction analytics are off unless the app turns them on** (`analytics: true` with the app's token; on `main`
  only, listed in the CHANGELOG under 0.3.0-beta.1, unreleased: the published `0.3.0-beta.0` does not have them):
  per page view the route, engaged time, scroll depth, and clicks, rage clicks and dead clicks per element (named
  from markup, never its text). No visitor id, nothing stored on the device, never used for a decision, and every
  opt-out above turns them off. Where consent is needed (the EU, EEA and UK), leave `analytics` unset and call
  `runtime.analytics.start()` once the visitor consents.
- **The visual checks send nothing.**
- **The CLI** contacts genclass.dev only for the command you run (`init` creates a dashboard only after you approve
  its diff).
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). Full schema, storage and guidance:
  [TELEMETRY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md); what an
  account stores: [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md).

## Security

- [SECURITY.md](SECURITY.md): how to report a vulnerability, supported versions.
- [packages/runtime/INTERCEPTION.md](packages/runtime/INTERCEPTION.md): every browser API GenClass wraps or listens
  to, what each mode may change, what it never does, every action's preconditions and undo, and how `disable()` and
  `?genclass=off` restore the page (checked against the code by a unit test).
- [docs/runtime/THREAT-MODEL.md](docs/runtime/THREAT-MODEL.md): page scripts, the model supply chain, crafted
  responses, denial of service, telemetry and state discovery, with mitigations and residual risks.
- `rt.audit()` exports a structured record of every decision and action; payment, checkout and sign-in endpoints
  should stay observe-only (`requests: { protect: protectPreset("payments", "auth") }`).

## Documentation

- [Docs index and glossary](docs/runtime/README.md): every document, what it answers and its status.
- [Package README](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md): the full guide
  (modes, triggers, adapters, observability, performance, privacy, known limitations).
- [API reference](docs/runtime/API.md), [interception surface](packages/runtime/INTERCEPTION.md),
  [CHANGELOG](packages/runtime/CHANGELOG.md).
- Measurements: [RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md) (every
  measured number), [compat/RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/compat/RESULTS.md) (the
  compatibility matrix), the
  [model card](https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime-model/MODEL_CARD.md).
- Guides on genclass.dev: [race conditions in React](https://genclass.dev/guides/race-conditions-react),
  [stale responses out of order](https://genclass.dev/guides/stale-responses-out-of-order),
  [preventing duplicate submissions](https://genclass.dev/guides/prevent-duplicate-submissions).

## Questions

Short answers to the common questions (race conditions in React, stale responses, double submits, whether it changes
your app, what it sends, how big it is, what it costs, how it compares) are in [FAQ.md](FAQ.md). Ask in
[GitHub Discussions](https://github.com/genclass-dev/GenClass-lib/discussions/categories/q-a) or on
[Discord](https://discord.gg/kN9kRnFtZm); report bugs and false detections in
[Issues](https://github.com/genclass-dev/GenClass-lib/issues).

## Development

Node ≥ 20. From the repo root:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci   # the root lockfile is committed; skip onnxruntime-node's CUDA download
npm run typecheck -w @genclass/runtime
npm run build -w @genclass/runtime
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets, run alone
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml), Node 22) runs on pushes to `main`, `runtime`, `mvp` and
`mvp-v2`, on pull requests, and on manual dispatch, in three jobs:

- `runtime`: the typecheck, build and unit tests above (14 tests skip: the model-parity tests, which need
  `GENCLASS_MODEL_DIR`), then the perf budgets in their own step, reported but not blocking, because they time a
  5,000-item store and can fail under parallel load;
- `visual-browser`: the first-load size against the release line, and the measured visual checks in Chromium with
  Playwright;
- `telemetry-worker`: the collector's unit tests.

`@genclass/playwright` has its own workflow,
[.github/workflows/playwright-reporter.yml](.github/workflows/playwright-reporter.yml) (typecheck, build, unit tests
and the fixture's end-to-end check in Chromium); it never blocks `ci.yml`. The
visual bench, [.github/workflows/visual-measure.yml](.github/workflows/visual-measure.yml), runs on manual dispatch
and on pushes that change `bench/visual/` on the `wave2/visual` branch, never on pull requests, because it loads
public sites.

Not in CI, because they are heavier or need Azure (read [AGENTS.md](AGENTS.md) before running them): the model
Playwright suite (`npm run test:browser` in `packages/runtime`), the npm tarball smoke test (`test/smoke/smoke.sh`),
the install suite (`test/install/run-all.sh`), the sim, the real-app corpus, the demos' evaluation, and training.

Releases are published by [.github/workflows/release.yml](.github/workflows/release.yml) from a `v*` tag, with npm
provenance.

**The training format is tagged.** The current tag is `situation-v2.3`, which runtime `0.1.0-beta.0` and later
render; the shipped model was trained on `situation-v2` data plus the `situation-v2.3` top-ups (simulated and real).
Any change to `packages/runtime/src/situation/*` (or other text the model reads) changes the model's input and means
a new tag and regenerated data (`training/curriculum/rt.py` mirrors the renderer and must change with it).

<a id="whats-in-this-repo"></a>

## Repository layout

| path | what |
|---|---|
| [`packages/runtime`](packages/runtime) | `@genclass/runtime`, the library: observers, causality, stores and adapters, learned baselines, relations and profiles, facts, triage, policy gate, actions, model host (Web Worker, ONNX Runtime Web on WebGPU or WASM), measured visual checks, devtools overlay. [README](packages/runtime/README.md) · [CHANGELOG](packages/runtime/CHANGELOG.md) |
| [`packages/runtime-model`](packages/runtime-model) | `@genclass/runtime-model`, the default model package (data only; `files/` is gitignored and filled at release time) and its [model card](packages/runtime-model/MODEL_CARD.md) |
| [`packages/mcp`](packages/mcp) | `@genclass/mcp` (unreleased), the MCP server for coding agents: pages connect through `@genclass/runtime/agent`; the agent gets findings in causal order, replays, explore verdicts and generated regression tests ([AGENT.md](docs/runtime/AGENT.md)). [README](packages/mcp/README.md) |
| [`packages/playwright`](packages/playwright) | `@genclass/playwright` (unreleased), GenClass for Playwright: a fixture that puts the runtime on every page under test (observe mode, seeded network chaos with `page.route`, the model skipped by default) and writes one race file per test, and a reporter that turns those files into one markdown report for the pull request, with the evidence line and what reproduced across seeds. [README](packages/playwright/README.md) |
| [`packages/nuxt`](packages/nuxt), [`packages/astro`](packages/astro) | `@genclass/nuxt` and `@genclass/astro` (unreleased): the runtime as a Nuxt module and as an Astro integration, one line in the framework's config, with options for the mode, the token, telemetry and the devtools overlay; browser only. [Nuxt README](packages/nuxt/README.md) · [Astro README](packages/astro/README.md) |
| [`packages/sv`](packages/sv) | `@genclass/sv` (unreleased), a community add-on for the Svelte CLI: `npx sv add @genclass` sets up GenClass in a SvelteKit app (the dependency, its import first in `src/hooks.client`, the devtools overlay in development). [README](packages/sv/README.md) |
| [`docs/runtime`](docs/runtime) | [Docs index](docs/runtime/README.md) · [Results](docs/runtime/RESULTS.md) · [Coding agents](docs/runtime/AGENT.md) · [API](docs/runtime/API.md) · [Architecture](docs/runtime/ARCHITECTURE.md) · [Build contract](docs/runtime/CONTRACT.md) · [Threat model](docs/runtime/THREAT-MODEL.md) |
| [`compat`](compat), [`templates`](templates) | Framework compatibility matrix (7 apps, 15 data layers, every mode; [RESULTS.md](compat/RESULTS.md)) and eight starter templates with the one line (React + Vite, Next.js, Vue + Vite, SvelteKit, Astro, Nuxt, React Router, Angular; [templates/README.md](templates/README.md)) |
| [`demos`](demos), [`bench`](bench) | Six demo apps (typeahead, autosave, checkout, flaky dashboard, live kanban, real-time decisions) with a Service Worker chaos backend and Playwright trials; [`bench/heal`](bench/heal) runs them per mode, [`bench/visual`](bench/visual) measures the visual checks |

<details>
<summary>The rest of the repository</summary>

| path | what |
|---|---|
| [`packages/genclass-runtime`](packages/genclass-runtime) | `genclass-runtime`, the former short name for the CLI: no longer published, and its newest npm version installs an unsupported runtime; use `@genclass/runtime` |
| [`sim`](sim) | Training-data simulator: random apps run on the real runtime in a deterministic virtual world, labelled by counterfactual outcomes |
| [`realapps`](realapps) | 158 real apps (144 written for the corpus, 14 open-source RealWorld front-ends) run with the real runtime in headless Chromium, labelled the same way; the never-worse sweep covered the first 66. [README](realapps/README.md) |
| [`training`](training) | Vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime's renderer), multi-node CPU training on Azure, ONNX export, evaluation ([EVAL.md](training/EVAL.md)) |
| [`telemetry-worker`](telemetry-worker) | The diagnostics collector, the dashboards and the accounts (Cloudflare Worker). The genclass.dev site and the page check are in a separate, private repository. |
| [`billing`](billing) | `plans.json`, the one place the genclass.dev plans are defined; the collector and the pricing page read it |
| [`research`](research) | Earlier GenClass/Jev research (voice-control Chrome extension, the `jev_local` encoder and server, classifier benchmarks); the training scripts still use `jev_local` ([README](research/README.md)) |
| [`scripts`](scripts) | Azure VM helpers for training runs |
| [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work in this repository |

</details>

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
