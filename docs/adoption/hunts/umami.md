# Race hunt: Umami list search (umami-software/umami)

A GenClass race hunt against the search box Umami shares across its list pages, run on 2026-10-24 in a cloud session
without approval checkpoints. Everything here was done on a local copy of Umami; nothing was sent to the Umami project.

**Headline: a real race, reproduced without GenClass and fixed.** Umami's shared list search (`DataGrid`, 18 searchable
list components: Websites, Admin > Users, teams, links, pixels, boards, sessions, events, replays and more) loses text
the user types after a short pause whenever the search navigation is still loading: the URL catching up with the
earlier value is copied back into the box, and the pending search for the newer text is cancelled. Under GenClass's
explore (12 sessions, 96 loads at 300, 600 and 900 ms of added latency) the box ended with the wrong text in **56 of 96
loads**, every one of the 24 serial baselines included, and the list showed the wrong rows in the same 56. Without
GenClass, Chromium's own network throttling reproduces it in **10 of 10 trials on both pages from 200 ms of added
round-trip latency** (0 of 10 at 0 and 150 ms), and a Playwright test in Umami's style that holds the first search
navigation with `page.route` **fails 5 of 5 before the fix and passes 5 of 5 after**. On the fixed build, FIXED_HEADLINE

GenClass's part, measured honestly (section 8): explore's verdict pointed at the search box in 5 of the 12 sessions on
the broken build, and in each of those its baselines were the broken runs and the runs it listed as racing were the
correct ones. In the other 7 the bug split the loads into scenario groups of their own (the recorded typed value is part
of the scenario, and the bug changes it), so explore printed "no race", no verdict, or a RACE line about noise only. On
the fixed build it printed RACE lines in FIXED_RACE_SESSIONS of 12 sessions, all of them false reports (Next's link
prefetch counts, relative times, discovered stores), none about the box or the list. No `overwrote-newer` witness fired
in any load: the box's text lives in `DataGrid`'s own `useState`, which GenClass's React discovery did not pick up.

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

## 5. Results on Umami as it is (every verdict)

`results/*-seed1.json`, summarised by `umami/summarize.mjs`. "Lost text" is the input oracle failing; the list oracle
failed in exactly the same loads (the list always matched what the box ended with, never what was typed). "After / mid"
splits the failures: the box went back to the first part after the last keystroke (`shop`, `anna`, `sho`, `an`), or the
old value landed mid-word and the remaining keystrokes were appended to it (`shopu`, `shoptu`, `shopstu`, `shost`,
`annasto`, `ana_st`, ...). The last column classifies the runs explore listed under a RACE line: their differences touch
the search box and the list, or only other things (request counts, relative times, discovered stores).

| page, pattern, `slow_ms` | lost text (list wrong) | after / mid | baselines lost text | explore verdict | scenario groups | listed runs: box and list / other only |
|---|---|---|---|---|---|---|
| `/websites`, pause, 300 | 2 of 8 | 0 / 2 | 2 of 2 | no race | 2 | 0 / 0 |
| `/websites`, pause, 600 | 5 of 8 | 3 / 2 | 2 of 2 | RACE 4 of 4 | 3 | 3 / 1 |
| `/websites`, pause, 900 | 5 of 8 | 2 / 3 | 2 of 2 | RACE 3 of 3 | 4 | 3 / 0 |
| `/websites`, split, 300 | 5 of 8 | 0 / 5 | 2 of 2 | no verdict | 4 | 0 / 0 |
| `/websites`, split, 600 | 7 of 8 | 3 / 4 | 2 of 2 | RACE 2 of 2 | 4 | 1 / 1 |
| `/websites`, split, 900 | 5 of 8 | 3 / 2 | 2 of 2 | RACE 4 of 4 | 2 | 3 / 1 |
| `/admin/users`, pause, 300 | 6 of 8 | 1 / 5 | 2 of 2 | RACE 1 of 1 | 3 | 0 / 1 |
| `/admin/users`, pause, 600 | 3 of 8 | 2 / 1 | 2 of 2 | RACE 5 of 5 | 2 | 5 / 0 |
| `/admin/users`, pause, 900 | 4 of 8 | 0 / 4 | 2 of 2 | no race | 4 | 0 / 0 |
| `/admin/users`, split, 300 | 7 of 8 | 1 / 6 | 2 of 2 | RACE 1 of 1 | 4 | 0 / 1 |
| `/admin/users`, split, 600 | 3 of 8 | 0 / 3 | 2 of 2 | no verdict | 3 | 0 / 0 |
| `/admin/users`, split, 900 | 4 of 8 | 0 / 4 | 2 of 2 | RACE 1 of 1 | 3 | 0 / 1 |
| **total** | **56 of 96** | 15 / 41 | **24 of 24** | RACE in 8, no race in 2, no verdict in 2 | | 15 / 6 |

