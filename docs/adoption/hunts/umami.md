# Race hunt: Umami list search (umami-software/umami)

A GenClass race hunt against the search box Umami shares across its list pages, run on 2026-10-24 in a cloud session
without approval checkpoints. Everything here was done on a local copy of Umami; nothing was sent to the Umami project.

HEADLINE

## 1. Versions and commits

| what | version |
|---|---|
| Umami | `umami-software/umami` branch `dev` at `12cdf5777f082f18001be63076789ab4ef618d27` (2026-10-23), `package.json` 3.4.1. `dev` is the branch Umami takes pull requests on (`CONTRIBUTING.md`); `master` (3.4.1, `559e3c607`) has the same `DataGrid` search code |
| Umami stack | Next.js 16.4.2 (App Router, Turbopack build), React 19.3.1, `@umami/react-zen` 0.255.0, `@tanstack/react-query` 5.104.1, Prisma with `@prisma/adapter-pg` |
| the code under test | `src/components/common/DataGrid.tsx`; its URL sync came in with `079cfdde8` (2026-08-03, "Improve website events query performance and fix activity search persistence"), first released in v3.3.0 and present in v3.3.1, v3.4.0 and v3.4.1 |
| GenClass | this repository at `d77ffd8` (main, 2026-10-22): `@genclass/runtime` 0.3.0-beta.1, `@genclass/mcp` 0.1.0, both built from source |
| Node, pnpm | Node 22.22.0, pnpm 12.3.4 (Umami's `engines.pnpm`, run through `npx pnpm@12.3.4`) |
| database | PostgreSQL 16 from Ubuntu's packages (already installed in the VM; no Docker) |
| browser | GenClass harness: Playwright 1.63.0 with headless Chromium 153.0.8010.12. Umami's own test: `@playwright/test` 1.64.0 (Umami's version) on the same Chromium 153 binary (`executablePath`, since 1.64's browser build is not installed in the VM) |

## 2. Running Umami

Umami needs PostgreSQL and nothing else today: `prisma/schema.prisma` has `provider = "postgresql"`, the README asks
for PostgreSQL 12.14 or later, and `db/` holds only `postgresql` and an optional `clickhouse` (an analytics store next
to PostgreSQL, not instead of it); MySQL support is gone. PostgreSQL 16 was already installed in the VM, so no apt or
Docker step was needed:

```bash
service postgresql start
su postgres -c "psql -c \"CREATE USER umami WITH PASSWORD 'umami' CREATEDB;\""
su postgres -c "psql -c 'CREATE DATABASE umami OWNER umami;'"

git clone https://github.com/umami-software/umami.git && cd umami && git checkout -b hunt origin/dev   # 12cdf5777
cat > .env <<'EOF'
DATABASE_URL=postgresql://umami:umami@localhost:5432/umami
APP_SECRET=genclass-hunt-local-secret
DISABLE_TELEMETRY=1
DISABLE_UPDATES=1
SKIP_BUILD_GEO=1
EOF
npx -y pnpm@12.3.4 install          # 11 s
npx -y pnpm@12.3.4 build            # 89 s: migrations, tracker, recorder, OpenAPI client, next build
npx -y pnpm@12.3.4 start            # next start on :3000 (it warns about output: standalone; it serves fine)
node docs/adoption/hunts/umami/seed.mjs   # from this repository: 50 websites and 50 users through Umami's API
```

`DISABLE_TELEMETRY` and `DISABLE_UPDATES` keep the local Umami from calling home; `SKIP_BUILD_GEO` skips the GeoLite
download. The build creates the tables and the default `admin` / `umami` login. Both pages under test are dynamic in
the build (`ƒ /websites`, `ƒ /admin/users`), so every `router.push` to a new `?search=` makes an RSC request to the
server.

The seed script (`umami/seed.mjs`) makes names that narrow step by step: websites `{shop,blog,docs,news,mail}
{store,studio,stats,site,space} {1,2}` (search `shop` gives 10, `shop st` 6, `shop stu` 2) and users
`{anna,andre,ben,bella,carl}_{smith,stone,stark,sato,silva}_{1,2}` (`anna` 10, `anna_st` 4, `anna_sto` 2).

Umami's own tests: `tests/e2e` on `dev` holds browser tests (`login.spec.ts`, `website.spec.ts`,
`session-modal-dismiss.spec.ts`, ...) and API tests, run by `playwright.config.ts` against `pnpm dev` or
`PLAYWRIGHT_BASE_URL`; `tests/api` is a separate API suite on Docker (`docker-compose.test.yml`). The regression test
written here follows the browser tests' style and helpers (`loginPage`, `deleteWebsite`).

