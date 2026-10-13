# Changelog

## 0.3.0-beta.0 (unreleased)

The first 0.3.0 prerelease, for the `beta` dist-tag (release.yml publishes a prerelease version to the dist-tag
named after it; `latest` stays where it is until the owner moves it). No model-visible text changed: the situation
text is still `situation-v2.3` and the default model is still `@genclass/runtime-model@0.2.0`.

### What changes when you upgrade from 0.2.x

- **App tokens and dashboards:** a page with `token` set also feeds that app's private dashboard on genclass.dev
  (below). Without a token, telemetry sends the same kinds of data as 0.2.2.
- **Detections are never sampled or capped in telemetry.** Only routine decisions (top diagnosis `expected`, nothing
  acted) are thinned, to one in four and at most 200 per page load (Telemetry, below).
- **No model on devices reporting 2 GB of memory or less, or on Save-Data connections** (`model.loadIf` default;
  `loadIf: () => true` restores loading everywhere). Such a page observes without a model, detects nothing and says
  why, in the console and in telemetry.
- **`init` creates a project** (a dashboard) after you approve its diff, unless you pass `--no-token`,
  `--token <gc_...>`, `--no-telemetry` or `--dry-run`.
- **Stored learned state from 0.2.2 is discarded once** (a new format, tagged with the runtime version). In a default
  install nothing is stored; transition profiles are stored only with `learn.persist`, as before.
- New and opt-in: sink adapters (`@genclass/runtime/sinks/*`, `init --sink`), flow expectations
  (`learn: { expectations: true }`), `protect()` and `scope: "functions"`.
- **Observe reports more** (below): "possible" detections on `console.debug`, and situations from while the model
  loads or the tab is hidden, decided once it can. `detect: "likely"` restores 0.2.x's reports; guard and heal act
  exactly as before.

### Observe-mode detection: a "possible" tier, and no blind windows

No model-visible text changed (`git diff` of `src/situation` is empty) and no rule maps a fact to a diagnosis: the
tiers are thresholds on the model's own output, the rest is when a situation is decided.

- **Two detection tiers** (`InitOptions.detect`, `Decision.detection`). *Likely*: the top diagnosis is not `expected`
  and its probability reaches the report gate (`gates().report`: the aggressiveness profile's value from the model
  meta, 0.90 at balanced with model 0.2.0), as before. *Possible* (new): at least the eager profile's report value from
  the same meta (`gates().possible`, 0.70) and below the report gate. On by default only where the effective mode is
  observe and the app set no `policy.thresholds.report`; `detect: "likely"` turns it off, `detect: "possible"` on in
  guard and heal too (reporting only: no action gate reads either tier). A likely detection prints exactly as before.
  A possible one prints the same line plus ` (possible)` with `console.debug` only (hidden at Chrome's default console
  level; repeats fold per tier), reaches `rt.on("detect")` and reports with `detection: "possible"`, shows as a
  dimmed devtools card left out of the badge counts, is counted in `summary().possibleDetections` (`detections` keeps
  the likely ones), and goes to sinks only with `possible: true` (`SinkRecord.detection`; the adapters take `possible`
  too; plain function sinks and sinks by name never get them). Telemetry: the same `detect` event with
  `tier: "possible"` (absent on likely ones; the tier follows from `p` and the `gates.report` already sent), and
  `summary.counts.possibleDetections`; nothing new about the page. Expected effect, from measurements already made
  for the 0.2.0 profiles (eager vs balanced on held-out real apps: stale 30 → 45%, broken 6 → 13%, duplicate 75 → 77%;
  false-detection bounds checked on held-out test: ≤ 5% real / 6% sim vs ≤ 2% / 3%), and what is not measured end to
  end: docs/runtime/RESULTS.md §11.
- **`explain()` and the devtools use the same gate as the "detect" event.** Both read the tier recorded with the
  decision; the devtools backfill (a panel opened after the fact) used a fixed 0.6 before, so it listed decisions
  that were never reported (0.6 to 0.9 at balanced) and missed reported ones under a report gate below 0.6.
