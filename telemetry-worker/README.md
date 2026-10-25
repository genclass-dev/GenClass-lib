# genclass-telemetry (collector, per-app tokens, dashboards and accounts)

Cloudflare Worker that receives the default-on diagnostics batches from `@genclass/runtime` (see
[`packages/runtime/TELEMETRY.md`](../packages/runtime/TELEMETRY.md)) and stores them in R2, that gives every web app
a token and a private dashboard on genclass.dev, and that holds the optional accounts (Google, an email and a
password, or GitHub, with passkeys as extra security) which keep several apps in one place and let `npx @genclass/runtime login` connect an app
([Accounts](#accounts)). There are two plans, Free and Enterprise, and nothing is sold on the site: every plan
includes the dashboard, analytics, export, forwarding and your own classifier, which GenClass trains on request
([Paid plans](#paid-plans)). There is no trial.

- **Deployed:** worker `genclass-telemetry`, account `144bd5f5270b51dbe7faf46227a154f0`.
  - `https://genclass-telemetry.mehar-144.workers.dev` (workers.dev). Runtime `0.2.1` and earlier send to this URL +
    `/v1/events`; from `0.2.2` the runtime's `DEFAULT_TELEMETRY_ENDPOINT` is `https://genclass.dev/api/v1/events` (the
    `genclass.dev/api/*` route below, same worker).
  - Zone routes on genclass.dev: `genclass.dev/start*`, `genclass.dev/dashboard*`, `genclass.dev/api/*`, and for
    accounts `genclass.dev/login*`, `/signup*`, `/logout*`, `/account*`, `/auth/*`. They run in front of the site
    (worker `genclass-site`, custom domain, owned by Mehar; this worker never changes it). Paths under these prefixes
    that this worker does not serve are handed to the site unchanged through the `SITE` service binding (a plain
    `fetch()` from a route to a custom-domain origin returns 522).
- **Storage:**
  - R2 bucket `genclass-telemetry`: one gzip JSON Lines object per accepted batch at
    `events/dt=YYYY-MM-DD/rt=<runtime version>/model=<model version|none>/<uuid>.jsonl.gz` (date = server UTC date).
    Each line is `{ sid, runtime, model, sent, receivedAt, country, event }`, plus `token` when the batch carried a
    well-formed one (known or not). Batches without a token are stored exactly as before.
  - D1 database `genclass-dashboard` (`694d7d16-8a47-4810-8e0d-e9c89533460a`): projects and dashboard counters (below).
- **Retention:** 90 days.
  - R2: lifecycle rule `expire-90d` (prefix `events/`, set 2026-10-09):
    `npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-90d events/ --expire-days 90`.
    Check it with `npx --yes wrangler@4 r2 bucket lifecycle list genclass-telemetry`.
  - D1: a daily Cron Trigger (`17 3 * * *`, `scheduled` in `src/index.ts`, `retention()` in `src/dashboard.ts`)
    deletes `daily` and `recent` rows older than 90 days, `hourly` rows older than 48 hours and `sessions` rows older
    than 2 days. Projects themselves (token, name, hash of the secret) are kept until deleted.
  - Paid plans keep an app's daily counters, recent rows and export copies for a year instead
    ([Paid plans](#paid-plans)); nothing is ever kept shorter than the 90 days above.

## Architecture

```
browser (@genclass/runtime) --POST /v1/events {token?, ...}--> genclass-telemetry
                                                                 |-- R2: raw batch (always, as before)
                                                                 '-- token known? -> D1 counters (ctx.waitUntil, one db.batch)
genclass.dev/start            --> /start page --POST /api/projects--> D1 projects (token, sha256(secret))
genclass.dev/dashboard/<secret> --> dashboard page --GET /api/projects/<secret>?range=--> D1 counters
```

| file | what |
|---|---|
| `src/index.ts` | entry point: default export only (`fetch`, `scheduled`). The Workers runtime treats every named export of the main module as an entrypoint, so nothing else is exported here. |
| `src/collector.ts` | ingest (`POST /v1/events`), envelope validation (incl. optional `token`), routing for `/api/*`, `/start`, `/dashboard*`; hands account paths to `src/auth.ts` |
| `src/dashboard.ts` | ids and hashing, project creation and lookup, token cache, aggregation of a batch into counters, stats for the dashboard, retention |
| `src/pages.ts` | HTML/CSS/JS for `/start` and `/dashboard/<secret>`, and the shell and dashboard the account pages reuse (`/account/apps/<id>` is the dashboard in its account mode, with the Connect panel); inline, per-response CSP nonce, fonts from Google Fonts only |
| `src/auth.ts` | accounts: Google, email and password, GitHub, passkeys (sign-in, the passkey step, fresh confirmations), sessions, CSRF, the device flow, owned apps, their routes and their retention |
| `src/password.ts` | passwords: the PBKDF2 hash string, the rules for a new password, the schedule of the delay after wrong ones |
| `scripts/password-hash.mjs` | for the owner: a hash string for a manual password reset ([Owner steps: a forgotten password](#owner-steps-a-forgotten-password)) |
| `src/locked.ts` | the locked private-link page, for a plan file whose plan leaves the dashboard out (none today; the tests run it on a fixture) |
| `src/webauthn.ts`, `src/cbor.ts` | WebAuthn verification with WebCrypto and a minimal CBOR decoder (no dependencies) |
| `src/account-pages.ts` | HTML for `/signup`, `/login`, `/login/forgot`, `/login/passkey`, `/login/device`, `/account`, the locked private-link page and the account message pages |
| `src/http.ts` | shared JSON response and capped body reader |
| `../billing/plans.json` | the plans (prices, Stripe lookup keys, limits, entitlements, pricing-page lines); the site's build reads it too |
| `src/plans.ts` | plans from `plans.json`, what an account may use now (paid plan, grant or Free: `accountAccess`), the Free plan's limits, dashboard ranges per plan, the plan-aware retention sweep |
| `src/stripe.ts` | Stripe over `fetch`: Checkout, Billing Portal, cancellation, webhook signature and events, plan from a subscription |
| `src/billing.ts`, `src/billing-pages.ts` | the billing, forwarding, export and export-key routes; `/account/billing` and the app page's Forwarding and Export sections |
| `src/forward.ts`, `src/paid.ts` | forwarding to Sentry, PostHog, Datadog, Slack and webhooks (encrypted settings, dedupe, hourly cap); what runs after each stored batch |
| `src/export.ts` | the batch index, export copies, JSONL/CSV export pages and their sweep |
| `../scripts/stripe-setup.mjs` | for the owner: Stripe products, prices, webhook endpoint and Billing Portal from `plans.json` |
| `test/billing.test.ts`, `test/forward.test.ts`, `test/export.test.ts` | paid plans: Stripe mocked (`test/account-helpers.ts`), the rest as below |
| `migrations/*.sql` | D1 schema |
| `test/index.test.ts`, `test/dashboard.test.ts`, `test/auth.test.ts`, `test/locked.test.ts`, `test/plans.test.ts`, `test/pages.test.ts` | unit tests (R2 mocked; D1 = `node:sqlite` running the real migrations, `test/d1.ts`; passkeys from a software authenticator, `test/authenticator.mjs`; Google and GitHub mocked; the dashboard page's script rendered in happy-dom) |

## Endpoints

| route | behaviour |
|---|---|
| `POST /v1/events` (also `/api/v1/events`) | body `{ schema: "genclass-telemetry/1", sid, sent, runtime, model, token?, events: [{ t, ... }] }`; content-type `application/json` or `text/plain` (sendBeacon / no CORS preflight). 202 `{ ok, accepted }`; 400 bad shape/JSON; 413 over 256 KB; 415 other content type; 503 R2 failure. A missing, malformed (`^gc_[A-Za-z0-9]{22}$`) or unknown `token` never changes the response. |
| `OPTIONS /v1/events` | CORS preflight (`access-control-allow-origin: *`) |
| `GET /v1/health` | `{ ok: true, schema }` |
| `POST /api/projects` | body `{ name? }` (JSON object or empty; name sanitised, at most 80 chars, default "Untitled app"). 201 `{ token, dashboardUrl, name, created }`, `dashboardUrl` = `https://genclass.dev/dashboard/<32 base62>`. CORS `*`, no credentials. 429 JSON when rate-limited, 400 bad JSON, 413 over 4 KB. |
| `GET /api/projects/<secret>?range=24h\|7d\|30d` | dashboard stats JSON (every plan includes the dashboard; a plan file that left it out would answer 402 `{ ok:false, error, locked:true }`) (default `7d`): `name, token, created, lastEvent, range, from, generated, totals, breakdowns{metric: [{key,count}]}` (top 25 each; 200 for `detect_issue` and `possible_issue`), `distinct{metric: n}` (distinct keys before that cut, e.g. pages with a problem), `series` (24 hourly or 7/30 daily buckets: sessions, decisions, detections, acted, possible, ix_views), `recent` (last 50 detections/interventions in the window; possible ones are not listed). `totals` also has `latencyAvgMs`, `modelLoadAvgMs`, `failOpens`, `modelErrors`, `interventions`, `actionLimits`, `detectionsWithPage` and `possibleWithPage`. Apps that turned on interaction analytics (runtime `interactions` events, [docs/runtime/ANALYTICS.md](../docs/runtime/ANALYTICS.md)) also get `ix_views`, `ix_engaged_ms`, `ix_click`, `ix_rage` and `ix_dead` totals and breakdowns (by route, or route TAB element key; `ix_scroll` by route TAB milestone; top 200 each), counted with their own per-batch budget. 404 `{ ok:false, error:"not found" }` for an unknown or malformed secret. Same-origin only (no CORS). |
| `GET /start` | "Get a token" page |
| `GET /dashboard/<secret>` | the dashboard (for an app with no account too: it is on Free), in views a sidebar switches between: Overview (the summary, the tiles, the trend), Problems, Pages and Actions, Activity, Visitors, Health, and Setup on a private link (Connect, Forwarding and Export in account mode); the hash names the view (`#found`, `#recent-s`), the header has a breadcrumb and the Dashboard guide (genclass.dev/docs/dashboard), and without the script every section shows. With a plan file that left the dashboard out, the locked page (sign in, add the app to the account, see the plans; `src/locked.ts`). 404 page for an unknown secret; `GET /dashboard` redirects to `/start`. `/dashboard/sample` stays open |

Rate limits on batches: `LIMIT`, 1200 per 60 s per client IP (a ceiling for offices and campuses behind one address;
since runtime 0.2.2 a page stops sending after 3 failed requests in a row, so a low per-IP limit would silence every
page behind a shared NAT), and `SESSION_LIMIT`, 30 per 60 s per `sid` (one page sends about 6 a minute). Over either
gives 429 and nothing is stored; a failing limiter lets the batch through. The IP is never stored.

Rate limits on project creation: the Workers Rate Limiting binding `CREATE_LIMITER` (10 per 60 s per client, keyed by
a SHA-256 of `cf-connecting-ip`; the IP is never stored; the binding is per location and eventually consistent, so it
is approximate) plus a global ceiling of 60 new projects per minute checked in D1.

Page and stats responses send `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex`,
and the pages a strict CSP (`default-src 'none'`, scripts and styles only with the response's nonce,
`connect-src 'self'`, `frame-ancestors 'none'`). All dynamic text is inserted with `textContent`.

Limits: 256 KB body, 500 events per batch, `sid` 8-64 chars `[A-Za-z0-9_-]`, every event an object with a string `t`.
Unknown top-level fields are dropped. Event objects are stored in R2 as sent (the client defines them).

## Tokens and secrets

- **Token** `gc_` + 22 base62 (about 131 bits) from `crypto.getRandomValues` (rejection-sampled, unbiased). Public: it
  ships in the app's code and only attributes data to the app.
- **Dashboard secret** 32 base62 (about 190 bits). Private; shown once at creation. D1 stores only its SHA-256 hex
  (`projects.secret_hash`), and lookups go by that hash. There is no recovery: a lost link means a new token.
- Token lookups during ingest are cached in memory per isolate (5 min for known tokens, 30 s for unknown ones).

## D1 schema (`migrations/`)

| table | columns | notes |
|---|---|---|
| `projects` | `token` PK, `secret_hash` UNIQUE, `name`, `created`, `last_event`; from 0003 `id` (16 hex, UNIQUE), `account_id` (nullable), `first_event` | one row per app; `account_id` is null for an app known only by its secret link |
| `daily` | `token, day (YYYY-MM-DD), metric, key, count` PK(token, day, metric, key) | counters per UTC day; `key` is the breakdown value, `''` for totals |
| `hourly` | `token, hour (YYYY-MM-DDTHH), metric, key, count` | same counters per UTC hour, kept 48 h (the 24 h view) |
| `recent` | `id, token, t, route, fn, trigger, diagnosis, action, ran, confidence, mode, executed, acted, kind` | last 500 detections / acted decisions per token; never situation text |
| `sessions` | `sid_hash, token, day, counts` | per page load (SHA-256 of token + sid): JSON state of its exact totals (below), kept 2 days after its last batch |

Metrics (`daily.metric`/`hourly.metric`; `key` in brackets):

| from event | metrics |
|---|---|
| `session` | `sessions`\*, `host` [hostname], `page_route` [route], `runtime` [version], `model_version` [version], `mode` [effectiveMode], `model_kind` [local/custom/off], `webgpu_available` [yes/no] |
| `model` | `model_state` [state], `model_ready`, `backend` [webgpu/wasm], `model_load_ms_sum` / `model_load_ms_n`, `model_from_cache`, `model_load_failed` |
| `decision` | `decisions`\*, `trigger`\*, `route`, `fn`, `diagnosis`\*, `decision_mode`, `executed`, `acted`\*, `acted_action` [ran], `fn_acted`, `latency_ms_sum` / `latency_ms_n`, `latency_bucket` |
| `detect` | `detections`\*, `detect_diagnosis`\*, `detect_trigger`, `detect_route`, `detect_issue` [diagnosis, tab, route], `fn_detect` (route/fn from the decision in the same batch). With `tier: "possible"` (runtime 0.3.0) instead: `possible`\*, `possible_diagnosis`\* (exact from the events; the summary has no per-diagnosis count for the tier), `possible_route`, `possible_issue` [diagnosis, tab, route], `possible_fn` |
| `action` | `action_outcome`\* [applied/failed/undone], `intervention` [action, applied only] |
| `veto`, `breaker`, `model-error` | `vetoes`\*, `breaker_trips`\*, `model_error_events` [code] |
| `summary` only | `fail_open` [reason:trigger], `model_errors` [code], `action_limits` [kind], `hidden_skipped` and `model_dropped` (`runtime.model.hiddenSkipped`, `.dropped`), `telemetry_dropped`, `records_sampled_out`, `records_capped` (`telemetry.dropped`, `.decisionsSampledOut`, `.decisionsCapped`) |

\* **Exact totals.** These metrics, and the `summary`-only ones, count each page load once, however its batches arrive.
A page load's `summary` carries them cumulatively (`counts.decisions`, `.acted`, `.detections`, `.byTrigger`,
`.byDiagnosis`, `.detectionsByDiagnosis`, `.possibleDetections`, `.actionsOk` / `.actionsFailed` / `.undos`, `.vetoes`, `.breakerTrips`);
until its first summary arrives, and for any field a client's summary lacks, its events count them one by one. The
`sessions` row holds, per metric and key, what the counters already got for that page load (the high-water mark), the
seq of the newest summary applied (and per metric the newest one that carried it), and the event seq ranges already
counted (at most 16; the closest ones are merged). A batch adds the difference between the larger of two lower bounds
(what was counted plus its events not yet counted or covered by a summary; its newest summary plus its events after
that summary) and the high-water mark. A repeated batch, a split flush in any order, an older summary arriving late,
and a client that samples or caps its decision records (its summary still counts every decision and detection) are
therefore counted once. When two batches of one page load are processed at the same time, the exact counters and the
state are written in one transaction guarded by the state's revision (`$.rev`); the batch that loses re-reads the state
and retries that part (event counters are written once). A row in the previous format, or a page load quiet for more
than 2 days (its row swept), starts a baseline: its next summary is not counted, only what follows it. Routes,
functions, `detect_route` / `detect_issue` and recent rows come from the events that arrived; `totals.detectionsWithPage`
says how many detections came with a page.

**Possible issues** (lower confidence) are the runtime's own tier, not something the worker derives: from 0.3.0 a
page in observe mode (by default; `InitOptions.detect` changes it) reports a decision whose top diagnosis is not
`expected` and whose confidence is under the report gate but at or over the eager profile's report value (from the
model's meta) as a `detect` event with `tier: "possible"`, and counts it in `summary.counts.possibleDetections`, apart
from `counts.detections`. The worker counts those events, and that summary field, in the `possible*` metrics only,
never in `detections` or `detect_diagnosis`. A `detect` event without a tier (every runtime before 0.3.0, and likely
detections from 0.3.0) or with any other value is a detection. Decision records under the report gate without a
`detect` event (guard and heal, `policy.thresholds.report`, `detect: "likely"`, older runtimes) are in no tier, as they
were in no console line. The client never samples or caps detect events or the records of decisions whose top
diagnosis is not `expected` (only a browser-side drop loses one, and the summary still counts it), so the tier is not a
sample. The runtime side of the tier is on `wave2/detect-observe`; until it is merged into the runtime that is
released, no client sends `tier` and the tier stays empty.

**Sampled metrics.** The decision-record metrics without a \* (`route`, `fn`, `decision_mode`, `executed`,
`acted_action`, `fn_acted`, `latency_*`) come from the records that arrived. From 0.3.0 the client sends a
`decisionSample` share (default 1 in 4) of routine records, at most `maxDecisions` (200) per page load, and every other
record, so these lean towards non-routine decisions and their counts are of records, not decisions. The session event
carries no sampling settings (rule 8), so the worker cannot reweight them; the page labels them as records.

Each batch is aggregated in one `db.batch()` (multi-row upserts `count = count + excluded.count`, at most 300 distinct
event counters and 300 exact ones per batch) after one `SELECT` of its page load's state (both again, for the exact part
only, when another batch of the same page load wrote first). Aggregation runs in `ctx.waitUntil` after the
202 and its failures are swallowed, so D1 can never break ingest.

## Privacy invariants

The worker never stores or logs the client IP, user agent, cookies or any other request header. The only server
additions are `receivedAt` (ISO time) and `country` (Cloudflare's two-letter `request.cf.country`; null if absent).
The dashboard store holds counters, hostnames, routes, function names, labels and versions, never situation text,
session ids (only a hash, for 2 days) or the dashboard secret (only its hash). Workers observability/logs are disabled
in `wrangler.toml`. Tests assert that headers, the city and the situation text never reach the stores.

Accounts add only what [Accounts](#accounts) lists: an email (as typed, or as Google returned it) and whether Google
verified it, a password's PBKDF2 hash string and its wrong-password counter, hashes of the device cookies of browsers
where a password was right, passkey public keys, the Google `sub` and the GitHub id and login when used, session
records (hashes, times, a label), and which apps an account owns. A password is never stored or logged in readable
form; Google and GitHub access tokens are used once during sign-in and never stored; the client IP is only a hashed
rate-limit key.

## Accounts

Optional for the runtime and for collection: `/start`, secret dashboard links and ingest keep working without
one. An account keeps several apps in one place, holds its plan, and lets the CLI (`npx @genclass/runtime login`, in `packages/runtime/bin/lib/login.mjs`
and `account.mjs`, from `@genclass/runtime` 0.3.0) connect an app without copying keys around. Code: `src/auth.ts`
(routes and rules), `src/password.ts` (passwords), `src/webauthn.ts` + `src/cbor.ts` (passkeys),
`src/account-pages.ts` (pages); tests in
`test/auth.test.ts`, which also runs the CLI's own request functions (`account.mjs`) against this router: a change
on either side that breaks the other fails CI.

### Ways to sign in

`/signup` and `/login` offer, in this order: "Continue with GitHub" and "Continue with Google" (each when its secrets
are set), an email and a password (always, so the site always has a way in), then a small "Use a passkey". Creating an account never needs a passkey, and there is no passkey sign-up: a passkey is extra security,
added on `/account` (Security); once the account has one, every password, Google or GitHub sign-in also asks for it
([The passkey step](#the-passkey-step)).

- **Email and password** ([Passwords](#passwords)), no owner setup. Sign-up: `POST /api/auth/password/signup`; the
  email, trimmed and lowercased, is the username (unique among passwords, never verified: GenClass has no email sender
  yet) and the account's email. Sign-in: `POST /api/auth/password/login`, a session at once or the passkey step.
  `/login` links to `/login/forgot`, which says to write to mehar@daybot.ca from the address the account signs in
  with ([Owner steps: a forgotten password](#owner-steps-a-forgotten-password)).
- **Passkeys (WebAuthn)**, no owner setup. Added by a signed-in account on `/account`; `POST
  /api/auth/passkey/register/options` without a session answers 403, and the verify step refuses a sign-up challenge
  stored before passkey sign-up was removed (accounts made by it keep signing in with their passkey). Sign in with a
  passkey ("Use a passkey" on `/login`, `/signup` and the device page): a discoverable-credential prompt, no email.
  Verification is done here with WebCrypto: attestation `none` (any `fmt`
  is accepted and its statement is not verified), ES256 (-7) and RS256 (-257, at least 2048 bits), and checks on
  the clientDataJSON type, a single-use challenge stored for 5 minutes, the exact origin, `crossOrigin`, the RP ID
  hash, user presence, user verification (required), the attested credential id, and the sign counter (a counter
  that does not increase is refused; authenticators that always send 0 are fine).
- **Google** (OpenID Connect authorization code flow, PKCE S256, confidential client), the first button on
  `/login` and `/signup`, shown only when the Worker secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` exist.
  `GET /auth/google` stores state, nonce, the PKCE verifier, where to go next and (for Link) the account and session
  that started it in a single-use `challenges` row (kind `oauth:google`, 10 minutes); one cookie
  (`gc_oauth_google`, HttpOnly, Secure, SameSite=Lax, Path=/auth/google, 10 minutes) holds only that row's random
  id, so a cookie planted from elsewhere cannot name an account to link. It redirects to Google with
  `scope=openid email profile` and `prompt=select_account`. The callback refuses a missing or mismatched state (constant-time) and an `error`
  parameter, exchanges the code with the client secret and the verifier, and takes the `id_token` from that direct
  TLS response: OIDC Core 3.1.3.7 lets a confidential client skip the signature check there, and the claims are
  still checked (`iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` is the client id, `exp` is in
  the future, `nonce` matches). `sub` is the identity (`accounts.google_sub` UNIQUE). The cookie is cleared on every
  outcome.
- **GitHub** (OAuth web flow), shown only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` exist: `/auth/github`
  (the same server-side state, cookie `gc_oauth_github`, 10 minutes), GitHub, `/auth/github/callback` (state check,
  code exchange, `GET https://api.github.com/user` for `id` and `login`; no scope is requested and no email is
  kept). Starting either flow signed out is rate limited (`AUTH_LIMIT`), since each start stores a row.

### The passkey step

Once an account has a passkey, "Require a passkey at sign-in" is on (it is not a separate switch: it is on exactly
while the account has a passkey, and `/account` says which). A correct password, or a Google or GitHub sign-in, of such
an account grants no session: the password route (its JSON answer `{ ok, next: "/login/passkey" }`) or the callback
stores a single-use `challenges` row (kind `mfa`: the account, where to go next, which way in;
5 minutes, `MFA_MS`), sets `__Host-gc_mfa` (HttpOnly, Secure, SameSite=Lax, Path=/, 5 minutes; `gc_mfa` on plain-HTTP
localhost) holding only that row's id, and redirects to `/login/passkey`. That page asks for one of the account's
passkeys: `POST /api/auth/passkey/mfa/options` (our Origin; WebAuthn request options with `allowCredentials` = that
account's passkeys, a single-use challenge bound to the step) and `POST /api/auth/passkey/mfa/verify` (our Origin;
the assertion must be of that account's passkey, with the checks of a passkey sign-in). Only then is the step's row
consumed and the web session created, marked as proven with a passkey (`auth_sessions.passkey_at`), and the browser
goes on to the `next` the sign-in started with. The pending step is never a session: `/api/me`, `/account` and the
device approval treat it as signed out. The CLI's device flow rides on the web session (`/login/device` approves only
with a session), so `npx @genclass/runtime login` gets the same step. The email-collision choice
(`POST /api/auth/pending`) also goes through the step when the identity's account appeared meanwhile and has a
passkey.

Adding a passkey to an account that already has one, and removing a passkey, need a passkey assertion in this browser
session within the last 5 minutes (`FRESH_MS`): a passkey sign-in, the passkey step, or `POST
/api/auth/passkey/confirm/options` + `/confirm/verify` (browser session and our Origin), which the account page runs
when the server answers `{ confirm: true }`. So a stolen session cookie can neither add its own passkey nor remove
the owner's. Removing the last passkey turns the step off (an account with a password, Google or GitHub; a passkey-only
account keeps at least one). Several passkeys are allowed. Lost every passkey: email mehar@daybot.ca (the page says
so); the owner can delete the account's `credentials` rows after checking who is asking.

**Linking rule.** A Google or GitHub identity is attached to an existing account only when that account is signed in
and chooses Link Google or Link GitHub on `/account` (`/auth/<provider>?link=1`; the callback checks that the same
account and the same session that started the Link are signed in). Never because emails match: emails typed at sign-up are unverified, so matching would let
someone register a victim's address first and later receive the victim's Google sign-in. A first Google sign-in whose
email another account already uses lands on a page that says so and offers two choices: sign in to that account with
its passkey and link Google there, or create a separate account (`POST /api/auth/pending`, the identity waits for 10
minutes in a single-use row named by the `gc_pending` cookie).

### Passwords

- **Storage** (`passwords`, one row per account): the username (`email`, UNIQUE) and a versioned string
  `$pbkdf2-sha256$v=1$i=600000,l=100000$<salt>$<hash>`: PBKDF2-HMAC-SHA256 through WebCrypto, 600,000 iterations, a
  16-byte random salt per password, a 32-byte output, both base64url without padding, the password NFC-normalised.
  Cloudflare Workers refuse a WebCrypto PBKDF2 call over 100,000 iterations (workerd's
  `DEFAULT_MAX_PBKDF2_ITERATIONS`), so the 600,000 are six chained calls: link 1 is PBKDF2(password, salt, 100,000),
  each next link is PBKDF2(previous output, salt, 100,000). A guess costs the full 600,000 iterations in sequence, as
  one call of 600,000 would; with `i` = `l` the string is plain PBKDF2. Checking reads `v`, `i`, `l` and the salt from
  the string and compares the 32 bytes in constant time, so stored strings keep working when the defaults rise; a
  correct password stored with less work than today's is re-hashed at that sign-in. One hash costs about 80 ms of CPU
  (Node on an M-series Mac; Workers' BoringSSL is similar), well inside Workers Paid's CPU limit.
- **Rules** (NIST SP 800-63B): 10 to 256 characters, counted as code points after NFC; no composition rules; refused
  when it is on a small embedded list of common passwords (case-insensitive), one character repeated, or the email.
- **Same answer:** an email without a password and a wrong password give the same 400 ("that email and password do
  not match an account; ...") after the same work (a check against `DUMMY_HASH`). Sign-up must refuse an email that
  already has a password (409, "an account already signs in with this email"), which says that much and nothing about
  how that account signs in; the delay below shows the same for an email it slows down.
- **The delay, never a lockout** (`src/password.ts` delayAfter). Each check of a password for an account is counted
  before it is made, in one conditional UPDATE (so parallel guesses cannot all slip in): none for the first 4 wrong
  passwords in a row, then 30 s after the 5th, doubling (1, 2, 4, 8 minutes) to 15 minutes; while it runs no password
  for that account is checked, the right one included (429 with `retry-after` and the wait in words). The count
  starts again after a day without a wrong password, and a correct password clears it. A guesser gets about 4 tries an
  hour after the first few. To keep a stranger from holding the owner out, a browser where that account's password
  was right before skips the account's delay: the device cookie `__Host-gc_device` (`gc_device` on plain-HTTP
  localhost; 32 random bytes, HttpOnly, Secure, SameSite=Lax, Path=/, 400 days), stored only as a SHA-256 hash in
  `password_devices` with the account, rotated at every correct password. Such a browser has its own budget of 5
  wrong passwords in a row; after that it is treated like any other until a correct password. A password change
  forgets every browser of the account; the daily sweep drops rows unused for 400 days. `AUTH_LIMIT` (per IP and
  route) applies on top.
- **Change or add** (`POST /api/auth/password`, browser session and our Origin; Security on `/account`). Change:
  `{ current, password }` (a wrong current password counts toward the delay), or `{ password }` after a passkey in this
  session within 5 minutes (else 403 `{ confirm: true }`, which the page answers with a passkey prompt). It ends every
  other session, browsers and terminals, and every trusted browser, then trusts this one. Add, for an account that
  signs in with Google, GitHub or a passkey: `{ email?, password }`, the email defaulting to the account's (a GitHub
  account has none: the typed one becomes its email too); 409 when another account signs in with that email; an
  account with a passkey needs a passkey in the last 5 minutes first (like adding a second passkey).
- **Forgotten password.** No email sender exists, so `/login/forgot` says to write from the account's address and the
  owner resets it by hand ([Owner steps: a forgotten password](#owner-steps-a-forgotten-password)). The hook for an
  emailed reset is `resetSender()` in `src/auth.ts` (null today) and `storeNewPassword()`, which a reset page would
  call; the comment there lists the route and the challenge row it needs.

### Sessions and request rules

- Web sessions: cookie `__Host-gc_session` (no Domain, so no other genclass.dev host can set or overwrite it), 32
  random bytes as base64url, HttpOnly, Secure, SameSite=Lax, Path=/, 30 days; for a plain-HTTP localhost origin in
  development it is `gc_session` without Secure. CLI sessions: bearer tokens `gcs_` + 32 random bytes, 90 days.
  Both are stored as SHA-256 hashes in `auth_sessions`, listed on `/account` and revocable there (one at a time, or
  "Sign out everywhere else"); a cookie is never accepted as a bearer token or the reverse. `POST /logout` revokes
  the web session, and removing a passkey revokes every other session of the account. `auth_sessions.passkey_at` is
  when the session last proved a passkey (sign-in, the passkey step, a confirmation).
- What a CLI session (bearer) may do is what the CLI needs and the approval page says: `GET /api/me`,
  `GET /api/account/projects`, `POST /api/account/projects`, `POST /api/account/projects/claim` and
  `DELETE /api/account/sessions/current`. Stats, other sessions, passkeys, private links and deleting the
  account answer 403 to a bearer token.
- CSRF: every state-changing request authenticated by the cookie must send `Origin` equal to `AUTH_ORIGIN` (403
  otherwise); the passkey endpoints require it even without a session. The JSON endpoints the pages call require
  `Content-Type: application/json` (415 otherwise). Bearer requests carry no ambient credentials and need no Origin.
  No account endpoint sends CORS headers.
- Rate limits: binding `AUTH_LIMIT` (namespace `7302`, 20 per 60 s), keyed by a SHA-256 of the route and the client
  IP, on sign-up, sign-in options, password sign-in and the current password of a change, starting Google or GitHub sign-in, device code creation, code lookups on
  `/login/device`, device approval and device token polling. A limited poll answers `slow_down` (interval 10)
  before any database read, for unknown device codes too. Account app creation also uses `CREATE_LIMITER` (per
  account) and a global ceiling of 60 apps created in accounts a minute, separate from the 60 a minute for anonymous
  `/api/projects`, so neither can use up the other.
- `/login/device` looks a code up only for a signed-in visitor: signed out, every well-formed code gets the same
  sign-in page, so the page cannot be used to find live codes. `client_name` is kept and shown only when it is
  `genclass-runtime <version>`; anything else shows as "Unknown client".

### Routes

| route | auth | behaviour |
|---|---|---|
| `GET /signup`, `GET /login` | - | the pages (`?next=` only to `/account...` or `/login/device...`); a signed-in visitor is redirected. GitHub, Google (each when its secrets are set), the email and password form, then a small Use a passkey |
| `GET /login/forgot` | - | what to do about a forgotten password (no email reset yet) |
| `POST /api/auth/password/signup` | Origin | `{ email, password, next? }` → `{ ok, account, next }` + session and device cookies; 400 with the rule a password breaks, 409 for an email that already signs in |
| `POST /api/auth/password/login` | Origin | `{ email, password, next? }` → `{ ok, next }` + session (or `next: "/login/passkey"` and the step's cookie for an account with a passkey) + device cookie; 400 for a wrong password or an unknown email (one answer), 429 while the account's delay runs |
| `POST /api/auth/password` | cookie + Origin | change (`{ current, password }`, or `{ password }` after a fresh passkey) or add (`{ email?, password }`) the account's password → `{ ok, changed \| added }`; 403 `{ confirm: true }` when a passkey must answer first; 403 for a bearer token |
| `GET /login/passkey` | `__Host-gc_mfa` | the passkey step after a password, Google or GitHub for an account with a passkey; 400 page when the step expired or is missing |
| `POST /logout` | cookie + Origin | revokes the session, clears the cookie, 303 to `/login?signed_out=1` |
| `GET /account` | cookie | the account page (302 to `/login?next=/account` without one): apps (and "Your plan has no dashboard" with See plans, for a plan file that left it out), Security (sign-in methods, "Require a passkey at sign-in", Add a passkey), sessions. `?claim=1` returns to a locked private link this tab kept |
| `GET /account/apps/<id>` | cookie | an owned app's dashboard with the Connect panel; for a plan without the dashboard (none today), the locked page (the key, the Connect panel, See plans, no stats); 404 for an app of another account |
| `GET /login/device?code=ABCD-EFGH` | cookie optional | signed in: the code and the request, Approve and Deny; signed out: the code and the ways to sign in, whether or not the code is live |
| `GET /auth/google`, `GET /auth/google/callback` | - | Google sign-in (404 page when not configured); `?link=1` needs a session |
| `GET /auth/github`, `GET /auth/github/callback` | - | GitHub sign-in, same rules |
| `POST /api/auth/passkey/register/options` | cookie + Origin | `{}`: a signed-in account adds a passkey (403 `{ confirm: true }` when the account has one and this session has not proved a passkey in 5 minutes; 403 without a session: there is no passkey sign-up) → `{ id, publicKey }` (WebAuthn creation options, binary fields base64url) |
| `POST /api/auth/passkey/register/verify` | cookie + Origin | `{ id, credential: { id, rawId, type, response: { clientDataJSON, attestationObject, transports } } }` → `{ ok, account }` (the passkey is added; no new session) |
| `POST /api/auth/passkey/login/options` | Origin | `{}` → `{ id, publicKey }` (empty `allowCredentials`) |
| `POST /api/auth/passkey/login/verify` | Origin | `{ id, credential: { ..., response: { clientDataJSON, authenticatorData, signature, userHandle } } }` → `{ ok, account }` + session |
| `POST /api/auth/passkey/mfa/options`, `/mfa/verify` | Origin + `__Host-gc_mfa` | the passkey step: options for that account's passkeys; verify → `{ ok, next, account }` + session, the step used up |
| `POST /api/auth/passkey/confirm/options`, `/confirm/verify` | cookie + Origin | prove a passkey again in this session (adding or removing a passkey); verify → `{ ok }` and `passkey_at` = now |
| `POST /api/auth/pending` | Origin + `gc_pending` | create the separate account a Google sign-in asked about (or, if that identity has an account by now, sign in to it: `{ next: "/login/passkey" }` when it has a passkey) |
| `POST /api/device/code` | - | `{ client_name? }` (the CLI sends `genclass-runtime <version>`, the only form shown on the approval page and kept as the session's label) → 200 `{ device_code, user_code: "ABCD-EFGH", verification_uri: "https://genclass.dev/login/device", verification_uri_complete: ".../login/device?code=ABCD-EFGH", expires_in: 600, interval: 5 }` |
| `POST /api/device/token` | - | `{ device_code }` (JSON or a form) → 200 `{ access_token: "gcs_...", token_type: "Bearer", expires_in: 7776000, account: { id, email, github_login } }` or 400 `{ error: authorization_pending \| slow_down (with the new interval) \| expired_token \| access_denied \| invalid_request, error_description }` |
| `POST /api/device/approve` | cookie + Origin | `{ user_code, approve: true \| false }` → `{ ok, status }`; 404 for an unknown, expired or used code |
| `GET /api/me` | bearer or cookie | `{ account: { id, email, github_login }, projects: [project] }` |
| `GET /api/account/projects` | bearer or cookie | `{ projects: [project] }` (the Connect panel polls this every 5 s) |
| `POST /api/account/projects` | bearer, or cookie + Origin | `{ name }` → 201 `{ project }`; at most 200 apps per account |
| `POST /api/account/projects/claim` | bearer, or cookie + Origin | `{ dashboard_url }` or `{ secret }` → 200 `{ project }`: the secret-link app joins the account and its link keeps working; 409 when another account owns it or the account holds 200 apps, 404 for an unknown link |
| `GET /api/account/projects/<id>/stats?range=` | cookie | the dashboard stats (same shape as `/api/projects/<secret>`), owned apps only; 402 `{ locked: true, upgrade_url }` for a plan without the dashboard (none today); 403 for a bearer token |
| `DELETE /api/account/projects/<id>/link` | cookie + Origin | turn off the app's private dashboard link (its hash is replaced by one nobody holds); 204 |
| `DELETE /api/account/sessions/current` | bearer (CLI logout) or cookie + Origin | 204 |
| `DELETE /api/account/sessions/<id>` | cookie + Origin | revoke one of this account's sessions; 204, 404 otherwise (403 for a bearer token) |
| `DELETE /api/account/sessions/others` | cookie + Origin | revoke every session of the account except this one; 204 |
| `DELETE /api/account/credentials/<id>` | cookie + Origin | remove a passkey and end every other session; 409 when it is the last way to sign in; 403 `{ confirm: true }` unless this session proved a passkey in the last 5 minutes |
| `DELETE /api/account` | cookie + Origin | `{ confirm: "delete" }`: delete the account, its passkeys, sessions and pending codes; apps created in it are deleted with their stats, apps with a private link leave the account and keep working; 204 |

A `project` is `{ id, name, token, dashboard_url, created, last_event, first_event }`; `id` is 16 hex, `dashboard_url`
is `https://genclass.dev/account/apps/<id>`. User codes use 20 consonants (no vowels, no look-alikes) and accept any
case or separator; device codes last 10 minutes and are used once; polling faster than the interval (1 s of slack)
answers `slow_down` and adds 5 s to the interval.

### Migration 0003 (`migrations/0003_accounts.sql`)

Additive and safe on the production database: new tables `accounts`, `credentials`, `auth_sessions` (named so
because `sessions` already holds the summary counters), `challenges` and `device_codes`, three nullable columns on
`projects` (`account_id`, `id`, `first_event`) and `private_link` (INTEGER, default 1: every existing project has
a private link; an app created in an account gets 0, and turning a link off sets 0). It gives every existing
project an `id` (`lower(hex(randomblob(8)))`) and a UNIQUE index on it, and a `first_event` for projects that
already had traffic (their earliest detection still in `recent`, else their `last_event`: it can be later than the
real first batch, never the first batch after the deploy); no existing value changes. Rows the old code inserts
between the migration and the deploy get an id when they are claimed. `test/auth.test.ts` runs it on a database
populated the old way. Apply it before deploying the code that reads it:

```sh
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
npx --yes wrangler@4 deploy
```

The daily cron also deletes expired challenges and device codes and expired or revoked sessions.

### Settings

| name | kind | default | what |
|---|---|---|---|
| `AUTH_ORIGIN` | var | `https://genclass.dev` | expected `Origin`, WebAuthn origin, OAuth redirect URIs, cookie `Secure` |
| `AUTH_RP_ID` | var | `genclass.dev` | WebAuthn RP ID |
| `RUNTIME_ON_NPM` | var (wrangler.toml) | `0.2.2` | the newest `@genclass/runtime` on npm, on any dist-tag; below `0.3.0-beta.0` the Connect panel, `/start` and private dashboards say first that keys and `login` are not published yet. Set it to `0.3.0-beta.0` once release.yml has published the beta and jsDelivr serves it, then deploy; at `0.3.0`, set it with `src/pages.ts` `SNIPPET_RUNTIME` and `RUNTIME_PKG` (the snippets pin the script tag to `SNIPPET_RUNTIME` and name the `@beta` dist-tag in their commands while it is a prerelease) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | unset | Google sign-in, the first way in; both needed. An email and a password are offered either way |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret | unset | GitHub sign-in; both needed |

Production needs no other vars (the defaults are production). For local development see `.dev.vars.example`.

### Owner steps: Google sign-in

Until these secrets exist, `/signup` and `/login` offer the email and password form (and GitHub, once its secrets
exist); once they do, "Continue with Google" leads. Accounts made with the old passkey sign-up keep signing in with it.

In the Google Cloud console, project of your choice, open **Google Auth Platform**:

1. **Branding**: app name `GenClass`, a user support email, app home page `https://genclass.dev`, privacy policy
   `https://genclass.dev/privacy`, terms of service `https://genclass.dev/terms`, authorized domain `genclass.dev`,
   and a developer contact email.
2. **Audience**: user type External, then publish the app (In production). `openid`, `email` and `profile` are
   non-sensitive scopes, so there is no sensitive-scope review; Google may still ask to verify the brand (app name,
   domain) before the consent screen shows them. Until it is published, only listed test users can sign in.
3. **Data Access**: scopes `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile` only.
4. **Clients**: create a client of type Web application, authorized JavaScript origin `https://genclass.dev`,
   authorized redirect URI `https://genclass.dev/auth/google/callback`.
5. In `telemetry-worker`: `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`
   (paste the values when asked). `secret put` redeploys the current version with the secret, so once this
   accounts code is deployed the Google button appears on the next request.

### Owner steps: GitHub sign-in

1. In the `genclass-dev` organization: Settings, Developer settings, OAuth Apps, New OAuth App. Application name
   `GenClass`, homepage URL `https://genclass.dev`, authorization callback URL
   `https://genclass.dev/auth/github/callback`. Device flow can stay off (the CLI signs in through genclass.dev).
2. Generate a client secret, then in `telemetry-worker`: `npx wrangler secret put GITHUB_CLIENT_ID` and
   `npx wrangler secret put GITHUB_CLIENT_SECRET`.

### Migration 0006 (`migrations/0006_trials_passkey_step.sql`)

Additive: `accounts.trial_started_at`, `accounts.trial_ends_at` (the trial GenClass had until 2026-10-19; unused
since), `accounts.comp_until` (GenClass's own grant, today of Enterprise; NULL, set only by hand) and `auth_sessions.passkey_at` (when the session last proved a
passkey; NULL for every existing session). No existing value changes. The code reads these columns, so apply it before
deploying:

```sh
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
npx --yes wrangler@4 deploy
```

### Migration 0007 (`migrations/0007_passwords.sql`)

Additive: new tables `passwords` (one per account: `email` UNIQUE, `hash`, `created`, `updated`, `last_used`, and the
delay's `failed`, `failed_at`, `next_try`) and `password_devices` (`hash` of a device cookie and `account_id` as the
key, `created`, `last_used`, `failed`; indexes on `account_id` and `last_used`). No existing row or column changes;
existing accounts have no password until they add one on `/account`. `test/auth.test.ts` runs it on a database with
accounts and sessions made before it. The code reads these tables, so apply it before deploying:

```sh
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote
npx --yes wrangler@4 deploy
```

### Owner steps: a forgotten password

GenClass cannot email a reset link yet, so `/login/forgot` asks the person to write to mehar@daybot.ca from the
address they sign in with. The address was never verified, so check that the mail really comes from it (the message's
DKIM/SPF results in the mail client, and a reply to that address that they answer) before changing anything. An
account with a passkey needs no help: after signing in with the passkey, Security, Change password takes a new password
without the current one. Otherwise set a temporary password, send it to that address, and ask them to change it on
`/account`:

```sh
read -rs PW && printf '%s' "$PW" | node telemetry-worker/scripts/password-hash.mjs; unset PW   # prints $pbkdf2-sha256$...
E=<their email, lowercased>; H='<the printed string>'
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  UPDATE passwords SET hash = '$H', updated = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), failed = 0, failed_at = NULL, next_try = NULL WHERE email = '$E';
  DELETE FROM password_devices WHERE account_id = (SELECT account_id FROM passwords WHERE email = '$E');
  UPDATE auth_sessions SET revoked = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE revoked IS NULL AND account_id = (SELECT account_id FROM passwords WHERE email = '$E');"
```

The account's passkey step still applies after the temporary password, if it has a passkey.

### Live checks of accounts

Accounts are production data too. A check against genclass.dev signs up with an address at `example.com`, names its
apps `... (throwaway, delete me)`, and deletes everything afterwards with Delete account on `/account` (which also
deletes the apps created in it), or by hand:

```sh
A=<account id>
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  DELETE FROM credentials WHERE account_id = '$A'; DELETE FROM auth_sessions WHERE account_id = '$A';
  DELETE FROM passwords WHERE account_id = '$A'; DELETE FROM password_devices WHERE account_id = '$A';
  UPDATE projects SET account_id = NULL WHERE account_id = '$A'; DELETE FROM accounts WHERE id = '$A';"
```

(then delete its throwaway projects with "Delete a project" below).

## Paid plans

The plans live in [`billing/plans.json`](../billing/plans.json) (version 2, 2026-10-22):

- **Free** (US$0): the open-source runtime and its on-device model, the dashboard for every app, with 90 days of
  history, export and forwarding, and your own classifier (`custom_model`): a person from GenClass trains a model on
  the app's traffic, bug reports or labelled examples when its owner emails the contact address, and ships it as
  private model files. Interaction analytics is listed as coming next.
- **Enterprise** (no price: agreed by email with the contact address): everything in Free, a year of history, and
  GenClass's models run in GenClass's cloud for the buyer's apps, on terms agreed together. It has no Stripe product;
  an account gets it from GenClass's own grant (below).

No plan is sold on Stripe Checkout today. Individual (US$29 a month, lookup key `genclass_individual_monthly`, a year
of history and a classifier a person trained for the buyer) was sold from 2026-10-19 to 2026-10-22; an account still
stored on `individual` reads as Free, and its data keeps the 30 days of grace after its paid period ends. Its Stripe
product and prices stay GenClass's own (`billing/plans.json` `retired_plans`, `src/plans.ts` ownedPrice): a
subscription to it is cancelled when its account is deleted, opens Manage billing, shows on the billing page as still
billing (or as cancelled, once it is), and sends the owner a `retired_plan_billing` notice each time a payment of it
clears (`invoice.paid`: its start and each renewal), but gives no plan. Its
classifier is in Free now. The Stripe code and `scripts/stripe-setup.mjs` stay for a plan given a monthly price above
0; the tests run them on Individual's plans file (`test/fixtures/plans-individual.json`, `test/one-paid.test.ts` and
`test/stripe-setup.test.ts`).

Each plan has its limits (`apps`, `history_days`), entitlements (`dashboard`, `forwarding`, `export`, `analytics`,
`custom_model`), Stripe lookup keys (a yearly price can be added later), product tax code (`stripe_tax_code`) and
whether it is sold through Stripe Managed Payments (`managed_payments`: no plan is). `grant_plan` names the plan the
grant gives. Change a price or a limit there; `src/plans.ts` imports the file and `scripts/stripe-setup.mjs` makes
Stripe match it for the plans priced above 0. Nothing in `src/` names a plan but Free and the grant's: every check reads
an entitlement or a limit, so the pages say which plans include something from the file. Until 2026-10-19 the plans
were Free without a dashboard, Pro (US$99, the dashboard) and Custom (US$599, a trained classifier), with a 7-day
trial of Pro; the tests keep that file as a fixture (`test/fixtures/plans-two-paid.json`, loaded with `vi.mock`), so
the code that only two paid plans or a locked dashboard reach (switches, duplicates, Managed Payments, the locked
pages) stays tested. `test/plans.test.ts` checks the real file.

GenClass bills through a Stripe account of its own, "GenClass" (Canada). The worker and the setup script touch only
objects they can prove are GenClass's ("Stripe object ownership" below).

An account's plan is `accounts.plan`, written only by the Stripe webhook from the subscription as Stripe has it. A
price names a plan only when it is provably GenClass's: a lookup key starting with `genclass_` and a product whose
`genclass_plan` metadata names the plan. After a price change the old price is archived with the lookup key
`genclass_<plan>_monthly_retired_<price id>` and its subscribers stay on it, on the same product, so they keep their
plan. `active` and `trialing` give the plan; `past_due` keeps it for 14 days from when GenClass first saw the
subscription past due (`accounts.past_due_since`), then the account is on Free, whatever the Stripe account's retry
settings; `unpaid` and anything else is Free. Entitlements follow the plan. A `pro` or `custom` plan from before
2026-10-19, or an `individual` one from before 2026-10-22, counts as Free.

The key's prefix sets the mode. With a live key (`sk_live_`) a plan priced above 0 is on sale (none is today). With a test key (`sk_test_`) only
the accounts listed in `STRIPE_TEST_ACCOUNTS` can buy and nobody else sees a button, so a test pass can run on the
production worker. The Free plan applies whatever the key. `accounts.stripe_mode` records which mode the Stripe ids
belong to: a plan bought in test mode counts only while the key is a test key (it is Free once the key is live, and
that account's next purchase gets a new live customer). A live plan always counts, whatever the key.

| | Free (no plan or grant) | Enterprise (a grant) |
|---|---|---|
| dashboard, interaction analytics | yes | yes |
| apps per account | no plan limit; the 200-app abuse cap stays | the same |
| dashboard ranges | 24 h, 7, 30, 90 days | and 1 year |
| kept (daily counters, recent rows, stored batches) | 90 days, as every project before plans | 1 year while the grant runs |
| forwarding, export | yes | yes |
| `custom_model` | yes, on request by email (no purchase, so no `custom_requests` row) | yes |

Apps without an account (private links, from `/start` or the CLI's `init`) are on Free: collected, kept 90 days, and
their link opens the dashboard (24 hours, 7 and 30 days).

### Grants (Enterprise) and no trial

- **Grant** (`comp_until`): the plan `billing/plans.json` `grant_plan` names (Enterprise) until that time, set only by
  hand, to the end of the agreement:

  ```sh
  # the account by email; 9999-12-31 means until revoked
  npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET comp_until = '9999-12-31T00:00:00.000Z' WHERE email = 'mehar@daybot.ca'"
  # revoke it
  npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET comp_until = NULL WHERE email = 'mehar@daybot.ca'"
  ```

  When an account has both a paid plan and a grant, the plan listed later in `billing/plans.json` applies (the paid
  one when they are the same; `src/plans.ts` accessOf), so an Enterprise grant covers an account that also pays for
  a plan (cancel that subscription in Stripe if the agreement replaces it). The collector caches each app's plan
  for a minute, so a hand-made change reaches forwarding and export within one.
- **No trial.** GenClass dropped the 7-day trial of Pro on 2026-10-19, when the dashboard became free. Nothing starts
  one: `POST /api/billing/trial` answers 410, `GET /account/trial` (genclass.dev's pricing page linked it until
  then) leads to `/account`, and Checkout never asks Stripe for trial days. The columns the trial used stay (migrations 0006
  and 0008: `trial_started_at`, `trial_ends_at`, `trial_check_failures`, `trial_check_failed_at`) and nothing reads or
  writes them. A subscription in Stripe's `trialing` status (one made by hand in the Stripe dashboard) counts like an
  active one once it has a saved payment method (`src/stripe.ts` `cardOnFile`); a trial from before whose card failed
  the $1 check (`genclass_card_check=failed`) is never applied.

### How a paid plan is sold

None is sold today; this is how Individual was (2026-10-19 to 2026-10-22), and how the worker sells any plan
`billing/plans.json` prices above 0.

A flat monthly price paid up front on Stripe-hosted Checkout, for the account's own GenClass customer, with flexible
billing mode (`subscription_data[billing_mode][type]=flexible`) and a payment method always collected. Stripe's
implementation planner recommended this set-up for the account; the reasons and the documentation behind each point
are in "Stripe documentation notes" below.

**Standard Checkout, GenClass the seller.** Managed Payments takes only fully automated digital products, and
Individual is a person training a model for the buyer, so no plan uses it (`managed_payments` false; `MANAGED_PAYMENTS`
stays `"off"`). The worker keeps the Managed Payments path for a plan marked `managed_payments` (Pro was, until
2026-10-19): with `MANAGED_PAYMENTS = "on"` that plan's Checkout Session carries `managed_payments[enabled]=true`,
Stripe sells it through Link as the merchant of record (Link's Checkout page, receipts and statement name; Stripe
collects the tax, handles fraud and disputes and may refund within 60 days; 3.5% of each payment on top of Stripe's
fees), and nothing Managed Payments refuses is sent. Stripe Tax's threshold monitoring tells the owner when sales reach
a registration threshold. Individual's Checkout collects no tax (no `automatic_tax`); once the owner registers
somewhere, turning automatic tax on is a small change in `checkoutSession` (`src/stripe.ts`).

**Tax codes** (set on the products by `scripts/stripe-setup.mjs` from `billing/plans.json`):

| plan | code | why |
|---|---|---|
| Individual (retired 2026-10-22) | `txcd_10203001` Downloadable Software, custom, business use | Individual's deliverable is a model trained for one buyer that their runtime downloads; `txcd_20060000` Professional Services is the other candidate. Not eligible for Managed Payments. The owner's accountant has the last word |

**A plan is granted once Stripe has the money.** Stripe can make a subscription `active` while its first payment is
still processing (a bank debit can take days). So a subscription the account has not been granted yet counts only
when its latest invoice is paid, or asks for nothing; until then the webhook changes nothing. The endpoint takes
`invoice.paid` for this: when the payment clears, the worker reads the invoice's subscription id (nothing else of the
invoice, which carries the buyer's name, email and address), fetches the subscription again and grants the plan. A
purchase of a plan with a custom model (Individual) is recorded on that same event.

**Switching between paid plans** (no plan is sold today, so there is nothing to switch to; the code stays for a
second paid plan, and the tests run it on the fixture) is a new Checkout for the other plan, never a price change in the
portal: a Managed Payments subscription can only hold eligible products and only authorises Managed Payments to charge
the card, so it cannot take another plan's price (and Checkout is the one path either way). The billing page's Switch
button posts to `/api/billing/checkout`, which opens a Checkout whose subscription carries `genclass_switch_from=<the
current subscription>`. When the new subscription's first payment has cleared, the webhook:

1. writes the new plan to the account, so the account is never without one;
2. refunds the unused part of the old plan to the payment method that paid it: a refund on the payment intent (or
   charge) of the old subscription's latest paid invoice, of that invoice's total times the share of its paid period
   left (counted from the current hour). It is made once: the refund carries `genclass_refund=switch:<old
   subscription>` in its metadata and an idempotency key, and a retry finds it. No balance credit: a Managed Payments
   plan's invoices are issued through Link and the others' by GenClass, so a credit on the customer's balance could be
   stranded, or pay the other issuer's invoice;
3. cancels the old subscription at once, with no proration and no final invoice (Stripe's defaults);
4. tells the owner (`plan_switch`, with the refund, or why there was none: a refusal, such as a payment Stripe or Link
   support already refunded, is reported and not retried).

The account is billed for both only until step 3 (a failure answers 500 and Stripe's retry finishes the job). If the
new payment never clears (it fails, or the subscription expires unpaid), the old plan stays and nothing is refunded or
cancelled. Every refund of a GenClass customer's charge reaches the owner as `charge_refunded`, so a double refund
shows. An accidental second purchase that is not a switch (two tabs paid, an old Checkout page completed later) keeps
the higher plan (the one listed later in `billing/plans.json`, then the newest) and refunds the other's latest payment
in full, then cancels it; the owner gets `duplicate_subscription`. GenClass's portal configuration offers no plan
switch.

### Stripe documentation notes

Read on 2026-10-13 with Stripe's documentation tools (and stripe.com/pricing for the fee). Each point says what GenClass
does about it.

- **Turning it on.** Set `managed_payments[enabled]=true` when creating the Checkout Session, in `subscription` or
  `payment` mode; Managed Payments must be enabled in the dashboard (Settings, Managed Payments, after accepting its
  terms) and needs API version `2025-03-31.basil` or later.
  [update-checkout](https://docs.stripe.com/payments/managed-payments/update-checkout). The changelog lists the
  parameter under `2026-02-25.preview`
  ([changelog](https://docs.stripe.com/changelog/clover/2026-02-25/managed-payments)); the integration guide's
  `2025-03-31.basil` is what the integration guide asks for, but until a test-mode checkout of an eligible plan with
  `MANAGED_PAYMENTS = "on"` has gone through with the pinned `2025-06-30.basil` (and `billing_mode` flexible beside
  it), the var stays `"off"` (a refusal would show as "Stripe: ..." on the billing page).
- **Not allowed with it (subscription mode):** `adaptive_pricing`, `automatic_tax`, `tax_id_collection`,
  `subscription_data.default_tax_rates`, `payment_method_configuration`, `payment_method_types`,
  `customer_update[name]`, `customer_update[address]`, `shipping_address_collection`, `shipping_options`,
  `subscription_data.application_fee_percent`, `.on_behalf_of`, `.transfer_data`, `subscription_data.invoice_settings`,
  `invoice_creation`. An existing `customer` is allowed and gets the name and billing address from Checkout.
  [update-checkout](https://docs.stripe.com/payments/managed-payments/update-checkout). GenClass sends none of the
  refused ones; `customer_creation` and `customer_email` are not sent either (`customer_creation` exists only in
  `payment` and `setup` mode: [API reference](https://docs.stripe.com/api/checkout/sessions/create)).
- **Which subscriptions.** Only new subscriptions bought through a Managed Payments Checkout Session; existing ones are
  not eligible ([update-checkout](https://docs.stripe.com/payments/managed-payments/update-checkout)), and creating a
  subscription outside Checkout or Payment Links is not supported
  ([overview](https://docs.stripe.com/payments/managed-payments)). Subscription items added later must be of eligible
  product categories ([changelog, 2026-04-22](https://docs.stripe.com/payments/managed-payments/changelog)), and a
  Managed Payments purchase authorises only Managed Payments to charge the payment method
  ([update-checkout](https://docs.stripe.com/payments/managed-payments/update-checkout), "Customer authorization").
  Hence the switch by new Checkout above.
- **Eligible products.** Fully automated digital products sold directly, with an eligible product tax code;
  professional services and services with human involvement are not
  ([eligibility](https://docs.stripe.com/payments/managed-payments/eligibility), which lists `txcd_10103001` among
  the eligible codes; Canada is a supported business location). Individual stays on standard Checkout.
- **Changing and cancelling.** Buyers manage Managed Payments orders on link.com (cancel or update subscriptions,
  payment methods, billing address); the Customer Portal can be offered too; `subscription.default_payment_method`
  cannot be changed through the API for these subscriptions, only by the buyer in the portal
  ([how it works](https://docs.stripe.com/payments/managed-payments/how-it-works)). GenClass's portal keeps card,
  invoices, email, tax id and cancel at period end. Cancelling with `prorate` and `invoice_now` would put the credit
  for unused time on the customer's balance for future invoices; both default to false
  ([cancel](https://docs.stripe.com/billing/subscriptions/cancel)), and GenClass sends neither: it refunds the unused
  time to the card instead (a refund can be partial and goes to the payment method charged:
  [refunds](https://docs.stripe.com/api/refunds/create); an invoice's payment intent comes from
  [invoice payments](https://docs.stripe.com/api/invoice-payment/list) in API `2025-03-31.basil` and later).
- **Events.** No event types of its own for subscriptions: the usual `customer.subscription.*` (and
  `checkout.session.*`) events ([set-up](https://docs.stripe.com/payments/managed-payments/set-up)); the Subscription
  object gains a `managed_payments` field
  ([changelog](https://docs.stripe.com/changelog/clover/2026-02-25/managed-payments)). A subscription can be `active`
  while its first payment is still processing, so the plan waits for `invoice.paid`
  ([subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks)). A buyer's data deletion request cancels their Managed Payments subscriptions and erases their data from the
  customer ([how it works](https://docs.stripe.com/payments/managed-payments/how-it-works)): the webhook accepts the end
  of the subscription recorded for an account even when the customer's metadata is gone, since ending a plan only takes
  entitlements away.
- **What the buyer sees.** Link as merchant of record, receipts and invoices from Link, statements reading
  `LINK.COM* <descriptor>`, Link support, refunds by Stripe within 60 days in some cases, refunds without approval
  after 48 hours without an answer, disputes handled by Stripe
  ([how it works](https://docs.stripe.com/payments/managed-payments/how-it-works)).
- **Fee.** "3.5% per successful Managed Payments transaction in addition to Payments fees"
  ([pricing](https://stripe.com/pricing)).
- **Flexible billing mode.** `subscription_data.billing_mode[type]=flexible` on a Checkout Session; it needs API
  version `2025-06-30.basil` or later, and before `2025-09-30.clover` the default is `classic`
  ([billing mode](https://docs.stripe.com/billing/subscriptions/billing-mode)). It is not on Managed Payments' list of
  refused parameters, so every plan uses it, and the worker's pinned version moved from `2025-03-31.basil` to
  `2025-06-30.basil`: monthly releases within a major release add no breaking changes
  ([versioning](https://docs.stripe.com/api-versions)). With flexible mode a cancellation at period end sets `cancel_at`
  rather than `cancel_at_period_end` ([compare](https://docs.stripe.com/billing/subscriptions/billing-mode/compare));
  the worker reads both.
- **Tax for Individual.** Stripe Tax threshold monitoring ([monitoring](https://docs.stripe.com/tax/monitoring)); the codes
  are in the [tax code list](https://docs.stripe.com/tax/tax-codes).

### Routes

| route | behaviour |
|---|---|
| `POST /api/billing/checkout` | `{ plan: "<id>" }` (a plan priced above 0; none today, so a 400 naming the contact address; Enterprise has no Checkout), browser session and our `Origin` (403 otherwise, also for a CLI token). Creates the account's own Stripe customer once (email, description `GenClass account`, metadata `genclass=1` and `genclass_account`); never looks one up by email. A stored customer is checked first (`GET /v1/customers/<id>`): its metadata must name the account, and every subscription on it must be GenClass's, else 409 with the contact address, nothing opened, and a `shared_customer` notice ("Stripe object ownership" below). Then it asks Stripe, not the database, whether that customer already has a GenClass subscription: one on this plan is a 409, one whose last payment failed (`past_due`, `unpaid`) is a 409 pointing to Manage billing, two at once (a switch still going through) or a paused one is a 409, and an active one on another paid plan is a switch: after the same invoice check as Manage billing, `{ url, switch: true }` of a Checkout for the new plan whose session and subscription carry `genclass_switch_from=<the current subscription>` (success URL `...?done=1&to=<plan>`). Otherwise `{ url }` of a Checkout Session in subscription mode for that customer and the plan's lookup key (metadata `genclass=1`, `genclass_account`, `genclass_plan`; the subscription gets `genclass` and `genclass_account` and flexible billing mode; `client_reference_id` = account id; success `https://genclass.dev/account/billing?done=1`), with `managed_payments[enabled]=true` for a plan marked `managed_payments` (none today) when `MANAGED_PAYMENTS` is `on`. GenClass's open Checkout page of the account for the same plan (and the same switch) is reused, its other open pages are closed first, and any other open page is left alone. 503 unless the account can buy (above). |
| `POST /api/billing/portal` | browser session and `Origin`; `{ url }` of a Billing Portal session (cancel at period end, card, email and tax id, invoices; no plan switch, which is a new Checkout) on GenClass's own portal configuration: the one whose id `STRIPE_PORTAL_CONFIGURATION` (live) or `STRIPE_PORTAL_CONFIGURATION_TEST` (test) names, fetched by that id and checked (metadata `genclass=1`, active, not the default; cached 10 minutes), never the account's default one: without it, 503 ("run scripts/stripe-setup.mjs"). The portal acts on everything on the customer, so first the customer must be the account's (metadata), every subscription on it GenClass's, and each of its latest 100 invoices for a GenClass subscription; otherwise 409 with the contact address, no session, and a `shared_customer` notice. 409 before a first purchase, and when Stripe no longer has the customer (the stored ids are then cleared). |
| `POST /api/billing/webhook` | Stripe only. The raw body must carry a valid `Stripe-Signature` (HMAC-SHA256 of `t.body`, any `v1`, within 5 minutes) under `STRIPE_WEBHOOK_SECRET` with a live key or `STRIPE_WEBHOOK_SECRET_TEST` with a test key; else 400. An event signed with the other mode's secret, or whose `livemode` is not the key's mode, is answered 200 and ignored (a test endpoint left over after going live). Handles `customer.subscription.created`, `.updated` and `.deleted`, `invoice.paid`, `charge.refunded` and `charge.dispute.created`, and subscribes to nothing else: they arrive for the whole Stripe account, so first, with no Stripe call, the customer must be in `accounts.stripe_customer_id`, and the subscription must look like GenClass's (the one recorded for the account, metadata `genclass=1` on it or copied onto the invoice, or a `genclass_` lookup key on a price). From an invoice only its subscription id is read; a refund or dispute of a GenClass customer's charge sends the owner `charge_refunded` or `charge_disputed` (ids and amounts; a dispute names no customer, so its charge is read first). Then it fetches the subscription (its prices' products, its customer and its latest invoice expanded), which must be provably GenClass's (every price a `genclass_` lookup key on a `genclass_plan` product, or the subscription already recorded for the account) and the account's (its customer's `genclass_account` names the account), and writes the plan, status, `past_due_since`, period end (when it ended, for one cancelled at once), cancel flag and mode. A subscription the account has not been granted yet is written only once its latest invoice is paid (or asks for nothing), never on `active` alone; another subscription than the account's current one never overwrites a live plan unless it was chosen as below. When a subscription starts billing (`created`, `updated` with a status change, or `invoice.paid`), if the customer has two GenClass subscriptions that bill and are paid for (a switch, or two tabs paid), the account keeps one (a switch's new plan; otherwise a live one, then the plan listed later in `billing/plans.json`, then the newest): it is written to the account first, then each other one is refunded to its payment method (a switch's old plan: its unused time; a duplicate: its latest payment in full; once, by the metadata `genclass_refund`) and cancelled at once with no proration, and `NOTIFY_WEBHOOK` gets `plan_switch` or `duplicate_subscription` with the refunds. A new subscription that is never paid (`incomplete`, `incomplete_expired`, or `active` with its invoice unpaid) changes nothing. The end of the subscription recorded for the account is applied even when its customer's metadata is gone (Stripe erasing a buyer's data on request). A purchase of a plan with `custom_model` (Individual) is recorded (`custom_requests`, `NOTIFY_WEBHOOK`, naming the plan) only when Stripe reports that plan's price paid: the subscription's latest invoice is paid and has a positive line on it (a first invoice, a switch included, seen on `invoice.paid` or the subscription's own events). Every other event (another business's subscriptions, in a shared account) is answered 200, logged as `stripe webhook: <type> <id> ignored: <reason>`, not stored, and nothing about it is fetched. The ids of events about GenClass customers are kept 30 days (`billing_events`), so a redelivery changes nothing; a failure answers 500 and Stripe retries. |
| `GET /api/billing` | browser session: `{ plan, subscription_status, current_period_end, cancel_at_period_end, on_sale, access }` (`on_sale`: a plan is sold and this account can buy it; false today); `access` is `paid`, `comp` (GenClass's grant) or null (Free) |
| `POST /api/billing/trial` | 410: GenClass has no trial any more ([Grants and no trial](#grants-enterprise-and-no-trial)) |
| `GET /account/trial` | `/account`, through `/signup` when signed out (genclass.dev's pricing page linked here until 2026-10-19) |
| `GET /account/billing` | the plan, its renewal or end date, the plans side by side (Free and Enterprise today), Upgrade (and Switch, with two paid plans) buttons and Manage billing (only to an account that can buy), Talk to us (a mailto link) for Enterprise, and which plan is sold through Link (Managed Payments; none today). With no plan sold it shows no Upgrade button, no "billed monthly" and no Stripe footer. `?plan=<id>` (a pricing page button) survives the sign-in redirect and highlights and focuses that plan's button. Back from Checkout (`?done=1`) while the plan still reads Free, or back from a switch (`?done=1&to=<plan>`) while the plan is still the old one, it shows no buttons and waits for the webhook. |
| `GET /api/account/projects/<id>/integrations` | browser session: the app's forwarding destinations, masked |
| `PUT /api/account/projects/<id>/integrations/<kind>` | browser session and `Origin`, a plan with forwarding (every plan), `INTEGRATIONS_KEY` set (503 otherwise). `kind` is `sentry` `{dsn}` (a `sentry.io` host), `posthog` `{key, host}`, `datadog` `{api_key, site}`, `slack` `{url}` or `webhook` `{url}` (https, public host name, default port, not genclass.dev or workers.dev); a new webhook gets a signing secret, returned once as `secret` |
| `PATCH`, `DELETE` same path; `POST .../<kind>/test` | turn a destination on or off (`{enabled}`), remove it, or send it one test record (502 with the reason when it fails). A test record counts against the app's 60 records an hour (429 when they are used up) |
| `GET /api/account/projects/<id>/events?from&to&format&limit&cursor` | export (every plan): an export key (`Authorization: Bearer gce_...`) or the browser session; a CLI token is refused. `from`/`to` take a date or an ISO time (default the last 7 days; `from` is moved up to the plan's history), `format` `jsonl` (default) or `csv`, `limit` 1 to 200 batches. The next page's cursor is in `x-genclass-next-cursor` and `Link: rel="next"`. 120 pages a minute per account (`EXPORT_LIMIT`; 429 with `retry-after: 60`) |
| `GET`, `POST /api/account/export-keys`; `DELETE .../<id>` | browser session: list, create (a plan with export, at most 10; the key is shown once, only its SHA-256 is stored) and revoke export keys |

Checkout, the portal, Send test and new export keys share `AUTH_LIMIT`'s 20 a minute per account and route (keyed by a
hash of the route and the account id), so one account cannot use up GenClass's Stripe API budget or post through Send
test at request rate.

### Migrations 0004 and 0005 (`migrations/0004_billing.sql`, `migrations/0005_billing_past_due.sql`)

Additive. `accounts` gains `plan` (default `'free'`), `stripe_customer_id`, `subscription_id`, `subscription_status`,
`current_period_end`, `cancel_at_period_end` and `stripe_mode`. New tables: `billing_events` (ids of the Stripe events handled for GenClass customers),
`custom_requests` (one row per paid subscription of a plan with a custom model, Individual (Custom before 2026-10-19), with its mode: the owner starts the training work from it),
`integrations` (forwarding destinations, AES-GCM ciphertext only), `forward_log` (dedupe and the hourly cap, kept 2
hours), `event_batches` (which stored batch belongs to which app in an account, for the export) and `export_keys` (hashes only).
0005 adds `accounts.past_due_since`: when GenClass first saw the subscription `past_due` (NULL in any other status).
The webhook, and the daily sweep for accounts no event arrives for, put an account on Free once that is more than 14
days ago, or when the subscription is `unpaid`.

### Stripe object ownership

The worker and the setup script change nothing in Stripe that is not GenClass's, read no more than they have to, and
act on nothing else, in live and test mode. The rules hold on any Stripe account, as a defence in depth against
objects made by hand in the dashboard or a customer mixed up with something else.

What GenClass creates in the account, in each mode, and nothing else:

| object | how GenClass recognises it | made by |
|---|---|---|
| a product per plan priced above 0 (none today). From plans GenClass no longer sells (`billing/plans.json` `retired_plans`): GenClass Individual (id `genclass_individual`, sold until 2026-10-22; archive it), and GenClass Pro and GenClass Custom (`genclass_pro`, `genclass_custom`, before 2026-10-19, test mode only). The script leaves them alone; the worker still counts their subscriptions as GenClass's (cancelled with the account, Manage billing opens) but gives them no plan | metadata `genclass_plan` (the plan id) and `genclass=1`; statement descriptor `GENCLASS`; tax code `txcd_10203001` | `scripts/stripe-setup.mjs` |
| its price (none today; `genclass_individual_monthly`, US$29 a month, until 2026-10-22); after a price change, the archived old price keeps `genclass_<plan>_monthly_retired_<price id>` | a lookup key starting with `genclass_`, on a product with `genclass_plan`; metadata `genclass=1`, `genclass_plan` | the script |
| 1 webhook endpoint, `https://genclass.dev/api/billing/webhook` | that URL and the description `GenClass billing` (metadata `genclass=1`); only `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `charge.refunded`, `charge.dispute.created` | the script |
| 1 Billing Portal configuration | metadata `genclass=1`; never the default; headline "Manage your GenClass plan"; no plan switch; its id in `STRIPE_PORTAL_CONFIGURATION` (live) or `STRIPE_PORTAL_CONFIGURATION_TEST` | the script |
| customers, one per GenClass account that buys | description `GenClass account`, metadata `genclass=1` and `genclass_account=<account id>`; the id in `accounts.stripe_customer_id`, which nothing else writes | the worker (checkout) |
| Checkout Sessions, Billing Portal sessions | Checkout: subscription mode, a GenClass customer, metadata `genclass=1`, `genclass_account`, `genclass_plan` (and `genclass_switch_from` for a switch); portal: GenClass's configuration | the worker |
| subscriptions, and their invoices, payments and charges | subscriptions: metadata `genclass=1`, `genclass_account`, GenClass prices, a GenClass customer; the rest: that customer | Stripe, from GenClass's Checkout and portal |

What reaches GenClass, and what it reads:

- The webhook endpoint subscribes to `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`,
  `charge.refunded` and `charge.dispute.created` only, and Stripe sends them for the whole account, so another
  business's events of those types arrive too. A subscription carries ids, its status, dates and amounts, and whatever
  description and metadata its business sets; an invoice, charge or dispute also carries the buyer's name, email or
  address. The worker parses the event, looks the customer id up in `accounts.stripe_customer_id`, and drops it: no
  Stripe call (except a dispute's charge, read for its customer id alone, since a dispute names none), nothing stored,
  one log line with the event type and id (worker logs are not kept: observability is off, so only a live
  `wrangler tail` shows them). Of GenClass's own invoices, charges and disputes it reads ids and amounts only.
  GenClass takes no Checkout or customer event.
- The worker reads from Stripe: its prices by `genclass_` lookup key; its portal configuration by id; and, for a
  customer in `accounts.stripe_customer_id` only, that customer, its subscriptions, its open Checkout pages, its
  latest 100 invoices (before a portal session) and a subscription it got an event for that looks like GenClass's,
  with the subscription's latest invoice. If another business's objects were put on a GenClass customer, the customer's
  subscription and invoice lists show them when the buyer opens checkout or Manage billing; the worker then opens
  nothing (below). Their own events are not fetched or stored.
- The setup script reads products by id (or a search on `metadata['genclass_plan']`), prices by `genclass_` lookup
  key, the list of webhook endpoints and the list of non-default portal configurations (Stripe has no search for
  either; it uses only its own, and changes no other). It lists no customers, products or prices.

What GenClass never does there:

- List products or prices. The script edits or archives only GenClass's own products and prices, and stops, changing
  nothing, at a product with a GenClass id but no `genclass_plan`, or a GenClass lookup key on another product's
  price. The worker sells a price only when its product is GenClass's (otherwise checkout answers 503).
- Look up or reuse a customer by email, or start a Checkout with `customer_email`. Each GenClass customer is new, with
  the buyer's email (Stripe sends the receipts there).
- Open a Stripe page for, or start a Checkout on, a customer that is not provably its own, or that holds anything
  else. Before a Billing Portal session (Manage billing) or a switch's Checkout the stored customer must have
  metadata `genclass=1` and `genclass_account` naming the account, every subscription on it (any status) must be
  GenClass's, and each of its latest 100 invoices must be for one of them; checkout checks the customer and its
  subscriptions. Otherwise the route answers 409 with the contact address, opens nothing, and `NOTIFY_WEBHOOK` gets a
  `shared_customer` notice with the account and customer ids. The portal would otherwise let the buyer cancel the
  other subscription, change the card that pays it, and read its invoices under GenClass's headline. The portal
  configuration lets a buyer change only the email and tax id of their GenClass customer, never an address.
- Put money on a customer's balance (which pays that customer's next invoice, whoever sends it). A switch's old plan
  and a duplicate subscription are refunded to the payment method that paid them, and cancelled with no proration.
- Act on another Checkout Session, subscription or invoice. The webhook checks the event's customer against GenClass's
  database before any Stripe call. Account deletion cancels only GenClass subscriptions that Stripe lists on the
  account's checked GenClass customer, never a subscription by its recorded id alone; if the stored customer is not
  GenClass's while a plan is recorded, deletion stops with a 409 and the contact address. Only GenClass's own open
  Checkout pages are closed.
- Edit or delete another webhook endpoint. The script finds its own by exact URL and description, and stops if any
  other endpoint uses GenClass's URL. `--new-webhook` deletes only GenClass's endpoint.
- Read or change the account's default portal configuration. The worker fetches only the
  configuration its setting names, and refuses it (503) unless it carries `genclass=1`, is active and is not the
  default; it never falls back to the default. The script never makes its configuration the default.
- Change an account-wide setting.

Database check before the first Stripe key: Rows written by the code before these checks (which took a customer from any Checkout's
   `client_reference_id`), or for another Stripe account, could name a customer that is not GenClass's. Nothing was
   ever on sale, so before the worker gets its first Stripe key of GenClass's account
   `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT COUNT(*) AS n FROM accounts WHERE stripe_customer_id IS NOT NULL OR subscription_id IS NOT NULL"`
   must print 0. If not, clear those ids first (still before any key):
   `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET plan = 'free', stripe_customer_id = NULL, subscription_id = NULL, subscription_status = NULL, past_due_since = NULL, current_period_end = NULL, cancel_at_period_end = 0, stripe_mode = NULL"`.

### Forwarding

After a batch from an app in an account whose plan includes forwarding (every plan), each new likely detection (`detect` without
`tier: "possible"`) goes to every enabled destination of that app: the diagnosis, confidence, trigger, page route,
runtime and model versions, the time and a link to the app's dashboard. Never page text. Sentry gets an event through
the envelope endpoint of the DSN, PostHog a `genclass detection` capture (no person profiles), Datadog a log through
`http-intake.logs.<site>/api/v2/logs`, Slack one message, a webhook a JSON POST with
`x-genclass-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. The same diagnosis on the same route is sent once
per UTC hour, at most 60 records per app per hour (test records included) and 20 per batch. It all runs in
`waitUntil`; a failure is written to the destination's `last_error` and the collector still answers 202. Settings are
encrypted with `INTEGRATIONS_KEY` (AES-GCM, the app id and kind as additional data); without that secret nothing can be
saved or sent.

### Export

Every batch from an app whose account's plan includes export gets an `event_batches` row (Free apps and apps known
only by a private link get none, so they cost no D1 row), and is written to `export/<token>/dt=<day>/<uuid>.jsonl.gz`;
the row points there. That prefix needs its own R2 lifecycle rule of 366 days (owner step 2 below), since `events/`
expires after 90 days. The export streams the stored lines of the app's batches (each line is checked against the
app's token), so it covers the batches received while the account's plan included export (every plan since 2026-10-19; Pro and
Custom before). The daily sweep deletes the export copies of apps no longer on a plan with more history once they pass 90 days, and every copy past the longest plan's history,
in rounds of 1,000 keys (40 rounds a pass), and any index row older than 367 days in one statement (R2's rule has
removed its object by then).

### Settings

| name | kind | what |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | `sk_live_...`: paid plans on sale. `sk_test_...`: only `STRIPE_TEST_ACCOUNTS` can buy. Without it the buttons are hidden and checkout answers 503; the Free plan applies with or without it |
| `STRIPE_WEBHOOK_SECRET` | secret | the live webhook endpoint's signing secret (`whsec_...`); `scripts/stripe-setup.mjs` with a live key stores it |
| `STRIPE_WEBHOOK_SECRET_TEST` | secret | the test endpoint's signing secret; the script with a test key stores it, so a test run never replaces the live one |
| `STRIPE_PORTAL_CONFIGURATION` | secret (an id, not secret) | GenClass's live Billing Portal configuration (`bpc_...`); the script with a live key stores it. The portal answers 503 without it, or when it does not name a configuration with metadata `genclass=1` that is active and not the default |
| `STRIPE_PORTAL_CONFIGURATION_TEST` | secret (an id) | the same for test mode; the script with a test key stores it |
| `STRIPE_TEST_ACCOUNTS` | secret | emails or account ids, comma-separated, that can buy while the key is a test key |
| `MANAGED_PAYMENTS` | var (`wrangler.toml`) | `"off"` there, and unset counts as off: every plan is sold on standard Checkout. `"on"` (or `true`, `1`, `yes`): the Checkout of a plan marked `managed_payments` in `billing/plans.json` uses Stripe Managed Payments (none is today) |
| `INTEGRATIONS_KEY` | secret | 32 random bytes, base64; encrypts forwarding settings. Set it once: another key makes saved settings unreadable (owners then save them again) |
| `NOTIFY_WEBHOOK` | secret, optional | an https URL that gets `{ text, content, event, mode, at, ... }`: `custom_purchase` (`request_id`, `account_id`, `subscription_id`) when a paid plan with a custom model is paid (Individual until 2026-10-22), `plan_switch` after every switch and `duplicate_subscription` after an accidental second purchase (`kept`, `cancelled`, and `refunds`: each with the refund id and amount, or a `note` saying why nothing was refunded), `charge_refunded` and `charge_disputed` (`charge`, `dispute`, `amount`, `currency`) for a GenClass customer's charge, `shared_customer` (`account_id`, `customer`) when checkout or Manage billing found something that is not GenClass's on the account's Stripe customer and opened nothing, `retired_plan_billing` (`account_id`, `subscription_id`, `lookup_key`) each time a payment of a subscription to a plan GenClass no longer sells clears (`invoice.paid`; the account reads as Free: cancel and refund it). Ids only: the buyer's email stays in `custom_requests`. `text` suits Slack, `content` Discord; test-mode notices start with `[Stripe test mode, no real money]` |
| `EXPORT_LIMIT` | rate limit binding | export pages per account per minute (120) |

An Individual buyer's email, for the notice above:
`npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT email, created, mode FROM custom_requests WHERE id = '<request_id>'"`.

### Owner steps, in order

No plan is sold on the site today, so none of this is needed to run GenClass; the steps were for Individual and apply
again to any plan `billing/plans.json` prices above 0 (where they name Individual, read that plan). Retiring
Individual, in order:

1. Deploy the worker (`npx --yes wrangler@4 deploy`), then bump genclass-site's `lib/` submodule to the same commit and
   deploy the site, so the pricing page stops offering Individual (its button linked `/account/billing?plan=individual`,
   which now shows Free and Enterprise only). Drop any Individual mention in the site's own copy (pricing, terms,
   privacy).
2. In the Stripe dashboard (live, and test if used): expire any open Checkout Session for Individual (Payments,
   Checkout sessions; they expire by themselves after 24 hours), archive the `genclass_individual` product and its
   price, and cancel and refund every Individual subscription (filter Subscriptions by the product; a
   `retired_plan_billing` notice also names one each time a payment of it clears). The worker keeps counting them as GenClass's, so their accounts can still cancel in Manage billing and a
   deleted account's subscription is cancelled.

For GenClass's own Stripe account ("GenClass"), dashboard first, in test mode and then live (each setting below has a
test-mode and a live copy unless the dashboard says it is shared):

1. **Activate the account** (Settings, Business): business details, the bank account for payouts, the public business
   name (GenClass) and statement descriptor (GENCLASS), and the support email and phone. Managed Payments sends its
   escalations to that support email; answer within 48 hours, or Stripe may refund the buyer without asking.
2. **Checkout settings** (Settings, Checkout): optionally add GenClass's terms (`https://genclass.dev/terms`) and
   privacy policy (`https://genclass.dev/privacy`). Managed Payments is not needed: no plan uses it.
3. **Revenue recovery** (Billing, Revenue recovery): Smart Retries on; failed-payment emails on (and the expiring-card
   ones); when all retries for a payment fail, **cancel the subscription**. The worker's 14-day past-due limit stays
   as a backstop.
4. **Receipts** (Settings, Customer emails): successful payments on, refunds on.
5. **Branding** (Settings, Branding): icon, logo, colours, for Checkout, the customer portal, receipts and invoices.
6. **Stripe Tax** (Settings, Tax): the head office address. Turn on threshold monitoring (Tax, Registrations) so the
   owner hears when Individual's sales, which GenClass sells itself, reach a registration threshold. No registration
   and no automatic tax are needed to start.
7. In `telemetry-worker/`: `npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote`, then the export
   copies' lifecycle rule:
   `npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-export-366d export/ --expire-days 366`.
8. `openssl rand -base64 32 | npx --yes wrangler@4 secret put INTEGRATIONS_KEY` (once), and optionally
   `npx --yes wrangler@4 secret put NOTIFY_WEBHOOK` (a Slack or Discord incoming webhook URL for Individual purchases and
   billing notices, since worker logs are not kept).
9. `npx --yes wrangler@4 deploy`. Nothing is on sale yet; the dashboard is free for everyone already.
10. Before any Stripe key: the database check ("Stripe object ownership") must print 0.
11. **Test mode**, on the production worker: `npx --yes wrangler@4 secret put STRIPE_TEST_ACCOUNTS` with your own
    account's email, then from the repo root `STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs` (signed in
    to wrangler; a test key of GenClass's account; `--dry-run` first, which only reads and says what it would do). It
    creates GenClass Individual with its tax code and monthly price, the test webhook endpoint
    `https://genclass.dev/api/billing/webhook` "GenClass billing" (its secret goes straight into
    `STRIPE_WEBHOOK_SECRET_TEST`, never printed) and GenClass's own Billing Portal configuration (no plan switch; its id
    goes into `STRIPE_PORTAL_CONFIGURATION_TEST`). Running it again changes only what differs. Then
    `npx --yes wrangler@4 secret put STRIPE_SECRET_KEY` with the test key. Only your account can buy.
12. **The test card**: on `https://genclass.dev/account/billing` (only `STRIPE_TEST_ACCOUNTS` can buy while the key
    is a test key) choose Upgrade to Individual and pay with `4242 4242 4242 4242`, any future expiry date and any CVC.
    Confirm that Stripe accepted the Checkout Session with `subscription_data[billing_mode][type]=flexible` and
    `payment_method_collection=always` (Developers, Logs: the `POST /v1/checkout/sessions` request answered 200, and
    the subscription shows billing mode flexible). The page shows Individual within a minute, and a `custom_requests`
    row with mode `test` and a test-mode `custom_purchase` notice appear. Then Manage billing (card, invoices) and
    cancel. Developers, Webhooks shows no failed deliveries. Enterprise shows Talk to us, a mailto link, and no
    Checkout.
13. Before going live, clear the test records (once the key is live they no longer count, but this keeps the tables
    clean):
    `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET plan = 'free', stripe_customer_id = NULL, subscription_id = NULL, subscription_status = NULL, past_due_since = NULL, current_period_end = NULL, cancel_at_period_end = 0, stripe_mode = NULL WHERE stripe_mode = 'test'; DELETE FROM custom_requests WHERE mode = 'test';"`
14. **Live**: steps 2 to 6 in live mode if the dashboard keeps them per mode, then
    `STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs` (`--dry-run` first; live products, prices, webhook
    endpoint and `STRIPE_WEBHOOK_SECRET`, portal configuration and `STRIPE_PORTAL_CONFIGURATION`), then
    `npx --yes wrangler@4 secret put STRIPE_SECRET_KEY` with the live key. Individual is on sale. Optionally remove `STRIPE_TEST_ACCOUNTS` (`npx --yes wrangler@4 secret delete STRIPE_TEST_ACCOUNTS`);
    events from the test endpoint are answered 200 and ignored, or delete GenClass's endpoint ("GenClass billing") in
    Stripe's test mode.

## Self-host the collector (private mode)

Telemetry sent to genclass.dev passes through GenClass: the maintainers can read every batch (README of the runtime,
TELEMETRY.md). An app that wants its diagnostics and dashboards to stay with it runs this same worker on its own
Cloudflare account instead. Nothing then reaches GenClass: pages send to the app's own collector, which keeps the
batches in the app's own R2 bucket and the dashboards in its own D1 database. Every plan's features work there
(without a Stripe key every account is on Free: the dashboard, export and forwarding, 90 days of history).

[`wrangler.selfhost.toml`](wrangler.selfhost.toml) is the configuration for it: no genclass.dev routes, no site
binding, and the worker's own origin for dashboard links, cookies and passkeys. From `telemetry-worker/`, on any
Cloudflare account (the free Workers plan is enough to start; R2 and D1 have free tiers):

```sh
npx --yes wrangler@4 login
npx --yes wrangler@4 r2 bucket create genclass-telemetry
npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-events-90d events/ --expire-days 90
npx --yes wrangler@4 d1 create genclass-dashboard        # paste the database_id into wrangler.selfhost.toml
# set AUTH_ORIGIN, AUTH_RP_ID and DASHBOARD_ORIGIN in wrangler.selfhost.toml to the worker's URL
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote -c wrangler.selfhost.toml
npx --yes wrangler@4 deploy -c wrangler.selfhost.toml
curl https://genclass-collector.<your-subdomain>.workers.dev/v1/health
```

Then open `https://<your worker>/start`: it gives an app a token and a private dashboard link, and its snippets
already send to your worker. A collector whose origin is not genclass.dev names its own endpoint in every snippet it
shows (`src/pages.ts` ownEndpoint), through `GenClass.init` or `window.GENCLASS_CONFIG` (a meta tag may only name
same-origin URLs), and leaves out `npx @genclass/runtime init` and `login`, which make their token at genclass.dev. In
an app wired by hand:

```ts
GenClass.init({ token: "gc_...", telemetry: { endpoint: "https://<your worker>/v1/events" } });
```

```html
<script>window.GENCLASS_CONFIG = { telemetry: { endpoint: "https://<your worker>/v1/events" } };</script>
<script src="https://cdn.jsdelivr.net/npm/@genclass/runtime@beta" data-token="gc_..."></script>
```

Accounts work on it as on genclass.dev (an email and a password, and passkeys; Google and GitHub with your own OAuth
clients, "Google sign-in" and "GitHub sign-in" above), and so do export and forwarding (`INTEGRATIONS_KEY`, "Owner
steps"). Updating is a `git pull` and the same `deploy` (new migrations first). `test/selfhost.test.ts` keeps the
configuration in step with `wrangler.toml` and the snippets pointed at the collector itself.

## Develop / deploy

```sh
cd telemetry-worker
../node_modules/.bin/vitest run --root .                              # unit tests (Node 22.5+ for node:sqlite)
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote  # new migrations first
npx --yes wrangler@4 deploy                                           # worker, routes, cron (wrangler login to the account above)
curl https://genclass-telemetry.mehar-144.workers.dev/v1/health
```

Local:

```sh
cd telemetry-worker
cp .dev.vars.example .dev.vars                                         # AUTH_ORIGIN, AUTH_RP_ID, DASHBOARD_ORIGIN for localhost
npx --yes wrangler@4 d1 migrations apply genclass-dashboard --local
npx --yes wrangler@4 dev --local --local-upstream localhost:8787
```

then open `http://localhost:8787/start` or `http://localhost:8787/signup`. `--local-upstream localhost:8787` matters:
without it wrangler rewrites each request's URL and `Origin` header to the first zone route (`http://genclass.dev`),
so every account write fails the Origin check with 403. `.dev.vars` (git-ignored) sets `AUTH_ORIGIN=http://localhost:8787`
and `AUTH_RP_ID=localhost`: passkeys work on `http://localhost` (browsers treat it as a secure context), and session
cookies drop `Secure` only on a plain-HTTP localhost origin. Google and GitHub need their own development OAuth
clients there (callback `http://localhost:8787/auth/<provider>/callback`); without them only passkeys are offered.

The CLI talks to this local worker with `GENCLASS_HOST=http://localhost:8787` (exactly `AUTH_ORIGIN`: the CLI only
opens a sign-in link and only shows a dashboard link that is on the host it talks to), for example
`GENCLASS_HOST=http://localhost:8787 node packages/runtime/bin/genclass-runtime.mjs login --no-browser`, then open
the printed link, sign up with a passkey and approve the code. The credentials file holds one session, marked with
its host, so this replaces a genclass.dev session saved on the same machine (sign out of that first, or set
`XDG_CONFIG_HOME` to a scratch directory for the local run); `logout` with the same `GENCLASS_HOST` ends it.

There is no `wrangler r2 object list`; list keys with the Cloudflare API
(`GET /client/v4/accounts/<id>/r2/buckets/genclass-telemetry/objects?prefix=events/`) or the dashboard, then
`npx --yes wrangler@4 r2 object get "genclass-telemetry/<key>" --remote --file out.gz`.

### Delete a project

With the token (`gc_...`), or find it by name with
`npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT token, name, created FROM projects WHERE name = 'My app'"`:

```sh
T=gc_XXXXXXXXXXXXXXXXXXXXXX
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  DELETE FROM daily WHERE token = '$T'; DELETE FROM hourly WHERE token = '$T';
  DELETE FROM recent WHERE token = '$T'; DELETE FROM sessions WHERE token = '$T';
  DELETE FROM integrations WHERE project_id = (SELECT id FROM projects WHERE token = '$T');
  DELETE FROM event_batches WHERE token = '$T';
  DELETE FROM projects WHERE token = '$T';"
```

The dashboard link then returns 404 and later batches with that token are stored in R2 only (the in-memory token cache
may keep aggregating for up to 5 minutes). Raw R2 objects under `events/` expire after 90 days; an app on a paid plan
also has copies under `export/<token>/`, deleted with
`npx --yes wrangler@4 r2 object delete "genclass-telemetry/<key>" --remote` for each key the Cloudflare API lists under
that prefix.

### Test data and live checks

Every batch sent to the deployed worker lands in the same R2 bucket and D1 database as real data, and real data is
what the model is evaluated and trained on. A check against production therefore:

- sends session events whose `host` ends in `.invalid` (reserved, RFC 6761), such as `livecheck.invalid`. The admin
  dashboard (`site/src/admin.js`, `TEST_HOST`) already counts `*.invalid`, `localhost`, `*.local`, `*.test` and private
  addresses as test traffic and leaves them out of its numbers unless `?test=1`;
- sets the envelope's `runtime` to `0.0.0-check`, never a released version, so its R2 objects land under
  `events/dt=<day>/rt=0.0.0-check/...`, apart from real data (any training or evaluation pull skips `rt=0.0.0-*`
  and the `TEST_HOST` hosts);
- names a project it creates `... (throwaway, delete me)`, deletes it right after (above), and is listed below until
  it is gone.

Synthetic data still in production:

| when (UTC) | what | where | to delete |
|---|---|---|---|
| 2026-10-13, 05:55 to 05:56 | the `wave1/projects` collector check: project "wave1-projects live check (throwaway, delete me)", token `gc_E6MwmUvD7vB5lbPCjPubXP`, and two synthetic batches labelled runtime `0.2.1` / model `0.2.0`, host `wave1-check.invalid`, each with one made-up detection (its dashboard read back 2 sessions, 2 decisions, 2 detections) | D1 `genclass-dashboard`: the `projects`, `daily`, `hourly`, `recent` and `sessions` rows of that token; R2: 2 objects under `events/dt=2026-10-13/rt=0.2.1/model=0.2.0/`, mixed with real `0.2.1` data | D1: "Delete a project" above with `T=gc_E6MwmUvD7vB5lbPCjPubXP`. R2: list that prefix with the Cloudflare API, fetch the objects created 05:55 to 05:57, and delete the two whose lines carry that token (`npx --yes wrangler@4 r2 object delete "genclass-telemetry/<key>" --remote`). The admin dashboard already treats `wave1-check.invalid` as test traffic, but lists the project until its D1 row is gone. |
