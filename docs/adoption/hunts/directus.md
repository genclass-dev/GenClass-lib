# Race hunt: Directus Studio (v12.5.1)

Evidence for the owner to write an issue from, in the owner's own words (facts in
[directus-facts.md](directus-facts.md)). Nothing was sent to directus/directus: no fork, push, issue, PR or comment.
Everything here was run locally in a cloud container on 2026-10-24 and 2026-10-25.

## Headline

**The Studio's item view can show the item you just left under the URL of the item you are on, and Save then writes
that other item's text into the current one for every field you edit.**

- Path: open article 1 from the Articles list, click "Navigate to Item" on a relational (M2O) field to go to article 2,
  then click the header back arrow. Directus designed this path (the back arrow calls `router.back()` "so the user
  returns to ... the parent item when navigating via a relation", `item.vue` lines 809-815). The item view component is
  reused, `getItem()` refires, and nothing discards the response for article 2 when it arrives after article 1's.
- Found with GenClass explore: across 12 settings (gap between the clicks 50 to 300 ms, extra latency `slow_ms` 300,
  600, 900), **72 of 72** reordered runs ended differently from the in-order baselines; by what the page showed:
  **29 stale form** (article 2's title, summary, status, topic under `/admin/content/articles/1`), 15 stale header
  title only, 12 stale relation display only, 16 request counts only (not a stale view). Baselines: 24 of 24 right.
- Confirmed without GenClass (plain Playwright, one `page.route` delay on article 2's requests, no injected code):
  stale form in **0 of 12** runs with no delay, **7 of 14** with 300 ms, **12 of 12** with 600 ms, **12 of 12** with
  900 ms.
- Save: Save always PATCHes the item in the URL and sends only edited fields. Appending a sentence to the Summary
  shown wrote `"Bravo body: what failed on Tuesday. Reviewed."` (article 2's summary plus the edit) into **article 1**
  in the database, 3 of 3. Replacing the whole Title wrote only the typed title, 3 of 3. Unedited fields were never
  written. So the severe case is real, and limited to the fields the user edits on top of the stale values.
- Same unguarded pattern, also found: the header title (`use-template-data.ts`) and the M2O display
  (`use-relation-single.ts`) on the same navigation, and the `input-autocomplete-api` suggestions (menu showed
  suggestions for "re" while "rea" was typed in **12 of 36** reordered runs). The Related picker drawer: no race
  (0 of 18).
- Fix: a generation counter in `getItem()` (house style: `getItemCount` in `packages/composables/src/use-items.ts`),
  plus the same guard in the three siblings (a monotonic variant for the autocomplete, section 11.2). 6 new vitest
  tests: all fail before, all pass after. Fixed variant: **0 stale forms in 24 reordered runs** with the `use-item`
  guard alone; with all four guards **0 stale views of any kind** (form, header, display) in 24 and 0 stale
  autocomplete menus in 18; the plain check found 0 stale in 47 runs, and Save wrote article 1's own text.
- GenClass itself still reports "RACE" on the fixed build, because its explore verdict compares per-signature request
  counts and the fixed app (correctly) skips follow-up requests for the discarded response. That is a false report by
  GenClass, counted in section 11 and raised as a GenClass follow-up.

## 1. Target and environment

| what | version |
|---|---|
| Directus | 12.5.1, tag `v12.5.1`, commit `2cd112f1a1afe42829d2e4de899d07ce4394649c` (2026-10-23); `@directus/app` 18.1.1, `@directus/api` 40.0.1 |
| License | MSCL-1.0-GPL (Directus's own) |
| App stack | Vue 3.5.43, vue-router 4.6.3, Vite 8.1.2 dev server (`cd app && pnpm dev`, :8080, `/admin`), SDK on `ofetch` 1.5.1, `axios` 1.20.0, `p-queue` 8.1.x |
| API | `pnpm --filter api dev` on 127.0.0.1:8055, SQLite (`sqlite3` 6.0.1), `RATE_LIMITER_ENABLED=false`, `CACHE_ENABLED=false`, websockets off (the defaults) |
| Runtime | Node 22.22.0, pnpm 10.27.0 (from `packageManager`), Ubuntu 24.04.5, Linux 6.18 |
| Browser | Chromium headless shell 153.0.8010.12 through Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.1 (script-tag build `dist/genclass.global.js` + `dist/agent.js`) and `@genclass/mcp` 0.1.0, GenClass-lib `d77ffd8` |

The brief said Node 26 and pnpm 12. The repository says otherwise: `package.json` has `"engines": { "node": "22",
"pnpm": ">=10 <11" }`, `.npmrc` has `engine-strict=true`, and `packageManager` is `pnpm@10.27.0`. It was run with Node
22.22.0 and pnpm 10.27.0.

## 2. Commands

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Playwright 1.63.0's Chromium was already installed in the container (/opt/pw-browsers), so no `playwright install`

# Directus
git clone --depth 1 --branch v12.5.1 https://github.com/directus/directus.git && cd directus
CI=true pnpm install --frozen-lockfile        # 22 s
pnpm build                                    # 53 s
cat > api/.env <<'ENV'
HOST=127.0.0.1
PORT=8055
PUBLIC_URL=http://localhost:8080
DB_CLIENT=sqlite3
DB_FILENAME=./data.db
SECRET=<any>
ADMIN_EMAIL=admin@example.com      # the scripts below log in with these two (local, throwaway)
ADMIN_PASSWORD=hunt-admin-pw
TELEMETRY=false
CACHE_ENABLED=false
RATE_LIMITER_ENABLED=false
ENV
pnpm --filter api cli bootstrap
pnpm --filter api dev                         # API on :8055
cd app && pnpm dev                            # Vite on :8080/admin, proxies everything else to :8055

# schema and data (directus/ next to this file)
node docs/adoption/hunts/directus/setup-schema.mjs
node docs/adoption/hunts/directus/setup-related.mjs

# GenClass explore, one session (2 fifo baselines + 6 seeded orders)
node docs/adoption/hunts/directus/gc-harness.mjs --scenario nav-back --gap 100 --slow 600 --runs 6 --out out.json
# the same check without GenClass
node docs/adoption/hunts/directus/confirm-plain.mjs --delay 600 --gap 100 --repeat 3
node docs/adoption/hunts/directus/confirm-plain.mjs --delay 600 --gap 100 --repeat 3 --save summary
```

From clone to a running Studio with the schema took under 30 minutes (install 22 s, build 53 s). The runs below took
about 3 hours of wall clock (each GenClass session is 9 page loads, about 4 minutes).

Two Studio prompts block clicks on a fresh project (license onboarding, project owner). Both are dismissed with the
cookies their own "Skip" and "Remind Later" buttons set: `license-onboarding-dismissed`, `license-banner-dismissed`,
`license-login-modal-dismissed`.

## 3. Schema and data

Created through the API by `directus/setup-schema.mjs` and `directus/setup-related.mjs`; the exported snapshot is
[directus/schema-snapshot.yaml](directus/schema-snapshot.yaml) (Settings > Data Model export, `GET /schema/snapshot`).

| collection | fields |
|---|---|
| `articles` | `id` (integer, auto), `title` (string, input), `summary` (text, input-multiline), `status` (select-dropdown: draft, review, published), `topic` (string, `input-autocomplete-api` on `/items/tags?filter[name][_istarts_with]={{value}}&fields=name&limit=10`, default throttle 500 ms), `author` (M2O -> `authors`, select-dropdown-m2o), `related` (M2O -> `articles`, select-dropdown-m2o with `enableLink: true`, the "Navigate to Item" link) |
| `authors` | `id`, `name` (5 rows) |
| `tags` | `id`, `name` (20 rows: react, reactive, reactor, realtime, redis, regex, rest, rust, ...) |

Six articles, "Alpha: launch checklist" (1) to "Foxtrot: roadmap" (6); `related` chains 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 1.
Article 1: summary "Alpha body: the steps before a launch.", status draft, topic rest, author Ada Lovelace, related
Bravo. Article 2: "Bravo: incident review", summary "Bravo body: what failed on Tuesday.", status review, topic redis,
author Grace Hopper, related Charlie.

## 4. The scenario

Only user-level actions; no route is pushed by script.

1. Load `/admin/content/articles` (the list).
2. Click the row "Alpha: launch checklist" -> `/admin/content/articles/1`; wait until it has loaded.
3. Click "Navigate to Item" (the launch icon) on the Related field -> `/admin/content/articles/2`.
4. After `--gap` ms, click the header back arrow -> `router.back()` -> `/admin/content/articles/1`.
5. Wait for a quiet point and read the form.

Why the list first: when article 1 is a direct landing, the back arrow's target is computed once
(`backRoute = computed(() => history.state?.back ? undefined : collectionRoute.value)`, `item.vue` lines 812-815) and
`history.state` is not reactive, so after the relation link it still points at the list. Side observation (not a race;
3 of 3 runs of an early smoke session that started on a directly loaded article 1): Related link then back arrow went
to the list instead of back to the item, which is not what the comment above it intends.

The same component instance serves both URLs: the item route is `{ name: 'content-item', path: ':primaryKey',
component: Item, props: true }` (`modules/content/index.ts` lines 278-281) under an unkeyed `<RouterView>`
(`app.vue` line 136, `utils/router-passthrough.ts`), so `useItem(collection, primaryKeyParam, ...)` (`item.vue` line
201) is not recreated and `watch([collection, primaryKey], refresh)` refires `getItem()`.

## 5. The GenClass harness

`directus/gc-harness.mjs`. The Studio is not modified; everything is done from the test:

- **Injection.** `page.route` serves the built runtime under a virtual path `/__genclass/` and rewrites the Studio's
  `index.html` to load, first in `<head>`: `genclass.global.js` with `data-manual`, an inline
  `GenClass.init({ model: false, report: "silent", telemetry: false })` (model skipped, telemetry off), and a module
  that imports `/__genclass/agent.js` and calls `connectAgent(rt)` (the agent entry has no static import of runtime
  code, so it works with the script-tag runtime). `__GENCLASS_AGENT_URL__` points at an in-process MCP server's bridge
  on a free port, driven over stdio exactly like `packages/mcp/test/e2e/race.e2e.mjs`.
- **State.** Vue state is not discovered, so the boot module registers `rt.atom("directus.form", ...)` and mirrors the
  visible form into it on every animation frame: one key per `.field[data-field]` (input value, or the interface's
  text for M2O fields), the header title and the route. Snapshots also carry the page text and form values.
- **Two environment workarounds**, both test-side only:
  1. Chromium 153 treats a document fulfilled by `page.route` as public, and its Local Network Access checks then block
     the page's calls to the loopback bridge (and Vite's websocket): `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. The
     harness launches Chromium with `--disable-features=LocalNetworkAccessChecks,...`. The plain confirmation (section
     7) uses no flag and no route on the document.
  2. Directus's `vite.config.js` always loads the Vue DevTools overlay; its 120 ms `setInterval` kept every run from
     reaching a quiet point (30 s per settle). The harness drops the overlay's two `<script>` tags from the served page.
- **Explore.** `genclass_explore { action: "start", runs: 6, route: "/admin/content/articles", slow_ms }`, then 8 page
  loads of the scenario (2 fifo baselines, 6 seeded orders), then `report`, `explain` and `findings`. One warm-up load
  before each session is not part of it.
- **Reading the verdict.** GenClass counts a run as a race when anything in its final state differs from the
  baselines: a store field, a form value, page text, **or the number of requests sent per signature**. The tables
  below therefore split each reordered run by what the user would see (`directus/classify.py`,
  `directus/make-tables.py`): stale form (title, summary, status or topic differ), stale header only, stale M2O
  display only, request counts only, witness only.

## 6. Verdicts (buggy build)

### 6.1 Item navigation (relation link, then back arrow)

| slow_ms | gap ms | GenClass verdict | stale form | stale header only | stale M2O display only | request counts only | witness only | same as baseline | baselines right |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 300 | 50 | 6 of 6 | 2 | 2 | 1 | 1 | 0 | 0 | 2 of 2 |
| 300 | 100 | 6 of 6 | 3 | 1 | 1 | 1 | 0 | 0 | 2 of 2 |
| 300 | 200 | 6 of 6 | 2 | 1 | 1 | 2 | 0 | 0 | 2 of 2 |
| 300 | 300 | 6 of 6 | 3 | 1 | 1 | 1 | 0 | 0 | 2 of 2 |
| 600 | 50 | 6 of 6 | 2 | 2 | 1 | 1 | 0 | 0 | 2 of 2 |
| 600 | 100 | 6 of 6 | 2 | 1 | 1 | 2 | 0 | 0 | 2 of 2 |
| 600 | 200 | 6 of 6 | 2 | 2 | 1 | 1 | 0 | 0 | 2 of 2 |
| 600 | 300 | 6 of 6 | 2 | 1 | 1 | 2 | 0 | 0 | 2 of 2 |
| 900 | 50 | 6 of 6 | 3 | 1 | 1 | 1 | 0 | 0 | 2 of 2 |
| 900 | 100 | 6 of 6 | 3 | 1 | 1 | 1 | 0 | 0 | 2 of 2 |
| 900 | 200 | 6 of 6 | 2 | 1 | 1 | 2 | 0 | 0 | 2 of 2 |
| 900 | 300 | 6 of 6 | 3 | 1 | 1 | 1 | 0 | 0 | 2 of 2 |
| **all** | | | **29** of 72 | 15 | 12 | 16 | 0 | 0 | 24 of 24 |

Per seed (`*`: some holds ran out, the run did not follow its schedule exactly; GenClass says so in its report):

| session (slow_ms, gap) | seed 1 | seed 2 | seed 3 | seed 4 | seed 5 | seed 6 |
|---|---|---|---|---|---|---|
| 300, 50 | form | header* | counts* | display* | form* | header |
| 300, 100 | form | counts* | form* | display* | form* | header |
| 300, 200 | form | counts* | counts* | display* | form* | header |
| 300, 300 | form | counts* | form* | display* | form* | header* |
| 600, 50 | form* | header* | counts* | display* | form* | header |
| 600, 100 | form* | counts* | counts* | display* | form* | header |
| 600, 200 | form* | header* | counts* | display* | form* | header* |
| 600, 300 | form* | counts* | counts* | display* | form* | header* |
| 900, 50 | form* | counts* | form* | display* | form* | header* |
| 900, 100 | form* | counts* | form* | display* | form* | header* |
| 900, 200 | form* | counts* | counts* | display* | form* | header* |
| 900, 300 | form* | counts* | form* | display* | form* | header* |

Honest reading: every session uses seeds 1 to 6, and the seed largely decides the order (seeds 1 and 5 give a stale
form in all 12 sessions, seed 4 a stale display, seed 6 a stale header). The 12 sessions are a robustness check over
gap and latency, not 72 independent trials. A first session (gap 100, `slow_ms` 0, 1 seeded run) gave the same stale
form; its timeline is the evidence in 6.4.

### 6.2 Related picker (two selections in quick succession)

Open the Related field's "Select Item" drawer, choose Delta, Save; 100 ms later reopen it, choose Echo, Save.

| slow_ms | gap ms | GenClass verdict | final Related display (all 8 loads) |
|---:|---:|---|---|
| 300 | 100 | no race (0 of 6) | Echo: security notes |
| 600 | 100 | no race (0 of 6) | Echo: security notes |
| 900 | 100 | no race (0 of 6) | Echo: security notes |

Negative. Whether the two `getDisplayItem()` requests overlapped was not measured; between the two choices the
drawer closes and reopens (each of these page loads took 7 to 9 s), which makes overlap unlikely at these latencies.
The code has the same missing guard (section 9); its effect shows on the navigation path instead (the "stale M2O
display" column above).

### 6.3 Autocomplete interface (`input-autocomplete-api`)

Clear the Topic field, wait 600 ms (the 500 ms throttle window), type "rea" at the gap. The menu opens after
`await onInput(value)` resolves; an older, slower response can then replace the list while it is open.

| slow_ms | gap ms | GenClass verdict | seeded runs whose menu lists tags not starting with "rea" | seeded runs with no menu | baselines' menus |
|---:|---:|---|---:|---:|---|
| 300 | 250 | 2 of 6 | 2 of 6 | 0 of 6 | 4 items, 4 items |
| 300 | 600 | no race (0 of 6) | 0 of 6 | 0 of 6 | 4 items, 4 items |
| 600 | 250 | 2 of 6 | 2 of 6 | 0 of 6 | 4 items, 4 items |
| 600 | 600 | 2 of 6 | 2 of 6 | 0 of 6 | 4 items, 4 items |
| 900 | 250 | 3 of 6 | 3 of 6 | 0 of 6 | 4 items, 4 items |
| 900 | 600 | 3 of 6 | 3 of 6 | 0 of 6 | 4 items, 4 items |
| **all** | | | **12 of 36** | 0 of 36 | |

The stale menus list 7 tags (the answer for "re": adds redis, regex, rest) or 10 (the answer for "r") while the input
says "rea". Low severity: suggestions only; picking one sets the field to that tag. Not confirmed without GenClass.

### 6.4 Evidence: one run in causal order

From `genclass_explain` of the first race (seed 1, gap 100, no extra latency), times from `connectAgent`:

```
+ 9.895s action 1: click link                                   ("Navigate to Item" on Related)
+ 9.949s send GET /items/articles/:id#3 (action 1)              (article 2)
+10.125s action 2: click button                                 (header back arrow)
+10.160s send GET /items/articles/:id#5 (action 2)              (article 1)
+10.216s delivered GET /items/articles/:id#5                    (article 1 arrives first)
+10.284s write directus.form.title: "" -> "Alpha: launch checklist"
+10.960s delivered GET /items/articles/:id#3 (held 954 ms)      (article 2 arrives last)
+10.985s write directus.form.title: "Alpha: launch checklist" -> "Bravo: incident review"
final: URL /admin/content/articles/1, header "Articles: Alpha: launch checklist",
       form title "Bravo: incident review", summary "Bravo body: what failed on Tuesday.", topic "redis",
       related "Charlie: pricing page"
```

The schedule only chose when the already-received response for article 2 was handed to the app; nothing was changed
or invented. Without GenClass the same order comes from a slower response for article 2 (section 7).

## 7. Confirmation without GenClass

`directus/confirm-plain.mjs`: plain Playwright, no injected script, no browser flags, no route on the document. The
only intervention is `page.route(/\/items\/articles\/2(\?|$)/)` holding article 2's GET requests for the given delay,
armed after article 1 has loaded (a slow response for that item, as with a heavier record or a busy server). Same
clicks as section 4. Stale = URL `/articles/1` and the Title input not "Alpha: launch checklist".

| article 2 response delayed by (ms) | gap between the clicks (ms) | back click measured at (ms after the relation click) | stale form under /articles/1 |
|---:|---:|---|---:|
| 0 | 50 | 184, 163, 157 | 0 of 3 |
| 0 | 100 | 207, 239, 211 | 0 of 3 |
| 0 | 200 | 328, 336, 328 | 0 of 3 |
| 0 | 300 | 438, 418, 439 | 0 of 3 |
| 300 | 50 | 173, 158, 168 | 3 of 3 |
| 300 | 100 | 255, 237, 207 | 3 of 3 |
| 300 | 200 | 313, 334, 341 | 1 of 3 |
| 300 | 300 | 422, 420, 446, 428, 406 | 0 of 5 |
| 600 | 50 | 136, 168, 150 | 3 of 3 |
| 600 | 100 | 209, 211, 209 | 3 of 3 |
| 600 | 200 | 359, 346, 302 | 3 of 3 |
| 600 | 300 | 409, 421, 452 | 3 of 3 |
| 900 | 50 | 176, 172, 162 | 3 of 3 |
| 900 | 100 | 205, 257, 223 | 3 of 3 |
| 900 | 200 | 304, 327, 302 | 3 of 3 |
| 900 | 300 | 426, 413, 394 | 3 of 3 |

By delay: 0 ms: 0 of 12; 300 ms: 7 of 14; 600 ms: 12 of 12; 900 ms: 12 of 12. The rule it follows: stale whenever
article 2's response lands after the back click's request for article 1 has answered. (The 300 ms / 300 ms row has 5
runs: a first invocation crashed on a list-page load timeout after 2 runs and was run again.)

Request and response times of one stale run (delay 600, gap 100), ms after the relation click:

| event | ms |
|---|---:|
| `GET /items/articles/2` sent | 86 |
| back arrow clicked | 209 |
| `GET /items/articles/1` sent | 300 |
| `GET /items/articles/1` answered | 341 |
| `GET /items/articles/2` answered (held 600 ms) | 714 |
| final form | title "Bravo: incident review", summary "Bravo body: what failed on Tuesday.", header "Articles: Bravo: incident review" under `/admin/content/articles/1` |

## 8. Does Save write the stale values?

After the stale state (delay 600, gap 100), the user edits one field and clicks Save (the default save action,
save-and-quit). The PATCH is captured and both articles are read back from the API; the seed is restored after each
run.

| edit | runs | PATCH | body | article 1 in the database after | article 2 after |
|---|---:|---|---|---|---|
| append " Reviewed." to the Summary shown | 3 of 3 | `/items/articles/1` | `{"summary": "Bravo body: what failed on Tuesday. Reviewed."}` | title "Alpha: launch checklist", **summary "Bravo body: what failed on Tuesday. Reviewed."** | unchanged |
| replace the Title (select all, type) | 3 of 3 | `/items/articles/1` | `{"title": "Alpha: launch checklist v2"}` | title "Alpha: launch checklist v2", summary unchanged | unchanged |

Why: `save()` sends `editsWithClearedValues` (the edits only) to `itemEndpoint`, which is built from the current
`primaryKey` (`use-item/index.ts` lines 106-112, 171-225). The URL is right, so the write goes to article 1; an edited
field's value is whatever the user changed in the input, and the input held article 2's value. Not tested: fields
cleared by conditions (`clearHiddenFieldsByCondition(edits, fields, defaults, item.value)` reads the stale
`item.value`), relational edits, and content versions (autosave only runs on versions, `use-auto-save.ts` line 30).

## 9. Root cause

At tag `v12.5.1`:

- `app/src/composables/use-item/index.ts` lines 151-169, `getItem()`: awaits `sdk.request(...)` and then calls
  `setItemValueToResponse(item)` unconditionally; no AbortController, no generation counter, no key check. Its
  `finally` also clears `loadingItem` when an older request ends, while the newer one is still in flight.
- Line 116, `watch([collection, primaryKey], refresh)`; lines 543-565, `refresh()` sets `item.value = null` and calls
  `getItem()` again, but does not invalidate the request already in flight.
- The component is reused: unkeyed `<RouterView>` (`app/src/app.vue` line 136, `app/src/utils/router-passthrough.ts`),
  item route `:primaryKey` with `props: true` (`app/src/modules/content/index.ts` lines 278-281).
- Siblings with the same shape on the same navigation:
  - `app/src/composables/use-template-data.ts` lines 64-100, `fetchTemplateValues()` (the header title);
  - `app/src/composables/use-relation-single.ts` lines 63-124, `getDisplayItem()` (M2O display);
  - `app/src/interfaces/input-autocomplete-api/input-autocomplete-api.vue` lines 43-74, `fetchResultsRaw()`.
- Directus already guards the same situation elsewhere: `app/src/composables/use-relation-multiple.ts` lines 510-517
  ("This can happen if the user navigates to a different item while the request is in progress"), and
  `packages/composables/src/use-items.ts` `getTotalCount` / `getItemCount` (lines 87-88, 309-358) with generation
  counters ("prevents race conditions when navigating between collections quickly").

## 10. The fix

[directus.patch](directus.patch), against `v12.5.1`, in the house style of `getItemCount` (a counter per composable,
`const currentGeneration = ++xGeneration`, discard when it moved, clear `loading` only for the current generation):

| file | change | test |
|---|---|---|
| `app/src/composables/use-item/index.ts` | generation counter in `getItem()` (result, error and `loadingItem`); `refreshItem()` also invalidates when switching to a new item (`+`), which sends no request | `index.test.ts`, "Stale item responses": 3 tests |
| `app/src/composables/use-template-data.ts` | same in `fetchTemplateValues()` | `use-template-data.test.ts`: 1 test |
| `app/src/composables/use-relation-single.ts` | same in `getDisplayItem()` | `use-relation-single.test.ts`: 1 test |
| `app/src/interfaces/input-autocomplete-api/input-autocomplete-api.vue` | in `fetchResultsRaw()`, skip a response older than the last one applied (a discard-every-superseded guard left the menu closed in 3 of 18 runs, section 11.2) | new `input-autocomplete-api.test.ts`: 1 test |

The `use-item` hunk is the fix for the reported bug; the other three are independent and can be split off. The `+`
invalidation is covered by a unit test only; it was not observed in the UI.

Tests (`cd app && npx vitest run <files>`, vitest 4.1.11):

| | `use-item/index.test.ts` | the 3 sibling test files |
|---|---|---|
| unfixed source, new tests added | 3 failed, 24 passed: `expected { id: 1, title: 'First' } to deeply equal { id: 2, title: 'Second' }`; `expected { id: 1, title: 'First' } to be null` (twice) | 3 failed, 10 passed: previous value's data wins in each (`Tenant A`, `First`, `['react', 'redis']`) |
| fixed source | 27 passed | 13 passed |
| whole app suite, fixed source (`npx vitest run` in `app/`) | 355 test files, 112,721 tests passed, 1 todo (390 s) | |

Prettier (`npx prettier --check`) and ESLint (`npx eslint`) pass on all changed files. The app's `typecheck` script
(`vue-tsc --noEmit`, which needs `NODE_OPTIONS=--max-old-space-size=8192` here) reports 445 errors on unpatched
`v12.5.1` and the same 445 with the patch (identical once line numbers are ignored; the two in changed files, TS7030 on
`save()` and a prop type in the autocomplete template, exist before the patch and only moved down).

## 11. Fixed-variant check

Same harness, same scenario, same seeds, on the patched Studio (Vite served the patched modules). The 11.2 navigation
sessions ran before the autocomplete guard was changed to its final form; that scenario does not type into the
autocomplete field.

### 11.1 `use-item` guard only

| slow_ms | gap ms | GenClass verdict | stale form | stale header only | stale M2O display only | request counts only | witness only | same as baseline | baselines right |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 300 | 50 | 6 of 6 | 0 | 1 | 0 | 5 | 0 | 0 | 2 of 2 |
| 300 | 300 | 6 of 6 | 0 | 1 | 0 | 5 | 0 | 0 | 2 of 2 |
| 600 | 100 | 4 of 6 (+2 ended right with a witness) | 0 | 1 | 0 | 3 | 2 | 0 | 2 of 2 |
| 900 | 200 | 4 of 6 (+1 ended right with a witness) | 0 | 1 | 0 | 3 | 1 | 1 | 2 of 2 |
| **all** | | | **0** of 24 | 4 | 0 | 16 | 3 | 1 | 8 of 8 |

The stale form is gone (29 of 72 before, 0 of 24 after). The header (seed 6, every session) is the separate
`use-template-data` race. The rest differ only in request counts or in a witness (identical `GET /comments`,
`/shares`, `/revisions` from the two clicks), not in what the page shows.

### 11.2 All four guards

| slow_ms | gap ms | GenClass verdict | stale form | stale header only | stale M2O display only | request counts only | witness only | same as baseline | baselines right |
|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 300 | 50 | 4 of 6 (+2 ended right with a witness) | 0 | 0 | 0 | 4 | 2 | 0 | 2 of 2 |
| 300 | 300 | 5 of 6 | 0 | 0 | 0 | 5 | 0 | 1 | 2 of 2 |
| 600 | 100 | 4 of 6 (+2 ended right with a witness) | 0 | 0 | 0 | 4 | 2 | 0 | 2 of 2 |
| 900 | 200 | 4 of 6 (+2 ended right with a witness) | 0 | 0 | 0 | 4 | 2 | 0 | 2 of 2 |
| **all** | | | **0** of 24 | 0 | 0 | 17 | 6 | 1 | 8 of 8 |

Per seed:

| session (slow_ms, gap) | seed 1 | seed 2 | seed 3 | seed 4 | seed 5 | seed 6 |
|---|---|---|---|---|---|---|
| 300, 50 | counts | counts* | counts* | witness* | witness* | counts |
| 300, 300 | counts | counts* | counts* | counts* | counts* | same |
| 600, 100 | counts* | counts* | counts* | witness* | witness* | counts |
| 900, 200 | counts* | counts* | counts* | witness* | witness* | counts* |

No stale form, header or display in any run. What GenClass still reports is one fewer `GET /revisions` (or another
follow-up) than the baselines, or a duplicate-request witness; section 11.4.

Autocomplete, first version of its guard ("discard every superseded response", as in the other three files):

| slow_ms | gap ms | GenClass verdict | seeded runs whose menu lists tags not starting with "rea" | seeded runs with no menu | baselines' menus |
|---:|---:|---|---:|---:|---|
| 300 | 250 | 2 of 6 | 0 of 6 | 2 of 6 | 4 items, 4 items |
| 900 | 250 | 1 of 6 | 0 of 6 | 1 of 6 | 4 items, 4 items |
| 900 | 600 | no race (0 of 6) | 0 of 6 | 0 of 6 | 4 items, 4 items |
| **all** | | | **0 of 18** | 3 of 18 | |

No stale suggestions, but in 3 of 18 runs the menu stayed closed: `onValueChange` awaits the throttled call, which
returns the earlier request's promise, and opens the menu only if `results` is non-empty when that resolves; the
discarded earlier response left it empty, and the later results arrived with nobody to open the menu. That would make
the interface worse in some orders, so the guard in the patch skips only responses older than the last one applied:

| slow_ms | gap ms | GenClass verdict | seeded runs whose menu lists tags not starting with "rea" | seeded runs with no menu | baselines' menus |
|---:|---:|---|---:|---:|---|
| 300 | 250 | no race (0 of 6) | 0 of 6 | 0 of 6 | 4 items, 4 items |
| 900 | 250 | no race (0 of 6) | 0 of 6 | 0 of 6 | 4 items, 4 items |
| 900 | 600 | no race (0 of 6) | 0 of 6 | 0 of 6 | 4 items, 4 items |
| **all** | | | **0 of 18** | 0 of 18 | |

0 stale and 0 empty menus in 18 runs (buggy at the same three settings: 8 of 18 stale).

### 11.3 Plain confirmation and Save on the fixed build

| article 2 response delayed by (ms) | gap between the clicks (ms) | back click measured at (ms after the relation click) | stale form under /articles/1 |
|---:|---:|---|---:|
| 0 | 50 | 161, 183, 167 | 0 of 3 |
| 0 | 100 | 211, 186, 195 | 0 of 3 |
| 0 | 200 | 331, 317, 335 | 0 of 3 |
| 0 | 300 | 426, 406, 442 | 0 of 3 |
| 300 | 50 | 164, 152, 155 | 0 of 3 |
| 300 | 100 | 212, 228, 232 | 0 of 3 |
| 300 | 200 | 356, 317, 296 | 0 of 3 |
| 300 | 300 | 430, 418, 399 | 0 of 3 |
| 600 | 50 | 165, 164, 166 | 0 of 3 |
| 600 | 100 | 207, 229, 192 | 0 of 3 |
| 600 | 200 | 295, 302, 300 | 0 of 3 |
| 600 | 300 | 405, 409, 447 | 0 of 3 |
| 900 | 50 | 159, 183, 170 | 0 of 3 |
| 900 | 100 | 206, 208, 219 | 0 of 3 |
| 900 | 200 | 318, 351 | 0 of 2 |
| 900 | 300 | 417, 407, 392 | 0 of 3 |

By delay: 0 ms: 0 of 12; 300 ms: 0 of 12; 600 ms: 0 of 12; 900 ms: 0 of 11. Every one of the 47 runs showed URL
`/admin/content/articles/1`, title "Alpha: launch checklist" and header "Articles: Alpha: launch checklist" (the
900 ms / 200 ms row has 2 runs: one invocation crashed on the same list-page load timeout as in section 7).

Save on the fixed build (same edits as section 8):

| edit | runs | body | article 1 in the database after |
|---|---:|---|---|
| append " Reviewed." to the Summary shown | 3 of 3 | `{"summary": "Alpha body: the steps before a launch. Reviewed."}` | its own summary plus " Reviewed." |
| replace the Title | 3 of 3 | `{"title": "Alpha: launch checklist v2"}` | title changed, summary unchanged |

### 11.4 Why GenClass still says "RACE" on the fixed build

The remaining differences are follow-up requests that a response for article 2 triggers; GenClass's own timelines show
them sent "via" that response (the M2O displays' `GET /items/authors/:id` and `GET /items/articles/:id?fields=...`
after `GET /items/articles/:id`, a second `GET /revisions` after the first). A fifo baseline always hands article 2's
responses over first, so it always sends them. In a reordered run on the fixed build those responses arrive after the
back click, article 2's data is discarded, and the follow-ups are not sent (in 11.1 the M2O ones and `GET /revisions`,
in 11.2 only `GET /revisions`). GenClass compares "requests sent per signature" as part of the final state
(`packages/mcp/src/compare.ts`), so it reports a race where the fix is working. Separately, its summary line says "N
more ended right but had an older response overwrite newer data along the way" for any witness, while here the
witnesses are `identical-in-flight` (duplicate requests), not overwrites (`packages/mcp/src/tools.ts` lines 306-311).
False-report rate of the explore verdict on the all-guards build: **23 of 24** reordered runs flagged (17 by request
counts, 6 by a duplicate-request witness only), "RACE" in 4 of 4 sessions; for the autocomplete scenario 0 of 18.
Both are GenClass follow-ups, not Directus findings.

## 12. Limits

- One machine, one browser (Chromium), SQLite, the Vite dev server; the production build of the Studio was not run.
  The race is in app code that both builds share, but that was not measured.
- The GenClass harness needs two test-side workarounds (section 5). The plain confirmation needs neither.
- Seeds 1 to 6 in every session (section 6.1).
- Not done: a search of directus/directus issues for duplicates (outside this session's repository scope; terms are
  in the fact sheet); the picker and autocomplete races were not confirmed without GenClass; Save was tested on two
  field types only.
- Not run: Directus's API tests, e2e tests and the blackbox suite; only the app test files named above and the whole
  app suite (section 10).

## 13. Files

| file | what |
|---|---|
| [directus-facts.md](directus-facts.md) | fact sheet for the issue (steps, observed and expected, timings, environment, schema, links) |
| [directus.patch](directus.patch) | the fix and tests, `git apply` on `v12.5.1` |
| [directus/gc-harness.mjs](directus/gc-harness.mjs) | GenClass harness (injection, agent link, explore session) |
| [directus/confirm-plain.mjs](directus/confirm-plain.mjs) | plain Playwright confirmation and the Save check |
| [directus/setup-schema.mjs](directus/setup-schema.mjs), [directus/setup-related.mjs](directus/setup-related.mjs) | schema and seed through the API |
| [directus/schema-snapshot.yaml](directus/schema-snapshot.yaml) | Directus schema snapshot (12.5.1, sqlite) |
| [directus/classify.py](directus/classify.py), [directus/make-tables.py](directus/make-tables.py) | the run classification and the tables in this file |
| [directus/results/](directus/results/) | per session `<scenario>-g<gap>-s<slow_ms>.json` (report and final states) in `buggy/`, `fixed/` (use-item guard), `fixed-all/` (all guards), `fixed-ac2/` (final autocomplete guard); plain runs `plain.jsonl`; Save runs `save-*.jsonl`; `evidence-first-race.json` (the 6.4 timeline with GenClass's full explain) |
