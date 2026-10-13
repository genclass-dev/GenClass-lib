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
| the same, on a local or private host (`localhost`, `*.localhost`, `*.local`, `*.test`, `*.internal`, `127.0.0.1`, `::1`, `10/8`, `172.16/12`, `192.168/16`, link-local, `file:`) | off unless `telemetry: true` / `{ ... }` (`0.2.1` and `0.2.2`: on, by mistake; fixed in the next release, see the CHANGELOG) |
| `GenClass.init()` outside a browser (Node, SSR, workers) | off unless `telemetry: true` / `{ ... }` |
| `createRuntime()` (headless, tests, the simulator) | off unless `telemetry: true` / `{ ... }` |

In `0.2.1` and `0.2.2` the local-host row did not apply to `GenClass.init()` (and so to `/auto` and the script tag):
it passed an explicit `telemetry: true` internally, so local and private hosts sent too. Fixed in the next release
([CHANGELOG](CHANGELOG.md), Unreleased).

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
latency and counts, plus the app's hostname and the id-normalised route (no query or fragment).

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
- **Never, in either setting:** typed values of password, payment (`cc-*`), one-time-code or secret-named inputs
  (the runtime never records them in the first place), cookies, request or response headers, request or response
  bodies, storage contents, the sentences GenClass prints about what it changed, IP addresses or user agents (the
  collector does not store them).

### Batch envelope (schema `genclass-telemetry/1`)

`POST <endpoint>` with `content-type: text/plain;charset=UTF-8` (JSON body), no credentials, no referrer:

```jsonc
{
  "schema": "genclass-telemetry/1",
  "token": "gc_…",           // only when the app configured a valid token (InitOptions.token); see "App tokens"
  "sid": "3f9c…",            // 24 hex chars from crypto.getRandomValues, new on every page load, never stored
  "sent": 12034,             // ms since this page's GenClass started (no wall-clock time is sent)
  "runtime": "0.2.1", // @genclass/runtime version
  "model": "2.0.0-rc4t",     // model card version, or null without a model
  "events": [ /* ≤ 100 events, ≤ 60 KB per request */ ]
}
```

Every event has `t` (type), `seq` (0, 1, 2, … per page) and `at` (ms since start). Event types:

