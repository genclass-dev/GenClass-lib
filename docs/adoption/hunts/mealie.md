# Race hunt: Mealie recipe search

Result: **reproduced.** Mealie's recipe search can show the results of an earlier search term. When the response to
a partial term ("chi") arrives after the response to the full term ("chicken"), it replaces the newer results and
stays on screen. GenClass explore found it in 5 of 30 reordered runs on the search dialog. It reported none of the 10
baselines, and with the results registered as an atom it agreed run by run with a DOM oracle. Plain Playwright
reproduces it without GenClass in 3 of 3 runs. A small request counter fixes it (7 added lines). On the fixed build: no race in 17
reordered runs, 0 stale results in 24 GenClass loads and 6 plain-Playwright runs. Two new unit tests fail before the
fix and pass after it.

Limits, stated up front:
- The bug needs one search response to arrive about 2 s or more after the next search's response. The composable
  debounces input by 500 ms, so continuous typing sends a single request and cannot race; the user has to pause
  mid-word. Plausible on a slow server or network, rare on a fast one.
- Explore needed help on this app. Without a registered store it missed the race (GenClass problem 1), and on the
  ingredient editor it gave 3 false reports in 6 runs (problem 3).

Nothing was sent to mealie-recipes/mealie. Drafts for the owner are in [mealie-pr.md](mealie-pr.md). The change is
[mealie.patch](mealie.patch). The harness is in [mealie-harness/](mealie-harness/).

## 1. Versions and setup

| what | version |
|---|---|
| Mealie | `mealie-next` at 4391aa8a5 (2026-10-24, v3.29.0; newer than the reviewed 6d857aa) |
| backend | Python 3.14.6 (uv 0.11.32), `task py` (go-task 3.54.0), default SQLite, port 9000 |
| frontend | Node 22.22.0, pnpm 11.23.0 (the `packageManager` pin; pnpm 10.28 switched to it), `task ui` (Nuxt dev server, port 3000) |
| GenClass | this repo at d77ffd8 (`@genclass/runtime` 0.3.0-beta.1, `@genclass/mcp` 0.1.0), both built locally |
| browser | Playwright 1.63.0, the preinstalled Chromium 153.0.8010.12 headless shell |
| data | 300 recipes seeded through the API: 20 names × 15 dishes ("Chicken Soup", "Chickpea Curry", "Beef Stew", ...) |

`task setup` first failed: `python-ldap` needs the LDAP headers (`apt-get install libldap2-dev libsasl2-dev`). The
admin's first-login redirect to `/admin/setup` was skipped by opening `/g/home` directly. Seeding: `seed.mjs`
(POST `/api/recipes` with a name). With this data, "chi" returns 60 recipes, and its first page (20) holds the 15
"Chicken ..." recipes plus 5 "Chickpea ...". "chicken" returns exactly the 15 "Chicken ...". "beef" returns 15,
"salmon" 15. The backend answers a search in 20 to 50 ms.

`npx playwright install --with-deps chromium` was not run: this environment ships a matching Chromium and forbids
installing another.

## 2. The code

`frontend/app/composables/recipes/use-recipe-search.ts` (at 4391aa8a5):

- lines 26-49, `searchRecipes(term)`: sets `loading`, awaits `api.recipes.search(...)`, then writes
  `recipes.value = data.items` and clears `loading`. Nothing ties a response to the term that is current when it
  arrives, so the last response to arrive wins, whichever term it was for.
- lines 51-57: `watchDebounced` on `query`, 500 ms. Each pause of 500 ms or more sends a search.
- lines 59-61: `trigger()` sends a search for the current query immediately (no debounce).

Callers:
- `components/Domain/Recipe/RecipeDialogSearch.vue` (the header search, opened with `/`): lists `search.data` as
  `RecipeCardMobile` cards (lines 54-66).
- `components/Domain/Recipe/RecipeIngredientEditor.vue` (an ingredient switched to "Toggle Recipe"): the "Choose
  Recipe" autocomplete (lines 151-168) uses `search.data` as its items and calls `search.trigger()` on both `@click`
  and `@focus`, so one click sends two identical searches for the current text before any typing.

Two claims from the review, checked:
- "`loading` is cleared by the first response": true of the composable, but neither caller reads `search.loading`.
  The dialog binds its own `loading` ref (line 12, declared on line 89), which is never set. No visible effect today. The fix
  still keeps `loading` on until the latest search returns, and a test covers it.
