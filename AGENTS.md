# AGENTS.md

Guide for coding agents working in GenClass-lib. The code is the source of truth; `docs/runtime/CONTRACT.md` is binding.

## What this repo is

`@genclass/runtime` (`packages/runtime/`) is a browser library that observes a web app (fetch/XHR/WebSocket/
EventSource, user actions, timers, stores, errors, causality), computes generic facts, and for salient situations
asks a small local ONNX model (`packages/runtime-model/`, a Web Worker on WebGPU or WASM) for a diagnosis and an
action. Decisions happen at the network boundary (the `delivery` trigger); store writes are never held by default.
Default mode is `observe` (report only); `guard` is opt-in; `heal` is experimental. Without a model it only observes.

## Repo map

| path | what |
|---|---|
| `packages/runtime/` | the library: `src/` (incl. `auto.ts`, `cdn/`, `situation/`, `decide/`, `model/`, `devtools/`, `visual/` (measured visual checks: `start.ts` is the first-load stub, the rest is the lazy chunk), `analytics/` (interaction analytics, opt-in: `start.ts` stub, `index.ts` lazy chunk; `docs/runtime/ANALYTICS.md`), `agent/` (`@genclass/runtime/agent`, the coding-agent link: recording, delivery schedules, the bridge link; its own entry, never in the first load; `docs/runtime/AGENT.md`)), `test/` (vitest; `test/install/`, `test/browser/`, `test/browser/visual/` (Playwright, the CI `visual-browser` job)), `bin/` (CLI: `init`, `remove`, `login`, `connect`, `whoami`, `logout`, `fetch-model`, `info`), `CHANGELOG.md`, `TELEMETRY.md`, `INTERCEPTION.md` |
| `packages/runtime-model/` | the data-only model package (`files/` is gitignored, filled at release) and `MODEL_CARD.md` |
| `sim/` | deterministic training-data simulator driving the real runtime (`SEPARABILITY.md`, `README.md`) |
| `realapps/` | 128 real apps run in headless Chromium with the real runtime: training rows and the never-worse sweep |
| `training/` | vocabulary pruning, curriculum (`curriculum/rt.py` mirrors the runtime's situation renderer), Azure training, ONNX export, `EVAL.md` |
| `demos/` | six demo apps with a chaos backend and Playwright trials; `bench/heal/` runs them per mode |
| `packages/mcp/` | `@genclass/mcp`: the MCP server for coding agents (bridge on 127.0.0.1:47357, store, explore verdicts, replays, regression-test generation, 8 tools); no runtime deps; `test/e2e/race.e2e.mjs` is the real-browser check (not in CI's main job). `plugin/` is the Claude Code plugin (also an Agent Plugins package); `server.json`, the plugin, `.claude-plugin/`, `.cursor-plugin/`, `gemini-extension.json`, `llms-install.md` and the READMEs pin its version (`npm run sync -w @genclass/mcp` after a version bump; `test/manifests.test.ts` fails otherwise) |
| `packages/sv/` | `@genclass/sv`: the Svelte CLI community add-on (`npx sv add @genclass`): adds the runtime, the `/auto` import first in `src/hooks.client`, the dev-only overlay and (default) the telemetry opt-out meta in `src/app.html`, all with the `genclass:init` marker so `remove` undoes it; bundles `@sveltejs/sv-utils`, `sv` is a peer; `test/e2e/` runs sv's add-on harness (pnpm, Chromium) |
| `packages/playwright/` | `@genclass/playwright`: the fixture (`src/fixture.ts`, `install.ts`, `page.ts`, `chaos.ts`, `races.ts`: puts the runtime's script-tag build on every `page` in observe mode with telemetry off, seeded chaos that holds matched fetch/XHR requests with `page.route` and `route.fallback()`, witnesses through the agent entry with every hold off, one `genclass-races/1` file per test in `test-results/genclass/`) and the reporter + pure summariser that read those files and write `genclass-report.md` for the PR; peer deps only (`@playwright/test`, `@genclass/runtime`); `test/e2e/run.mjs` is the real-browser check (its own workflow) |
| `packages/nuxt/`, `packages/astro/` | `@genclass/nuxt` (a Nuxt module, `@nuxt/kit`, built with `@nuxt/module-builder`) and `@genclass/astro` (an Astro integration, `injectScript("page", ...)`): from options `{ mode, token?, telemetry?, devtools? }` they generate the runtime's own one line (`/auto` or `/auto/guard`) plus a `window.GENCLASS_CONFIG` module imported before it; browser only, nothing on the server; `@genclass/runtime` is a peer dependency. The generated code is pure (`src/source.ts`, `src/index.ts`) and the tests check it exactly, then build one fixture app. Workflow: `integrations.yml` (Node 24) |
| `docs/adoption/listings/` | how the framework packages and templates get listed (nuxt.com/modules entry and steps, astro.build/integrations, sveltesociety.dev, awesome-vue and Angular lists): research and draft entries; nothing is submitted from the repo |
| `bench/visual/` | the visual checks' bench (GitHub Actions only, `.github/workflows/visual-measure.yml`): false reports on the demos, templates, compat apps and about 40 public sites, recall on faults planted from the harness, cost; public sites are counted per check kind only, never named in the repo, its run logs or plain artifacts (per-site results only encrypted with the `VISUAL_BENCH_KEY` secret) |
| `compat/`, `templates/` | framework compatibility matrix (`RESULTS.md`) and starter templates (react-vite, nextjs, vue-vite, sveltekit, astro, nuxt, react-router, angular; `compat/templates-check.mjs` builds and boots them in Chromium against the packed runtime, module and integration); evaluation only |
| `telemetry-worker/` | the diagnostics collector with the dashboards and accounts (Cloudflare Worker). genclass.dev itself (the site, its admin and the pitch deck) and the page check (`scan-worker/`) live in the private repo genclass-dev/genclass-site, which has this repo as its `lib/` submodule |
| `research/` | earlier Jev research: extension, `jev_local` (Python encoder the training scripts import), benchmarks |
| `docs/adoption/` | listing drafts for directories and registries (`listings/mcp.md`): steps, fields and entries, nothing submitted |
| `docs/runtime/` | `CONTRACT.md` (binding), `API.md`, `ARCHITECTURE.md`, `OPTIONS-SPEC.md`, `THREAT-MODEL.md`, `VISUAL.md` (measured visual checks: design), `ANALYTICS.md` (interaction analytics: design), **`RESULTS.md`** (every measured number) |
| `scripts/` | Azure VM helpers (`vm.sh`, `azvm.sh`, `launch_run.sh`); `internal/` is gitignored working notes |

## Build and test

Node ≥ 20. CI (`.github/workflows/ci.yml`, Node 22) runs, in order:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run typecheck -w @genclass/runtime        # tsc on src/ only; tests are never type-checked
npm run build -w @genclass/runtime            # tsup: ESM entries, the script-tag IIFE, the CDN worker
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets; reported, not blocking
```

`packages/mcp/` (`@genclass/mcp`) has its own workflow, `mcp.yml` (typecheck, build, vitest; then the e2e in Chromium):
`npm run typecheck -w @genclass/mcp && npm run build -w @genclass/mcp && (cd packages/mcp && npx vitest run)`; the e2e
needs both packages built: `node packages/mcp/test/e2e/race.e2e.mjs`.

`packages/playwright/` (`@genclass/playwright`, the fixture and the race-file reporter) has its own workflow,
`playwright-reporter.yml` (typecheck, build, vitest; then the fixture's e2e in Chromium; never blocks `ci.yml`):
`npm run typecheck -w @genclass/playwright && npm run build -w @genclass/playwright && (cd packages/playwright && npx vitest run)`;
the e2e needs the runtime built too: `node packages/playwright/test/e2e/run.mjs`.

`packages/sv/` (`@genclass/sv`, the Svelte CLI add-on) has its own workflow, `sv-addon.yml` (never blocks `ci.yml`):
`npm run typecheck -w @genclass/sv && npm run build -w @genclass/sv && (cd packages/sv && npx vitest run --project unit)`;
the e2e (`npx vitest run --project e2e`) needs the runtime built, pnpm, Chromium and the network (npm, jsDelivr).

`packages/nuxt/` and `packages/astro/` share `integrations.yml` (Node 24: Nuxt 4.6 and Astro 7 want Node 22.23 or
24.15 and later; typecheck, build, vitest; the tests build one fixture app each, so build the runtime first):
`npm run build -w @genclass/runtime && npm run typecheck -w @genclass/nuxt && npm run build -w @genclass/nuxt && (cd packages/nuxt && npx vitest run)`,
the same for `@genclass/astro`. The templates that use them are checked by `compat/templates-check.mjs`, not in CI.

One test: `npx vitest run test/delivery.test.ts -t "<name>"`. The 14 skipped tests are model-parity tests that need
`GENCLASS_MODEL_DIR`. CI also runs the `visual-browser` job: the first-load size against the release line (`FIRST_LOAD_BASE`, release/0.3.0 until 0.3.0 is on main; `test/first-load-size.mjs`, fails at 0.6 KB
growth on the visual branch, 0.5 KB before the review, pending the owner's OK) and `npx playwright test --config test/browser/visual/playwright.config.ts` in Chromium. The visual bench
(`visual-measure.yml`) is a separate workflow: manual dispatch (and pushes to `bench/visual/` on the visual branch);
it loads public sites, so it does not run on pull requests. Not in CI, ask before running: the model Playwright suite (`npm run test:browser`), `test/smoke/smoke.sh`, the
install suite (`test/install/run-all.sh`), the sim and realapps generators, the demos' eval, training, anything on
Azure, `git push`, `npm publish`.

## Hard rules

1. **Never make a correct app worse.** Observe never holds, delays or changes anything. An action runs only when the
   policy gate (`src/decide/policy.ts`) clears and the top diagnosis is not `expected`; model missing, late or
   erroring means the passive action. Report FIR (false interventions on clean runs) next to every recall number.
   Exception (owner request, 2026-10-19; CONTRACT.md §16): the coding-agent link (`src/agent/`,
   `docs/runtime/AGENT.md` section 9) is a test harness a developer imports in development builds, inert on pages not
   served from their machine. With a schedule they or their agent set, it holds response deliveries (each at most its
   delay plus `maxHoldMs`, never changed); without one it holds only a page load's first responses until the bridge's
   hello (at most `helloTimeoutMs`, 600 ms); `hold: false` turns every hold off; protected requests are never held (unless `holdProtected`).
   Report explore results with the false-report rate on the correct variant next to the races found.
2. **No hardcoded bug patterns.** The runtime computes facts and triages (`runtime.ts` → `trigger`); it never maps a
   fact pattern to a diagnosis or action with an if/then. `situation/build.ts` → `builtinApplicable` only says
   whether an action *can* run. Exception (owner, 2026-10-13): visual checks in `src/visual/` are measured checks,
   labelled as such (deterministic measurements with documented thresholds, reported as kind `"check"`, never as a
   model finding); they never decide network actions and never feed situations, facts, the event log, the gate or
   the model. Their runtime fixes follow rule 1: opt-in, reversible, never in `observe`. Design:
   `docs/runtime/VISUAL.md`. One indirect path stays: their page reads run in idle slices of 8 ms, but a read that
   makes the browser lay out a very heavy page can still take 50 ms or more, and the runtime's `perf` observer records
   any such long task as a `perf` event the model can read (VISUAL.md section 1).
3. **Model-visible text is frozen** (tag `situation-v2.3`). Any change to `src/situation/*`, facts, question, action
   or diagnosis wording, `util.ts` formatting/redaction, op or event names means a new tag, regenerated data, an
   `rt.py` mirror and retraining. Do not make such a change without an explicit go-ahead; exact-text tests exist.
4. **`sim/` and `demos/` authors never read each other's code.** `sim/` and `realapps/` never read or model `demos/`
   or `compat/`; demos and compat apps are never tuned to the model and contain nothing beyond a normal integration.
5. **Determinism.** Runtime code uses the injected `Clock` (`src/clock.ts`); never `Math.random`, `Date.now`,
   `performance.now` or the global `setTimeout`. IDs come from counters. Same inputs give byte-identical situations.
6. **`test/review-*.test.ts` are a contract.** Fix `src/`, never the test.
7. **Dependencies.** `onnxruntime-web` is the only runtime dependency; ask before adding one. Keep the committed root
   `package-lock.json` in sync. TypeScript strict, ESM only, `src/` uses no Node APIs (`types: []`).
8. **Telemetry** stays disclosed (console notice, `TELEMETRY.md`, both READMEs, CHANGELOG), sends no page text
   unless the app opts in, keeps every opt-out (`telemetry: false`, `?genclass=no-telemetry`, localStorage, GPC) and
   never feeds a decision. Widening what is sent needs the owner's OK.
9. **Publish only through the release workflows**: `.github/workflows/release.yml` on a `v*` tag whose version
   equals `packages/runtime/package.json`; `.github/workflows/release-mcp.yml` on a `mcp-v*` tag for
   `@genclass/mcp` (its first version is published once by the owner from the workflow's tarball, because npm sets up
   trusted publishing from an existing package). Never `npm publish` by hand otherwise. Never push without being asked.

## Conventions and definition of done

- Modules open with a `//` header stating role and invariants; JSDoc on exports; named exports; relative imports
  with `.js`; 2 spaces, double quotes. Never throw into the host app: hooks and callbacks run in `try/catch`.
- Tests: one `<area>.test.ts` per area; `test/helpers.ts` → `setup()` gives a fake clock, server and scripted decider
  (default `mode: "guard"`; pass `mode: undefined` for observe). Name the CONTRACT section in the `describe`.
- Done means: `tsc` clean, `tsup` builds, both vitest steps pass with new tests, no review test edited, no
  model-visible text changed; public-surface changes update `docs/runtime/API.md`, the JSDoc in `src/types.ts` and
  `packages/runtime/CHANGELOG.md`; new numbers go to `docs/runtime/RESULTS.md` with the FIR next to the recall; say
  which checks you could not run and why.
