# Contributing to GenClass

How to change GenClass-lib, the repository of `@genclass/runtime` (GenClass Runtime, an open-source browser library
that reports race conditions in web apps), its model package, and everything used to train and evaluate the model:
where things are, what CI runs, the rules that keep the measurements honest, and how a release is made. To use
GenClass in an app, read the [package README](packages/runtime/README.md) instead.

Thanks for looking. Issues and pull requests are welcome.

## Where things are

- `packages/runtime/` is the library: `src/` (observers, causality, stores, facts, triage, the policy gate, actions,
  the model host, devtools, the measured visual checks in `src/visual/`, interaction analytics in `src/analytics/`),
  `test/` (vitest; `test/browser/` holds the Playwright suites), `bin/` (the CLI: `init`, `remove`, `login`,
  `connect`, `whoami`, `logout`, `fetch-model`, `info`). Read `docs/runtime/CONTRACT.md` (binding design rules),
  `docs/runtime/API.md` and `packages/runtime/INTERCEPTION.md` before changing behaviour.
- `packages/runtime-model/` is the data-only model package and its model card.
- `packages/playwright/` is `@genclass/playwright` (0.1.0, not on npm yet), a Playwright reporter that turns the race
  files the GenClass Playwright fixture writes into one markdown report for a pull request (the fixture is built
  separately and has not shipped). `packages/genclass-runtime/` is `genclass-runtime`, the former short name for the
  CLI: deprecated in this repository and not published by the release workflow, but not yet marked with
  `npm deprecate` on the registry, so `npx genclass-runtime init` still installs its newest npm version, 0.1.0-beta.3,
  with an unsupported runtime and no deprecation warning from npm. Marking it is a maintainer step:
  `npm deprecate genclass-runtime "Use @genclass/runtime: npx @genclass/runtime init"`. Use
  `npx @genclass/runtime@beta init` (or `npx @genclass/runtime init` for 0.2.x).
- `sim/`, `realapps/`, `training/` produce and train on the model's data; `demos/`, `compat/`, `bench/heal/`
  evaluate the result; `bench/visual/` measures the visual checks' false reports, recall and cost (GitHub Actions
  only). `docs/runtime/RESULTS.md` is where every measured number lives.
