# @genclass/playwright

### Explain your flaky e2e test: which response landed over newer data, which click submitted twice.

GenClass for Playwright, in two parts that share one file format:

- **The fixture** (`@genclass/playwright/fixture`) puts [`@genclass/runtime`](../runtime) on every page your tests
  open, before the app's first script, in observe mode with telemetry off. With `chaos` it slows and reorders the
  app's API responses from a seed, so the orders a real network produces happen in your test, the same way every
  run. At the end of each test it writes one JSON file (format `genclass-races/1`) with what the runtime saw, the
  seed and the chaos that produced it.
- **The reporter** (`@genclass/playwright/reporter`) reads those files when the suite ends, marks what reproduced
  across seeds, writes one markdown file, `genclass-report.md`, and prints it. A short GitHub Actions step posts that
  file as one pull-request comment that updates in place.

What the fixture records without a model download: two happens-before facts the runtime computes on its own
(`overwrote-newer`, a response that wrote a field over what a newer request or the user had written;
`identical-in-flight`, two identical requests in flight together from separate user actions). With the model loaded
(`model: "load"`, a 13 MB download), the file also carries the model's diagnoses with their confidence. Both are
things to look at, not verdicts: the report says what happened and leaves the call to you.

Observe only. The runtime never holds, delays or changes anything the app does; the fixture's chaos changes when a
response reaches the page, never what it says; no finding changes a test's outcome. No runtime dependencies:
`@playwright/test` and `@genclass/runtime` are peer dependencies (the reporter alone needs neither).

## Install

Not on npm yet (version 0.1.0 is unreleased). Once published:

```bash
npm install -D @genclass/playwright @genclass/runtime
```

Playwright 1.40 or later; `@genclass/runtime` 0.3.0-beta.1 or later (the fixture reads its `dist/` from the
installed package).

## Use

Two lines in the config, one import in a spec:

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  use: { genclass: { chaos: { seed: 1, delayMs: [0, 600] } } },
  reporter: [["list"], ["@genclass/playwright/reporter"]],
});
```

```ts
// tests/search.spec.ts
import { test, expect } from "@genclass/playwright/fixture";

test("shows the results of the last query", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  await expect(page.locator("#results li").first()).toContainText("react");
});
```

`test` is Playwright's `test.extend` with GenClass on its `page`; `expect` is Playwright's. Everything else in the
spec stays as it was. The run ends with `test-results/genclass/<test>-<id>-s<seed>.json` per test and
`genclass-report.md` next to the config.

Two seeds, so the report can mark what reproduced: `repeatEach: 2` in the config (or `npx playwright test
--repeat-each 2`). The fixture adds the repeat index to the seed, so the repeats run under seeds 1 and 2, and a
signature flagged in both is **Reproducible** in the report.

### The `genclass` option

Set in `use` in the config, or `test.use({ genclass: {...} })` in a spec or a `describe` block.

| key | default | what |
|---|---|---|
| `enabled` | `true` | `false`: the fixture does nothing (the page is Playwright's own, no file is written). |
| `mode` | `"observe"` | The only value. The runtime reports and never holds, delays or changes anything; guard and heal are not for tests. |
| `model` | `"skip"` | `"skip"`: no model download; the file carries the runtime's witnesses, facts computed without the model, and no model confidences. `"load"`: the runtime loads its model (from `modelUrl`, else the package default on jsDelivr: 13 MB, cached by the browser) and the file also carries its detections with their confidence. |
| `modelUrl` | package default | With `model: "load"`: a model directory URL (the runtime's `model.baseUrl`). |
| `chaos` | off | Seeded network chaos (below): an object, or `true` for the defaults. Off unless given. |
| `outDir` | `"test-results/genclass"` | Where the files go, relative to the config's directory. The reporter reads the same place by default. |
| `runtimeDir` | the installed package's `dist/` | `@genclass/runtime`'s `dist/` directory, when it is not resolvable from your project. |

### Chaos

```ts
use: { genclass: { chaos: { seed: 1, delayMs: [0, 600], reorder: true, match: ["/api", /\/graphql$/] } } }
```

| key | default | what |
|---|---|---|
| `seed` | `1` | Every delay is derived from it. With `repeatEach`, the fixture adds the repeat index. |
| `delayMs` | `[0, 600]` | Extra latency per matched response, uniform in `[min, max]` ms, at most 10000. |
| `reorder` | `true` | `false`: matched responses keep their request order (latency only, nothing overtakes). |
| `match` | same-origin `/api*` or JSON | Which requests: a path prefix (`"/api"`), a URL prefix (`"https://api.example.com/"`), a RegExp tested against the full URL, a function of `{ url, method, resourceType, sameOrigin }`, or a list of those. Without it: same-origin requests whose path starts with `/api` or whose response is JSON. |

How it works: with `page.route`, the fixture fetches the real response at once and holds its delivery to the page
for the planned time, the way a slower network would. Each matched request is keyed by its method, path and
occurrence in the test (`GET /api/search#3`); its delay comes from a small PRNG seeded by `seed` and that key, so
the same test under the same seed gets the same delays whatever the wall clock does, and a finding comes with the
seed that produced it. Nothing is dropped, changed or invented. Only fetch and XHR requests are ever touched, never
documents, scripts, styles, images, WebSockets or the runtime's own files; a request outside `match` is passed
through untouched. One consequence of fetching the response first: a matched response is buffered, so a streaming
response (server-sent events over fetch, NDJSON) on a matched URL does not work; exclude it with `match`.

