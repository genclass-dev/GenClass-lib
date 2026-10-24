# Race hunt: Payload admin panel (payload 3.92.0)

An evidence-backed contribution prepared for Payload's maintainers, from a GenClass race hunt against the admin panel
of a fresh Payload app. Nothing was sent to Payload: the draft issue and PR text are in [payload-issue.md](payload-issue.md), the fix and its
regression test in [payload.patch](payload.patch), and the harness that produced every number below in
[payload-hunt/](payload-hunt/). Run on 2026-10-24 in a cloud session, about 3 h 40 min in all (section 10).

## 1. Headline

- **No stale-state race.** In every scenario, the page's final state (visible rows, form values, the stored draft, the
  versions created) was the same in the reordered runs as in the two request-order baselines: 144 of 144 reordered
  runs (24 sessions, 8 scenarios, three latencies) by the harness's own DOM and REST comparison (sections 4 and 5).
  Payload's own code prevents the classic races: one queue per autosave and per relationship field (`useQueue` runs
  one request at a time and discards the backlog), an abort controller per form-state refresh, a merge that keeps the
  local value of every modified field, and submit buttons disabled while a submit is processing (section 7). Two
  transient, self-repairing effects were recorded on the edit view under 900 ms of latency (section 5).
- **One timing-dependent bug, with a fix.** The list view's relationship cells load their documents in batches
  (`RelationshipProvider`), and a batch whose response is still pending is requested again on every change of the
  provider's state meanwhile: another collection's batch landing, new rows mounting after a search or a sort. The
  number of `GET /api/<slug>?where[id][in]=...` requests for the same page and actions depended on response timing in
  33 of 36 reordered runs of the list scenarios (2 to 5 requests for 2 batches), and the baselines themselves varied
  between sessions. The data shown is correct (every response carries the same documents): a redundant-request bug,
  not a wrong-display bug. Root cause in section 6, fix in section 7, the fixed variant's check in section 8.
- **GenClass problems met on the way** (section 9): Chromium 153's Local Network Access check blocks the bridge from
  a Playwright-fulfilled document; `whenSettled` resolves while an 800 ms debounce is pending on this app; the explore
  verdict reports state-discovery noise as races on the edit view (clock minutes in page text, stores beyond the
  300-field cap, stores that exist only when a component changed state), 72 `RACE` verdicts over 108 reordered
  edit-view runs whose form, stored document and versions were identical, next to the 33 of 36 right ones on the list
  views; an app's own follow-up request to the same endpoint is keyed as a GenClass `~hedge`; and typing into a
  react-select combobox is not recorded as a typing action.

## 2. What was run

| what | version |
|---|---|
| payload, `@payloadcms/ui`, `@payloadcms/next`, `@payloadcms/db-sqlite`, `@payloadcms/richtext-lexical` | 3.92.0 (npm; the tag is `v3.92.0`; the commit SHA was not resolved because this session's repository access is scoped to GenClass-lib, so the file paths below are quoted from the published package's source maps, which carry the TSX of that release) |
| next / react / react-dom | 16.3.3 (Turbopack dev server) / 19.2.6 / 19.2.6 |
| create-payload-app | 3.92.0, `-t blank --db sqlite`, `npm install` (743 packages) |
| `@genclass/runtime` / `@genclass/mcp` | 0.3.0-beta.1 / 0.1.0, built from GenClass-lib `d77ffd8` (main) |
| Node / Chromium / Playwright | 22.22.0 / 153.0.8010.12 (headless) / 1.63.0 |

The app (`/home/user/payload-hunt/app`, not committed) is the blank template plus four collection configs, a normal
integration and nothing tuned to GenClass ([payload-hunt/collections/](payload-hunt/collections/)):

- `posts`: `title` (text), `summary` (textarea), `category` (relationship to `categories`), `author` (relationship to
  `users`), `views` (number); `versions.drafts.autosave: true` (the default 800 ms interval); list columns title,
  category, author, views, updatedAt. Seeded with 300 published documents whose titles are two words and a number
  (`react 278 tango`), so a typed prefix narrows the list step by step (70 match `react`).
- `categories`: `name`; 20 documents. No versions (one Save button).
- `pages`: `title`, `body`; `versions.drafts: true` without autosave (Save Draft and Publish buttons); 3 documents.
- `users`: the template's auth collection; one user.

