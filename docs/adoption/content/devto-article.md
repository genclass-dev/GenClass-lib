<!--
Draft for DEV (dev.to). Not posted.

Before posting: DEV allows AI-assisted articles only with a disclosure (the #ABotWroteThis tag or a line in the
text), and an AI-assisted article must not "Promote any business, program, or course (including your own)"
(https://dev.to/guidelines-for-ai-assisted-articles-on-dev). This draft was prepared with an LLM and mentions GenClass.
Two honest ways to publish it:
1. Rewrite it in your own words (then it is your article), keeping the disclosure about GenClass; or
2. Publish it as AI-assisted with the disclosure, and cut the section "Can a tool tell you which one your app has?"
   and every other GenClass mention except the link to the bench repository.
-->

---
title: We measured 10 ways to fix stale search results
published: false
tags: react, javascript, webdev, testing
canonical_url: https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md
---

**Disclosure:** I work on GenClass, an open-source (Apache-2.0) library that reports race conditions in web apps. The
benchmark below lives in its repository, and at the end we also ran GenClass on every page. The fix numbers do not
come from GenClass: the test harness reads them from the page and the server.

You type "react query" into a search box. The app sends one request per keystroke. The answer for "react" is slow,
arrives last, and replaces the results for "react query". The input and the list now disagree, and nothing threw.

Every guide to this bug shows a fix. None of them says how often the fix works, or what it costs. So we built one
tiny search page per fix, ran each one 200 times per network profile with a seeded server and a scripted user, and
counted.

## The 10 pages

| | fix | stack |
|---|---|---|
| a | no guard | React 19 |
| b | debounce 300 ms, nothing else | React 19 |
| c | ignore flag in the `useEffect` cleanup (react.dev's pattern) | React 19 |
| d | `AbortController` aborted in the cleanup | React 19 |
| e | request id: write only if it is still the latest | React 19 |
| f | `useQuery` with the term in the query key | TanStack Query 5 |
| g | `useSWR` with the term in the key | SWR 2 |
| h | `switchMap` with `fromFetch` | RxJS 7 |
| i | `watch` with `onCleanup` | Vue 3.5 |
| j | `$effect` with an `AbortController` in its teardown | Svelte 5 |

Every page except (b) sends a request per keystroke, so the fixes are compared on their own.

## How we measured

- **The server** draws each request's latency from a seed, so the request for "react q" takes the same time on every
  page. Four network profiles:
  - **fast**: 20 to 60 ms, answered in request order (your laptop);
  - **jittery**: 50 to 900 ms, each request on its own, so answers arrive in any order;
  - **lossy**: jittery, plus 5% of requests fail with a 503;
  - **tail**: jittery, except one request in ten takes 1.5 to 4 s.
- **The user** (Playwright, headless Chromium) types a two-word query at 60 to 150 ms per key and pauses 150 to
  1,200 ms before the second word, the way you glance at the first results before refining.
- **Wrong final state**: once everything has settled, the list shows results for another query, or a stale error, or
  nothing.
- 200 seeds per page and profile. Same seed, same user, same network, on every page.

## Results

Wrong results at the end, out of 200 runs each (on lossy, a page that shows an error because the typed query's own
request failed counts as right):

| fix | fast | jittery | lossy | tail | requests per query |
|---|---|---|---|---|---|
| (a) no guard | 0% | 52.5% | 49.5% | 74.5% | 11.0 |
| (b) debounce only | 0% | 0% | 0% | 7.5% | 1.9 |
| (c) ignore flag | 0% | 0% | 0% | 0% | 11.0 |
| (d) AbortController | 0% | 0% | 0% | 0% | 11.0 |
| (e) request id | 0% | 0% | 0% | 0% | 11.0 |
| (f) TanStack Query key | 0% | 0% | 0% | 0% | 11.0 |
| (g) SWR key | 0% | 0% | 0% | 0% | 11.0 |
| (h) RxJS switchMap | 0% | 0% | 0% | 0% | 11.0 |
| (i) Vue watch cleanup | 0% | 0% | 0% | 0% | 11.0 |
| (j) Svelte 5 $effect | 0% | 0% | 0% | 0% | 11.0 |

Median time from the last keystroke to the right results, jittery profile: 478 ms for the guards
(c to j), 778 ms with debounce (it waits 300 ms before asking).

What we did not expect:

- **The bug is invisible on a fast server.** No guard was right in 100% of runs on the fast profile and
  wrong in 52.5% on the jittery one. Same code, same typing. That is how it gets through review.
- **Debounce held, until it didn't.** While every answer came within 900 ms, debounce alone was never wrong: after the
  pause, typing the second word took longer than the slowest answer. With a slow tail it ended on the first word's
  results 7.5% of the time (15 of 200).
- **All eight guards were right in every run**, on all four networks. They differ elsewhere: AbortController and
  switchMap abort the stale requests (8.6 of 11.0 per query on the jittery
  network), so the browser stops downloading answers nobody will see; TanStack Query's default retries recovered every
  failed request on the lossy network (0% of runs ended on an error message, against
  6.5% for the other guards, which show the error), for 15 extra requests in 200 runs: it
  retries only the query on screen.

## What we would use

- **Already on TanStack Query, SWR, RTK Query or similar:** put every input of the request in the key. That is the
  whole fix (f, g). Render the data for the current key, never a copy of it in local state.
- **Plain React:** the ignore flag or an `AbortController` in the effect's cleanup (c, d). Both were right in every
  run; abort also stops the browser from downloading answers nobody will see.
- **RxJS / Angular:** `switchMap` (h). **Vue:** the watcher's `onCleanup` (i). **Svelte 5:** return a teardown from
  `$effect`, or use `getAbortSignal()` (j).
- **Debounce:** keep it for load. It is not a guard.

```jsx
// (c) the fix from react.dev
useEffect(() => {
  if (!query) return;
  let ignore = false;
  fetch(`/api/search?q=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .then((data) => {
      if (!ignore) setResults(data);
    });
  return () => {
    ignore = true;
  };
}, [query]);
```

## Bonus: double submits

Same harness, a "Create ticket" button double-clicked with 0 to 150 ms between the clicks (real mouse events, so a
disabled button really ignores the second one):

| fix | fast server | jittery | lossy |
|---|---|---|---|
| no guard | 100% | 100% | 94% |
| button disabled while pending | 72.5% | 2.5% | 5% |
| TanStack `useMutation`, disabled while `isPending` | 43.5% | 4% | 4.5% |
| idempotency key checked by the server | 0% | 0% | 0% |

(Share of double-clicks that created more than one ticket.) A disabled button only stops the second click while the
first request is still in flight. On a fast server it often is not. TanStack Query's `isPending` has one more gap: on the slower
servers, its duplicates came from two clicks about 3 ms apart, before `isPending` had disabled the button (the update is
batched). The button disabled through React state had none of those; all its duplicates came after the first request
had answered.

## Can a tool tell you which one your app has?

On a fast local server, the unguarded page was right in 100% of runs. That is why this bug ships.

This is where GenClass comes in (disclosure above): it watches the page from the inside and asks a small model, in a
Web Worker, whether a response is landing over newer data or a request is a repeat. In its default observe mode it
only reports. We added its script tag to every page:

| | runs with the bug that it reported | false reports |
|---|---|---|
| stale results (page a, runs that ended wrong) | 70% (35 of 50) | 0 of 1,200 runs of the eight correct search fixes |
| double submits (runs with two tickets) | 100% on the unguarded page, 100% of the duplicates the disabled buttons let through | 0 of 240 runs of those pages with one ticket |

Those are its default ("likely") reports, 50 seeds per page and network (fast, jittery, lossy). Two caveats that
belong next to them: it flagged 36.7% of the debounce page's runs, which all ended right (the first word's
results land while the input already shows more, which is what debounce does), and it called the second POST on the
idempotency-key page a duplicate in every run (true on the network, harmless in the app). Its lower "possible" tier
caught 88% of the stale runs and raised false reports on the correct search fixes to
3.8%. With the model skipped (what low-memory phones get by default) it reported nothing.

The costs, so you can judge: about 13 MB downloaded on the first visit (cached), a worker holding 190 to 280 MB while
the model is loaded, and anonymous diagnostics on by default except on localhost (`telemetry: false` turns them off).
There is a [live demo](https://genclass.dev/#lab).

## Run it yourself

```bash
git clone https://github.com/genclass-dev/GenClass-lib
cd GenClass-lib
./bench/fixes/run.sh --conditions off --seeds 20   # a few minutes
./bench/fixes/run.sh                               # the full run, hours
```

Every run's raw result is committed as JSON. If you think a page is not idiomatic, open an issue or a PR against
`bench/fixes/src`: the bench is only as good as its pages.

**Limits.** One machine, headless Chromium, synthetic latency (uniform, which is harsher than most real APIs). Real
users do more than type one query. The pages were written by the same people who wrote the harness.
