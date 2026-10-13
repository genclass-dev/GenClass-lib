# @genclass/playwright

### Explain your flaky e2e test: which click submitted twice, which response landed late.

A Playwright reporter for [GenClass Runtime](https://github.com/genclass-dev/GenClass-lib). When your suite ends, it
reads what GenClass flagged in each test (duplicate submits, stale responses, failing endpoints, each with the
evidence line the runtime printed and the model's confidence), marks what reproduced across seeds, writes one
markdown file, `genclass-report.md`, and prints it. A short GitHub Actions step posts that file as one pull-request
comment that updates in place.

It reads files; it does not inject anything. The files come from the GenClass Playwright fixture, which puts the
runtime on the page under test, adds seeded network chaos with `page.route` and writes one file per test. **The
fixture is being built separately and has not shipped yet.** Until it does, this reporter has nothing to read and
says so.

No runtime dependencies. Playwright is not imported: the reporter implements Playwright's reporter interface by
shape, and the summariser is a pure function you can call from any script.

## Install

Not on npm yet (version 0.1.0 is unreleased). Once published:

```bash
npm install -D @genclass/playwright
```

## Use

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["list"], ["@genclass/playwright/reporter"]],
});
```

| option | default | what |
|---|---|---|
| `dir` | `test-results/genclass` and `genclass` inside each project's `outputDir` | Where the fixture's files are, relative to the config's directory (a string or a list). |
| `outputFile` | `"genclass-report.md"` | The report, relative to the config's directory. `false`: print only. |
| `quiet` | `false` | Do not print the report at the end of the run. |
| `minSeeds` | `2` | Seeds a signature must be flagged in, within one test, to be marked **Reproducible** (the fixture's 2-seed rule). |
| `title` | `"GenClass race report"` | The report's heading. |

The reporter never changes the run's status and never throws into Playwright: a report it cannot write is one line
on stderr.

### Without the reporter, or with shards

```bash
npx genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--title <text>] [--quiet]
```

Same report from the same files (default dir `test-results/genclass`, default out `genclass-report.md`, `-` prints
only). For sharded runs, collect each shard's `test-results/genclass/` and pass the directories. Exit code 0 when the
report was written, whatever it says; 1 when the file could not be written; 2 on a usage error.

From code (pure, no I/O):

```ts
import { summarize } from "@genclass/playwright/summarize";
const markdown = summarize([{ name: "checkout-1.json", content: jsonText }], { minSeeds: 2 });
```

`buildSummary` returns the same report as data (tests, signatures, seeds, totals, skipped files), and
`validateRaces` / `parseRaces` check one file.

## What it reads

One JSON file per test (or per test and seed) in `test-results/genclass/`, format `genclass-races/1`, as agreed with
the fixture's authors:

```ts
interface GenClassRacesFile {
  schema: "genclass-races/1";
  test: string;                  // the test's title path
  seed: number;                  // the chaos seed of this run
  signatures: {
    sig: string;                 // "trigger|diagnosis|op", ids normalised by the fixture
    trigger: string;             // the runtime's trigger kind: "request", "delivery", "failure", ...
    diagnosis: string;           // the model's diagnosis: "duplicate", "stale", "failing", ...
    op: string;                  // "POST /api/orders"
    confidence: number;          // the model's probability for that diagnosis, 0 to 1
    evidence: string;            // the line the runtime printed for the decision
    seeds: number[];             // the seeds this signature was seen in
  }[];
  shadow?: unknown;              // carried through, not interpreted
  mode?: string;                 // optional, shown when present
  model?: { state?: string; name?: string; version?: string; device?: string } | null;  // optional
  chaos?: { latencyMs?: [number, number]; reorder?: boolean; failRate?: number; routes?: unknown[] } | null;  // optional
}
```

The type is exported as `GenClassRacesFile`. A file that does not validate is never half-read: the report lists it
under **Files skipped** with the field and the reason (for example
`signatures[0].confidence: expected a number from 0 to 1, got 1.4`), so a change of format shows up in the comment
instead of as an empty report.

How the report groups them:

- **by test**, then **by signature**: the same `sig` in several files of one test is one line, with the seeds merged,
  the highest confidence and that occurrence's evidence line;
- **Reproducible** when a signature was flagged in at least `minSeeds` seeds of the same test; a signature seen in
  fewer seeds may depend on that seed's timing;
- **groups by the model's diagnosis label**: `duplicate` (Duplicate submits), `stale` (Stale responses), `failing`
  (Failing endpoints) and everything else (Other detections: `transient`, `inconsistent`, `overload`, ...).
  `expected` is not a detection and is left out. Nothing looks at facts or decides on its own what is a bug;
- a file whose `model.state` is not `ready` could not flag anything, and the report says so for that test;
- **nothing about interventions.** The files do not say what an action did to your app, so the report makes no
  claim about interventions, correct or false.

## What the comment looks like

This is the exact output for the unit-test fixture in [`test/fixtures/races`](test/fixtures/races): two tests, two
seeds each, one signature flagged in both seeds and one in a single seed. The fixture is synthetic (the evidence
lines are written for the test, not taken from a real run); `test/package.test.ts` fails if this block and the
summariser drift apart.

```markdown
<!-- genclass-report -->
## GenClass race report

**2 signatures** in 2 tests, **1 reproducible** (flagged in 2 or more seeds of the same test) · 4 files read in `test-results/genclass`

| | signatures | reproducible |
|---|---:|---:|
| Duplicate submits | 1 | 1 |
| Stale responses | 1 | 0 |
| Failing endpoints | 0 | 0 |
| Other detections | 0 | 0 |

### checkout.spec.ts > checkout > places one order

2 seeds (1, 2) · 1 signature

**Duplicate submits**

