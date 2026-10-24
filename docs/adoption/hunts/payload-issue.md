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
time as soon as the `users` batch lands; after a search or sort, when new rows request their ids while an earlier batch
is still pending, the earlier ids are included again. With 250 ids per batch the repeated requests are not small. The
documents shown are correct in the end (every response carries the same data), so this is a redundant-request bug, not
a wrong-display bug; on a slow connection or a loaded server it adds a query per batch per change.

**To Reproduce**

1. A collection with two relationship fields in its list columns (for example `posts` with `category` relating to
   `categories` and `author` relating to `users`), a few hundred documents.
2. Open the collection's list view with the network throttled (DevTools, "Slow 4G"), or add about 1 s of latency to
   `/api/categories` only.
3. In the Network panel, filter on `where[id][in]`: `/api/categories` is requested twice with the same ids (the second
   time right after `/api/users` answered). Type into the search box: the new rows' batch again includes any id whose
   first request has not answered yet.

A Playwright reproduction without any extra tooling is below (it is the regression test of the PR): it delays one
collection's batch by 1.5 s and asserts that no `<slug>:<id>` pair is requested twice.

**Expected behaviour**

Each relationship document is requested once per list view load (and once more after a locale change, as the
`reloadAll` path intends).

**Environment**

- payload, `@payloadcms/ui`, `@payloadcms/next`, `@payloadcms/db-sqlite` 3.92.0
- next 16.3.3, react 19.2.6, Node 22, Chromium 153 (Playwright 1.63)

**How it was found**

Found while running the admin panel under [GenClass](https://github.com/genclass-dev/GenClass-lib), which re-runs the
same user steps with responses delivered in different orders and compares the final state: the page ended identical
every time, but the number of relationship batch requests depended on the delivery order (2 in request order, 3 to 5
reordered, in 22 of 24 reordered runs of the search and sort scenarios).

## PR

**Title:** fix(ui): do not re-request relationship documents whose batch is still pending

**What**

`RelationshipProvider` keeps the ids whose request is in flight (a `Set` per collection in a ref) and leaves them out
of the next batch. The ids are added before `fetch` and removed in a `finally`, so a failed request lets them be
requested again on the next change. `reloadAll` (a locale change) still requests everything.

**Why**

`loadRelationshipDocs` requests every id whose value is `null`, and runs again on every change of `documents`
(debounced 100 ms). An id stays `null` from its request until its response, so each change in that window requests it
again: another collection's batch landing, new rows mounting after a search or a sort. On a slow connection this is one
extra `where[id][in]` request per pending batch per change.

**Test**

`test/fields/collections/Relationship/relationshipCells.e2e.spec.ts` (new): loads the list view with the first
collection's batch delayed by 1.5 s and asserts that every `<slug>:<id>` pair appears in exactly one request. The same
assertion against a 3.92.0 app (two relationship columns, `categories` delayed by 1.5 s): as published, 3 batch
requests and 10 ids requested twice, three runs out of three; with the fix, 2 requests and no repeated id, three out of
three. The helper imports follow the `test/fields` suite's layout; the slug is `relationshipFieldsSlug`.

**Checklist**

- [ ] I have read and understand the CONTRIBUTING document
- [ ] Existing test suite passes locally with my changes
- [ ] Tests have been added for the change (the e2e above)
