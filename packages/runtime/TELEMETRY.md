# GenClass Runtime telemetry

Since **`0.1.0-beta.3`**, `GenClass.init()` in a browser sends **anonymous diagnostics** about GenClass's own
decisions to the GenClass maintainers (Daybot Solutions Inc.). We use them to measure and improve the GenClass
model (accuracy, false interventions, latency, which situations it sees in real apps). This page lists exactly what
is sent, where it goes, and how to turn it off.

**Turn it off:** `GenClass.init({ telemetry: false })`, `?genclass=no-telemetry` in the URL, or
`localStorage.setItem("genclass.telemetry", "off")`. Browsers that send Global Privacy Control are never collected.
Details under [Opting out](#opting-out).

## When it is on

| how GenClass starts | default |
|---|---|
| `GenClass.init()`, `import "@genclass/runtime/auto"` (and `/auto/*`), the CDN script tag, `npx @genclass/runtime init` setups | **on** in a browser on a public host |
| the same, on a local or private host (`localhost`, `*.localhost`, `*.local`, `*.test`, `*.internal`, `127.0.0.1`, `::1`, `10/8`, `172.16/12`, `192.168/16`, link-local, `file:`) | off unless `telemetry: true` / `{ ... }` (`0.2.1`: on, by mistake; fixed in `0.2.2`, see the CHANGELOG) |
| `GenClass.init()` outside a browser (Node, SSR, workers) | off unless `telemetry: true` / `{ ... }` |
| `createRuntime()` (headless, tests, the simulator) | off unless `telemetry: true` / `{ ... }` |

In `0.2.1` the local-host row did not apply to `GenClass.init()` (and so to `/auto` and the script tag): it passed
an explicit `telemetry: true` internally, so local and private hosts sent too. Fixed in `0.2.2`
([CHANGELOG](CHANGELOG.md)).

When it is on, the console shows one notice per page:

```
[GenClass] Sends anonymous diagnostics (decisions and counts, no page text) to improve the model. Opt out: GenClass.init({ telemetry: false }) or ?genclass=no-telemetry.
```

`runtime.telemetry` reports `{ enabled, reason?, endpoint?, sessionId?, token?, flush() }`; `reason` says why it is off
(`option`, `headless`, `local`, `url`, `localStorage`, `gpc`, `sampled-out`, `no-crypto`, `no-transport`,
`kill-switch`, `disabled`).

## What is sent

Only data the runtime already computes for its own decisions. **By default, no text from the page is sent:**
decision events carry the trigger kind, the diagnosis and its confidence, the chosen action, the gate, the outcome,
latency and counts, plus the app's hostname and the id-normalised route (no query or fragment; from 0.3.0 a path
segment holding an `@`, such as an e-mail address, is `:id` too).

