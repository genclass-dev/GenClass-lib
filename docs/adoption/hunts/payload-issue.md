# Draft issue and PR text for Payload's maintainers

Drafts the owner can send. Factual, reproduction without GenClass, one sentence on how it was found. Not sent by the
session that wrote it (see payload.md).

## Issue

**Title:** List view requests the same relationship documents again while their first request is still pending

**Describe the bug**

In the list view, relationship cells load the documents they show in batches, one request per collection
(`GET /api/<slug>?depth=0&draft=true&limit=250&where[id][in]=...`), through `RelationshipProvider`
(`packages/ui/src/elements/Table/RelationshipProvider/index.tsx`). A requested id is stored as `null` until its
response arrives, and `loadRelationshipDocs` requests every id that is still `null`. The loader runs again on every
change of that state (debounced 100 ms): when another collection's batch comes back, or when more cells mount. So
while one batch is slow, each of those changes requests the pending ids again.

On a list with two relationship columns (say `category` and `author`), a slow `categories` batch is requested a second
time as soon as the `users` batch lands; after a search or sort, when new rows request their ids while an earlier
batch is still pending, the earlier ids are included again. Each repeated request is a full `where[id][in]` query over
every pending id of that collection (10 in the reproduction below; a relationship cell asks for at most 3 ids,
`totalToShow` in `DefaultCell/fields/Relationship/index.tsx`, and `limit=250` only caps the documents returned). The
documents shown are correct in the end (every response carries the same data), so this is a redundant-request bug, not
a wrong-display bug.

**To Reproduce**

1. A collection whose list columns relate to two collections (for example `posts` with `category` relating to
   `categories` and `author` relating to `users`, or one polymorphic relationship column), a few documents.
2. Delay only one collection's batch by about 1 s, for example with a hook on `categories`: `hooks: { beforeOperation:
   [async ({ operation }) => { if (operation === 'read') await new Promise((r) => setTimeout(r, 1000)) }] }` (or a
   proxy, or a Playwright route). A uniform throttle such as DevTools "Slow 4G" delays both batches alike, so they
   land within the provider's 100 ms debounce of each other and the repeat does not appear.
3. Open the list view. In the Network panel, filter on `limit=250` (the key is sent encoded, `where%5Bid%5D%5Bin%5D`):
   `/api/categories` is requested twice with the same ids, the second time right after `/api/users` answered. Type
   into the search box while a batch is still pending: the new rows' batch includes the pending ids again.

The regression test in the PR below reproduces it with plain Playwright: it holds one collection's batch until the
other has answered, and asserts that no `<slug>:<id>` pair is requested twice.

**Expected behaviour**

No relationship document is requested again while an earlier request for it is still pending (a locale change still
reloads everything, as the `reloadAll` path intends).

Separately, and not changed by the PR below: `REQUEST` in `reducer.ts` sets a document back to `null` whenever a newly
mounted cell asks for it, even when it is already loaded, so after a search, sort or page change the new rows' batch
also fetches loaded documents again. That may be intended (fresh titles after an edit), so it is only mentioned here.
Also in `reducer.ts`, line 30: `unreturnedIDs.splice(unreturnedIDs.indexOf(doc.id), 1)` compares a numeric `doc.id`
(SQLite, Postgres) with string ids, so `indexOf` is `-1` and the last id is removed instead; when some documents are
not returned, the wrong ids are marked `false` (read from the code, not reproduced).

**Environment**

- payload, `@payloadcms/ui`, `@payloadcms/next`, `@payloadcms/db-sqlite` 3.92.0 (`v3.92.0`, `e6f7db8`); the same
  code path is on `main` at `aebbf75` (`loadRelationshipDocs` still requests every `null` id)
- next 16.3.3, react 19.2.6, Node 22, Chromium 153

**How it was found**

Found while running the admin panel under [GenClass](https://github.com/genclass-dev/GenClass-lib), which re-runs the
same user steps with responses delivered in different orders and compares the final state: the page ended identical
every time, but the number of relationship batch requests depended on the delivery order: between 2 and 5 per
collection for the same steps, different from the request-order runs in 33 of 36 reordered runs of the search and sort
scenarios, and in none of the 18 reordered runs on the fixed build (where the tool still flagged 9 of 18 runs, all on
unrelated state-discovery noise and Next dev-overlay witnesses).

## PR

**Title:** fix(ui): do not re-request relationship documents whose batch is still pending

**What**

`RelationshipProvider` keeps the ids whose request is in flight, per collection, in a ref (a `Map` from id to the batch
that requested it), and leaves them out of the next batch. A batch marks its ids before `fetch` and, when it is over,
releases the ids it still owns: a later batch (a locale change) may have taken one over. A request that throws (a
network error) is logged with `console.error` and its ids are released, so the next change requests them again; an
error response still marks them `false`, as before. The loader also checks the latest `documents` (a ref kept current
by an effect declared before the loader's), because for one run after a response has been applied the debounced copy
can still show its ids as `null` when they are no longer in flight. `reloadAll` (a locale change) still requests
everything.

The code avoids `??=` and a `try` without `catch`: `babel-plugin-react-compiler` 19.1.0-rc.3, which the package build
runs, bails out on both and would emit the component without memoization. Run through the package's SWC and Babel
steps, the file compiles with a `_c(19)` memo cache (v3.92.0: `_c(15)`).

**Why**

`loadRelationshipDocs` requests every id whose value is `null`, and runs again on every change of `documents`
(debounced 100 ms). An id stays `null` from its request until its response, so each change in that window requests it
again: another collection's batch landing, new rows mounting after a search or a sort. Whenever one collection's batch
answers more than 100 ms after another's (a slow query, a slower collection, an uneven network), this is one extra
`where[id][in]` request per pending batch per change.

**Test**

A new test in `test/fields/collections/Relationship/e2e.spec.ts`, `should not request related documents again while
their batch is pending`, placed before the first list-filter test: it adds a row related to an `array-fields` document
so the list view loads two batches, holds the first batch on a promise (the pattern of the Tabs spec), waits for the
other batch's response and 500 ms more for the provider's debounced loader, releases the held batch, waits for its
response, and asserts that no `<slug>:<id>` pair was requested twice. Waiting for the other batch's response means the
window is exercised on every run. In the `fields` suite (MongoDB), on v3.92.0 it fails 3 of 3 runs (`Expected length: 3,
Received length: 4`: the held `array-fields` id is requested again after the `text-fields` batch lands) and passes 3
of 3 with the fix. Prettier passes, and ESLint reports nothing in the added lines.

It sits before the list-filter tests because `should not duplicate relationship filter options when switching
operators` leaves a relationship filter open on the shared page, and its lookup fails after the next test's
`reInitializeDB`, so whichever test runs next can fail on the console error "There was a problem loading the document
with ID of ..." (pre-existing, on both codes).

**Checklist**

- [ ] I have read and understand the CONTRIBUTING document
- [ ] Existing test suite passes locally with my changes
- [ ] Tests have been added for the change (the e2e above)
