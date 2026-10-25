<!--
Draft for genclass.dev/guides/race-conditions-by-framework. Not published.
Title tag: Race conditions by framework: the fix, and how often it works
Meta description: Stale search results and double submits in React, TanStack Query, SWR, Redux Toolkit, Vue, Pinia,
SvelteKit, Angular, HTMX and Solid: the failure, the idiomatic fix, and measured failure rates from 14,600 seeded runs.
Numbers: bench/fixes/RESULTS.md and docs/runtime/RESULTS.md section 17 (re-run with ./bench/fixes/run.sh).
-->

# Race conditions by framework: the fix, and how often it works

Two races cause most of the "it showed the wrong thing" bugs in web apps:

- **Stale responses.** The user types "react query". Your app sends a request per keystroke. The answer for "react"
  arrives last and replaces the results for "react query". The box and the list now disagree.
- **Double submits.** The user double-clicks Create. Two POSTs go out, the server creates two tickets.

Every framework has an idiomatic fix for both. Most guides show the fix and stop there. We wanted to know how often
each fix actually works, so we built one small page per fix and ran each of them 200 times per network profile with a
seeded server and a scripted user (the bench is open source: [bench/fixes](https://github.com/genclass-dev/GenClass-lib/tree/main/bench/fixes)).
This page is the result, framework by framework.

## The short version

A user types a two-word query at 60 to 150 ms per key and pauses before the second word. Share of runs that ended
showing results for the wrong query, on three networks: **fast** (20 to 60 ms, answers in order, like your laptop),
**jittery** (50 to 900 ms, answers in any order) and **slow tail** (jittery, but one request in ten takes 1.5 to 4 s):

| fix | fast | jittery | slow tail | requests per query |
|---|---|---|---|---|
| no guard | 0% | 52.5% | 74.5% | 11.0 |
| debounce 300 ms, no other guard | 0% | 0% | 7.5% | 1.9 |
| ignore flag, AbortController, request id, TanStack Query key, SWR key, RxJS switchMap, Vue watch cleanup, Svelte 5 `$effect` teardown | 0% | 0% | 0% | 11.0 |

(200 runs per cell; the guards row is 1,600 runs per network, every one of them right.)

For double submits (two clicks 0 to 150 ms apart):

| fix | more than one ticket, fast server (20 to 60 ms) | jittery server (50 to 900 ms) |
|---|---|---|
| no guard | 100% | 100% |
| button disabled while pending | 72.5% | 2.5% |
| TanStack Query `useMutation`, disabled while `isPending` | 43.5% | 4% |
| idempotency key checked by the server | 0% | 0% |

Three things stand out:

1. **Every real guard worked**, in every run on every network. Pick the one that fits your stack; they differ in
   requests sent and in what the user sees while waiting, not in correctness.
2. **Debounce worked until the network had a slow tail.** It cut requests from 11.0 to
   1.9 per query, and while every answer came within 900 ms it was never wrong: after the pause, the
   user took longer to type the second word than the first request took to come back. Once one request in ten took
   1.5 to 4 s, 7.5% of runs ended on the results for the first word. Real APIs have tails.
3. **Disabling the button failed most on the fastest server.** In 72.5% of double-clicks the server had
   already answered the first click, so the button was enabled again when the second click landed. Only the
   server-side idempotency key held on every network.

The rest of this page: each framework's version of the failure, the fix we would use, and the measured number where
the bench has one.

## React (`useEffect` and `fetch`)

**The failure.** An effect fetches on every change of `query` and writes whatever comes back:

```jsx
useEffect(() => {
  fetch(`/api/search?q=${encodeURIComponent(query)}`)
    .then((r) => r.json())
    .then(setResults); // the last response to arrive wins, not the last query typed
}, [query]);
```

Measured (bench page a): wrong results at the end in 52.5% of runs on the jittery network and
49.5% on the lossy one (the same plus 5% failed requests). On a fast server that answers in order:
0%. That is why it passes every test on localhost.

**The fix.** The cleanup function runs before the next effect. Use it to ignore (react.dev's pattern) or abort the
previous request:

```jsx
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

```jsx
useEffect(() => {
  if (!query) return;
  const controller = new AbortController();
  fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
    .then((r) => r.json())
    .then(setResults)
    .catch((e) => {
      if (e.name !== "AbortError") setError(e);
    });
  return () => controller.abort();
}, [query]);
```

A request counter in a ref (write only if the response's number is still the latest) does the same outside effects,
for example in an event handler.

Measured: ignore flag (c), AbortController (d) and request id (e) all ended right in every run
(0 wrong in 2,400 runs over all profiles; on the lossy network an error message for the typed query is counted as right).
Median time from the last keystroke to the right results on the jittery network: 478 ms for all three.
AbortController sends the same requests but the browser drops the stale answers before your code sees them
(8.6 of 11.0 requests per query were aborted).

**Debounce is a load fix, not a race fix.** With a 300 ms debounce and no guard (b), runs were right on the fast,
jittery and lossy networks: by the time the user had typed the second word, the first word's request had come back.
On the slow-tail network 7.5% of runs (15 of 200) ended on the first word's results, because
that request was one of the slow ones and came back after the request for the full query. Use debounce with one of the
guards above.

Sources: [react.dev, Synchronizing with Effects: fetching data](https://react.dev/learn/synchronizing-with-effects#fetching-data),
[You Might Not Need an Effect: fetching data](https://react.dev/learn/you-might-not-need-an-effect#fetching-data).

## TanStack Query

**The failure.** TanStack Query is safe by default if the query key contains everything the query depends on. It breaks
when the key leaves the search term out:

```jsx
// wrong: one cache entry for every query, so a late answer for "react" lands in it
const { data, refetch } = useQuery({ queryKey: ["search"], queryFn: () => search(query) });
useEffect(() => { refetch(); }, [query]);
```

Copying `data` into `useState` from an effect reintroduces the React race above.

**The fix.** Put the term in the key. Each term gets its own cache entry and the component shows the entry for the
current key, so a late answer fills an entry nobody is looking at:

```jsx
const { data, isFetching } = useQuery({
  queryKey: ["search", query],
  queryFn: ({ signal }) => fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal }).then((r) => r.json()),
  enabled: query.length > 0,
  placeholderData: keepPreviousData, // optional: keep the old list on screen while the new one loads
});
```

Passing `signal` also cancels requests for keys that are no longer used. Without it, they run to completion (the
default).

Measured (f, term in the key, library defaults, no `signal`, no placeholder): ended right in every run,
0 wrong in 800 runs over all profiles. On the lossy network TanStack's default retries recovered failed requests:
0% of runs ended on an error, against 6.5% for the other guards, which show the
error (for 15 extra requests in 200 runs: TanStack retries only the query on screen).

**Double submits with `useMutation`.** Disabling the button while `mutation.isPending` is the usual advice
([TanStack discussion #10041](https://github.com/TanStack/query/discussions/10041) asks why it still lets
duplicates through). Measured (n): more than one ticket in 43.5% of double-clicks on a fast server,
4% on the jittery one. The duplicates on the slower networks came from clicks about 3 ms apart, before `isPending` had disabled the button
(TanStack batches the state update); the button disabled through React state (l) had none of those, and every one of
its duplicates came after the first request had answered. The robust fix is on the server: an idempotency key that the
form keeps for one submission (m: 0 duplicates in 600 double-clicks over all profiles). A `useRef` flag set at the start of the handler closes the
window before the re-render; it does not help once the first request has finished.

Sources: [Query keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys),
[Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation),
[Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations).

## SWR

**The failure.** Same shape as TanStack Query: a key without the term (`useSWR("/api/search", () => search(query))`)
never refetches when the query changes, and a fetch outside SWR whose result goes into `useState` races as in plain
React.

**The fix.** Make the term part of the key, and pass `null` to skip the empty query:

```jsx
const { data, error, isLoading } = useSWR(
  query ? `/api/search?q=${encodeURIComponent(query)}` : null,
  (url) => fetch(url).then((r) => r.json()),
  { keepPreviousData: true }, // optional
);
```

Measured (g, term in the key, library defaults): ended right in every run, 0 wrong in 800 runs over all profiles. On the lossy
network SWR shows the error and retries later (its default back-off waits seconds), so 6.5% of runs
ended on an error message for the typed query, which is the truth at that moment.

Sources: [SWR API](https://swr.vercel.app/docs/api) (`keepPreviousData`, `dedupingInterval`),
[Mutation](https://swr.vercel.app/docs/mutation).

## Redux Toolkit and RTK Query

**The failure.** A `createAsyncThunk` search dispatched on every keystroke. Each `fulfilled` action writes its
payload, so the last one to resolve wins.

**The fix.** Keep the latest `requestId` in the slice and drop older results, and abort the previous thunk when a new
search starts:

```js
export const search = createAsyncThunk("search/run", async (q, { signal }) => {
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
  return r.json();
});

// in the slice
builder
  .addCase(search.pending, (state, action) => {
    state.requestId = action.meta.requestId;
  })
  .addCase(search.fulfilled, (state, action) => {
    if (action.meta.requestId !== state.requestId) return; // a newer search started
    state.results = action.payload;
  });

// in the component
useEffect(() => {
  if (!query) return;
  const promise = dispatch(search(query));
  return () => promise.abort();
}, [query]);
```

With **RTK Query** the query argument is the cache key, like TanStack Query: `useSearchQuery(query, { skip: !query })`.
One detail: `data` is "the latest returned result regardless of hook arg", so it shows the previous query's results
while the new ones load; `currentData` is the result for the current argument only. Render `currentData` if showing
old results for a moment is wrong in your UI.

Not measured in the bench. The `requestId` check is the same logic as the request id page (e), which ended right in
every run.

Sources: [createAsyncThunk](https://redux.js.org/toolkit/api/createAsyncThunk) (`condition`, `abort`, `requestId`),
[RTK Query hooks](https://redux.js.org/toolkit/rtk-query/api/created-api/hooks).

## Vue

**The failure.** A `watch` on the query that awaits a fetch and assigns the result. Vue's docs describe it directly:
when the previous request completes, "it will still fire the callback with an ID value that is already stale."

**The fix.** The watcher's cleanup runs before the next run of the callback. Mark the old run as cancelled, or abort
its request:

```js
watch(query, async (q, _old, onCleanup) => {
  if (!q) return;
  let cancelled = false;
  onCleanup(() => {
    cancelled = true;
  });
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await r.json();
  if (!cancelled) results.value = data;
});
```

In Vue 3.5+, `onWatcherCleanup(() => controller.abort())` does the same with an `AbortController`, but it must be
called before the first `await`.

Measured (i, `onCleanup` with a flag): ended right in every run, 0 wrong in 800 runs over all profiles.

Source: [Vue watchers: side effect cleanup](https://vuejs.org/guide/essentials/watchers.html#side-effect-cleanup).

## Pinia

**The failure.** An async store action called on every keystroke. Pinia runs overlapping calls in parallel and says
nothing about their order, so the last to resolve writes the state.

**The fix.** A request counter inside the store (setup syntax), or an `AbortController` kept in the store and aborted
at the start of each call:

```js
export const useSearchStore = defineStore("search", () => {
  const results = ref([]);
  let latest = 0;
  async function search(q) {
    const id = ++latest;
    const data = await fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
    if (id === latest) results.value = data;
  }
  return { results, search };
});
```

Not measured in the bench; the logic is the request id page (e). Pinia Colada keys queries like TanStack Query.

Source: [Pinia actions](https://pinia.vuejs.org/core-concepts/actions.html).

## SvelteKit and Svelte 5

**The failure.** An `$effect` (or a Svelte 4 `$:` block) that fetches whenever the query changes and assigns the
result.

**The fix.** Return a teardown from the effect. It runs before the effect runs again:

```svelte
<script>
  let query = $state("");
  let results = $state([]);

  $effect(() => {
    const q = query;
    if (!q) return;
    const controller = new AbortController();
    fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => (results = data))
      .catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
    return () => controller.abort();
  });
