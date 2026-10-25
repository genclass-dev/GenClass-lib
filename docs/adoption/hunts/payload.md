# Race hunt: Payload admin panel (payload 3.92.0)

An evidence-backed contribution prepared for Payload's maintainers, from a GenClass race hunt against the admin panel
of a fresh Payload app. Nothing was sent to Payload: the draft issue and PR text are in
[payload-issue.md](payload-issue.md), the fix and its regression test in [payload.patch](payload.patch), and the
harness that produced every number below in [payload-hunt/](payload-hunt/). Run on 2026-10-24 in a cloud session,
about 4 hours of active session time in all (section 11).

## 1. Headline

- **No stale-state race.** In every scenario, the page's final state (visible rows, form values, the stored draft, the
  versions created) was the same in the reordered runs as in the two request-order baselines: 144 of 144 reordered
  runs (24 sessions, 8 scenarios, three latencies) by the harness's own DOM and REST comparison (sections 4 and 5).
  Payload's own code prevents the classic races: one queue per autosave and per relationship field (`useQueue` runs
  one request at a time and discards the backlog), an abort controller per form-state refresh, a merge that keeps the
  local value of every modified field, and submit buttons disabled while a submit is processing (section 7). On the edit
  view, one transient effect repaired itself (the header title) and two differences in the form's internal state
  depended on the order (its `modified` and `processing` flags), with the fields, the stored document and the versions
  right in every run (section 5).
- **One timing-dependent bug, with a fix.** The list view's relationship cells load their documents in batches
  (`RelationshipProvider`), and a batch whose response is still pending is requested again on every change of the
  provider's state meanwhile: another collection's batch landing, new rows mounting after a search or a sort. The
  number of `GET /api/<slug>?where[id][in]=...` requests for the same page and actions depended on response timing in
  33 of 36 reordered runs of the list scenarios (2 to 5 requests per collection where the page needs 2 batches in the
  search scenario and 3 in the sort scenario), and the baselines themselves varied between sessions. The data shown is
  correct (every response carries the same documents): a redundant-request bug, not a wrong-display bug. Root cause in
  section 6, fix in section 7, the fixed variant's check in section 8. Next to that number, the false-report rate on
  the fixed build, on the same pages: no reordered run differed in a request count (0 of 18), and explore still
  flagged 9 of 18, all on state-discovery noise and dev-overlay witnesses.
- **GenClass problems met on the way** (section 9): Chromium 153's Local Network Access check blocks the bridge from a
  Playwright-fulfilled document; `whenSettled` does not wait for app timers over 1 s (documented), so it resolves
  while Payload's 2000 ms autosave debounce is pending; the explore verdict reports state-discovery noise as races on
  the edit view (clock minutes in page text, stores beyond the 300-field cap, stores that exist only when a component
  changed state), 72 `RACE` verdicts over 108 reordered edit-view runs whose form, stored document and versions were
  identical, next to the 33 of 36 right ones on the list views; and an app's own follow-up request to the same
  endpoint is labelled a GenClass `~hedge`.

## 2. What was run

| what | version |
|---|---|
| payload, `@payloadcms/ui`, `@payloadcms/next`, `@payloadcms/db-sqlite`, `@payloadcms/richtext-lexical` | 3.92.0 from npm; tag `v3.92.0`, commit `e6f7db8b71facd9ee5ef67feb3b065b2684370d2` (2026-10-22). Paths and line numbers below are from the repository at that commit (the published source maps carry identical files) |
| next / react / react-dom | 16.3.3 (Turbopack dev server) / 19.2.6 / 19.2.6 |
| create-payload-app | 3.92.0, `-t blank --db sqlite`, `npm install` (743 packages) |
| `@genclass/runtime` / `@genclass/mcp` | 0.3.0-beta.1 / 0.1.0, built from GenClass-lib `d77ffd8` (main) |
| Node / Chromium / Playwright | 22.22.0 / 153.0.8010.12 (headless) / 1.63.0 |

The app (not committed) is the blank template (its `users` and `media` collections) plus three collection configs, a
normal integration and nothing tuned to GenClass ([payload-hunt/collections/](payload-hunt/collections/)):

- `posts`: `title` (text), `summary` (textarea), `category` (relationship to `categories`), `author` (relationship to
  `users`), `views` (number); `versions.drafts.autosave: true` (the default interval, 2000 ms:
  `versionDefaults.autosaveInterval` in `packages/payload/src/versions/defaults.ts`); list columns title, category,
  author, views, updatedAt. Seeded with 300 published documents whose titles are two words and a number (`react 278
  tango`), so a typed prefix narrows the list step by step (70 match `react`).
- `categories`: `name`; 20 documents. No versions (one Save button).
- `pages`: `title`, `body`; `versions.drafts: true` without autosave (Save Draft and Publish buttons); 3 documents.
- `users`: the template's auth collection; one user. `media`: the template's upload collection, unused.

Commands, in order (the harness files are in [payload-hunt/](payload-hunt/)):