- **Reproducible**: 2 of 2 seeds (1, 2) · `POST /api/orders` · `request:duplicate` · confidence 0.97
  > 1 identical POST /api/orders request in the last 10s (#15, 0.03s earlier, still in flight); no user action between them.

### search.spec.ts > search > shows the results of the last query

2 seeds (1, 2) · 1 signature

**Stale responses**

- 1 of 2 seeds (2) · `GET /api/search` · `delivery:stale` · confidence 0.91
  > The response of GET /api/search (#21) arrives after a newer GET /api/search (#23) was answered; it would replace results.query, which #23 wrote 0.31s ago.

---

Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). Reproducible: flagged in 2 or more seeds of the same test. A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.
```

The first line is an HTML comment, invisible on GitHub, that lets a CI step find and update its own comment.

## Post it on the pull request

No new secret: the workflow's own `GITHUB_TOKEN` with `pull-requests: write`. On pull requests from forks that token
is read-only, so the step is skipped there (the job summary still works).

```yaml
# .github/workflows/e2e.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test   # the reporter writes genclass-report.md

      - name: GenClass report in the job summary
        if: ${{ !cancelled() && hashFiles('genclass-report.md') != '' }}
        run: cat genclass-report.md >> "$GITHUB_STEP_SUMMARY"

      - name: GenClass report on the pull request (one comment, updated in place)
        if: ${{ !cancelled() && hashFiles('genclass-report.md') != '' && github.event.pull_request.head.repo.full_name == github.repository }}
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: genclass-report
          path: genclass-report.md
```

The same with the GitHub CLI only (it updates the bot's comment that starts with the report's marker, or adds one):

```yaml
      - name: GenClass report on the pull request
        if: ${{ !cancelled() && hashFiles('genclass-report.md') != '' && github.event.pull_request.head.repo.full_name == github.repository }}
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          id=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
            --jq '.[] | select(.user.login == "github-actions[bot]" and (.body | startswith("<!-- genclass-report -->"))) | .id' | head -n 1)
          if [ -n "$id" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/$id" -F body=@genclass-report.md > /dev/null
          else
            gh api -X POST "repos/$REPO/issues/$PR/comments" -F body=@genclass-report.md > /dev/null
          fi
```

## Pairing it with the fixture

The fixture is not published yet. The options below are the contract agreed with its authors on 2026-10-13; the
package name and import path are not final, so this is a sketch, not something to copy:

```ts
// tests/fixtures.ts (sketch)
import { test as base } from "@playwright/test";
import { genclass } from "<the GenClass fixture, once it ships>";

export const test = base.extend(
  genclass({ mode: "observe", chaos: { latencyMs: [0, 600], reorder: true, failRate: 0, routes: ["/api/"] }, seeds: 2 }),
);
```

Then keep this reporter in `playwright.config.ts` as above. Each test runs under each seed's network timing, the
fixture writes `test-results/genclass/<test-id>.json`, and the report marks what reproduced in two seeds.

## What to expect

This reporter only passes on what the runtime flagged. What the runtime flags in observe mode was measured on the
framework compatibility matrix ([`compat/RESULTS.md`](../../compat/RESULTS.md), run of 2026-10-10: headless Chromium,
10 seeds per cell, model `genclass-runtime-r17` 2.0.0-rc4t, the default of `@genclass/runtime-model` 0.2.0, WASM,
balanced profile, whose report threshold is 0.90 per [`docs/runtime/RESULTS.md`](../../docs/runtime/RESULTS.md)):

- **Double submit** (scenario b, a create form clicked twice): 10 `request:duplicate` detections over 10 seeds in
  each of the 14 data layers where the scenario applies (React state, TanStack Query, Zustand, Redux, Apollo,
  Next.js, SWR, Pinia, Svelte stores, Angular fetch and XHR, Solid, plain fetch).
- **Stale typeahead** (scenario a; the app showed stale results on 10 of 10 seeds without GenClass in 11 data
  layers): `delivery:stale` detections over 10 seeds were 2 (React state), 5 (Zustand with its devtools middleware
  set to `enabled: true`), 1 (Redux) and 2 (Next.js state), and 0 in the other 7 layers with the bug (Zustand with
  the middleware at its default, Pinia, Svelte stores, Angular fetch and XHR, plain HTML fetch and push). Stale
  detection needs state the runtime can discover: React component state, Redux, and Zustand stores whose devtools
  middleware is enabled (the discovery table of the same page).
- **On correct apps** (scenarios c to h, 880 runs): 49 false findings, `request:overload` ×45 and
  `request:duplicate` ×4, all on the polling scenario (g).

So lead with duplicate submits, expect stale signatures only where that state is discovered, and treat any line as
the model's diagnosis to check, not a confirmed bug.

## Privacy

This package reads files on the machine that runs it and writes one; it makes no network request and sends nothing
anywhere. The files hold test titles, operation names and the runtime's evidence lines (the runtime replaces URL
query values with "…"), and the comment you post contains the same.

The runtime's own anonymous diagnostics are off by design on local hosts (`localhost`, `*.localhost`, `127.0.0.1`,
private networks; [`TELEMETRY.md`](../runtime/TELEMETRY.md)), which is where e2e suites usually run. One exception:
`@genclass/runtime` 0.2.1 sent from local hosts by mistake when started with `GenClass.init()`, `/auto` or the
script tag (fixed in 0.2.2). With 0.2.1, or with a test server on a non-local host name, pass `telemetry: false`
to the runtime under test.

## Development

From the repository root (CI runs these in `.github/workflows/playwright-reporter.yml`):

```bash
npm run typecheck -w @genclass/playwright
npm run build -w @genclass/playwright
cd packages/playwright && npx vitest run   # schema, summariser (exact output), reporter, command, package invariants
```

Apache-2.0.
