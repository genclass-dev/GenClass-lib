# Changelog

## Unreleased

- **`rt.summary().requests`: the requests GenClass saw, per host** (issue 94; [API.md](../../docs/runtime/API.md)
  "Requests in `rt.summary()`"). Counts of the `fetch` and XHR requests of the page load, in total and per host
  (`"same-origin"` or the API's host, 30 at most): `requests`, answers by status class, `network` (no answer),
  `aborted`, `notJson` (a fetch answer read with `response.json()` while the Content-Type is not JSON; the body is never
  parsed for it), `byGenClass`, `pending`, and the latency `p50` / `p95` of the answers that did not fail, from the
  learned baselines. `requests: 0` now tells "GenClass did not see the requests" apart from "it saw them and nothing
  was salient" (a 404 or a non-JSON answer the app's own `catch` handles is counted, not detected). Counted in the
  measured checks' chunk, so it is present wherever the checks run (development hosts by default, `visual: true`
  elsewhere); first load +34 B gzip (the not-JSON flag), within the existing limits. Local only: telemetry does not
  send it (a proposal for that and a dashboard alert waits for the owner,
  [OPTIONS-SPEC.md](../../docs/runtime/OPTIONS-SPEC.md) §4.21); a sink's `summary` record carries the totals only.
- **Measured check `request-stalled`** ([VISUAL.md](../../docs/runtime/VISUAL.md) 3.24). A `fetch` or XHR request
  still pending after `visual: { checks: { stallMs } }` (default 15 s) is reported once as a kind `"check"` finding
  with its method, host and path, how long it waited, and the control the page disabled or marked `aria-busy` when it
  started if that control still is (severity high then). Long polls the runtime learned, endpoints that usually take
  that long, EventSource and WebSocket are not checked. Same rules as the other visual checks: on by default on
  development hosts, `visual: true` elsewhere, report-only, never a situation or model input, nothing sent. It lives
  in the lazily loaded checks chunk: no first-load bytes. Demos: 0 false reports in 120 clean and chaos runs, 11 of 18
  planted 60 s hangs found (polls on a learned schedule are skipped by design; RESULTS.md §21).
- **`init` writes `defer` on the plain-HTML script tag**, so a slow or blocked CDN no longer holds up rendering.
  GenClass then starts after classic scripts without `defer` or `async` (their requests during page load are not
  seen), still before deferred and module scripts; model loading is unchanged (idle after `load`). `--sync` writes the
  blocking tag of earlier versions; existing setups are not changed. `remove` already took out the tag with attributes
  added by hand (`defer`, `async`, `nonce`); that is now tested and said in `remove`'s help.
- **`init` notes when a project looks mostly static** (no `fetch`, XHR, WebSocket or EventSource call in its sources,
  or a plain HTML page with one script): one sentence that GenClass will have little to find there, pointing to the
  visual checks and the page scan, `npx @genclass/runtime@beta scan <url>`.

- **Two measured visual checks: `ad-heavy` and `text-warped`** ([docs/runtime/VISUAL.md](../../docs/runtime/VISUAL.md)
  sections 3.25 and 3.26). `ad-heavy` reports a page whose ad slots (elements whose id or class names an ad slot, the
  AdSense, Ad Manager and Prebid attributes, cross-site frames at a fixed ad size) cover 30% of the page, half the first
  screen, a fixed ad 30% of the screen (the Coalition for Better Ads thresholds), or a full-screen ad on top of the page
  (an interstitial, high). `text-warped` reports text a reader cannot read as text, from line boxes, rects, transforms
  and code points: two lines overlapping by half a line, a line cut mid-way by its overflow box, lone surrogates and
  unassigned code points (half an emoji), mirrored text, text skewed over 20° or stretched 2x, letter spacing of
  0.5 em or more (or -0.2 em and less), and text drawn below 8 px that is still meant to be read. Both are kind
  `"check"`, report only (no runtime fix), run in the lazy chunk's idle slices on the full tier, and never feed the
  model; `CheckKind` gains both. First load unchanged (0 B of first-load code; the lazy visual chunk grows by about
  6.7 KB gzip).
- **Interaction analytics: navigation paths** ([docs/runtime/ANALYTICS.md](../../docs/runtime/ANALYTICS.md) section
  11, TELEMETRY.md "Interaction analytics"). With `analytics: true` (still off by default, still only with the app's
  token), `interactions` events also say how each page view was reached (`nav`: load, reload, back_forward, push, back,
  forward, pop), the previous view's route in the same page load and the ms between (`from`, `fromMs`), the element key
  of the view's first click or keyboard focus on a form field (`first`, `firstMs`), and at pagehide that the page load
  ended there with its routes in order (`exit`, `path`, at most 10). Never text, the referrer or anything that links
  two page loads. The console notice now says "page views and the path between them". The dashboard's Visitors view
  shows the most taken paths, page-to-page steps, entries, exits and back/forward use, and the first interaction per
  page.
- **`scan <url>` (alias `audit`): audit any page in one command.** `npx @genclass/runtime@beta scan https://example.com`
  loads the page in headless Chromium through Playwright (resolved from the project, this package or the global
  node_modules, never a dependency) at desktop (1280x800) and phone (390x844) sizes, with the script-tag build
  injected first in observe mode (telemetry off, no model, visual checks on; the runtime's files come from disk on a
  virtual same-origin path, so the only requests are the page's own), runs a check pass, presses Tab four times and
  scrolls to the end like the hosted page check, and prints a score (the hosted check's "Visual bugs" formula) and
  each finding with its count, sizes, element, selector and suggested CSS, worst first. `--json` prints the same
  report (`format: "genclass-scan/1"`) as JSON on stdout only; `--phone` checks the phone size only; `--timeout <s>`.
  Without Playwright's Chromium it prints the line to install it and checks the page on the genclass.dev page check
  instead, saying so (`--hosted` asks for that directly, `--local` never uses it; a loopback or private address is
  never sent). Exit code 0 when nothing is found, 1 when something is, 2 on an error. No runtime code, no telemetry
  and no model-visible text changed. `@genclass/mcp`'s `genclass_scan` tool runs it.
- **`dashboard` prints the link to this app's free dashboard.** `npx @genclass/runtime dashboard` prints the link
  to the dashboard of the app in the current folder: the private link in `.genclass.local` (nothing is contacted),
  else the app's page in the signed-in account (one `GET /api/me`), else the account's apps; `--open` also opens it in
  the browser. `init`'s dashboard notice says what the dashboard shows and how to print the link again, and `whoami`
  and `login` point to the dashboards too. No runtime code, no telemetry and no model-visible text changed.
- **Coding-agent link: snapshots and witnesses that do not depend on arrival order** (`@genclass/runtime/agent`;
  [docs/runtime/AGENT.md](../../docs/runtime/AGENT.md) section 2). `snapshot()` takes up to 1,000 store fields (was 300)
  within 96,000 characters, in an order that does not depend on when they were written (registered stores, then
  discovered component state, then other discovered stores; shallower paths first), and says how many it left out
  (`stateLeft`, `stateTotal`). The final snapshot at page hide is not sent again when the bridge already has it or when it
  would not fit a keepalive request. Snapshots list the lines of ARIA live regions (`live`: status messages, alerts,
  toasts) beside the page text. An `overwrote-newer` witness is no longer recorded for a write that only reordered a
  field's elements or entries (a cache's list of keys re-sorted by arrival), nor for a path the hub's layout re-cut in
  the same write (an object or store that crossed its field limits, so its fields became one or the reverse). Development-only entry: the first load,
  situations, the model and telemetry are unchanged (`situation-v2.3`).

## 0.3.0-beta.1 (2026-10-22)

The second 0.3.0 prerelease, on the `beta` dist-tag (`latest` stays 0.2.2). It adds the coding-agent link
(`@genclass/runtime/agent`, used by `@genclass/mcp` 0.1.0) and carries everything below since 0.3.0-beta.0. No
model-visible text changed (`situation-v2.3`); the default model is still `@genclass/runtime-model@0.2.0`.


- **Coding agents: record, replay and explore (`@genclass/runtime/agent`, new; [docs/runtime/AGENT.md](../../docs/runtime/AGENT.md)).**
  `connectAgent(rt)` in an app's development build connects the page to `@genclass/mcp`, a local MCP server for
  Claude Code and other coding agents. It records the run (user actions; requests by key, `GET /api/search#3`; the
  order their responses were delivered; state writes; errors with their stack and causal chain; two happens-before
  facts as witnesses: a response that overwrote newer data, identical requests in flight from two separate clicks) and
  snapshots the app's state at quiet points. With a schedule (`fifo`, `seeded`, `given`, set by the agent, a test's
  `__GENCLASS_SCHEDULE__` or `?genclass-schedule=`) it delivers responses in that order, optionally slower: the same
  responses, unchanged, each held at most `maxHoldMs` (1.5 s), so a race shows up on a fast machine and replays
  exactly. Without a schedule it holds only a page load's first responses until the bridge's hello (at most 0.6 s);
  `hold: false` turns every hold off; protected requests are never held (unless `holdProtected`). Only on pages served from the developer's
  machine by default; it talks only to a loopback address; it is its own entry (`dist/agent.js`, no imports), so the
  first load stays within its limits (108.54 / 100.40 KB).
  It wraps the runtime's delivery gate and request ignore list while connected and restores both on `disconnect()`;
  nothing it records reaches a situation, a decision, the event log or the model (no model-visible text changed,
  `situation-v2.3`), and telemetry is unchanged. INTERCEPTION.md, THREAT-MODEL.md (T10), API.md, CONTRACT.md §16,
  RESULTS.md section 16.
- **Fix: a reused XHR object could get the next request's response early.** When the app aborted an XHR whose
  completion listeners the runtime held for a delivery decision (guard or heal) and sent a new request on the same
  object, releasing the old, held delivery ran the listeners queued for the new request before its own decision. The
  release now checks that it still belongs to the request it was made for (`src/observe/xhr.ts`). No model-visible
  text changed. Found by the coding-agent link's review.
- **The devtools overlay is in genclass.dev's black design.** `@genclass/runtime/devtools` (and `devtools: true`) now
  uses the site's black ground and raised panels, bone text, the mark's green for what GenClass changed and
  red-orange for the bugs it catches, amber for warnings, square corners and 1px rules without shadows, and the
  current GenClass mark (drawn inline, no image request). It is black by default whatever the page's or the OS's
  theme: `theme` defaulted to `"auto"` before and now defaults to `"dark"`; `"light"` gives the same design on white
  and `"auto"` still follows `prefers-color-scheme`. Type is the system UI font and a system mono stack: the overlay
  no longer names Inter or JetBrains Mono, so a page that declares either as a web font no longer downloads it for
  the overlay. The tab row scrolls sideways instead of hiding Expectations and Now past the panel's edge, and the
  header no longer clips the name. Every view, control and string is the same; no model-visible text changed.