- **The situation text the model read is sent only with `include: { situation: true }`** (default off since
  `0.2.1`). It is the text exactly as built for the model, after the redactor (`InitOptions.redact`, default:
  secret-named fields such as passwords, tokens, card numbers, API keys are replaced by `[redacted]`; see the
  README's [Privacy](README.md#privacy-and-telemetry) section for the rules and their known gaps). It describes
  operations (e.g. `GET /api/items/:id`), store fields and short value summaries, timing and the facts GenClass
  computed. **Before enabling it, know what it can contain:** request names with their query strings (parameter
  values are redacted only when the parameter name looks secret), route changes with query string and fragment,
  the page title, the first 100 characters of your app's error messages, the first 40 characters typed into
  ordinary inputs (a name or an email typed into a field called "Email"), fragments of WebSocket / SSE messages
  (up to 60 characters) and store leaf values up to 48 characters, including state the runtime discovered on its
  own (`autoState`: React, Redux or Zustand state the app never registered; those decisions carry
  `autoState: true`). Add a `redact` function for fields with ordinary names and personal values.
- **Interaction analytics** (new in `0.3.0-beta.1`; [design](../../docs/runtime/ANALYTICS.md)): **off unless the app
  turns them on** with `analytics: true`, and only with the app's token (or your own `telemetry.endpoint`). Then the
  page also sends `interactions` events: per page view, the route, engaged time, scroll depth milestones and clicks,
  rage clicks and dead clicks per element, the element named from markup (a `data-genclass-name`, a `data-testid`, an
  id, a link's target, stable class names or a short structural path), never its text. See
  [Interaction analytics](#interaction-analytics).
- **Measured visual checks** ([VISUAL.md](../../docs/runtime/VISUAL.md); new in `0.3.0`): nothing about
  them is sent. Their findings stay in the page (the console, `rt.checks()`, your own sinks). Counts per check kind
  are a proposal that needs the maintainers' approval of the exact fields first; this file will list them if that
  happens.
- **Never, in either setting:** typed values of password, payment (`cc-*`), one-time-code or secret-named inputs
  (the runtime never records them in the first place), cookies, request or response headers, request or response
  bodies, storage contents, the sentences GenClass prints about what it changed, the measured visual checks'
  selectors, element text, colours, URLs and messages, IP addresses or user agents (the collector does not store
  them).

### Batch envelope (schema `genclass-telemetry/1`)

`POST <endpoint>` with `content-type: text/plain;charset=UTF-8` (JSON body), no credentials, no referrer:

```jsonc
{
  "schema": "genclass-telemetry/1",
  "token": "gc_…",           // only when the app configured a valid token (InitOptions.token); see "App tokens"
  "sid": "3f9c…",            // 24 hex chars from crypto.getRandomValues, new on every page load, never stored
  "sent": 12034,             // ms since this page's GenClass started (no wall-clock time is sent)
  "runtime": "0.3.0-beta.0", // @genclass/runtime version
  "model": "2.0.0-rc4t",     // model card version, or null without a model
  "events": [ /* ≤ 100 events, ≤ 60 KB per request */ ]
}
```

Every event has `t` (type), `seq` (0, 1, 2, … per page) and `at` (ms since start). Event types:

| `t` | when | fields |
|---|---|---|
| `session` | once, at init | `runtime`, `host` (the page's hostname, which identifies the app using GenClass), `route` (the page path with id-like segments replaced by `:id`, and from 0.3.0 any segment holding an `@` or `%40`, such as an e-mail address; no query or fragment), `mode`, `effectiveMode`, `aggressiveness`, `sampled`, `model` (`local` / `custom` / `off`), `modelState`, `modelVersion`, `triage`, `shadow`, `holdWrites`, `device` (`webgpu` available, `cores`, `memoryGB` (the browser's coarse deviceMemory), `crossOriginIsolated`, `effectiveType`, `saveData`), `sample`, `situation` (whether situation text is included). Not the page's `decisionSample` or `maxDecisions` setting: `summary.telemetry` says how many records were sent and withheld ([Volume](#volume)) |
| `model` | model state changes, and once right after `session` when the model was skipped or failed before telemetry started (the device floor: `state` `skipped`, `reason` `device-memory` / `save-data` / `loadIf`; with `model.inlineFallback: false` and no worker, `reason` `worker-unavailable`) | `state`, `version`, `model`, `variant`, `device` (webgpu/wasm), `threads`, `worker`, `workerError` (why the model worker was not used, URLs replaced by `<url>`), `gpu` (WebGPU probe summary), `ort`, `loadMs`, `warmupMs`, `fromCache`, `bytes`, `phase`, `reason`, `error` (GenClass model-host error text, ≤ 200 chars, URLs replaced by `<url>`), `attempts` (variant, device and error per load attempt, URLs replaced by `<url>`) |
| `status` | mode, aggressiveness or breaker changes | `mode`, `effectiveMode`, `aggressiveness`, `breaker` |
| `decision` | a model decision: every one whose top diagnosis is not `expected` (detections and near-misses), that acted or was vetoed, always; a `decisionSample` share (default 1 in 4) of the routine ones (top diagnosis `expected`, nothing acted), at most `maxDecisions` (default 200) routine ones per page load ([Volume](#volume)); all are counted in `summary` | `id`, `trigger`, `route` (the page path, normalised; for a decision deferred until the model loaded or the tab was visible again, 0.3.0, the path at its trigger), `model`, `latencyMs`, `held` (the subject waited for the answer; false = decided in the background), `situation` (text, see above), `autoState` (true when discovered state was recorded on the page), `budget`, `compact`, `questions` (question ids), `answers` (per question: calibrated `probabilities` per label, `choice`, `confidence`; or `p` / `score`), `diagnosis`, `diagnosisConfidence`, `action` (chosen), `confidence`, `tier`, `candidate`, `ran`, `executed`, `acted`, `reason` (why the passive action ran), `mass`, `gateKind`, `threshold` / `gain` / `margin`, `thresholdSource`, `gates` (report/guard/heal thresholds, aggressiveness, level and sources), `effectiveMode`, `shadow`, `fn` (only on batches with a token: the name the app gave the `protect()`ed function the decision's subject ran inside, the outermost one; omitted otherwise) |
| `detect` | a decision reported as a detection: every one, never sampled or capped, with its `decision` record; since 0.3.0 also observe's "possible" ones (`InitOptions.detect`: below the report gate, at or above the eager profile's report value) | `decision`, `trigger`, `diagnosis`, `p`, `tier` (0.3.0: `"possible"` on a possible detection; absent on a likely one, as from earlier runtimes. It cannot be derived from the decision record: a possible detection is one whose `p` is below `gates.report` and at least the eager profile's report value (`gates().possible`, 0.70 with model 0.2.0), which the record does not carry, so `tier` says which side of that threshold a near-miss fell on. A decision deferred until the model loaded or the tab was visible again is `"possible"` whatever its `p`, until the false-report rate of those late decisions is measured. Nothing about the page) |
| `action` | an action ran, failed or was undone | `id`, `decision`, `action`, `tier`, `trigger`, `outcome` (`applied` / `failed` / `undone`), `late` (a late revert), `reversible`, `droppedFields` (count) |
| `veto` | `onBeforeAction` vetoed an action (every one) | `decision`, `action`, `enforced` |
| `breaker` | the breaker tripped or reset | `tripped`, `reason`, `undos`, `errors`, `decisions` (ids) |
| `model-error` | model errors (first 20 per page; all are counted) | `code`, `message` (≤ 200 chars, URLs replaced by `<url>`: a model host's message can quote the browser's worker error, which names the script and the page origin) |
| `summary` | about once a minute (≥ 60 s apart) while decisions continue, never capped; when the tab is hidden, on pagehide and on destroy | `reason`, `counts` (decisions, acted, detections (likely ones), `possibleDetections` (0.3.0: the possible ones, counted apart), actions applied/failed, late reverts, undos, vetoes, breaker trips, per trigger / diagnosis / action ran, detections per diagnosis, action limits hit, model errors per code, fail-opens per reason and trigger), `runtime` (model p50/p95 latency, decisions, dropped, hidden-tab skips, held time, denied and shadow counts, error count), `telemetry` (queued, dropped, send failures, events sent, `decisionRecords` (decisions whose records were sent), `decisionsSampledOut`, `decisionsCapped`) |
| `interactions` | only with `analytics: true` and a token (or a custom endpoint): when a page view ends (a route change, page exit), when the tab is hidden, and before a `summary`, if anything changed ([Interaction analytics](#interaction-analytics)) | `view` (page view number in this page load), `route` (normalised as on `session`), `start` (the view's first event: a page view), `engagedMs`, `scroll` (milestones 25 / 50 / 75 / 100 first reached since the previous event), `clicks`, `rage`, `dead` (counts per element key, at most 50 / 20 / 20 keys, the rest under `(other)`), `end` (the view ended). Counts are deltas since the view's previous event |

Not sent: `expectation` reports (a learned step that did not happen, `docs/runtime/EXPECTATIONS.md`) and anything
else learned about the page (flows, profiles, relations); those stay in the browser (`localStorage`, `rt.learned()`).

Numbers are rounded to 4 decimals. The source of truth is `packages/runtime/src/telemetry/client.ts`.

### Volume

The built-in model takes up to 30 decisions a minute (`model.maxDecisionsPerMinute`), and in `0.2.2` and earlier
every one of them was sent as a `decision` record with its answers, gates and shadow fields, so a busy tab left open kept
uploading for as long as it stayed open. Two defaults bound the routine part of that. Neither changes a count, and
neither ever drops a detection:

- **Detections are never sampled or capped.** Every `detect` event is sent with the `decision` record it points to,
  and so is every decision whose top diagnosis is not `expected` (a near-miss below the report gate included), every
  decision that ran an action or would have in shadow mode, and every veto.
- **`decisionSample` (default `0.25`):** of the routine decisions (top diagnosis `expected`, passive action, no veto),
  one in four is sent. The draw is a hash of the session id and the decision id (mixed, so every page sends close to
  that share), not a random number at decision time.
- **`maxDecisions` (default `200`):** after 200 routine decisions' records in a page load, no more routine records are
  sent. Detections and the other events (`summary`, about once a minute while decisions continue, so the exact counts
  keep arriving; `action`, `veto`, `model`, `status`, `breaker`, `model-error`) continue. Summaries are not capped:
  their cost grows with how long a busy tab stays open, not with how many decisions it takes (see the table).

`summary.counts` count every decision, detection, action and veto whatever was sampled, and `summary.telemetry`
says how many decisions' records were sent (`decisionRecords`), and how many routine ones were sampled out
(`decisionsSampledOut`) and capped (`decisionsCapped`), so a collector can scale what it received.
`telemetry: { decisionSample: 1, maxDecisions: Infinity }` sends every record (your own collector, debugging).

How much that is, measured in CI ([RESULTS.md](https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/RESULTS.md#10-release-030-beta0-first-load-and-telemetry-volume-ci) §10)
by `test/telemetry.test.ts` "an hour at the built-in model's maximum rate": one page, 30 decisions a minute for a
simulated hour (1,800 decisions from a scripted decider, not the model; situation text off), all bytes of all
request bodies counted:

| decisions | defaults (`0.3.0-beta.0`: CI run 38471973596 with the detection tiers, and the release candidate's runs 38485063587, 38485289326 and 38488753971) | `decisionSample: 1, maxDecisions: Infinity` (every record, as in `0.2.2` and earlier) |
|---|---|---|
| all routine | 250.9 to 252.2 KB in 157 to 167 requests (which routine decisions are sampled, and so how many requests, follows the random session id) | not measured |
| every one a detection | 2,068.5 KB in 361 requests: every record (detections are never sampled or capped) | 2,068.5 KB in 361 requests |
| of which `summary` events | 61 summaries, 40.7 KB (routine) and 42.2 KB (detections) | 61 summaries, 42.2 KB |

The summaries are 1.4 KB an hour larger than in CI run 38465242176 (39.3 / 40.8 KB): each carries the new
`possibleDetections` count. The scripted detections in this test are likely ones, which carry no `tier`.

A page where every decision is a detection sends every record, as `0.2.2` did: the detections are what the
diagnostics are for. A page whose decisions are routine costs about 40 KB an hour in summaries after the cap, plus
the batch envelopes, for as long as it stays open and keeps deciding; the test fails if that case reaches 300 KB. A
real page takes far fewer decisions than this (only salient situations go to the model), so these are ceilings, not
typical volumes.

### Transport

- Batches every 10 s (`flushMs`) of activity, and on `pagehide` / when the tab becomes hidden via
  `navigator.sendBeacon` (falling back to `fetch` with `keepalive`).
- The `fetch` and `sendBeacon` captured when `@genclass/runtime` loaded, so GenClass never observes, holds or decides
  about its own requests.
- At most 1,000 queued events; beyond that the oldest routine decision record (top diagnosis `expected`, nothing
  acted) makes room for a new event (since 0.3.0), else the new event is dropped; both are counted
  (`summary.telemetry.dropped`). A detection and its decision record are never dropped while a routine record is
  queued. A failed request (a network error, a 5xx) is dropped, never retried; after 3 failures in a row the page
  stops sending (`MAX_FAIL_STREAK`). Since 0.3.0 an HTTP 429, or a 503 with a `Retry-After` the page can read, is a
  back-off, not a failure: the refused batch goes back to the front of the queue and nothing is sent for 30 s,
  doubling per back-off in a row, or the `Retry-After` (in seconds) when it is longer, never more than 5 minutes
  (page exit still sends, by `sendBeacon`). After 8 back-offs in a row (about 27 minutes) a refusal counts as a
  failure. A `Retry-After` on any other status is ignored. Before 0.3.0 a busy network address (an office or campus
  behind one IP, against the collector's per-address limit) could stop its pages for good after three 429s.
  Telemetry never throws into your app, never changes what the model sees, and never delays a decision.

### Interaction analytics

New in `0.3.0-beta.1`. **Off by default.** An app turns them on for its own dashboard:

```ts
GenClass.init({ token: "gc_…", analytics: true });
```

(also `data-analytics="on"` on the script tag, `<meta name="genclass" content="analytics=on">`,
`window.GENCLASS_CONFIG.analytics`). They need telemetry on and the app's token, or a custom `telemetry.endpoint`;
without either, `analytics: true` warns once in the console and records nothing. Every telemetry opt-out below, Global
Privacy Control and the local-host default turn them off too. When they start, the console says so once:

```
[GenClass] Interaction analytics are on (this app turned them on): page views, time on page, scroll depth and clicks per element, never page text.
```

What is recorded, per page view (a page load, and each route change to a new path):

- **page views** and the **route** (the path as on `session`: id-like segments and segments with an `@` as `:id`, no
  query, no fragment);
- **engaged time:** while the tab is visible, at most 30 s after the visitor's last input (pointer, key, wheel, scroll,
  touch);
- **scroll depth:** which of 25 / 50 / 75 / 100 % of the page height the bottom of the viewport reached (a page that
  fits the screen reaches 100 % at once);
- **clicks** per element; **rage clicks** (3 or more on one element within 1 s, once per burst, not while text is
  being selected); **dead clicks** (a click on a link or button after which nothing in the page changed within 1 s: no
  DOM change, no URL change; not counted for modified clicks, links that open another tab or download);
- the **element key:** `[data-genclass-name="…"]` (a name you put on the element; the way to get readable keys),
  `[data-testid="…"]`, `tag#id` (ids that look generated or like data are skipped), a link's target (`a[href="/route"]`
  on your site, the other site's origin only), the tag with up to two stable class names, or an `nth-of-type` path of
  up to 4 levels under a named ancestor or a landmark. At most 120 characters. Any attribute value that looks like data
  (an e-mail address, a URL, 4 or more digits, 12 or more hex digits) is not used.

**Never recorded:** element text, labels, `alt`, `title`, placeholders, input values or what was typed, mouse
coordinates, the order or timing of clicks, the query string or fragment, the referrer, the page title, the screen
size, a visitor id. Nothing is written to cookies or `localStorage`, so page loads by the same person cannot be linked
and the dashboard does not count unique visitors. Synthetic events (`isTrusted` false) and events inside
`[data-genclass-ignore]` are not counted.

They never reach the model or a decision: they are recorded by their own listeners (a separate file the runtime loads
only when analytics are on), outside GenClass's event log, and change nothing on the page in any mode. The
maintainers use `interactions` events only for the app's dashboard and its export, never for model training or
evaluation.

**After consent:** `runtime.analytics.start()` turns them on later (for example once a visitor accepts analytics in
your consent banner), `runtime.analytics.stop()` turns them off and drops the counts not sent yet.
`runtime.analytics` reports `{ enabled, reason? }` (`option`, `telemetry-off`, `no-token`, `stopped`, `error`).

## App tokens and dashboards

New in `0.3.0` (`0.2.x` ignores a token and sends neither `token` nor `fn`). An app can set a **token**
(`InitOptions.token`, `data-token`, `<meta name="genclass" content="token=...">` or `window.GENCLASS_CONFIG.token`):
`gc_` followed by 22 letters or digits, created by `npx @genclass/runtime init` or at https://genclass.dev/start.

- The token is public (it is in the page). It is sent as the batch envelope's top-level `token` and nowhere else; it
  lets the collector group the batches of one app. A malformed token logs one console warning and is not sent.
- Whoever holds the app's private dashboard link (`https://genclass.dev/dashboard/<secret>`, given once when the
  token is created) can see aggregated diagnostics for that token (decisions, detections by diagnosis, possible
  detections (the `detect` events with `tier: "possible"`, shown apart), actions, the app's hostnames, top routes and
  protected functions, model load, backend and latency, versions) and its recent detections. Dashboard data is also deleted after 90 days.
- A token changes nothing about when data is collected: with telemetry off (any opt-out, or Global Privacy
  Control, or a local host) nothing is sent and the dashboard gets nothing from that page. On a local host the
  console says so once when a token is set; otherwise only with `debug: true`.
- Only batches that carry a token have `fn` on `decision` events: the name the app chose for the `protect()`ed
  function the decision was about (at most 80 characters). A name that looks like it carries data rather than
  naming a function (an e-mail address, a URL, 4 or more digits in a row, 12 or more hex digits) is sent as
  `[redacted]`, so use fixed names. Without a token `fn` is never sent.
- With a token, the console notice ends with one more sentence: `With this app's token they also feed its private
  GenClass dashboard.`
- `npx @genclass/runtime init` creates a token (a "project") only on a new setup and only after the developer
  approved its changes (or passed `--yes`): it sends one request, `POST https://genclass.dev/api/projects` with
  `{ "name": <package.json name, at most 80 characters> }`. The collector keeps one record per project: the token,
  that name, the creation time, the times of the first and the last batch, a SHA-256 hash of the dashboard secret
  (never the secret itself) and, when the app belongs to a genclass.dev account, that account. Project records have
  no automatic expiry; the aggregated dashboard data does (90 days). To delete a project and its dashboard data,
  write to the contact in PRIVACY.md with the token.
- An app can also belong to an optional **genclass.dev account** (passkey, Google or GitHub sign-in), which opens its
  dashboard at `https://genclass.dev/account/apps/<id>` for the signed-in owner; an existing dashboard link can be
  added to an account and keeps working until the owner turns that link off on the account page. This changes
  nothing the runtime sends: pages send the same batches with the same token, and nothing in a batch identifies a
  person or an account. What an account itself stores (an email as typed or as Google returned it and whether it is
  verified, passkey public keys, the Google `sub` and the GitHub id and login if used, session records, the apps it
  owns) is listed in PRIVACY.md. Deleting the account on its account page deletes the apps created in it with their
  dashboard data.
- The CLI's account commands send nothing until they are run. `login` sends `POST https://genclass.dev/api/device/code`
  with `{ "client_name": "genclass-runtime <version>" }` (the approval page shows that name and the account page lists
  the CLI session under it), then polls `POST /api/device/token` with the code until the sign-in is approved, denied
  or expires. `whoami` and `connect` read the account's apps (`GET /api/me`); `connect` creates an app with
  `POST /api/account/projects` and its name (after the developer approved the changes), or adds an existing
  dashboard with `POST /api/account/projects/claim` and its link from `.genclass.local`; `logout` sends
  `DELETE /api/account/sessions/current`. Signed in, `init` asks whether a new app goes into the account and then
  creates it with `POST /api/account/projects` instead of `/api/projects`. These account requests carry
  `user-agent: genclass-runtime-cli/<version>`.

## Where it goes

- **Endpoint:** `https://genclass.dev/api/v1/events` (`DEFAULT_TELEMETRY_ENDPOINT`; before 0.2.2 the same worker's
  `https://genclass-telemetry.mehar-144.workers.dev/v1/events`, which still works), a Cloudflare Worker operated by the
  GenClass maintainers (source: `telemetry-worker/` in the repository). With a Content-Security-Policy, allow
  `https://genclass.dev` in `connect-src` or turn telemetry off; after 3 failed requests in a row a page stops sending
  (a 429 is a back-off, not a failure, since 0.3.0).
- **Storage:** a private Cloudflare R2 bucket (`genclass-telemetry`), gzip JSON Lines, one object per batch,
  partitioned by UTC date, runtime version and model version. The collector adds only the time it received the
  batch and the visitor's coarse **country** (two letters, from Cloudflare). It does not store IP addresses, user
  agents, cookies or any request header, and it drops unknown fields.
- **Use:** model evaluation and training by the GenClass maintainers (never `interactions` events: those are only for
  the app's dashboard and export), and, for batches that carry a token, that app's dashboard. For an app in a genclass.dev account (any plan, Free included), also what that account's owner
  turns on: an export of the app's stored batches, and forwarding of each likely detection (problem type, confidence,
  trigger, page route, versions, time; never page text) to the services the owner chose. Not sold, not used for
  advertising.
- **Retention:** 90 days. An R2 lifecycle rule (`expire-90d`, prefix `events/`) deletes every stored batch 90 days after it
  was written. For an app on a plan with a year of history (Enterprise, given by GenClass's own grant), a copy of each
  batch is kept for its export under `export/<token>/` for up to 1 year (another lifecycle rule, 366 days), and its
  dashboard data for 1 year; both are deleted when the grant ends (30 days after the paid period ends, for a paid
  plan), and at once when the app or its account is deleted. The maintainers may change this later; changes are
  recorded in the CHANGELOG.
- **Your own endpoint (private mode):** `telemetry: { endpoint: "https://…" }` sends the same batches to a
  collector you run instead, so nothing reaches GenClass: the worker in `telemetry-worker/` deploys to any Cloudflare
  account with `wrangler.selfhost.toml`, dashboards and accounts included (telemetry-worker/README.md, "Self-host the
  collector (private mode)").

## Options

```ts
GenClass.init({
  telemetry: {
    endpoint: "https://…",          // default DEFAULT_TELEMETRY_ENDPOINT
    sample: 0.25,                    // fraction of page loads that send (default 1)
    decisionSample: 1,               // share of routine decisions whose record is sent (default 0.25; counts stay exact)
    maxDecisions: 1_000,             // most routine decisions' records per page load (default 200; Infinity: no cap; detections never capped)
    flushMs: 10_000,                 // batch interval
    maxBatch: 100,                   // events per request
    include: { situation: true },    // also send the redacted situation text (default: off)
  },
  analytics: true,                   // interaction analytics for the app's dashboard (default: off; needs the token)
});
```

`telemetry: true` is the defaults; `telemetry: false` turns it off.

## Opting out

Any one of these turns telemetry off for the page:

| how | who |
|---|---|
| `GenClass.init({ telemetry: false })` (or `window.GENCLASS_CONFIG = { telemetry: false }`, `<meta name="genclass" content="telemetry=off">`, `data-telemetry="off"` on the script tag) | the app developer |
| `?genclass=no-telemetry` in the page URL (`?genclass=off` turns GenClass off entirely) | anyone, for one page load |
| `localStorage.setItem("genclass.telemetry", "off")` | a user or tester, persistent per origin |
| **Global Privacy Control**: `navigator.globalPrivacyControl === true` | the user's browser setting |

**Global Privacy Control (GPC).** California law (CCPA as amended by the CPRA, and its regulations) requires
businesses to treat a GPC signal as a valid request to opt out of the sale or sharing of personal information, and
other US state laws (e.g. Colorado, Connecticut) recognise universal opt-out signals. GenClass honours GPC for every
visitor, wherever they are: when the browser sends it, nothing is collected.

## If you ship GenClass in your app

The data is collected from **your** users' browsers. Even though it is designed to be anonymous (random per-page
session id, no IP or user agent stored, redacted text), situation text can contain fragments of your app's data and
the session event names your hostname. Depending on your users and jurisdiction you may need to:

- mention GenClass diagnostics in your privacy policy / cookie or tracking disclosures (GDPR transparency,
  Articles 13 and 14; CCPA notice at collection);
- decide whether it needs consent where you require consent for analytics (GDPR / ePrivacy), and if so start
  GenClass with `telemetry: false` until consent is given (`GenClass.init()` reads the option once; to switch it on
  later, create the runtime after consent);
- if you turn on interaction analytics (`analytics: true`): in the EU, the EEA and the UK, Article 5(3) of the
  ePrivacy Directive (regulation 6 of PECR in the UK) requires consent to read information from a visitor's device
  unless it is strictly necessary for the service they asked for, and regulators read it as covering scripts that send
  interaction data, not only cookies (EDPB Guidelines 2/2023). Analytics are not strictly necessary, so start with them
  off there and call `runtime.analytics.start()` after consent; some regulators exempt first-party audience
  measurement under strict conditions (the CNIL in France), which is your call. Name GenClass as a recipient in your
  privacy policy either way;
- turn it off (`telemetry: false`) in apps that handle regulated data (health, finance, children's services): a
  custom `redact` lowers what reaches situation text but does not guarantee that nothing sensitive does;
- if you add a webhook sink (`@genclass/runtime/sinks/webhook`, `init --sink webhook:<url>`, 0.3.0) that posts to an
  endpoint run by someone else, disclose that recipient too: the webhook sends the redacted evidence by default (the
  console line, subject and timeline, which can hold short fragments of what users typed) to the URL you configure
  (`evidence: false` sends the structured fields only). The free runtime forwards nothing to Sentry, PostHog or
  Datadog. Sinks are your configuration, not
  telemetry: the telemetry opt-outs (`telemetry: false`, `?genclass=no-telemetry`, the `localStorage` switch) and
  Global Privacy Control do not turn them off; `?genclass=off` turns GenClass off altogether.

Privacy policy for this collection: [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md). Data processing terms are not published yet
(planned); if you cannot disclose a third-party diagnostics recipient, set `telemetry: false`.
