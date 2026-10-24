# Race hunt: Strapi admin panel (5.59.0)

A GenClass race hunt on the Strapi admin panel, run on 2026-10-24 in a cloud session, with the real
`@genclass/runtime` (0.3.0-beta.1, this repository at `d77ffd8`) injected into the admin by Playwright and the real
`@genclass/mcp` driven the way a coding agent drives it. Strapi's source was not modified for the hunt; the fix is a
patch for its maintainers (`strapi.patch`, draft issue and pull request text in `strapi-issue.md`). Nothing was sent
to Strapi's repository, forum or maintainers.

**Headline.** One real race, found by `genclass_explore` on the first page it was pointed at and reproduced without
GenClass: when the response to `GET /admin/users/me/permissions` lands after the Content Manager's two init responses,
a logged-in super admin who opens a Content Manager URL is sent to `/admin/content-manager/403`, "You don't have the
permissions to access that content", and stays there. Explore reported it in 2 of 6 reordered loads at each of the
three latencies; its replay reproduced it; a Playwright script that only delays that one response reproduces it in
3 of 3 loads (0 of 3 without the delay). A 12-line fix in `useContentManagerInitData.ts` makes the replay say
"not reproduced", the regression test pass, and explore report no such difference over 6 reordered loads at each
latency. The five interaction scenarios (search, sort and filter, relation picker, double Save and Publish,
pagination) showed no order-dependent page: their verdicts, with the false reports GenClass produced on them, are in
section 3.

Sections: 1 setup, 2 how the admin was driven, 3 scenarios and verdicts, 4 the finding, 5 a second observation,
6 problems with GenClass itself, 7 time spent.

## 1. Setup