```bash
# GenClass
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Payload
npx -y create-payload-app@3.92.0 -n app -t blank --db sqlite --db-connection-string "file:./payload.db" --no-agent --use-npm --no-deps
cd app && npm install && (PORT=3000 npm run dev &)       # Next 16.3.3, Turbopack
node seed.mjs                                            # first user over /api/users/first-register, 20 categories, 300 posts over REST
node seed-pages.mjs                                      # 3 pages (drafts, no autosave) for dbldraft
# the hunt (one explore session: a warm-up load, 2 baselines + 6 seeded loads, the report, explain for each race)
node hunt.mjs probe                                      # injection check
node hunt.mjs explore <scenario> <slow_ms> 6             # scenario: search filtersort relsearch autosave autosave2 dblpublish dblsave dbldraft
node hunt.mjs replay <scenario> <finding-id>
node dup-requests.spec.mjs                               # the GenClass-free reproduction of the finding (exit 1 while the bug is there)
node apply-to-bundle.mjs [--revert]                      # the fix in the app's @payloadcms/ui client bundle, for the fixed-variant check
# Payload's own e2e suite, for the regression test (payload-hunt/payload-suite/run.sh has the steps as a script)
git clone --branch v3.92.0 https://github.com/payloadcms/payload && cd payload  # e6f7db8
pnpm install --frozen-lockfile                           # Node 22.23.4, pnpm 11.28.6 (.tool-versions)
NODE_OPTIONS=--max-old-space-size=6144 pnpm run build:core --concurrency=2
node mongo-replset.mjs &                                 # MongoDB 7.0.14 replica set rs0 on 27018 (mongodb-memory-server)
PORT=3100 MONGODB_URL="mongodb://127.0.0.1:27018/payload?replicaSet=rs0&directConnection=true" pnpm dev fields &
playwright test test/fields/collections/Relationship/e2e.spec.ts -c test/playwright.local.config.ts --repeat-each=3 \
  --grep "should not request related documents again"   # then the whole relationship and upload specs
node react-compiler-check.cjs <index.tsx>                # SWC + babel-plugin-react-compiler, as the package build runs them
```

### 2.1 Injection without touching Payload

Payload's source is not modified. The harness (`hunt.mjs`) runs the MCP server in-process (`serve()` from
`@genclass/mcp`, driven over JSON-RPC `tools/call` exactly as a coding agent drives it) and, in Playwright:

- routes `/__genclass/*` on the app's origin to `packages/runtime/dist/` (and `/__genclass/__connect.js` to two lines
  that import `./agent.js` and call `connectAgent(window.GenClass.runtime)`);
- routes every `/admin` document through `route.fetch()` and inserts, first in `<head>`, the script tag `<script
  src="/__genclass/genclass.global.js" data-base="/__genclass/" data-mode="observe" data-model="off"
  data-telemetry="off" data-report="silent" data-devtools="off" data-visual="off">` followed by `<script type="module"
  src="/__genclass/__connect.js">`. The classic tag runs before Next's own (async) scripts, so the React state
  discovery hook is installed before react-dom evaluates;
- `addInitScript` sets `window.__GENCLASS_AGENT_URL__` to the bridge and `window.GENCLASS_CONFIG = { telemetry: false,
  mode: "observe", model: false, report: "silent", devtools: false, visual: false, analytics: false }`; the model is
  never loaded (status `{"state":"off"}`), telemetry is off, nothing is downloaded;
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
| (d) `autosave` | edit view of post 2 (autosave every 2000 ms) | click the title, 4 bursts of typing (` one`, ` two`, ...) at 80 ms a key with 1.5 s pauses, then stop | the title field, the stored draft (`GET /api/posts/2?draft=true`), the versions list |
| (d2) `autosave2` | edit view of post 4 | 5 bursts with 2.6 s pauses, so each burst's autosave response (and the form-state refresh after it) lands while the next burst is typed | the same |
| (e) `dblpublish` | edit view of post 3 | edit the title, let its autosave land, double-click Publish changes | versions created, stored title and status, the field |
| (e) `dblsave` | edit view of a category (no versions) | edit the name, double-click Save | stored name and `updatedAt`, the field |
| (e) `dbldraft` | edit view of a page (drafts, no autosave) | edit the title, double-click Save Draft | versions created, stored draft, the field |

Hard rule 1 holds: mode `observe`, no model, the agent link's holds only (each response at most its seeded delay plus
`maxHoldMs`, never changed); the app is never made worse by the runtime, only slower in the way a bad network is.

## 4. Verdicts: list views (search, filter and sort)

| session | explore verdict (as reported) | what differed | DOM oracle (rows, URL, search; result count over the saved JSON) |
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
`GET /api/users?...`): 2 batches of ids are needed in the search scenario (the first rows, then the rows for the typed
query) and 3 in the sort scenario (plus the sorted rows), and between 2 and 5 requests per collection were sent, fewer
than the baselines in some runs and more in others. The baselines were not stable across sessions either (users: 4, 2
and 3 in the three search sessions, 5, 3 and 4 in the sort sessions), which is the same effect under the seeded extra
latency the baselines get too. Section 6 has the cause. With the fix, the same three sessions (search 300 and 600,
sort 600) sent the same counts in every run, and explore flagged 9 of their 18 reordered runs for other reasons
(section 8): that is the false-report rate next to the 33 of 36.

