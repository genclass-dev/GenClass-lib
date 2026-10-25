# Race hunt: Vendure dashboard, duplicate submit on detail pages

Status: **reproduced, fix and regression tests ready, not sent.** Nothing was posted to vendurehq/vendure; the owner
sends the issue and PR drafted in [`vendure-issue.md`](./vendure-issue.md). The fix is
[`vendure.patch`](./vendure.patch) (against `master` at `aba3e9c`). The harness is
[`vendure-hunt.mjs`](./vendure-hunt.mjs).

## Summary

A double-click on **Create** on any dashboard detail page built with `useDetailPage` creates the entity twice; a
double-click on **Update** sends the update twice. It reproduces without GenClass (on the wire, in the database, and
with Playwright's plain `dblclick()`).

Headline counts (CDP double press, presses 0 to 150 ms apart, local SQLite dev server, production build):

| variant | Create trials with 2 mutations | duplicate entities in the database | Update trials with 2 mutations | GenClass duplicate reports |
|---|---|---|---|---|
| `master` | 77 of 160 (all 40 at 0 ms, 33 of 40 at 30 ms, 4 of 40 at 80 ms, 0 at 150 ms) | 60 (Collection 23, Product 21, Facet 16; Customer 0: the server rejects the second email) | 23 of 48 | 74 of the 77, 23 of the 23 |
| `master`, 100 ms added latency | 37 of 48 (now every page at 80 ms, one at 150 ms) | 28 | not run | 37 of 37 |
| review's one line (variant A) | 19 of 48 | 16 | 22 of 48 | 41 of 41 |
| patch (variant B) | **0 of 208** (160 local, 48 with 100 ms latency) | **0** (208 entities from 208 trials) | **0 of 48** | **0** |

GenClass found the duplicate in 208 of the 213 trials that sent two mutations (5 missed, section 7) and reported no
duplicate in any of the 443 trials that sent one, the 256 patched trials included. Without GenClass injected the
counts follow the same pattern (18 of 48 Create trials, 15 duplicate entities), so it changes nothing in the app.

The fix proposed in the review (add `createMutation.isPending` to `isPending`) is necessary but not sufficient: the
Update button already has `updateMutation.isPending` and still double-submits, because the submit handler awaits
validation before it calls the mutation and the button is only disabled on the next render. The patch adds that line
and a synchronous guard in the form engine's submit handler.

Issue [vendurehq/vendure#2117](https://github.com/vendurehq/vendure/issues/2117) (open, filed 2023-04-11 for the legacy
Angular admin-ui, labels `@vendure/admin-ui`, `P4: low`, `type: bug`, `contributions welcome`): the maintainer
(michaelbromley) confirmed in 2024 that it affects every detail page with create and update, because the button stays
enabled while the first request is in flight, and on 2025-04-02 a maintainer (dlhck) wrote that the fix "will be
included in a future release of the new `@vendure/dashboard`". **The React dashboard has the same bug** (3.8.1,
`master` of 2026-10-23), on Create and on Update. The legacy admin-ui still builds and still has it (section 6).

## 1. Versions