Commands, in order (the harness files are in [payload-hunt/](payload-hunt/)):

```bash
# GenClass
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Payload
npx -y create-payload-app@latest -n app -t blank --db sqlite --db-connection-string "file:./payload.db" --no-agent --use-npm --no-deps
cd app && npm install && (PORT=3000 npm run dev &)       # Next 16.3.3, Turbopack
node seed.mjs                                            # first user over /api/users/first-register, 20 categories, 300 posts over REST
# the hunt (one explore session: a warm-up load, 2 baselines + 6 seeded loads, the report, explain for each race)
node hunt.mjs probe                                      # injection check
node hunt.mjs explore <scenario> <slow_ms> 6             # scenario: search filtersort relsearch autosave autosave2 dblpublish dblsave dbldraft
node hunt.mjs replay <scenario> <finding-id>
node dup-requests.spec.mjs                               # the GenClass-free reproduction of the finding (exit 1 while the bug is there)
```

### 2.1 Injection without touching Payload

Payload's source is not modified. The harness (`hunt.mjs`) runs the MCP server in-process (`serve()` from
`@genclass/mcp`, driven over JSON-RPC `tools/call` exactly as a coding agent drives it) and, in Playwright:

- routes `/__genclass/*` on the app's origin to `packages/runtime/dist/` (and `/__genclass/__connect.js` to two lines
  that import `./agent.js` and call `connectAgent(window.GenClass.runtime)`);
- routes every `/admin` document through `route.fetch()` and inserts, first in `<head>`, the script tag
  `<script src="/__genclass/genclass.global.js" data-base="/__genclass/" data-mode="observe" data-model="off" data-telemetry="off" data-report="silent" data-devtools="off" data-visual="off">`
  followed by `<script type="module" src="/__genclass/__connect.js">`. The classic tag runs before Next's own (async)
  scripts, so the React state discovery hook is installed before react-dom evaluates;
- `addInitScript` sets `window.__GENCLASS_AGENT_URL__` to the bridge and `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, report: "silent", devtools: false, visual: false, analytics: false }`;
  the model is never loaded (status `{"state":"off"}`), telemetry is off, nothing is downloaded;
- logs in once through the admin login form and reuses `storageState`; `bypassCSP: true`.