| what | version |
|---|---|
| Strapi | 5.59.0 (`@strapi/strapi`, `@strapi/admin`, `@strapi/content-manager` 5.59.0; npm `gitHead` `c04f9bc085eb06219fa7707a484159bed60fce68`, the commit the patch is against; the admin's source maps carry the TypeScript sources, which match that commit byte for byte for the files quoted here) |
| Node, npm | 22.22.0, 10.9.4 |
| database | SQLite (`better-sqlite3` 12.11.1) |
| browser | Chromium 1243 (headless shell), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.1 and `@genclass/mcp` from this repository at `d77ffd8`, built with `npm run build -w @genclass/runtime && npm run build -w @genclass/mcp` |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Strapi, in its own directory
npx -y create-strapi@latest strapi-app --javascript --use-npm --install --skip-cloud --no-example --no-git-init \
  --no-run --dbclient sqlite --dbfile .tmp/data.db --non-interactive
# three collection types written as schema files before the first start (src/api/{article,author,category}):
#   article: title (string, required), summary (text), rank (integer), author (manyToOne author),
#            categories (manyToMany category); draftAndPublish on
#   author: name, email; category: name
# src/index.js bootstrap: seeds 30 authors, 40 categories, 300 published articles once (titles such as
#   "React guide 1", "Redux notes 43": the prefixes r, re, rea, reac, react match shrinking subsets)
printf "\nSTRAPI_TELEMETRY_DISABLED=true\nFLAG_NPS=false\nFLAG_PROMOTE_EE=false\n" >> .env
npm run develop                      # serves the admin through Vite in dev mode (React development build)
curl -X POST localhost:1337/admin/register-admin -H 'content-type: application/json' \
  -d '{"email":"hunt@example.com","password":"...","firstname":"Hunt","lastname":"Admin"}'
```

Two Strapi settings were changed for the harness, neither on the code path under test: `config/admin.js` got
`rateLimit: { enabled: false }` (the harness logs in and loads the admin many times a minute), and the guided tour a
new admin sees once was marked completed through its `STRAPI_GUIDED_TOUR` localStorage entry, because its step
tooltip comes with a full-screen transparent backdrop that takes every click until the tour is advanced.

## 2. How the admin was driven

`docs/adoption/hunts/strapi/hunt.mjs` (this directory) is the whole loop, modelled on
`packages/mcp/test/e2e/race.e2e.mjs`:

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js` with its bridge on a free port and a state
  directory per batch; the tools are called through JSON-RPC `tools/call`, the same `genclass_explore`,
  `genclass_explain`, `genclass_replay`, `genclass_status` and `genclass_findings` an agent calls.
- **Injection without touching Strapi.** Playwright's `page.route` serves `packages/runtime/dist/` under the
  virtual same-origin path `/__genclass/`, and rewrites the admin's HTML document to add, at the top of `<head>`:
  a script setting `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, visual: false,
  devtools: false }` and `window.__GENCLASS_AGENT_URL__`; the script tag
  `<script src="/__genclass/genclass.global.js" data-base="/__genclass/">`; and a module script that imports
  `/__genclass/agent.js` and calls `connectAgent(window.GenClass.runtime, { url })`. The classic script runs before
  the admin's module scripts, so automatic React and Redux state discovery installs before react-dom evaluates. No
  model is loaded (explore's witnesses and comparison need none: `src/agent/record.ts` reads the event log, ops and
  store hub only), nothing is downloaded, telemetry is off. The browser context uses `bypassCSP: true`; the admin
  session is logged in once through the login form and reused as `storageState`.
- **Hermetic page.** Requests to any host but `localhost` are aborted (the admin asks `api.github.com` for the
  latest release on every load and got a 403 "rate limit exceeded" from this machine before that).
- **One page load per run.** The deep-link scenarios load the Content Manager URL directly. The interaction
  scenarios load `/admin`, wait for GenClass's quiet point, then move to the Content Manager URL without a page load
  (`history.pushState` and a `popstate` event, which React Router follows), so the admin's start-up responses are
  not among what the interaction's responses are reordered with. Each run waits for
  `window.__GENCLASS_AGENT__.connected`, performs its steps, awaits `whenSettled()`, then reads its own DOM oracle
  (the visible rows, the URL's query, the entry count; the picker's options; the edit view's title, status and
  notifications) and closes the context after 600 ms so the last batch reaches the bridge.
- **Explore.** `genclass_explore start` with `runs: 6` and `slow_ms` 300, 600 and 900 (8 loads per session: 2
  fifo baselines, 6 seeded orders), then `report`; on a race, `genclass_explain` for the first finding, then
  `genclass_replay arm`, one more load, `genclass_replay result`.
- **Secondary oracle.** `docs/adoption/hunts/strapi/summarise.mjs` compares each run's DOM oracle, as a JSON
  string, with the two fifo baselines': a seeded run counts as differing when it equals neither. It is this
  script's own check, next to the explore verdict, never a replacement for it.

`genclass_status` after the first load of each batch showed the page connected ("1 active page(s)", schedule as
armed, "model off, mode observe", settled) and `recorded()` showed the user actions: a search typed as one
`type input "Search for Article" = react` burst, clicks as `click link "Go to next page"`, the relation picker as
`type combobox "author (1)" = re`, a double click as `click button "Publish" x2`. State discovery found the admin's
Redux store (`redux.adminApi.*`, `redux.admin_app.*`, `redux.content-manager.*`) and component hooks
(`AuthProvider.external2`, `HomePageCE.state5`, `NpsSurvey.state7`, ...); every snapshot carried the 300-field cap
(section 6).

## 3. Scenarios and verdicts

Every verdict below is the explore report's own wording, reduced to counts; the DOM oracle column is the secondary
check of section 2. "Witness only" runs ended in the baseline's state but recorded an `overwrote-newer` witness the
baselines did not. A session is one `genclass_explore` session of 8 loads.

<!-- RESULTS TABLE -->

Scenario by scenario:

- **load-list** (the Content Manager list opened by its URL, no action): **the race of section 4**, at every
  latency. The seeded orders that produced it (2 and 3 of 6) are the ones that deliver `/admin/users/me/permissions`
  after both `/content-manager/init` and `/content-manager/content-types-settings`.
- **load-edit** (an entry's edit view opened by its URL): same mechanism, same page (the redirect happens in the
  Content Manager layout, above the route).
- **(a) search.** Strapi's list search (`SearchInput.tsx`) submits on Enter, not per keystroke: typing "react" at
  90 ms a key sends nothing until Enter. The scenario therefore types "react", submits, types "redux" and submits at
  once, so two list requests with different `_q` overlap. The final list was "redux" (9 entries) in every run, in
  both oracles. The list is read through RTK Query's `useGetAllDocumentsQuery` (`services/documents.ts` line 212),
  whose cache is keyed by the query arguments, so an older `_q` response updates an entry nobody displays.
- **(b) sort and filter.** Four header clicks (title, rank, title, rank) and two filters added in a row
  (`rank = 5`, then `title = React`): same keyed cache, same final list in every run.
- **(c) relation picker.** `RelationsInput` (`Relations.tsx` line 550) debounces the search by 300 ms and uses a
  lazy RTK Query (`useLazySearchRelationsQuery`, keyed by `_q`, `Relations.tsx` line 563 and `services/relations.ts`
  line 108). Typed at 350 ms a key, "re" sent one request per key; typed at 80 ms a key, "ra" sent one request for
  the burst. The options shown were the final query's in every run.
- **(d) double Save and double Publish.** The second click on Save hits a disabled button (one `PUT`); the second
  click on Publish does not (two `POST .../actions/publish`, an `identical-in-flight` witness in every run, fifo
  and seeded alike, and two "Published document" notifications): section 5. The final state is the same in every
  order.
- **(e) pagination.** Three clicks on "Go to next page" before the first response lands: the final list was page 4
  in every run. Keyed cache again.

The interaction scenarios' verdicts are not all "no race" in the report's own words: GenClass flagged internal
fields of RTK Query that change with every arrival order, and once a request id it redacts only when the random
string holds a digit (section 6). On those sessions the page was the same in every run, and the replay of the
flagged finding ended in the baseline's state. Those rows are false reports and are counted as such in section 6.

## 4. The finding

### 4.1 What explore saw

Session `load-list`, 600 ms (the 300 ms and 900 ms sessions are the same story). Baselines: both loads ended on the
list ("300 entries found", rows). Seeds 2 and 3 ended on `/admin/content-manager/403`. The report, reduced:

```
RACE: 2 of 6 reordered run(s) ended in a different state than the baseline (responses in request order).
- run r5 (seed 2):
    state redux.adminApi.queries.getContentTypeConfiguration("api::article.article").status: baseline "fulfilled", this run (absent)
    state redux.adminApi.queries.getAllDocuments({"model":"api::article.article",...}).status: baseline "fulfilled", this run (absent)
    page text only in the baseline: "Article", "Back", ...
    page text only in this run: "Content Manager", "You don't have the permissions to access that content"
```

`genclass_explain` of the finding, the evidence in causal order (times from `connectAgent`; the schedule's holds in
brackets; the delivery order of seed 2):

```
+2.931s send   GET /content-manager/init#2                       (a refetch: refetchOnMountOrArgChange)
+2.950s write  HistoryProvider.state0.currentLocation: ".../collection-types/api::article.article" → ".../content-manager/403"
+3.424s recv   GET /content-manager/init#2                       (held 428 ms)
+3.485s recv   GET /admin/users/me/permissions#1                 (held 2.2 s)
+3.489s write  redux.adminApi.queries.getMyPermissions(undefined).data: undefined → 97 items   by GET /admin/users/me/permissions#1
+3.513s write  redux.content-manager.app.collectionTypeLinks: 0 items → 4 items                 by GET /admin/users/me/permissions#1
Delivery order: GET /admin/project-type#1 → GET /admin/users/me#1 → GET /admin/init#1 → GET /admin/information#1
  → GET /content-manager/content-types-settings#1 → GET /admin/guided-tour-meta#1 → GET /content-manager/init#1
  → GET /content-manager/init#2 → GET /admin/license-limit-information#1 → GET /admin/users/me/permissions#1 → ...
```

So: the Content Manager's two init responses arrived, the admin navigated to the 403 page at +2.950 s, and the
permissions arrived half a second later, filled in the four authorised content types, and changed nothing the user
could see. In the fifo baselines `/admin/users/me/permissions#1` (requested at app start) is delivered before
`/content-manager/init#1` (requested when the Content Manager mounts), so the links are authorised against the
loaded permissions.

The replay (`genclass_replay arm` with the finding, one load, `result`): "REPRODUCED · ended with the same wrong
values as the failing run", at 300 ms (run r9 of finding f2) and 600 ms (run r18 of finding f3).

### 4.2 Reproduction without GenClass

`docs/adoption/hunts/strapi/repro-403.mjs`: a logged-in context, `context.route` delaying only the response to
`GET /admin/users/me/permissions` by 1,500 ms (nothing else is touched), `page.goto` of the list URL, then whichever
comes first: a table row or the 403 text.

```
permissions delayed 0 ms, trial 1..3:    list (/admin/content-manager/collection-types/api::article.article)
permissions delayed 1500 ms, trial 1..3: 403 page (/admin/content-manager/403)
```

### 4.3 Root cause (file paths and lines at `c04f9bc085eb06219fa7707a484159bed60fce68`)

1. `packages/core/admin/admin/src/features/Auth.tsx`, lines 183 to 191: `useGetMyPermissionsQuery` with
   `data: userPermissions = _defaultPermissions`, whose default is `[]` (line 45, `EMPTY_DEFAULT_PERMISSIONS`); lines
   532 to 544 pass `permissions={userPermissions}` and `isLoading={isLoadingUser || isLoadingPermissions}` to the
   context. While the request is pending the context says: no permissions, loading.
2. `packages/core/content-manager/admin/src/hooks/useContentManagerInitData.ts`, lines 186 to 207: the effect runs
   `formatData` as soon as `initialDataQuery.data` and `contentTypeSettingsQuery.data` exist. `formatData` (lines
   114 to 184) calls `authorizeLinks` (lines 46 to 61), which asks `checkUserHasPermissions` which of the links'
   permissions the user has; `Auth.tsx` lines 486 to 496 filter `actualUserPermissions` (the empty list) against
   them: nothing. `setInitialData` stores empty link lists and `isLoading: false` (`modules/app.ts`, line 58).
3. `packages/core/content-manager/admin/src/layout.tsx`, lines 66 to 105: `authorisedModels.length === 0 &&
   supportedModelsToDisplay.length > 0` (the init data lists four displayed content types), no i18n locale in the
   query, so `<Navigate to="/content-manager/403" replace />` (line 104).
4. The permissions arrive; `checkUserHasPermissions` is a `useCallback` on `userPermissions` (`Auth.tsx` line 457),
   so its identity changes, `formatData` runs again and dispatches the four links. The router is on
   `/content-manager/403`; the redirect to the first authorised model (lines 113 to 118) excludes that path, so the
   page stays.

Related: strapi/strapi#20332 (May 2024, Strapi 5 beta: "You don't have permission" on a fresh install until a
refresh, confirmed, closed in June 2024 as fixed by #20609, a batch of admin fixes that moved auth state into the
Redux store). The ordering case is still in 5.59.0.