</script>
```

Recent Svelte 5 releases also export `getAbortSignal()`, a signal that aborts when the current effect or derived
re-runs: `fetch(url, { signal: getAbortSignal() })` inside the effect.

If the query lives in the URL and a `load` function fetches (`goto("?q=" + q, { keepFocus: true, replaceState: true })`),
SvelteKit's router itself drops a navigation when a newer one started ("abort if user navigated during update" in
`src/runtime/client/client.js`), so a late `load` result does not replace a newer page.

Measured (j, `$effect` with `AbortController`): ended right in every run, 0 wrong in 800 runs over all profiles.

Sources: [`$effect`](https://svelte.dev/docs/svelte/$effect), [`getAbortSignal`](https://svelte.dev/docs/svelte/svelte),
[SvelteKit `load`](https://svelte.dev/docs/kit/load).

## Angular and RxJS

**The failure.** `mergeMap` (or a `subscribe` inside a `subscribe`) for a search box: every request's answer is
emitted, in arrival order.

**The fix.** `switchMap` unsubscribes from the previous request when a new term arrives; Angular's `HttpClient` aborts
it:

```ts
results$ = this.query.valueChanges.pipe(
  debounceTime(200),
  distinctUntilChanged(),
  switchMap((q) => this.http.get<Result[]>("/api/search", { params: { q } })),
);
```

For submits, `exhaustMap` ignores new clicks while a save is in flight. Like a disabled button, it lets a click
through once the first save has completed. With signals, Angular's `resource()` aborts the outstanding load when its
params change.

Measured (h, RxJS `switchMap` with `fromFetch`, no framework, no debounce): ended right in every run,
0 wrong in 800 runs over all profiles.

Sources: [switchMap](https://rxjs.dev/api/operators/switchMap), [exhaustMap](https://rxjs.dev/api/operators/exhaustMap),
[Angular `resource`](https://angular.dev/guide/signals/resource).

## HTMX

**The failure.** `hx-get` on a search input with `hx-trigger="keyup"`: every response is swapped into the target as
it arrives.

**The fix.** `hx-sync="this:replace"` aborts the in-flight request when a new one starts; `delay:` debounces:

```html
<input type="search" name="q"
       hx-get="/search" hx-target="#results"
       hx-trigger="input changed delay:300ms, search"
       hx-sync="this:replace">