The witnesses recorded along the way (`overwrote-newer nextBadgeRoot.state5.phase by GET /admin/collections/posts`,
`overwrote-newer r1.state1 by GET /api/categories`, `Mte.state0`) are Next's dev overlay and a progress indicator
being written by a response's chain after a timer: facts about the dev tooling, not about Payload.

## 5. Verdicts: edit views

18 sessions, 108 reordered runs. The harness's oracle (`key` in `payload-hunt/hunt.mjs`, line 458) compares the form
field, the stored document over REST (`?draft=true` where drafts apply), the versions a double-click created
(dblpublish, dbldraft) and the toasts, and `options` for the relationship search. The status line, the autosave line
(minutes blanked) and the autosave scenarios' version counts were compared over the saved JSON afterwards, with the
same result.

| session (slow_ms) | explore verdict | what explore saw differ | oracle | requests per run |
|---|---|---|---|---|
| relsearch 300 / 600 / 900 | RACE 2 of 6 / no race / no race | `fieldAuthor.state3..8`, `Mte.state0`, `V5.state0.*` present in one run, absent in another | 18 of 18 same options | 3 option searches |
| autosave 300 / 600 / 900 (1.5 s pauses) | RACE 5 / 6 / 6 of 6 | `ax.state0` (a formatted time: `7:27 PM` vs `7:28 PM`), `V5.state0.*`, `reactSelect….focusedOption` present vs absent | 18 of 18: stored draft = typed text, one autosave, versions +1 | 1 autosave (the 2000 ms debounce is longer than the 1.5 s pauses, so it fires only after the last burst), 5 form-state actions |
| autosave2 300 / 600 / 900 (2.6 s pauses) | RACE 1 / 6 / 6 of 6 | 300: absent stores; 600: the time text, absent stores, and `formReady.state7` (the form's `modified` flag) `true` in both baselines, `false` in r165; 900: `formReady.state7` `false` in both baselines, `true` in 6 of 6 seeded runs, form-state actions 9 vs 8 or 10, autosaves 5 vs 4 in two runs | 18 of 18: stored draft = typed text (` one two three four five`), status `Changed`, `Last saved less than a minute ago` | 5 autosaves (4 when `useQueue` dropped a backlog), 10 form-state actions (9 in the 900 ms baselines, 8 to 10 in its seeded runs) |
| dblpublish 300 / 600 / 900 | RACE 4 / 4 / 5 of 6 | the time text; dev overlay fields | 18 of 18: one publish request, versions +2 (the edit's autosave and the publish), stored title published | 1 `PATCH /api/posts/3?depth=0` |
| dblsave 300 / 600 / 900 (categories, no versions) | RACE 6 / 4 / 6 of 6 | the time text (`8:11 PM` vs `8:12 PM`, once `Loading...`); in r240 (300) `formReady.state5` (the form's `processing` flag) still `true` and the name field's `initialValue` still the pre-save `Category dbl base` | 18 of 18: one save, stored name = field | 1 `PATCH /api/categories/:id` |
| dbldraft 300 / 600 / 900 (pages, drafts, no autosave) | RACE 4 / 2 / 5 of 6 | the time text, `X1.state1..2` (the auth token and its expiry), dev overlay fields | 18 of 18: one draft save, versions +1, stored draft = field | 1 `PATCH /api/pages/:id?draft=true` |

Every reordered run ended as its baselines did by the oracle: 108 of 108. Of the 72 `RACE` verdicts, 64 are on
discovered-store fields or on a page line that holds a formatted clock time alone (section 9, problem 3, says why and
what to change). The other 8 are on the form's own internal state: autosave2's `modified` flag (1 run at 600 ms, 6 at
900 ms) and dblsave 300's r240. None is on a field value, the stored document or the versions.

Three things the reordered edit runs did show; the first was repaired within the run, the other two are end states:

- **The document title in the header reverts for one keystroke.** In `autosave2` at 900 ms, the witness
  `overwrote-newer docId.state0 by PATCH /api/posts/:id` appeared in 5 of 6 seeded runs and in both baselines: the
  autosave response for `… three four` landed while ` five` was being typed and wrote the header title (`docId.state0`,
  also the step-nav label `NC.state0`) back from `… three four f` to `… three four`; the next keystroke rewrote it from
  the form value (`+15.067s` and `+15.090s` in the recorded steps). The field itself was never touched: the merge keeps
  modified fields (section 7). A user who stops typing exactly as an older autosave lands sees the previous title in
  the header until the next autosave; the final text was right in every run.
- **Whether the form ends `modified` depends on the order, and on the number of autosaves.** At 900 ms the form ended
  `modified` in 6 of 6 seeded runs and in neither baseline; at 600 ms it ended `modified` in both baselines and not in
  r165. Everything was saved in every run. The cause is in `packages/ui/src/forms/Form/index.tsx`: the `setModified`
  interceptor (lines 157-163) sets `modifiedWhileProcessingRef` on every call made while `backgroundProcessingRef` is
  true, and an autosave runs its `submit` between `setBackgroundProcessing(true)` and `(false)`
  (`elements/Autosave/index.tsx` lines 182-187). So the save's own `setModified(false)` (line 410) sets the flag, and
  the next autosave takes the `else` branch (lines 409-413): it clears the flag and leaves `modified` true. `modified`
  therefore alternates from one autosave to the next, and a burst typed during a save shifts the alternation (the 900 ms
  baselines made 5 autosaves and ended `false`; two seeded runs made 4). The intended part, a change made during a save
  surviving that save, works; the flag being set by the save's own call looks like a small Payload bug of its own. For
  an autosave collection nothing visible was found to depend on it (the leave prompt is off for autosave), so it is
  noted here and not in the issue draft.
- **One double-click Save run ended with the form still `processing`.** In dblsave 300, r240's last snapshot has the
  form's `processing` flag `true` and the name field's `initialValue` still the pre-save value, where the baselines have
  `false` and the saved name. r240 sent the same three requests as every other run (the form-state action, the
  `PATCH`, the post-save form-state action), and the stored name and the field were right. A form left `processing`
  would keep Save disabled; the oracle did not record the button, so whether a user would see that was not checked.

The relationship search did not test what it meant to: with the text typed at 90 ms a key, the field's debounced
search went out for the first two characters only (`where[and][1][name][like]=Ca`, the same in a plain Playwright run
without GenClass) and the menu kept the unfiltered first page, so the comparison is of that state. GenClass recorded
both actions (`click combobox "react-select-…"` and `type combobox "react-select-…" = Category r`, 10 keystrokes over
1.1 s), so the narrow search comes from the field's debounce and the typing pace, not from the recorder.

## 6. The finding: relationship batches requested again while pending

### 6.1 Evidence, in causal order

`genclass_explain f6` (session search 600, run r37, seeded order 1, the recorded delivery order; times from
`connectAgent`; the full output is in [payload-hunt/out/explain-f6.txt](payload-hunt/out/explain-f6.txt)):

```
+0.964s write headingSelect.state0.categories.11 ... users.1          the 10 first rows' cells request their ids (REQUEST, null)
+1.069s write headingSelect.state1.categories.11 ... users.1          the debounced copy, 100 ms later: the loader runs
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

`packages/ui/src/elements/Table/RelationshipProvider/index.tsx` at v3.92.0 (commit `e6f7db8`):

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

Where it bites: list views whose relationship cells point to two or more collections (two relationship columns, or one
polymorphic column; one batch per collection, so one landing re-requests the other), list views whose rows change
while a batch is pending (search, sort, page), and `RelationshipTable`
(`packages/ui/src/elements/RelationshipTable/index.tsx` mounts the same provider). On a fast local server the two
batches land within 100 ms of each other and nothing happens, which is why the baselines usually show 2 requests; with
up to 300 ms of seeded latency per response (the `slow_ms: 300` sessions) the baselines themselves showed 4 users
requests in the search scenario and 5 in the sort scenario.

An aside, not part of the finding and not in the patch (the issue draft mentions it, read from the code and not
reproduced): `reducer.ts` line 30,
`unreturnedIDs.splice(unreturnedIDs.indexOf(doc.id), 1)`, compares `doc.id` (a number with the SQLite and Postgres
adapters) with `idsToLoad` entries that are strings (`Object.entries` keys), so `indexOf` is `-1` and `splice(-1, 1)`
removes the last entry instead. When every id is returned the counts still match and nothing is visible. When k
documents are missing, the first k ids of the batch are marked `false`, overwriting returned documents among them
(shown as "Untitled - ID: n"), and the missing ids stay `null` (shown as "Loading...", and requested again on every
later change, with or without the fix). With string ids (MongoDB) the result is right.

Not tested, and possibly a real stale-response race: on a locale change `reloadAll` requests every id again in the new
locale while a batch in the old locale may still be pending, and whichever response lands last is what the cells
show.

## 7. The fix and its test

[payload.patch](payload.patch) (against v3.92.0, the version tested) and [payload-main.patch](payload-main.patch) (the
same change rebased onto Payload's `main` at `aebbf75`, 2026-10-23, where the provider's locale and select code changed
but the duplicate-request path is unchanged; the v3.92.0 patch applies there with a three-way merge, the rebased one
with a plain `git apply`), two files:

- `packages/ui/src/elements/Table/RelationshipProvider/index.tsx`: the ids in flight per collection, in a ref (a `Map`
  from id to the batch that requested it); `loadRelationshipDocs` leaves them out of the next batch. A batch marks its
  ids before `fetch` and, when it is over, releases only the ids it still owns (a `reloadAll` batch after a locale
  change may have taken one over). A request that throws (a network error) is logged and its ids are released, so the
  next change requests them again; an error response still marks them `false`, as before. The loader also checks the
  latest `documents`, kept in a ref by an effect declared before the loader's effect: for one run after a response has
  been applied, the debounced copy can still show its ids as `null` although they are no longer in flight. `reloadAll`
  still requests everything. 52 lines added and 19 removed (34 and 1 ignoring the re-indentation of the `fetch` block
  into the `try`), in the file's own style. Three of these points came from the review of the first version of the fix
  (section 10): the latest-state check, the per-batch ownership, and the compiler-safe form. Payload builds
  `@payloadcms/ui` with `babel-plugin-react-compiler` 19.1.0-rc.3, which bails out on `??=` and on a `try` without
  `catch` and then emits the component without memoization, with no error. The first version used both. Run through
  the package's own SWC and Babel steps
  ([payload-hunt/react-compiler-check.cjs](payload-hunt/react-compiler-check.cjs)), the final file compiles with a
  `_c(19)` memo cache, as v3.92.0 does with `_c(15)`.
- `test/fields/collections/Relationship/e2e.spec.ts`: one new test in the existing `relationship` describe block,
  `should not request related documents again while their batch is pending`. It adds a row related to an
  `array-fields` document (the default columns are ID, Text, Relationship and the has-many column, and the seeded rows
  relate only to `text-fields`, so the list would load one batch), routes every request with `where[id][in]`, holds the
  first collection's batch on a promise (the hold-and-release pattern of `test/fields/collections/Tabs/e2e.spec.ts`),
  waits for another collection's batch to answer and 500 ms more for the provider's debounced loader, releases the held
  batch, waits for its response, and asserts that no `<slug>:<id>` pair was requested twice. Waiting for the other
  batch's response, not only its request, means the window is exercised on every run, and the test cannot pass with
  nothing overlapping (it times out instead). `page.unrouteAll({ behavior: 'ignoreErrors' })` in a `finally` keeps the
  shared page clean. It uses the file's own `page`, `url`, `payload`, `tableRowLocator`, `wait` and
  `createRelationshipFieldDoc`, and adds no imports.

Run in Payload's own e2e suite (`test/fields`, its default MongoDB adapter on a local single-node replica set, the dev
server on Node 22.23.4 and pnpm 11.28.6 as `.tool-versions` pins them, Playwright 1.58.2 from the repository driving the
machine's Chromium 153; [payload-hunt/payload-suite/run.sh](payload-hunt/payload-suite/run.sh) has the steps):

| code | the new test (final version) |
|---|---|
| v3.92.0 | fails 3 of 3: `Expected length: 3, Received length: 4`, the held `array-fields` id requested a second time right after the `text-fields` batch landed |
| v3.92.0 with the final fix | passes 3 of 3 (the served admin chunk contains the final code) |

The first version of the test (it polled until a second collection's batch had been sent) and the first two versions of
the fix gave the same results: 3 of 3 failing on v3.92.0, 3 of 3 passing with each fix.

The whole relationship and upload specs of the suite (52 tests with the new one, 9 of them skipped by the specs
themselves), one worker, no retries, in this order
([payload-hunt/out/payload-suite/](payload-hunt/out/payload-suite/) has every run's results):

| code | passed | failed | failures |
|---|---|---|---|
| v3.92.0 | 41 | 2 | `should edit document in relationship drawer` (a 20 s timeout at Save); the new test (by design) |
| first fix | 40 | 3 | the drawer test; `should not duplicate relationship filter options when switching operators` (browser console error "There was a problem loading the document with ID of ..."); `should respect filterOptions in the relationship list drawer` (`UnauthorizedError` while rendering the drawer's list) |
| second fix (latest-state check) | 42 | 1 | the drawer test |
| final fix, the test after the filter-operators test | 41 | 2 | the drawer test; the new test, on the same console error as above |
| final fix, the test moved (below) | 40 | 3 | the drawer test; `should handle polymorphic relationship when appearance: "drawer"` (no success toast within 6 s after Save); the `filterOptions` drawer test |
| v3.92.0, the test moved | 41 | 2 | the drawer test; the new test (by design) |

The drawer test failed in every run, on both codes. The other failures were checked one by one. The `filterOptions`
drawer test, repeated three times, failed its third repetition on v3.92.0 and on the fix alike, and the
filter-operators test passed 3 of 3 on both. The console error comes from the list filter's relationship condition
(`packages/ui/src/elements/WhereBuilder/Condition/Relationship/index.tsx` line 286, `addOptionByID`), not from the
provider. The filter-operators test leaves a relationship filter open on the shared page, the next test's
`reInitializeDB` resets the database under it, and the filter's lookup of a document then fails. Whichever test is
running when that lookup fails gets the console error. Checked directly: the filter-operators test and the new
test run in turn five times, on each code. With the fix, the new test failed 1 of 5 times, on that console error, and
never on a repeated request. On v3.92.0 it failed 5 of 5: 3 on the repeated request, 2 on the console error first. So
the new test now sits after the sort-options test, before the first list-filter test, where nothing leaves a filter
open. In that position the new test fails 3 of 3 on v3.92.0 (`Expected length: 3, Received length: 4`) and passes 3 of
3 with the fix, and in the whole-spec run with the fix it passed. That run had one failure seen nowhere else, the
polymorphic drawer test, which then passed 3 of 3 on each code. The carryover itself is pre-existing and outside this
PR.

ESLint with Payload's configuration reports no problem in the provider and none in the new test's lines (the spec's
36 problems, mostly `perfectionist/sort-objects`, are the ones v3.92.0 already has), and Prettier leaves both files
unchanged. On SQLite (`PAYLOAD_DATABASE=sqlite`) the suite could not start:
its own `/api/re-initialize` seed fails with `The following field is invalid: readOnlySlug` (a slug-fields seed
document), on the unfixed code, so MongoDB was used as in Payload's CI.

The same assertion against the app here, without GenClass
([payload-hunt/dup-requests.spec.mjs](payload-hunt/dup-requests.spec.mjs): delay `/api/categories` by 1.5 s, load the
posts list, list the batch requests):

```
payload 3.92.0 as published, three runs, the same requests (the third at +132, +135 and +149 ms):
+    0 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17
+    1 ms  GET /api/users       where[id][in]=1
+  132 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17      <- the users batch landed, the loader ran again
category cells with a title: 10; batch requests: 3; ids requested more than once: 10      exit 1

with the fix, three runs, the same requests (users at +3, +1 and +1 ms):
+    0 ms  GET /api/categories  where[id][in]=2,3,4,8,9,10,11,15,16,17
+    3 ms  GET /api/users       where[id][in]=1
category cells with a title: 10; batch requests: 2; ids requested more than once: 0       exit 0
```

The fixed variant was checked on the file the admin really loads. `@payloadcms/ui` ships
`dist/exports/client/index.js` as one bundled, minified file with its own copy of every component, and that is what
the `./client` export and Next compile; a first attempt that patched
`dist/elements/Table/RelationshipProvider/index.js` changed nothing (the reproduction still failed, the replay still
said reproduced). [payload-hunt/apply-to-bundle.mjs](payload-hunt/apply-to-bundle.mjs) applies the same three changes
to the minified provider in the bundle (the dev server restarted with `.next` removed). The TSX patch is what the
maintainers apply; the bundle edit only serves the check here.

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

With the final fix in the admin's client bundle (section 7) and the dev server restarted with `.next` removed, on the
same pages as the unfixed sessions (the list preferences cleared before the search sessions, so the list is not
sorted by what the sort scenario left behind), in this order
([payload-hunt/out/verify-fix-final.log](payload-hunt/out/verify-fix-final.log)):

| check | result |
|---|---|
| `dup-requests.spec.mjs`, three runs | 2 batch requests, 0 ids requested twice, exit 0, three times (section 7 has the output) |
| `genclass_replay f6` (the seeded order 1 with up to 600 ms of latency that produced the finding) | `r355: not reproduced · ended with the values of the request-order baseline`; on the unfixed build, `r297: REPRODUCED` |
| `genclass_explore` search, `slow_ms` 600, 2 baselines + 6 seeded | `GET /api/categories` 2 and `GET /api/users` 2 in all 8 runs (unfixed: RACE 5 of 6 on the request counts). Verdict `No race found: all 6 reordered run(s) ended in the baseline's state.` DOM oracle 6 of 6 same |
| `genclass_explore` search, 300 | categories 2 and users 2 in all 8 runs (unfixed: RACE 6 of 6, users 4 in the baselines vs 2 or 3). Verdict `RACE: 2 of 6 ... ; 1 more ended right but had an older response overwrite newer data along the way`, on stores present in the baselines and absent in the run (Next's dev indicator `m.state0.*`; in r373 the list's query store `createNewPost.state*`) and a dev-overlay witness (`nextBadgeRoot.state5.phase`). DOM oracle 6 of 6 same |
| `genclass_explore` filtersort, 600 | the same 6 batch requests, in the same order, in all 8 runs: categories 3 and users 3 (unfixed: RACE 6 of 6, 3 vs 4 or 5 and 3 vs 5). Verdict `RACE: 6 of 6`, every run on Next's dev indicator store present in the baselines and absent in the run (`devtoolsIndicator.state0.*`), plus witnesses: the dev overlay in four runs and, in r381 and r382, `overwrote-newer headingSelect.state0.users.1 by "GET /api/categories#2"`, the provider's own `documents` state. DOM oracle 6 of 6 same |

So with the fix the request counts no longer depend on the delivery order: 0 of 18 reordered runs differ from their
baselines in any request count (17 of 18 did on the same three sessions before the fix), and the batches per
collection are exactly the ones the page needs (the first rows, then the rows for the typed query; the sort scenario's
third is the sorted rows). The false-report rate on the fixed variant, as reported: explore flagged 9 of 18 reordered
runs (0, 3 and 6 per session), none of them on a request count, a page value or a row: 8 ended differently only on
stores that exist in one run and not the other (section 9, problem 3), and 1 had a witness alone. The witness on the
provider's `documents` in r381 and r382 is new on this build: the end state is the same as the baselines', the
requests are identical in every run, and the reducer writes the nested objects in place
(`packages/ui/src/elements/Table/RelationshipProvider/reducer.ts` lines 31, 36 and 49 mutate `newState[slug]`, which
the previous state shares), so a write can be recorded at whichever later render reads it. That last part is a likely
explanation, not checked with `genclass_explain`.

An earlier check of the first version of the fix (2 of 18 runs ended differently, 3 more flagged for witnesses alone,
also none on a request count) ran its two search sessions on the list sorted by views, a different page from the
unfixed sessions; those sessions are kept as `out/*-fixed.json`, and the ones above are `out/*-fixed2.json`.

The issue's reproduction without any route was checked on the unfixed bundle as well: a `beforeOperation` hook that
delays `categories` reads by 1 s (the hook in the issue draft) and no other delay. `dup-requests.spec.mjs` with
`DELAY_MS=0` reports 3 batch requests and 10 ids requested twice, exit 1, in 2 of 2 runs.

## 9. GenClass runtime problems met

1. **Chromium 153 Local Network Access.** A document fulfilled through a Playwright route (needed to inject the tag)
   loses its loopback address space, so the page's `fetch` to the bridge at `127.0.0.1:<port>` was refused
   ("Permission was denied for this request to access the loopback address space") and `connected` never became
   true; Next's HMR websocket was refused the same way. Launching Chromium with
   `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers` fixed it. A page served normally is
   not affected (the probe variants without the route connected fine), but any test harness that rewrites the document
   will hit this; `docs/runtime/AGENT.md` should mention it, and `connectAgent` could warn when the hello fails with
   `TypeError: Failed to fetch` on a loopback URL.
2. **`whenSettled` does not wait for a debounce longer than 1 s.** On the edit view, `whenSettled()` returned true 2
   to 10 ms after the harness's pause that follows the last keystroke (950 ms in the first sweep, 1.5 s later; 22 of 24
   saved autosave runs, 87 and 170 ms in the other two). The page was already marked quiet while Payload's autosave
   debounce was pending (`useDebounce(formState, interval)` with the default 2000 ms), so the harness closed the page
   before the autosave request existed: with plain Playwright and a 4 s wait the autosave fired every time, with
   `whenSettled` alone never. This is the documented quiet-point rule, not a defect: the agent's `setTimeout` wrapper
   tracks only timers of at most `SHORT_TIMER_MS` (1000 ms, `src/agent/index.ts` line 117) and passes longer ones
   through untracked (line 263; AGENT.md section 2, "no pending app timer of at most 1 s"), so that polls do not keep a
   page busy. The 250 ms form-state debounce and its request were waited for. Workaround in the harness: settle, wait a
   fixed 2.5 to 5 s, settle again. A suggestion: make the limit an `AgentOptions` setting, and consider a default that
   covers common autosave intervals (2 s), since an autosave is exactly the kind of debounce a race hunt needs to see.
3. **State-discovery noise reported as races.** On the edit views, 72 of 108 reordered runs (18 sessions, section 5)
   were reported as `RACE` while form values, the stored document and the versions were identical; 64 of them rested
   only on the noise below, and the other 8 also had the form's internal flags (`formReady.state7`, the `modified`
   flag, in 7 runs; `formReady.state5`, the `processing` flag, in dblsave 300's r240; section 5). The noise:
   `ax.state0` and the page line that shows it (a formatted time, `7:27 PM` vs `7:28 PM`: the "Last saved" and
   "updated at" clock crossing a minute during the session, once `Loading...`), `V5.state0.*` (a date-fns locale
   object), `Eo.state*` (tooltip positions), `it.state*`, `reactSelect….focusedOption` (`undefined` vs absent),
   `Mte.state0` (a progress value), `fieldAuthor.state3..8`, `X1.state1..2` (the auth token and its expiry), the dev
   overlay's `m.state0.*`, each present in one run and `(absent)` in another. Two causes: the snapshot keeps the first
   300 leaves (`src/agent/index.ts`, `snapshot()`), and Next's dev overlay alone takes about 40 of them, so which app
   stores make the cut depends on discovery order; and a component store exists only once that component has changed
   state, which for a tooltip or a progress bar is itself timing. The baseline-vs-baseline filter catches a value that
   differs between the two baselines but not a field that is absent in one seeded run only, and the line-shape filter
   blanks digits only when the two baselines already differed on that line (they usually fell in the same minute).
   Suggestions: treat `(absent)` on one side as noise unless the parent store is present in both snapshots (a missing
   record under a present parent stays a difference); blank clock-shaped tokens (`\d{1,2}:\d{2}`, month names with a
   day) in page lines and store values before comparing (a fixed text pattern, which `compare.ts` line 11 and AGENT.md
   section 5.1 rule out today, so it needs the owner's go-ahead; page lines alone would leave `ax.state0`, which holds
   the same formatted time); prefer app stores over framework internals in the 300-leaf cap, or raise it. None of
   these touches the runtime or `AGENTS.md` rule 2. For the list scenarios the request counts were a real, if small,
   difference, and the DOM comparison agreed on every run, so the verdict there is right.
4. **Hydration keystroke loss is not GenClass's.** The first load of a route under Turbopack can take seconds to
   hydrate; a keystroke typed into Payload's controlled search input before that is lost (recorded scenario
   `= eact` and `= ct` instead of `= react`), which split one explore session into three scenario groups. A warm-up load
   and a quiet point before acting fixed it. GenClass recorded the actual typed value, which is what made it visible.
5. **An app's follow-up request labelled a GenClass hedge.** `src/agent/schedule.ts` line 212 keys a request as
   `<parent key>~hedge` when the request that was ambient when it started has the same signature (`~retryN` only when
   its `attempt` is higher, which an app request, attempt 1, never is). Payload's edit view sends a second `form-state`
   server action from the first one's response chain (`POST /admin/collections/posts/:id#6` then `#6~hedge`, with
   different arguments: 15 and 16 keys), and the runtime never hedges in `observe`. So the steps, delivery orders and
   explain output call an app request a GenClass hedge and give it no occurrence number of its own. No witness is lost:
   `identical-in-flight` needs the same identity (method, URL and body) and two separate user actions (`record.ts` lines
   325 and 331), and the retry-or-hedge skip at line 327 uses the `cause` link, not the key. Retries already carry a
   marker (`attempt`, `src/observe/fetch.ts` line 594); the hedge op (`fetch.ts` line 631) starts with its parent's
   `attempt` and needs a flag of its own, which the scheduler should check instead of the signature match. Pagination
   chains and polls started in the previous response's handler are labelled the same way.
