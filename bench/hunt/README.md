# bench/hunt: explore and replay against any running app

A harness that runs GenClass's explore and replay loop ([docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)
sections 5 and 7) against a web app that is already running at a URL, without changing a line of the app. It is
the loop `packages/mcp/test/e2e/race.e2e.mjs` runs on its own demo page, made reusable: one command, one scenario file,
one report per app.

What one run does:

1. starts the GenClass MCP server in-process (`@genclass/mcp`, its bridge on a free loopback port) and headless
   Chromium;
2. arms `genclass_explore` (two baselines with responses in request order, then N seeded orders, optionally slower,
   like a bad network) and, for each planned load, opens a fresh browser context, puts `@genclass/runtime` on the page
   (see "How the injection works"), connects the agent link to the bridge, waits for the page's first quiet point
   (as the generated regression test does), runs the scenario's `steps(page)`, waits for the next quiet point
   (`whenSettled`), and records the scenario's `oracle(page)`;
3. asks for `genclass_explore report`: the verdict is GenClass's comparison of each seeded run's final state with the
   baselines (store fields, page text lines, form values, request counts, errors, witnesses), noise between the two
   baselines removed. No pattern is matched anywhere. The harness counts the verdict from the report's structured
   groups and says how many seeded orders it rests on, and how many GenClass could not compare;
4. for every race finding: `genclass_explain` (the evidence in causal order; the generated Playwright regression test
   is saved), `genclass_replay arm`, the scenario once more, `genclass_replay result` (REPRODUCED or not), and the
   generated test run against the app as it stands (it should fail while the bug is there);
5. lists every other finding GenClass recorded on those loads (an uncaught error, a duplicate request from two
   clicks, a response that overwrote newer data), the first three with their full explanation and generated test;
6. compares the scenario's own DOM oracle across the loads (the harness's check, labelled as such, never GenClass's
   verdict), and writes `report.md` and `report.json`.

The harness orchestrates and records. It never decides anything about the app (AGENTS.md rule 2) and never changes
it: the runtime runs in observe mode, which holds, delays and changes nothing; a schedule only moves the moment each
response reaches the app, and every response is delivered unchanged (CONTRACT.md section 16). Nothing leaves the
machine: telemetry is off, the model is skipped, the bridge is a loopback port.

## Install

