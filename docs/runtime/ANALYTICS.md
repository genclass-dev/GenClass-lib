# Interaction analytics: design

Status: design written 2026-10-17, **waiting for the owner's OK** on the fields, the default and the decisions in
[section 9](#9-decisions-for-the-owner). Nothing is built yet. Widening what telemetry sends needs that OK (AGENTS.md
rule 8).

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
| rage clicks | 3 or more clicks on the same element within 1 s, counted once per burst, per element |
| dead clicks | a click on a link or button (the `a`, `button`, `[role=button]`, `[role=link]`, `[role=tab]`, `[role=menuitem]` and button-type inputs) after which nothing changed within 1 s: no DOM mutation, no URL change, no page hide. Not counted: modified clicks (Ctrl, Cmd, Shift, middle button), links with `target` other than `_self` or with `download`. A click on a disabled button counts (the visitor tried and nothing happened) |

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
coordinates, the click order or timing (a sequence of clicks), the query string or fragment, the referrer, the
page title, the screen size, a visitor id. Nothing is written to cookies or `localStorage`, so two page loads by the
same person cannot be linked and the dashboard cannot count unique visitors.

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
(1 year on a paid plan), hourly rows 48 hours.

**Dashboard.** A "How visitors use this app" section on the app dashboard (`src/pages.ts`, Pro, the same range
picker), shown once the app has sent `interactions` events, using the page's existing table and card styles:

- page views, average engaged time per view, clicks, rage clicks, dead clicks, with the change against the previous
  period, and page views on the timeline;
- per page: views, average engaged time, share of views reaching 50 % and 100 %;
- most clicked elements (page, element key, clicks), and rage and dead clicks the same way, worst first;
- a line saying unique visitors are not counted (no visitor id is stored, by design).

The footer stays true and gets one clause: "…and, for apps that turn on interaction analytics, page views, time on
page, scroll depth and clicks per element (named by a selector or a name the app gave it, never its text). No text
from your pages, no IP addresses and no user agents are stored."

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

## 5. Consent and opt-outs

- Every telemetry opt-out also turns analytics off: `telemetry: false`, `?genclass=no-telemetry`, `?genclass=off`,
  `localStorage` `genclass.telemetry = off`, **Global Privacy Control**, local and private hosts (unless telemetry is
  set explicitly), `createRuntime()` and SSR without the option.
- No cookies, no storage writes, no persistent id: the session id stays random per page load.
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
`billing/plans.json` (Pro's "Interaction analytics (coming next)" becomes available once a runtime with it is on npm).

## 7. genclass.dev adopting it

The site pins runtime 0.2.2, so this needs a runtime release through `release.yml` (asked separately; never by hand).
Then:

1. Create an app for genclass.dev in the owner's account (its token goes in the page; its dashboard is the owner's).
2. Add the runtime to every page's head (today only `/` and `/docs` load it) with `model: false` outside the lab, so
   other pages do not download the model, and `analytics: true` with the token.
3. The lab sets `telemetry: false` today, and its footer says "Telemetry is off on this site". Analytics need
   telemetry on, so the lab's decisions (guard, eager profile, margins at 0) would be sent too. Either filter host
   `genclass.dev` out of model evaluation in the admin ingest, or keep the lab's own runtime instance off and track
   the lab page's interactions only. The footer sentence changes either way.
4. Update genclass.dev's privacy page (it describes GenClass's diagnostics for other apps, not tracking on
   genclass.dev itself), and decide on consent for EU, EEA and UK visitors (section 5): a consent banner, or start
   analytics only outside those regions (Cloudflare gives the country at the edge).
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