6. Small: `genclass_explain`'s generated test asserts the request count (`toBe(2)`), the right fact here but one that
   a fix changes legitimately in both directions; and `genclass_explore`'s report line "Race finding(s): f6. Next: ..."
   puts a period right after the last id, which a naive id parser (mine) tripped on.

## 10. Review of this report

Before the pull request, five independent auditors (fresh agents, read-only, each with one dimension: the numbers
against the saved JSON, every claim about Payload's code against the repository at `e6f7db8`, the fix and the test,
every claim about GenClass's own code, and consistency with the repository's rules) checked the first version of this
report, the issue draft, the fix and the test. A sixth agent then tried to refute each finding. The auditors reported
52 findings (21 major, 31 minor); the skeptic confirmed 41, confirmed 11 in part (the finding right, its proposed
correction wrong or overtaken by a later change) and refuted none. The corrections are in the text above; the ones
that changed substance:

- **The fix shipped without memoization.** The first version used `??=` and a `try` without `catch`. Payload builds
  `@payloadcms/ui` with `babel-plugin-react-compiler` 19.1.0-rc.3, which bails out on both, with no error, and emits
  the component unoptimized; no test, lint or behaviour check here could see it. The final version compiles with a
  `_c(19)` memo cache (section 7).
- **Two narrow windows in the fix.** For one loader run after a response is applied, the debounced copy could still
  show its ids as `null` (closed with the latest-state check); and on a locale change an older batch could release an
  id that the `reloadAll` batch still had in flight (closed with per-batch ownership).