| `t` | when | fields |
|---|---|---|
| `session` | once, at init | `runtime`, `host` (the page's hostname, which identifies the app using GenClass), `route` (the page path with id-like segments replaced by `:id`, no query or fragment), `mode`, `effectiveMode`, `aggressiveness`, `sampled`, `model` (`local` / `custom` / `off`), `modelState`, `modelVersion`, `triage`, `shadow`, `holdWrites`, `device` (`webgpu` available, `cores`, `memoryGB` (the browser's coarse deviceMemory), `crossOriginIsolated`, `effectiveType`, `saveData`), `sample`, `situation` (whether situation text is included) |
| `model` | model state changes | `state`, `version`, `model`, `variant`, `device` (webgpu/wasm), `threads`, `worker`, `workerError`, `gpu` (WebGPU probe summary), `ort`, `loadMs`, `warmupMs`, `fromCache`, `bytes`, `phase`, `reason`, `error` (GenClass model-host error text, ≤ 200 chars), `attempts` |
| `status` | mode, aggressiveness or breaker changes | `mode`, `effectiveMode`, `aggressiveness`, `breaker` |
| `decision` | every model decision | `id`, `trigger`, `route`, `model`, `latencyMs`, `held` (the subject waited for the answer; false = decided in the background), `situation` (text, see above), `autoState` (true when discovered state was recorded on the page), `budget`, `compact`, `questions` (question ids), `answers` (per question: calibrated `probabilities` per label, `choice`, `confidence`; or `p` / `score`), `diagnosis`, `diagnosisConfidence`, `action` (chosen), `confidence`, `tier`, `candidate`, `ran`, `executed`, `acted`, `reason` (why the passive action ran), `mass`, `gateKind`, `threshold` / `gain` / `margin`, `thresholdSource`, `gates` (report/guard/heal thresholds, aggressiveness, level and sources), `effectiveMode`, `shadow`, `fn` (only on batches with a token: the name the app gave the `protect()`ed function the decision's subject ran inside, the outermost one; omitted otherwise) |
| `detect` | a decision reported as a detection | `decision`, `trigger`, `diagnosis`, `p` |
| `action` | an action ran, failed or was undone | `id`, `decision`, `action`, `tier`, `trigger`, `outcome` (`applied` / `failed` / `undone`), `late` (a late revert), `reversible`, `droppedFields` (count) |
| `veto` | `onBeforeAction` vetoed an action | `decision`, `action`, `enforced` |
| `breaker` | the breaker tripped or reset | `tripped`, `reason`, `undos`, `errors`, `decisions` (ids) |
| `model-error` | model errors (first 20 per page; all are counted) | `code`, `message` (≤ 200 chars) |
| `summary` | every ≥ 60 s with activity, when the tab is hidden, on pagehide and on destroy | `reason`, `counts` (decisions, acted, detections, actions applied/failed, late reverts, undos, vetoes, breaker trips, per trigger / diagnosis / action ran, detections per diagnosis, action limits hit, model errors per code, fail-opens per reason and trigger), `runtime` (model p50/p95 latency, decisions, dropped, hidden-tab skips, held time, denied and shadow counts, error count), `telemetry` (queued, dropped, send failures, events sent) |

Numbers are rounded to 4 decimals. The source of truth is `packages/runtime/src/telemetry/client.ts`.

### Transport

- Batches every 10 s (`flushMs`) of activity, and on `pagehide` / when the tab becomes hidden via
  `navigator.sendBeacon` (falling back to `fetch` with `keepalive`).
- The `fetch` and `sendBeacon` captured when `@genclass/runtime` loaded, so GenClass never observes, holds or decides
  about its own requests.
- At most 1,000 queued events; beyond that new events are dropped and counted. A failed request is dropped, never
  retried; after 3 failures in a row the page stops sending (`MAX_FAIL_STREAK`). Telemetry never throws into your app, never changes what the model sees, and never delays a decision.

## App tokens and dashboards

Unreleased (not in `0.2.2`, which ignores a token and sends neither `token` nor `fn`). An app can set a **token**
(`InitOptions.token`, `data-token`, `<meta name="genclass" content="token=...">` or `window.GENCLASS_CONFIG.token`):
`gc_` followed by 22 letters or digits, created by `npx @genclass/runtime init` or at https://genclass.dev/start.

- The token is public (it is in the page). It is sent as the batch envelope's top-level `token` and nowhere else; it
  lets the collector group the batches of one app. A malformed token logs one console warning and is not sent.
- Whoever holds the app's private dashboard link (`https://genclass.dev/dashboard/<secret>`, given once when the
  token is created) can see aggregated diagnostics for that token (decisions, detections by diagnosis, actions, the
  app's hostnames, top routes and protected functions, model load, backend and latency, versions) and its recent
  detections. Dashboard data is also deleted after 90 days.
- A token changes nothing about when data is collected: with telemetry off (any opt-out, or Global Privacy
  Control, or a local host) nothing is sent and the dashboard gets nothing from that page. On a local host the
  console says so once when a token is set; otherwise only with `debug: true`.
- Only batches that carry a token have `fn` on `decision` events: the name the app chose for the `protect()`ed
  function the decision was about (at most 80 characters). Without a token `fn` is never sent.
- `npx @genclass/runtime init` creates a token (a "project") only on a new setup and only after the developer
  approved its changes (or passed `--yes`): it sends one request, `POST https://genclass.dev/api/projects` with
  `{ "name": <package.json name, at most 80 characters> }`. The collector keeps one record per project: the token,
  that name, the creation time, the time of the last batch, and a SHA-256 hash of the dashboard secret (never the
  secret itself). Project records have no automatic expiry; the aggregated dashboard data does (90 days). To delete
  a project and its dashboard data, write to the contact in PRIVACY.md with the token.

## Where it goes

- **Endpoint:** `https://genclass.dev/api/v1/events` (`DEFAULT_TELEMETRY_ENDPOINT`; before 0.2.2 the same worker's
  `https://genclass-telemetry.mehar-144.workers.dev/v1/events`, which still works), a Cloudflare Worker operated by the
  GenClass maintainers (source: `telemetry-worker/` in the repository). With a Content-Security-Policy, allow
  `https://genclass.dev` in `connect-src` or turn telemetry off; after 3 failed requests in a row a page stops sending.
- **Storage:** a private Cloudflare R2 bucket (`genclass-telemetry`), gzip JSON Lines, one object per batch,
  partitioned by UTC date, runtime version and model version. The collector adds only the time it received the
  batch and the visitor's coarse **country** (two letters, from Cloudflare). It does not store IP addresses, user
  agents, cookies or any request header, and it drops unknown fields.
- **Use:** model evaluation and training by the GenClass maintainers, and, for batches that carry a token, that
  app's dashboard. Not sold, not used for advertising.
- **Retention:** 90 days. An R2 lifecycle rule (`expire-90d`, prefix `events/`) deletes every stored batch 90 days after it
  was written. The maintainers may change this later; changes are recorded in the CHANGELOG.
- **Your own endpoint:** `telemetry: { endpoint: "https://…" }` sends the same batches to a collector you run
  instead (the worker in `telemetry-worker/` deploys to any Cloudflare account).

## Options

```ts
GenClass.init({
  telemetry: {
    endpoint: "https://…",          // default DEFAULT_TELEMETRY_ENDPOINT
    sample: 0.25,                    // fraction of page loads that send (default 1)
    flushMs: 10_000,                 // batch interval
    maxBatch: 100,                   // events per request
    include: { situation: true },    // also send the redacted situation text (default: off)
  },
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
- turn it off (`telemetry: false`) in apps that handle regulated data (health, finance, children's services): a
  custom `redact` lowers what reaches situation text but does not guarantee that nothing sensitive does.

Privacy policy for this collection: [PRIVACY.md](https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md). Data processing terms are not published yet
(planned); if you cannot disclose a third-party diagnostics recipient, set `telemetry: false`.