Every page load is a new browser context, so each explore slot is one document. Client-side navigations (the list
view's search is a Next router `replace`, an RSC fetch) stay inside the same page load and the same run.

`genclass_status` after the probe: `1 active page(s)`, `schedule natural`, `model off, mode observe`, `settled`.
State discovery sees the admin's React state: 300 fields in the snapshot (the cap), among them Payload's own stores
(`searchFilterInput.state0` is the typed search, `headingSelect.state0.categories.<id>` the relationship provider's
documents, `formReady.state8.updatedAt.value` a form field, `fieldCategory_2.state8` the relationship field's options),
next to Next's dev overlay (`m.state0.*`, `nextBadgeRoot.*`, about 40 fields) and minified third-party components
(`r6`, `$1`, `X1`, `Eo`, `V5`: pre-compiled code keeps no names). Hooks from `useReducer` are seen as writes with the
request that caused them (`write headingSelect.state0.categories.11 by GET /api/categories#1`).

## 3. Scenarios

Each scenario is one page load per run, repeated 8 times per explore session (2 fifo baselines, 6 seeded orders) at
`slow_ms` 300, 600 and 900 (each response also waits a seeded 0 to `slow_ms` ms, baselines included). A warm-up load
before each session lets Turbopack compile the route (a first load slow enough that keystrokes typed into the
controlled search input were lost to hydration changed the scenario; the warm-up is unarmed and takes no slot). Before
acting, the harness waits for the bridge's hello and a quiet point.

| id | scenario | actions | my own oracle (next to the explore verdict) |
|---|---|---|---|
| (a) `search` | list view, 300 posts | type `react` into the search box at 90 ms a key | URL, search value, result count, the 10 visible rows |
| (b) `filtersort` | list view | sort by title ascending, 120 ms later sort by views descending, 120 ms later type `echo` at 60 ms a key | the same |
| (c) `relsearch` | edit view of post 1, `category` relationship | click the field's combobox, type `Category r` at 90 ms a key | the options shown |
| (d) `autosave` | edit view of post 2 (autosave 800 ms) | click the title, 4 bursts of typing (` one`, ` two`, ...) at 80 ms a key with 1.5 s pauses, then stop | the title field, the stored draft (`GET /api/posts/2?draft=true`), the versions list |
| (d2) `autosave2` | edit view of post 4 | 5 bursts with 2.6 s pauses, so each burst's autosave response (and the form-state refresh after it) lands while the next burst is typed | the same |
| (e) `dblpublish` | edit view of post 3 | edit the title, let its autosave land, double-click Publish changes | versions created, stored title and status, the field |
| (e) `dblsave` | edit view of a category (no versions) | edit the name, double-click Save | stored name and `updatedAt`, the field |
| (e) `dbldraft` | edit view of a page (drafts, no autosave) | edit the title, double-click Save Draft | versions created, stored draft, the field |

Hard rule 1 holds: mode `observe`, no model, the agent link's holds only (each response at most its seeded delay plus
`maxHoldMs`, never changed); the app is never made worse by the runtime, only slower in the way a bad network is.

## 4. Verdicts: list views (search, filter and sort)

| session | explore verdict (as reported) | what differed | DOM oracle (rows, count, URL, search) |
|---|---|---|---|
| search 300 | RACE 6 of 6 | `GET /api/users` 4 (baseline) vs 2 or 3; `GET /api/categories` 2 vs 3; Next dev overlay fields (`m.state0.errors` 0 items vs absent) | 6 of 6 same as the baselines |
| search 600 | RACE 5 of 6 | `GET /api/categories` 2 vs 3 or 4; `GET /api/users` 2 vs 3 | 6 of 6 same |
| search 900 | RACE 6 of 6 | `GET /api/categories` 2 vs 3; `GET /api/users` 3 vs 2 | 6 of 6 same |
| filtersort 300 | RACE 6 of 6 | `GET /api/categories` 3 vs 4 or 5; `GET /api/users` 5 vs 3 or 4; dev overlay fields | 6 of 6 same |
| filtersort 600 | RACE 6 of 6 | `GET /api/categories` 3 vs 4 or 5; `GET /api/users` 3 vs 5 | 6 of 6 same |
| filtersort 900 | RACE 4 of 6 | `GET /api/users` 4 vs 3 or 5 | 6 of 6 same |

Every one of the 36 reordered runs ended with the same 10 rows, the same `1-10 of 70` (search) and the same URL as the
baselines, with the typed value in the search box. The search itself never raced: the list is server-rendered by a
Next router `replace` (one RSC fetch per debounced change, 300 ms), and no run showed rows for an older query. What
differed, in 33 of the 36, is the number of relationship batch requests (`GET /api/categories?...where[id][in]=...`,
`GET /api/users?...`): 2 batches of ids are needed (the first rows, then the rows for the typed query), and between 2
and 5 requests per collection were sent. The baselines were not stable across sessions either (users: 4, 2 and 3 in the
three search sessions), which is the same effect under the uniform extra latency. Section 6 has the cause.

The witnesses recorded along the way (`overwrote-newer nextBadgeRoot.state5.phase by GET /admin/collections/posts`,
`overwrote-newer r1.state1 by GET /api/categories`, `Mte.state0`) are Next's dev overlay and a progress indicator
being written by a response's chain after a timer: facts about the dev tooling, not about Payload.

## 5. Verdicts: edit views

18 sessions, 108 reordered runs. The oracle compares the form field, the stored document over REST (`?draft=true`
where drafts apply), the number of versions created, the status line, the autosave line (minutes blanked) and the
toasts; `options` for the relationship search.

| session (slow_ms) | explore verdict | what explore saw differ | oracle | requests per run |
|---|---|---|---|---|
| relsearch 300 / 600 / 900 | RACE 2 of 6 / no race / no race | `fieldAuthor.state3..8`, `Mte.state0`, `V5.state0.*` present in one run, absent in another | 18 of 18 same options | 3 option searches |
| autosave 300 / 600 / 900 (1.5 s pauses) | RACE 5 / 6 / 6 of 6 | `ax.state0` (a formatted time: `7:27 PM` vs `7:28 PM`), `V5.state0.*`, `reactSelect….focusedOption` present vs absent | 18 of 18: stored draft = typed text, one autosave, versions +1 | 1 autosave (the form-state merge restarts the 800 ms debounce, so a burst's autosave waits for the next pause), 5 form-state actions |
| autosave2 300 / 600 / 900 (2.6 s pauses) | RACE 1 / 6 / 6 of 6 | 300 and 600: the time text and absent stores; 900: `formReady.state7` (the form's `modified` flag) `false` in the baselines, `true` in 6 of 6 seeded runs; form-state actions 9 vs 8 or 10; autosaves 5 vs 4 in two runs | 18 of 18: stored draft = typed text (` one two three four five`), status `Changed`, `Last saved less than a minute ago` | 5 autosaves (4 when `useQueue` dropped a backlog), 10 form-state actions |
| dblpublish 300 / 600 / 900 | RACE 4 / 4 / 5 of 6 | the time text; dev overlay fields | 18 of 18: one publish request, versions +2 (the edit's autosave and the publish), stored title published | 1 `PATCH /api/posts/3?depth=0` |
| dblsave 300 / 600 / 900 (categories, no versions) | RACE 6 / 4 / 6 of 6 | the time text (`8:11 PM` vs `8:12 PM`, once `Loading...`), `formReady.state5` | 18 of 18: one save, stored name = field | 1 `PATCH /api/categories/:id` |
| dbldraft 300 / 600 / 900 (pages, drafts, no autosave) | RACE 4 / 2 / 5 of 6 | the time text, `X1.state1..2` (the auth token and its expiry), dev overlay fields | 18 of 18: one draft save, versions +1, stored draft = field | 1 `PATCH /api/pages/:id?draft=true` |

Every reordered run ended as its baselines did by the oracle: 108 of 108. The 72 `RACE` verdicts are all on
discovered-store fields or on a page line that holds a formatted clock time, never on a form value, the stored
document, the versions or a request count that mattered (section 9, problem 3, says why and what to change).

Two things the reordered edit runs did show, both repaired within the run:

- **The document title in the header reverts for one keystroke.** In `autosave2` at 900 ms, the witness
  `overwrote-newer docId.state0 by PATCH /api/posts/:id` appeared in 5 of 6 seeded runs and in both baselines: the
  autosave response for `… three four` landed while ` five` was being typed and wrote the header title (`docId.state0`,
  also the step-nav label `NC.state0`) back from `… three four f` to `… three four`; the next keystroke rewrote it from
  the form value (`+15.067s` and `+15.090s` in the recorded steps). The field itself was never touched: the merge keeps
  modified fields (section 7). A user who stops typing exactly as an older autosave lands sees the previous title in
  the header until the next autosave; the final text was right in every run.
- **The form stays `modified` after the last autosave** when a burst was typed while an autosave was in flight
  (`modifiedWhileProcessingRef` in `forms/Form/index.tsx`, intended: a change during a save must survive the save's
  `setModified(false)`), in 6 of 6 seeded runs at 900 ms and none of the baselines, with everything saved. For an
  autosave collection nothing visible depends on it (the leave prompt is off, Publish is enabled by the draft anyway),
  so it was not pursued; it is the one order-dependent state difference on the edit views that is not noise.

The relationship search did not test what it meant to: with the text typed at 90 ms a key, the field's debounced
search went out for the first two characters only (`where[and][1][name][like]=Ca`, the same in a plain Playwright run
without GenClass) and the menu kept the unfiltered first page, so the comparison is of that state. GenClass recorded
the click on the combobox but not the typing into it (the react-select input), which is a recorder gap (section 9).

## 6. The finding: relationship batches requested again while pending

### 6.1 Evidence, in causal order

`genclass_explain f6` (session search 600, run r37, seeded order 1, the recorded delivery order; times from
`connectAgent`; the full output is in [payload-hunt/out/explain-f6.txt](payload-hunt/out/explain-f6.txt)):

```
+1.069s write headingSelect.state1.categories.11 ... users.1          the 10 first rows' cells request their ids (REQUEST → null)
+1.070s send GET /api/categories#1 "?depth=0&draft=true&limit=250&where[id][in]=11,12,13,14,15,…"
+1.072s send GET /api/users#1      "?depth=0&draft=true&limit=250&where[id][in]=1"
+1.388s delivered GET /api/users#1 (held 274 ms)
+1.418s delivered GET /api/categories#1 (held 317 ms)
+2.122s action 0: type input "Search by Title" = "react" (5 keystrokes over 383 ms)
+2.834s send GET /admin/collections/posts#1 "?depth=1&limit=10&search=react&page=1&_rsc=…"      the debounced search: one RSC navigation
+3.457s delivered GET /admin/collections/posts#1 (held 575 ms)
+3.601s write headingSelect.state0.categories.2, .8, .9 ...: undefined → null                     the new rows' cells request their ids
+3.704s send GET /api/categories#2 "?...where[id][in]=2,8,9,12,15,18,…"
+3.706s send GET /api/users#2      "?...where[id][in]=1"
+4.232s delivered GET /api/users#2 (held 454 ms)                                                   ADD_LOADED users → `documents` changes
+4.339s send GET /api/categories#3 "?...where[id][in]=2,8,9,12,15,18,…"                            the pending categories ids, requested again
+4.360s delivered GET /api/categories#2 (held 597 ms)
+4.923s delivered GET /api/categories#3 (held 530 ms)
Delivery order: users/me#1 → users#1 → categories#1 → posts#1 → users#2 → categories#2 → categories#3
```

The third categories request carries exactly the ids of the second, and is sent 100 ms (the provider's debounce)
after the users batch landed while the categories batch was still pending. In the baselines the two batches landed
within the debounce window, so the loader ran once with nothing left to load. The same mechanism explains every other
count in section 4: each response that lands while another batch is pending re-requests the pending ids, and new rows
mounting while a batch is pending include its ids in theirs.

### 6.2 Root cause

`packages/ui/src/elements/Table/RelationshipProvider/index.tsx` (payload 3.92.0; lines from the source map of
`@payloadcms/ui/dist/elements/Table/RelationshipProvider/index.js`):

```tsx
38    const [documents, dispatchDocuments] = useReducer(reducer, {})
39    const debouncedDocuments = useDebounce(documents, 100)
...
52    const loadRelationshipDocs = useCallback(
53      (reloadAll = false) => {
54        Object.entries(debouncedDocuments).forEach(async ([slug, docs]) => {
55          const idsToLoad: (number | string)[] = []
56
57          Object.entries(docs).forEach(([id, value]) => {
58            if (value === null || reloadAll) {
59              idsToLoad.push(id)
60            }
61          })
62
63          if (idsToLoad.length > 0) {
...
92            const result = await fetch(`${url}${query}`, {
...
99            if (result.ok) {
100             const json = await result.json()
101             if (json.docs) {
102               dispatchDocuments({
103                 type: 'ADD_LOADED',
...
115      [debouncedDocuments, api, i18n, locale, collections],
116    )
117
118    useEffect(() => {
119      void loadRelationshipDocs(locale && prevLocale.current !== locale)
120      prevLocale.current = locale
121    }, [locale, loadRelationshipDocs])
```

and `reducer.ts`: `REQUEST` sets `newState[relationTo][value] = null` (line 49), `ADD_LOADED` sets the document or
`false` (lines 31 and 36). There is no state between "requested" and "loaded": an id is `null` from its `REQUEST`
until its `ADD_LOADED`, `loadRelationshipDocs` is recreated whenever `debouncedDocuments` changes (line 115) and runs
from the effect (line 118), and it requests every `null` id (line 58). Any change of `documents` while a request is
pending, another collection's `ADD_LOADED` or another cell's `REQUEST`, therefore requests the pending ids again.

Where it bites: list views with two or more relationship columns (one batch per collection, so one landing re-requests
the other), list views whose rows change while a batch is pending (search, sort, page), and `RelationshipTable`
(`packages/ui/src/elements/RelationshipTable/index.tsx` mounts the same provider). On a fast local server the two
batches land within 100 ms of each other and nothing happens, which is why the baselines usually show 2 requests; with
250 to 300 ms of network latency (the `slow_ms: 300` sessions) the baselines themselves showed 4.

An aside the maintainers may want to look at, not part of the finding and not in the patch: `reducer.ts` line 30,
`unreturnedIDs.splice(unreturnedIDs.indexOf(doc.id), 1)`, compares `doc.id` (a number with the SQLite and Postgres
adapters) with `idsToLoad` entries that are strings (`Object.entries` keys), so `indexOf` is `-1` and `splice(-1, 1)`
removes the last entry instead. When every id is returned the counts still match and nothing is visible; when a
document is missing, the wrong id can be marked `false`.

## 7. The fix and its test

[payload.patch](payload.patch), two files:

- `packages/ui/src/elements/Table/RelationshipProvider/index.tsx`: a `useRef<Record<string, Set<string>>>` of the ids
  in flight per collection; `loadRelationshipDocs` leaves them out (`value === null && !inFlight.has(id)`), adds a
  batch's ids before `fetch` and removes them in a `finally`, so a failed request lets them be requested again on the
  next change; `reloadAll` (a locale change) still requests everything. 25 lines changed, Payload's style (the file's
  own names, 2-space, no semicolons, the `payload/shared` and `qs-esm` imports untouched).
- `test/fields/collections/Relationship/relationshipCells.e2e.spec.ts` (new): a Playwright e2e in the `test/fields`
  suite's layout (`initPayloadE2ENoConfig`, `AdminUrlUtil`, `reInitializeDB`, `ensureCompilationIsDone`,
  `initPageConsoleErrorCatch`, `TEST_TIMEOUT_LONG`, `relationshipFieldsSlug`): it routes every request with
  `where[id][in]`, delays the first collection's batch by 1.5 s, loads the list view, and asserts that every
  `<slug>:<id>` pair was requested exactly once. The helper import paths follow the 3.x layout from the published
  tests; they could not be checked against Payload's repository from this session (access is scoped to GenClass-lib),
  so the maintainers may need to move the file or adjust an import.

The same assertion against the app here, without GenClass ([payload-hunt/dup-requests.spec.mjs](payload-hunt/dup-requests.spec.mjs):
delay `/api/categories` by 1.5 s, load the posts list, list the batch requests):

```
payload 3.92.0 as published, three runs, identical:
+    0 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17
+    1 ms  GET /api/users       where[id][in]=1
+  132 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17      <- the users batch landed, the loader ran again
category cells with a title: 10; batch requests: 3; ids requested more than once: 10      exit 1

with the fix, three runs, identical:
+    0 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17
+    3 ms  GET /api/users       where[id][in]=1
category cells with a title: 10; batch requests: 2; ids requested more than once: 0       exit 0
```

The fixed variant was checked on the file the admin really loads. `@payloadcms/ui` ships `dist/exports/client/index.js`
as one bundled, minified file with its own copy of every component, and that is what the `./client` export and Next
compile; a first attempt that patched `dist/elements/Table/RelationshipProvider/index.js` changed nothing (the
reproduction still failed, the replay still said reproduced). [payload-hunt/apply-to-bundle.mjs](payload-hunt/apply-to-bundle.mjs)
applies the same three changes to the minified provider in the bundle (the dev server restarted with `.next` removed).
The TSX patch is what the maintainers apply; the bundle edit only serves the check here.

What Payload already does right, quoted because it is why the classic races did not show (section 5):

- `packages/ui/src/hooks/useQueue.ts`: `queueTask` runs one task at a time and, when more are queued meanwhile,
  "only process[es] the last task in the queue" and discards the rest. `Autosave` and the relationship field's
  `updateResults` both go through it, so an autosave or an option search is never in flight twice for one component.
- `packages/ui/src/forms/Form/mergeServerFormState.ts`: with `acceptValues: { overrideLocalChanges: false }` (what
  `Autosave` passes) a server value is accepted only for a field that is not `isModified`, and array rows are matched by
  id, so an autosave response landing over newer typing does not replace it.
- `packages/ui/src/views/Edit/index.tsx` and `forms/Form/index.tsx`: every form-state refresh (`onChange`, `onSave`,
  reset) goes through `handleAbortRef`, which aborts the previous request's controller before starting the next, so an
  older form-state response cannot be merged after a newer one was requested.
- `packages/ui/src/forms/Submit/index.tsx`: the Save and Publish buttons are disabled while the form is `processing`
  or `backgroundProcessing`, so the second click of a double-click never submits.

## 8. The fixed variant

With the fix in the admin's client bundle (section 7) and the dev server restarted, in this order:

| check | result |
|---|---|
| `dup-requests.spec.mjs`, three runs | 2 batch requests, 0 ids requested twice, exit 0, three times (section 7 has the output) |
| `genclass_replay f6` (the seeded order 1 with up to 600 ms of latency that produced the finding) | `r326: not reproduced · ended with the values of the request-order baseline`; the earlier replay on the unfixed build, `r297: REPRODUCED` |
| `genclass_explore` search, `slow_ms` 600, 2 baselines + 6 seeded | `GET /api/categories` 2 and `GET /api/users` 2 in all 8 runs (unfixed: 2 vs 3 or 4). Verdict `RACE: 1 of 6` on `Mte.state0` (`null` vs absent) and `headingSelect.state1.categories.16.name` (absent vs `"Category papa"`): the absent-store noise of section 9, no request count, no page text. DOM oracle 6 of 6 same |
| `genclass_explore` filtersort, 600 | categories 3 and users 3 in all 8 runs (unfixed: 3 vs 4 or 5). Verdict: `no reordered run ended differently, but 3 of 6 had an older response overwrite newer data along the way`, the witnesses being Next's dev overlay (`nextBadgeRoot.state5.phase`) and a progress value (`r1.state1`), as in every session. DOM oracle 6 of 6 same |
| `genclass_explore` search, 300 | categories 2 and users 2 in all 8 runs (unfixed: users 4 vs 2 or 3). Verdict `RACE: 1 of 6`, the same two absent-store fields. DOM oracle 6 of 6 same |

So on the fixed variant the request counts no longer depend on the delivery order: 0 of 18 reordered runs differ
(17 of 18 did on the same three sessions before the fix), and the two batches per collection are exactly the two the
page needs (the first rows, then the rows for the typed query; the sort scenario's third is the sort's own rows). The
false-report rate on the fixed variant, as reported: 2 of 18 reordered runs flagged, both on the state-discovery noise
of section 9 (problem 3), none on anything the fix touches, and one session flagged for witnesses alone that the
unfixed build and the baselines also produce.

The regression test of the patch could not be run inside Payload's own suite from this session (no checkout of the
Payload repository); its assertion is the one `dup-requests.spec.mjs` makes, which fails on the published build and
passes with the fix, three times each.

## 9. GenClass runtime problems met

1. **Chromium 153 Local Network Access.** A document fulfilled through a Playwright route (needed to inject the tag)
   loses its loopback address space, so the page's `fetch` to the bridge at `127.0.0.1:<port>` was refused
   ("Permission was denied for this request to access the loopback address space") and `connected` never became
   true; Next's HMR websocket was refused the same way. Launching Chromium with
   `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers` fixed it. A page served normally is
   not affected (the probe variants without the route connected fine), but any test harness that rewrites the document
   will hit this; `docs/runtime/AGENT.md` should mention it, and `connectAgent` could warn when the hello fails with
   `TypeError: Failed to fetch` on a loopback URL.
2. **`whenSettled` resolves while a debounce is pending.** On the edit view, `whenSettled()` returned true 2 to 10 ms
   after the last keystroke while Payload's 800 ms autosave debounce (and the 250 ms form-state debounce) were pending,
   so the harness closed the page before the autosave request existed: with plain Playwright and a 4 s wait the
   autosave fired every time, with `whenSettled` alone never. The quiet-point rule in `src/agent/index.ts` counts
   pending short timers only until they have been pending without a pause for `LONG_RUNNING_MS` (10 s); on this page
   some short timer appears never to clear (likely a timer created through the wrapped `setTimeout` and cleared through
   a `clearTimeout` reference captured before the wrapper was installed, which leaves its id in `pendingTimers` for
   good), after which no timer counts. Not pinned down to the component. Workaround in the harness: settle, wait a
   fixed 2.5 to 5 s, settle again. A fix should drop a pending-timer entry that never fires or is never cleared after
   its own delay has passed (the wrapper knows `ms`), instead of giving up on all timers after 10 s.
3. **State-discovery noise reported as races.** On the edit views, 72 of 108 reordered runs (18 sessions, section 5)
   were reported as `RACE` while form values, the stored document and the versions were identical. What differed:
   `ax.state0` and the page line that shows it (a formatted time, `7:27 PM` vs `7:28 PM`: the "Last saved" and
   "updated at" clock crossing a minute during the session, once `Loading...`), `V5.state0.*` (a date-fns locale
   object), `Eo.state*` (tooltip positions), `it.state*`, `reactSelect….focusedOption` (`undefined` vs absent),
   `Mte.state0` (a progress value), `fieldAuthor.state3..8`, `X1.state1..2` (the auth token and its expiry), the dev
   overlay's `m.state0.*`, each present in one run and `(absent)` in another, plus `formReady.state7` (the one real
   difference, section 5). Two causes: the snapshot keeps the first 300 leaves (`src/agent/index.ts`, `snapshot()`),
   and Next's dev overlay alone takes about 40 of them, so which app stores make the cut depends on discovery order;
   and a component store exists only once that component has changed state, which for a tooltip or a progress bar is
   itself timing. The baseline-vs-baseline filter catches a value that differs between the two baselines but not a
   field that is absent in one seeded run only, and the line-shape filter blanks digits only when the two baselines
   already differed on that line (they usually fell in the same minute). Suggestions: treat `(absent)` on one side as
   noise unless the parent store is present in both snapshots (a missing record under a present parent stays a
   difference); blank clock-shaped tokens (`\d{1,2}:\d{2}`, month names with a day) in page lines before comparing;
   prefer app stores over framework internals in the 300-leaf cap, or raise it; `AGENTS.md` rule 2 is not touched by
   any of these. For the list scenarios the request counts were a real, if small, difference, and the DOM comparison
   agreed on every run, so the verdict there is right.
4. **Hydration keystroke loss is not GenClass's.** The first load of a route under Turbopack can take seconds to
   hydrate; a keystroke typed into Payload's controlled search input before that is lost (recorded scenario
   `= eact` and `= ct` instead of `= react`), which split one explore session into three scenario groups. A warm-up load
   and a quiet point before acting fixed it. GenClass recorded the actual typed value, which is what made it visible.