- **Situations raised while the model loads are decided once it is ready** (observe only). Until now everything in the
  first seconds of every page view (the idle preload, then about 4 s of loading in production) was dropped before
  triage, uncounted. Now a salient situation is built at its trigger (the same text it would have had) and kept, at
  most 32 (the oldest dropped, counted as failOpen `not-ready`), then decided in order as a background decision with
  a detection-only deadline (30 s from its submission). A lazy model starts loading at the first one. A deferred
  decision never acts: it is gated as observe whatever the mode is by then, and dropped (counted) if its subject is no
  longer in observe. Guard and heal do not defer (a background decision there can still late-revert); while the model
  loads their salient situations now fail open as `not-ready` (counted; before, dropped before triage, uncounted).
- **Hidden tabs (observe only):** salient situations raised while the tab is hidden are built at once and decided when
  it is visible again, in order (the same queue of 32; a dropped one counts in `summary.model.hiddenSkipped`). Before,
  observe skipped them like guard and heal still do (OPTIONS-SPEC §5.1).
- **Fix: with `model.unloadAfterIdleMs`, detection stopped for good after the first idle unload.** The "unloaded"
  state was not consultable, so nothing ever asked for the model again. Now the next salient situation reloads it
  (OPTIONS-SPEC §4.18): in observe that situation is decided once the model is back, in guard and heal it fails open
  and the next one is decided. The reloaded model is idle-unloaded again later.
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
which subjects are decided, never what the model reads about one). Without a token, telemetry sends what 0.2.2
sends.

- **`InitOptions.token`** (also `data-token`, `<meta name="genclass" content="token=...">` in `<head>`,
  `window.GENCLASS_CONFIG.token`): `gc_` + 22 letters or digits (`TOKEN_PATTERN`, `isValidToken` exported). Sent as
  the telemetry batch envelope's top-level `token`; `runtime.telemetry.token` reports it. A malformed token logs one
  console warning and is ignored; never throws. It does nothing while telemetry is off: on a local host the console
  says so once (local hosts never feed a dashboard), otherwise only with `debug: true`. Opt-outs and Global Privacy
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
- **Not done:** a per-function mode (`protect(name, fn, { mode })`).
- **Cost:** about +1.8 KB gzip on each first load (CI run 38436014497); the release's total is under "First-load
  size" below.
- **Privacy:** TELEMETRY.md ("App tokens and dashboards") and PRIVACY.md ("Dashboards for website owners") describe
  the token, the `fn` field, what `init` sends to create a project, how long project records are kept and who can
  see dashboard data. Dashboards show counts, hostnames, routes, function names and versions, never situation text.

### Telemetry

- **Telemetry volume is bounded per page load; detections are never dropped; counts stay exact.** Every model
  decision used to be sent as a `decision` record (up to 30 a minute with the built-in model, for as long as a tab
  stayed open). Now every detection is sent, with its `decision` record, never sampled or capped, and so is every
  decision whose top diagnosis is not `expected` (near-misses below the report gate too), that ran an action, was
  vetoed or would have acted in shadow mode. Only routine decisions (top diagnosis `expected`, passive action) are
  thinned: one in four is sent (`telemetry.decisionSample`, default `0.25`, drawn from a mixed hash of the session
  and decision ids, so every page sends close to that share), and no routine records after 200 in a page load
  (`telemetry.maxDecisions`). `summary` events still count every decision, detection, action and veto, and their
  `telemetry` block adds `decisionRecords`, `decisionsSampledOut` and `decisionsCapped`; the `session` event names
  both settings. Summaries are not capped: one about every minute while decisions continue, so the exact counts keep
  arriving after the cap (about 40 KB an hour). This narrows what is sent; nothing new about the page is sent.
  Measured in CI for one page over a simulated hour at 30 decisions a minute (scripted decisions, not the model;
  situation text off; run 38465242176): all routine, 250.3 KB in 163 requests (61 summaries, 39.3 KB); every
  decision a detection, 2,067.1 KB in 361 requests, the same as with every record (TELEMETRY.md, "Volume";
  docs/runtime/RESULTS.md §10).
  (API.md also had `include.situation` defaulting to true; the default has been false since 0.2.1.)
