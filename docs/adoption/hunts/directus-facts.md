# Directus Studio: fact sheet

Raw facts for writing the issue by hand. Not issue text. Everything below was measured locally; details and the full
tables are in [directus.md](directus.md). Directus's guide asks for: reproduction steps, version, hosting strategy,
database, and a schema snapshot (https://directus.com/docs/raw/community/reporting-and-support/bug-reporting.md).

## Area

- Scope: Studio (app). Core area: content module, item view.
- Component: `useItem()` (`app/src/composables/use-item/index.ts`), used by `app/src/modules/content/routes/item.vue`.

## Version and environment

| field | value |
|---|---|
| Directus | 12.5.1 (tag `v12.5.1`, commit `2cd112f1a1afe42829d2e4de899d07ce4394649c`) |
| Hosting | self-hosted, local, from source: `pnpm --filter api dev` (API) + `cd app && pnpm dev` (Vite dev server) |
| Database | SQLite (`DB_CLIENT=sqlite3`) |
| Node / pnpm | 22.22.0 / 10.27.0 |
| Browser | Chromium 153.0.8010.12 (headless, Playwright 1.63.0) |
| OS | Ubuntu 24.04.5 |
| Non-default env | `CACHE_ENABLED=false`, `TELEMETRY=false`; `RATE_LIMITER_ENABLED=false` and websockets off are the defaults |
| Production build | not tested |

## Schema snapshot

- File: [directus/schema-snapshot.yaml](directus/schema-snapshot.yaml) (`GET /schema/snapshot?export=yaml`, 633 lines).
- Needed for the reproduction: a collection with an M2O field to itself (or to any collection) whose interface option
  "Item link" ("Show a link to the item", `enableLink: true`) is on, so the field shows a "Navigate to Item" link.
- Used here: `articles` (`title`, `summary`, `status`, `topic`, `author` M2O -> `authors`, `related` M2O ->
  `articles` with `enableLink: true`); `related`: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 1.
- Rows used: article 1 "Alpha: launch checklist" / summary "Alpha body: the steps before a launch."; article 2
  "Bravo: incident review" / summary "Bravo body: what failed on Tuesday.".

## Reproduction steps (UI)

1. Open the Articles collection list (`/admin/content/articles`).
2. Click the row for article 1. Wait until it has loaded.
3. On the Related field, click "Navigate to Item" (launch icon). URL becomes `/admin/content/articles/2`.
4. Before article 2 has loaded, click the back arrow in the header. URL becomes `/admin/content/articles/1`.
5. Condition for the bug: the response for article 2 arrives after the response for article 1 (article 2 slower).
6. Optional: append text to the Summary field and click Save.

Notes:

- Step 1 matters: if article 1 is opened directly by URL, the back arrow goes to the list instead (separate
  observation, `item.vue` lines 812-815).
- On a fast local server the responses usually arrive in order (0 of 12 runs stale without a delay). The reproduction
  needs article 2's response to be slower; the automated script below holds it.

## Reproduction (automated, no GenClass)

- Script: [directus/confirm-plain.mjs](directus/confirm-plain.mjs) (plain Playwright; logs in, dismisses the license
  prompts with their own cookies, delays only GET requests matching `/items/articles/2` by `--delay` ms).
- Command: `node confirm-plain.mjs --delay 600 --gap 100 --repeat 3` (add `--save summary` for the Save check).
- Results:

| delay of article 2's response | stale form under `/articles/1` |
|---|---|
| 0 ms | 0 of 12 |
| 300 ms | 7 of 14 |
| 600 ms | 12 of 12 |
| 900 ms | 12 of 12 |

## Observed vs expected

| | observed | expected |
|---|---|---|
| URL | `/admin/content/articles/1` | `/admin/content/articles/1` |
| Header title | "Articles: Bravo: incident review" (in some runs; others "Alpha") | "Articles: Alpha: launch checklist" |
| Title field | "Bravo: incident review" | "Alpha: launch checklist" |
| Summary field | "Bravo body: what failed on Tuesday." | "Alpha body: the steps before a launch." |
| Status / Topic | Review / redis | Draft / rest |
| Form state | editable with article 2's values, no error shown (the Save checks edited it) | article 1's values |
| Save after appending " Reviewed." to Summary | `PATCH /items/articles/1` body `{"summary": "Bravo body: what failed on Tuesday. Reviewed."}`; article 1's summary in the database becomes that text (3 of 3) | article 1's own summary plus " Reviewed." |
| Save after replacing Title | `PATCH /items/articles/1` body `{"title": "Alpha: launch checklist v2"}`; only the title changes (3 of 3) | same |
| Fields not edited | not written (3 of 3) | not written |

## Request and response timestamps (one stale run)

Delay 600 ms, gap 100 ms; ms after clicking "Navigate to Item":

| event | ms |
|---|---:|
| `GET /items/articles/2` sent | 86 |
| header back arrow clicked | 209 |
| `GET /items/articles/1` sent | 300 |
| `GET /items/articles/1` response | 341 |
| `GET /items/articles/2` response | 714 |

Same order found by GenClass without any delay on the server (its schedule held the received response for article 2):
article 2 sent +9.949 s, article 1 sent +10.160 s, article 1 delivered +10.216 s, article 2 delivered +10.960 s, form
title changed to "Bravo: incident review" at +10.985 s.

## Root cause (file and lines at v12.5.1)

- `getItem()` assigns the response with no staleness check:
  https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-item/index.ts#L151-L169
- Refired on key change: https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-item/index.ts#L116
- `refresh()` / `refreshItem()` do not invalidate the in-flight request:
  https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-item/index.ts#L543-L565
- Save PATCHes the current key with the edits:
  https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-item/index.ts#L171-L225
- Component reused across keys (unkeyed RouterView, `props: true` route):
  https://github.com/directus/directus/blob/v12.5.1/app/src/app.vue#L136,
  https://github.com/directus/directus/blob/v12.5.1/app/src/utils/router-passthrough.ts,
  https://github.com/directus/directus/blob/v12.5.1/app/src/modules/content/index.ts#L278-L281
- The navigation path (relation link, back arrow uses browser history):
  https://github.com/directus/directus/blob/v12.5.1/app/src/interfaces/select-dropdown-m2o/select-dropdown-m2o.vue#L218-L231,
  https://github.com/directus/directus/blob/v12.5.1/app/src/modules/content/routes/item.vue#L809-L815,
  https://github.com/directus/directus/blob/v12.5.1/app/src/views/private/private-view/components/private-view-header-bar-icon.vue#L16-L18

## Same pattern nearby (lower severity)

| where | symptom seen | how often (GenClass, reordered runs) |
|---|---|---|
| `use-template-data.ts` `fetchTemplateValues()` [L64-L100](https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-template-data.ts#L64-L100) | header title of article 2 on article 1 | 15 of 72 (header only) |
| `use-relation-single.ts` `getDisplayItem()` [L63-L124](https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-relation-single.ts#L63-L124) | M2O display (Author, Related) of the other item | 12 of 72 (display only) |
| `input-autocomplete-api.vue` `fetchResultsRaw()` [L43-L74](https://github.com/directus/directus/blob/v12.5.1/app/src/interfaces/input-autocomplete-api/input-autocomplete-api.vue#L43-L74) | suggestions for "re" while "rea" is typed | 12 of 36 |
| Related picker drawer, two choices in a row | none | 0 of 18 |

## Existing guards in Directus (house style)

- Generation counter: https://github.com/directus/directus/blob/v12.5.1/packages/composables/src/use-items.ts#L334-L358
  (`getItemCount`; also `getTotalCount` L309-L332, comment "prevents race conditions when navigating between
  collections quickly").
- Key check: https://github.com/directus/directus/blob/v12.5.1/app/src/composables/use-relation-multiple.ts#L510-L517
  (comment "This can happen if the user navigates to a different item while the request is in progress").

## Fix (prepared, not submitted)

- Patch: [directus.patch](directus.patch) (applies to `v12.5.1` with `git apply`).
- `use-item/index.ts`: `let itemGeneration = 0`; `getItem()` takes `const currentGeneration = ++itemGeneration` and
  ignores the result, the error and the `loadingItem` reset when the generation moved; `refreshItem()` bumps it for a
  new item (`+`).
- Same guard in `use-template-data.ts` and `use-relation-single.ts`; in `input-autocomplete-api.vue` a variant that
  skips only responses older than the last applied one (discarding every superseded response left the menu closed in
  3 of 18 runs). All three are separable from the `use-item` fix.
- Tests: 6 new (3 in `use-item/index.test.ts`, 1 each in `use-template-data.test.ts`, `use-relation-single.test.ts`,
  new `input-autocomplete-api.test.ts`): fail before, pass after. Prettier and ESLint clean.
- Fixed build, same harness: stale form 0 of 24 reordered runs (was 29 of 72) with the `use-item` guard alone; with
  all guards 0 stale form, header or display in 24, 0 stale autocomplete menus in 18 (was 12 of 36).
- Fixed build, plain script: 0 stale in 47 runs at delays 0 to 900 ms; Save after appending wrote article 1's own
  summary plus the edit (3 of 3).

## Duplicate check (not done here)

- Not searched (outside this session's repository scope). Suggested searches in directus/directus issues:
  `stale item navigate`, `wrong item data after navigation`, `item view shows previous item`, `useItem race`,
  `back button wrong item`, `getItem abort`.

## Disclosure material

- Found with GenClass (`@genclass/runtime` 0.3.0-beta.1 explore, local MCP bridge), then confirmed with a plain
  Playwright script with no GenClass code.
- The analysis and the patch were prepared with an AI coding agent; Directus's `ai_policy.md` requires a human in the
  loop, own wording, and disclosure of AI-generated content in quote blocks.