### The model trade-off

By default (`model: "skip"`) nothing is downloaded and the file carries the runtime's **witnesses**: facts the
runtime computes from what it already traces (the causal chain of every request, the version history of every
store field), with no model involved:

- `overwrote-newer`: a request's response chain wrote a field that, since the request started, a newer operation
  (one that started after it, outside its causal chain) or the user had written. Older data over newer data.
- `identical-in-flight`: two identical requests (same method, URL and body) in flight together, from two separate
  user actions.

A witness is a fact, not a diagnosis: some overwrites are intended, and many are repaired a moment later. The report
keeps them in their own group, shows no confidence for them and says so in its footer. They need state the runtime
can see: stores registered with the runtime, or found by automatic state discovery (React component state, Redux,
Zustand stores with the devtools middleware), which the fixture turns on.

With `model: "load"` the runtime downloads its model (13 MB, from jsDelivr unless `modelUrl` names your own copy;
the browser caches it) and the file also carries the model's **detections** (`delivery:stale`,
`request:duplicate`, `failure:failing`, ...) with the model's confidence and the evidence line it printed, grouped
by diagnosis in the report. What the model flags, and how often it is wrong on correct apps, was measured on the
framework compatibility matrix (the "What to expect" section below).

### What the fixture puts on the page

For the runtime to see the app's first requests and state, it has to be there before the app's first script, so
the fixture adds one init script per page: the runtime's script-tag build (`dist/genclass.global.js`) with the
page configuration `mode: "observe"`, `telemetry: false`, no visual checks, no devtools overlay, the model as
chosen, and one sink that hands each likely detection to the test runner. The runtime's files are served from disk
on the page's own origin at `/__genclass__/` with `page.route`, never from a CDN. The page then loads the runtime's
agent entry (`dist/agent.js`) and connects it with every hold off (`hold: false`), pointed at a loopback URL the
fixture aborts, so the witnesses are computed and nothing is ever sent to an MCP bridge. Like the runtime's own
observers, the agent entry wraps the page's `setTimeout` and `clearTimeout` (to see pending debounces; it calls the
originals). The page gets two globals, `window.GenClass` (the runtime) and `window.__GENCLASS_PLAYWRIGHT__` (the
fixture's collector), and one exposed function.

Limits, as they are today:

- Only the `page` fixture is instrumented. Pages from `context.newPage()` or popups are not.
- Top frame only, on http(s) pages. `page.setContent` (about:blank) and iframes get nothing.
- An app that already starts GenClass itself (`GenClass.init()` from the ESM entry) runs a second runtime next to
  the fixture's; stores it registered with `rt.atom` or `rt.guard` on its own runtime are not visible to the
  fixture's, which sees network, user actions and what automatic discovery finds. An app integrated through the
  script tag (`window.GenClass`) shares the fixture's runtime.
- The witnesses need writes the runtime can attribute to a response (registered or discovered state). Apps whose
  state the runtime cannot see produce no witnesses; the model's detections about requests (duplicates, failures)
  do not depend on state.

## Measured

The fixture's end-to-end check, [`test/e2e`](test/e2e) (run by [`.github/workflows/playwright-reporter.yml`](../../.github/workflows/playwright-reporter.yml)),
on the search page of the MCP server's own e2e ([`packages/mcp/test/e2e/app/app.js`](../mcp/test/e2e/app/app.js)):
a search box whose results are written by each response, so a slower older answer can land over newer results; the
fixed variant keeps only the answer to the latest query. The test types "react" at 80 ms per key; the backend
answers in 40 ms, in order, so without chaos the race never shows. Headless Chromium 153 (Playwright 1.63.0),
2026-10-24, `model: "skip"`, five seeds per test (`repeatEach: 5`):

| page | chaos | seeds with `witness:overwrote-newer` on `GET /api/search` | any other signature |
|---|---|---:|---:|
| buggy | latency 0 to 600 ms, reorder | 5 of 5 | 0 |
| buggy | latency 0 to 600 ms, latency only (`reorder: false`) | 0 of 5 | 0 |
| fixed | latency 0 to 600 ms, reorder | 0 of 5 | 0 |

So on this page the fixture finds the race under every seed, reports nothing on the correct variant (the false
report count that goes next to every recall number here), and reports nothing when the chaos cannot reorder, which
is the check that the witness comes from the order and not from the latency.

The same buggy page with `model: "load"` (one run by hand, same day, two seeds, not part of the workflow because it
downloads the model): the model loaded through the fixture's path (`genclass-runtime-r17` 2.0.0-rc4t, WASM, in a
worker) and the witness was recorded in 2 of 2 seeds, but the model itself produced no likely detection: in seed 1
its top diagnosis for the late delivery was `stale` at 0.64, below the 0.90 report gate, and in seed 2 it raised
no decision. That matches the compatibility matrix below (stale detection is the model's weak case) and is why the
witnesses are the default.

One page is not a benchmark: the numbers to expect on your app depend on what state the runtime can see (above).
Wider measurements (the six demos, the real-app corpus) are the next step and will go to
[`docs/runtime/RESULTS.md`](../../docs/runtime/RESULTS.md).

## The reporter

```ts
// playwright.config.ts
reporter: [["list"], ["@genclass/playwright/reporter"]],
```

Listed alone (`reporter: [["@genclass/playwright/reporter"]]`) it works too: it prints only the report, once, at the
end, so Playwright still adds its own line reporter (dot on CI) for progress and failures, as it does next to the
html reporter. Playwright finds the reporter by its module name; `playwright-reporter.yml` checks that with a real
Playwright run (no browser).

| option | default | what |
|---|---|---|
| `dir` | `test-results/genclass` and `genclass` inside each project's `outputDir` | Where the fixture's files are, relative to the config's directory (a string or a list). |
| `outputFile` | `"genclass-report.md"` | The report, relative to the config's directory. `false`: print only. |
| `quiet` | `false` | Do not print the report at the end of the run. |
| `minSeeds` | `2` | Seeds a signature must be flagged in, within one test, to be marked **Reproducible**. |
| `title` | `"GenClass race report"` | The report's heading. |
| `maxChars` | `60000` | Keep the report under this many characters, so it fits in one GitHub comment (GitHub rejects comment bodies over 65,536). `0`: no limit. |

The reporter never changes the run's status and never throws into Playwright: a report it cannot write is one line
on stderr. It reads files; it does not inject anything (the fixture does that), and Playwright is not imported by
it: the reporter implements Playwright's reporter interface by shape, and the summariser is a pure function you can
call from any script.

### Without the reporter, or with shards

```bash
npx genclass-playwright-report [dir ...] [--out <file>|-] [--min-seeds <n>] [--max-chars <n>] [--title <text>] [--quiet]
```

Same report from the same files (default dir `test-results/genclass`, default out `genclass-report.md`, `-` prints
only, default `--max-chars 60000`, `0` for no limit). For sharded runs, collect each shard's `test-results/genclass/`
and pass the directories. Exit code 0 when the report was written, whatever it says; 1 when the file could not be
written; 2 on a usage error.

From code (pure, no I/O):

```ts
import { summarize } from "@genclass/playwright/summarize";
const markdown = summarize([{ name: "checkout-1.json", content: jsonText }], { minSeeds: 2 });
```

`buildSummary` returns the same report as data (tests, signatures, seeds, totals, skipped files), and
`validateRaces` / `parseRaces` check one file.

### The file format

One JSON file per test and seed in `test-results/genclass/`, format `genclass-races/1`:

```ts
interface GenClassRacesFile {
  schema: "genclass-races/1";
  test: string;                  // "[chromium] checkout.spec.ts > checkout > places one order"
  seed: number;                  // the chaos seed of this run
  signatures: {
    sig: string;                 // "trigger|diagnosis|op"
    trigger: string;             // the runtime's trigger kind ("request", "delivery", "failure", ...) or "witness"
    diagnosis: string;           // the model's diagnosis ("duplicate", "stale", "failing", ...) or the witness kind
    op: string;                  // "POST /api/orders"
    confidence: number;          // the model's probability for that diagnosis, 0 to 1; 1 for a witness (a fact)
    evidence: string;            // the line the runtime printed, or the witness's line
    seeds: number[];             // the seeds this signature was seen in
  }[];
  mode?: string;                 // "observe"
  model?: { state?: string; name?: string; version?: string; device?: string } | null;  // null: GenClass never started
  chaos?: { latencyMs?: [number, number]; reorder?: boolean; routes?: unknown[] } | null;  // the chaos option (latencyMs is delayMs)
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
- **witnesses** (trigger `witness`) get their own group, shown only when there are any, with no confidence on the
  line and a footer sentence saying what they are; they are never counted as duplicate submits or stale responses;
- a file that flagged nothing and whose `model.state` is not `ready` (for example `loading`, or `null` for a page
  where GenClass never started) may not have been checked, and the report notes it for that test. State `off` (no
  model by choice, the fixture's default) gets no note: the witnesses were still computed. A file with detections
  is reported as usual whatever the state: the runtime can unload an idle model after it ran;
- **nothing about interventions.** The files do not say what an action did to your app, so the report makes no
  claim about interventions, correct or false.

What it does so the comment is safe to post:

- text from the files (test names, evidence lines, modes) is escaped, so it cannot turn into markup;
- `#` before a digit, `GH-` before a digit and `@` before a name get an invisible zero-width space (U+200B). The
  runtime's evidence lines name requests by id (`#15`), which GitHub would otherwise link to issue or pull request
  15 of your repository (adding a "mentioned this" entry there), and a Playwright tag in a test title (`@smoke`)
  would mention a user or team. The text reads the same; copied, it carries the invisible character. Code spans
  (operations, file names) are left as they are, since GitHub links nothing inside them;
- the report is kept under `maxChars` (default 60000 characters). Left out first: entries of the "nothing flagged"
  and "Files skipped" lists, then the least important signatures of each test (fewer seeds and lower confidence
  first), then whole tests from the end. The counts always include everything, and a note under the first line says
  what was left out.

### What the comment looks like

This is the exact output for the unit-test fixture in [`test/fixtures/races`](test/fixtures/races): two tests, two
seeds each, one signature flagged in both seeds and one in a single seed, both model detections (a run with
`model: "load"`). The fixture is synthetic (the evidence lines are written for the test, not taken from a real run);
`test/package.test.ts` fails if this block and the summariser drift apart. Each `#` of a request id below is
followed by the invisible zero-width space described above.

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
  > 1 identical POST /api/orders request in the last 10s (#​15, 0.03s earlier, still in flight); no user action between them.

### search.spec.ts > search > shows the results of the last query

2 seeds (1, 2) · 1 signature

**Stale responses**

- 1 of 2 seeds (2) · `GET /api/search` · `delivery:stale` · confidence 0.91
  > The response of GET /api/search (#​21) arrives after a newer GET /api/search (#​23) was answered; it would replace results.query, which #​23 wrote 0.31s ago.

---

Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). Reproducible: flagged in 2 or more seeds of the same test. A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.
```

A run with the default `model: "skip"` looks like this instead (the e2e check above, shortened to the one flagged
test; the request ids carry the same invisible character):

```markdown
| | signatures | reproducible |
|---|---:|---:|
| Duplicate submits | 0 | 0 |
| Stale responses | 0 | 0 |
| Failing endpoints | 0 | 0 |
| Other detections | 0 | 0 |
| Witnesses (facts measured without the model) | 1 | 1 |

### search.spec.ts > search > buggy page: results of the last query

5 seeds (1, 2, 3, 4, 5) · 1 signature · chaos: latency 0–600 ms, reorder

**Witnesses (facts measured without the model)**

- **Reproducible**: 5 of 5 seeds (1, 2, 3, 4, 5) · `GET /api/search` · `witness:overwrote-newer`
  > The response of GET /api/search#​1 wrote search.results over what newer GET /api/search#​4 had written 0.26s after GET /api/search#​1 started (2 items \["reac one", "reac two"\] → 2 items \["r one", "r two"\]).
```

The first line of every report is an HTML comment, invisible on GitHub, that lets a CI step find and update its own
comment.

## Post it on the pull request

No new secret: the workflow's own `GITHUB_TOKEN` with `pull-requests: write`. On pull requests from forks that token
is read-only, so the step is skipped there (the job summary still works).

The reporter's `genclass-report.md` is kept under 60000 characters by default, which fits in one comment (GitHub
rejects bodies over 65,536). The job summary takes up to 1 MiB per step, so the summary step below renders a longer
report from the same files with the command (300000 characters stays under 1 MiB even if every character took three
bytes).

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
      - run: npx playwright test --repeat-each 2   # the fixture writes the race files, the reporter the report

      - name: GenClass report in the job summary
        if: ${{ !cancelled() }}
        run: npx genclass-playwright-report --max-chars 300000 --out - >> "$GITHUB_STEP_SUMMARY"

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

## What to expect from the model

With `model: "load"`, the report passes on what the runtime's model flagged. That was measured on the framework
compatibility matrix ([`compat/RESULTS.md`](../../compat/RESULTS.md), run of 2026-10-10: headless Chromium,
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

So with the model, lead with duplicate submits, expect stale signatures only where that state is discovered, and
treat any line as the model's diagnosis to check, not a confirmed bug. The witnesses (the default) were measured
only on the one page above so far.

## Privacy

This package reads and writes files on the machine that runs it, serves the runtime's files to the page it tests
from disk, and sends nothing anywhere: with `model: "skip"` no network request leaves your test environment
because of it; with `model: "load"` the page downloads the model and onnxruntime-web's wasm from jsDelivr (or
`modelUrl`). The runtime on the page runs with `telemetry: false`.

The files hold test titles, operation names and the runtime's evidence lines. For a witness that line includes the
store field's name and the runtime's short summary of its value before and after (`2 items ["r one", "r two"]`;
fields whose name says they hold a secret are redacted by the runtime, as elsewhere). The comment you post contains
the same, so read a report before posting it from a repository whose test data is private.

## Development

From the repository root (CI runs these in `.github/workflows/playwright-reporter.yml`):

```bash
npm run typecheck -w @genclass/playwright
npm run build -w @genclass/playwright
cd packages/playwright && npx vitest run   # chaos, race files, the installer on a fake page, schema, summariser (exact output), reporter, command, package invariants
```

The end-to-end check needs both builds and Chromium:

```bash
npm run build -w @genclass/runtime && npm run build -w @genclass/playwright
npx playwright install --with-deps chromium
node packages/playwright/test/e2e/run.mjs   # the table in "Measured"; prints a JSON summary, exit 0 when every count holds
```

The workflow also runs Playwright itself on `test/playwright-smoke` (no browser: its one test writes race files and
uses no page), which loads `@genclass/playwright/reporter` by name the way your config does, and checks that the
reporter's file equals the command's rendering of the same files. The module-resolution test in
`test/package.test.ts` needs `dist/` (build first); without it, outside CI, it is skipped.

Apache-2.0.