- **The test could pass without exercising the window.** It waited until the second batch was sent, not answered; the
  final version waits for its response.
- **Wrong facts in the first version:** the autosave interval (2000 ms, not 800), the cause of the `whenSettled`
  behaviour (a documented 1 s limit, not a leaked timer), a claimed recorder gap that does not exist (the combobox
  typing was recorded), the fixed-build search sessions compared with unfixed sessions on a differently sorted list
  (rerun on the same page, section 8), the false-report count on the fixed build, "22 of 24" in the issue draft (33 of
  36), a reproduction step that would not have reproduced it (a uniform throttle delays both batches alike), and an
  expectation the fix does not meet (a loaded document is still re-fetched when a new cell asks for it).
- **A second Payload observation:** the form's `modified` flag alternates between autosaves because the save's own
  `setModified(false)` sets the "modified while processing" flag (section 5).

## 11. Time spent

Active session time, from the file and commit times (UTC, 2026-10-24 and 25): 18:42 to 20:44 (the first commit; `git
push` was refused for lack of GitHub App access), then 22:46 to about 00:50 after a worker restart. About 4 hours in
all.

| step | about |
|---|---|
| reading AGENT.md, the e2e loop, `compare.ts`, the runtime entries | 10 min |
| Payload app: scaffold, install, collections, seed over REST | 10 min |
| injection harness and probe (Local Network Access, hydration, connect variants) | 15 min |
| list-view sessions and the finding's root cause | 20 min |
| edit-view sessions, the `whenSettled` diagnosis, scenario fixes, reruns | 45 min |
| first fix, the GenClass-free reproduction, the fixed-variant check (including the bundle detour) | 20 min |
| the first version of this report, the issue draft and the patch | 10 min |
| Payload's own suite: clone at v3.92.0, `pnpm install`, `build:core` (one out-of-memory retry), MongoDB, dev server (SQLite tried first) | 35 min |
| the review (five auditors and a skeptic; the first attempt was stopped by the account's spend limit) | in parallel |
| the review's fix and test revisions, the suite runs on both codes, isolating the flaky tests | 60 min |
| the hunt-app reruns on the same page, the corrections to the report and the issue draft | 30 min |