- **A 429 is a back-off, not a failure.** 0.2.2 stopped a page's telemetry after 3 failed requests in a row, and an
  HTTP 429 from the collector's per-address limit counted as one, so pages behind a busy shared IP could go silent for
  good. Now a 429, or any response with a `Retry-After` the page can read, puts the refused batch back at the front
  of the queue and pauses sending for the `Retry-After` (seconds), else 30 s doubling per 429 in a row up to 5 minutes
  (page exit still sends by `sendBeacon`); it is not a strike. Network errors and 5xx without a `Retry-After` still
  count toward the stop. The default transport puts the HTTP `status` and a readable `retryAfterMs` on its error; a
  custom transport can do the same (`TelemetryTransport`).
- **A page the device floor skips still reports why.** Its `session` event says `modelState: "skipped"`, and a
  `model` event with the reason (`device-memory`, `save-data`, `loadIf`) follows it; before, the reason was only in
  the console line, because the model never changed state after telemetry started.
- **Telemetry: `workerError` in the `model` event carries no URLs.** This version also records the Worker
  constructor's exception in `status.workerError` (see `inlineFallback` below; before, nothing was recorded), and a browser's text
  for it can name the worker script's URL and the page's origin (a Content-Security-Policy or cross-origin
  `SecurityError`). Telemetry replaces every URL in `workerError` with `<url>`, for that and for the errors a worker
  reports before it comes up; `status.workerError` and the console warning keep the full text.
- **Disclosed:** the app token in every batch of a page that sets one, `fn` on its `decision` events, and the
  project `init` creates (the `name` from `package.json`) are approved by the owner for 0.3.0 and described in
  TELEMETRY.md, PRIVACY.md, both READMEs and the console notice. Without a token nothing new is sent.

### Reports where developers look: sink adapters

- **Findings reach the developer: sink adapters for the tools you already open.** In production the `[GenClass]`
  console lines print in your users' browsers; `@genclass/runtime/sinks/sentry`, `/posthog`, `/datadog`,
  `/console-json` and `/webhook` (all five in `@genclass/runtime/sinks`) forward every detection, intervention, undo,
  breaker trip and runtime error as well: `Sentry.captureMessage` at level `warning` with tags `genclass` (the
  diagnosis), `genclass.mode`, `genclass.action` and a per-bug fingerprint (or breadcrumbs with `as: "breadcrumb"`);
  `posthog.capture("genclass_<kind>", { ... })`; `DD_RUM.addError` (`GenClassDetection`, `GenClassIntervention`) and
  `DD_RUM.addAction("genclass_<kind>")`; one JSON line per record on the console; batched POSTs of
  `{ schema: "genclass-sink/1", version, records }` to a URL you own by `navigator.sendBeacon`, else `fetch` keepalive
  (at most one POST per idle-time delivery round, or per `flushMs` window with a `clock`).
  No new dependency: each finds the SDK on the page at send time (or takes the client you pass) and never throws. They
  send only the record the runtime built: kind, diagnosis, probability, action, route, session tags and the redacted
  evidence (the console line, subject and timeline, URL query values as `…`; timeline lines can hold short fragments
  of app data, as the console does). `evidence: false` on any adapter sends the structured fields only. Never the
  situation text, bodies, headers or cookies. Separate entries, never in the first-load bundle. A tool adapter that
  finds no SDK when a record arrives says so once in the console, naming the fix. The tool adapters and the webhook
  cap repeats of one bug at 10 per page load (`maxPerSignature`); a bug's signature treats op ids, numbers and id-like
  path segments (UUIDs, hex, tokens, slug ids, emails) as one, so one bug on many orders is one Sentry issue and one
  cap. The webhook sends at most 50 records and 32,000 UTF-8 bytes per POST and at most one POST per round (the
  browser's 64 KiB keepalive budget is shared with the app's own beacons); the rest waits for the next round, at most
  500 records wait, and on page hide one batch goes (the session summary first) and the rest is dropped.