```

For forms, `hx-disabled-elt="find button"` disables the button during the request, and `hx-sync="this:drop"` drops
new requests while one is in flight. Both share the disabled button's limit on fast servers.

Not measured in the bench (it covers fetch-based pages only).

Sources: [hx-sync](https://htmx.org/attributes/hx-sync/), [hx-disabled-elt](https://htmx.org/attributes/hx-disabled-elt/),
[hx-trigger](https://htmx.org/attributes/hx-trigger/).

## Solid

**The failure.** A `createEffect` that fetches and sets a signal has the same race as React.

**The fix.** `createResource` with the query signal as its source:

```js
const [query, setQuery] = createSignal("");
const [results] = createResource(query, (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json()));
```

Solid keeps only the latest fetch's result: a superseded promise's value is discarded (in the source, `loadEnd` checks
that the promise is still the current one). The docs do not say so, and the stale request is not aborted.

Not measured in the bench.

Source: [createResource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).

## Double submits, in any framework

- **Disable the button** while the request is pending, set synchronously in the click handler. It stops the
  second click only while the first request is in flight: measured, 72.5% duplicates when the server
  answered in 20 to 60 ms, 2.5% at 50 to 900 ms.
- **Send an idempotency key** the form keeps for one submission (a new key when the user changes the form), and let
  the server create one record per key and answer repeats with the same record. Measured: 0 duplicates in 600 double-clicks over all profiles,
  including when 5% of requests failed.
- React 19's `useActionState` queues repeated submits and runs them one after the other; it does not drop them.

## Finding the ones you missed

The fixes are easy once you know where the race is. On a fast local server it never shows: no guard ended right in
100% of runs there.

Disclosure: we build GenClass, an Apache-2.0 library that watches a page from the inside (network, user actions, state)
and asks a small on-device model whether a response is landing over newer data or a request is a repeat. We ran it in
its default observe mode on every page of this bench:

| | detected, at the default reporting level | false reports |
|---|---|---|
| stale results (page a, runs that ended wrong) | 70% (35 of 50) | 0 of 1,200 runs of the correct search fixes (c to j) |
| double submits (pages k, l, n, runs with two tickets) | 100% (148 of 148) on k, 100% (60 of 60) on l and n | 0 of 240 runs of l and n with one ticket |

Two caveats sit next to those numbers. It flagged 36.7% of the debounce page's runs (55 of 150), all of
which ended right: the first word's results landed while the input already showed more text, which is how debounce
behaves. And on the idempotency-key page (m) it reported a duplicate in every run (150 of 150): the second POST
really went out, the server dropped it, so the report is right about the network and wrong about the app. With its
lower "possible" tier (`console.debug`) it caught 88% of the stale runs, and false reports on the
correct search fixes rose to 3.8%. With the model skipped, as on devices with 2 GB of memory or
less, it reported nothing in 2,100 runs. (50 seeds per page and network for these; source: section 17 of
docs/runtime/RESULTS.md.)

It reports and changes nothing in observe mode. Costs: about 13 MB downloaded on the first visit (model and WASM
runtime, cached after), a Web Worker holding 190 to 280 MB while the model is loaded, and anonymous diagnostics on by
default except on local hosts (`telemetry: false` turns them off). Try it on the [live demo](https://genclass.dev/#lab)
or read the [full benchmark](https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md).

## How we measured

- One page per fix, 14 in all, small and written for the bench. React 19, TanStack Query 5, SWR 2, RxJS 7, Vue 3.5,
  Svelte 5; production builds.
- A local HTTP/2 server draws each request's latency from a seed, so the request for a given query takes the same
  time on every page. Profiles: fast (20 to 60 ms, in order), jittery (50 to 900 ms, any order), lossy (jittery plus
  5% of requests failing).
- Playwright types a two-word query at 60 to 150 ms per key with a 150 to 1,200 ms pause before the second word, or
  double-clicks with 0 to 150 ms between clicks, using real mouse events.
- 200 seeds per page and network without GenClass (10,400 runs), and 50 per page and network with GenClass observe,
  with and without its model (4,200 runs).
- Wrong final state: results for another query, a stale error, or nothing shown (search); more than one ticket
  (submit).
- Limits: one machine, headless Chromium, synthetic latency. A real network has other shapes, and real users do more
  than type one query or double-click once.

Everything, including the raw results of every run, is in
[bench/fixes](https://github.com/genclass-dev/GenClass-lib/tree/main/bench/fixes); `./bench/fixes/run.sh` reproduces
it.
