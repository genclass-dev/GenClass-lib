# @genclass/playwright

### Explain your flaky e2e test: which response landed late, which click submitted twice.

A Playwright fixture and reporter for [GenClass Runtime](https://github.com/genclass-dev/GenClass-lib). The
fixture puts the runtime on the page under test (or finds the one your app installed), optionally makes the
network slow, reordered and flaky through `page.route`, and at the end of each test collects what the runtime
flagged. The reporter turns that into one markdown file with the exact evidence line per finding, which a
10-line GitHub Actions step posts on the pull request.

The runtime runs its model locally in headless Chromium (WASM, about 10 MB downloaded once per run from jsDelivr),
in observe mode: it reports and never holds, delays or changes anything in your app.

## Install

```bash
npm install -D @genclass/playwright
```

`@playwright/test` ≥ 1.40 is a peer dependency; `@genclass/runtime` comes with the package.

## Use

```ts
// tests/fixtures.ts
import { test as base } from "@playwright/test";
import { genclass, type GenClassFixtures } from "@genclass/playwright";

export const test = base.extend<GenClassFixtures>(
  genclass({ mode: "observe", chaos: { latencyMs: [50, 800], reorder: true, failRate: 0.05, routes: [/\/api\//] } }),
);
export { expect } from "@playwright/test";
```

```ts
// playwright.config.ts
reporter: [["list"], ["@genclass/playwright/reporter", { outputFile: "genclass-report.md" }]],
```

Then write tests as usual with that `test`. The fixture is automatic: every test of the file gets GenClass, even one
that never mentions it. Inside a test, `genclass.ready()` waits for the model, `genclass.settle()` waits for
decisions still in flight, and `genclass.snapshot()` returns the runtime's audit trail, decisions and interventions.

### Options

| option | default | what |
|---|---|---|
| `mode` | `"observe"` | Mode of the injected runtime. `guard` and `heal` act; they are for testing those modes, not for finding bugs. |
| `install` | `"inject"` | `"inject"`: an init script loads the script-tag build of `@genclass/runtime` before the page's own scripts. `"app"`: your app installs GenClass itself; nothing is injected and the runtime is read from `handle`. |
| `runtime` | `"local"` | Where the injected build comes from: `"local"` serves the installed package's `dist/` through Playwright routing under its jsDelivr URLs (no network for the runtime itself), `"cdn"` loads it from jsDelivr pinned to the installed version, a path serves another checkout. The model and ONNX Runtime come from jsDelivr unless `config.model` says otherwise. |
| `handle` | `["GenClass.runtime", "__genclass"]` | Dotted `window` paths tried in order to find the runtime. For an ESM install: `window.__genclass = GenClass.init(...)` in your app, or name your own path. |
| `chaos` | off | `true` = `{ latencyMs: [50, 800], reorder: true, failRate: 0.05 }`, or an object: `latencyMs` (number or `[min, max]`), `reorder` (a newer request of the same method and path always lands before an older one still in flight), `failRate` (answered with `failStatus`, default 503), `routes` (RegExps or `*` globs against the URL, default `[/\/api\//]`), `seed` (default: the test title). |
| `config` | `{}` | Extra `InitOptions` for the injected runtime (`model`, `requests`, `policy`, ...). `mode` and `telemetry` are the fixture's. |
| `settle` | `{ quietMs: 1500, maxMs: 6000 }` | How long the fixture waits at the end of a test for decisions still in flight. |

Bad options never fail a test: they are corrected and printed as warnings in the report.

### Which requests chaos sees

Chaos uses `page.route`, so it applies to what Playwright can intercept: real servers (your dev server, a
`webServer`), and mocks you register with `context.route` (page routes run first, so the chaos handler delays or
fails the request and then falls through to your mock). It does not see requests a Service Worker answers (MSW in
worker mode, the demos in this repository): use the app's own knobs there, as `e2e/demos.spec.ts` does.

### Apps that install GenClass themselves

Use `install: "app"`. The injected build would otherwise start a second runtime next to yours (the report warns when
it sees two "Model ready" lines in one test). Expose the runtime for the fixture: `window.__genclass = GenClass.init(...)`,
or `handle: "myApp.genclass"`.

## The report

One file, `genclass-report.md` (and `.json`), written where your Playwright config lives and printed at the end of
the run:

- a headline with the findings (duplicate submits, stale responses, conflicting writes, inconsistent state) and the
  interventions line;
- the runtime version, the model, its device and the report threshold every number was produced with;
- per test: one line per finding (the diagnosis, its confidence, the request, how often) with the exact evidence line
  the runtime printed; failing endpoints; interventions, if any; an `Info` section for `failing`, `transient`,
  `overload`, `slow` and `unusual`, which usually describe an injected failure or a polling page; the chaos counters;
- tests where GenClass was not on the page, with why.

A diagnosis flagged on more than 8 distinct requests in one run is listed once as a recurring pattern of the app, not
as 8 findings (`maxSubjectsPerDiagnosis` in the reporter options). "0 interventions" is stated as a fact of observe
mode; with interventions, the report says it cannot tell a correct one from a wrong one, your assertions can.

### What it looks like

<!-- REPORT -->
From the `Playwright reporter` workflow of this repository (`.github/workflows/playwright-reporter.yml`): three demo
apps under their own chaos plus one injected page. The run that produced this is linked in the pull request that
added the package.

(to be pasted from the CI artifact)
<!-- /REPORT -->

### Post it on the pull request

With `pull-requests: write` and the repository's own `GITHUB_TOKEN` (no new secret):

```yaml
- run: npx playwright test
  continue-on-error: true
- uses: marocchino/sticky-pull-request-comment@v2
  if: github.event_name == 'pull_request'
  with:
    header: genclass-report
    path: genclass-report.md
```

or with the GitHub CLI:

```yaml
- if: github.event_name == 'pull_request'
  env:
    GH_TOKEN: ${{ github.token }}
  run: gh pr comment ${{ github.event.pull_request.number }} --body-file genclass-report.md
```

## What it can and cannot find

The runtime reports what its local model flags; the fixture adds nothing of its own, no list of known bugs. What
observe mode detects on the eight scenarios of the framework compatibility matrix, with the shipped model
(`genclass-runtime-r17` 2.0.0-rc4t, WASM, balanced profile, 10 seeds, headless Chromium): the double submit of a
create form (scenario b) was reported as `request:duplicate` on 10 of 10 seeds in every one of the 15 data layers
(React state, TanStack Query, Zustand, Redux, Apollo, Next.js, SWR, Pinia, Svelte stores, Angular fetch and XHR,
Solid, plain fetch); the stale typeahead (scenario a) was reported on 1 to 5 of 10 seeds on React state, Zustand
and Redux layers and on 0 of 10 on Vue, SvelteKit, Angular, Solid and plain HTML, because stale detection needs
state the runtime can discover (React, Redux, Zustand) and those are not covered yet. On correct apps, 49 of 880
runs produced a false finding (`request:overload` on a polling page ×45, `request:duplicate` ×4), which is why
`overload` sits in the collapsed Info section. Source: `compat/RESULTS.md` in the repository.

So: lead with the duplicate submits, read stale findings as "React/Redux/Zustand state only" for now, and open an
issue with the evidence line when a finding is wrong.

## Privacy

Everything runs on the machine that runs Playwright. The runtime's anonymous diagnostics are off on `localhost`,
`*.localhost`, `127.0.0.1` and other local or private hosts by design (`packages/runtime/TELEMETRY.md`), and the
fixture sets `telemetry: false` on the runtime it injects. The attachment and the report contain request names and
store field names as the runtime prints them (query values are replaced with "…"); they stay in your test results.

## Development

```bash
npm run typecheck -w @genclass/playwright
npm run build -w @genclass/playwright
cd packages/playwright && npx vitest run                   # the summariser, the chaos scheduler, the option parser, the reporter
npx playwright test --config e2e/playwright.config.ts      # the demos run (needs the demos built and Chromium; CI does it)
```

Apache-2.0.
