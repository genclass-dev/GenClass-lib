# Draft comment for reduxjs/redux-toolkit#5139

For the owner to post (not posted). The links assume `docs/adoption/hunts/rtk-5139/` is on genclass-dev/GenClass-lib
`main`; adjust them if it lands elsewhere. Everything in it is measured in [rtk-5139.md](rtk-5139.md).

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
   +64  api/executeQuery/pending        getItems     next poll (forceRefetch: true, subscribe: false), sent at +69
   +76  api/executeQuery/fulfilled      getItems     "Original"   optimistic update replaced, PUT still pending
        ... 15 more polls fulfilled with "Original" ...
 +2038  api/executeMutation/fulfilled   renameItem   "Original"   tag invalidation waits for an in-flight poll
 +2059  api/executeQuery/fulfilled      getItems     "Edited 1"   that poll, answered after the PUT
 +2060  api/executeQuery/pending        getItems     invalidatesTags refetch
 +2086  api/executeQuery/fulfilled      getItems     "Edited 1"
```

With `refetchOnFocus` it is the same at the focus: `__rtkq/focused` (+328), `executeQuery/pending`,
`executeQuery/fulfilled` with "Original" (+347) while the PUT is pending, and "Edited 1" back from the
`invalidatesTags` refetch after the PUT (+2045). The control keeps "Edited 1" throughout.

**Why**, as far as I can read 2.13.0: polling and focus both go through `refetchQuery`
(`initiate(originalArgs, { subscribe: false, forceRefetch: true })`), and `writeFulfilledCacheEntry` replaces `data`
with the payload whenever the `requestId` is current. The patch from `updateQueryData` is recorded only in the
`PatchCollection` returned to the caller, so nothing can re-apply it. Two shapes hit this: a fetch already in flight
when the patch is applied (#5103 / discussion #5105) and a fetch started after it while the mutation is pending (this
issue).

**Tests** that fail on 2.13.0 (the controls pass):

- Redux-only vitest using the `post` / `updatePost` endpoints, `baseQuery` mock and `storeRef` shape of
  `optimisticUpdates.test.tsx`, so it can be pasted there:
  https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139/repro/test/optimisticUpdates.pending.test.ts
- Playwright against the repro (the name shown in the DOM while the PUT is pending):
  https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139/repro/e2e/rtk-5139.spec.ts

Polling and focus failed 10 of 10 runs each; the controls passed 10 of 10.

On the "what should happen" question: re-running the recipes of in-flight mutations after each fulfilled fetch of the
entry (a small userland middleware, roughly the reporter's suggestion) makes both tests pass, so that behaviour is
reachable without dropping fresh data. Sketch and trade-offs of the alternatives:
https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/rtk-5139.md#fix-directions-no-pr

(The timing was recorded with GenClass, which logs requests next to store writes; the action log above is all it
needs.)
