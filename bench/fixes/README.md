# Fix bench: the usual fixes for stale search results and double submits, measured

How often does each common fix for a race condition leave the page wrong, how many requests does it send, and how
long until the right results show? And what does GenClass observe report on each variant: detections on the buggy
ones, next to false reports on the correct ones? This bench answers both on one machine, from one command.

Results: **[RESULTS.md](RESULTS.md)** (generated) and `results/raw/` (every run, JSON). The summary, with the setup and
versions, is section 17 of [docs/runtime/RESULTS.md](../../docs/runtime/RESULTS.md).

**What the committed results contain** (2026-10-25, one 4 vCPU cloud VM): without GenClass, 200 seeds for every
strategy on fast, jittery and lossy, and for the search strategies on tail (10,400 runs); with GenClass (model, and
model skipped), 50 seeds for every strategy on fast, jittery and lossy (4,200 runs). The commands:

```bash
node run.mjs --conditions off --profiles fast,jittery,lossy --workers 12
node run.mjs --conditions off --profiles tail --strategies a,b,c,d,e,f,g,h,i,j --workers 12
node run.mjs --conditions model --profiles fast,jittery,lossy --seeds 50 --model-workers 5
PORT=4518 node run.mjs --conditions skipped --profiles fast,jittery,lossy --seeds 50 --workers 4   # alongside the model pass
```

Keep the machine otherwise idle while it runs: with three runners at once on 4 vCPU the gap between keystrokes
drifted by up to 260 ms from the plan, so those cells were dropped and measured again alone.

## Run it

From the repository root, Node 20 or newer, Linux or macOS:

```bash
./bench/fixes/run.sh --conditions off --seeds 20      # a quick look: no GenClass, 20 seeds, a few minutes
./bench/fixes/run.sh                                  # everything at 200 seeds: 33,600 runs, many hours on 4 vCPU
```

`run.sh` installs what is missing (`npm ci` at the root and here), builds `@genclass/runtime` from this repository,
builds the 14 pages, fetches `@genclass/runtime-model` (the version the runtime loads by default) from the npm registry
and checks its sha256s, then runs `run.mjs` and `report.mjs`. A cell (condition, strategy, profile) is written to
`results/raw/` as soon as all its seeds are done, so an interrupted run picks up where it stopped; `--force` redoes
finished cells. Options of `run.mjs`:

| option | default | |
|---|---|---|
| `--conditions` | `off,model,skipped` | no GenClass; GenClass observe with the default model; GenClass observe with the model skipped |
| `--strategies` | `a` to `n` | |
| `--profiles` | `fast,jittery,lossy,tail` | |
| `--seeds`, `--seed-start` | `200`, `1` | |
| `--workers`, `--model-workers` | `6`, `3` | pages at once (the model condition is CPU-bound: keep it at or under the core count) |
| `--out` | `results/raw` | |
| `--force`, `--no-report` | | |

