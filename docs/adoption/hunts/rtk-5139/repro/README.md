# Reproduction: redux-toolkit#5139

An optimistic update written by `api.util.updateQueryData` in a mutation's `onQueryStarted` is replaced when a
polling (`pollingInterval`) or refetch-on-focus fetch of the same cache entry fulfills while the mutation is still
pending. Issue: https://github.com/reduxjs/redux-toolkit/issues/5139

`@reduxjs/toolkit` 2.13.0, `react-redux` 9.3.0, React 19, Vite 8. The backend is an in-memory Map mounted into the
Vite dev server (`server/api.ts`, 34 lines): `GET /api/items` answers at once, `PUT /api/items/:id` takes
2000 ms.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Or open it on StackBlitz:
https://stackblitz.com/github/genclass-dev/GenClass-lib/tree/main/docs/adoption/hunts/rtk-5139/repro

Or copy just this folder: `npx degit genclass-dev/GenClass-lib/docs/adoption/hunts/rtk-5139/repro rtk-5139`.

Press **Rename item 1**. The name changes to `Edited 1` at once (the optimistic update), goes back to `Original`
within about 100 ms (the next poll's `executeQuery/fulfilled`), and shows `Edited 1` again after the PUT returns and
`invalidatesTags` refetches. The page lists the RTK Query actions that can change that cache entry
(`executeQuery/*`, `executeMutation/*`, `queryResultPatched`, `__rtkq/*`) since the click, with item 1's cached name
after each one and the changed rows highlighted.

| page | query options | what you see |
|---|---|---|
| `/?variant=polling` (default) | `pollingInterval: 100` | `Edited 1` → `Original` → `Edited 1` |
| `/?variant=focus` | `refetchOnFocus: true`, `setupListeners(store.dispatch)` | the same once the window gets focus back while the PUT is pending (switch tabs and back, or press **Simulate refocus**, which dispatches the window `focus` event) |
| `/?variant=none` | neither (control) | `Edited 1` stays until the PUT returns |

## Tests

```bash
npm test                                         # Redux-only vitest, no DOM (test/optimisticUpdates.pending.test.ts)
npx playwright install chromium && npm run test:e2e   # Playwright against the dev server (e2e/rtk-5139.spec.ts)
```

Both assert that once the optimistic value is shown it stays while the mutation is pending. On 2.13.0 the polling
and focus tests fail and the controls pass. The vitest file uses the endpoints, `baseQuery` mock and `storeRef` of
`packages/toolkit/src/query/tests/optimisticUpdates.test.tsx`, so its last `describe` can be pasted into that file
once it also imports `setupListeners` from `@reduxjs/toolkit/query`.

`../workaround.patch` is a userland workaround (re-run the optimistic recipes of in-flight mutations after each
fulfilled `getItems` fetch). With it applied (`patch -p1 < ../workaround.patch`; undo with `patch -R -p1 <
../workaround.patch`) both suites pass.

## Files

| file | |
|---|---|
| `src/api.ts` | `createApi`: `getItems` (query), `renameItem` (mutation with the documented optimistic-update recipe and `invalidatesTags`) |
| `src/store.ts` | `configureStore`, `setupListeners`, and a small action logger for the on-page log |
| `src/App.tsx` | the three variants, the button, the log |
| `server/api.ts` | the backend |