### 4.4 The fix

`strapi.patch` (12 added lines in the hook, one new e2e spec), in Strapi's style: `useContentManagerInitData` reads
`isLoading` from the auth context and returns from the effect while it is true, with `isLoadingPermissions` in the
effect's dependencies, so `formatData` first runs with the loaded permissions and the Layout keeps `Page.Loading`
until then. A user whose loaded permissions cover no content type still gets the 403 page.

Applied here to the installed package, line for line (`dist/admin/hooks/useContentManagerInitData.{mjs,js}` of
`@strapi/content-manager` 5.59.0, then Vite's dependency cache `node_modules/.strapi/vite/deps` removed and
`strapi develop` restarted), since the admin is pre-bundled from `node_modules` rather than built from the monorepo.

### 4.5 Test and fixed-variant check

`tests/e2e/tests/content-manager/permissions-loading.spec.ts` (in the patch), in the style of
`tests/e2e/tests/content-manager/listview.spec.ts`: `resetDatabaseAndImportDataFromPath('with-admin')`, `login`,
`page.route` delaying the permissions response by 1,500 ms, `page.goto` of the Article list URL, then expect the
"Article" heading, a URL that is not `/content-manager/403`, and no 403 text. Run here with Playwright's runner
through `docs/adoption/hunts/strapi/e2e/` (the spec unchanged; Strapi's `login` and `dts-import` helpers replaced by
two stand-ins, since the monorepo's harness was not installed):

<!-- E2E RESULTS -->

<!-- FIXED RESULTS -->

## 5. A second observation: a double click on Publish sends two publish requests

In every `double-save` run (fifo and seeded), `click button "Publish" x2` was followed by two
`POST /content-manager/collection-types/api::article.article/:id/actions/publish` (`identical-in-flight` witness:
same method, URL and body, in flight together, from two clicks) and two "Published document" notifications, while
the double click on Save sent one `PUT` (its second click hit a disabled button and was not recorded as an action).
Both buttons are disabled through the form's `isSubmitting` (`DocumentActions.tsx`: `PublishAction` line 1067,
`UpdateAction` line 1293) and both handlers call `setSubmitting(true)` first (`performPublish` line 857,
`handleUpdate` line 1297), so the difference was not expected from the source and is reported as observed, without
a root cause. <!-- PUBLISH PROBE --> The final state is the same whatever the order, so it is not a race; a second
publish does fire the `entry.publish` webhook again. It is in `strapi-issue.md` as a note, not in the patch.