`node report.mjs` rebuilds `RESULTS.md` and `results/summary.json` from `results/raw/` without running anything.
`node server.mjs` starts the server alone (https://127.0.0.1:4517, self-signed certificate): pages are at
`/s/<strategy>/?run=<id>` once a run is registered (`POST /__bench/runs`), which is what `run.mjs` does.

## What is measured

**Strategies** (`src/`, one page each, written for this bench; production builds):

| | page | stack | strategy |
|---|---|---|---|
| a | search | React 19 | no guard: every response is written |
| b | search | React 19 | debounce 300 ms, no other guard |
| c | search | React 19 | ignore flag in the `useEffect` cleanup (react.dev) |
| d | search | React 19 | `AbortController` aborted in the `useEffect` cleanup |
| e | search | React 19 | request id: write only if the response's number is still the latest |
| f | search | TanStack Query 5 | `useQuery` with the term in the query key (library defaults) |
| g | search | SWR 2 | `useSWR` with the term in the key (library defaults) |
| h | search | RxJS 7 | `switchMap` with `fromFetch` (no framework) |
| i | search | Vue 3.5 | `watch` with `onCleanup` |
| j | search | Svelte 5 | `$effect` with an `AbortController` aborted in its teardown |
| k | submit | React 19 | no guard: every click on Create sends a POST |
| l | submit | React 19 | button disabled while the request is pending |
| m | submit | React 19 | idempotency key (one per submission intent) checked by the server; button not disabled |
| n | submit | TanStack Query 5 | `useMutation`, button disabled while `isPending` |

Every search page except (b) sends one request per keystroke, so the strategies are compared on their own; debounce is
often combined with one of the guards, which cuts requests and changes nothing else measured here.

**Server** (`server.mjs`): HTTP/2 on 127.0.0.1 (a self-signed certificate made with `openssl` on first start, in
`.cache/`), so the browser does not queue requests behind HTTP/1.1's six connections per host. The search API echoes
the query (`{ q, items }`); pages show the results with the query they are for (`data-term`), which is how the runner
knows what is on screen. Latency for each request is drawn from `(seed, profile, method, path and query, attempt)`
(`lib/rng.mjs`), so a given request takes the same time whatever fix the page uses:

| profile | latency | order | failures |
|---|---|---|---|
| fast | uniform 20 to 60 ms | answered in request order | none |
| jittery | uniform 50 to 900 ms | each request on its own | none |
| lossy | uniform 50 to 900 ms | each request on its own | 5% answered 503 after their latency, not processed (no ticket created, idempotency key not kept) |
| tail | uniform 50 to 900 ms, except 10% of requests, which take 1.5 to 4 s | each request on its own | none |

**User** (Playwright 1.63, Chromium): for search, a two-word query from 20, typed with 60 to 150 ms between keys and a
pause of 150 to 1,200 ms before the second word (people glance at the first results before refining; without that
pause a 300 ms debounce never fires mid-query at these speeds). For submit, the page loads its ticket list, then the
user double-clicks Create with 0 to 150 ms between the two clicks, as real mouse events at the button's position, so
a disabled button really ignores the second one (Playwright's `click()` would wait for it to be enabled). Everything is
drawn from the seed: every strategy and condition sees the same user in a seed.

**End of a run**: nothing in flight, no new request and no change on the page for 1 s, and nothing marked
`aria-busy` (TanStack Query keeps its loading state while it waits to retry, so the run waits for the retry); at most
15 s after the last key or click. In the model condition the runner then waits until GenClass has made no new decision
for 1 s.

**Per run**: the final state (search: results for the typed query, results for another query, an error, nothing;
submit: tickets created on the server), requests the server received (aborted ones included), the request log, the
time from the last keystroke until the right results showed for good (submit: first click to "Created"), and in the
GenClass conditions every model decision with its diagnosis, probability and tier.

- **Wrong final state.** Search: results for another query (stale), an error although the typed query's last answer
  succeeded (stale error), or nothing shown. An error after the typed query's own request failed is the truth and is
  counted as "error shown", not wrong. Submit: more than one ticket.
- **GenClass detection.** At least one race diagnosis (stale, duplicate, conflict, inconsistent) in the run, at the
  likely tier (what observe reports by default) or likely + possible (observe's `console.debug` tier). On a run that
  did not end wrong, and on every run of a correct fix, a detection is a false report.

**GenClass conditions** (the app bundles are identical in every condition; only the page's `<head>` differs):

- `off`: no GenClass.
- `model`: `<script>window.GENCLASS_CONFIG = { mode: "observe", telemetry: false, visual: false, model: { baseUrl:
  "/model/", ortWasmPaths: "/ort/", preload: "eager" } }</script>` and the script tag
  (`packages/runtime/dist/genclass.global.min.js`), first in `<head>`. The user starts once the model is ready (as in
  the compatibility matrix), so a page load's cold start is not measured. Default `aggressiveness` (balanced).
- `skipped`: the same with `model: { loadIf: () => false }`, what devices with 2 GB of memory or less and Save-Data
  connections get by default.

The measured visual checks are off because 127.0.0.1 is a development host, where they would start; they never feed a
detection. Telemetry is off (it is off on local hosts anyway).

## Limits

- One machine, one browser (headless Chromium), local network. Real networks have other latency shapes; the uniform
  distributions here are a stress test, not a model of any one API.
- The pages are small and written for the bench by the same author as the runner; they are idiomatic, not tuned for
  or against GenClass (AGENTS.md rule 4: no code from `demos/` or `sim/`).
- Wall-clock timers: two runs of the same seed are separate page loads, so a race that is close can land either way.
  The agreement of final states between conditions is reported as such, not as a controlled comparison.
- The double-click is the only submit behaviour measured; impatient re-clicks after a slow response, retries after an
  error and reloads are not.
