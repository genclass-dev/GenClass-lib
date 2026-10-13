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
several apps in one place and lets the CLI (`npx @genclass/runtime login`, built on the `wave2/accounts-cli` branch)
connect an app without copying keys around. Code: `src/auth.ts` (routes and rules), `src/webauthn.ts` +
`src/cbor.ts` (passkeys), `src/account-pages.ts` (pages); tests in `test/auth.test.ts`.

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
  `GET /auth/google` stores state, nonce and the PKCE verifier in one cookie (`gc_oauth_google`, HttpOnly, Secure,
  SameSite=Lax, Path=/auth/google, 10 minutes) and redirects to Google with `scope=openid email profile` and
  `prompt=select_account`. The callback refuses a missing or mismatched state (constant-time) and an `error`
  parameter, exchanges the code with the client secret and the verifier, and takes the `id_token` from that direct
  TLS response: OIDC Core 3.1.3.7 lets a confidential client skip the signature check there, and the claims are
  still checked (`iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` is the client id, `exp` is in
  the future, `nonce` matches). `sub` is the identity (`accounts.google_sub` UNIQUE). The cookie is cleared on every
  outcome.
- **GitHub** (OAuth web flow), shown only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` exist: `/auth/github`
  (state cookie `gc_oauth_github`, 10 minutes), GitHub, `/auth/github/callback` (state check, code exchange,
  `GET https://api.github.com/user` for `id` and `login`; no scope is requested and no email is kept).

**Linking rule.** A Google or GitHub identity is attached to an existing account only when that account is signed in
and chooses Link Google or Link GitHub on `/account` (`/auth/<provider>?link=1`; the callback checks that the same
session is still signed in). Never because emails match: passkey sign-up emails are unverified, so matching would let
someone register a victim's address first and later receive the victim's Google sign-in. A first Google sign-in whose
email another account already uses lands on a page that says so and offers two choices: sign in to that account with
its passkey and link Google there, or create a separate account (`POST /api/auth/pending`, the identity waits for 10
minutes in a single-use row named by the `gc_pending` cookie).

### Sessions and request rules

- Web sessions: cookie `gc_session`, 32 random bytes as base64url, HttpOnly, Secure (dropped only for a plain-HTTP
  localhost origin in development), SameSite=Lax, Path=/, 30 days. CLI sessions: bearer tokens `gcs_` + 32 random
  bytes, 90 days, listed on `/account` and revocable there. Both are stored as SHA-256 hashes in `auth_sessions`; a
  cookie is never accepted as a bearer token or the reverse. `POST /logout` revokes the web session.
- CSRF: every state-changing request authenticated by the cookie must send `Origin` equal to `AUTH_ORIGIN` (403
  otherwise); the passkey endpoints require it even without a session. The JSON endpoints the pages call require
  `Content-Type: application/json` (415 otherwise). Bearer requests carry no ambient credentials and need no Origin.
  No account endpoint sends CORS headers.
- Rate limits: binding `AUTH_LIMIT` (namespace `7302`, 20 per 60 s), keyed by a SHA-256 of the route and the client
  IP, on sign-up options, sign-in options, device code creation, device approval and device token polling. A limited
  poll answers `slow_down`. Account app creation also uses `CREATE_LIMITER` (per account) and the global ceiling of
  60 new projects a minute.

### Routes