- Issue #2808 is not related: it is a backend race (concurrent PATCH requests to one recipe duplicate its
  ingredients and steps), with a maintainer comment and an open PR (#8754). See mealie-pr.md, section 1. No existing
  issue covers the search race.

## 3. Method

`mealie-harness/hunt.mjs` follows `packages/mcp/test/e2e/race.e2e.mjs`:
- The MCP server runs in-process (`serve()`, bridge on a free loopback port). The harness calls the same tools an
  agent would: `genclass_explore` start, 8 page loads, `report`, then `genclass_explain` on the finding.
- Each load is a fresh browser context (`bypassCSP: true`, a saved login). `page.route` serves
  `packages/runtime/dist/*` on the virtual same-origin path `/__genclass/`. It also rewrites the page's HTML to add,
  first in `<head>`: `window.GENCLASS_CONFIG = { telemetry: false, model: false, report: "silent" }`, the script-tag
  build (`/__genclass/genclass.global.js`), and a module that runs
  `connectAgent(window.GenClass.runtime, { url: <bridge> })` from `/__genclass/agent.js` (the script-tag build has no
  agent entry). No Mealie file is changed.
- State: Mealie is Vue, and GenClass discovers only React and Redux state. With `--atom`, the injected module
  registers `rt.atom("searchResults")` and sets it from the rendered result list on DOM changes (a MutationObserver)
  as "count: first ... last". The selector counts each dialog card twice, so 15 results read "30: ...". It is
  consistent across runs, so the comparison is unaffected. Runs without `--atom` rely on the page text and form
  values in the snapshots, and on the delivery order.
- DOM oracle, separate from explore: after `whenSettled`, the harness reads the visible results. Dialog: the card
  names must equal the backend's first page for the final term, in order. Ingredient editor: the autocomplete's
  options must be non-empty and all match the typed term.
- Explore session: 2 `fifo` baselines and 6 `seeded` loads, `slow_ms` adding 0 to N ms per response. Typing with
  `pressSequentially` at 60 or 90 ms per key.

Scenarios (a pause of 1.1 s, longer than the 500 ms debounce and the runtime's 1 s typing-burst window; see
problem 2):

| scenario | steps | requests |
|---|---|---|
| dialog-type | `/`, type `chicken` | one, "chicken" |
| dialog-pause | `/`, type `chi`, pause, type `cken` | "chi", then "chicken" |
| dialog-clear-retype | `/`, type `salmon`, pause, Ctrl+A, Backspace, type `beef` | "salmon", then "beef" |
| ingredient-link | recipe edit page, ingredient row menu "Toggle Recipe", click "Choose Recipe", type `chicken` | "" twice (click and focus), then "chicken" |

Commands (paths as on the hunt machine):

```bash
# GenClass
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# Mealie
git clone --branch mealie-next https://github.com/mealie-recipes/mealie.git && cd mealie
task setup && task py   # second shell: task ui
# harness (node_modules linked to this repo's, for playwright and @genclass/mcp)
node seed.mjs && node login.mjs && node login2.mjs
HUNT_PAUSE=1100 node hunt.mjs --atom --scenario dialog-pause --slow 900 --tag buggy
node repro-plain.mjs 3      # buggy build; 6 after `git apply mealie.patch`
python3 summarize.py out/*.json
```

## 4. Every verdict

Unpatched build (`buggy`) first, then the patched build (`fixed`). "Reordered" means the 6 seeded runs; the oracle
column reads seeded wrong / baseline wrong.

| build | scenario | slow_ms | key ms | atom | explore verdict | DOM oracle wrong | agreement |
|---|---|---|---|---|---|---|---|
| buggy | dialog-pause (0.6 s pause) | 900 | 90 | no | no race (one group had no baseline) | 1 of 2 / 0 of 2 | missed (problem 2) |
| buggy | dialog-pause | 900 | 90 | no | **no race** | **2 of 6** / 0 of 2 | missed (problem 1) |
| buggy | dialog-pause | 900 | 90 | yes | **race, 2 of 6** | 2 of 6 / 0 of 2 | same runs (seeds 1, 5) |
| buggy | dialog-pause | 600 | 90 | yes | **race, 1 of 6** | 1 of 6 / 0 of 2 | same run (seed 5) |
| buggy | dialog-pause | 300 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |
| buggy | dialog-type | 900 | 60 | yes | no race | 0 of 6 / 0 of 2 | agree |
| buggy | dialog-clear-retype | 900 | 90 | yes | **race, 2 of 6** | 2 of 6 / 0 of 2 | same runs (seeds 1, 5) |
| buggy | ingredient-link | 900 | 60 | yes | race, 3 of 6: **false** | 0 of 6 / 0 of 2 | false report (problem 3) |
| fixed | dialog-pause | 900 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |
| fixed | dialog-pause, seed 7 | 900 | 90 | yes | no race in 5; 1 run no verdict | 0 of 6 / 0 of 2 | agree (problem 2) |
| fixed | dialog-clear-retype | 900 | 90 | yes | no race | 0 of 6 / 0 of 2 | agree |

The first row was a 4-load smoke run (2 seeded) with a 0.6 s pause.

Totals for the search dialog with the atom (the setup that works):
- Unpatched: explore flagged 5 of 30 reordered runs. The DOM oracle found the same 5 runs wrong, and no baseline was
  wrong (0 of 10).
- Patched: explore flagged 0 of 17 reordered runs with a verdict, and the DOM oracle found 0 of 24 loads wrong. That
  is no false report on the correct variant.
- Ingredient editor, unpatched: 3 false race reports in 6 reordered runs. None of them reordered the search
  responses: the "" responses were delivered before "chicken" was sent in all 8 loads, and the oracle found nothing
  wrong.

By `slow_ms` (dialog-pause): 300 gave 0 of 6, 600 gave 1 of 6, 900 gave 2 of 6. Continuous typing gave 0 of 6: the
debounce sends one request. Not run, to keep the hunt short at the owner's request: dialog-type and
dialog-clear-retype at 300 and 600, ingredient-link at 300 and 600, typing at 120 ms per key, and
`genclass_replay` of the finding.

## 5. Evidence, in causal order

Finding f2 (`genclass_explain`), run r4, `/g/home`, schedule seeded 1 with 0 to 900 ms latency. Times are from
`connectAgent`; page-load requests that do not bear on it are left out:

```
+5.560s action 0: type input "Search" = "chi" (3 keystrokes over 198 ms)
+6.260s send GET /api/recipes#2 "?search=chi&page=1&orderBy=name&orderDirection=asc&perPage=…" (action 0) via timer 500ms
+7.436s action 1: type input "Search" = "chicken" (4 keystrokes over 306 ms)
+8.244s send GET /api/recipes#4 "?search=chicken&page=1&orderBy=name&orderDirection=asc&perP…" (action 1) via timer 500ms
+8.452s delivered GET /api/recipes#4 (held 164 ms)
+8.636s write searchResults by GET /api/recipes#4: "" → "30: Chicken Bowl ... Chicken Wrap"
+9.272s delivered GET /api/recipes#2 (held 2.9 s)
+9.336s write searchResults by GET /api/recipes#2: "30: Chicken Bowl ... Chicken Wrap" → "40: Chicken Bowl ... Chickpea Pasta"
```

- Explore: `state "searchResults": baseline "30: Chicken Bowl ... Chicken Wrap", this run "40: Chicken Bowl ...
  Chickpea Pasta"`.
- Witness only in the failing runs: `overwrote-newer searchResults by GET /api/recipes`.
- DOM oracle, same run: 20 cards shown, 15 expected; not in the results for "chicken": "Chickpea Bowl", "Chickpea
  Burger", "Chickpea Casserole", "Chickpea Curry".

The "chi" response reached the app 3.0 s after its request was sent and 0.8 s after the "chicken" response. Its
emulated latency (at most 900 ms) was stretched by the seeded schedule's holds while other requests were in flight.
That is the honest size of the window: the earlier response has to arrive about 2 s or more late.

Without GenClass (`repro-plain.mjs`, plain `page.route` holding only the "chi" response for 2 s; type `chi`, wait
1.1 s, type `cken`):

```
run 1: STALE: 20 shown (15 expected), not for "chicken": ["Chickpea Bowl","Chickpea Burger","Chickpea Casserole"]; chi sent @7890, chicken answered @9461, chi answered @9950
run 2: STALE: ... chi sent @7063, chicken answered @8619, chi answered @9134
run 3: STALE: ... chi sent @7136, chicken answered @8680, chi answered @9181
{"runs":3,"stale":3}
```

## 6. Root cause and fix

Root cause: `searchRecipes` (use-recipe-search.ts, lines 26-49) applies every response it receives, whether or not a
newer search has started since. Two searches in flight resolve in network order, not request order, and the last one
to resolve sets `recipes` and clears `loading`.

Fix ([mealie.patch](mealie.patch), Mealie's style): a counter in the composable. Each search takes the next number;
after the `await`, a response whose number is not the latest returns without touching `recipes` or `loading`.

```ts
  let latestRequest = 0;

  async function searchRecipes(term: string) {
    const request = ++latestRequest;
    loading.value = true;
    const { data, error } = await api.recipes.search({ ... });

    // a newer search started while this one was in flight; let it set the results
    if (request !== latestRequest) {
      return;
    }
```

An AbortController would also cancel the request. It was not used because the API client's `search` takes no
signal, and the counter keeps the change to the one file both callers share.

Regression test: `frontend/app/composables/recipes/__tests__/use-recipe-search.test.ts`, in the style of the
existing composable tests (vitest, `vi.fn`, no GenClass). A fake `api.recipes.search` returns a promise per term that
the test resolves by hand:
- "an older response that arrives last does not overwrite newer results": search "chi", then "chicken"; resolve
  "chicken", then "chi"; the data stays "chicken".
- "loading stays on until the latest search returns": resolve "chi" first; `loading` stays true and the data stays
  empty until "chicken" resolves.

## 7. Test results

| check | unpatched | patched |
|---|---|---|
| new tests (`npx vitest run app/composables/recipes/__tests__/use-recipe-search.test.ts`) | **2 failed** (data "chi recipe" where "chicken recipe" was expected; `loading` false where true was expected) | 2 passed |
| Mealie frontend suite (`npx vitest run`) | not run | 58 files, 625 tests passed |
| eslint on the two changed files, `--max-warnings=0` | | clean |
| plain Playwright, "chi" held 2 s | 3 of 3 stale | **0 of 6 stale** ("chi" still answered last in all 6) |
| GenClass explore (atom), dialog-pause and clear-retype, slow 900 | race in 4 of 12 reordered runs | **no race in 17 reordered runs** (1 more without a verdict) |
| DOM oracle in those sessions | 4 of 12 seeded wrong | **0 of 24 loads wrong** |

Checks not run: `task py:check` (ruff, mypy, semgrep, pytest), because the change touches no backend file. Of
`task ui:check`, the whole-project `pnpm lint` was not run; eslint ran on the changed files and vitest on the whole
suite. In this repository: no code changed (docs only), so its typecheck, build and tests were not rerun.

## 8. GenClass problems found

1. **Snapshots keep only the first 300 lines of page text** (`packages/runtime/src/agent/index.ts`, `snapshot()`,
   `.slice(0, 300)`). Mealie's home page renders 689 lines with the dialog open, and the results start at line 599
   (the dialog is teleported to the end of `<body>`). Without a registered store, explore said "No race found" while
   the DOM oracle saw 2 of 6 seeded runs wrong. A silent false negative on any long page with an overlay. Ideas:
   keep the lines of open dialogs, overlays, focused and `aria-live` regions first; or compare a hash of the full
   text with a capped excerpt.
2. **The scenario key depends on keystroke timing.** A typing burst is one action only while each keystroke comes
   within `TYPING_BURST_MS` (1000 ms, `runtime.ts`) of the last. On Mealie's dev build a render blocked the main
   thread for over 1 s, so the same `pressSequentially` was recorded as "chicke" + "chicken" in one run, putting
   that run in a group with no baseline and no verdict. This happened once on the unpatched build (the failing run,
   so the race went unreported) and once on the patched build. Ideas: group runs by the final value per field and
   the request sequence, or merge bursts whose split lies in a gap the page itself caused.
3. **Generated element ids as field names give false race reports.** Form fields are keyed by their label, and
   unlabelled Vuetify inputs fall back to auto ids (`input-v-0-78`) that depend on mount order. A different delivery
   order mounts components in a different order. The two `fifo` baselines matched each other, so the noise filter
   kept the fields, and 3 of 6 reordered runs on the ingredient editor were reported as races with only "field
   input-v-0-NN: baseline "", this run (absent)". Ideas: treat fields named only by a generated-looking id as noise,
   or compare such fields by position and value.
4. **Chromium 153 Local Network Access.** When the document is served through `route.fulfill`, Chromium blocks the
   page's requests to loopback (the bridge, and Vite's HMR socket) with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
   The harness launches Chromium with `--disable-features=LocalNetworkAccessChecks`. Anyone injecting GenClass this
   way will hit it; AGENT.md could say so.
5. Explore without a registered store is weak on Vue apps. GenClass discovers only React and Redux state, so on Vue
   the verdict rests on page text (problem 1) and form fields (problem 3). Registering one atom from the DOM was
   enough here, and the `overwrote-newer` witness was recorded through it.

Harness-side mistakes, for the record: parallel sessions hung while Vite re-optimized dependencies, so sessions run
one at a time. Waiting for `networkidle` never settles on the Nuxt dev server (the HMR socket keeps retrying), so the
warm-up waits for `load`.

## 9. Time spent

About 1 hour of wall-clock time (23:26 to 00:25 UTC): 15 minutes for setup (Python 3.14, go-task, LDAP headers,
seeding), 20 for the harness (injection, LNA, Vuetify menus), 20 for the explore sessions (about 1.6 minutes each),
and 5 for the fix and its tests.
