# Stack Overflow: answer briefs

Status: notes, nothing posted. Prepared 2026-10-25.

## Read this first: the answers must be written by hand

Stack Overflow bans content made with generative AI: "Generative artificial intelligence (a.k.a. GPT, LLM, generative
AI, genAI) tools may not be used to generate content for Stack Overflow." (https://stackoverflow.com/help/gen-ai-policy)
These notes were prepared with an LLM, so they are briefs: what the asker needs, what the existing answers miss, the
measured numbers you can cite, and the code pattern to write yourself. They are not answers to paste. Write each answer
in your own words and test your own code against the asker's case.

Rules for the answers themselves (https://stackoverflow.com/help/promotion):

- "if you mention your product, website, etc. in your question or answer ... you must disclose your affiliation in your
  post." Put the disclosure before the first mention, for example a first line saying you maintain GenClass and wrote
  the benchmark you cite. Saying "our benchmark" or "I maintain" is the accepted minimum
  (https://meta.stackexchange.com/questions/57497).
- "Always solve the asker's problem." Each answer below must work with no GenClass at all.
- "Don't include links except to support what you've written." Link the benchmark only to support a number you state.
- "If you respond only to questions where the answer can be something you're selling, they'll assume you're just here
  to sell." Answer other questions too, most of them with no mention of GenClass.

GenClass belongs in at most one of these three answers (Q1, below), as one sentence at the end. Q2 and Q3 do not need
it.

## Numbers you can cite (bench/fixes, 200 seeded runs per page and profile)

Network "jittery": 50 to 900 ms per request, answers in any order. User: two-word query at 60 to 150 ms per key,
a 150 to 1,200 ms pause before the second word. Source to link:
https://github.com/genclass-dev/GenClass-lib/blob/main/bench/fixes/RESULTS.md

- No guard: wrong results at the end in 52.5% of runs (105 of 200); 0%
  on a fast in-order server.
- Debounce 300 ms alone: 0% on jittery (the user's typing after the pause outlasted every answer),
  7.5% when one request in ten takes 1.5 to 4 s (15 of 200).
- Ignore flag (c), request id (e): 0% wrong on every profile, all requests still sent.
- Vue `watch` with `onCleanup` (i): 0 wrong in 800 runs over all profiles.
- Double submit, button disabled while pending: 72.5% duplicates on a 20 to 60 ms server,
  2.5% on a 50 to 900 ms server.

## Q1. 70646283: response order of multiple API calls in React (autocomplete)

https://stackoverflow.com/questions/70646283 (reactjs, react-hooks; score 0, 1,089 views, not answered)

**The asker needs:** all three requests go out, and the final result is the last request's response. The interviewer
ruled out cancelling and debouncing. The asker also suspects debounce "will still run into issue if the response
timeout is super long".

**The existing answer misses it:** the only answer suggests debounce, which the question excludes.

**What to write:**
1. Why it happens, in two lines: each `.then` calls `setState` when its response arrives, so the slowest response
   wins, not the latest request.
2. The pattern the interviewer wants, "last request wins": tag each request with a number from a counter kept in a
   ref, and apply a response only if its number is still the latest. Show it in an `onChange` handler and in a
   `useEffect`. Variant: the effect cleanup flag from react.dev ("If your Effect fetches something, the cleanup
   function should either abort the fetch or ignore its result",
   https://react.dev/learn/synchronizing-with-effects#fetching-data).
3. The asker's intuition about debounce is right, with numbers: in the benchmark a 300 ms debounce alone was never
   wrong while every answer came within 900 ms, but once one request in ten took 1.5 to 4 s it ended on the wrong
   results in 7.5% of runs (15 of 200), while the counter was wrong in 0 runs on every
   profile (and sent every request, as asked).
4. Optional, one line: data libraries (TanStack Query, SWR) key results by query, which gives the same guarantee.
5. Optional, last line, with the disclosure placed before it: the benchmark is part of GenClass, a library that
   reports this kind of race in a running app, which in the benchmark reported 70% of the runs
   that ended wrong with false reports on 0 of 1,200 runs of the correct versions (it did flag
   36.7% of the debounced page's runs, which ended right, so do not overstate it). Only if you think
   it helps this asker; the answer is complete without it.

**Code pattern to write yourself:** a `latestId` ref, incremented before each fetch; `if (id === latestId.current)
setResults(data)` in the `.then`. Test it with a fake fetch that resolves after a random delay.

## Q2. 66930089: prevent axios from sending more than one request to an endpoint at the same time

https://stackoverflow.com/questions/66930089 (javascript, reactjs, axios; score 2, 2,379 views, no answers)

**The asker needs:** infinite scroll must not fire a second "load more" while one is running; `if (!isLoading)` does
not stop it; is the interceptor flag reasonable?

**What nobody has said:**
- `isLoading` is React state: the handler reads the value from its render, so scroll events that fire before the next
  render still see `false`. A ref (or a module variable) changes synchronously and closes that window.
- The interceptor has a bug: the response error handler never resets `subsequentDataRequestInProgress`, so after one
  failed request every later request is rejected as a duplicate until reload. Reset it in both handlers (or in a
  `finally` around the call). It also rejects with a string instead of an `Error`.
- A cleaner shape than an interceptor: keep the in-flight promise for that endpoint and return it while it is pending
  (callers share one request), clearing it in `finally`.
- Library route: TanStack Query's infinite query allows "only a single ongoing fetch for an InfiniteQuery"
  (https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries).

**Number you can cite:** the benchmark's double-click page with a button disabled through React state created two
records in 72.5% of double-clicks when the server answered in 20 to 60 ms: a guard that is released when
the request finishes lets the next event through. For "load more" that is the desired behaviour (the next page), which
is why the in-flight promise, not a permanent flag, is the right tool.

**GenClass:** not relevant here; leave it out.

## Q3. 55834500: search with axios, cancel the previous request when a new character is typed (Vue)

https://stackoverflow.com/questions/55834500 (vue.js, axios; score 10, 14,545 views, accepted answer from 2019)

**The existing answers:** both cancel with axios `CancelToken`, which axios now marks as deprecated ("This API is
deprecated and will be removed in the next major release"; since v0.22.0 axios supports `AbortController`). Neither
protects the second request (`/Items/count`), which can come back out of order and show the count of an older query
next to newer results. Neither notes that in the asker's code `.catch` comes before `.then` (after a cancel, `.then`
runs with `undefined`), or that results are appended, so a late response mixes old and new items.

**What to add** (as a new answer, since the accepted one is from 2019):
1. Vue's own tool: the watcher's cleanup runs before the next run of the callback. With `watch(query, async (q, old,
   onCleanup) => ...)`, create an `AbortController`, call `onCleanup(() => controller.abort())`, and pass
   `signal: controller.signal` to both axios calls (`/Items/find` and `/Items/count`). In Vue 3.5+ `onWatcherCleanup`
   does the same if called before the first `await`. Source: https://vuejs.org/guide/essentials/watchers.html#side-effect-cleanup
2. Replace, do not append, on a new query; append only in `showMore`.
3. Put `.then` before `.catch`, and ignore `axios.isCancel(e)` / `CanceledError` in the catch.
4. Number: the benchmark's Vue page (`watch` with `onCleanup`) was right in every run (0 wrong in 800 runs over all profiles), against
   52.5% wrong for a page with no guard on the same network.

**GenClass:** not needed; leave it out.

## Also worth answering (no GenClass)

TanStack Query discussion #10041, "How best to prevent double button clicks and duplicate / parallel mutations"
(https://github.com/TanStack/query/discussions/10041, January 2026, no accepted answer). Not Stack Overflow, but the
same rules of thumb apply (disclose if you mention your project). What the benchmark adds to that thread: with
`disabled={mutation.isPending}`, 43.5% of double-clicks created two records on a 20 to 60 ms server and
4% on a 50 to 900 ms server; the duplicates on the slower server came from clicks about 3 ms apart, before `isPending` had disabled the button,
while a button disabled through React state had none of those. A server-side idempotency key was the only fix with 0
duplicates on every profile. Link the page's code (`bench/fixes/src/n-mutation.tsx`) so the maintainers can check it.
