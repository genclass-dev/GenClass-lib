# GenClass Runtime

[![npm](https://img.shields.io/npm/v/@genclass/runtime/latest?label=%40genclass%2Fruntime)](https://www.npmjs.com/package/@genclass/runtime)
[![CI](https://github.com/genclass-dev/GenClass-lib/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![website](https://img.shields.io/badge/web-genclass.dev-14B86A)](https://genclass.dev)

**Website and docs: [genclass.dev](https://genclass.dev)** · [Discord](https://discord.gg/kN9kRnFtZm) · [Docs](https://genclass.dev/docs) · [Benchmarks](https://genclass.dev/benchmarks) · [Cloud](https://genclass.dev/cloud) · [Pricing](https://genclass.dev/pricing)

**A runtime for web apps. It watches the app from the inside and uses a small local model to flag, and optionally
prevent, stale responses, races, duplicate requests, inconsistent state and failure storms.**

One line, first in `<head>` or first in your entry file:

```html
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@0.3.0-beta.0"></script>
```

```ts
import "@genclass/runtime/auto"; // after npm install @genclass/runtime
```

Pin the version in the script tag, as above: the unversioned URL may serve an older release from the CDN cache.

That covers the whole app: network, user actions, errors, timing, and the app's state (React component state,
Redux / Redux Toolkit and Zustand `devtools` stores are discovered automatically; discovered React and Zustand state
is observed only). Observe mode by default: it reports only. `npx @genclass/runtime init` writes the line for you;
`GenClass.init()` is the explicit setup ([package README](packages/runtime/README.md#automatic-state-discovery)).

GenClass Runtime records what the app does: user actions, async operations and their causal chains, network
traffic (fetch, XHR, WebSocket, EventSource), store writes with per-field versions, errors and timing. It computes
generic facts about each write, request and response, and asks a small GenClass model only about salient situations.
The model runs in the browser (WebGPU or WASM, in a Web Worker). It answers two questions: what is happening, and
which available action is best. There is no list of known bugs in the code.

**Status: `@genclass/runtime@0.3.0-beta.0` (npm `beta` dist-tag: `npm install @genclass/runtime@beta`; the stable
line is `0.2.x`) with model `@genclass/runtime-model@0.2.0`.** Observe by default; `guard` is
opt-in; `heal` is experimental. Measured false-intervention and recall rates are under
[Measured behaviour](#measured-behaviour). AI coding agents: start at [AGENTS.md](AGENTS.md).

## Install

Pick one; all of them start the same runtime in observe mode unless you choose otherwise. Full install guide, with
`init` flags, page configuration and the script-tag attributes: [package README](packages/runtime/README.md#install).

```bash
npx @genclass/runtime init          # finds the framework, adds the import, shows the diff first
npm install @genclass/runtime       # then: import "@genclass/runtime/auto" (or GenClass.init())
```

The package is **ESM only** (no `require`). Jest users need `transformIgnorePatterns` that lets
`@genclass/runtime` be transformed.

### What you will see in the first two minutes

- One console line saying anonymous diagnostics are on (`[GenClass] Sends anonymous diagnostics (decisions and
  counts, no page text) to improve the model. Opt out: …`); since `0.2.2` it does not appear on `localhost`
  or other local hosts (`0.2.1` sends and shows it there too, by mistake).
- `[GenClass] Model ready (genclass-runtime-r17, wasm, q8, 0.4s). Mode: observe.` once the model has loaded at idle.
- Then possibly nothing for a while. Observe mode reports only salient situations (a response landing over newer
  data, a repeat, a failure streak, a broken relation, an error), and the first response of each kind after a page
  load is never a delivery decision: the runtime first has to see what that request writes.
- The devtools overlay: `Alt+Shift+G` on localhost (the `init` command loads it in development only).
- The first-visit cost: about 13 MB downloaded from jsDelivr on WASM (model 10 MB plus ONNX Runtime's wasm) or
  18 MB on WebGPU, cached afterwards, and 190–280 MB of memory in a Web Worker while the model is loaded. Devices
  that report 2 GB of memory or less, and Save-Data connections, do not load the model by default (they observe
  without it and say so in one console line; new in `0.3.0`: `0.2.x` loads everywhere and only lazily on
  Save-Data). For phones and strict Content-Security-Policies see
  [self-hosting](packages/runtime/README.md#content-security-policy-and-self-hosting) and
  [`loadIf`](packages/runtime/README.md#costs) in the package README.

### New in 0.3.0: app dashboards and `protect()`

In `0.3.0-beta.0` (`@beta` on npm): `0.2.x` ignores `token` and has no `protect()` export (an import of it fails),
and its `init` creates no token. Details: [CHANGELOG](packages/runtime/CHANGELOG.md), 0.3.0-beta.0.

```ts
import { GenClass, protect } from "@genclass/runtime"; // 0.3.0

GenClass.init({ token: "gc_your_app_token", scope: "functions" }); // scope: decide only inside protect()ed functions
// what GenClass finds here (a double submit, overlapping calls, a failure) is reported under "checkout submit"
export const submitOrder = protect("checkout submit", (cart) => fetch("/api/orders", { method: "POST", body: JSON.stringify(cart) }));
```

- **Token and dashboard.** A token (`gc_` plus 22 letters and digits, public) groups your app's diagnostics under a
  private dashboard link (`https://genclass.dev/dashboard/...`; whoever holds the link sees the stats). Get one at
  [genclass.dev/start](https://genclass.dev/start), or let `init` create it after you approve its diff. The
  dashboard fills from deployed pages with telemetry on. Local and private hosts (`localhost`, `*.local`, `*.test`,
  private networks) do not send by default; `telemetry: true` or any telemetry options object (`telemetry: { ... }`)
  is an explicit opt-in that sends from them too, with the token. Data is kept for 90 days.
- **`protect(name, fn)`** returns a function with the same signature (same `this`, arguments, return value and
  errors); decisions about what it causes carry `fn: name`. Without a runtime it just calls `fn`.
  [Package README](packages/runtime/README.md#function-specific-protect).
- **More sensitive observe mode.** Observe also reports *possible* detections (below the report gate, at the
  `eager` profile's value; one `console.debug` line each, ending in `(possible)`; `detect: "likely"` turns them off),
  and decides what happens while the model loads or the tab is hidden once it can, instead of skipping it. Their
  telemetry `detect` events carry `tier: "possible"`; nothing new about the page is sent.
  [Package README](packages/runtime/README.md#modes).

## How it works

1. **Observe.** Fetch, XHR, WebSocket, EventSource, DOM events, errors, navigation, storage, long tasks and timers
   are instrumented. Async work is linked into causal chains. Stores created through GenClass, or wrapped with its
   Redux, Zustand, React or generic adapters, get per-field versions and write histories.
2. **Learn.** The runtime learns per-operation baselines (latency, failure rate, request rate) and which fields each
   operation usually writes. It also learns cadences (polling, debounced saves) and relations that keep holding
   (`total == sum(items[*].price × qty)`, `selectedId ∈ items[*].id`).
3. **Triage.** Cheap facts are computed for every write and request. Only salient situations reach the model: a
   response landing over newer data, a repeated request, a failure streak, a broken relation, an error.
4. **Decide at the network boundary.** Responses and push messages are judged *before the app sees them*:
   - `deliver` (passive);
   - `discard` (deliver, but drop the writes it makes over newer data);
   - `defer` (wait for related in-flight work).

   Store writes are never held or reordered by default. Salient writes that no delivery decision covered are
   decided in the background, and can be reverted within 2 s under strict rules.
5. **Act by mode.**

   | mode | behaviour |
   |---|---|
   | `observe` (default) | reports only; never holds, delays or changes anything |
   | `guard` (opt-in) | `discard`, `defer`, `coalesce`, `delay`, only when the model's gate for that trigger says acting beats doing nothing by the margin of the chosen `aggressiveness` profile |
   | `heal` (experimental) | also `retry`, `serve_cached`, `block`, `hedge`, `rollback`, `resync` and custom actions, at the heal margin of the profile |

   Detections are reported when the top diagnosis is not `expected` with probability at or above the profile's
   report threshold (0.95 / 0.90 / 0.70 for cautious / balanced / eager). `rt.gates()` shows what is in force.

6. **Explain.**
   - Every detection and intervention is logged in plain English, with the exact situation text the model read.
   - Reversible actions can be undone.
   - `?genclass=off` installs nothing.

## Measured behaviour

> **`@genclass/runtime@0.3.0-beta.0` with the model `@genclass/runtime-model@0.2.0`.** The model and the situation
> text it reads (`situation-v2.3`) are the same as in 0.2.x; the numbers below were measured with them.
>
> - **Runtime:** works and is unit-tested (situation format tag `situation-v2.3`). Install with
>   `npx @genclass/runtime init`, one import (`@genclass/runtime/auto`) or one script tag.
> - **Default mode** is `observe`: the model diagnoses salient situations and the runtime reports likely problems,
>   without changing what the app does (it never holds or delays a response). `guard` is opt-in; `heal` is
>   experimental.
> - **How eager it acts** once you opt in: `aggressiveness: "cautious" | "balanced" (default) | "eager"`.
> - **Model:** `genclass-runtime-r17` 2.0.0-rc4t (`r17-v2dT`, gain gate, 10 MB (10.2 MB q8), about 180 ms per
>   decision on one WASM thread; WASM or WebGPU), loaded from jsDelivr at idle and cached. On held-out data
>   ([RESULTS.md](docs/runtime/RESULTS.md) §1):
>
>   | profile | guard FIR | guard recall (clear / real) | heal FIR | heal recall (clear / real) | report threshold |
>   |---|---|---|---|---|---|
>   | `cautious` | 0.005% | 2.4% / 1.4% | 0.26% | 3.7% / 3.8% | 0.95 |
>   | `balanced` (default) | 0.13% | 7.8% / 7.5% | 0.59% | 7.1% / 10.4% | 0.90 |
>   | `eager` | 0.54% | 14.2% / 21.0% | 1.84% | 17.1% / 24.2% | 0.70 |
>
>   Our targets are guard FIR ≤ 0.1% and heal FIR ≤ 0.5%. `cautious` stays under both; `balanced` is slightly over
>   both (0.13% and 0.59% on simulated apps); `eager` is well over. FIR on held-out real apps was 0.00% for every
>   profile. Recall is still low: at `balanced`, guard acts on under 8% of the cases where acting would help.
>   Installed from the registry into a fresh app, guard mode fixed an out-of-order typeahead in 6 of 6 trials, and
>   clean typing made 0 model calls. See the [model card](packages/runtime-model/MODEL_CARD.md).
> - **Options** (activation, route scopes, protected endpoints, breaker, shadow, veto, action limits, sinks):
>   [OPTIONS-SPEC.md](docs/runtime/OPTIONS-SPEC.md).
> - **Privacy notice:** anonymous diagnostics are on by default, without page text, and off on localhost (since
>   `0.2.2`; `0.2.1` sends from localhost too, by mistake); opt out
>   with `GenClass.init({ telemetry: false })` or `?genclass=no-telemetry`. See
>   [Privacy and telemetry](#privacy-and-telemetry).

## Privacy and telemetry

- **Decisions are local.** Situations are built and decided in the browser by the local model; nothing is sent anywhere to make a decision.
- **Anonymous diagnostics are on by default** with `GenClass.init()` in a browser, except on local and private hosts (`localhost`, `*.localhost`, `*.local`, `*.test`, `127.0.0.1`, `::1`, private IP ranges) (`0.2.1` sends from local hosts too, by mistake; fixed in `0.2.2`, see the CHANGELOG), in Node/SSR, and in `createRuntime()`. They go to the GenClass maintainers' collector ([`telemetry-worker/`](telemetry-worker), a Cloudflare Worker writing to a private R2 bucket) and are used to improve the model.
- **By default no text from your page is sent.** Sent: a random per-page session id, versions, mode, device class, the app's hostname and id-normalised path, and per decision (every detection and every decision whose diagnosis is not `expected`, every action and veto; of the routine ones, one in four and at most 200 per page load; counts are exact; `0.2.2` and earlier send every decision) the trigger, the diagnosis and its confidence, the action and gate, the outcome and latency. The collector stores no IP address or user agent. One console notice per page says it is on.
- **The situation text the model read is sent only if you opt in** with `GenClass.init({ telemetry: { include: { situation: true } } })`. It is redacted by field meaning, but can still contain route names with query strings, short error messages and short field values; read [TELEMETRY.md](packages/runtime/TELEMETRY.md) before enabling it.
- **Opt out:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry`, `localStorage.setItem("genclass.telemetry", "off")`; browsers sending Global Privacy Control are never collected.
- **With a token** (`0.3.0`: `token` option, `data-token`, `token=` in the meta tag), each batch also carries
  your app's public token, so the same diagnostics also show on your app's private dashboard (whoever holds its link
  can open it), and decisions about `protect()`ed functions carry the function's name (`fn`, the label you chose).
  Without a token neither is sent; without telemetry, a token does nothing.
- Apps that ship GenClass may need to disclose this to their users (GDPR/CCPA). Full schema, storage and guidance: [TELEMETRY.md](packages/runtime/TELEMETRY.md).

## Security

- [SECURITY.md](SECURITY.md): how to report a vulnerability, supported versions.
- [packages/runtime/INTERCEPTION.md](packages/runtime/INTERCEPTION.md): every browser API GenClass wraps or listens
  to, what each mode may change, what it never does, every action's preconditions and undo, and how `disable()` and
  `?genclass=off` restore the page (checked against the code by a unit test).
- [docs/runtime/THREAT-MODEL.md](docs/runtime/THREAT-MODEL.md): page scripts, the model supply chain, crafted
  responses, denial of service, telemetry and state discovery, with mitigations and residual risks.
- `rt.audit()` exports a structured record of every decision and action; payment, checkout and sign-in endpoints
  should stay observe-only (`requests: { protect: protectPreset("payments", "auth") }`).

Full guide (modes, triggers, adapters, observability, performance, privacy, known limitations):
**[packages/runtime/README.md](packages/runtime/README.md)**. API: [docs/runtime/API.md](docs/runtime/API.md).

## Results so far

All numbers are on held-out data, with each recall reported next to its false-intervention rate (FIR). Source:
[docs/runtime/RESULTS.md](docs/runtime/RESULTS.md).

| what | result |
|---|---|
| Round 1 model, R17 (9.6 MB int8; **previous format** `situation-v1`), simulated apps | diagnosis 90.5%, action 81.9%, guard FIR 0.05%, heal FIR 0.24%, calibration error 0.009. Recall on clear stale/duplicate cases is only 7.7% (precise but timid). |
| Why round 1 was timid ([sim/SEPARABILITY.md](sim/SEPARABILITY.md)) | Many clear cases had benign twins with identical visible facts; 24% of clear rows were mislabelled `expected`; labels assumed knowledge a runtime cannot have. v2 adds measured facts and fixes the labels. |
| **r17-v2dT** (`situation-v2`; shipped as `@genclass/runtime-model@0.2.0`) | Gain gate with three profiles (table above). `balanced`: guard FIR 0.13%, heal FIR 0.59% on simulated apps (slightly over the 0.1% / 0.5% targets); `cautious`: 0.005% / 0.26% (under). 0.00% on held-out real apps for every profile. Calibration error not yet measured for this model (r17-v2b: 0.021–0.023). |
| r17-v2b (shipped as `@genclass/runtime-model@0.1.0`) | Simulated apps: diagnosis 84.2%, action 77.8%. Real apps: diagnosis 83.6%, action 80.0%. Guard FIR 0.01%, heal FIR 0.07%; heal acts on 5.9% of clear simulated cases and 5.7% of actionable real-app cases; guard on 0.6%. |
| Training continues | teacher model, distillation, DAgger rounds; ~10M simulated gold rows, ~50M unlabeled rows, ~0.6M real-app rows |
| Never make a correct app worse (always-passive model, heal vs observe, 66 real apps × 6 seeds) | 0/396 clean runs changed: final page text (inputs and alerts excluded) and server state. Request timing and store contents are not compared, nor is observe mode against no runtime. With chaos: 3/198 changed. |
| Same check on the v1 runtime (store-write holds) | 4/198 clean runs changed; the React/Redux RealWorld app never rendered its home feed |
| Demos (model 0.2.0, `balanced`, 10 chaos + 5 clean seeds per demo and mode) | The chaos bug rate over the six demos was 72% off, 70% observe, 72% guard and 73% heal (differences under 5 points are noise): nothing is healed at the shipped gates, because candidate gains rarely clear the margins; 0 false interventions on clean runs. |

## What's in this repo

| path | what |
|---|---|
| [`packages/runtime`](packages/runtime) | `@genclass/runtime`, the library. Observers, causality, stores and adapters, learned baselines/relations/profiles, facts, triage, policy gate, actions, model host (Web Worker, ONNX Runtime Web on WebGPU/WASM), devtools overlay. [README](packages/runtime/README.md) · [CHANGELOG](packages/runtime/CHANGELOG.md) |
| [`packages/playwright`](packages/playwright) | `@genclass/playwright` (unreleased), a Playwright reporter: reads what the GenClass fixture flagged per test (`test-results/genclass/*.json`) and writes one markdown report for the pull request, with the evidence line and what reproduced across seeds. [README](packages/playwright/README.md) |
| [`packages/runtime-model`](packages/runtime-model) | `@genclass/runtime-model`, the default model package (data only; `files/` is gitignored and filled at release time) and its [model card](packages/runtime-model/MODEL_CARD.md) |
| [`sim`](sim) | Training-data simulator: random apps run on the real runtime in a deterministic virtual world, labelled by counterfactual outcomes |
| [`realapps`](realapps) | 128 real apps (written for the corpus, plus open-source ones) run with the real runtime in headless Chromium, labelled the same way; the never-worse sweep covered the first 66. [README](realapps/README.md) |
| [`training`](training) | Vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime's renderer), multi-node CPU training on Azure, int8 ONNX export, evaluation ([EVAL.md](training/EVAL.md)) |
| [`demos`](demos) | Six demo apps (typeahead, autosave, checkout, flaky dashboard, live kanban, real-time decisions) with a Service Worker chaos backend and Playwright trials; [`bench/heal`](bench/heal) runs them per mode |
| [`compat`](compat), [`templates`](templates) | Framework compatibility matrix (7 apps, 15 data layers, every mode; [RESULTS.md](compat/RESULTS.md)) and starter templates with the one line |
| [`docs/runtime`](docs/runtime) | [Results](docs/runtime/RESULTS.md) · [Architecture](docs/runtime/ARCHITECTURE.md) · [Build contract](docs/runtime/CONTRACT.md) · [API](docs/runtime/API.md) · [Threat model](docs/runtime/THREAT-MODEL.md) |
| [`telemetry-worker`](telemetry-worker), [`site`](site) | The diagnostics collector (Cloudflare Worker) and the genclass.dev site |
| [`research`](research) | Earlier GenClass/Jev research (voice-control Chrome extension, the `jev_local` encoder and server, classifier benchmarks); the training scripts still use `jev_local` ([README](research/README.md)) |
| [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to work in this repository |

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

The same steps run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml), Node 22) on pushes to `main`,
`runtime`, `mvp` and `mvp-v2`, on pull requests, and on manual dispatch. 667 unit tests pass in CI (14 skipped: the
model-parity tests, which need `GENCLASS_MODEL_DIR`), plus the 4 perf tests, which time a 5,000-item store and run
in their own step because they can fail under parallel load.

Releases are published by [.github/workflows/release.yml](.github/workflows/release.yml) from a `v*` tag, with npm
provenance.

Not covered by CI:

- Playwright browser tests: `npm run test:browser` in `packages/runtime`.
- `@genclass/playwright`: its typecheck, build and unit tests run in their own workflow,
  [.github/workflows/playwright-reporter.yml](.github/workflows/playwright-reporter.yml), on pushes and pull
  requests that touch the package; it never blocks `ci.yml`.
- The npm tarball smoke test: `test/smoke/smoke.sh`.
- The sim, the real-app corpus, the demos' evaluation, and training.

These are heavier or need Azure; see [AGENTS.md](AGENTS.md) before running them.

**The training format is tagged.** The current tag is `situation-v2.3`; the shipped model was trained on data from
`situation-v2`. Any change to `packages/runtime/src/situation/*` (or other text the model reads) changes the model's
input and means a new tag and regenerated data (`training/curriculum/rt.py` mirrors the renderer and must change
with it).

## License

Apache-2.0. See [NOTICE](NOTICE).