5. **An app's follow-up request keyed as a GenClass hedge.** `src/agent/schedule.ts` line 212 keys a request whose
   ambient parent has the same signature as `<parent key>~hedge` (or `~retryN`), and `record.ts` line 326 then treats
   it as GenClass's own, so it is never an `identical-in-flight` witness. Payload's edit view sends a second
   `form-state` server action from the first one's response chain (`POST /admin/collections/posts/:id#6` then
   `#6~hedge`, with different arguments: 15 and 16 keys), and the runtime never hedges in `observe`. The runtime's own
   hedges and retries (`src/observe/fetch.ts` lines 594 and 631) should carry a marker the agent checks instead of the
   signature match; pagination chains and polls that start from the previous response's handler are mislabelled the
   same way.
6. **Typing into a react-select combobox is not recorded.** The relationship field's input (`role="combobox"`) got a
   `click combobox` action and no typing burst, so two runs that type different text there fall into one scenario
   group and the generated test would not type at all.
7. Small: `genclass_explain`'s generated test asserts the request count (`toBe(2)`), the right fact here but one that
   a fix changes legitimately in both directions; and explain's "Race finding(s): f6." ends with a period that a naive
   id parser (mine) tripped on.

## 10. Time spent

| step | about |
|---|---|
| reading AGENT.md, the e2e loop, compare.ts, the runtime entries | 15 min |
| Payload app: scaffold, install, collections, seed over REST | 20 min |
| injection harness and probe (LNA, hydration, connect variants) | 35 min |
| list-view sessions (6) and the finding's root cause | 25 min |
| edit-view sessions, the `whenSettled` diagnosis, scenario fixes, reruns | 60 min |
| fix, regression test, fixed-variant checks (including the bundle detour of section 7) | 35 min |
| this report, the issue draft, the patch | 30 min |

About 3 h 40 min of session time from the first `npm ci` to the pull request, of which about 1 h 10 min was waiting for
explore sessions to run (24 sessions of 9 page loads, 3 more on the fixed build). A session's worker restart killed the
dev server and a sweep once; the remaining sessions were rerun.
