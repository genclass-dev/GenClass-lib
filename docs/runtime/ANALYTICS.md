# Interaction analytics: design

Status: design written 2026-10-17 and **approved by the owner the same day** with every recommendation in
[section 9](#9-decisions-for-the-owner) (AGENTS.md rule 8: widening what telemetry sends needs that OK). **Built**
2026-10-18 on branch `feat/interaction-analytics`: the runtime (`packages/runtime/src/analytics/`), the collector
and the dashboard (`telemetry-worker/`), and the admin filter for genclass.dev (`site/src/admin.js`); the differences
from this note are in [section 10](#10-implementation-notes). Not released: genclass.dev needs a runtime release
first (section 7).

**Product analytics (2026-10-25).** The owner asked for analytics "like PostHog in the dashboard ... choose the most
easy and reliable way". Section [1.2](#12-visits-sources-devices-unreleased) adds visits, where they came from,
devices, countries, new or returning, entry and exit pages and funnels, inside the same `analytics: true` opt-in and
the same no-text rule; section [3.1](#31-visits-and-funnels) says how the collector counts them.

**Why not embed PostHog, Plausible or Umami.** Each is a good product, and each would be a second pipeline: the hosted
versions send the app's visitors' page views to another company (a new recipient for every app's privacy policy,
and for EU visitors a transfer to assess), and the self-hosted versions are a service someone has to run, upgrade and
back up (PostHog needs ClickHouse, Kafka and Postgres; Plausible ClickHouse and Postgres; Umami a database and a Node
server). Their own snippet would also be a second script in every app, with its own cookie or storage and its own
consent, next to GenClass's. And the dashboard's Content-Security-Policy allows no third-party script, so an embedded
chart (an iframe or a script from their host) would need that policy loosened on a page that holds a private link.
GenClass already has the pieces: an opt-in runtime chunk that counts per page view without text, a collector that
aggregates into D1 per app, and a dashboard with tables and charts. Extending those is less code than integrating
any of the three, adds no dependency and no recipient, keeps one consent switch (`analytics: true`,
`runtime.analytics.start()`), and keeps every number in the same export. What this gives up: PostHog's session
replay, feature flags, arbitrary custom events and ad-hoc queries. Funnels here are over page routes only.

The owner asked on 2026-10-17: "can genclass please track all the clicks, and scrolls, time spent everywhere, and then
we'll put genclass on our own website to track everything." This note says what the runtime would record, how the
collector would count it, what the dashboard would show, how an app turns it on, and what consent it needs.

## 1. What is recorded

Everything is counted per **page view** in the browser and sent as counts, never as a stream of individual clicks.
A page view starts when GenClass starts and again at every route change (a new path: `pushState`, `popstate`,
`hashchange` that changes the path, a full navigation).

| field | what it is |
|---|---|
| route | the page path as telemetry already sends it: id-like segments and segments holding an `@` become `:id`, no query, no fragment, at most 200 characters |
| page views | 1 per page view |
| engaged time | ms the tab was visible, counting at most 30 s after the visitor's last input (pointer move or press, key, wheel, scroll, touch). A tab left open in the background or untouched for an hour adds at most 30 s |
| scroll depth | which of 25 / 50 / 75 / 100 % of the page height the bottom of the viewport reached in this view. A page that fits the screen reaches 100 % at once |
| clicks | count per element, the element named by its **element key** (below) |
| rage clicks | 3 or more clicks on the same element within 1 s, counted once per burst, per element; not while the visitor is selecting text (a triple click selects a paragraph) |
| dead clicks | a click on a link or button (the `a`, `button`, `[role=button]`, `[role=link]`, `[role=tab]`, `[role=menuitem]` and button-type inputs) after which nothing changed within 1 s: no DOM mutation outside `[data-genclass-ignore]`, no URL change, no page hide. Not counted: modified clicks (Ctrl, Cmd, Shift, Alt, a button other than the main one), links with `target` other than `_self` or with `download`. A click on a control marked `aria-disabled` counts (the visitor tried and nothing happened); browsers send no click for a natively `disabled` button |

**Element key.** A short name for the element, built from markup only, at most 120 characters. In order:

1. `[data-genclass-name="pricing-cta"]`: a name the app put on the element. This is the way to get readable keys.
2. `[data-testid="..."]` (or `data-test-id`).
3. `tag#id`, when the id does not look generated (the visual checks' `GENERATED_ID`: `:r1:`, `headlessui-…`, long hex,
   4+ digits) and does not look like data (telemetry's `DATA_LIKE`: an e-mail address, a URL, 4+ digits, 12+ hex).
4. For a link, `a[href="/pricing"]`: a same-origin `href` as a route (normalised as above); another site's as its
   origin only (`a[href^="https://github.com"]`).
5. The tag with up to two stable class names (hashed CSS-module and CSS-in-JS classes and utility classes dropped,
   as in the visual checks' `selectorOf`).
6. Else an `nth-of-type` path of up to 4 levels under the nearest ancestor that has one of 1 to 3 or is a landmark
   (`header`, `nav`, `main`, `aside`, `footer`, `form`, `dialog`): `nav > ul > li:nth-of-type(3) > a`.

Every part that comes from an attribute goes through `DATA_LIKE`; one that matches is dropped and the next rule is
used. A click inside a control counts for the control (the same `closest()` the user-action observer uses).

**Never recorded:** element text, `aria-label`, `title`, `alt`, `placeholder`, input values, what was typed, mouse
coordinates, the click order or timing (a sequence of clicks), the query string or fragment (except the three utm
values of section 1.2), the referrer's path or query, the page title, the screen size, the user agent string, a
visitor id. No cookies. Since section 1.2 one `localStorage` entry links the page loads of one visit (30 minutes);
nothing links two visits except a yes-or-no "visited before" flag, so the dashboard cannot count unique visitors.

**Not counted:** synthetic events (`isTrusted` false, whatever `observe.untrustedEvents` says), events inside
`[data-genclass-ignore]` (the devtools overlay), events while GenClass is paused or off.

### 1.1 What is sent

One new telemetry event type, `interactions`, on the existing batches (schema `genclass-telemetry/1`):

```jsonc
{ "t": "interactions", "seq": 41, "at": 61234,
  "view": 2,                       // page view number in this page load
  "route": "/pricing",
  "start": true,                   // first event of this view: the collector counts a page view
  "engagedMs": 18450,              // since this view's previous interactions event
  "scroll": [25, 50],              // milestones first reached since the previous event
  "clicks": { "[data-genclass-name=\"pricing-cta\"]": 2, "a[href=\"/docs\"]": 1 },
  "rage": {},                      // same keys, omitted when empty
  "dead": { "button.copy": 1 },
  "end": true }                    // the view ended (route change, pagehide, destroy)
```

Every count is a delta since the previous `interactions` event of the same view, so the collector only adds. An event
is queued when a view ends, when the tab is hidden (before the existing hidden flush) and before the minute's
`summary`, and only if something changed. At most 50 element keys per event for `clicks` and 20 each for `rage` and
`dead`; the rest are added up under `(other)`. A view of a few minutes sends one or two events of well under 2 KB.

### 1.2 Visits, sources, devices (Unreleased)

Built 2026-10-25 (branch `dash-analytics`) on the owner's request above, inside `analytics: true`; nothing changes
without it.

- **Visit.** Page views with no gap over 30 minutes (`VISIT_IDLE_MS`, as Google Analytics and PostHog define a
  session). The chunk keeps `localStorage["genclass.analytics.<token>"] = { v, t, r }`: `v` a visit id (16 random hex
  characters from `crypto.getRandomValues`), `t` the wall time of the visit's last page view or `interactions` event
  (`performance.timeOrigin` plus the runtime's Clock: only compared with the stored value, never sent), `r: 1` once
  the browser has had a visit. A view opens a new visit when `t` is more than 30 minutes away, or when its page load
  came from another site or a utm link (a new campaign is a new visit). The entry is written with `rt.selfStorage`
  set, so the runtime's storage observer does not record it (rule 1: nothing in the event log changes), and
  `runtime.analytics.stop()` removes it. Storage blocked: a visit lasts the page load, `returning` is not sent.
- **Sent**, on the `interactions` event that starts a view: `visit`. On the view that opened the visit also `entry:
  true` and:

| field | what it is |
|---|---|
| `ref` | `document.referrer`'s host, lower case, `www.` dropped, only when it is another host than the page's (`android-app://` package names count); at most 80 characters; `(other)` when it looks like data (telemetry's `DATA_LIKE`). Absent: direct, or this site |
| `utm` | `{ source, medium, campaign }` from the page URL's `utm_source`, `utm_medium`, `utm_campaign`, each lower case, only letters, digits, `. _ + -` and spaces, words with 4+ digits, 8+ hex characters or 20+ characters dropped (ids), at most 40 characters, dropped when the rest still looks like data |
| `device` | `desktop`, `mobile` or `tablet`, from the user agent and `navigator.userAgentData.mobile` (iPadOS's desktop-mode string with touch points counts as a tablet) |
| `browser` | `Chrome`, `Safari`, `Firefox`, `Edge`, `Opera`, `Samsung Internet` or `Other` (bots and headless browsers: `Other`) |
| `os` | `Windows`, `macOS`, `iOS`, `Android`, `Linux`, `ChromeOS` or `Other` |
| `returning` | whether the stored entry existed before this visit (absent with storage blocked) |

- **Country** comes from the collector (`request.cf.country`, already stored with every batch), counted once per
  visit. The runtime sends none.
- **First load:** nothing; all of it is in the lazy chunk (`src/analytics/index.ts`), and the stub is unchanged.

## 2. How it is built in the runtime

- **Opt-in, lazy chunk.** `InitOptions.analytics` (section 4). Off means nothing: no listener, no import. On, a small
  stub in `src/telemetry/` imports `src/analytics/` (a separate chunk, like the visual checks) once telemetry has
  started. CI fails a first-load growth of 0.5 KB (`test/first-load-size.mjs`); the stub is the only first-load cost.
- **Own listeners, outside the trace.** The chunk adds passive capture listeners (`click`, `pointerdown`, `pointermove`,
  `keydown`, `wheel`, `touchstart`, `scroll`, `visibilitychange`, `pagehide`, `popstate`, `hashchange`). It reads
  route changes from `rt.on("event")` (`nav` events) and, when the nav observer is off, from `location.pathname` at
  each input. It never calls `rt.user`, `rt.emit` or `rt.op`, never writes to the event log, and nothing it computes
  reaches a situation, a fact, the gate or the model. `src/observe/dom-user.ts` and every model-visible string stay
  as they are (rule 3); only its `INTERACTIVE` selector and `ignoredEvent` are exported for reuse.
- **Rule 1.** Passive listeners, no `preventDefault`, no DOM writes, in every mode including `observe`.
- **Rule 2.** Rage and dead clicks are measurements with fixed thresholds (3 clicks in 1 s; nothing changed in 1 s),
  reported as counts, never as a diagnosis, never as a reason to act.
- **Rule 5.** All times from the runtime's `Clock`; no timers while the visitor is idle. A dead-click check holds one
  `MutationObserver` for at most 1 s after a click on a link or button, then disconnects.
- **Cost.** Per input: a clock read and a comparison. Per scroll: one read of `scrollY`, `innerHeight` and
  `scrollHeight`, at most every 250 ms. Per click: building the element key (bounded walk of 4 ancestors).

## 3. Collector and dashboard

**Ingest.** `src/collector.ts` is unchanged: the batch is stored in R2 as today. `summarize()` in `src/dashboard.ts`
adds counters for `interactions` events, in the existing `daily` and `hourly` tables, no migration:

| metric | key | count |
|---|---|---|
| `ix_views` | `''` and the route | page views (`start: true`) |
| `ix_engaged_ms` | `''` and the route | engaged ms |
| `ix_scroll` | route, tab, milestone | views that reached it |
| `ix_click` | `''`, and route, tab, element key | clicks |
| `ix_rage`, `ix_dead` | `''`, and route, tab, element key | rage / dead clicks |

Interaction counters get their own per-batch budget (200 counters), so they never push out the diagnostics counters
(`MAX_COUNTERS`). A batch that repeats one already counted is skipped as today. Retention is the dashboard's: 90 days
(1 year on Enterprise), hourly rows 48 hours.

**Dashboard.** A "How visitors use this app" section on the app dashboard (`src/pages.ts`, every plan, the same range
picker), filled once the app has sent `interactions` events (before that, the setup below, with the runtime they
need: section 4.1), using the page's existing table and card styles:

- page views, average engaged time per view, clicks, rage clicks, dead clicks, with the change against the previous
  period, and page views on the timeline;
- per page: views, average engaged time, share of views reaching 50 % and 100 %;
- most clicked elements (page, element key, clicks), and rage and dead clicks the same way, worst first;
- a line saying unique visitors are not counted (no visitor id is stored, by design).
- (Section 1.2, 2026-10-25) Sources (Table 7, referring sites; Table 8, utm values), Devices (Table 9: device,
  browser, system, country, new or returning), Sessions (visits with the change on the previous period, visits per
  day, pages per visit, one-page visits, returning share, Fig. 5 visits per bucket), Entry and exit pages (Tables 10
  and 11) and Funnels (Fig. 4: per step the visits, the share of step 1 and of the step before, where most visits are
  lost, and an editor: a name and one route per line). For an app without analytics the Visitors view is one big
  button, "Copy the prompt for your coding agent" (the same button sits in account mode's Connect panel), that copies
  a prompt to install `@genclass/runtime@beta`, add `analytics: true` with the app's token to whichever config the app
  uses, respect consent with `runtime.analytics.start()`, run the dev server once and say where the numbers appear.

The footer stays true and gets one clause: "…and, for apps that turn on interaction analytics, page views, time on
page, scroll depth and clicks per element (named by a selector or a name the app gave it, never its text). No text
from your pages, no IP addresses and no user agents are stored."

### 3.1 Visits and funnels

- **Per-visit counters** (the view with `entry: true`, in the `ix_*` budget): `ix_sessions` (`''`), `ix_ref` (the host
  or `(direct)`), `ix_utm_source`, `ix_utm_medium`, `ix_utm_campaign`, `ix_device`, `ix_browser`, `ix_os`,
  `ix_country`, `ix_returning` (`new` / `returning`). The collector checks every value against the runtime's buckets
  or a pattern, whatever the client sent (an unknown device is `(unknown)`, an unknown browser or OS `Other`, a bad
  host `(other)`, a bad utm value is not counted). `ix_sessions` is on the timeline and in `previous`.
- **The `visits` table** (migration `0010_visits_funnels.sql`): one row per visit, keyed by
  `sha256(token + ":visit:" + id)` (never the id), with `started`, `updated`, `entry`, `exit`, `pages` and `routes`,
  the routes of about its first 50 page views (`VISIT_ROUTES`; the batch that crosses 50 still goes in whole) as
  `\t/a\t\t/b\t`. An upsert per visit per batch, in the same `db.batch` as the counters and skipped with them for a
  repeated batch. At most 5 visits per batch. Deleted 90 days after `started`, on every plan, and with the account.
- **Stats:** `visits` (`sessions`, `pages`, `bounces` (one page view), top 25 `entry` and `exit` pages) over the
  visits that started in the period; `funnels` with per-step counts.
- **Funnels.** `projects.funnels` (JSON): up to 5 funnels of 2 to 6 steps, a step a route normalised like the
  runtime's (`/products/123` becomes `/products/:id`) or a prefix ending in `*` (`/docs/*`). Step k counts the visits
  whose routes match `GLOB '*\t<step 1>\t*\t<step 2>\t* ... *'` for the first k steps: those steps in that order,
  other pages allowed between them, case-sensitive. Counted at read time from the stored routes, so a funnel defined
  today counts the past 90 days. Saved with `PUT /api/projects/<secret>/funnels` (the private link) or
  `PUT /api/account/projects/<id>/funnels` (the owner's browser session with the site's Origin), body
  `{ "funnels": [{ "name", "steps" }] }`, the whole list at once, at most 4 KB; the sample dashboard answers 403.

## 4. How an app turns it on

```ts
GenClass.init({ token: "gc_…", analytics: true });
```

- **Default: off.** It records nothing unless the app sets `analytics: true` (also `data-analytics="on"` on the
  script tag, `<meta name="genclass" content="analytics=on">`, `window.GENCLASS_CONFIG.analytics`).
- **Needs telemetry and a token.** Analytics only feed a dashboard, so they are sent only on batches that carry the
  app's token, or to a custom `telemetry.endpoint`. Without either, `analytics: true` warns once and stays off.
- **After consent.** `rt.analytics.start()` turns it on later, `rt.analytics.stop()` turns it off and drops the
  counts not sent yet. `rt.analytics` reports `{ enabled, reason? }` (`option`, `telemetry-off`, `no-token`,
  `stopped`).
- `telemetry.sample` below 1 samples analytics with the page load; the dashboard does not scale counts up.

### 4.1 Which runtime: loud, never silent

Interaction analytics first shipped in `@genclass/runtime` **0.3.0-beta.1**, on npm's `beta` dist-tag (install it with
`npm install @genclass/runtime@beta`, `npx @genclass/runtime@beta init`, or a script tag pinned to
`@0.3.0-beta.1`). npm's `latest` is still `0.2.2` until 0.3.0 is stable, and `0.2.x` and `0.3.0-beta.0` have no
analytics: they ignore `analytics: true` without a word (reproduced on 0.2.2 in jsdom: no warning, no
`runtime.analytics`, nothing sent; a TypeScript app gets a type error for the unknown option). Those releases cannot
change, so every path that the newest line controls says it instead:

- **The runtime.** The script tag loads `dist/analytics/index.js` by URL from its base, so a self-hosted `dist/` can
  lack it or hold files of two releases (an app's bundler ships the chunk with the runtime it came with, so the ESM
  entries cannot mix them). The tag's loader (`src/cdn/analytics-loader.ts`) warns when the chunk does not load,
  once per load: `[GenClass] analytics: <url> (@genclass/runtime <version>) did not load; nothing is recorded. Serve
  every file of this version's dist/.`, and `runtime.analytics` reports `{ enabled: false, reason: "error" }`. It
  passes the tag's version to the chunk, and a chunk of another release warns once per page with both versions and
  the install line, and still records. Both live in the script-tag build and the lazy chunk: the ESM first load does
  not grow for them.
- **The CLI.** `init` prints its version and the dist-tag it came from, says when npm has a newer release, and
  upgrades an older `@genclass/runtime` in the project instead of keeping it (packages/runtime/README.md, "Which
  version").
- **`genclass_setup`** (`@genclass/mcp`) prints `npm install @genclass/runtime@beta` for a project on 0.2.x, on a range
  without a version (`*`, `latest`) or with an older installed copy.
- **The dashboard.** Under the copy-prompt button, the Visitors view of an app without interaction data says that
  analytics need 0.3.0-beta.1 or later with the install line and names the app's older runtime versions from its own
  telemetry; the Connect panel says the same.

## 5. Consent and opt-outs

- Every telemetry opt-out also turns analytics off: `telemetry: false`, `?genclass=no-telemetry`, `?genclass=off`,
  `localStorage` `genclass.telemetry = off`, **Global Privacy Control**, local and private hosts (unless telemetry is
  set explicitly), `createRuntime()` and SSR without the option.
- No cookies and no persistent id: the session id stays random per page load. Since section 1.2 one `localStorage`
  entry holds the visit id (30 minutes) and the "visited before" flag; it is written only while analytics run and
  `runtime.analytics.stop()` removes it. Under the ePrivacy rule below this is storage on the device, which the
  consent advice already covers.
- **EU, EEA and UK.** Article 5(3) of the ePrivacy Directive (PECR regulation 6 in the UK) requires consent to store
  or read information on a visitor's device unless it is strictly necessary for the service the visitor asked for,
  and the EDPB's Guidelines 2/2023 read it as covering scripts that read information on the device and send it, not only cookies.
  Interaction analytics are not strictly necessary, so sites with EU, EEA or UK visitors should start with analytics
  off and call `rt.analytics.start()` once the visitor consents. Some regulators exempt first-party audience
  measurement under strict conditions (the CNIL in France); GenClass does not decide that for an app. The GDPR still
  applies to the collection itself (the visitor's IP reaches the collector at the network level even though it is not
  stored), so the app's privacy policy must name GenClass as a recipient; data processing terms are not published yet.
- **US.** No sale or sharing, and GPC is honoured for everyone. Apps still disclose it in their privacy policy.

The maintainers use `interactions` events only for the app's dashboard and its export: they are not used for model
training or evaluation.

## 6. Disclosures to update when it ships

`packages/runtime/TELEMETRY.md` (the event, the options, the consent text), the console notice (one more sentence when
analytics are on: "Interaction analytics are on: page views, time on page, scroll depth and clicks per element, never
page text."), both READMEs, `packages/runtime/CHANGELOG.md`, `docs/runtime/API.md`, the JSDoc in `src/types.ts`,
`PRIVACY.md` and `site/src/pages/privacy.html`, the dashboard footer, `telemetry-worker/README.md`, and
`billing/plans.json` (Free's "Interaction analytics (coming next)" becomes available once a runtime with it is on npm).

## 7. genclass.dev adopting it

The site pins runtime 0.2.2, so this needs a runtime release through `release.yml` (asked separately; never by hand).
Then:

1. Create an app for genclass.dev in the owner's account (its token goes in the page; its dashboard is the owner's).
2. Add the runtime to every page's head (today only `/` and `/docs` load it) with `model: false` outside the lab, so
   other pages do not download the model, and `analytics: true` with the token.
3. The lab sets `telemetry: false` today, and its footer says "Telemetry is off on this site". Analytics need
   telemetry on, so the lab's decisions (guard, eager profile, margins at 0) would be sent too. **Decided:** filter
   host `genclass.dev` out of model evaluation in the admin ingest (done on this branch, `site/src/admin.js`), and
   change the footer sentence.
4. **Decided:** record analytics only outside the EU, the EEA and the UK until the site has a consent banner. The
   site worker (`site/src/worker.js`) adds `<meta name="genclass" content="analytics=on">` to the page's head with
   HTMLRewriter only when `request.cf.country` is outside the EEA, the UK and Switzerland (and not unknown); the pages
   start GenClass without an `analytics` option, so the meta tag decides, and visitors elsewhere get diagnostics only.
   The page must not be cached across countries with that tag (it is added per request, after the static asset).
   Update genclass.dev's privacy page: it describes GenClass's diagnostics for other apps, not tracking on
   genclass.dev itself.
5. Add `data-genclass-name` to the calls to action so the keys read well (`hero-start`, `pricing-pro`, `scan-submit`).

## 8. Tests

Runtime (vitest, happy-dom, the fake clock): nothing sent without `analytics: true`, without a token, or with each
opt-out and GPC; element keys from each rule and never from text; `DATA_LIKE` ids and attributes dropped; engaged
time with idle and hidden tabs; scroll milestones; rage bursts; dead clicks with and without a mutation, with
`target=_blank` and modifier clicks; route changes; deltas add up across hidden flushes; no `user` op, event or
situation change (the situation text of a scripted run is byte-identical with analytics on and off); the first-load
size. Collector: counters, the separate budget, repeated batches, stats and the dashboard section rendered in
happy-dom.

## 9. Decisions for the owner

All five approved as recommended on 2026-10-17, with genclass.dev's: filter host `genclass.dev` out of model
evaluation (option one in section 7 step 3), and record analytics only outside the EU, EEA and UK until the site has
a consent banner (section 7 step 4).

1. **Fields** as in section 1 (route, page views, engaged time, scroll milestones, clicks, rage and dead clicks per
   element key). Recommended.
2. **Default off**, opt-in with `analytics: true`, and only with a token (or a custom endpoint). Recommended: a
   default-on clickstream from every app using GenClass would change what the library is.
3. **Element key sources**: data attributes, then ids, then link targets, then stable class names, then a structural
   path. Recommended. The stricter alternative drops ids and class names (more `nth-of-type` paths, less readable).
4. **Storage**: `interactions` events stored in R2 with the batch (90 days, and in the paid export), but never used
   for model training. The alternative strips them from R2 and keeps only the dashboard counters.
5. **genclass.dev**: which of the two options in section 7 step 3, and how to handle consent for EU, EEA and UK
   visitors (section 7 step 4).

## 10. Implementation notes

What the build (2026-10-18) does where this note was not specific, or differs:

- **Runtime.** `src/analytics/start.ts` (first load: `runtime.analytics`, the chunk loader) and `src/analytics/index.ts`
  (the lazy chunk, one file with no static imports; the script tag loads `dist/analytics/index.js` by URL). The
  telemetry client gained a `pre` hook, called first in every `summary()`, where the chunk queues its event so it
  goes out in the same flush; `push`, `route` and `stopped` lost their `private` modifier for the chunk. The chunk
  copies the `INTERACTIVE` selector from `dom-user.ts` and the generated-id and class rules from the visual checks
  instead of importing them (a static import would make it depend on another file). `runtime.analytics.reason` can
  also be `"error"` (the chunk did not load).
- **Console.** One line when analytics start: `[GenClass] Interaction analytics are on (this app turned them on):
  page views, time on page, scroll depth and clicks per element, never page text.` Without a token:
  `[GenClass] analytics: true needs the app's token; nothing is recorded.`
- **Route changes** come from the runtime's `nav` events when the nav observer is on (exact); without it, from
  `location.pathname` at the next input, so the time between a navigation and that input counts for the previous page.
- **First-load cost:** 288 B gzip on `/auto` and 275 B on the main entry over main (RESULTS.md section 15), under the
  CI gate (0.6 KB) but over `test/bundle.test.ts`'s limits, which this branch raises to 108.6 / 100.48 KB (approved
  by the owner on 2026-10-18).
- **Collector.** `ix_*` counters (section 3) in a separate per-batch budget of 200; at most 60 element keys read per
  map, counts above 10,000 per key per event and engaged time above 24 h per event ignored; element keys cut to 120
  characters and routes to 100. Stats keep the top 200 keys of every `ix_*` metric, add `ix_views` to the timeline and
  to `previous`. The sample dashboard (`/dashboard/sample`) shows simulated interaction data.
- **Dashboard.** "How visitors use this app" (page views with the change on the previous period, time on page,
  clicks, rage and dead clicks; Table 4, pages with views, time on page and the share of views reading half and to
  the end) and "Most clicked" / "Rage and dead clicks" (Tables 5 and 6), after Recent activity, with a "Visitors" link
  in the sidebar; all hidden until the app sends `interactions` events. Built from the page's existing classes; no
  CSS changed.
- **Admin.** `site/src/admin.js` marks `genclass.dev` and `www.genclass.dev` as test hosts, so their sessions,
  decisions and detections stay out of the model numbers unless "Include test traffic" is ticked; it never reads
  `interactions` events.
- **Not done here:** `billing/plans.json` still says "Interaction analytics (coming next)" for Free (every plan has it); it becomes
  available when a runtime with analytics is on npm. genclass.dev's own pages are unchanged (section 7).

## 11. Navigation paths (2026-10-25)

The owner asked on 2026-10-25 for "exact specifics of how a user navigates the site". This widens what interaction
analytics send (AGENTS.md rule 8); the owner asked for it, and it stays inside the same opt-in: nothing of it exists
unless the app sets `analytics: true`, with the app's token, every telemetry opt-out and Global Privacy Control
turning it off, and the same consent advice (section 5). Built on branch `strange-sites`.

### 11.1 What is added

Four things per page load, on the existing `interactions` events, aggregated by the collector like views, clicks and
scroll depth (counts per route and per element key, never a stored sequence per visitor):

| field | on which event | what it is |
|---|---|---|
| `nav` | a view's first event (`start: true`) | how the visitor reached this view: `load` (a normal page load), `reload`, `back_forward` (a page load or a restore from the back/forward cache by the browser's back or forward button, from Navigation Timing's `type` and `pageshow.persisted`), `push` (an in-app route change by `pushState` or `replaceState`, or one seen at the next input when the nav observer is off), `back` or `forward` (an in-app history traversal, `popstate`, the direction read from the Navigation API's entry index where the browser has it), `pop` (a traversal whose direction the browser does not expose) |
| `from`, `fromMs` | a view's first event, from the second view of a page load on | the previous view's route in this page load, and the ms from that view's start to this one's (on the runtime's Clock): the route-to-route step and the time between |
| `first`, `firstMs` | the event after the view's first interaction, once per view | the element key (section 1, the same keys clicks use) of the first click, or of the first focus on a form field (`input`, `select`, `textarea`, an editable region) for keyboard users, and the ms from the view's start |
| `exit`, `path` | the page load's last event (`pagehide`) | `exit: true` marks where the page load ended; `path` lists the routes of its views in order, at most 10 (a longer path ends with `"(more)"`). After a restore from the back/forward cache a new path starts |

Everything else in section 1 holds: routes are normalised as telemetry sends them (ids and `@` segments as `:id`, no
query, no fragment), element keys come from markup only and never from text. These fields add nothing to what is
stored on the device (the visit entry of section 1.2 is the only one).

What changes in the "Never recorded" list: the **order of page views within one page load** and the time between
them are now recorded (the order and timing of clicks still are not). These fields describe one page load: a full page
navigation to another page of the same app ends one page load (`exit`) and starts another (`nav: "load"`, no `from`).
Following pages across page loads is the visit's job (section 1.2: the visit id, and the visit's routes the collector
stores for entry and exit pages and funnels). So on a site without client-side routing every path here is one page
long, and a page load's end means "the visitor left this page", not "left the site"; the visit's exit page says that.

Not sent: the referrer, the URL a link pointed to beyond its element key, the history length, the Navigation API's
entry keys or ids, scroll positions per step, the time of day beyond the batch's own timestamp.

A page load that ends without `pagehide` (a phone that discards a background tab, a crash) sends no `exit` and no
`path`: its views and steps are counted, its end is not.

### 11.2 Collector and dashboard

New `ix_*` counters in `summarize()` (the same per-batch budget of 200, no migration):

| metric | key | count |
|---|---|---|
| `ix_entry` | `''` and the route | views with no `from` (where page loads start) |
| `ix_nav` | from TAB to | route-to-route steps |
| `ix_nav_ms` | from TAB to | the sum of `fromMs` (the dashboard shows the average) |
| `ix_arrive` | `nav`, and route TAB `nav` | views by how they were reached |
| `ix_first` | route TAB element key | views whose first interaction was on that element |
| `ix_first_ms`, `ix_first_n` | the route | the sum of `firstMs` and the views that had a first interaction |
| `ix_exit` | `''` and the route | where page loads ended |
| `ix_path` | the first 5 routes joined with ` > ` (` > …` when longer), at most 240 characters | page loads that took that path |

Bounds, as for the other fields: `fromMs` and `firstMs` above 24 h are ignored, `nav` outside the list above is
`(other)`, routes are cut to 100 characters and element keys to 120.

The dashboard's Visitors view gets "How visitors move through this app": entries, exits and back/forward use with the
change on the previous period; Table 7, the most taken paths; Table 8, page-to-page steps with the average time
before the step; Table 9, per page: entries, exits and the exit rate (exits over views), back/forward arrivals, the
most frequent first interaction and the average time to it. The footer's clause becomes "page views, the path between
pages, time on page, scroll depth and clicks per element".

### 11.3 Disclosures

`packages/runtime/TELEMETRY.md` (the `interactions` row and the section), `PRIVACY.md`, the console notice
("Interaction analytics are on (this app turned them on): page views and the path between them, time on page, scroll
depth and clicks per element, never page text."), the JSDoc of `InitOptions.analytics`, `docs/runtime/API.md`,
`packages/runtime/CHANGELOG.md` and the dashboard footer say what is added. genclass.dev's privacy page lives in the
site repository and is updated there when the site takes a runtime with this.