From the repository root (Node 20 or later; the harness uses the repository's own `@playwright/test`, which is pinned
to the Chromium build Playwright installs):

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp     # the harness builds nothing itself
npx playwright install --with-deps chromium                              # once per machine
```

`node bench/hunt/hunt.mjs --help` lists the options.

## Five-minute walkthrough on the e2e page

The e2e page is a search box whose results are written by each response, with no staleness guard; a slower answer to an
older query can land last. `scenarios/e2e-search-server.mjs` serves it with no GenClass in the page at all (its state
lives in a closure, so GenClass discovers no store: the verdict rests on page text and request counts, as it would for
any app whose state GenClass does not see), plus a second planted bug, a Save button that sends one POST per click.

```sh
node bench/hunt/scenarios/e2e-search-server.mjs --port 4777 &
# 1. the buggy page: a race, reproduced, with a failing regression test
node bench/hunt/hunt.mjs --url http://127.0.0.1:4777/ --scenario scenarios/e2e-search.mjs --out results/e2e-buggy --expect race
# 2. the fixed page (the same steps): no race
node bench/hunt/hunt.mjs --url http://127.0.0.1:4777/fixed --scenario scenarios/e2e-search.mjs --out results/e2e-fixed --expect no-race
# 3. the second bug with a generic scenario: a duplicate-request finding, no race (the final state is the same)
node bench/hunt/hunt.mjs --url http://127.0.0.1:4777/form --scenario scenarios/double-click-submit.mjs --param button='text:Save' --param results='#items' --out results/e2e-form
# 4. the saved regression test against the fix at the same path (as a developer would run it after fixing):
#    restart the server with --fixed, then
GENCLASS_APP_URL=http://127.0.0.1:4777 npx playwright test --config results/e2e-buggy/tests/playwright.config.mjs
```

Measured on 2026-10-24 (headless Chromium 153 through Playwright 1.63.0, runtime 0.3.0-beta.1, mcp 0.1.0, 6 seeded
orders, `--slow 600`), the same counts as the e2e in AGENT.md section 7:

| page | GenClass explore verdict | replay | the generated test | DOM oracle (harness) |
|---|---|---|---|---|
| `/` (buggy) | **RACE: 5 of 6** reordered runs ended with the results of an older query ("reac", "rea", "r") | REPRODUCED | fails on the buggy page (expected "Results for react", received "reac") | differs in 5 of 6 |
| `/fixed` | **no race**: 0 of 6 differ from the baseline (no false report) | | the test saved from the buggy run passes against the fix at the same path (`--fixed`) | same in 6 of 6 |
| `/form` (double submit) | no race (both clicks land in every order) and one `duplicate-request` finding: `POST /api/items` sent twice, in flight together, by two clicks | | | same |
| `/form-fixed` | no race, no finding | | | same |

The committed reports are in `results/e2e-buggy/`, `results/e2e-fixed/`, `results/e2e-form/` and `results/e2e-form-fixed/`.

## A real app: Strapi 5.59.0 (`results/sample/`)

The same command on an app this repository does not own: a fresh `npx create-strapi@latest --example` (sqlite, the
example content types and data; the npm release, not a git checkout), its admin served by `strapi develop`, logged in
through `scenarios/strapi-login.mjs`, the Article list searched twice in a row with `scenarios/strapi-search.mjs`
(the entries search applies on Enter, so it is not a typeahead; the generic `typeahead.mjs` typed into the sidebar's
content-type filter instead, which is what a first attempt found out). 6 seeded orders, `--slow 600`.

What GenClass said, and what held up:

- **React and Redux state was discovered** (the admin's Redux store through the Redux DevTools globals, component
  state through the React hook): 300 state fields in every snapshot, the cap, so the comparison covered page text and
  form values in full and the first 300 state paths.
- **The search has no race.** Every seeded load that could run the steps ended with the same table as the baselines
  ("1 entry found", the same row). GenClass's verdict still reads "RACE: 1 of 4": the one race finding (`f25`) is a
  single discovered state field, `AuthProvider.external1.requestId`, which read `[redacted]` in both baselines (the
  runtime redacts it) and a fresh request id under seed 1, so a value that differs on every run slipped past the noise
  filter, which only sees values the baselines show. Its replay did not reproduce it and its generated test passes;
  the report says both next to the finding. Three more seeded loads had an older response overwrite newer data along
  the way (in the store's injected reducers) and ended right. `plain.mjs` with the first search's response delayed by
  2 s: the same end state in 3 of 3 runs (`results/sample/plain-search.txt`).
- **The page's load has an order dependency.** In 2 of 6 seeded orders (seeds 2 and 3) `GET
  /admin/users/me/permissions` was delivered after the content manager's own init responses (held 2.3 s, within the
  schedule's limit), and the page ended on "You don't have the permissions to access that content" with no table and
  no search button, so the steps could not run. GenClass cannot compare those loads (no recorded actions, so no
  baseline in their group); the report lists them under "Loads whose steps could not be done" with the page text.
  Without GenClass, `plain.mjs --delay 'GET /admin/users/me/permissions=2500'` ends on the same screen in 3 of 3 runs
  (`results/sample/plain-permissions.txt`). Whether a 2.5 s permissions response is a timing a user meets, and whether
  the admin should recover once the permissions arrive, is for Strapi's maintainers; it has not been reported upstream
  from here, and the mechanism was not traced in their code.
- **24 `stale-write` witnesses** on the Redux store's injected reducers (`GET /:id/locales` and the list response
  writing whole slices after a newer write). Facts, not diagnoses: the first three explanations are in the report in
  full, the rest cut to their evidence (each carries the whole step log).

The sample is there to show what a report on a real app looks like, including its weak findings. It is not a bug
report; "Using a result publicly" says what one needs.

## How to write a scenario

A scenario is an ES module. Named exports or a default object, these fields:

```js
// scenarios/my-search.mjs
import { textLines } from "../lib/dom.mjs";