- **Interaction analytics, off by default (`analytics: true`; [docs/runtime/ANALYTICS.md](../../docs/runtime/ANALYTICS.md)).**
  An app that sets `analytics: true` with its token also sends `interactions` telemetry events for its dashboard: per
  page view, the route, engaged time (the tab visible, at most 30 s after the last input), scroll depth milestones
  (25 / 50 / 75 / 100 %), and clicks, rage clicks (3 within 1 s on one element) and dead clicks (a link or button
  after which nothing changed within 1 s) per element key. Keys are built from markup only (`data-genclass-name`,
  `data-testid`, a stable id, a link's target, stable class names, a short structural path), never element text;
  nothing is stored on the device and no visitor id exists. Needs telemetry and the token (or a custom endpoint);
  every telemetry opt-out and Global Privacy Control turn it off; `runtime.analytics` reports it and its `start()` /
  `stop()` turn it on after consent and off again. The recording is a lazy chunk (`dist/analytics/index.js`, loaded
  only when an app turns analytics on) with its own passive listeners, outside the event log: no model-visible text
  changed (`situation-v2.3`), and nothing reaches a situation, a decision or the model. First-load cost of the stub:
  about 0.29 KB gzip on `/auto` and 0.27 KB on the main entry (TELEMETRY.md "Interaction analytics", README "Privacy
  and telemetry", API.md, INTERCEPTION.md).
- **CLI copy: the dashboard is free.** genclass.dev's dashboard is free for every app (every plan in
  `billing/plans.json` includes it, with analytics, export and forwarding; there is no trial): `init`'s dashboard
  notice and help, the top-level help and the README say so next to the private dashboard link. A link made by
  0.3.0-beta.0's `init` opens the dashboard. No runtime code and no model-visible text changed.
- **Docs: your own classifier is free; the Individual plan is gone.** genclass.dev has two plans, Free and Enterprise
  (`billing/plans.json`): Free now includes the classifier GenClass trains on your app's traffic, bug reports or
  labelled examples and ships as a private model your runtime loads, and nothing is sold on the site. The README's
  dashboard section and TELEMETRY.md's retention note say so. No runtime code and no model-visible text changed.
- **CLI copy: `login` lists email and password sign-in.** genclass.dev accounts also sign in with an email and a
  password now; `login`'s help, the line it prints with the link, and the README say "Google, email and password,
  GitHub or a passkey". The device flow is unchanged (the browser half signs in; the CLI only polls).
- **Fix: on WASM, the first salient request of a page load was not held on CPUs a little slower than the train
  VM's.** The model's warm-up timed a second, warm pass only on WebGPU (where the first compiles pipelines); on WASM
  `status.latency` came from the first, cold pass. The runtime's estimate before any measured decision (that pass's
  per-token cost × 1,200 tokens + 20 ms) then came to 4-7x a real decision (0.2.2, model 0.2.0, Chromium on the train
  VM): 711 ms against about 160 ms at the VM's speed, 2.0-2.5 s against about 340 ms at half of it. A request is held only when the estimate fits the hold budget (at most 800 ms automatically), so in guard
  and heal the first duplicate submit of every page load went through on a CPU about 15% slower than the VM's. The
  warm-up now times a second pass on every device: `status.latency` comes from it, `status.warmupMs` is still the
  first, cold pass. A load on WASM takes one more warm-up pass (a ~430-token situation, warm). No model-visible text
- **Release notes: the npm registry's empty `readme` field.** Since 0.3.0-beta.0 went to `beta`, the registry's
  top-level `readme` for the package (`npm view @genclass/runtime readme`) is empty: the registry empties it on every
  publish to a tag other than `latest` and fills it again on the next `latest` publish, as it does for react,
  typescript, next and vitest. The npm and jsDelivr package pages are not affected; they show each version's full
  README. `.github/workflows/release.yml` now says so. No package contents, runtime code or model-visible text
  changed.

## 0.3.0-beta.0 (unreleased)

The first 0.3.0 prerelease, for the `beta` dist-tag (release.yml publishes a prerelease version to the dist-tag
named after it; `latest` stays where it is until the owner moves it). No model-visible text changed: the situation
text is still `situation-v2.3` and the default model is still `@genclass/runtime-model@0.2.0`.

### What changes when you upgrade from 0.2.x

- **App tokens and dashboards:** a page with `token` set also feeds that app's private dashboard on genclass.dev
  (below); the token and `fn` are sent only then.
- **Telemetry sends more kinds of events and counts, with or without a token** (nothing new about the page itself;
  TELEMETRY.md): a `detect` event for each of observe's possible detections, with `tier: "possible"` (on by default
  in observe; 0.2.x sent no `detect` event below the report gate); `summary.counts.possibleDetections`;
  `summary.telemetry.decisionRecords`, `decisionsSampledOut` and `decisionsCapped`; a `model` event right after
  `session` when the model was skipped (the device floor) or failed before telemetry started; and `decision` and
  `detect` records for situations deferred while the model loaded or the tab was hidden, which 0.2.x dropped, with
  the page path at their trigger. It sends less elsewhere: routine decision records are sampled and capped (next
  bullet), a path segment holding an `@` (an e-mail address) is sent as `:id`, and URLs in model error text as
  `<url>`.
- **Detections are never sampled or capped in telemetry.** Only routine decisions (top diagnosis `expected`, nothing
  acted) are thinned, to one in four and at most 200 per page load (Telemetry, below).
- **No model on devices reporting 2 GB of memory or less, or on Save-Data connections** (`model.loadIf` default;
  `loadIf: () => true` restores loading everywhere). Such a page observes without a model, detects nothing and says
  why, in the console and in telemetry.
- **`init` creates a project** (a dashboard) after you approve its diff, unless you pass `--no-token`,
  `--token <gc_...>`, `--no-telemetry` or `--dry-run`.
- **Stored learned state from 0.2.2 is discarded once** (a new format, tagged with the runtime version). In a default
  install nothing is stored; transition profiles are stored only with `learn.persist`, as before.
- **`model.inlineFallback: false` now skips the model** when the worker cannot be created or does not come up
  (`status.state` `skipped`, reason `worker-unavailable`); 0.2.x ignored the option and ran the model inline on the
  main thread. The default (`true`) is unchanged.
- **Guard and heal no longer retry a `fetch(new Request(...))` whose body is over 64 KB** (`retry` is not offered
  for it): 0.2.x kept a second copy of every such upload in memory to make it replayable. String, form, Blob and
  BufferSource bodies passed in `init` are unchanged (Defaults, footprint and fixes, below).
- New and opt-in: vendor-neutral sink adapters that keep the records on your side (`@genclass/runtime/sinks/console-json`
  and `/webhook`, `init --sink`), flow expectations (`learn: { expectations: true }`), `protect()` and
  `scope: "functions"`, and genclass.dev accounts with the CLI's `login`, `connect`, `whoami` and `logout` (`init`
  asks whether a new app goes into a signed-in account).
