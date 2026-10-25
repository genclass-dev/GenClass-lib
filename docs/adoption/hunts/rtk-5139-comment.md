# Draft comment for reduxjs/redux-toolkit#5139

For the owner to post (not posted). Before posting:

- The links assume `docs/adoption/hunts/rtk-5139/` and `rtk-5139.md` are on genclass-dev/GenClass-lib `main` and the
  repository is public; adjust them if they land elsewhere.
- Open the StackBlitz link once and drop that line if the project does not boot (it was not tested: Vite 8 inside
  StackBlitz's WebContainers).

Everything in it is measured in [rtk-5139.md](rtk-5139.md).

---

Here is a runnable reproduction, and the sequence of events and state changes asked for above.

**Repro** (Vite + React + TS, `@reduxjs/toolkit` 2.13.0, backend is an in-memory Map inside the Vite dev server, so
`npm install && npm run dev` is the whole setup):
https://github.com/genclass-dev/GenClass-lib/tree/main/docs/adoption/hunts/rtk-5139/repro
(StackBlitz: https://stackblitz.com/github/genclass-dev/GenClass-lib/tree/main/docs/adoption/hunts/rtk-5139/repro)

`GET /api/items` answers at once, `PUT /api/items/:id` takes 2 s. The mutation is the docs' optimistic-update recipe
(`updateQueryData` in `onQueryStarted`, `undo` on failure) plus `invalidatesTags`. Three pages: `pollingInterval: 100`,
`refetchOnFocus: true` with `setupListeners`, and a control with neither.

**Sequence** with polling (ms after the click; item 1's cached name after each action):

```
    +1  api/executeMutation/pending     renameItem   "Original"
    +4  api/queries/queryResultPatched  getItems     "Edited 1"   optimistic update
   +64  api/executeQuery/pending        getItems     next poll (forceRefetch: true, subscribe: false)
   +76  api/executeQuery/fulfilled      getItems     "Original"   optimistic update replaced, PUT still pending
        ... 15 more polls fulfilled with "Original" ...
 +2038  api/executeMutation/fulfilled   renameItem   "Original"   tag invalidation waits: a poll is pending
 +2059  api/executeQuery/fulfilled      getItems     "Edited 1"   that poll
 +2060  api/executeQuery/pending        getItems     invalidatesTags refetch
 +2086  api/executeQuery/fulfilled      getItems     "Edited 1"
```

With `refetchOnFocus` it is the same at the focus: `__rtkq/focused` (+328), `executeQuery/pending`,
`executeQuery/fulfilled` with "Original" (+347) while the PUT is pending, and "Edited 1" back from the
`invalidatesTags` refetch after the PUT (+2045). The control keeps "Edited 1" throughout.

**Why**, as far as I can read 2.13.0: polling and focus both go through `refetchQuery`
(`initiate(originalArgs, { subscribe: false, forceRefetch: true })`), and `writeFulfilledCacheEntry` replaces `data`
with the payload (or hands it to the endpoint's `merge`) whenever the `requestId` is current. The patches from
`updateQueryData` are applied by `queryResultPatched` and then kept nowhere in the store or the middleware, and
nothing ties them to the pending mutation, so RTK has nothing to re-apply. Two shapes hit this: a fetch already in
flight when the patch is applied (#5103 / discussion #5105) and a fetch started after it while the mutation is pending
(this issue).

**Tests** that fail on 2.13.0 (the controls pass):

- Redux-only vitest using the `post` / `updatePost` endpoints, `baseQuery` mock and `storeRef` shape of
  `optimisticUpdates.test.tsx`; its last `describe` can be pasted there once that file also imports `setupListeners`
  from `@reduxjs/toolkit/query`:
  https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139/repro/test/optimisticUpdates.pending.test.ts
- Playwright against the repro (the name shown in the DOM while the PUT is pending):
  https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139/repro/e2e/rtk-5139.spec.ts

With `--repeat-each=10` the Playwright polling and focus tests failed 10 of 10 and the control passed 10 of 10; the
vitest gave 2 failed, 1 passed on each of 10 runs.

On the "what should happen" question: re-running the recipes of in-flight mutations after each fulfilled fetch of the
entry (a small userland middleware, roughly the reporter's suggestion) makes both suites pass every time without
dropping fresh data. The patch against the repro and the test, and the trade-offs of the alternatives:
https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139/workaround.patch and
https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139.md#fix-directions-no-pr

(The actions and values above are the Redux action log; the request timing behind the notes was recorded with
GenClass, which logs requests next to store writes.)