export const name = "my-search";        // the results directory's default name, and the report's label
export const url = "/admin/articles";   // optional: a path resolved against --url, or an absolute URL; omit to use --url as given
export const settleMs = 400;            // optional: quiet time before GenClass snapshots the page (--settle overrides)
export const route = undefined;         // optional: arm only page loads of this path; the default lets the first armed load decide
export const settleBeforeSteps = true;  // optional: false starts the steps as soon as GenClass is connected, before the page is quiet

/** The user's steps, the same on every load. ctx: { params, url, log, phase }. */
export async function steps(page, ctx) {
  await page.getByRole("searchbox").pressSequentially(ctx.params.word ?? "react", { delay: 80 });
}

/** Optional: what the user sees at the end; compared across loads by the harness (not by GenClass). */
export async function oracle(page) {
  return { heading: await page.locator("h2").textContent(), rows: await textLines(page, "ul.results") };
}
```

Rules that matter:

- **Same steps every load.** GenClass groups runs by their recorded user actions (typing bursts with their final
  value, named by the element's label); a seeded load whose actions differ from the baselines' is not compared, and
  the report counts it as "not compared". Keep random values out of the steps. Keystrokes merge into one typing burst
  while the target keeps its name and the gaps stay under a second, so type at a steady pace below that. By default the
  steps start from the page's first quiet point: a label a load response changes while you type (Strapi's "author"
  becoming "author (1)") would otherwise split the burst differently on different loads.
- **Reach a quiet point.** After the steps the harness waits for `whenSettled`: no event for `settleMs`, nothing in
  flight or held, no pending short timer. A page that polls every 500 ms never looks quiet; raise `settleMs` only if
  the page has a longer debounce, and pass `--timeout` when the app is slow.
- **One page under test.** A scenario that navigates to another page mid-way makes that page's load take an explore
  slot: set `route` to the page under test (or `--route`).
- **Parameters** come from `--param key=value` (repeatable) as `ctx.params`; `lib/dom.mjs` has `param`, `numberParam`,
  `textLines` and `countOf`.
- The generic scenarios `scenarios/typeahead.mjs` (a word typed into a search field: `input`, `open`, `word`, `delay`,
  `results`) and `scenarios/double-click-submit.mjs` (fill fields, click a submit button twice: `button`, `fill`,
  `clicks`, `gap`, `results`) cover the two commonest races without a scenario file of your own.

## How to log in

Most apps worth hunting sit behind a login. Write a login module once (see `scenarios/strapi-login.mjs`):

```js
export async function login(page, ctx) {
  await page.goto(new URL("/login", ctx.url).href);
  await page.locator('input[name="email"]').fill(process.env.APP_EMAIL);
  await page.locator('input[name="password"]').fill(process.env.APP_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.includes("/login"));
}
```

`--login scenarios/x-login.mjs --storage-state .storage/x.json` runs it once in a browser context without GenClass, saves
the context's storage state (cookies, local storage) to the file, and every later page load starts from it.
`--storage-state` alone reuses a saved file, but sessions expire (Strapi's admin access token lasts 30 minutes, and a
session saved a few hours earlier landed every load on the login page): pass `--login` on every run unless the login is
slow. A load that ends on another page than asked is listed in the report, and the run
warns when a baseline was not on the requested page before its steps. The file holds a session: `.gitignore` covers
`bench/hunt/.storage/` and `bench/hunt/**/storage-state*.json`; keep credentials in the environment, never in a scenario
file.

## How to read a report

`report.md` (and the same data in `report.json`), from the top:

- **the header table**: the app URL and commit (`--app-commit`), the runtime and MCP versions and the checkout commit
  (the harness does not check that `dist/` was rebuilt from it), the harness commit and whether `bench/hunt` had
  uncommitted changes, the browser, the explore settings, whether the model ran, exactly what was injected;
- **Summary**: one row per scenario: loads recorded out of planned, GenClass's explore verdict (`RACE: n of N compared
  orders`, `no race`, or `no verdict` with the reason, and how many seeded loads were not compared), race findings,
  their replay verdicts, other findings, the DOM-oracle status;
- **per scenario**: the recorded actions as GenClass grouped them; how many state fields were discovered (0 means the
  verdict rests on page text, form values, request counts, errors and witnesses); the explore report verbatim; for
  each race finding the explanation verbatim (evidence in causal order, the steps of the failing run with each
  request's send and delivery time, the delivery order, how to replay), the replay result, the path of the generated
  test and whether it failed on the app as it stands; every other finding (the first three explained in full); the
  loads that were not on the requested page and the loads whose steps could not be done, with the page's text; the
  DOM-oracle comparison; a table of every page load (schedule assigned, run id, quiet point reached, forced
  deliveries, witnesses, errors, timings); GenClass's console messages, the page's uncaught errors and its console
  errors;
- **What this does not show**: what the verdict cannot cover on this app (state not discovered, the model skipped,
  explore's limits, the injection), with this run's own numbers.

What the verdicts mean:

- `RACE: n of N compared orders ended differently` is GenClass's statement that the final state depended on the
  delivery order in n of the N seeded orders it compared. The evidence names what differed. "n more overwrote newer
  data along the way" is a flicker the page repaired before the quiet point. Read the evidence before the count: a
  single state field that differs on every run (an id the baselines happened to show redacted) is noise GenClass did
  not catch, and its replay says "not reproduced".
- `no race: 0 of N compared orders differ` means none of these N orders changed the final state. It is not a proof that
  none can: raise `--runs`, add `--slow`, or `--focus` the request you suspect.
- `k seeded load(s) not compared`: GenClass put them in another group than the baselines (their steps failed, the page
  ended elsewhere, or their recorded actions differed). Each is listed in the report with what the page showed. Seeded
  loads that cannot even do the steps while the baselines can mean the page's state before the user acts depended on
  the order: a finding of its own, outside GenClass's verdict.
- `no verdict` means nothing was compared: no two baselines in one group (another page took a slot: set `--route`),
  no seeded load in the baselines' group, no load that reached a quiet point, or every page load failed (the reason
  says which).
- `REPRODUCED` is the replay's verdict: the finding's exact order produced the failing run's state again. "not
  reproduced" after a fix is the evidence the fix holds for that order.
- The **DOM oracle** rows are the harness comparing the scenario author's own reading of the page. When GenClass says
  race and the oracle differs too, they agree on independent evidence; when the oracle differs and GenClass does not,
  read the explore report's noise line first (the oracle may be noisy), then the page.

## Using a result publicly

An issue or a pull request on someone else's project carries their name. Before a result leaves your machine:

1. **Evidence first.** Quote the explore report and the explanation (the steps, the send and delivery times, what
   differed), not the summary line. Name the scenario file and the exact command.
2. **Reproduce without GenClass.** Show the same wrong state with nothing of GenClass on the page. `plain.mjs` does
   that with the same scenario: it slows down only the responses the finding names, with plain Playwright routing, and
   prints each run's oracle next to a reference run with no delay:

   ```sh
   node bench/hunt/plain.mjs --url <page> --scenario scenarios/x.mjs --storage-state .storage/x.json \
     --delay 'GET /api/search=2500' --runs 4
   ```

   Take the delay from the finding's delivery order (the response that landed last, and by how much). A race only
   GenClass can show is a question, not a bug report.
3. **The fixed variant must show no race.** Run the same scenario against your fix (or the upstream fix) and include
   that report: `no race`, replay `not reproduced`, the generated test passing.
4. **Name the commit of the app** (`--app-commit`), the browser and the runtime version, and say that GenClass was
   injected by this harness, not part of the app.
5. **Mind what the report holds.** Page text and form values from a logged-in app are in it (passwords, hidden,
   card and one-time-code fields and secret-named fields are left out by the runtime; nothing else is). Read it before
   publishing it, and never publish a storage state file.
6. Offer the fix and the generated regression test together; a report alone is a chore for the maintainer.

## How the injection works

The app's source is not touched. For every page load the harness:

- serves `packages/runtime/dist/` under the page's own origin at `/__genclass__/` (every file, correct content types),
  so the script-tag build, the agent entry and, with `--model-dir`, a model directory load same-origin;
- rewrites the HTML document on its way to the browser (Playwright routing): the script tag
  `<script src="/__genclass__/genclass.global.js" data-base="/__genclass__/">` goes first in `<head>`, where the
  README asks for it, so the runtime sees the page's first requests and the React discovery hook is installed before
  react-dom; a second tag connects the agent link (`dist/agent.js`, imported from the same path) once the runtime
  exists. Redirects pass through unchanged and are rewritten at their target;
- sets the page configuration from an init script (`window.GENCLASS_CONFIG`: observe, telemetry off, visual checks off,
  the model off unless `--model`); when the document was not rewritten (a response that is not HTML, or
  `--no-rewrite`), the init script inserts the runtime inline as soon as the document has an element to hold it: that
  is still before the page's external scripts, but after inline scripts that come first in `<head>`;
- opens each context with `bypassCSP: true` (so the injected script and the loopback bridge are allowed), service
  workers blocked (so every request reaches the routing), HTTPS errors ignored, and the `local-network-access`
  permission granted (Chromium otherwise refuses an intercepted request to the loopback bridge). These apply to the
  test browser only.

The injected tags are nodes the app's server did not render. A React 19 app accepts extra nodes in `<head>`; a React 18
app that renders its own `<head>` on the server (Next.js 13 and 14 with React 18, Remix on React 18) may log a hydration
mismatch and render again on the client. The report keeps the page's console errors so this is visible; such a run is
not measuring the app as its users get it.

For a page on a name other than localhost (a `*.test` name, a LAN address) the harness passes `anyHost` to the agent
link and allows the page's exact origin on the bridge (`GENCLASS_AGENT_ORIGINS`), as AGENT.md section 1 describes.

An app that already includes GenClass (`GenClass.init()` in its own code) is not a target for this harness: a second
runtime would observe the page twice. Use `connectAgent` from `@genclass/runtime/agent` in its development build instead.

## The generated regression test

`genclass_explain` writes a Playwright test that sets the finding's schedule through `window.__GENCLASS_SCHEDULE__`
(no bridge needed), performs the recorded actions and asserts the baseline's state. It expects the page to have the
agent link, which a hunted app does not, so the harness saves two files under `<out>/tests/`: the test as generated
(`<scenario>-<id>.spec.ts`, for the app's own repository once GenClass is in its dev build), and a copy whose import
comes from `bench/hunt/fixture.mjs` (`<scenario>-<id>.hunt.spec.mts`), a fixture that applies the same injection to the
test's browser context, with a `playwright.config.mjs` next to them. `hunt.mjs` runs the second one right away and
records whether it failed; run it yourself with `GENCLASS_APP_URL=<origin> npx playwright test --config
<out>/tests/playwright.config.mjs` (`GENCLASS_HUNT_STORAGE=<file>` for a logged-in app).

## Files

| file | what |
|---|---|
| `hunt.mjs` | the command: options, the MCP server and the browser, the explore and replay loop, the report |
| `lib/inject.mjs` | the injection: the virtual `dist/` path, the document rewrite, the init script, the permission |
| `lib/mcp.mjs` | the in-process MCP server driven over JSON-RPC (`tools/call`), plus the structured agent API |
| `lib/report.mjs` | `report.md` from `report.json`; the DOM-oracle comparison |
| `lib/dom.mjs` | helpers for scenarios (`textLines`, `countOf`, `param`, `numberParam`) |
| `fixture.mjs` | the Playwright fixture that injects GenClass for the generated tests |
| `plain.mjs` | the same scenario with no GenClass on the page and chosen responses slowed down: the reproduction step |
| `scenarios/` | `e2e-search.mjs` and its server, `typeahead.mjs`, `double-click-submit.mjs`, `strapi-login.mjs`, `strapi-search.mjs` |
| `results/` | committed reports: the e2e pages (`e2e-*`) and, when one was run, a real app (`sample/`) |

Not in CI. It needs Chromium and an app to point at; the e2e pages above are the regression check for the harness
itself.