- **No Sentry, PostHog or Datadog adapter.** The vendor adapters that were in development for this release are not
  part of the free runtime. On Pro, the GenClass collector forwards detections to Sentry, PostHog, Datadog, Slack
  or a signed webhook once you turn it on (https://genclass.dev/pricing); the runtime has no adapter. A page config that names `sentry`, `posthog` or `datadog` gets one
  console warning that says so, and nothing else happens; `init --sink sentry` stops with a usage error that says the
  same.
- **The webhook adapter, if you add one, caps repeats and sends evidence by default.** Unlike telemetry, it forwards
  at most 10 records per bug signature per page load (`maxPerSignature`, `0` for no cap), a sink's `sampleRate` below
  1 can drop detections, and it sends the redacted evidence (console line, subject, timeline, which can hold short
  fragments of typed input) to the URL you configure unless you pass `evidence: false`.
- **Measured visual checks, on development hosts by default** (Measured visual checks, below): `visual` defaults to
  `"local"` with `GenClass.init()`, `/auto` and the script tag, so on `localhost`-style hosts with a port, `*.test`
  names and wherever the devtools overlay mounts, the page gets `[GenClass] Check (measured): ...` console lines, and
  an app's `report` function and `rt.on("report")` listeners receive reports of the new kind `"check"`. Off
  everywhere else and in `createRuntime()`; `visual: false` turns them off. They send nothing in telemetry, reach a
  sink only when its `kinds` lists `"check"`, and change the page only with `visual: { on: true, fix: true }` in guard
  or heal mode.
- **Observe reports more** (below). What an app wired to `rt.on("detect")`, `rt.on("report")` or `report: fn`
  receives is unchanged by default: likely detections only, as in 0.2.x. New: "possible" detections on
  `console.debug`, in the devtools, `summary()` and telemetry (to your listeners and report function only with
  `detect: "possible"`, to a sink only with `possible: true`), and situations from while the model loads or the tab
  is hidden, decided once it can and reported at the possible tier at most. `detect: "likely"` turns off both.
  Three fixes can add likely reports, false ones included, at a rate not measured yet, and `detect: "likely"` does
  not turn them off: overwritten writes now decided in observe on slow devices, the body-wait fix and the idle-unload
  fix (below). Guard and heal act exactly as before, except with `model.unloadAfterIdleMs`: they act again after the
  model reloads, where 0.2.x stopped for good after the first unload.

### Observe-mode detection: a "possible" tier, and no blind windows

No model-visible text changed (`git diff` of `src/situation` is empty) and no rule maps a fact to a diagnosis: the
tiers are thresholds on the model's own output, the rest is when a situation is decided.

- **Two detection tiers** (`InitOptions.detect`, `Decision.detection`). *Likely*: the top diagnosis is not `expected`
  and its probability reaches the report gate (`gates().report`: the aggressiveness profile's value from the model
  meta, 0.90 at balanced with model 0.2.0), as before. *Possible* (new): at least the eager profile's report value from
  the same meta (`gates().possible`, 0.70) and below the report gate. On by default only where the effective mode is
  observe and the app set no `policy.thresholds.report`; `detect: "likely"` turns it off (also as a meta tag or
  `data-detect` key), `detect: "possible"` on in guard and heal too (reporting only: no action gate reads either
  tier). A likely detection prints exactly as before. A possible one prints the same line plus ` (possible)` with
  `console.debug` only (hidden at Chrome's default console level; repeats fold per tier), shows as a dimmed devtools
  card left out of the badge counts and without the pill's pulse, is counted in `summary().possibleDetections`
  (`detections` keeps the likely ones), and is on `rt.on("decide")` with `detection: "possible"`. It reaches
  `rt.on("detect")`, `rt.on("report")` and a `report` function only when `detect: "possible"` is set explicitly, and
  sinks only with `possible: true` (`SinkRecord.detection`; the adapters take `possible` too; plain function sinks and
  sinks by name never get them). Telemetry: the same `detect` event with `tier: "possible"` (absent on likely ones),
  and `summary.counts.possibleDetections`; nothing new about the page. Expected effect, from measurements already
  made for the 0.2.0 profiles (eager vs balanced on held-out real apps: stale 30 → 45%, broken 6 → 13%, duplicate
  75 → 77%), and what is not measured end to end: docs/runtime/RESULTS.md §11. The 0.2.0 fit held eager-profile
  detections (likely and possible together) to at most 5% (real apps) / 6% (simulated) false per clean decision,
  against 2% / 3% for balanced; the share of possible detections that are false is not measured and is expected to
  be well above the likely tier's.
- **`explain()` and the devtools use the same gate as the "detect" event.** Both read the tier recorded with the
  decision; the devtools backfill (a panel opened after the fact) used a fixed 0.6 before, so it listed decisions
  that were never reported (0.6 to 0.9 at balanced) and missed reported ones under a report gate below 0.6.
- **Situations raised while the model loads are decided once it is ready** (observe, where the possible tier is in
  force). Until now, a page view's salient situations while the model loaded (about 4 s in production) were dropped
  before triage, uncounted; the ones before the idle preload started were counted as failOpen `not-ready`, and the
  first of them started the load. Now a salient situation is built at its trigger (the same text, at the smallest
  automatic situation budget while the device is not known yet) and kept, at most 32 (the oldest dropped, counted as
  failOpen `not-ready`), then decided in order as a background decision with a detection-only deadline (30 s from
  its submission), after any fresh decision. A lazy model starts loading at the first one. A deferred decision never
  acts: it is gated as observe whatever the mode is by then, and dropped (counted) if its subject is no longer in
  observe. **Its detection is reported at the possible tier at most** (a likely one is recorded as possible), until a
  cold-start and hidden-tab clean run measures the false-report rate of these late decisions (RESULTS.md §11). Its
  telemetry decision record carries the page path at its trigger, not the page it was decided on. Guard and heal do
  not defer and, as before 0.3.0, do not build situations while the model loads.
- **Hidden tabs (observe, where the possible tier is in force):** salient situations raised while the tab is hidden
  are built at once and decided when it is visible again, in order (the same queue of 32; a dropped one counts in
  `summary.model.hiddenSkipped`), at the possible tier at most. A hidden tab never starts loading or reloading the
  model: the tab becoming visible does (OPTIONS-SPEC §4.18 counts hidden time as idle). Before, observe skipped them
  like guard and heal still do (OPTIONS-SPEC §5.1); `detect: "likely"` keeps that.
- **Fix: with `model.unloadAfterIdleMs`, detection stopped for good after the first idle unload.** The "unloaded"
  state was not consultable, so nothing ever asked for the model again. Now the next salient situation in a visible
  tab reloads it (OPTIONS-SPEC §4.18), as does the tab becoming visible with deferred situations waiting: in observe
  that situation is decided once the model is back, in guard and heal it fails open and the next one is decided (so
  guard and heal act again after the reload). The reloaded model is idle-unloaded again later.
- **Fix: a response body slower than 100 ms hid pending-change and typed-text overwrites in observe.** A delivery
  whose only conflicts were a pending local change or text the user typed was settled as not salient when its body
  wait ran out, which covered its writes: neither the delivery nor the write was decided. Now, where those writes
  cannot act (observe), the delivery stays salient and undecided, as when the app writes before the body, so its
  writes get their own decisions. Guard and heal still decide such a delivery without its body.
- **Observe computes overwritten writes on slow devices.** The queue skipped a superseded decision (the write was
  overwritten before the model got to it) whenever decisions took over 300 ms, which is most single-thread WASM
  devices, to keep a fresh held item from waiting behind it. Nothing is held in observe, so there it is computed now;
  guard and heal keep the skip.
- **Priority aging in observe:** a queued decision gains one priority level per second it waits, up to the background
  level, so error and transition decisions (priority 0) go before newer writes instead of waiting out their deadline
  in a burst. Still 30 model evaluations a minute (`model.maxDecisionsPerMinute`); the provider timeout (10 s) also
  bounds the longer deadline of deferred situations.

### App tokens, dashboards and function-specific protection with `protect()`

Each web app can have a token that groups its diagnostics under a private dashboard on genclass.dev, and GenClass can
be pointed at a few functions instead of the whole app. No model-visible text changes (`scope: "functions"` changes
which subjects are decided, never what the model reads about one). Without a token, neither the token nor `fn` is
sent; what telemetry adds in 0.3.0 with or without one is under "What changes when you upgrade", above.

- **`InitOptions.token`** (also `data-token`, `<meta name="genclass" content="token=...">` in `<head>`,
  `window.GENCLASS_CONFIG.token`): `gc_` + 22 letters or digits (`TOKEN_PATTERN`, `isValidToken` exported). Sent as
  the telemetry batch envelope's top-level `token`; `runtime.telemetry.token` reports it. A malformed token logs one
  console warning and is ignored; never throws. It does nothing while telemetry is off: on a local host the console
  says so once (local hosts feed a dashboard only with an explicit `telemetry: true` or telemetry options object),
  otherwise only with `debug: true`. Opt-outs and Global Privacy
  Control still win. With a token, the telemetry console notice says the diagnostics also feed the app's dashboard.
  `token` and `scope` are fixed when GenClass starts: `GenClass.init({ token, scope })` on a runtime that `/auto` or
  the script tag already started is ignored with one console warning that says where to set them
  (`window.GENCLASS_CONFIG`, the meta tag, `data-token` / `data-scope`); before, only a different `mode` warned.
- **`protect(name, fn)`** (named export, `GenClass.protect`, and `window.GenClass.protect` on the script tag): returns
  a function with the same signature whose calls run as an operation named `name` (like `runtime.op`), so the
  requests, state writes, timers and errors it causes are linked to it. `this`, arguments, return value and thrown
  errors pass through; sync stays sync; an async function's promise is replaced by one that settles the same way;
  other thenables are returned untouched. Safe to wrap at import time: without a runtime it calls `fn` directly.
- **`InitOptions.scope`**: `"app"` (default, unchanged) or `"functions"`: the runtime raises decisions, and asks
  standing questions (`runtime.question()`, plugin `questions`), only for activity inside protected functions;
  everything is still recorded as context, and `runtime.ask()` / `runtime.decide()` are still answered everywhere.
  Also `data-scope` / `scope=` in the meta tag. Test: for an async function, `protect()` and `runtime.op()` give a
  byte-identical situation.
- **`Decision.fn`**: the outermost protected function in the subject's cause chain (the name the app chose, at most
  80 characters), also on a held subject's answer that arrives after the hold budget. Telemetry `decision` events
  carry it as `fn` **only when the app set a token** (it feeds that app's dashboard); a label that looks like data
  (an e-mail address, a URL, 4+ digits in a row, 12+ hex digits) is sent as `[redacted]`.
- **`init` can create a project**: after you approve the diff (or with `--yes`), `npx @genclass/runtime init` calls
  `POST https://genclass.dev/api/projects` with the `name` from `package.json`, writes the token into what it adds
  (`genclass.config.*`, `data-token`, or the Astro meta line), prints the private dashboard link and saves both in
  `.genclass.local` before writing anything else (git is asked whether it is ignored; if not, it goes into the
  project's `.gitignore`, created inside a git repository when missing; `remove` keeps the file and that line). A
  file init cannot write still leaves the link saved and printed, with how to retry. Nothing is sent when you decline,
  when there is no terminal and no `--yes`, with `--dry-run`, `--token <gc_...>`, `--no-token` or `--no-telemetry`,
  or when the project already has a token. A network failure or HTTP error warns, sets GenClass up without a token
  and points to https://genclass.dev/start. Running `init` again reuses the token; on a setup made without one it
  never creates a project as a side effect (pass `--token`).
- **Accounts in the CLI: `login`, `connect`, `whoami`, `logout`** (no new dependencies; Node 20 or later).
  `npx @genclass/runtime login` signs in with the device flow (RFC 8628): it asks for a code with
  `POST /api/device/code { client_name: "genclass-runtime <version>" }` (the approval page shows that name and the
  account page labels the session with it), prints the code and `https://genclass.dev/login/device?code=...`,
  opens the browser when it can (not over SSH, not without a display, not with `--no-browser`; it goes on either
  way), polls `POST /api/device/token` at the interval the server gives (5 s more after each `slow_down` or HTTP
  429, or the longer interval a `slow_down` names), and stops on approval, denial or expiry. Ctrl-C stops it and
  saves nothing (exit 130). The CLI session (`gcs_...`) is saved as `{ host, access_token, account, created }` in
  `$XDG_CONFIG_HOME/genclass/credentials.json` or `~/.config/genclass/credentials.json` (Windows
  `%APPDATA%\genclass\`), mode 600 in a directory with mode 700, and is only used for the host it was made for.
  Inside an app's folder `login` then asks whether to connect the app; `connect` does that alone: it picks one of the
  account's apps (`GET /api/me`; `--app <id|name>`) or a new one named after `package.json` (`--name`), created
  with `POST /api/account/projects` only after you approve the diff, and writes the token with init's own edits
  (a setup init made gets it in place; a new one is set up as by init; a hand-written one gets the snippet printed,
  nothing edited). An app init created with a private link can be added to the account instead
  (`POST /api/account/projects/claim` with the link from `.genclass.local`, and only when the link belongs to the
  host the session is for: with `GENCLASS_HOST` set elsewhere, a genclass.dev link is not sent), keeping its token; when genclass.dev
  refuses (the dashboard belongs to another account, or the link is unknown) `connect` says so and how to give the
  folder a new app instead (`--name`), and changes nothing. An app in an account
  has no secret link, so nothing goes into `.genclass.local` for it. `whoami` prints the account and its apps;
  `logout` calls `DELETE /api/account/sessions/current` and deletes the file. `--yes` skips the questions;
  `connect --dry-run` reads the account's app list (`GET /api/me`) and creates and writes nothing.
- **`init` with a saved session** asks, before anything is sent, whether the new app goes into the account
  (`--yes`: it does; no: a private link as before). Without saved credentials `init` is unchanged. A
  `GENCLASS_HOST` environment variable (an origin; plain http only on loopback hosts) points every command at
  another server, for tests and a local `wrangler dev` only, and every command prints it when set. Questions now
  take answers typed ahead, and Ctrl-C at a question exits with code 130. Tests: `test/install/account.test.ts`
  against a fake genclass.dev (`mock-account.mjs`, with the worker's own formats and error answers), and
  `telemetry-worker/test/auth.test.ts` runs the CLI's request functions against the real worker.
- **Accounts on genclass.dev** (the server side, `telemetry-worker/`; deployed separately from this package, see
  `telemetry-worker/README.md`). Sign up and sign in at `https://genclass.dev/signup` and `/login` with a passkey
  (WebAuthn, verified with WebCrypto and no dependencies), Google (OpenID Connect) or GitHub, each provider shown
  only once its client is configured. A Google or GitHub identity joins an existing account only through "Link" on
  `/account` while signed in, never because an email matches. `/account` lists the apps (project key, last event,
  dashboard link, whether a private link still opens it, with Turn off), adds an existing private-link dashboard
  (at most 200 apps an account, created or added), lists passkeys, browser sessions and CLI sessions with Revoke and
  "Sign out everywhere else", and deletes the account. Removing a passkey signs out every other session.
  An app's dashboard in the account (`/account/apps/<id>`) shows a Connect panel until its first event arrives: the
  project key with a copy button, `npx @genclass/runtime login`, the `GenClass.init({ token })`, `data-token` and
  meta snippets, and a status line that checks every 5 seconds; until this release is on npm it says first that
  keys and `login` are not published yet. `/login/device` approves or denies a CLI sign-in; only a signed-in visitor
  learns whether a code is live, and only the CLI's own name (`genclass-runtime <version>`) is shown as the
  requester. A CLI session can read the account's apps, create and add apps and end itself, nothing more.
  Private-link dashboards and `/start` keep working without an account.
- **Dashboard counts** (the server side, `telemetry-worker/`, deployed separately): page loads, decisions,
  detections, actions and the loss counters come from each page load's cumulative summary, so a repeated or split
  batch and sampled or capped decision records are counted once and exactly. A `detect` event with
  `tier: "possible"` counts as a possible issue (Fig. 2, its own cards and a Possible column), exact from
  `summary.counts.possibleDetections`, never as a detection; a `detect` without a tier is a detection, as from
  earlier runtimes. docs/runtime/RESULTS.md §12. This needs the worker from this release on genclass.dev: the one
  before it counts every `detect` event, possible ones included, as a detection, takes decisions from the records
  that arrived (too few once routine ones are sampled) and keeps those aggregates 90 days. So the worker, and the
  maintainers' admin aggregates (`site/`), are deployed before this version is published (release.yml, "Before you
  push the tag").
- **Not done:** a per-function mode (`protect(name, fn, { mode })`).
- **Cost:** about +1.8 KB gzip on each first load (CI run 38436014497); the release's total is under "First-load
  size" below.
- **Privacy:** TELEMETRY.md ("App tokens and dashboards") and PRIVACY.md ("Dashboards for website owners") describe
  the token, the `fn` field, what `init` sends to create a project, how long project records are kept and who can
  see dashboard data. Dashboards show counts, hostnames, routes, function names and versions, never situation text.
  PRIVACY.md ("Accounts on genclass.dev") and genclass.dev/privacy list what an account stores: the email as typed
  or as Google returned it and whether it is verified, passkey public keys, the Google `sub` and the GitHub id and
  login when used, session records (a hash, times, the CLI's name) and the apps it owns. An account changes nothing
  the runtime sends.

### Telemetry

- **Telemetry volume is bounded per page load; detections are never dropped; counts stay exact.** Every model
  decision used to be sent as a `decision` record (up to 30 a minute with the built-in model, for as long as a tab
  stayed open). Now every detection is sent, with its `decision` record, never sampled or capped, and so is every
  decision whose top diagnosis is not `expected` (near-misses below the report gate too), that ran an action, was
  vetoed or would have acted in shadow mode. Only routine decisions (top diagnosis `expected`, passive action) are
  thinned: one in four is sent (`telemetry.decisionSample`, default `0.25`, drawn from a mixed hash of the session
  and decision ids, so every page sends close to that share), and no routine records after 200 in a page load
  (`telemetry.maxDecisions`). `summary` events still count every decision, detection, action and veto, and their
  `telemetry` block adds `decisionRecords`, `decisionsSampledOut` and `decisionsCapped` (counts; the two settings
  themselves are not sent). Summaries are not capped: one about every minute while decisions continue, so the exact counts keep
  arriving after the cap (about 40 KB an hour). This narrows what is sent; nothing new about the page is sent.
  Measured in CI for one page over a simulated hour at 30 decisions a minute (scripted decisions, not the model;
  situation text off; the release candidate's runs 38485063587, 38485289326 and 38488753971, and 38471973596 with
  the detection tiers): all routine, 250.9 to 252.2 KB in 157 to 167 requests (61 summaries, 40.7 KB; which routine decisions are
  sampled follows the random session id); every decision a detection, 2,068.5 KB in 361 requests, the same as with
  every record (TELEMETRY.md, "Volume"; docs/runtime/RESULTS.md §10).
  (API.md also had `include.situation` defaulting to true; the default has been false since 0.2.1.)
- **A 429 is a back-off, not a failure.** 0.2.2 stopped a page's telemetry after 3 failed requests in a row, and an
  HTTP 429 from the collector's per-address limit counted as one, so pages behind a busy shared IP (an office or
  campus network) could go silent for good, detections included. Now a 429, or a 503 with a `Retry-After` the page
  can read, puts the refused batch back at the front of the queue and pauses sending for 30 s doubling per back-off
  in a row, or the `Retry-After` (seconds) when it is longer, never more than 5 minutes (page exit still sends by
  `sendBeacon`); it is not a strike. After 8 back-offs in a row (about 27 minutes) a refusal counts as a failure, so
  a collector that keeps refusing still stops the page after three more. Network errors, other statuses and a 503
  without a `Retry-After` count toward the stop as before; a `Retry-After` on them is ignored. When the 1,000-event
  queue is full, the oldest routine decision record makes room, so a detection and its record are never the events
  dropped while one is left. The default transport puts the HTTP `status` and a readable `retryAfterMs` on its
  error; a custom transport can do the same (`TelemetryTransport`).
- **A page the device floor skips still reports why.** Its `session` event says `modelState: "skipped"`, and a
  `model` event with the reason (`device-memory`, `save-data`, `loadIf`) follows it; before, the reason was only in
  the console line, because the model never changed state after telemetry started.
- **Telemetry: model error text carries no URLs.** This version also records the Worker
  constructor's exception in `status.workerError` (see `inlineFallback` below; before, nothing was recorded), and a browser's text
  for it can name the worker script's URL and the page's origin (a Content-Security-Policy or cross-origin
  `SecurityError`). Telemetry replaces every URL with `<url>` in the `model` event's `workerError`, `error` and
  `attempts[].error` and in `model-error` messages (a `ModelNotReadyError` refusing the inline fallback quotes the
  worker's error), for that and for the errors a worker reports before it comes up; `status.workerError` and the
  console warning keep the full text.
- **Telemetry: a page path segment holding an `@` is sent as `:id`.** The `route` on `session` and `decision`
  events replaced only id-like segments (numbers, UUIDs, long hex or tokens, slug ids), so `/users/alice@example.com`
  was sent as it is, kept by the collector and shown among an app's top routes; now any segment with `@` or `%40`
  (an e-mail address, a handle) is `:id`, as in sink records. A name or username in a segment without an `@` is still
  sent (docs/runtime/THREAT-MODEL.md T5). Not model-visible: the situation text and `util.ts` are unchanged.
- **Disclosed:** the app token in every batch of a page that sets one, `fn` on its `decision` events, and the
  project `init` creates (the `name` from `package.json`) are approved by the owner for 0.3.0 and described in
  TELEMETRY.md, PRIVACY.md, both READMEs and the console notice. What is new with or without a token (the possible
  tier's `detect` events and count, the `summary.telemetry` record counts, the skipped-model `model` event and the
  records of deferred decisions; "What changes when you upgrade", above) is counts and tiers of the runtime's own
  decisions, nothing about the page, and is described in TELEMETRY.md, PRIVACY.md and both READMEs.

### Reports where developers look: sink adapters

- **Findings reach the developer's own side: vendor-neutral sink adapters.** In production the `[GenClass]` console
  lines print in your users' browsers; `@genclass/runtime/sinks/console-json` and `/webhook` (both in
  `@genclass/runtime/sinks`) forward every detection, intervention, undo, breaker trip and runtime error as well: one
  JSON line per record on the console, for a log shipper; batched POSTs of
  `{ schema: "genclass-sink/1", version, records }` to a URL you configure by `navigator.sendBeacon`, else `fetch`
  keepalive (at most one POST per idle-time delivery round, or per `flushMs` window with a `clock`). No new
  dependency, and neither ever throws. They send only the record the runtime built: kind, diagnosis, probability,
  action, route, session tags and the redacted evidence (the console line, subject and timeline, URL query values as
  `…`; timeline lines can hold short fragments of app data, as the console does). `evidence: false` on either sends
  the structured fields only. Never the situation text, bodies, headers or cookies. Separate entries, never in the
  first-load bundle. The webhook caps repeats of one bug at 10 per page load (`maxPerSignature`); a bug's signature
  treats op ids, numbers and id-like path segments (UUIDs, hex, tokens, slug ids, emails) as one, so one bug on many
  orders is one cap. It sends at most 50 records and 32,000 UTF-8 bytes per POST and at most one POST per round (the
  browser's 64 KiB keepalive budget is shared with the app's own beacons); the rest waits for the next round, at most
  500 records wait, and on page hide one batch goes (the session summary first) and the rest is dropped.
- **Sentry, PostHog and Datadog: not in the free runtime.** The adapters for those tools that were in development for
  this release (`@genclass/runtime/sinks/sentry`, `/posthog`, `/datadog`, with `init --sink sentry` detecting an
  npm-installed SDK and passing it in) are not part of it and were never published. On Pro, the GenClass collector
  forwards detections to those tools once you turn it on (https://genclass.dev/pricing). The runtime has no adapter, export or CDN file for them. A page config that names `sentry`, `posthog` or `datadog` (any
  case, with or without an option) gets one console warning for them all, "Ignored sink sentry: Sentry, PostHog and
  Datadog forwarding is not in the free runtime: https://genclass.dev/pricing", and
  nothing is loaded or sent for those names; `init --sink sentry` is a usage error that says the same, and `init`
  suggests no sink for a project that depends on those SDKs.
- **Sinks by name, with no code:** `window.GENCLASS_CONFIG = { sinks: ["webhook:/genclass"] }`,
  `<meta name="genclass" content="sink=webhook:/genclass+console-json">`, `data-sink="webhook:/genclass,console-json"`
  on the script tag, and `npx @genclass/runtime init --sink webhook:/genclass` (repeatable; written to the option file,
  the tag or the Astro meta line; `remove` takes it out). `console-json:noevidence` (`--sink console-json:noevidence`)
  prints the structured fields only. The names become one proxy sink that queues records (at most 200) and loads the
  adapters on the first record, never before (a page with `?genclass=off`, or one that reports nothing, fetches none);
  the name table and the adapters are lazy chunks of `/auto` and come from the CDN for the script tag, so only the
  proxy is in the first load. A `webhook:<url>` is made absolute at init and only its own endpoint (origin and path) joins `requests.ignore`
  (`webhook:/collect` never hides `/collections`); from a `<meta>` tag it must be same-origin, like the model URL (a
  cross-origin one is ignored with one warning; THREAT-MODEL T8), and `init` says so for an absolute webhook URL on
  Astro. A string passed to `GenClass.init({ sinks })` directly is now ignored with one warning that names the fix
  (before, every record failed with "a sink failed: … is not a function", reported at most once a minute). Turning
  page-config sinks into options never throws into the app (it runs before `GenClass.init`'s own guard, while `/auto`
  is imported): a `requests.ignore` that is not a list stays as written, for `GenClass.init` to report as it would
  without sinks, and any other failure is one warning.
- **Security: the same-origin check on meta-tag URLs resolves them as the browser does.** A model, ORT or webhook URL
  in `<meta name="genclass">` is now resolved with the WHATWG URL parser against the page and `document.baseURI`, so
  `/\evil.example/`, a tab inside `//` or an injected `<base href>` no longer pass as a same-origin path (the 0.2.2
  check let them through for model and ORT URLs too).
- `SinkRecord.route`: the page path the subject's operation was created on, normalised as telemetry sends it (id-like
  segments and segments holding an `@`, such as an e-mail address, as `:id`; at most 200 chars).
- Both adapters send the evidence (the console line, subject and timeline) by default, while a sink you write
  yourself still gets it only with `evidence: true` (`SinkObject.evidence`, default false). `evidence: false` (or
  `console-json:noevidence`) turns it off per adapter.
- The console default (`report: "console"`) is unchanged. No model-visible text, no telemetry change.

### Flow expectations (opt-in): learn what each action usually does, report the step that did not happen

**Off by default** (`learn: { expectations: true }` turns it on) until its false-report rate on correct apps is
measured (docs/runtime/RESULTS.md, "Flow expectations": the demos' clean-trial gate has not been run). Off, nothing
is learned, stored or reported, and its code is never loaded: `src/learn/flows.ts` is a lazy chunk the runtime
imports on the next task after init (a 0 ms timer on the injected clock), only when the option is on, so it adds nothing to the first
load (the script-tag file carries it inline). Activity before it loads is not learned.

A deterministic, reporting-only layer (`docs/runtime/EXPECTATIONS.md`). For every user action on a route (click,
submit, change, Enter; never typing) the runtime learns which requests it starts and how soon, which request follows
which, what each response's handler writes, where the page navigates and how long the flow settles. Once a step
was seen in at least 95% of 20 or more observations over 3 or more visits (8 or more in one page load when nothing
is stored), a flow in which it did not happen is
reported: a click that sent nothing within its learned deadline, a follow-up request that never came after its
predecessor answered, a response whose handler wrote nothing, a navigation that did not happen, and a request still
waiting past twice its p99 latency. The model is never consulted for these and nothing acts on them in any mode. No model-visible
text changed (no new fact, trigger or situation text).

- `Report.kind "expectation"` with `Report.expectation` (the learned counts); `rt.on("expectation", fn)`; sink
  records of kind `expectation` (counts and signatures, no page text), which reach a sink that forwards every kind
  (a function, `{ send }` without `kinds`, the webhook and console-json adapters) only while the layer is on, and
  never a sink whose `kinds` leaves `"expectation"` out; one console line per deviation
  in the usual style, with a collapsed group; folded repeats as for every report. `report: "interventions"` prints
  none.
- `rt.learned()`: whether the layer is on (`expectations`), the learned flows (current route first) with their
  steps, counts, shares and delays, the recent deviations and the learned relations. Devtools: an **Expectations**
  tab shows the same, and says how to turn the layer on when it is off.
- `learn.expectations` (default false), `learn.minSupport` (8 while every observation is from this page load, 20
  once stored ones count; a number sets both), `learn.minShare` (0.95), `learn.minSessions` (3 when learned state is
  kept in localStorage, else 1; a reload in the same tab is not a new session) and `learn.maxBytes` (200,000).
- A step reported missing is not expected again until it is seen again (`missed` in `rt.learned()`), so an app whose
  behaviour changed gets one line, not one per visit; a flow's counts are halved when it reaches 64 observations; a
  run of hanging requests of one signature is one `response` line until one of them answers.
- False-positive controls (EXPECTATIONS.md §3), all learned counts or properties of the request: a step is
  checked only on the branch of the handler it was learned on (the same set of fields written: a submit that showed
  a validation error and sent nothing is not a gap); a repeat of the action within a page load is held to what
  earlier repeats did; only a request that changes data (not GET, HEAD or OPTIONS) is expected to start or to write
  after its answer; an answer with status 400 or above is no missing write and no predecessor of a follow-up; a
  request with the signature started from anywhere since the action counts as sent; a write that left the value as
  it was counts as handling the answer; an action repeated while its flow is open (a stepper) opens nothing and its
  open flow's writes are not checked; a flow whose page was left for another action is neither learned nor
  reported; deadlines have a 1 s floor.
- Skipped while the page is hidden or offline or the runtime is paused, for requests under `requests.protect`, on
  routes with `mode: "off"`, for the second click of a double click and for disabled controls (the DOM observer now
  records `UserAction.data.disabled`; not model-visible). The layer runs inside `try/catch` and never throws into
  the app.
- First-load size: see the package README "Costs" (measured by `test/bundle.test.ts` in CI). Telemetry does not
  send expectation reports (TELEMETRY.md's event table is unchanged).

#### Learned flows are stored (with the layer on); transition profiles only when asked

With `learn.expectations` on and `learn.persist` unset, the learned flows (reporting only) are kept per origin in `localStorage` under
`genclass:learn`; transition profiles, which the model reads, stay in memory as before (CONTRACT §4), so what
reaches the model in a default install is unchanged. `true` / `"local"` stores both in localStorage, `"session"`
both in sessionStorage, `false` nothing. Nothing is stored by default in jsdom or happy-dom (an app's unit tests) or
when storage throws (then learning stays in memory with this page load's thresholds). The stored value carries a
format number and the runtime version and is discarded, never migrated, when either or `learn.version` (default
`session.tags.release`) changes; the 0.2.2 value is discarded too. It is capped at `learn.maxBytes` (the stored copy
only; a cap below its header removes it), saved 5 s after a change, when the page is hidden or unloads and on
`rt.destroy()`, checked field by field and against the learner's bounds when loaded, and cleared (with a pending
save) by `rt.learn.clear()`. What is stored: request signatures, routes and field names (id-like path segments and
keys normalised; other path segments and map keys as they are), counts, delay samples and branch hashes; user-action
labels only as hashes (transition profiles of user actions, when stored, under `user#<hash>`), never values. A tab's
sessionStorage keeps its session ordinal (`genclass:learn:session`) so a reload is not a new session. The storage
observer does not record the runtime's own writes.

### Defaults, footprint and fixes

- **A device floor by default.** `model.loadIf` now defaults to `{ minDeviceMemoryGB: 4, saveData: "skip" }`: the
  model (about 13 MB downloaded on a first visit and 190 to 280 MB more renderer memory while it is loaded, README
  "Costs") is not loaded on devices whose `navigator.deviceMemory` is under 4 GB, which, as the value is quantised
  to powers of two, means exactly the devices reporting 2 GB or less, nor on Save-Data connections (before:
  Save-Data only made the load lazy). The runtime then keeps observing without a model (`status.state`
  "skipped", reason `device-memory` / `save-data`; nothing is detected or prevented on that device) and prints
  one line: `[GenClass] Model not loaded: this device reports 2 GB of memory and model.loadIf asks for at least
  4 GB. …`. Browsers that do not report `deviceMemory` (Safari, Firefox) load as before. An object `loadIf`
  without `saveData` now skips on Save-Data too (`saveData: "lazy"` keeps the old behaviour).
  `model: { loadIf: () => true }` forces the load. `DEFAULT_LOAD_IF` is exported next to `deviceEnv` and
  `evalLoadIf` (now in `src/model/device.ts`).
- **Fix: `model.inlineFallback: false` is honoured.** The option was documented since 0.2.0 but the model host
  ignored it and ran the model on the main thread whenever the worker could not be created, errored before it
  came up or never came up (a `worker-src` policy, `file:`). Now `false` means the model is not loaded in those
  cases: `status.state` is `skipped` with reason `worker-unavailable` and `workerError` naming the failure, pending
  evaluations fail open, `rt.ready` rejects, `load()` tries the worker again (with its one WebGPU-to-WASM retry), and
  one console warning names the error and the `worker-src` fix. `worker: false` still runs inline (that asks for the
  main thread). The default stays `true` as documented; the `Model ready` line now says `inline on the main thread`
  when it is, and `status.workerError` records why the worker was not used. `npx @genclass/runtime init` mentions `worker-src` in
  its CSP advice.
- **`fetch(new Request(...))` with a body no longer keeps a second copy of the upload.** The fetch observer cloned
  such a Request twice: once to read up to 64 KB for the request's identity, and once as a pristine template for a
  later retry or hedge. Nothing read the template until a replay, so its stream tee queued the whole body in memory
  for the request's lifetime (uploads through axios's fetch adapter or ky, which pass a `Request`). Now there is one
  clone, read up to 64 KB (then cancelled, which stops its tee from buffering), and a retry rebuilds the Request from
  the original's URL and fields with those bytes, only when it happens. A Request whose `content-length` is over
  64 KB is not cloned at all; it, and a body that turns out larger while being read, is not replayable (`retry` is
  not offered for it; before, the template made it replayable at any size). String, form, Blob and BufferSource
  bodies passed in `init` are unchanged.
- **WebSocket and EventSource messages are no longer JSON-parsed inside the dispatch.** Every incoming text message
  (≤ 16 KB) was parsed and summarised before the app's listeners ran, and parsed a second time when its delivery was
  analysed; every text `send` was summarised too. Now the summary and the parsed body are computed only when
  something reads them (the delivery decision of a salient message, a situation that lists the op, devtools), once
  each and from one shared parse. In observe mode a message that nothing finds salient is never parsed. The op, its
  event and the delivery gate are unchanged, and the summary text is the same when it is read (the model sees the
  same situation). Binary messages are still sized at once.

### Measured visual checks

- **New: measured visual checks** ([docs/runtime/VISUAL.md](../../docs/runtime/VISUAL.md)). GenClass now finds visual
  and CSS bugs that never throw an error: text you cannot read because it is nearly the colour of its background
  (below 1.5:1, including on hover, on focus and in dark mode), images, CSS background images, stylesheets, web fonts,
  icon fonts and media that failed to load, styles and images a Content-Security-Policy blocked, `[object Object]`,
  `$NaN`, `{{ }}`, `Invalid Date`, mojibake and lorem ipsum in rendered text, `var(--x)` with `--x` defined nowhere,
  stretched images, pages that scroll sideways (with the element that causes it), a missing viewport meta tag on
  phones, layout shifts above 0.25, a blank main region, invisible layers that swallow clicks, `pointer-events: none`
  or a scroll lock left on `body`, controls under a fixed bar, focus or anchor targets under a sticky header, and
  dialogs covered by other elements: 23 kinds. Each report names the element, what was measured and the threshold,
  and suggests a CSS change for that selector (or the URL, header or HTML change when CSS is not the fix). These are
  deterministic measurements with documented thresholds, reported as kind `"check"` with the line
  `[GenClass] Check (measured): ...`; the model is not involved, they never feed a decision, and they abstain on what
  they cannot know (text over images, video, canvases and gradients, including layers that ignore the pointer,
  filters, partial opacity, forced colours, page translation).
  - **Where they run.** `visual` defaults to `"local"` with `GenClass.init()`, `/auto` and the script tag: on for
    development hosts (a dev server's port on `localhost`, `127.0.0.1`, `[::1]` or a `*.localhost` name, and `*.test`
    names) and when the devtools overlay mounts, off everywhere else, including Capacitor, Tauri, Electron and
    intranet hosts. `visual: true` (or `data-visual="on"`, `<meta name="genclass" content="visual=on">`) turns them on
    everywhere; `?genclass-visual=on` turns on report-only checks for the person who opened the link; `visual: false`
    or `?genclass-visual=off` turns them off. `createRuntime()` leaves them off.
  - **Cost.** First load grows by 550 B gzip on `/auto` and 524 B on the main entry (the stub; measured in CI against
    `release/0.3.0` without the checks), which puts both first loads over the earlier 0.3.0 limits; the maintainers raised them to 108.30 / 100.20 KB
    (see "First-load size" below). The checks are a lazy chunk (`dist/visual/index.js`, about 35 KB gzip), loaded 1.5 s after `load` and only in a visible tab
    that is not prerendering. Every page read (passes, the 2 s read of `html` and `body`, the click, hover, focus,
    scroll and page-blank checks) runs in idle callbacks: slices of 8 ms, 100 ms per pass and 1,000 ms per 10 minutes
    of check time. One step can still exceed a slice when the browser must first lay out a heavy page, and a step of
    50 ms or more is a long task the runtime's `perf` observer records. Low-end devices run only the near-free checks.
  - **Runtime fixes (opt-in).** With `visual: { on: true, fix: true }` and guard or heal mode, three narrow fixes can
    run: a readable text colour (one owned stylesheet rule and a `data-genclass-fix` attribute), and removing a leaked
    inline `pointer-events: none` or `overflow: hidden` on `html` or `body`. Each is re-measured and undone if it did
    not help; a colour fix is measured again every 2 s, after class or style changes and when the colour scheme
    changes, and undone once the background it was made for changes. A scroll lock held since the page loaded, with
    no dialog or menu ever open, is reported but not removed. Fixes can be undone (`finding.fix.undo()`, the devtools
    Undo button) and are undone on `setMode("observe")`, the breaker, `disable()` and `destroy()` at once, and on
    `pause()` at the next 2 s read. Observe mode never changes the page.
  - **API.** `rt.on("check", f => ...)`, `rt.checks(n?)`, `rt.checkNow()`, `Report.kind "check"`, `rt.summary().visual`
    (counts per kind and per route, fixes, cost), sink records of kind `"check"` (only for sinks whose `kinds` lists
    it; the route normalised as in every sink record, a segment holding an `@` as `:id`; the webhook adapter caps
    repeats per check kind and selector), audit entries of kind `"fix"`, a Checks tab in the devtools overlay (with Copy, Show and Undo), and
    `@genclass/runtime/visual` with `checkPage()` for your own Playwright or Cypress tests. An app's `report`
    function and `rt.on("report")` listeners receive reports of kind `"check"` without opting in (sinks only when
    their `kinds` lists it).
  - **Telemetry: nothing.** No field about the visual checks is sent; counts per kind are a proposal awaiting the
    maintainers' approval of the exact fields ([TELEMETRY.md](TELEMETRY.md)).
  - Not covered yet: text over photos, video and gradients, canvas and WebGL content, the colour scheme or viewport
    the visitor is not using, layout shifts and failed CSS images outside Chromium, low contrast that is readable but
    below WCAG AA.
  - **Measured** by a new bench (`bench/visual`, GitHub Actions only;
    [RESULTS.md section 14](../../docs/runtime/RESULTS.md)): 0 false reports in 128 views of the demos, templates and
    compat apps (desktop and phone, light and dark), and recall 1.00 on planted faults for 19 of the 23 kinds
    (`click-blocked` and `scroll-lock-stuck` 0.67, `pointer-events-leak` 0.94, `css-var-undefined` 0.96; run 5). On
    about 40 public home pages the checks
    were tuned on the same sites (the first run had 44 check errors in 100 loads; the fourth had none confirmed);
    there is no held-out site set yet. Because of what the bench found, `css-var-undefined` reports a missing token only
    where its fallback leaves text below 3:1; `focus-obscured` needs a cover that paints and is at most half the
    viewport tall; `layout-shift` needs an element that moved and skips windows that start within 1 s after a scroll;
    `control-unreachable` sees controls inside open shadow roots and skips covers with no box; `scroll-lock-stuck` and
    `pointer-events-leak` treat an expanded popup trigger as something open; and a pass on a page that is never idle
    no longer advances one step per second.
  - **After a review of the checks** (VISUAL.md section 19), correct pages that looked broken no longer do:
    `text-invisible` follows the page's own colour scheme for the canvas (the `color-scheme` meta tag, and dark-only
    pages for every visitor), does not trust a low verdict while a layer that ignores the pointer paints under the
    text, and skips loading placeholders and emoji; `dialog-covered` tests a dialog's controls only where its own
    scroll area shows them; `page-blank` counts web components (shadow roots) as content and waits for a tab that
    stayed visible; `scroll-lock-stuck` ignores wheels at the ends of the page, sideways gestures, gestures the app
    handled and pages that scroll by moving a layer; `pointer-events-leak` ignores a busy shield while a request runs;
    `csp-blocked` and `layout-shift` are reported once per session, not again on every route; `icon-font-failed`
    re-reads the font's status before reporting.

### First-load size

Minified and gzipped by esbuild in `test/bundle.test.ts` (CI run 38477010836, commit 7c7c6d6): `/auto` (with state
discovery) **106.59 KB** and the main entry (`GenClass.init()`) **98.57 KB**, against 99.17 KB and 91.70 KB in
`0.2.2`. The test's limits are the sizes at bff4a71 (106.24 / 98.21 KB, CI run 38465242176) plus 1.5 KB,
**107.74 KB** and **99.71 KB** (owner-approved for 0.3.0); the telemetry 429 back-off added about 0.35 KB since. Each first load is four files now (100.26 + 3.05 + 2.74 + 0.19 KB for `/auto`): the util code the lazy flow
chunk shares is a chunk of its own. Where it goes (CI, step by step, docs/runtime/RESULTS.md §10): app tokens and
`protect()` about +1.8 KB; the device floor, telemetry sampling and Request replays about +1.5 KB; the sink names'
proxy +0.8 KB on `/auto`; the flow expectations' runtime side and learned-state persistence about +3.3 KB (the flow
layer itself, about 4 KB by difference, is a lazy chunk loaded only with `learn.expectations`). The script-tag file is
126.45 KB (it carries the flow layer inline). Observe's detection tiers and deferred situations, with their review
fixes, then add 0.97 KB to `/auto` and 1.02 KB to the main entry (the 429 back-off they brought is counted above;
the expectation report's console text moved into the lazy flow chunk to pay for the fixes): **107.56 KB** and
**99.59 KB** (CI run 38482297879; script tag 127.89 KB), still under the same limits, 0.18 / 0.12 KB below them
(docs/runtime/RESULTS.md §11). The release candidate (with main's accounts and CLI commands, which add no browser
code, and the dashboard's counting, which is the worker's) measures the same: 107.56 / 99.59 KB, script tag
127.89 KB (CI run 38485063587, RESULTS.md §10). With the release review's telemetry fixes (path segments holding an
`@` and URLs in model error text masked): **107.61 KB** and **99.61 KB**, script tag 127.92 KB (CI run 38488753971),
0.13 / 0.10 KB under the limits, which are not re-set. Removing the Sentry, PostHog and Datadog adapters changes no
first load (they were lazy chunks and CDN files); the one console warning for those names in a page config adds
0.10 KB to `/auto` and 0.08 KB to the script tag, and nothing to the main entry: **107.71 KB** and **99.61 KB**, script
tag 128.00 KB (CI run 38494904699, RESULTS.md §10), 0.03 / 0.10 KB under the limits, which are not re-set.

The measured visual checks' first-load stub then adds 550 B to `/auto` and 524 B to the main entry (measured against
`release/0.3.0` by `test/first-load-size.mjs` in CI; the checks themselves are a lazy chunk): **108.25 KB** and
**100.13 KB**, script tag 128.56 KB (CI run 38676978903, RESULTS.md §10 and §13), over the 107.74 / 99.71 KB limits.
The maintainers raised the test's limits to 108.30 / 100.20 KB for this release.

## 0.2.2 (2026-10-13)

- **Fix (privacy): default telemetry is off on local hosts, as documented since 0.2.1.** `GenClass.init()` (and so
  `/auto` and the script tag) passed an explicit `telemetry: true` internally, which skips the local-host rule, so
  pages on `localhost`, `*.local`, `*.test` and private networks sent diagnostics and showed the console notice. An
  unset option now stays unset and the default applies as documented; an explicit `telemetry: true` still sends from
  a local host. This narrows what is sent; nothing new is sent. Test: `test/telemetry-local-hosts.test.ts`.
- **`init --telemetry` no longer writes `telemetry: true`.** It now takes the `--no-telemetry` opt-out out of what
  init wrote (back to the default) and, on a new setup, writes nothing. An explicit `true` would now mean "also send
  from local hosts". An options file written by an earlier `init --telemetry` holds `telemetry: true`: run
  `npx @genclass/runtime init --telemetry` again to take it out.

- **Security: a link or an injected `<meta>` tag can no longer raise GenClass's mode or swap its model.**
  `?genclass=guard|heal` and `localStorage.genclass` now only demote, from the app's mode or from `observe` when it
  sets none (before, they opted a visitor into guard when the app set no mode, so a crafted link could turn on
  guard-tier actions on a production site). Raising from the URL still works with `debug: true` or on a development
  host (`localhost`, `*.local`, `*.test`, private networks). The zero-code entries (`/auto`, the script tag) read
  `<meta name="genclass">` only inside `<head>` (before: anywhere, so markup injected into the body could set the
  mode and the model URL), and a meta tag's model and onnxruntime-web URLs must be same-origin: a cross-origin one is
  ignored with one console warning (use `data-model` / `data-ort`, `window.GENCLASS_CONFIG` or `GenClass.init()` for
  a CDN of your own). THREAT-MODEL T8 updated.
- **The first decision of a page load has a realistic hold budget, and a late answer is no longer thrown away.**
  Before any measured decision the budget came from the warm-up pass, a ~430-token situation (49–74 ms on an Apple
  GPU), so it was the 150 ms floor, while the first real decision measured 137 ms there: 13 ms of margin, and none
  on a slower GPU. The warm-up time is now scaled by its per-token cost to a typical situation (1,200 tokens, plus
  the worker round trip): 49 ms warm-up → 234 ms budget. An answer that arrives after a held request's or write's
  deadline (the queue has moved on and released the subject, as before) was ignored entirely; it is now recorded
  and reported ("the decision arrived after the hold budget expired"), counts as a latency sample and clears the
  queue's "stuck" state. A held subject's queued decision whose subject already went its way runs behind fresh ones
  while decisions are fast (median ≤ 300 ms) rather than being dropped. Deadlines, release timing and the queue's
  occupancy are unchanged. (Not a fix for a hidden tab: held decisions are skipped there by design.)
- **Telemetry goes to `https://genclass.dev/api/v1/events`** (the same collector worker, on the project domain instead
  of a personal workers.dev URL), and **a page stops sending after 3 failed requests in a row**. A strict
  Content-Security-Policy that does not allow the endpoint (the README's own example did not) logged a violation on
  every 10 s flush; now it logs at most 3. Allow `https://genclass.dev` in `connect-src` or pass `telemetry: false`.
  Nothing new is sent.
- **Model downloads retry transient failures.** The model card and model files are retried on HTTP 408, 429 and 5xx
  (after 1 s and 3 s, or a numeric `Retry-After` of at most 8 s) and once after a network error. A cached model card
  is still used at once when the network fails, without waiting. Other statuses (a 404) are never retried. Before,
  one rate-limited answer from jsDelivr left the page without a model: on the one production deployment, 5 of about
  65 sessions on 2026-10-11/12 failed with "model card download failed: HTTP 429".

## 0.2.1 (2026-10-10)

- **Telemetry: no page text by default.** `telemetry.include.situation` now defaults to **false**: decision events
  carry the trigger, diagnosis, confidence, action, gate, outcome, latency and counts, but not the situation text
  the model read. Opt in with `GenClass.init({ telemetry: { include: { situation: true } } })`; TELEMETRY.md now
  says exactly what that text can contain (request names with query strings, route changes, the page title, short
  error messages, short typed values, short store values). The console notice changed accordingly.
- **Telemetry stays off on local and private hosts** (`localhost`, `*.localhost`, `*.local`, `*.test`,
  `*.internal`, loopback, private IPv4 ranges, link-local, `file:`); `runtime.telemetry.reason` is `local`. An
  explicit `telemetry: true` / `{ ... }` still sends from them.
- **Fix: the first salient request after the model loaded was never held in guard or heal mode.** The hold
  budget and the expected model latency used the first warm-up pass, which on WebGPU includes pipeline compilation
  and reads as seconds, so the first decision was taken in the background and could not act. They now use the
  warm pass timed after compilation (`status.latency`), so a duplicate submit right after `Model ready` can be
  coalesced.
- **Fix: the "Model ready" console line repeated** (every 5 s, with each latency notification). Printed once per
  transition into ready.
- Docs: Zustand's `devtools` middleware is off in production builds unless `enabled: true`, so production Zustand
  stores are not discovered without it; `?genclass=guard|heal` only raise the mode within limits.

### From the compatibility matrix (`compat/RESULTS.md`)

Seven framework apps (React + Vite, Next.js 16, Vue + Pinia, SvelteKit 3, Angular 22, Solid, plain HTML) and 15 data
layers, every mode, 10 seeds: no bug introduced; observe identical to no GenClass except one seed of an app race (SWR
optimistic rollback) that GenClass's timing tipped to the correct outcome. No situation text or other model-visible
text changes; no telemetry change.


## 0.2.0 (2026-10-10)

The first release without the beta label, versioned to match `@genclass/runtime-model@0.2.0`. It contains the safety
work below and everything listed under `0.1.0-beta.4`, which was never published.

### Safety: audit trail, interception inventory, money-flow guardrails

- **`rt.audit(n?)`** and `audit: { size, sink }`: a JSON-serialisable audit trail of every decision (acted on or not),
  action, undo, breaker trip and reset, and control change (`setMode`, `setAggressiveness`, `pause`, `resume`,
  `enabled`, `disable`), each with a timestamp, the effective and requested mode, the aggressiveness profile, the gate
  kind, thresholds and their source, the model's probabilities and the model's name, version, variant, device and
  sha256. Bounded in memory (1,000 entries by default); the sink gets every entry after the current task. It never
  changes what the model reads. `status.sha256`: the digest the loaded model variant was verified against.
- **`requests.protect` presets** for payment, checkout and sign-in endpoints: `protectPreset("payments", "auth")`,
  `PROTECT_PRESETS`, or `"preset:payments"` / `"preset:auth"` strings in JSON configs. Protection now also covers what
  a protected response causes (writes, timers and requests started from its callbacks). `npx @genclass/runtime init`
  suggests the presets when the project uses a payment SDK or has checkout or payment pages. Keeping money and identity
  flows observe-only is the documented recommendation.
- **Docs:** [INTERCEPTION.md](INTERCEPTION.md) lists every API GenClass wraps or listens to, what each mode may change,
  what it never does, every action's preconditions and undo, and how `disable()` and `?genclass=off` restore the page;
  a unit test keeps it in sync with the code. New: `SECURITY.md` (reporting, supported versions) and
  `docs/runtime/THREAT-MODEL.md`. The release workflow publishes from a tag with npm provenance (RELEASE.md: how to
  verify a tarball).

### Fixes (found by the new invariant suite, `test/invariants/`)

- The hold budget is now a hard ceiling in three more places: a held store write that the model deferred
  (`policy.holdWrites`) could wait up to 10 s per defer (now its re-decisions share one budget); a response's wait for
  its body and a request's identity body read were not counted against the budget.
- `observe` mode never delays a `fetch` whose `Request` or `Blob` body GenClass reads to identify it (it was sent
  after the read, a few microtasks to 100 ms later); protected and cross-origin requests neither.
- After a late revert, a delivery `discard` no longer drops every later write of the same chain to that field (the
  revert counted as newer data).
- First-load size: `/auto` about 98 KB gzip, the main entry about 91 KB (+1.6 KB each).

## 0.1.0-beta.4 (never published; shipped in 0.2.0)

### One line covers the whole app (automatic state discovery)

`<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime"></script>` or `import "@genclass/runtime/auto"` now
also finds the app's state, so delivery decisions (a response that would overwrite newer data) work in apps that
register no store. In a pilot app (Next.js 16, React state) GenClass had made no state-based decision at all,
because it saw only the network. No situation text or other model-visible text format changes (discovered fields
are ordinary data); telemetry now includes discovered state (below).

- **`InitOptions.autoState`** (`boolean | { react?, redux?, zustand?, pinia? }`): on by default in
  `@genclass/runtime/auto*` and the script tag, off in `GenClass.init()` / `createRuntime()` so explicit setups do
  not change. Installed synchronously when the entry is evaluated, before the framework. Off with
  `autostate=off` (meta tag, `data-autostate`), `window.GENCLASS_CONFIG.autoState = false`, or the kill switch.
- **React ≥ 16.8** (development and production builds) through the React DevTools global hook, installed when absent
  or chained onto an existing one (the extension and React Refresh keep working). Renderers that inject before they
  render get stable wrapped setters that record the op that called `setState` (fetch callback, timer, user handler),
  so a commit that happens later in React's scheduler keeps its cause. Commits are walked over re-rendered fibers only,
  with a 1 ms budget. One observed store per component instance (`Comp.state0`, `Comp.external0`, class state keys;
  production builds: named after the rendered element), 3 instances per component and 48 stores at most; framework
  internals, error boundaries and non-data values are skipped; values equal to a password/card/one-time-code input
  are redacted.
- **Redux / Redux Toolkit** through `window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` / `__REDUX_DEVTOOLS_EXTENSION__`
  shims (forwarding to the real extension): stores created with them get GenClass's Redux enhancer, a full adapter.
  **Zustand** `devtools` stores (and other Redux DevTools `connect` clients) become observed stores.
- **Observed-only stores** (new hub store kind `observed`): writes are recorded with their writer, versions and
  history and decided in the background (detection), never held, dropped, reverted or rolled back. A mutation of an
  observed store offers no write action, and a delivery `discard` is not offered when every field it would write is
  observed only (`defer` still is). Not-offered reasons are not model-visible.
- **`@genclass/runtime/discover`**: the discovery code for `GenClass.init({ autoState: true })` setups (the main
  entry stays without it). Importing it first installs the hooks at once; a runtime started later attaches.
- **`runtime.stores()`** lists registered and discovered stores; the devtools overlay's Now view shows them.
- **Telemetry:** discovered state is sent like registered stores, in the redacted situation text; decisions made
  after discovered state was recorded carry `autoState: true`. PRIVACY.md says so.
- **Cost:** `/auto` first load about 96 KB gzip (was 89 KB; the main entry is unchanged at 89 KB); the script-tag
  file about 110 KB gzip. Commit-walk and pilot-app measurements: README "Costs".

### Fixes from the local healing benchmark (`bench/heal/`)

No situation text or other
model-visible text changes; no telemetry change.

- **Fix: delivery `discard` on Redux and Zustand stores.** A response whose chain writes stale fields *and* other
  fields in one dispatch / `set()` was applied whole (the discard was a silent no-op while its record named the
  fields as dropped). The write now applies without the stale fields, as it already did for atoms and guarded stores.
- **Fewer model calls on fan-out polling (delivery triage).** Requests started together by the same operation (one
  timer tick or user action fetching several items) no longer count as "newer data" for each other, so a correct
  dashboard that writes a shared `updatedAt` from each response is not asked about (or, in guard/heal, held) on every
  poll. Overlapping rounds stay salient.
- **`policy.idempotencyBodyFields`** (opt-in, default none): top-level JSON body fields that carry an idempotency
  key the server deduplicates on (e.g. `["request_id"]`), so `retry` may be offered for such a POST.

### Fixes from the first real-app trial

Found in the pilot trial ( a Next.js 16 site with a strict Content-Security-Policy, observe mode,
`0.1.0-beta.3`). No change to what the model sees (no situation or model-visible text change) and none to the
telemetry payload.

- **No ONNX Runtime wasm in app builds.** Bundlers (Next/Turbopack, webpack, Vite) copied onnxruntime-web's two
  `.wasm` builds and two `.mjs` bundles (41 MB, one file 26.8 MB, over Cloudflare's 25 MiB per-file limit) into every
  app's build output, unused: the runtime fetches the wasm itself. The model worker and the inline fallback now
  import the prepared ORT copies in `dist/cdn/ort-*.js`, whose `new URL("<file>", import.meta.url)` patterns are
  hidden from bundlers (same value at runtime). A minimal Vite app went from 40 MB to 772 KB of output.
  onnxruntime-web is pinned to exactly `1.30.0` (the version bundled and fetched).
- **Smaller first load.** The inline (no-Worker) fallback loads the tokenizer, packer, engine and loader on first
  use. `/auto` is about 89 KB gzip (was 99 KB), the main entry with `GenClass.init()` 88 KB (was 98 KB). The README
  said 83 KB before; it now gives the measured number, and `test/bundle.test.ts` keeps it under 92 KB.
- **A CSP-blocked model says so, once.** When the model or ORT download is blocked (a `securitypolicyviolation`
  in the page or the worker, or a network-type failure of a cross-origin URL), the runtime prints one
  `console.warn` naming the blocked origin and the fix (self-host with `fetch-model` + `model.baseUrl` /
  `ortWasmPaths`, or allow the origin in `connect-src`) instead of a bare "Failed to fetch" at info level.
  `status.blocked` = `{ url, origin, csp, directive? }`. A failed ORT wasm download is named in the load error.
- **`fetch-model` self-hosts ONNX Runtime too** (`--ort all|wasm|webgpu|none`, default all, into `<dir>/ort/`, with
  `ort/ort.json`), and prints the options to pass, so `connect-src 'self'` is enough.
- **`init --no-telemetry`, `--telemetry`, `--model-url <url>`** write options without hand-editing: a marked
  `genclass.config.(ts|js)` that sets `window.GENCLASS_CONFIG`, imported right before the `/auto` import (plain HTML:
  `data-telemetry="off"` etc. on the script tag; Astro: a `<meta name="genclass">` line). Re-running `init` with
  them changes the options in place; `remove` takes everything out.
- **`init` discloses telemetry** (on by default, what it sends, how to turn it off, links to TELEMETRY.md and
  PRIVACY.md), and **detects a Content-Security-Policy** (next.config/proxy/middleware headers, meta tags, helmet,
  hosting header files) and prints the self-host steps.
- **ORT warnings no longer hit `console.error`.** Sessions are created with ORT's log cut to errors
  (`logSeverityLevel: 3`): the two benign WebGPU lines ("Some nodes were not assigned to the preferred execution
  providers ...") are gone; real failures still reject and are reported.
- **`status.scope` reports the effective mode.** `status.scope.mode` was the route ceiling ("heal" with no `routes`
  rule) and read as if the page ran in heal mode; it is now the effective mode on the current route (as
  `effectiveMode`), with `rule` and `ceiling` when a rule matches. `rt.gates()` carries `mode`.
- `DeviceEnv.mobile` (from `navigator.userAgentData.mobile`) for `model.loadIf` predicates, and a README "Costs"
  section with the trial's measurements (+190 to 280 MB renderer memory with the model worker, 12.7 MB first-visit
  download) and the options for phones.

## 0.1.0-beta.3 (2026-10-09)

> **Privacy-relevant change: anonymous telemetry is now on by default.** Review
> [TELEMETRY.md](TELEMETRY.md) before upgrading; apps that ship GenClass may need to disclose it to their users.

- **Default-on anonymous diagnostics (`telemetry` option).** `GenClass.init()` in a browser (and `/auto`, the
  script tag, `init` setups) now sends GenClass's own diagnostics to the GenClass maintainers' collector
  (`DEFAULT_TELEMETRY_ENDPOINT`, a Cloudflare Worker storing to a private R2 bucket) to improve the model: a session
  event (runtime/model versions, mode, aggressiveness, device class, model load, the page's hostname and
  id-normalised path), every decision (trigger, **the redacted situation text the model read**, calibrated answers,
  diagnosis, gate threshold and source, what ran, latency, held or background), action outcomes (applied, failed,
  undone, late revert, veto), detections, model status and errors, fail-open counts and periodic summaries. Never
  typed password/payment/secret values, cookies, headers, bodies, storage, query strings or app error messages; the
  collector stores no IP address or user agent. A random per-page session id (not persisted, no cookies). One
  console notice per page.
- **Opt-outs:** `telemetry: false` (also `telemetry=off` in `<meta name="genclass">` / `data-telemetry="off"`),
  `?genclass=no-telemetry` or `?genclass=off`, `localStorage["genclass.telemetry"] = "off"`, and Global Privacy
  Control (`navigator.globalPrivacyControl === true`) is always honoured. Off in Node/SSR and in `createRuntime()`
  unless enabled. `telemetry: { endpoint, sample, flushMs, maxBatch, include: { situation } }` for your own
  collector, sampling or leaving the situation text out; `runtime.telemetry` says whether it is on and why not.
- Telemetry is read-only: it never changes what the model sees (no situation or model-visible text change), never
  delays a decision, uses the fetch/sendBeacon captured at load (GenClass never observes its own requests), keeps a
  bounded queue and drops failed batches without retrying or throwing.
- New exports: `DEFAULT_TELEMETRY_ENDPOINT`, `TELEMETRY_SCHEMA`, `TELEMETRY_NOTICE`, `RUNTIME_VERSION`; types
  `TelemetryOptions`, `TelemetryTransport`, `TelemetryStatus`. `TELEMETRY.md` ships in the package.

## 0.1.0-beta.2 (2026-10-08)

Merges the 0.1.0-beta.1 work (model 0.2.0, aggressiveness, batch 12 options) with the fixes that shipped in
0.1.0-beta.0 but were missing from 0.1.0-beta.1, which was published from a branch without them.

- **Default mode is `observe` again.** `GenClass.init()` with no `mode` reports what it sees and never changes
  execution; `guard` is opt-in and `heal` is experimental (0.1.0-beta.1 defaulted to `guard`). `aggressiveness`
  still defaults to `"balanced"`; its action gates apply once you opt into `guard` or `heal` (in observe mode it
  only picks the profile's report threshold for detections: 0.95 / 0.90 / 0.70 for cautious / balanced / eager). `shadow: "guard"` in observe mode records what guard
  would have done, background delivery decisions included.
- **Observe never holds or delays a delivery.** A response or push message is released synchronously, before any
  body read, whenever no hold is possible (observe, sample cap, breaker downgrade, an observe / off route scope, a
  protected or cross-origin subject, no permitted action, or a model too slow for the remaining hold budget). The
  delivery decision is still made in the background and recorded (`executed: false`), on the state the delivery was
  released into; while it is pending it covers its chain's writes, so they are not decided twice.
- **Redaction fixes:** the "would replace text the user typed" fact no longer prints characters of a redacted
  field, and numbers and arrays under a secret-named container (`payment.cvv.value`, `login.otp.code`) are redacted.
- **Install CLI fixes:** `init` without `--mode` writes the observe import, and `--mode guard|heal|observe` writes
  `/auto/<mode>` (or `data-mode` on the script tag) and switches it in place when run again; `remove` deletes only
  what `init` wrote, including formatter-rewrapped lines, and changes nothing when you edited inside a marked block;
  Node servers and libraries are refused; SRI only for this version's own jsDelivr / unpkg file; `typesVersions`
  for `"moduleResolution": "node"`.
- **`fetch-model` downloads from jsDelivr by default:** `https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/`,
  the same directory as the runtime's `DEFAULT_MODEL_BASE_URL` (a test keeps them equal).
- **CI:** GitHub Actions runs typecheck, build, the unit tests and review-perf (separately, with retries) against a
  committed root `package-lock.json`.

## 0.1.0-beta.1 (2026-10-08)

Published from the `runtime` branch; it did not include the 0.1.0-beta.0 observe default, delivery, redaction and
install fixes listed above (0.1.0-beta.2 restores them).

- **Model 0.2.0** (`@genclass/runtime-model@0.2.0`, `genclass-runtime-r17` 2.0.0-rc4t, run `r17-v2dT`) is the
  default model: a gain gate and three aggressiveness profiles in `meta.json`. Numbers in `docs/runtime/RESULTS.md`.
- **`aggressiveness`** (runtime batch 11): `"cautious" | "balanced" | "eager"` or a number 0–1, per route too;
  `rt.setAggressiveness()`, `?genclass-aggr` (demote only unless `debug`), a devtools selector, `rt.gates()`.
- **Batch 12, 19 options** (`docs/runtime/OPTIONS-SPEC.md`): `enabled`, `rt.disable({ undo })`, `sample`, `routes`,
  `requests.{ignore, protect, labels, correlate, crossOrigin}`, `breaker`, `shadow`, `onBeforeAction` + `vetoMode`,
  `policy.actionLimits` (60/min, 10/min per subject, 200 per session), `policy.holdBudgetMs` as a hard ceiling,
  `sinks`, `session`, `report: "interventions"`, `rt.summary()`, typed `rt.on()` events, and `model.{loadIf,
  threads, timeoutMs, maxDecisionsPerMinute, unloadAfterIdleMs}`.

## 0.1.0-beta.0 (2026-10-08)

- **Ships with a model.** A default `GenClass.init()` now loads `@genclass/runtime-model@0.1.0`
  (`genclass-runtime-r17` 2.0.0-rc2, checkpoint `r17-v2b`) from jsDelivr. The model is 9.6 MB (q8, WASM) and is
  cached after the first load. On held-out data:
  - Diagnosis: 84.2% on simulated apps and 83.6% on real apps.
  - False interventions: 0.01% (guard) and 0.07% (heal) on simulated apps; none were seen on held-out real apps.
  - Recall is low: guard acts on 0.7% of clear simulated cases; heal on 2.9% of them and on 5.7% of actionable
    real-app cases.
  - In observe mode, 1.4% (simulated) to 3.8% (real) of decisions where nothing was wrong get flagged (3.1% on the
    model's own on-policy simulated traffic).

  Numbers, gates and limits are in the model card (`@genclass/runtime-model`, `MODEL_CARD.md`).
- **The model sets the gate thresholds** (runtime batch 6). The model's `meta.json` `gate` provides the report,
  guard and heal thresholds per trigger kind; `policy.thresholds` still overrides them. The shipped model uses:
  - report 0.85;
  - guard 0.80 (mutation 0.95);
  - heal 0.85 (failure 0.95).

  These were refit on the model's own on-policy traffic before release.

  `rt.gates(trigger)` shows the values in force and where each came from. Decisions record the threshold and its
  source, and the devtools overlay shows the gates. Also in batch 6: a request with no latency baseline counts as a
  stall after 10 s.
- **Observe stays the default**, and in this version it never holds or delays a response. The delivery decision is
  made in the background and recorded with `executed: false`. A later `GenClass.init({ mode })` that cannot apply
  (the runtime is already running) now logs one warning instead of being ignored silently.
- **`retry` only when repeating is safe** (runtime batch 7). It is offered for idempotent methods, and for POST /
  PATCH only with an idempotency-key header (`policy.idempotencyHeaders`). `Situation.notOffered` says why an action
  was left out.
- **Fewer false `inconsistency` triggers** (runtime batch 8, relation learner precision):
  - sentinel "nothing selected" values are understood;
  - uniqueness is learned only for id columns;
  - pagination and envelope fields are ignored;
  - nothing is checked during typing bursts;
  - busy counters are excluded;
  - equality, count and sum relations need compatible field names.

  On 444 clean runs of 148 real apps, inconsistency decisions fell from 745 to 45. The situation format tag is now
  `situation-v2.3`.
- **One-command install** (new in this version; not in 0.1.0-alpha.1): `npx @genclass/runtime init` detects your
  framework and installs GenClass, and `remove` undoes it. In end-to-end runs on fresh Vite (React, Vue, Svelte),
  Next.js App and Pages Router, Create React App, SvelteKit, Astro, Nuxt, React Router, Angular and plain-HTML
  projects, `remove` restored every file byte for byte. Those runs predate the install fixes below.
- **One import:** `import "@genclass/runtime/auto"` (also `/auto/observe`, `/auto/guard` and `/auto/heal`).
- **One script tag:** `<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime"></script>`, which loads the model
  worker cross-origin.
- **Install fixes:**
  - `init` without `--mode` writes the observe import. `--mode guard|heal|observe` writes `/auto/<mode>` (or
    `data-mode` on the script tag), and running `init` again with another `--mode` switches it in place.
  - `remove` deletes only what `init` wrote, including lines a formatter rewrapped (Prettier, ESLint `curly`). If you
    edited inside a marked block, it reports where and changes nothing. It keeps the package installed while
    dot-folders or `tmp` / `out` / `build` still import it.
  - Node servers and libraries that merely list a bundler are refused instead of edited.
  - An SRI hash is added only for this version's own jsDelivr / unpkg file.
  - `typesVersions` makes the subpath types resolve under TypeScript `"moduleResolution": "node"`.
  - `fetch-model` downloads from `@genclass/runtime-model@0.1.0` on jsDelivr by default, the runtime's own default
    model.
- **Redaction fixes:**
  - The "would replace text the user typed" fact no longer prints characters of a redacted field.
  - Numbers and arrays under a secret-named container (`payment.cvv.value`, `login.otp.code`) are redacted.

## 0.1.0-alpha.1

- **Never reorders your app's writes.** Decisions now happen at the network boundary (the new `delivery` trigger
  for fetch, XHR, WebSocket and EventSource), which looks like latency to the app. Store holds are opt-in
  (`policy.holdWrites`). With a model that never intervenes, GenClass changed 0 of 396 clean runs across 66 real
  apps.
- **Observe is the default mode**; `guard` is opt-in and `heal` is experimental.
- **New facts:** "would put back a value a newer write replaced", "would replace text the user typed", "response
  changes nothing", stale-value provenance, refresh/save cadence, failure scope, commit ambiguity, repeat-click
  evidence, and count-by-group relations.
- **Fixes:**
  - an infinite recursion when app state contains `NaN`;
  - clicks inside shadow DOM were described as the host element;
  - nested-label element names included the text of their options;
  - redaction is now by field name, so a store named `auth` is no longer hidden wholesale;
  - 34 review findings, each with a regression test.

No model for this runtime was published with this version.

## 0.1.0-alpha.0

First alpha.
