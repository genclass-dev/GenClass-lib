# genclass-telemetry (collector, per-app tokens, dashboards and accounts)

Cloudflare Worker that receives the default-on diagnostics batches from `@genclass/runtime` (see
[`packages/runtime/TELEMETRY.md`](../packages/runtime/TELEMETRY.md)) and stores them in R2, that gives every web app
a token and a private dashboard on genclass.dev, and that holds the optional accounts (passkeys, Google, GitHub) which
keep several apps in one place and let `npx @genclass/runtime login` connect an app ([Accounts](#accounts)).

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
| `src/auth.ts` | accounts: passkeys, Google, GitHub, sessions, CSRF, the device flow, owned apps, their routes and their retention |
| `src/webauthn.ts`, `src/cbor.ts` | WebAuthn verification with WebCrypto and a minimal CBOR decoder (no dependencies) |
| `src/account-pages.ts` | HTML for `/signup`, `/login`, `/login/device`, `/account` and the account message pages |
| `src/http.ts` | shared JSON response and capped body reader |
| `../billing/plans.json` | the plans (prices, Stripe lookup keys, limits, entitlements, pricing-page lines); the site's build reads it too |
| `src/plans.ts` | plans from `plans.json`, the Free plan's limits, dashboard ranges per plan, the plan-aware retention sweep |
| `src/stripe.ts` | Stripe over `fetch`: Checkout, Billing Portal, cancellation, webhook signature and events, plan from a subscription |
| `src/billing.ts`, `src/billing-pages.ts` | the billing, forwarding, export and export-key routes; `/account/billing` and the app page's Forwarding and Export sections |
| `src/forward.ts`, `src/paid.ts` | forwarding to Sentry, PostHog, Datadog, Slack and webhooks (encrypted settings, dedupe, hourly cap); what runs after each stored batch |
| `src/export.ts` | the batch index, export copies, JSONL/CSV export pages and their sweep |
| `../scripts/stripe-setup.mjs` | for the owner: Stripe products, prices, webhook endpoint and Billing Portal from `plans.json` |
| `test/billing.test.ts`, `test/forward.test.ts`, `test/export.test.ts` | paid plans: Stripe mocked (`test/account-helpers.ts`), the rest as below |
| `migrations/*.sql` | D1 schema |
| `test/index.test.ts`, `test/dashboard.test.ts`, `test/auth.test.ts` | unit tests (R2 mocked; D1 = `node:sqlite` running the real migrations, `test/d1.ts`; passkeys from a software authenticator, `test/authenticator.mjs`; Google and GitHub mocked) |

## Endpoints

| route | behaviour |
|---|---|
| `POST /v1/events` (also `/api/v1/events`) | body `{ schema: "genclass-telemetry/1", sid, sent, runtime, model, token?, events: [{ t, ... }] }`; content-type `application/json` or `text/plain` (sendBeacon / no CORS preflight). 202 `{ ok, accepted }`; 400 bad shape/JSON; 413 over 256 KB; 415 other content type; 503 R2 failure. A missing, malformed (`^gc_[A-Za-z0-9]{22}$`) or unknown `token` never changes the response. |
| `OPTIONS /v1/events` | CORS preflight (`access-control-allow-origin: *`) |
| `GET /v1/health` | `{ ok: true, schema }` |
| `POST /api/projects` | body `{ name? }` (JSON object or empty; name sanitised, at most 80 chars, default "Untitled app"). 201 `{ token, dashboardUrl, name, created }`, `dashboardUrl` = `https://genclass.dev/dashboard/<32 base62>`. CORS `*`, no credentials. 429 JSON when rate-limited, 400 bad JSON, 413 over 4 KB. |
| `GET /api/projects/<secret>?range=24h\|7d\|30d` | dashboard stats JSON (default `7d`): `name, token, created, lastEvent, range, from, generated, totals, breakdowns{metric: [{key,count}]}` (top 25 each), `series` (24 hourly or 7/30 daily buckets: sessions, decisions, detections, acted), `recent` (last 50 detections/interventions in the window). 404 `{ ok:false, error:"not found" }` for an unknown or malformed secret. Same-origin only (no CORS). |
| `GET /start` | "Get a token" page |
| `GET /dashboard/<secret>` | the dashboard (404 page for an unknown secret); `GET /dashboard` redirects to `/start` |

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
| `sessions` | `sid_hash, token, day, counts` | last cumulative `summary` counters per page load (SHA-256 of token + sid), so repeated summaries count once; kept 2 days |

Metrics (`daily.metric`/`hourly.metric`; `key` in brackets):

| from event | metrics |
|---|---|
| `session` | `sessions`, `host` [hostname], `page_route` [route], `runtime` [version], `model_version` [version], `mode` [effectiveMode], `model_kind` [local/custom/off], `webgpu_available` [yes/no] |
| `model` | `model_state` [state], `model_ready`, `backend` [webgpu/wasm], `model_load_ms_sum` / `model_load_ms_n`, `model_from_cache`, `model_load_failed` |
| `decision` | `decisions`, `trigger`, `route`, `fn`, `diagnosis`, `decision_mode`, `executed`, `acted`, `acted_action` [ran], `fn_acted`, `latency_ms_sum` / `latency_ms_n`, `latency_bucket` |
| `detect` | `detections`, `detect_diagnosis`, `detect_trigger`, `detect_route`, `fn_detect` (route/fn from the decision in the same batch) |
| `action` | `action_outcome` [applied/failed/undone], `intervention` [action, applied only] |
| `veto`, `breaker`, `model-error` | `vetoes`, `breaker_trips`, `model_error_events` [code] |
| `summary` (delta per page load) | `fail_open` [reason:trigger], `model_errors` [code] |

Each batch is aggregated in one `db.batch()` (multi-row upserts `count = count + excluded.count`, at most 300 distinct
counters per batch), plus one `SELECT` when the batch has a `summary`. Aggregation runs in `ctx.waitUntil` after the
202 and its failures are swallowed, so D1 can never break ingest.

## Privacy invariants

The worker never stores or logs the client IP, user agent, cookies or any other request header. The only server
additions are `receivedAt` (ISO time) and `country` (Cloudflare's two-letter `request.cf.country`; null if absent).
The dashboard store holds counters, hostnames, routes, function names, labels and versions, never situation text,
session ids (only a hash, for 2 days) or the dashboard secret (only its hash). Workers observability/logs are disabled
in `wrangler.toml`. Tests assert that headers, the city and the situation text never reach the stores.

Accounts add only what [Accounts](#accounts) lists: an email (as typed, or as Google returned it) and whether Google
verified it, passkey public keys, the Google `sub` and the GitHub id and login when used, session records (hashes,
times, a label), and which apps an account owns. Google and GitHub access tokens are used once during sign-in and
never stored; the client IP is only a hashed rate-limit key.

## Accounts

Optional. Everything above keeps working without one: `/start`, secret dashboard links, ingest. An account keeps
several apps in one place and lets the CLI (`npx @genclass/runtime login`, in `packages/runtime/bin/lib/login.mjs`
and `account.mjs`, from `@genclass/runtime` 0.3.0) connect an app without copying keys around. Code: `src/auth.ts`
(routes and rules), `src/webauthn.ts` + `src/cbor.ts` (passkeys), `src/account-pages.ts` (pages); tests in
`test/auth.test.ts`, which also runs the CLI's own request functions (`account.mjs`) against this router: a change
on either side that breaks the other fails CI.

### Ways to sign in

- **Passkeys (WebAuthn)**, always available, no owner setup. Sign up: an email (stored as typed and never verified;
  it names the passkey and is used for account notices only), then the browser's passkey prompt. Sign in: a
  discoverable-credential prompt, no email. Verification is done here with WebCrypto: attestation `none` (any `fmt`
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

**Linking rule.** A Google or GitHub identity is attached to an existing account only when that account is signed in
and chooses Link Google or Link GitHub on `/account` (`/auth/<provider>?link=1`; the callback checks that the same
account and the same session that started the Link are signed in). Never because emails match: passkey sign-up emails are unverified, so matching would let
someone register a victim's address first and later receive the victim's Google sign-in. A first Google sign-in whose
email another account already uses lands on a page that says so and offers two choices: sign in to that account with
its passkey and link Google there, or create a separate account (`POST /api/auth/pending`, the identity waits for 10
minutes in a single-use row named by the `gc_pending` cookie).

### Sessions and request rules

- Web sessions: cookie `__Host-gc_session` (no Domain, so no other genclass.dev host can set or overwrite it), 32
  random bytes as base64url, HttpOnly, Secure, SameSite=Lax, Path=/, 30 days; for a plain-HTTP localhost origin in
  development it is `gc_session` without Secure. CLI sessions: bearer tokens `gcs_` + 32 random bytes, 90 days.
  Both are stored as SHA-256 hashes in `auth_sessions`, listed on `/account` and revocable there (one at a time, or
  "Sign out everywhere else"); a cookie is never accepted as a bearer token or the reverse. `POST /logout` revokes
  the web session, and removing a passkey revokes every other session of the account.
- What a CLI session (bearer) may do is what the CLI needs and the approval page says: `GET /api/me`,
  `GET /api/account/projects`, `POST /api/account/projects`, `POST /api/account/projects/claim` and
  `DELETE /api/account/sessions/current`. Stats, other sessions, passkeys, private links and deleting the account
  answer 403 to a bearer token.
- CSRF: every state-changing request authenticated by the cookie must send `Origin` equal to `AUTH_ORIGIN` (403
  otherwise); the passkey endpoints require it even without a session. The JSON endpoints the pages call require
  `Content-Type: application/json` (415 otherwise). Bearer requests carry no ambient credentials and need no Origin.
  No account endpoint sends CORS headers.
- Rate limits: binding `AUTH_LIMIT` (namespace `7302`, 20 per 60 s), keyed by a SHA-256 of the route and the client
  IP, on sign-up options, sign-in options, starting Google or GitHub sign-in, device code creation, code lookups on
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
| `GET /signup`, `GET /login` | - | the pages (`?next=` only to `/account...` or `/login/device...`); a signed-in visitor is redirected |
| `POST /logout` | cookie + Origin | revokes the session, clears the cookie, 303 to `/login?signed_out=1` |
| `GET /account` | cookie | the account page (302 to `/login?next=/account` without one) |
| `GET /account/apps/<id>` | cookie | an owned app's dashboard with the Connect panel; 404 for an app of another account |
| `GET /login/device?code=ABCD-EFGH` | cookie optional | signed in: the code and the request, Approve and Deny; signed out: the code and the ways to sign in, whether or not the code is live |
| `GET /auth/google`, `GET /auth/google/callback` | - | Google sign-in (404 page when not configured); `?link=1` needs a session |
| `GET /auth/github`, `GET /auth/github/callback` | - | GitHub sign-in, same rules |
| `POST /api/auth/passkey/register/options` | Origin | `{ email }` (or, signed in, `{}` to add a passkey) → `{ id, publicKey }` (WebAuthn creation options, binary fields base64url) |
| `POST /api/auth/passkey/register/verify` | Origin | `{ id, credential: { id, rawId, type, response: { clientDataJSON, attestationObject, transports } } }` → `{ ok, account }`, sets the session for a new account |
| `POST /api/auth/passkey/login/options` | Origin | `{}` → `{ id, publicKey }` (empty `allowCredentials`) |
| `POST /api/auth/passkey/login/verify` | Origin | `{ id, credential: { ..., response: { clientDataJSON, authenticatorData, signature, userHandle } } }` → `{ ok, account }` + session |
| `POST /api/auth/pending` | Origin + `gc_pending` | create the separate account a Google sign-in asked about |
| `POST /api/device/code` | - | `{ client_name? }` (the CLI sends `genclass-runtime <version>`, the only form shown on the approval page and kept as the session's label) → 200 `{ device_code, user_code: "ABCD-EFGH", verification_uri: "https://genclass.dev/login/device", verification_uri_complete: ".../login/device?code=ABCD-EFGH", expires_in: 600, interval: 5 }` |
| `POST /api/device/token` | - | `{ device_code }` (JSON or a form) → 200 `{ access_token: "gcs_...", token_type: "Bearer", expires_in: 7776000, account: { id, email, github_login } }` or 400 `{ error: authorization_pending \| slow_down (with the new interval) \| expired_token \| access_denied \| invalid_request, error_description }` |
| `POST /api/device/approve` | cookie + Origin | `{ user_code, approve: true \| false }` → `{ ok, status }`; 404 for an unknown, expired or used code |
| `GET /api/me` | bearer or cookie | `{ account: { id, email, github_login }, projects: [project] }` |
| `GET /api/account/projects` | bearer or cookie | `{ projects: [project] }` (the Connect panel polls this every 5 s) |
| `POST /api/account/projects` | bearer, or cookie + Origin | `{ name }` → 201 `{ project }`; at most 200 apps per account |
| `POST /api/account/projects/claim` | bearer, or cookie + Origin | `{ dashboard_url }` or `{ secret }` → 200 `{ project }`: the secret-link app joins the account and its link keeps working; 409 when another account owns it or the account holds 200 apps, 404 for an unknown link |
| `GET /api/account/projects/<id>/stats?range=` | cookie | the dashboard stats (same shape as `/api/projects/<secret>`), owned apps only; 403 for a bearer token |
| `DELETE /api/account/projects/<id>/link` | cookie + Origin | turn off the app's private dashboard link (its hash is replaced by one nobody holds); 204 |
| `DELETE /api/account/sessions/current` | bearer (CLI logout) or cookie + Origin | 204 |
| `DELETE /api/account/sessions/<id>` | cookie + Origin | revoke one of this account's sessions; 204, 404 otherwise (403 for a bearer token) |
| `DELETE /api/account/sessions/others` | cookie + Origin | revoke every session of the account except this one; 204 |
| `DELETE /api/account/credentials/<id>` | cookie + Origin | remove a passkey and end every other session; 409 when it is the last way to sign in |
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
| `RUNTIME_ON_NPM` | var (wrangler.toml) | `0.2.2` | the newest `@genclass/runtime` on npm; below `0.3.0` the Connect panel says first that keys and `login` are not published yet. Set it to `0.3.0` when release.yml publishes 0.3.0, then deploy |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | unset | Google sign-in; both needed |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret | unset | GitHub sign-in; both needed |

Production needs no other vars (the defaults are production). For local development see `.dev.vars.example`.

### Owner steps: Google sign-in

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

### Live checks of accounts

Accounts are production data too. A check against genclass.dev signs up with an address at `example.com`, names its
apps `... (throwaway, delete me)`, and deletes everything afterwards with Delete account on `/account` (which also
deletes the apps created in it), or by hand:

```sh
A=<account id>
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  DELETE FROM credentials WHERE account_id = '$A'; DELETE FROM auth_sessions WHERE account_id = '$A';
  UPDATE projects SET account_id = NULL WHERE account_id = '$A'; DELETE FROM accounts WHERE id = '$A';"
```

(then delete its throwaway projects with "Delete a project" below).

## Paid plans

The plans live in [`billing/plans.json`](../billing/plans.json): Free (US$0), Pro (US$99 a month) and Custom (US$599 a
month), with their limits (`apps`, `history_days`), entitlements (`forwarding`, `export`, `analytics`, `custom_model`)
and Stripe lookup keys (`genclass_pro_monthly`, `genclass_custom_monthly`; a yearly price can be added later). Change
a price or a limit there; `src/plans.ts` imports the file and `scripts/stripe-setup.mjs` makes Stripe match it.

An account's plan is `accounts.plan`, written only by the Stripe webhook from the subscription as Stripe has it. The
price names the plan: its lookup key, else the `genclass_plan` metadata the setup script puts on every price and
product. After a price change the lookup key moves to the new price while current subscribers stay on the old one, and
the metadata keeps them on their plan. `active` and `trialing` give the plan, `past_due` keeps it while Stripe retries
the card, anything else is Free. Entitlements follow the plan.

The key's prefix sets the mode. With a live key (`sk_live_`) paid plans are on sale and the Free plan's limits apply.
With a test key (`sk_test_`) only the accounts listed in `STRIPE_TEST_ACCOUNTS` can buy, nobody else sees a button, and
no limits change, so a test pass can run on the production worker. `accounts.stripe_mode` records which mode the
Stripe ids belong to: a plan bought in test mode counts only while the key is a test key (it is Free once the key is
live, and that account's next purchase gets a new live customer). A live plan always counts, whatever the key.

| | Free | Pro, Custom |
|---|---|---|
| apps per account | 3 (a fourth is refused with 409 and a link to `/account/billing`; apps already there stay) | no plan limit; the 200-app abuse cap stays |
| dashboard ranges | 24 h, 7 days | 24 h, 7, 30, 90 days, 1 year |
| kept (daily counters, recent rows, stored batches) | 90 days, as every project before plans | 1 year, and 30 days of grace after a paid period ends |
| forwarding, export | no | yes |
| `custom_model` | no | Custom only |

Apps without an account (private links) keep the current behaviour: 30-day views and 90 days of data. A private link
to an app that belongs to an account also still shows 24 hours, 7 and 30 days whatever the account's plan, because
anyone can make a link-only app with the same 30-day view at `/start`; the owner decides whether link dashboards should
follow the Free plan's 7 days.

### Routes

| route | behaviour |
|---|---|
| `POST /api/billing/checkout` | `{ plan: "pro" \| "custom" }`, browser session and our `Origin` (403 otherwise, also for a CLI token). Creates the account's Stripe customer once (email, `metadata.account_id`). Then it asks Stripe, not the database, whether that customer already has a subscription: one on this plan is a 409, one on the other plan gets `{ url, portal: true }` (the Billing Portal's plan change), so an account never gets a second subscription. Otherwise a Checkout Session in subscription mode for the plan's lookup key (`client_reference_id` = account id, success `https://genclass.dev/account/billing?done=1`), `{ url }`: an open Checkout page of the account for the same plan is reused, one for the other plan is closed first. 503 unless the account can buy (above). |
| `POST /api/billing/portal` | browser session and `Origin`; `{ url }` of a Billing Portal session (cancel at period end, switch plans, card, invoices). 409 before a first purchase, and when Stripe no longer has the customer (the stored ids are then cleared). |
| `POST /api/billing/webhook` | Stripe only. The raw body must carry a valid `Stripe-Signature` (HMAC-SHA256 of `t.body`, any `v1`, within 5 minutes) under `STRIPE_WEBHOOK_SECRET` with a live key or `STRIPE_WEBHOOK_SECRET_TEST` with a test key; else 400. An event signed with the other mode's secret, or whose `livemode` is not the key's mode, is answered 200 and ignored (a test endpoint left over after going live). Handles `checkout.session.completed`, `customer.subscription.created`/`updated`/`deleted`, `invoice.paid`, `invoice.payment_failed`: each one fetches the subscription (its prices' products expanded) and writes the plan, status, period end (when it ended, for one cancelled at once), cancel flag and mode. A subscription of another Stripe customer than the account's is ignored. After a Checkout, if the customer has two subscriptions that bill (two tabs paid), the newest is kept and the others are cancelled at once with the unused time credited to the customer's balance; `NOTIFY_WEBHOOK` gets a `duplicate_subscription` notice. A Custom purchase is recorded (`custom_requests`, `NOTIFY_WEBHOOK`) only when Stripe reports the Custom price paid: a paid Checkout, or a paid invoice with a positive Custom line (a switch from Pro is invoiced at once). Event ids are kept 30 days (`billing_events`), so a redelivery changes nothing; a failure answers 500 and Stripe retries. Events for customers GenClass does not know are logged by type and id and ignored. |
| `GET /api/billing` | browser session: `{ plan, subscription_status, current_period_end, cancel_at_period_end, on_sale }` |
| `GET /account/billing` | the plan, its renewal or end date, the three plans, Upgrade and Switch buttons and Manage billing (only to an account that can buy). `?plan=pro\|custom` (the pricing page's buttons) survives the sign-in redirect and highlights and focuses that plan's button. Back from Checkout (`?done=1`) while the plan still reads Free, it shows no buttons and waits for the webhook. |
| `GET /api/account/projects/<id>/integrations` | browser session: the app's forwarding destinations, masked |
| `PUT /api/account/projects/<id>/integrations/<kind>` | browser session and `Origin`, paid plan, `INTEGRATIONS_KEY` set (503 otherwise). `kind` is `sentry` `{dsn}` (a `sentry.io` host), `posthog` `{key, host}`, `datadog` `{api_key, site}`, `slack` `{url}` or `webhook` `{url}` (https, public host name, default port, not genclass.dev or workers.dev); a new webhook gets a signing secret, returned once as `secret` |
| `PATCH`, `DELETE` same path; `POST .../<kind>/test` | turn a destination on or off (`{enabled}`), remove it, or send it one test record (502 with the reason when it fails). A test record counts against the app's 60 records an hour (429 when they are used up) |
| `GET /api/account/projects/<id>/events?from&to&format&limit&cursor` | export, paid plans: an export key (`Authorization: Bearer gce_...`) or the browser session; a CLI token is refused. `from`/`to` take a date or an ISO time (default the last 7 days; `from` is moved up to the plan's history), `format` `jsonl` (default) or `csv`, `limit` 1 to 200 batches. The next page's cursor is in `x-genclass-next-cursor` and `Link: rel="next"`. 120 pages a minute per account (`EXPORT_LIMIT`; 429 with `retry-after: 60`) |
| `GET`, `POST /api/account/export-keys`; `DELETE .../<id>` | browser session: list, create (paid plans, at most 10; the key is shown once, only its SHA-256 is stored) and revoke export keys |

Checkout, the portal, Send test and new export keys share `AUTH_LIMIT`'s 20 a minute per account and route (keyed by a
hash of the route and the account id), so one account cannot use up GenClass's Stripe API budget or post through Send
test at request rate.

### Migration 0004 (`migrations/0004_billing.sql`)

Additive. `accounts` gains `plan` (default `'free'`), `stripe_customer_id`, `subscription_id`, `subscription_status`,
`current_period_end`, `cancel_at_period_end` and `stripe_mode`. New tables: `billing_events` (handled Stripe event ids),
`custom_requests` (one row per paid Custom subscription, with its mode: the owner starts the training work from it),
`integrations` (forwarding destinations, AES-GCM ciphertext only), `forward_log` (dedupe and the hourly cap, kept 2
hours), `event_batches` (which stored batch belongs to which paid app, for the export) and `export_keys` (hashes only).

### Forwarding

After a batch from an app whose owner is on Pro or Custom, each new likely detection (`detect` without
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
app's token), so it covers the batches received while the account was on Pro or Custom. The daily sweep deletes the
export copies of apps no longer on a paid plan once they pass 90 days, and every copy past the longest plan's history,
in rounds of 1,000 keys (40 rounds a pass), and any index row older than 367 days in one statement (R2's rule has
removed its object by then).

### Settings

| name | kind | what |
|---|---|---|
| `STRIPE_SECRET_KEY` | secret | `sk_live_...`: paid plans on sale, the Free plan's limits on. `sk_test_...`: only `STRIPE_TEST_ACCOUNTS` can buy, no limits. Without it the buttons are hidden, checkout answers 503, and the Free plan's limits do not apply |
| `STRIPE_WEBHOOK_SECRET` | secret | the live webhook endpoint's signing secret (`whsec_...`); `scripts/stripe-setup.mjs` with a live key stores it |
| `STRIPE_WEBHOOK_SECRET_TEST` | secret | the test endpoint's signing secret; the script with a test key stores it, so a test run never replaces the live one |
| `STRIPE_TEST_ACCOUNTS` | secret | emails or account ids, comma-separated, that can buy while the key is a test key |
| `INTEGRATIONS_KEY` | secret | 32 random bytes, base64; encrypts forwarding settings. Set it once: another key makes saved settings unreadable (owners then save them again) |
| `NOTIFY_WEBHOOK` | secret, optional | an https URL that gets `{ text, content, event, mode, at, ... }`: `custom_purchase` (`request_id`, `account_id`, `subscription_id`) when a Custom plan is paid, `duplicate_subscription` when a second subscription was cancelled. Ids only: the buyer's email stays in `custom_requests`. `text` suits Slack, `content` Discord; test-mode notices start with `[Stripe test mode, no real money]` |
| `EXPORT_LIMIT` | rate limit binding | export pages per account per minute (120) |

A Custom buyer's email, for the notice above:
`npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "SELECT email, created, mode FROM custom_requests WHERE id = '<request_id>'"`.

### Owner steps, in order

1. In `telemetry-worker/`: `npx --yes wrangler@4 d1 migrations apply genclass-dashboard --remote`, then the export
   copies' lifecycle rule:
   `npx --yes wrangler@4 r2 bucket lifecycle add genclass-telemetry expire-export-366d export/ --expire-days 366`.
2. `openssl rand -base64 32 | npx --yes wrangler@4 secret put INTEGRATIONS_KEY` (once), and optionally
   `npx --yes wrangler@4 secret put NOTIFY_WEBHOOK` (a Slack or Discord incoming webhook URL).
3. `npx --yes wrangler@4 deploy`. Nothing is on sale yet and nothing changes for anyone.
4. Test mode, on the production worker: `npx --yes wrangler@4 secret put STRIPE_TEST_ACCOUNTS` with your own account's
   email, then from the repo root `STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs` (signed in to wrangler).
   It creates GenClass Pro and GenClass Custom with their monthly prices, the test webhook endpoint
   `https://genclass.dev/api/billing/webhook` (its secret goes straight into `STRIPE_WEBHOOK_SECRET_TEST`, never
   printed) and the Billing Portal (plan switches charged at once). `--dry-run` only reads; running it again changes
   only what differs.
5. `npx --yes wrangler@4 secret put STRIPE_SECRET_KEY` with the test key. Only your account can buy; everyone else
   sees no change.
6. Test a checkout: on `https://genclass.dev/account/billing` choose Upgrade to Pro and pay with Stripe's test card
   `4242 4242 4242 4242`, any future expiry date and any CVC. The page shows Pro within a minute. Then Manage billing:
   switch to Custom (charged at once; a `custom_requests` row with mode `test` and a test-mode notice), and cancel.
7. Before going live, clear the test records (once the key is live they no longer count, but this keeps the tables
   clean):
   `npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "UPDATE accounts SET plan = 'free', stripe_customer_id = NULL, subscription_id = NULL, subscription_status = NULL, current_period_end = NULL, cancel_at_period_end = 0, stripe_mode = NULL WHERE stripe_mode = 'test'; DELETE FROM custom_requests WHERE mode = 'test';"`
8. Live: `STRIPE_SECRET_KEY=sk_live_... node scripts/stripe-setup.mjs` (live products, prices, webhook endpoint and
   `STRIPE_WEBHOOK_SECRET`, portal).
9. In the Stripe dashboard, live mode: Billing, Revenue recovery, Retries: set "If all retries for a payment fail" to
   "Cancel the subscription". A plan stays paid while its subscription is `past_due`, so without this a card that keeps
   failing would keep Pro or Custom.
10. `npx --yes wrangler@4 secret put STRIPE_SECRET_KEY` with the live key. Paid plans are on sale and the Free plan's
    limits apply. Optionally remove `STRIPE_TEST_ACCOUNTS` (`npx --yes wrangler@4 secret delete STRIPE_TEST_ACCOUNTS`);
    events from the test endpoint are answered 200 and ignored, or delete that endpoint in Stripe's test mode.

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
