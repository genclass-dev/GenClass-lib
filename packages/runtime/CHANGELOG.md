# Changelog

## Unreleased

### App tokens and dashboards; function-specific protection with `protect()`

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
- **Not done:** a per-function mode (`protect(name, fn, { mode })`).
- **Cost:** about +1.8 KB gzip on `/auto`: 100.68 KB (98.86 KB in 0.2.2), and the main entry 93.19 KB, minified
  and gzipped by `test/bundle.test.ts` in CI (run 38436014497). Its ceilings are 101 KB and 94 KB.
- **Privacy:** TELEMETRY.md ("App tokens and dashboards") and PRIVACY.md ("Dashboards for website owners") describe
  the token, the `fn` field, what `init` sends to create a project, how long project records are kept and who can
  see dashboard data. Dashboards show counts, hostnames, routes, function names and versions, never situation text.
  PRIVACY.md ("Accounts on genclass.dev") and genclass.dev/privacy list what an account stores: the email as typed
  or as Google returned it and whether it is verified, passkey public keys, the Google `sub` and the GitHub id and
  login when used, session records (a hash, times, the CLI's name) and the apps it owns. An account changes nothing
  the runtime sends.

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
  - **Cost.** First load grows by about 0.55 KB gzip (the stub, measured against main in CI), which puts `/auto` at
    101.24 KB, over the 101 KB ceiling: raised to 101.5 KB on this branch, pending the maintainers' decision. The checks
    are a lazy chunk (`dist/visual/index.js`, about 35 KB gzip), loaded 1.5 s after `load` and only in a visible tab
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
    it), audit entries of kind `"fix"`, a Checks tab in the devtools overlay (with Copy, Show and Undo), and
    `@genclass/runtime/visual` with `checkPage()` for your own Playwright or Cypress tests. An app's `report`
    function and `rt.on("report")` listeners receive reports of kind `"check"` without opting in (sinks only when
    their `kinds` lists it).
  - **Telemetry: nothing.** No field about the visual checks is sent; counts per kind are a proposal awaiting the
    maintainers' approval of the exact fields ([TELEMETRY.md](TELEMETRY.md)).
  - Not covered yet: text over photos, video and gradients, canvas and WebGL content, the colour scheme or viewport
    the visitor is not using, layout shifts and failed CSS images outside Chromium, low contrast that is readable but
    below WCAG AA.
  - **Measured** by a new bench (`bench/visual`, GitHub Actions only;
    [RESULTS.md section 9](../../docs/runtime/RESULTS.md)): 0 false reports in 128 views of the demos, templates and
    compat apps (desktop and phone, light and dark), and recall 1.00 on planted faults for 20 of the 23 kinds
    (`click-blocked` and `scroll-lock-stuck` 0.67, `css-var-undefined` 0.96). On about 40 public home pages the checks
    were tuned on the same sites (the first run had 44 check errors in 100 loads, the fourth none confirmed); there
    is no held-out site set yet. Because of what the bench found, `css-var-undefined` reports a missing token only
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