## 6. Problems with GenClass itself

Recorded as they were hit; none changed the finding.

1. **False reports from RTK Query's bookkeeping (explore, witnesses).** The admin's Redux store holds RTK Query's
   internals: `redux.adminApi.provided.<tag>.<id>` (arrays of cache keys, appended in arrival order),
   `redux.adminApi.subscriptions.*`, `queries.*.requestId`, `startedTimeStamp`, `fulfilledTimeStamp`. Their final
   values depend on the response order by construction, with nothing visible attached. On the pagination sessions
   explore reported "no reordered run ended differently, but 6 of 6 had an older response overwrite newer data"
   (600 ms) and a race in 1 of 6 (300 ms), the witnesses being `overwrote-newer redux.adminApi.provided.Document.ALL_LIST by GET /content-manager/collection-types/...` and the like; runs recorded 18 to 74 witnesses each,
   the baselines included (33 each). The DOM oracle: 0 of 6 differing. The replay of the 300 ms finding: "not
   reproduced · ended with the values of the request-order baseline"; of the 600 ms finding: "REPRODUCED · the older
   response overwrote newer data again", which is the same bookkeeping again. Suggestion: ignore, by default, the
   Redux Toolkit Query slices `provided`, `subscriptions` and `config`, and the per-query `requestId`,
   `startedTimeStamp` and `fulfilledTimeStamp` fields, for both the comparison and the witnesses; and read an
   `overwrote-newer` on a field whose value is a set of ids as a reorder, not an overwrite.