- **Sinks by name, with no code:** `window.GENCLASS_CONFIG = { sinks: ["sentry", "webhook:/genclass"] }`,
  `<meta name="genclass" content="sink=sentry+posthog">`, `data-sink="sentry,posthog"` on the script tag, and
  `npx @genclass/runtime init --sink sentry` (repeatable; written to the option file, the tag or the Astro meta line;
  `remove` takes it out). `<name>:noevidence` (`sentry:noevidence`, `--sink posthog:noevidence`) sends the structured
  fields only. The names become one proxy sink that queues records (at most 200) and loads the adapters on the first
  record, never before (a page with `?genclass=off`, or one that reports nothing, fetches none); the name table and the
  adapters are lazy chunks of `/auto` and come from the CDN for the script tag, so only the proxy is in the first
  load. A `webhook:<url>` is made absolute at init and only its own endpoint (origin and path) joins `requests.ignore`
  (`webhook:/collect` never hides `/collections`); from a `<meta>` tag it must be same-origin, like the model URL (a
  cross-origin one is ignored with one warning; THREAT-MODEL T8), and `init` says so for an absolute webhook URL on
  Astro. A string passed to `GenClass.init({ sinks })` directly is now ignored with one warning that names the fix
  (before, every record failed with "a sink failed: … is not a function", reported at most once a minute). Turning
  page-config sinks into options never throws into the app (it runs before `GenClass.init`'s own guard, while `/auto`
  is imported): a `requests.ignore` that is not a list stays as written, for `GenClass.init` to report as it would
  without sinks, and any other failure is one warning.
- **`init` reaches npm-installed SDKs.** It suggests `--sink` when `package.json` depends on a Sentry browser SDK
  (`@sentry/react`, `@sentry/vue`, `@sentry/nextjs`, ...; no longer its build plugins or server SDKs), `posthog-js` or
  `@datadog/browser-rum`. The npm Sentry and PostHog SDKs set no page global, so in its option file `init` writes such a
  sink as the adapter with your SDK passed in (`import * as Sentry from "@sentry/vue"; ... sinks:
  [sentrySink({ sentry: Sentry })]`); another `--sink` rewrites those imports, and `remove` takes them out. On plain
  HTML and Astro, where only names fit, it says to add `window.Sentry = Sentry`.
- **Security: the same-origin check on meta-tag URLs resolves them as the browser does.** A model, ORT or webhook URL
  in `<meta name="genclass">` is now resolved with the WHATWG URL parser against the page and `document.baseURI`, so
  `/\evil.example/`, a tab inside `//` or an injected `<base href>` no longer pass as a same-origin path (the 0.2.2
  check let them through for model and ORT URLs too).
- `SinkRecord.route`: the page path the subject's operation was created on, normalised as telemetry sends it (id-like
  and email segments as `:id`, at most 200 chars).
- Every adapter sends the evidence (the console line, subject and timeline) by default, while a sink you write
  yourself still gets it only with `evidence: true` (`SinkObject.evidence`, default false). `:noevidence` /
  `evidence: false` turns it off per adapter.
- The console default (`report: "console"`) is unchanged. No model-visible text, no telemetry change.

### Flow expectations (opt-in): learn what each action usually does, report the step that did not happen

**Off by default** (`learn: { expectations: true }` turns it on) until its false-report rate on correct apps is
measured (docs/runtime/RESULTS.md, "Flow expectations": the demos' clean-trial gate has not been run). Off, nothing
is learned, stored or reported, and its code is never loaded: `src/learn/flows.ts` is a lazy chunk the runtime
imports, after the first idle (on the injected clock), only when the option is on, so it adds nothing to the first
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
  never the Sentry, PostHog or Datadog adapters unless `kinds` lists `"expectation"`; one console line per deviation
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

### First-load size

Minified and gzipped by esbuild in `test/bundle.test.ts` (CI run 38465242176, commit bff4a71): `/auto` (with state
discovery) **106.24 KB** and the main entry (`GenClass.init()`) **98.21 KB**, against 99.17 KB and 91.70 KB in
`0.2.2`. The test's limits are now those sizes plus 1.5 KB, **107.74 KB** and **99.71 KB** (owner-approved for
0.3.0). Each first load is four files now (100.26 + 3.05 + 2.74 + 0.19 KB for `/auto`): the util code the lazy flow
chunk shares is a chunk of its own. Where it goes (CI, step by step, docs/runtime/RESULTS.md §10): app tokens and
`protect()` about +1.8 KB; the device floor, telemetry sampling and Request replays about +1.5 KB; the sink names'
proxy +0.8 KB on `/auto`; the flow expectations' runtime side and learned-state persistence about +3.3 KB (the flow
layer itself, about 4 KB by difference, is a lazy chunk loaded only with `learn.expectations`). The script-tag file is
126.12 KB (it carries the flow layer inline).

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