## 3. Attaching GenClass without touching Umami

Nothing in Umami changed for the hunt. The harness (`umami/hunt.mjs`) follows `packages/mcp/test/e2e/race.e2e.mjs`:
the `@genclass/mcp` server runs in-process (its bridge on a free loopback port) and the harness calls its tools the way
a coding agent would (`genclass_explore` start and report, `genclass_findings`, `genclass_explain`,
`genclass_replay`). In each page load:

- `page.route` rewrites the HTML document of the page under test (`/websites` or `/admin/users`; documents only, never
  RSC payloads) so its first script is the script-tag build, `<script src="/__genclass/genclass.global.js"
  data-base="/__genclass/">`, followed by a module script that imports `connectAgent` from `/__genclass/agent.js` and
  connects it to the bridge. `/__genclass/*` is a virtual same-origin path that another `page.route` serves from
  `packages/runtime/dist`. The script-tag build has no agent entry (AGENT.md section 8), so the ESM `agent.js` is
  loaded next to it and handed `window.GenClass.runtime`.
- An init script sets `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false,
  visual: false, analytics: false, report: "silent" }`: telemetry off, no model, observe mode. React state discovery
  (`autoState`) stays at the script tag's default (on).
- The browser context has `bypassCSP: true` (Umami sends a `Content-Security-Policy` header that would block the
  injected inline module) and Chromium runs with `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks`
  (otherwise the page on `localhost:3000` may not call the bridge on `127.0.0.1` without a prompt headless Chromium
  cannot answer).
- The signed-in token goes into `localStorage["umami.auth"]` before the page loads, as Umami's own `loginPage` helper
  does.
- A timeline probe, installed before GenClass and Umami, records on the page clock: keystrokes, every
  `history.pushState` (Next calls it when a navigation commits, so it marks when the new URL took effect), the start
  of each navigation RSC request and when the network answered it (the probe wraps `fetch` under GenClass's own
  wrapper, so it sees the network's timing, not GenClass's delivery), and every change of the search box's value (read
  once per animation frame). It writes nothing the app reads.

## 4. Scenarios and oracles

Each load opens the page signed in, waits for the agent link to connect and the first rows to render, clicks the search
box and types one of two patterns at 90 ms per keystroke, with a pause that straddles `DataGrid`'s 600 ms debounce so
the first `router.push` starts while the rest is still being typed:

| page | `pause` pattern | `split` pattern |
|---|---|---|
| `/websites` | `shop`, wait 700 ms, ` stu` (typed `shop stu`) | `sho`, wait 650 ms, `p st` (typed `shop st`) |
| `/admin/users` | `anna`, wait 700 ms, `_sto` (typed `anna_sto`) | `an`, wait 650 ms, `na_st` (typed `anna_st`) |

Then it waits for `window.__GENCLASS_AGENT__.whenSettled()` (nothing in flight or held, no app timer of 1 s or less
pending, so the last debounce has fired and its navigation has landed), 300 ms more, and settles again.

Each explore session is `genclass_explore start` with `runs: 6`, `slow_ms` 300, 600 or 900, `seed: 1` and the page as
`route`: 8 armed loads, the first two `fifo` baselines (responses in request order, with the same added latency as the
seeded runs), then seeds 1 to 6 (overlapping responses in a seeded order, each delayed by up to `slow_ms`). 2 pages x 2
patterns x 3 latencies = 12 sessions, 96 loads.

Two oracles per load, reported apart from explore's verdict:

- **input**: the search box's final value equals everything typed;
- **list**: the rows shown equal what Umami's own API (`GET /api/users/:id/websites` or `GET /api/admin/users`, page 1,
  `search` = everything typed) returns, compared as sets.

REST