2. **A redaction that depends on the random value.** `AuthProvider.external2.requestId` (an RTK Query hook result
   under a component whose name holds "auth") was `"[redacted]"` in one baseline and a plain string in a seeded run,
   and the explore counted the difference as a race (pagination, 300 ms, run r7). `util.ts` `isSensitivePath`:
   under a broad container (`auth`) a string is redacted when it looks opaque (`OPAQUE`: at least 20 characters,
   letters and digits); RTK Query's 21-character request ids sometimes contain a digit and sometimes do not.
   Suggestion: treat a `[redacted]` against a value as noise in the comparison, or redact by path only for the
   comparison.
3. **The snapshot's 300-field cap.** `src/agent/index.ts` stops `snapshot()` at 300 store leaves (`n++ >= 300`);
   every Strapi snapshot hit it (`stateFields: 300`), so which fields a run's snapshot holds depends on the order
   the hub lists them in, and the admin's store is several thousand leaves. The 403 finding was still visible
   because the page text differed too. Suggestion: raise the cap for the comparison, or prefer registered and
   component state over discovered Redux internals when truncating.
4. **Chromium's Local Network Access check.** A document that Playwright `route.fulfill`s has no address space of
   its own, and Chromium refused the page's `fetch` to the loopback bridge: "Permission was denied for this request
   to access the loopback address space". Not a GenClass bug (a page served from localhost is unaffected), but the
   first thing an agent injecting the runtime this way hits; the harness passes
   `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessForWorkers`.
5. **No agent entry in the script-tag build** (AGENT.md section 8 says so): the harness pairs the IIFE with the ESM
   `agent.js` through a module script, which worked; `window.GenClass.runtime` is the runtime `connectAgent` needs.
6. **Harness, not GenClass: the saved admin session expires.** The admin's access token lasts 30 minutes and the
   saved refresh cookie does not survive its rotation, so about 30 minutes after the login every load landed on the
   login page and the `ready` wait ran out: one batch (the 900 ms deep-link session and the first interaction
   sessions) was discarded and run again with the harness logging in afresh at the start of every session. Only
   sessions whose 8 loads all reached a quiet point are in the table.
7. **No console errors from the runtime** on any load. The admin's own console carried its React Router future-flag
   warning, `useRBAC` deprecation warnings, a styled-components unknown-prop warning on the edit view, and 404s for
   two optional endpoints (`/:id/ai-localization-jobs/...`, a plugin probe), on every load alike.

## 7. Time spent

<!-- TIME -->