Read by the oracles: the bug showed in every one of the 12 sessions, in 56 of 96 loads, including all 24 baselines
(responses in request order, with the session's added latency) and 32 of the 72 seeded loads. No load errored. The
seeded loads that ended right are the ones whose first navigation was held so long (behind higher-priority requests,
up to the hold limit) that the second debounced push started before it landed; the App Router then drops the older
navigation (section 8), and nothing is copied back. The bug has a window: the older navigation must land after the
user starts typing again and before the next debounce fires.

Read by explore's verdict: section 12. In short, explore was right that the final state depends on timing, its RACE
lines pointed at the box and the list in 5 sessions (15 runs), and in those the baselines were the wrong runs.

The evidence session (`results/evidence-websites-pause-slow600.json`, the same session again with `genclass_explain`
and `genclass_replay`) gave the same eight outcomes load for load: GenClass's schedules are deterministic, and so is the
bug under them. The replay of finding `f1` (the seed 3 run, which ended right) printed "REPRODUCED · ended with the same
wrong values as the failing run": it reproduced the right values, which explore calls wrong because its baselines were
the broken runs.

## 6. Negatives (recorded, not run)

The hunt brief's adversarial review had already ruled these out; they were skipped and are recorded with the code that
makes them safe:

- **Dashboard filters and date ranges**: every dashboard query keys TanStack Query by its parameters, for example
  `src/components/hooks/queries/useWebsiteStatsQuery.ts`: `queryKey: ['websites:stats', { websiteId, compare, startAt,
  endAt, ...filters }]`. A slow answer for an older range is cached under the older key and never shown for the newer
  one.
- **Settings forms**: `@umami/react-zen`'s `FormSubmitButton` is disabled while the form is submitting
  (`isDisabled: isDisabled ?? (requireValid ? ... : isSubmitting)`), and forms such as
  `src/app/(main)/settings/profile/PasswordEditForm.tsx` also pass `isDisabled={isPending}`; a second submit cannot
  start while the first is out.

## 7. The evidence, in causal order

One `/websites` baseline load at `slow_ms: 600` (`results/websites-pause-slow600-seed1.json`, load 1), from the
timeline probe; times in ms from the first keystroke:

```
    0 .. 340  keys "s" "h" "o" "p"                      box: "shop"
  960         RSC request  /websites?search=shop&page=1 (DataGrid's 600 ms debounce fired: router.push)
  975         the network has answered it (local server, 15 ms); GenClass holds the delivery (emulated latency)
 1160 .. 1500 keys " " "s" "t" "u"                      box: "shop stu"
 1529         history.pushState /websites?search=shop&page=1   (the navigation commits: useSearchParams changes)
 1548         box: "shop"                               (DataGrid's URL-to-state effect)
              no further RSC request: the push effect sees search === URL and has cancelled its timer
```

The final state: box `shop`, URL `?search=shop`, the 10 `shop` websites listed, ` stu` gone.

The mid-word form, `/admin/users` `split` at 300 ms (`results/users-split-slow300-seed1.json`, load 1):

```
    0 .. 117  keys "a" "n"                              box: "an"
  740         RSC request  /admin/users?search=an&page=1
  892         key "n"                                   box: "ann"
  953         history.pushState ?search=an               (commit)
  967         box: "an"                                 (the "n" typed at 892 is gone)
 1040 .. 1376 keys "a" "_" "s" "t"                      box: "ana_st"
 1993         RSC request ?search=ana_st, committed at 2236: the user asked for "anna_st" and got "ana_st"
```

On the fixed build the same load (`results/fixed/websites-pause-slow600-seed1.json`, load 1) runs the same way up to
the commit and then diverges: `1627 pushState ?search=shop`, the box stays `shop stu`, `2253 RSC request
?search=shop+stu`, `2867 pushState ?search=shop+stu`, 2 rows.

What GenClass recorded of the same mechanism (`genclass_explain f1`, the seed 3 run): it attributes each search
navigation to the typing action through the debounce timer (`send GET /websites#1 "?search=shop&page=1" (action 1) via
timer 600ms`), records its delivery (`delivered GET /websites#1 (held 181 ms)`), sees Next's router state take the new
URL (`write A_3.state0.tree ... "" → "?search=shop&page=1"`) and the list query refetch for it (`send GET
/api/users/:id/websites#2 "?page=1&search=shop"`), and then the second push (`send GET /websites#2 "?search=shop
stu&page=1" (action 1) via timer 600ms`). It does not show the box being written back, because it does not see the
box's state (section 12).

## 8. Root cause

`src/components/common/DataGrid.tsx` on `dev` at `12cdf5777` (the same code on `master` 3.4.1):

- line 60: `const [search, setSearch] = useState(queryParams?.search || data?.search || '');` the box's text, local state
  (`SearchField` at lines 127-134 is controlled: `value={search}`, `onSearch={handleSearch}`, `delay={0}`, so every
  keystroke sets it);
- lines 89-91: `useEffect(() => { setSearch(queryParams?.search || ''); }, [queryParams?.search]);` copies the URL into
  the box whenever `?search=` changes;
- lines 93-104: when the box differs from the URL, a 600 ms timer calls `router.push(updateParams({ search: search ||
  undefined, page: 1 }))` (line 101); the effect re-runs, and so clears the timer, whenever `search` or the URL changes;
- `src/components/hooks/useNavigation.ts` lines 8 and 14-15: `queryParams` is `Object.fromEntries(useSearchParams())`,
  memoised on its string.

Both effects came in with `079cfdde8` (2026-08-03), which moved the debounce out of `SearchField` and made the box
follow the URL ("fix activity search persistence"); first released in v3.3.0.

`router.push` is an App Router soft navigation: `useSearchParams()` changes only when the navigation commits, after the
RSC payload for the new URL has arrived (both pages are dynamic, so each search is a server round trip). If the user
types during that time, the commit fires the first effect with the older, pushed value and overwrites the newer text.
The second effect then runs with `search === currentSearch`, returns early, and the timer that would have pushed the
newer text was already cleared. If instead the user's next debounced push starts before the older navigation commits,
the App Router drops the older one: in all 30 loads of this hunt where a second search navigation started before the
first had committed, the first never committed. So the window is exactly "the older navigation lands after typing
resumes and before the next debounce fires", which needs only a navigation slower than the gap between the debounce
firing and the next keystroke: 200 ms of added round-trip latency was enough in every throttled trial (section 10).

## 9. The fix

`umami.patch` (against `dev` at `12cdf5777`; it also applies to `master`):

```diff
   const [search, setSearch] = useState(queryParams?.search || data?.search || '');
+  const pushedSearch = useRef<string | null>(null);
 ...
   useEffect(() => {
-    setSearch(queryParams?.search || '');
+    const currentSearch = queryParams?.search || '';
+
+    // The URL is catching up with our own debounced push: keep anything typed since then.
+    if (currentSearch === pushedSearch.current) {
+      pushedSearch.current = null;
+      return;
+    }
+
+    setSearch(currentSearch);
   }, [queryParams?.search]);
 ...
     const timer = window.setTimeout(() => {
+      pushedSearch.current = search;
       router.push(updateParams({ search: search || undefined, page: 1 }));
```

`DataGrid` remembers the value it pushed. When the URL arrives at that value, the box already holds it or newer text
the user typed since, so the copy is skipped once and the ref cleared; the push effect re-runs on the URL change and
pushes the newer text after the usual 600 ms. Every other URL change (back and forward, a link to a filtered list, the
first render) is still copied into the box, so the reason for `079cfdde8` keeps working (the control test in section
10). Of the two shapes the brief suggested, this one ("compare against the last pushed value") was chosen over
"ignore URL updates while the input is focused or dirty": the focused or dirty rule would also ignore a back
navigation made while the box has focus, and it needs a notion of "dirty" that the component does not have today.

Limits: it relies on the App Router dropping a superseded navigation (observed in 30 of 30 cases above). If an older
navigation ever committed after a newer push, its value would differ from `pushedSearch` and be copied, as today.
If a pushed navigation never commits (a failed RSC request), the ref keeps that value until the next push overwrites
it; a later back or forward navigation to exactly that search would then not be copied once.

## 10. Test results

**Umami's own style, without GenClass** (`tests/e2e/data-grid-search.spec.ts`, in the patch). It follows
`session-modal-dismiss.spec.ts`: `loginPage`, websites created through the API in `beforeEach` and deleted in
`afterEach`. `keeps text typed while the search navigation is loading` holds the response of the first search
navigation (`rsc: 1`, not a prefetch, `?search=revert`) with `page.route` and `route.fetch()` until the user has typed
` beta`, then releases it, so it lands inside the next debounce window as a slow network would deliver it; it then
expects the URL to reach `search=revert+beta`, the box to hold `revert beta`, and only `Search revert beta` listed.
`control: going back restores the previous search` checks that the URL-to-box sync still follows a back navigation.
Run against the production build (`PLAYWRIGHT_SKIP_WEB_SERVER=1`, Umami's `playwright.config.ts` with the VM's
Chromium as `executablePath`, `--repeat-each 5 --workers 1`):

| build | `keeps text typed while the search navigation is loading` | `control: going back restores the previous search` |
|---|---|---|
| `dev` as it is | **failed 5 of 5**: `Expected pattern: /[?&]search=revert(\+\|%20)beta(&\|$)/`, `Received string: "http://localhost:3000/websites?search=revert&page=1"` | passed 5 of 5 |
| `dev` + `umami.patch` | **passed 5 of 5** | passed 5 of 5 |

A first run with Playwright's default worker count failed the control too: `--repeat-each` put copies on two workers at
once and both created websites with the same names (a strict-mode violation). Umami's CI runs one worker
(`workers: process.env.CI ? 1 : undefined`); the numbers above are with one worker.

**Throttling only, without GenClass and without intercepting anything** (`umami/throttle.mjs`): Chromium's network
emulation through CDP (`Network.emulateNetworkConditions`, latency only), typing `shop` / `anna` at 90 ms per key, a
700 ms pause, then ` stu` / `_sto`; 10 trials per cell (`results/throttle-*.json`):

| added round-trip latency | `/websites` lost text, unfixed | `/admin/users` lost text, unfixed | `/websites`, fixed | `/admin/users`, fixed |
|---|---|---|---|---|
THROTTLE_ROWS

**Static checks on the patched tree**: `biome check` on the two changed files is clean; `pnpm lint` reports 6 errors,
12 warnings and 11 infos, the same counts as a clean `dev` checkout (none in the changed files); `tsc --noEmit` (with a
6 GB heap; the default heap aborts) reports 2 errors, both in files the patch does not touch (`src/app/mcp/route.ts`,
`src/app/api/admin/users/[userId]/2fa/route.test.ts`); Umami's `next.config.ts` sets `typescript.ignoreBuildErrors`, so
`pnpm build` (53 s, passed) does not type-check. Umami's other suites (vitest, `tests/api` on Docker) were not run: the
patch touches one client component and adds one e2e spec, and the VM has no Docker daemon for `tests/api`.

## 11. The fixed-variant check

The same 12 explore sessions (2 pages x 2 patterns x `slow_ms` 300, 600, 900; seed 1; 2 baselines and 6 seeded loads
each, 72 seeded loads) on the patched build (`results/fixed/`):

FIXED_TABLE

## 12. What GenClass could and could not see on this app

What it saw:

- every search navigation as a request, attributed to the typing action through the 600 ms debounce timer (`(action
  1) via timer 600ms`), with its hold and delivery time;
- the state changes the navigation causes: Next's router tree taking the new URL (a discovered store, `A_3.state0.tree`)
  and React Query's list result (`search.external9.data.search`, `.count`, `.data`, written by the list API response);
- the box's value as a form field (`field "Search"`) in each settled snapshot, which is how explore's diffs named the
  bug in 5 sessions.

What it did not see, and what that cost:

- **The box's own state.** `DataGrid`'s `useState` holding the text is not among the 192 store fields GenClass
  discovered on `/websites` (no short string field held `shop` or `shop stu` apart from React Query's
  `data.search`). Why is not certain: in the production build component names are minified, so GenClass names
  discovered stores after the instance's first rendered element, and `WebsitesDataTable` and the `DataGrid` it renders
  share that element; the store GenClass called `search` holds the list query's result, and the box's text appeared in
  no store. Without it, the write that loses the text cannot be seen, and no `overwrote-newer` witness fired in any of
  the 96 loads (nor in the 96 on the fixed build). The router tree write was also recorded without a cause (`write
  A_3.state0...` with no `by GET /websites#1`), so the chain from the RSC response to the effect was not linked either.
- **Which side is wrong.** Explore takes the serial baselines as the reference. Here the baselines were the broken
  runs in all 24 cases (the added latency alone opens the window; the order of responses does not matter), so every
  RACE line that named the box listed a correct run as the racing one, and the replay "REPRODUCED the wrong values" was
  the right values. Explore's claim (the final state depends on network timing) was true; the direction needed the
  oracle.
- **Runs the bug itself regroups.** A scenario is the user's actions with each typing burst's final value. When the
  old value lands mid-word, the burst's recorded value changes (`shopu` instead of `shop stu`), so the load forms a
  scenario of its own. Both "no race" sessions are this: on `/websites` pause 300 both baselines ended `shopstu` and
  formed a group with no seeded load ("No race found: all 0 reordered run(s) ended in the baseline's state"), while the
  six correct seeded loads formed a group with no baseline; `/admin/users` pause 900 the same with `annato`. Both "no
  verdict" sessions are this too: the two baselines lost text differently (`shost` and `shot`; `anst` and `an_st`), so
  each sat alone in a group, and the report blamed it on "another page load took the other baseline slot", which is
  not what happened. Grouping a burst by its keystrokes rather than the field's final value would keep these loads
  together.
- **False reports** on the broken and the fixed build alike: request counts of Next's link prefetches
  (`GET /websites/:id`, `GET /websites/:id/settings`: the rows on screen are prefetched, and which rows are on screen
  depends on when each list rendered), one list fetch fewer when a navigation was superseded, relative times that
  crossed a minute between loads (`37 minutes ago` against `38 minutes ago`: the baselines agreed, so the line was not
  marked as noise), and discovered stores present in one load and absent in another. The Ghost hunt reported the same
  classes.
- **A misleading key.** Next's segment prefetch issues a second request for the same path from the first one's
  response handler; the agent's schedule names it `GET /links#1~hedge`, the label it uses for GenClass's own hedges,
  although GenClass ran in observe mode with the model off and sent nothing.
- **Forced deliveries.** Seeded loads report 2 to 10 responses delivered only because their hold ran out
  (`maxHoldMs` 1.8 to 2.4 s): the page makes many concurrent prefetches, so a seeded order cannot always be followed.
  The reports say so; it does not change the oracles.

## 13. Time spent

About TIME_TOTAL of wall-clock time in one session (23:24 to TIME_END UTC): setup (GenClass build, Umami clone, install
and build, PostgreSQL, seeding) about 15 minutes; the harness and the first explore session 10 minutes; the 12-session
matrix 13 minutes (runs while the regression test and fix were written); evidence session, Playwright and throttling
runs on the broken build 15 minutes; rebuild, Playwright, the fixed matrix and throttling on the fixed build
TIME_FIXED; the report the rest.

## 14. Reproducing

```bash
# this repository, both packages built:
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp

# Umami running as in section 2, then:
node docs/adoption/hunts/umami/seed.mjs
node docs/adoption/hunts/umami/hunt.mjs websites pause --slow 600 --seed 1          # one explore session (8 loads)
node docs/adoption/hunts/umami/hunt.mjs users split --slow 300 --seed 1
node docs/adoption/hunts/umami/hunt.mjs websites pause --slow 600 --replay --label evidence-websites-pause-slow600
node docs/adoption/hunts/umami/summarize.mjs                                       # the table in section 5
node docs/adoption/hunts/umami/throttle.mjs --trials 10 --latency 0,150,200,250,300,400

# Umami's regression test (from the Umami checkout, umami.patch applied or not):
PLAYWRIGHT_SKIP_WEB_SERVER=1 npx playwright test tests/e2e/data-grid-search.spec.ts --repeat-each 5 --workers 1
```

Files: `umami/hunt.mjs` (the explore harness), `umami/seed.mjs`, `umami/throttle.mjs`, `umami/summarize.mjs`,
`umami/results/` (one JSON per session: every load's oracles, timeline, schedule and GenClass's report, findings and
explanations; `fixed/` for the patched build; `throttle-*.json`), `umami.patch`, `umami-issue.md`. Two harness changes
were made while the broken-build matrix ran, neither touching what a load does: the explain step first missed finding
ids written as `f1.` (the first three `/websites` sessions have the report but no `explains`; the evidence session
covers the first of them), and the per-load `genclass` field (GenClass's own snapshot of the form field and string
state) was added before the evidence session, so the twelve broken-build session files do not have it.