| route | auth | behaviour |
|---|---|---|
| `GET /signup`, `GET /login` | - | the pages (`?next=` only to `/account...` or `/login/device...`); a signed-in visitor is redirected |
| `POST /logout` | cookie + Origin | revokes the session, clears the cookie, 303 to `/login?signed_out=1` |
| `GET /account` | cookie | the account page (302 to `/login?next=/account` without one) |
| `GET /account/apps/<id>` | cookie | an owned app's dashboard with the Connect panel; 404 for an app of another account |
| `GET /login/device?code=ABCD-EFGH` | cookie optional | shows the code and the request; Approve and Deny when signed in, otherwise sign in first and come back |
| `GET /auth/google`, `GET /auth/google/callback` | - | Google sign-in (404 page when not configured); `?link=1` needs a session |
| `GET /auth/github`, `GET /auth/github/callback` | - | GitHub sign-in, same rules |
| `POST /api/auth/passkey/register/options` | Origin | `{ email }` (or, signed in, `{}` to add a passkey) → `{ id, publicKey }` (WebAuthn creation options, binary fields base64url) |
| `POST /api/auth/passkey/register/verify` | Origin | `{ id, credential: { id, rawId, type, response: { clientDataJSON, attestationObject, transports } } }` → `{ ok, account }`, sets the session for a new account |
| `POST /api/auth/passkey/login/options` | Origin | `{}` → `{ id, publicKey }` (empty `allowCredentials`) |
| `POST /api/auth/passkey/login/verify` | Origin | `{ id, credential: { ..., response: { clientDataJSON, authenticatorData, signature, userHandle } } }` → `{ ok, account }` + session |
| `POST /api/auth/pending` | Origin + `gc_pending` | create the separate account a Google sign-in asked about |
| `POST /api/device/code` | - | `{ client_name? }` → 200 `{ device_code, user_code: "ABCD-EFGH", verification_uri: "https://genclass.dev/login/device", verification_uri_complete: ".../login/device?code=ABCD-EFGH", expires_in: 600, interval: 5 }` |
| `POST /api/device/token` | - | `{ device_code }` (JSON or a form) → 200 `{ access_token: "gcs_...", token_type: "Bearer", expires_in: 7776000, account: { id, email, github_login } }` or 400 `{ error: authorization_pending \| slow_down (with the new interval) \| expired_token \| access_denied \| invalid_request, error_description }` |
| `POST /api/device/approve` | cookie + Origin | `{ user_code, approve: true \| false }` → `{ ok, status }`; 404 for an unknown, expired or used code |
| `GET /api/me` | bearer or cookie | `{ account: { id, email, github_login }, projects: [project] }` |
| `GET /api/account/projects` | bearer or cookie | `{ projects: [project] }` (the Connect panel polls this every 5 s) |
| `POST /api/account/projects` | bearer, or cookie + Origin | `{ name }` → 201 `{ project }`; at most 200 apps per account |
| `POST /api/account/projects/claim` | bearer, or cookie + Origin | `{ dashboard_url }` or `{ secret }` → 200 `{ project }`: the secret-link app joins the account and its link keeps working; 409 when another account owns it, 404 for an unknown link |
| `GET /api/account/projects/<id>/stats?range=` | bearer or cookie | the dashboard stats (same shape as `/api/projects/<secret>`), owned apps only |
| `DELETE /api/account/sessions/current` | bearer (CLI logout) or cookie + Origin | 204 |
| `DELETE /api/account/sessions/<id>` | bearer, or cookie + Origin | revoke one of this account's sessions; 204, 404 otherwise |
| `DELETE /api/account/credentials/<id>` | cookie + Origin | remove a passkey; 409 when it is the last way to sign in |

A `project` is `{ id, name, token, dashboard_url, created, last_event, first_event }`; `id` is 16 hex, `dashboard_url`
is `https://genclass.dev/account/apps/<id>`. User codes use 20 consonants (no vowels, no look-alikes) and accept any
case or separator; device codes last 10 minutes and are used once; polling faster than the interval (1 s of slack)
answers `slow_down` and adds 5 s to the interval.

### Migration 0003 (`migrations/0003_accounts.sql`)

Additive and safe on the production database: new tables `accounts`, `credentials`, `auth_sessions` (named so
because `sessions` already holds the summary counters), `challenges` and `device_codes`, and three nullable columns
on `projects` (`account_id`, `id`, `first_event`). It gives every existing project an `id`
(`lower(hex(randomblob(8)))`) and a UNIQUE index on it; no existing value changes. Apply it before deploying the code
that reads it:

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | unset | Google sign-in; both needed |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | secret | unset | GitHub sign-in; both needed |

Production needs no vars (the defaults are production). For local development see `.dev.vars.example`.

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
apps `... (throwaway, delete me)`, and deletes everything afterwards:

```sh
A=<account id>
npx --yes wrangler@4 d1 execute genclass-dashboard --remote --command "
  DELETE FROM credentials WHERE account_id = '$A'; DELETE FROM auth_sessions WHERE account_id = '$A';
  UPDATE projects SET account_id = NULL WHERE account_id = '$A'; DELETE FROM accounts WHERE id = '$A';"
```

(then delete its throwaway projects with "Delete a project" below).

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
  DELETE FROM projects WHERE token = '$T';"
```

The dashboard link then returns 404 and later batches with that token are stored in R2 only (the in-memory token cache
may keep aggregating for up to 5 minutes). Raw R2 objects are not indexed by token; they expire after 90 days.

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