| what | version |
|---|---|
| Vendure | `master` at `aba3e9c` (2026-10-23), packages 3.8.1, `@vendure/dashboard` 3.8.1 |
| runtime | Node 22.22.0, bun 1.4.4, Linux, SQLite (better-sqlite3) |
| browser | Chromium 153.0.8010.12 (preinstalled), Playwright 1.63.0 (harness), Playwright 1.58.2 (Vendure's e2e, pointed at the same Chromium) |
| GenClass | GenClass-lib `d77ffd8`: `@genclass/runtime` 0.3.0-beta.1 script-tag build (`dist/genclass.global.js`) and agent link (`dist/agent.js`), `@genclass/mcp` 0.1.0 bridge in-process |

## 2. Commands

GenClass (this repo):

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
```

`npx playwright install --with-deps chromium` was skipped: the container has Chromium preinstalled and a second
install would not find it.

Vendure (a shallow clone, read only):

```bash
git clone --depth 1 https://github.com/vendurehq/vendure && cd vendure
bun install && bun run build          # every package built except the dashboard: its check-types ran out of heap
(cd packages/dashboard && NODE_OPTIONS=--max-old-space-size=8192 bun run build)
cd packages/dev-server
DB=sqlite bun run populate
VENDURE_DISABLE_TELEMETRY=true NODE_OPTIONS=--max-old-space-size=8192 DB=sqlite bun run dev:direct
```

`dev:direct` serves the API on http://localhost:3000 and the dashboard from the Vite dev server at
http://localhost:5173/dashboard (not :3000/dashboard; the workflow does not serve a static dashboard). Login
superadmin / superadmin. Vendure's own telemetry was turned off for the hunt.

Production build of the dashboard against the same API, served the way the dashboard's e2e harness serves it:

```bash
cd packages/dashboard
VITE_ADMIN_API_PORT=3000 VITE_ADMIN_API_HOST=http://localhost npx vite build --outDir /tmp/dash-buggy --emptyOutDir
npx vite preview --outDir /tmp/dash-buggy --port 5175     # dashboard at http://localhost:5175
```

The same for the review's one-line fix (variant A, :5176) and the patch (variant B, :5177). An out-of-tree `--outDir`
keeps `vite build` from emptying `packages/dashboard/dist`, which holds the built plugin the dev server loads.

The sweep (this repo):

```bash
BASE=http://localhost:5175 LATENCY=0 TRIALS=10 ACTIONS=create VENDURE=/path/to/vendure \
  node docs/adoption/hunts/vendure-hunt.mjs
```

## 3. Method

For each page, gap and trial the harness opens a fresh page in headless Chromium, fills the form with a unique name,
waits until the button is enabled, and presses it twice with raw input events sent through CDP
(`Input.dispatchMouseEvent`, `clickCount` 1 then 2, the second press sent `gap` ms after the first without waiting for
the page to handle the first, as a person's second click is not held back). A disabled button ignores a press. It
records:

- **wire**: `create*` / `update*` mutations sent to `/admin-api` (Playwright's request log) and their responses;
- **db**: rows with that name in the dev server's SQLite file, read directly;
- **GenClass**: `identical-in-flight` witnesses of the agent link (two identical requests, same method, URL and body,
  in flight together, started by two separate user actions), split into the mutation pair and other pairs;
- the measured gap between the two presses (event timestamps in the page) and what the second press hit.

GenClass is injected without touching Vendure: `page.route` rewrites the dashboard's HTML document to load
`/__genclass/genclass.global.js` (`data-model="off" data-telemetry="off" data-visual="off"`) and
`/__genclass/agent.js` (`connectAgent(runtime, { hold: false })`, so no response is ever held) from a virtual
same-origin path served out of `packages/runtime/dist`. The duplicate witness needs no model. Because a document
fulfilled through `page.route` loses its loopback address space, Chromium's Local Network Access check would block the
dashboard's calls from :5175 to :3000, so the browser runs with `--disable-features=LocalNetworkAccessChecks`.

Why raw CDP presses: Playwright's `page.mouse.click()` waits until the renderer has handled the click, which on the
dev build took about 130 ms (validation and the mutation call run inside that click task), while the local create
mutation answers in about 30 ms. Two awaited clicks therefore never overlap a request on a local server; the first
smoke run with them found nothing at an 80 ms gap. A person's double-click is not throttled that way. Playwright's
`locator.dblclick()`, used by the regression test, does reproduce (section 5).

`LATENCY=100` adds 100 ms to every request through CDP `Network.emulateNetworkConditions`, a server about that far
away; the local SQLite server is the fastest case for this bug, since the window is about one request long.

Pages: Collection, Product, Facet and Customer, new (`/new`) for Create and an existing populated entity
(`collections/2`, `products/1`, `facets/2`, `customers/1`) for Update. Gaps 0, 30, 80 and 150 ms.

## 4. Counts

Trials per cell: 10 for Create on the production build, 3 elsewhere (the run was shortened on request; the 3-trial
cells are marked). "GenClass duplicate" counts trials with a mutation witness; "other identical pairs" are follow-on
requests (an Update's detail query refetched once per response).

### 4.1 `master`, production build, Create (10 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 10 | 0 | 10 | 20 | 20 | 10 | 10 | 0 | 0 |
| create | collection | 30 | 10 | 30 | 10 | 20 | 20 | 10 | 10 | 0 | 0 |
| create | collection | 80 | 10 | 81 | 3 | 13 | 13 | 3 | 3 | 0 | 0 |
| create | collection | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | product | 0 | 10 | 0 | 10 | 20 | 20 | 10 | 10 | 0 | 0 |
| create | product | 30 | 10 | 31 | 10 | 20 | 20 | 10 | 10 | 0 | 0 |
| create | product | 80 | 10 | 81 | 1 | 11 | 11 | 1 | 1 | 0 | 0 |
| create | product | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 0 | 10 | 0 | 10 | 20 | 20 | 10 | 10 | 0 | 0 |
| create | facet | 30 | 10 | 31 | 6 | 16 | 16 | 6 | 4 | 0 | 0 |
| create | facet | 80 | 10 | 80 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 10 | 0 | 10 | 20 | 10 | 0 | 10 | 0 | 0 |
| create | customer | 30 | 10 | 30 | 7 | 17 | 10 | 0 | 6 | 0 | 0 |
| create | customer | 80 | 10 | 81 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |

- Totals: trials 160, failed 0, trials with 2 mutations 77, GenClass duplicate trials 74 (on trials without 2 mutations: 0; 2-mutation trials it missed: 3); entities created 220; error responses 17: The email address is not available.
- Second press landed on (target of the second `pointerdown`): {"enabled button":77,"div Create":18,"button ":56,"div EnabledCreate":9}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":20,"runs":387}}

### 4.2 Patch (variant B), production build, Create (10 trials per cell): the fixed-variant check

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 10 | 0 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | collection | 30 | 10 | 31 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | collection | 80 | 10 | 81 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | collection | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | product | 0 | 10 | 0 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | product | 30 | 10 | 31 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | product | 80 | 10 | 80 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | product | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 0 | 10 | 0 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 30 | 10 | 30 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 80 | 10 | 81 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | facet | 150 | 10 | 150 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 10 | 0 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 30 | 10 | 30 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 80 | 10 | 80 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |
| create | customer | 150 | 10 | 151 | 0 | 10 | 10 | 0 | 0 | 0 | 0 |

- Totals: trials 160, failed 0, trials with 2 mutations 0, GenClass duplicate trials 0 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 160; error responses 0: 
- Second press landed on (target of the second `pointerdown`): {"enabled button":53,"div Create":39,"button ":52,"div EnabledCreate":16}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":17,"runs":198}}

### 4.3 `master`, production build, Update (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| update | collection | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | collection | 30 | 3 | 31 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | collection | 80 | 3 | 81 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | collection | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | product | 30 | 3 | 31 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | product | 80 | 3 | 83 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | facet | 30 | 3 | 30 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | facet | 80 | 3 | 80 | 1 | 4 | - | - | 1 | 1 | 0 |
| update | facet | 150 | 3 | 150 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 0 | 0 |
| update | customer | 30 | 3 | 30 | 1 | 4 | - | - | 1 | 1 | 0 |
| update | customer | 80 | 3 | 80 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 23, GenClass duplicate trials 23 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 0; error responses 0: 
- Second press landed on (target of the second `pointerdown`): {"enabled button":23,"div Update":19,"div EnabledUpdate":6}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":12,"runs":52},"duplicate-request":{"findings":4,"runs":23}}

### 4.4 Patch, production build, Update (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| update | collection | 0 | 3 | 0 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | collection | 30 | 3 | 33 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | collection | 80 | 3 | 80 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | collection | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 0 | 3 | 0 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 30 | 3 | 30 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 80 | 3 | 81 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 0 | 3 | 0 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 30 | 3 | 31 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 80 | 3 | 81 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 0 | 3 | 0 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 30 | 3 | 31 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 80 | 3 | 81 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 0, GenClass duplicate trials 0 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 0; error responses 0: 
- Second press landed on (target of the second `pointerdown`): {"enabled button":21,"div Update":21,"div EnabledUpdate":6}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":4,"runs":25}}

### 4.5 `master`, production build, Create, 100 ms added latency (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 30 | 3 | 30 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 80 | 3 | 81 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 30 | 3 | 30 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 80 | 3 | 80 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 150 | 3 | 151 | 1 | 4 | 4 | 1 | 1 | 0 | 0 |
| create | facet | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 30 | 3 | 30 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 80 | 3 | 82 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 3 | 0 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 30 | 3 | 30 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 80 | 3 | 81 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 37, GenClass duplicate trials 37 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 76; error responses 9: The email address is not available.
- Second press landed on (target of the second `pointerdown`): {"enabled button":37,"div Create":9,"div EnabledCreate":2}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":20,"runs":174}}

### 4.6 Patch, production build, Create, 100 ms added latency (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 3 | 1 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | collection | 30 | 3 | 31 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | collection | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | collection | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 0 | 3 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 30 | 3 | 31 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 0 | 3 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 30 | 3 | 30 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 80 | 3 | 80 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 3 | 0 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 30 | 3 | 31 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 0, GenClass duplicate trials 0 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 48; error responses 0: 
- Second press landed on (target of the second `pointerdown`): {"enabled button":13,"div Create":26,"div EnabledCreate":9}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":8,"runs":96}}

### 4.7 Control: `master`, production build, Create, GenClass not injected (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 3 | 0 | 3 | 6 | 6 | 3 | - | - | 0 |
| create | collection | 30 | 3 | 31 | 3 | 6 | 6 | 3 | - | - | 0 |
| create | collection | 80 | 3 | 81 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | collection | 150 | 3 | 152 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | product | 0 | 3 | 0 | 3 | 6 | 6 | 3 | - | - | 0 |
| create | product | 30 | 3 | 32 | 3 | 6 | 6 | 3 | - | - | 0 |
| create | product | 80 | 3 | 81 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | product | 150 | 3 | 150 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | facet | 0 | 3 | 0 | 3 | 6 | 6 | 3 | - | - | 0 |
| create | facet | 30 | 3 | 31 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | facet | 80 | 3 | 81 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | facet | 150 | 3 | 150 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | customer | 0 | 3 | 0 | 3 | 6 | 3 | 0 | - | - | 0 |
| create | customer | 30 | 3 | 30 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | customer | 80 | 3 | 80 | 0 | 3 | 3 | 0 | - | - | 0 |
| create | customer | 150 | 3 | 151 | 0 | 3 | 3 | 0 | - | - | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 18, GenClass duplicate trials 0 (on trials without 2 mutations: 0; 2-mutation trials it missed: 18); entities created 63; error responses 3: The email address is not available.
- Second press landed on (target of the second `pointerdown`): {"enabled button":18,"div Create":8,"button ":13,"div EnabledCreate":3,"header Hunt Hunt buggy-create-l":6}

### 4.8 Variant A (the review's one line only), production build, Create and Update (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 30 | 3 | 31 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | collection | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 30 | 3 | 31 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | product | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 30 | 3 | 31 | 1 | 4 | 4 | 1 | 1 | 0 | 0 |
| create | facet | 80 | 3 | 80 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 3 | 0 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 30 | 3 | 31 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 80 | 3 | 80 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 150 | 3 | 150 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| update | collection | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | collection | 30 | 3 | 31 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | collection | 80 | 3 | 81 | 1 | 4 | - | - | 1 | 1 | 0 |
| update | collection | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | product | 30 | 3 | 30 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | product | 80 | 3 | 81 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | product | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | facet | 30 | 3 | 30 | 3 | 6 | - | - | 3 | 3 | 0 |
| update | facet | 80 | 3 | 80 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | facet | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 0 | 3 | 0 | 3 | 6 | - | - | 3 | 1 | 0 |
| update | customer | 30 | 3 | 31 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 80 | 3 | 80 | 0 | 3 | - | - | 0 | 0 | 0 |
| update | customer | 150 | 3 | 151 | 0 | 3 | - | - | 0 | 0 | 0 |

- Totals: trials 96, failed 0, trials with 2 mutations 41, GenClass duplicate trials 41 (on trials without 2 mutations: 0; 2-mutation trials it missed: 0); entities created 64; error responses 3: The email address is not available.
- Second press landed on (target of the second `pointerdown`): {"enabled button":41,"div Create":8,"button ":18,"div EnabledCreate":3,"div Update":20,"div EnabledUpdate":6}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":20,"runs":142}}

### 4.9 `master`, Vite dev server (`dev:direct`, :5173/dashboard), Create (3 trials per cell)

| action | page | gap ms | trials | median press gap | trials with 2 mutations | mutations | entities created | trials with 2 entities | GenClass duplicate (trials) | other identical pairs (trials) | failed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| create | collection | 0 | 3 | 1 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 30 | 3 | 30 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 80 | 3 | 81 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | collection | 150 | 3 | 151 | 3 | 6 | 6 | 3 | 1 | 0 | 0 |
| create | product | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 30 | 3 | 31 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 80 | 3 | 81 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | product | 150 | 3 | 151 | 2 | 5 | 5 | 2 | 2 | 0 | 0 |
| create | facet | 0 | 3 | 0 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 30 | 3 | 30 | 3 | 6 | 6 | 3 | 3 | 0 | 0 |
| create | facet | 80 | 3 | 81 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | facet | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 0 | 3 | 0 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 30 | 3 | 30 | 3 | 6 | 3 | 0 | 3 | 0 | 0 |
| create | customer | 80 | 3 | 80 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |
| create | customer | 150 | 3 | 151 | 0 | 3 | 3 | 0 | 0 | 0 | 0 |

- Totals: trials 48, failed 0, trials with 2 mutations 35, GenClass duplicate trials 33 (on trials without 2 mutations: 0; 2-mutation trials it missed: 2); entities created 77; error responses 6: The email address is not available.
- Second press landed on (target of the second `pointerdown`): {"enabled button":35,"div EnabledCreate":1,"div Create":7,"button ":5}
- Bridge findings by kind (`genclass_findings`, first 20): {"stale-write":{"findings":20,"runs":219}}

## 5. Root cause, fix, tests

### Root cause (`master`, `aba3e9c`)

- `packages/dashboard/src/lib/framework/page/use-detail-page.ts` line 446 returns
  `isPending: updateMutation.isPending || detailQuery?.isPending`. `createMutation` (line 379) is left out, so every
  Create button that uses `disabled={... || isPending}` (for example `collections_.$id.tsx` lines 168 to 173,
  `products_.$id.tsx` line 245) stays enabled while the create mutation is in flight.
- `packages/dashboard/src/lib/framework/form-engine/use-generated-form.tsx` lines 293 to 351: the submit handler
  awaits `form.trigger()` (line 297), then `form.handleSubmit` (line 350) calls `onSubmit` (line 348), which calls
  `createMutation.mutate` or `updateMutation.mutate` (`use-detail-page.ts` lines 418 and 430). Nothing stops a second
  submit event during validation, and `isPending` disables the button only on the render after `mutate()`. This is
  why Update, which has `updateMutation.isPending`, double-submits too.
- After the first create succeeds, its `onSuccess` resets the form and navigates; the second submit was already past
  validation with the same values, so the server creates a second entity. Vendure de-duplicates the slug or code
  (`name`, `name-2`), so nothing fails. On Customer the server rejects the second create because the email address is
  taken: one customer, but the request still goes out twice.

### Fix (in `vendure.patch`)

- `useGeneratedForm`: a `useRef` flag set from the start of a submit until the promise returned by `onSubmit`
  settles; a submit that arrives meanwhile is ignored. `GeneratedFormOptions.onSubmit` may return a promise
  (`=> void | Promise<unknown>`); returning nothing keeps the old behavior apart from the validation-time guard.
- `useDetailPage`: `onSubmit` returns `createMutation.mutateAsync(...)` / `updateMutation.mutateAsync(...)` with the
  rejection caught (errors still go to the mutation's `onError`, as `mutate` does internally), and `isPending`
  includes `createMutation.isPending`.
- No dependency, no new import, no change to any page. Suggested commit subject (Vendure's conventional, lower-case):
  `fix(dashboard): submit a detail form only once on double-click`.

### Tests (in `vendure.patch`, no GenClass import)

| test | `master` | variant A (one line) | variant B (patch) |
|---|---|---|---|
| `use-generated-form.spec.tsx`: second submit during validation ignored | fails | not run | passes |
| `use-generated-form.spec.tsx`: submits ignored until the `onSubmit` promise settles | fails | not run | passes |
| `use-generated-form.spec.tsx`: a submit that failed validation releases the guard | passes | not run | passes |
| `e2e/tests/regression/double-submit-on-save.spec.ts`, Create (`dblclick()`, 5 runs) | 5 of 5 fail (2 mutations) | 5 of 5 fail | 5 of 5 pass |
| same spec, Update (5 runs) | 5 of 5 fail (2 mutations) | 5 of 5 fail | 5 of 5 pass |

With the patch: `npm run check-types` clean, `eslint` and `prettier --check` clean on the changed files, the dashboard
unit suite passes (86 files, 961 tests passed, 4 skipped). The e2e spec was run with Vendure's own harness
(`global-setup.ts` test server on :3050, `vite build` + `vite preview` of each variant, `--repeat-each=5`) through a
local wrapper config that only sets Chromium's `executablePath`; the wrapper is not in the patch. The full dashboard
e2e suite was not run (time).

## 6. Legacy admin-ui

`@vendure/admin-ui` still builds (`ng build`, 45 s). Served statically at http://localhost:3002/admin/ against the same
API, with the same CDP double press (no GenClass, 3 trials per cell):

| page | gap 0 ms: mutations / created | gap 80 ms: mutations / created |
|---|---|---|
| Collection | 6 / 6 (2 per trial) | 3 / 3 |
| Facet | 6 / 6 (2 per trial) | 3 / 3 |
| Customer | 6 / 3 (second rejected: email taken) | 3 / 3 |
| Product | 0 / 0: the probe did not submit (the form needs more fields), inconclusive | 0 / 0 |

So #2117 still reproduces in the legacy admin-ui. The patch does not touch it.

## 7. GenClass: what it reported, and its false reports

**Duplicate-request witness** (the one this hunt used; no model):

| run | trials with 2 mutations | reported by GenClass | missed | trials with 1 mutation | false duplicate reports |
|---|---|---|---|---|---|
| `master` Create, local | 77 | 74 | 3 (Facet 2 and Customer 1 at 30 ms) | 83 | 0 |
| `master` Update, local | 23 | 23 | 0 | 25 | 0 |
| `master` Create, 100 ms | 37 | 37 | 0 | 11 | 0 |
| variant A, Create and Update | 41 | 41 | 0 | 55 | 0 |
| `master` dev server, Create | 35 | 33 | 2 (Collection at 150 ms) | 13 | 0 |
| patch, all runs | 0 | 0 | 0 | 256 | 0 |
| **total** | **213** | **208 (97.7%)** | **5** | **443** | **0 (0.0%)** |

Its title reads, for example: `"POST localhost:3000/admin-api" was sent twice, 75 ms apart, by two separate user
actions while the first was in flight`, with the operation (`mutation CreateCollection…`) in the evidence. The 5
misses all came at gaps of 30 ms or more; why the witness did not fire there is not diagnosed yet (a GenClass
follow-up). "Other identical pairs" on Update are real follow-on
duplicates (the detail query refetched once per update response); they disappear with the patch.

**False reports of another kind.** On every run, the patched one included, the bridge also lists `stale-write`
findings such as `The response to "POST localhost:3000/admin-api" {query: "mutation CreateCollecti…"} overwrote
"pageHeading.external5.isPending" after a newer "timer 0ms" had already written it`, and the same for `.status`. On
the patched Create run they cover 20 of the 40 runs of each page (17 findings), so about half of the clean runs carry
one. They are not bugs: they are TanStack Query's own `useMutation` state, which its notify manager writes from a
`setTimeout(0)` batch before the response's write lands. The agent link's `overwrote-newer` witness treats that timer
as a newer operation. This is a GenClass false positive to fix on our side (a follow-up for the runtime, not part of
this hunt); it would have been noise to a maintainer, so the hunt reports only the duplicate-request witness.

## 8. Time spent

About 1 h 20 min wall clock (2026-10-24 23:25 to 2026-10-25 00:45 UTC): 10 min to build both projects (including the
dashboard's out-of-memory type check), 15 min to set up the injection and find the right way to press (the Local
Network Access block and the awaited-click limitation), 10 min on the root cause and the two fix variants, 15 min on
the unit and e2e tests (three builds each), 30 min of sweeps (two in parallel; the plan of 10 trials everywhere was cut
to 3 for the secondary cells to finish sooner), 10 min on the admin-ui and the write-up. One sweep pair was lost and
rerun when the dev server hit the session's background time limit.