- `telemetry-worker/` is the diagnostics collector with the dashboards and accounts on genclass.dev (a Cloudflare
  Worker). `billing/plans.json` is the one place the plans are defined. The website itself is built in a separate,
  private repository (see [Releasing](#releasing-maintainers)).
- `templates/` (starter apps with the runtime installed), `research/` (earlier research; the training scripts
  import its `jev_local` encoder), `scripts/` (Azure VM helpers for training, and the Stripe setup script).
- `AGENTS.md` is the short guide for coding agents; it applies to people too.

## Build and test

Node ≥ 20. CI (`.github/workflows/ci.yml`, Node 22) runs three jobs on every pull request:

- **`runtime`**: typecheck, build and the unit tests of `@genclass/runtime`, exactly as below.
- **`visual-browser`**: the first-load size of `/auto` and the main entry against the merge base with `main` (fails
  at 0.6 KB gzip growth), and the measured visual checks in Chromium with Playwright
  (`test/browser/visual/playwright.config.ts`). Chromium is installed in CI only.
- **`telemetry-worker`**: the collector's unit tests (`cd telemetry-worker && npx vitest run`).

The `runtime` job:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run typecheck -w @genclass/runtime
npm run build -w @genclass/runtime
cd packages/runtime
NODE_OPTIONS=--expose-gc npx vitest run --exclude "test/browser/**" --exclude test/review-perf.test.ts
NODE_OPTIONS=--expose-gc npx vitest run test/review-perf.test.ts --retry=2   # timing budgets; reported, not blocking
```

One test: `npx vitest run test/delivery.test.ts -t "<name>"`. `@genclass/playwright` has its own workflow,
`playwright-reporter.yml` (typecheck, build, vitest; it runs when `packages/playwright/` or the lockfile changes and
never blocks `ci.yml`). The visual bench (`visual-measure.yml`) runs on manual dispatch, and on pushes that change
the bench on the `wave2/visual` branch; it loads public sites, so it never runs on pull requests. `release.yml`
publishes from a tag (see [Releasing](#releasing-maintainers)).

Not run in CI: the model Playwright suite (`npm run test:browser`), the tarball smoke test (`test/smoke/smoke.sh`),
the install suite (`test/install/run-all.sh`), the sim and real-app generators, the demos' evaluation and training.
Say in the PR which of them you could not run.

## The rules

1. **Never make a correct app worse.** Observe mode never holds, delays or changes anything. In guard and heal,
   an action runs only when the model's gate clears, and every action is logged and, where possible, undoable.
   False interventions on clean runs are a first-class metric: report FIR next to every recall number. A change
   that adds a hold, a delay or an action on clean traffic needs a measurement, not an argument.
2. **No hardcoded bug patterns.** The runtime computes generic facts and decides what is salient; it never maps a
   fact pattern to a diagnosis or an action with an if/then. Actions are chosen only by the policy gate from the
   model's answers. The one exception is the measured visual checks in `src/visual/`: deterministic measurements
   with documented thresholds, reported as kind `"check"` and never as a model finding. They never decide network
   actions and never feed situations, facts, the event log, the gate or the model; their fixes are opt-in,
   reversible and never run in `observe` (`docs/runtime/VISUAL.md`). One indirect path remains: a check step that
   makes the browser lay out a very heavy page can take 50 ms or more, and the `perf` observer records that long task
   as a `perf` event the model can read (VISUAL.md section 1).
3. **Model-visible text is frozen.** Anything the model reads (`packages/runtime/src/situation/*`, facts, question,
   action and diagnosis wording, redaction output, op and event names) is tagged (`situation-v2.3`). Changing it
   means a new tag, regenerated data, an updated `training/curriculum/rt.py` mirror and retraining. Open an issue
   first.
4. **`sim/` and `demos/` authors never read each other's code.** The simulator and the real-app corpus generate
   training data; the demos and the compatibility apps are the evaluation. Neither side may be tuned to the other:
   `sim/` and `realapps/` never read or model `demos/` or `compat/`, and the demos and compat apps contain nothing
   beyond a normal integration. If you work on one side in a PR, do not touch the other.
5. **Determinism.** Runtime code uses the injected `Clock`, never `Math.random`, `Date.now`, `performance.now` or
   the global `setTimeout`. Same inputs give byte-identical situations.
6. **`packages/runtime/test/review-*.test.ts` are a contract.** Fix `src/`, never the test.
7. **Dependencies.** `onnxruntime-web` is the only runtime dependency; ask before adding another. Keep the committed
   root `package-lock.json` in sync.
8. **Telemetry stays disclosed** (the console notice, `packages/runtime/TELEMETRY.md`, both READMEs, the CHANGELOG),
   sends no page text unless the app opts in, keeps every opt-out (`telemetry: false`, `?genclass=no-telemetry`,
   the `localStorage` switch, Global Privacy Control) and never feeds a decision. Widening what is sent needs the
   owner's OK.
9. **Releases** are published only by `.github/workflows/release.yml` from a `v*` tag, with npm provenance. Do not
   publish from a laptop.

## Pull requests

- One change per PR, with tests in the house style (`test/helpers.ts` → `setup()`; drive time with
  `clock.advance`; name the CONTRACT section in the `describe`).
- Update `docs/runtime/API.md` and the JSDoc in `src/types.ts` for public-surface changes, and add a line to
  `packages/runtime/CHANGELOG.md`.
- New numbers go to `docs/runtime/RESULTS.md`, with the FIR next to the recall and what was and was not compared.
- The PR template lists the checks. CI must be green.

## Releasing (maintainers)

`.github/workflows/release.yml` publishes `@genclass/runtime` to npm from a tag `v<version>` whose version equals
`packages/runtime/package.json`; its header comment is the authority on the order. In this order:

1. On the release branch (`release/<version>`): `packages/runtime/package.json` and `packages/runtime/src/version.ts`
   (`RUNTIME_VERSION`) have the version (`release.yml` checks both), the CHANGELOG section is final and dated, CI is
   green, and the first-load limits in `test/bundle.test.ts` match the README and `docs/runtime/RESULTS.md`. Every place
   a reader sees the version says the same: the version notes at the top of `docs/runtime/API.md`,
   `docs/runtime/OPTIONS-SPEC.md`, `packages/runtime/TELEMETRY.md` and `packages/runtime/INTERCEPTION.md` (and any other
   page that opens with one), the CDN pins and the `@beta` commands in both READMEs, and the Versions lines in both
   READMEs (`README.md` and `packages/runtime/README.md`).
2. The previous release is on npm as `latest` (`npm view @genclass/runtime dist-tags`) and
   `https://cdn.jsdelivr.net/npm/@genclass/runtime@<that version>` answers 200.
3. Merge the release branch into `main` by pull request, with CI green: the READMEs link `TELEMETRY.md`,
   `PRIVACY.md` and `RESULTS.md` at `blob/main`. When the READMEs pin the new version, their CDN snippet on GitHub
   answers 404 until the publish finishes, so tag as soon as step 4 is done.
4. Deploy `telemetry-worker/` from that commit (`d1 migrations apply genclass-dashboard --remote`, then
   `wrangler deploy`; `telemetry-worker/README.md`), together with the site's admin aggregates (in
   genclass-dev/genclass-site: `site/src/admin.js` and `site/migrations-admin/`; ask its maintainer), before the
   tag: a worker older than 0.3.0 counts possible detections as detections.
5. Tag `v<version>` on that `main` commit and push the tag; approve the `npm-publish` environment run of
   `release.yml`.
6. Check the release: the dist-tags (a prerelease lands on the tag named after it and `latest` stays), the "Verify
   the registry signature and provenance" step, `npm view @genclass/runtime@<version> version`, and that jsDelivr
   serves `@<version>`, `/dist/cdn/worker.js` and `/dist/sinks/webhook.js` (HTTP 200). Then set `RUNTIME_ON_NPM` to
   the version in `telemetry-worker/wrangler.toml` and in `telemetry-worker/wrangler.selfhost.toml` (the config
   self-hosters deploy; its Connect panel names the runtime that sends tokens), and deploy the worker again.
7. Site: genclass.dev is built in the private repository genclass-dev/genclass-site, which has this repository as
   its `lib/` submodule. After the merge, ask its maintainer to move that submodule, and the runtime version the
   site's pages name, to this release, so `/docs/telemetry` and `/privacy` match the released `TELEMETRY.md` and
   `PRIVACY.md`. Deploying the site is a separate, owner-approved step.

## Reporting a false flag

GenClass flagged or acted on code that was right? That is a bug we want: use the "False flag or false
intervention" issue template and include the console group and `rt.explain(id)`.

## Security

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
