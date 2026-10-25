# Threat model

What could go wrong, or be made to go wrong, when `@genclass/runtime` runs in a web app; what the code does about it;
and what remains. It covers the runtime as published (`packages/runtime`), its default model package and the telemetry
collector. Companion documents: [INTERCEPTION.md](../../packages/runtime/INTERCEPTION.md) (the full list of what
GenClass wraps and what each action does), [SECURITY.md](../../SECURITY.md) (reporting),
[TELEMETRY.md](../../packages/runtime/TELEMETRY.md) (what leaves the page). Code references are to
`packages/runtime/src/`. Reviewed against commit 2f89fb5 plus the SAFETY changes of 2026-10-10.

## Contents

- [What GenClass is, for this purpose](#what-genclass-is-for-this-purpose)
- [Assets and trust boundaries](#assets-and-trust-boundaries)
- [T1. Other scripts on the page](#t1-other-scripts-on-the-page)
- [T2. Model and code supply chain](#t2-model-and-code-supply-chain)
- [T3. Crafted responses and messages steering the model](#t3-crafted-responses-and-messages-steering-the-model)
- [T4. Denial of service through forced model calls](#t4-denial-of-service-through-forced-model-calls)
- [T5. Telemetry and redaction leaks](#t5-telemetry-and-redaction-leaks)
- [T6. State discovery reading application state](#t6-state-discovery-reading-application-state)
- [T7. A wrong action on a correct app](#t7-a-wrong-action-on-a-correct-app)
- [T8. Configuration by URL, storage and meta tags](#t8-configuration-by-url-storage-and-meta-tags)
- [T9. Cached and shared responses](#t9-cached-and-shared-responses)
- [T10. The coding-agent bridge](#t10-the-coding-agent-bridge)
- [Residual risks, in one list](#residual-risks-in-one-list)
- [Recommended production setup](#recommended-production-setup)

## What GenClass is, for this purpose

A JavaScript library in the page's own origin. It wraps `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, the
timers, `history` and `Storage` methods, listens to user and error events, and (with `autoState`) hooks React's
DevTools interface and the Redux DevTools globals. From what it observes it builds a short text, the *situation*, and,
for salient ones, asks a small classification model (ONNX, in a Web Worker) to pick a diagnosis and one action from a
fixed list the runtime offers for that subject. A policy gate decides whether that action runs. The model cannot run
code, call APIs or name an action that was not offered.

## Assets and trust boundaries

Assets: the correctness of the app's behaviour (no wrong action), the user's data (typed input, application state,
response contents), the app's availability and latency, and the integrity of the code and model that run.

| Boundary | Trusted? | Notes |
|---|---|---|
| the page's own scripts | same trust as GenClass | any script in the origin can already read and change everything GenClass can |
| responses from the app's servers and third parties | data, untrusted as instructions | they become situation text the model reads (T3) |
| the model files (`model.baseUrl`) and onnxruntime-web (`model.ortWasmPaths`) | integrity-checked, not trusted blindly | default: jsDelivr, from the npm packages (T2) |
| the telemetry collector | receives redacted diagnostics only | default on for `GenClass.init` in a browser (T5) |
| the developer's configuration | trusted | but parts of it can come from the URL, `localStorage` or meta tags (T8) |
| learned state in storage (`genclass:learn`; the learned flows when `learn.expectations` is on (opt-in), transition profiles only with `learn.persist`, EXPECTATIONS.md §4) | data, checked field by field and against the learner's bounds on load, discarded on a format or runtime-version change | holds request signatures, routes and field names (id-like segments and keys normalised; other path segments and map keys, such as `/u/jane.doe@example.com` or a store keyed by email, as they are), counts and hashes of action labels, no element text or values; a script that rewrites the flows can make expectation reports wrong or silent, and, when profiles are stored, change which `transition` situations reach the model, which any same-origin script could already do (T1) |

## T1. Other scripts on the page

**Threat.** A third-party script, a compromised dependency or an XSS payload reads what GenClass collected (situation
text, `rt.history()`, `rt.decisions()`, `rt.explain()`, `rt.audit()`, discovered state) or drives it
(`GenClass.runtime.setMode("heal")`, `localStorage.genclass`, `rt.disable()`).

**Mitigations.** GenClass adds no capability such a script lacks: it can already read the DOM, the app's state and
every response, and wrap `fetch` itself. What GenClass keeps is redacted when it is recorded: values of password, card
(`cc-*`), one-time-code and secret-named inputs are never recorded ([observe/dom-user.ts](../../packages/runtime/src/observe/dom-user.ts)
`isSensitiveField`); secret-named state paths and values are replaced by `[redacted]`
([util.ts](../../packages/runtime/src/util.ts) `defaultRedact`, `isSensitivePath`), a custom `redact` can only redact
more ([runtime.ts](../../packages/runtime/src/runtime.ts) constructor); discovered React hooks whose string equals what a
sensitive input holds are redacted from then on ([discover/react.ts](../../packages/runtime/src/discover/react.ts));
storage keys are recorded by name only, never values ([observe/storage.ts](../../packages/runtime/src/observe/storage.ts)).
Everything stays in memory and is bounded (500 events, 200 decisions, 1,000 audit entries).

**Residual.** Inside the origin there is no isolation from a hostile script. A script can raise the mode with
`setMode("heal")` and then rely on the model to act; it could equally perform those effects itself.

## T2. Model and code supply chain

**Threat.** A tampered model, model card or onnxruntime-web build makes GenClass choose harmful actions, lower its own
gate, or run hostile code.

**Mitigations.**

- The default model URL is a pinned npm version on jsDelivr (`DEFAULT_MODEL_BASE_URL` in
  [model/host.ts](../../packages/runtime/src/model/host.ts)); npm versions are immutable once published.
- Every model file is checked against the card's `bytes` and `sha256` before use; a Cache Storage entry is reused only
  when it was stored under the same sha256 ([model/loader.ts](../../packages/runtime/src/model/loader.ts) `fetchFile`,
  `cachedValid`; `ModelIntegrityError`). The sha256 of the loaded variant is in `rt.status.sha256` and in every audit
  entry, so a deployment can verify which model decided.
- A model can only rank the actions the runtime offered for a subject. Out-of-vocabulary answers are ignored
  ([runtime.ts](../../packages/runtime/src/runtime.ts) `onDecision`), and the gate applies the mode, `requests.protect`,
  cross-origin, `policy.allow`/`deny`, action limits, the breaker and `onBeforeAction`
  ([decide/policy.ts](../../packages/runtime/src/decide/policy.ts) `gate`). In `observe` (the default) nothing it says
  changes anything (`test/invariants/observe.test.ts`).
- Inference runs in a module Web Worker; the ONNX graph has no network or DOM access.
- Self-hosting: `npx @genclass/runtime fetch-model <dir>` plus `model: { baseUrl, ortWasmPaths }` and a
  Content-Security-Policy limiting `connect-src`, `script-src` and `worker-src` to your origin
  ([README](../../packages/runtime/README.md#content-security-policy-and-self-hosting)). The script-tag build pins
  every URL it loads later to its own version ([cdn/config.ts](../../packages/runtime/src/cdn/config.ts)).
- The release workflow (`.github/workflows/release.yml`) builds from a tag and publishes with npm provenance once the
  owner has configured npm trusted publishing; [SECURITY.md](../../SECURITY.md#verifying-a-published-tarball) shows how to
  check a tarball against the repository.

**Residual.**

- `model.json` itself is not pinned by a hash the app supplies: whoever controls the model URL can publish a new card
  with matching hashes. The model's meta gate (`meta.json` → `gate`) sets the thresholds unless the app sets
  `policy.thresholds`, so a hostile model could lower them. Pin `policy.thresholds` and self-host if that matters.
- onnxruntime-web's wasm is verified by its version tag only, not a sha256; an `integrity` attribute on the script tag
  covers that one file, not the modules, worker and wasm it loads later (dynamic `import()` and module workers take no
  SRI).
- Cache Storage is per origin: a page script can plant a cache entry (T1).
- Memory-safety bugs in onnxruntime-web's wasm are sandboxed by WebAssembly and the worker, not by GenClass.

## T3. Crafted responses and messages steering the model

**Threat.** Data the app receives (an API response, a WebSocket message, a user-generated string another user
submitted) contains text meant to push the model towards an action, the way prompt injection steers a chat model.

**Mitigations.**

- The model is a classifier over a fixed label set, not an instruction follower; the situation text quotes values as
  data in a fixed format ([situation/serialize.ts](../../packages/runtime/src/situation/serialize.ts)), and each value
  summary is truncated (about 60 to 90 characters, [util.ts](../../packages/runtime/src/util.ts) `describe`).
- What it can choose is limited to the actions offered for that subject, each with preconditions the runtime checks
  itself ([situation/build.ts](../../packages/runtime/src/situation/build.ts) `builtinUnavailable`): no retry of a
  non-idempotent request without an idempotency key (`repeatUnsafe`), cache answers only for GET, nothing for a
  cross-origin or protected subject.
- Precision-first gate: the summed calibrated probability must reach 0.9 (guard) / 0.8 (heal) by default and the
  diagnosis must not be `expected`; action limits (60 per minute, 10 per subject per minute, 200 per session); the
  breaker drops the session to `observe` after 2 undos or 3 errors that follow actions.
- Every action is recorded with what it changed and, where possible, can be undone.

**Residual.** An adversarial input can, in principle, flip a classifier. The impact is bounded by the mode and the
offered actions for that one subject: in guard, dropping a response's writes over newer data, coalescing or delaying a
request; in heal also block, retry, serve from cache, hedge, roll back. `observe` and `requests.protect` remove it.

## T4. Denial of service through forced model calls

**Threat.** A server, a page script or user-generated content makes many situations salient, to burn CPU and battery
or to add latency through holds.

**Mitigations.** Model evaluations are rate limited (`model.maxDecisionsPerMinute`, default 30 for the built-in
model; beyond it decisions fail open: [decide/decider.ts](../../packages/runtime/src/decide/decider.ts)); the queue is
bounded (32) and stale items are dropped; each evaluation times out (10 s, `model.timeoutMs`); while the model is not
answering, nothing is held (`expectedLatency` is infinite). A hold never exceeds the hold budget (at most 800 ms with
"auto"; `test/invariants/*` "the hold budget caps"), and only guard and heal hold at all. Hidden tabs skip
background evaluations in guard and heal; in observe (0.3.0) at most 32 situations raised while the tab is hidden
(or the model loads) wait, and are decided within the same per-minute budget once the tab is visible; a hidden tab
never loads or reloads the model. Inference runs off the main thread. React discovery stops after 1 ms per commit. The model
is not loaded on devices reporting 2 GB or less nor on Save-Data connections (`model.loadIf` default), can be skipped or unloaded when idle
(`model.unloadAfterIdleMs`).

**Residual.** Up to 30 evaluations a minute of worker CPU, and in guard/heal up to one hold budget of added latency per
salient request, response or failure. `policy.holdBudgetMs` lowers it; `observe` removes holds entirely.

## T5. Telemetry and redaction leaks

**Threat.** Diagnostics, sink records, reports or the audit trail carry personal data.

**Mitigations.** Telemetry (on by default for `GenClass.init` in a browser on a public host; off by default on localhost
and private networks, where only an explicit `telemetry: true` or options object sends) sends only what [TELEMETRY.md](../../packages/runtime/TELEMETRY.md) lists: decisions, action
outcomes and counts, the hostname and id-normalised route; no page text unless the app opts in with
`telemetry: { include: { situation: true } }`, and never input values of sensitive fields, cookies, headers, bodies
or the sentences describing changes. With situation text opted in, it can carry request names with query strings,
route changes, the page title, short error messages, short typed values and short store values (see TELEMETRY.md).
It is off with `telemetry: false`, `?genclass=no-telemetry`, `localStorage["genclass.telemetry"]="off"`, Global
Privacy Control, and in `createRuntime()`. The transport omits
credentials and the referrer ([telemetry/transport.ts](../../packages/runtime/src/telemetry/transport.ts)); the
collector stores no IP address or user agent. Query values are redacted in situation text and replaced with "…" in
sink evidence and audit entries ([runtime.ts](../../packages/runtime/src/runtime.ts) `redactUrlText`).

**Residual.** Redaction is by name and by the sensitive inputs it saw: a personal value in a field with an ordinary
name (an email in `profile.contact`, a search term, an address) can appear in the situation text and so in telemetry
when situation text is opted in,
`rt.explain()`, the devtools overlay and sinks with `evidence: true`. Add a `redact` function for such fields, set
`telemetry: { include: { situation: false } }`, or turn telemetry off.

Page paths are sent by default: the telemetry `route` (session and decision events) and `SinkRecord.route` replace
id-like segments and, from 0.3.0, any segment holding an `@` (an e-mail address, a handle) with `:id`, but personal
data in other segments (a username or a name in `/u/jane-doe`, a search term in the path) is sent as it is, kept 90
days by the collector and shown among an app's top routes on its dashboard. Apps with such paths should set
`telemetry: false` or route those pages under an id.

App tokens (0.3.0) are public: anyone who reads one from a page can post batches under it to the collector, within
its per-address limits, and so inflate or pollute that app's dashboard counts, routes, function names and recent
rows with values of their choosing. The dashboard inserts every such string as text (`textContent`, escaped HTML),
never as markup, and a token grants no read access (the dashboard needs the private link or the owning account). A
dashboard is therefore a diagnostic view, not an audit record.

## T6. State discovery reading application state

**Threat.** `autoState` hooks React's DevTools interface and the Redux DevTools globals and so sees component and store
state the app never handed to GenClass, including personal data; the hooks could also disturb the framework.

**Mitigations.** Discovered React and Zustand state is observe-only: GenClass records it but never holds, drops,
reverts, rolls back or resyncs it ([state/hub.ts](../../packages/runtime/src/state/hub.ts) `StoreHub.observe`;
`test/invariants/discovery.test.ts` with a hostile model in heal mode). Values that equal a sensitive input's value,
functions, DOM nodes, elements and class instances are not recorded; secret-named fields are redacted; the walk is
bounded (1 ms, 20,000 fibers, 48 component stores). A real React DevTools or Redux DevTools extension keeps working
(theirs run first). `autoState: false` (or `{ react: false }`, `{ redux: false }`, `{ zustand: false }`) turns it off;
`?genclass=off` installs nothing.

**Residual.** Discovered state appears in situation text, and so in telemetry (marked `autoState`), unless redacted or
turned off. Redux stores created through the DevTools compose or enhancer are full adapters: in guard/heal their writes
can be acted on like a registered store's (INTERCEPTION.md). The DevTools hook GenClass installs stays (inert) after
`destroy()`, since React keeps a reference to it.

## T7. A wrong action on a correct app

**Threat.** The model is simply wrong and GenClass changes a correct app's behaviour (the external review asked for
evidence that state invariants, optimistic updates, transactions, offline sync and repeated actions survive this).

**Mitigations.** `observe` is the default and never changes execution. In guard and heal the guarantees below hold
whatever the model answers; `test/invariants/` checks each with an adversarial provider that puts probability 1 on the
most disruptive offered action:

| Guarantee | Test |
|---|---|
| observe never changes delivery timing or content (also for requests whose body is read for an identity) | `observe.test.ts` |
| a repeated user action is coalesced only when mode, policy, protection and the gate all allow it | `observe.test.ts` |
| a non-idempotent request without an idempotency key is never sent twice (retry, hedge) | `network.test.ts` |
| an action that was not offered never runs | `network.test.ts` |
| `requests.protect` endpoints, and what their responses cause, are never held, delayed, retried, cached, coalesced or discarded | `network.test.ts`, `presets.test.ts` |
| the hold budget caps the latency of a held response, request or write | `network.test.ts`, `state.test.ts` |
| an offline outbox drained in order is never reordered or duplicated | `network.test.ts` |
| concurrent writes to different fields are never dropped | `state.test.ts` |
| optimistic update → confirm / server rollback ends in a state the app's own logic produces | `state.test.ts` |
| `disable({ undo: true })` restores what the app would have without GenClass; every global is restored | `state.test.ts`, `interception.test.ts` |
| the breaker demotes the session after undos (and ignores `disable`'s own undos) | `state.test.ts` |
| discovered React and Zustand state is observe-only | `discovery.test.ts` |

**Residual (documented by tests).** With every situation consulted and a model at probability 1: an identical POST
repeated within 2 s can be coalesced in guard (that is the double-submit action; it cannot be undone); a late revert
of an app's own bookkeeping write can make a sync loop send an item again, bounded by `actionLimits.perSubject`; in
heal a request can be answered with a synthetic 503 (`block`). Transactions that span several stores are not
recognised as one unit: an inconsistency `rollback` (heal) restores whole stores to their last consistent snapshot,
including fields other flows wrote. Recommended: `observe` or `requests.protect` for payment, checkout and sign-in
flows.

## T8. Configuration by URL, storage and meta tags

**Threat.** Someone who can make a user open a link, or inject markup, changes GenClass's configuration.

**Mitigations.** `?genclass-mode`, `?genclass-aggr` and `?genclass-sample=0` can only lower the mode, aggressiveness or
sampling, on every host and whatever `debug` says (`?genclass-sample=1` does nothing); `?genclass=off` turns GenClass
off for that visitor only ([runtime.ts](../../packages/runtime/src/runtime.ts) constructor,
[index.ts](../../packages/runtime/src/index.ts) `initUnsafe`). Since 0.2.2 `?genclass=` and `localStorage.genclass`
also only demote, from the app's mode or from `observe` when it sets none: a crafted link can no longer raise a
production site to guard or heal. Since 0.2.3 and 0.3.0-beta.2 `debug: true` is console logging only and no longer lets any
URL or `localStorage` switch raise anything, and only a development host lets `?genclass=` / `localStorage.genclass`
raise the mode ([devhost.ts](../../packages/runtime/src/devhost.ts): http(s) on `localhost`, `127.0.0.1`, `[::1]` or
`*.localhost` with an explicit port, or `*.test`). Hosts that only look local are production hosts there: Capacitor
(`https://localhost`), Tauri (`tauri.localhost`), Electron (`file:`), intranet names, private addresses, `*.internal`
and `*.local` (before 0.2.3 and 0.3.0-beta.2 all of these counted as development hosts, and a link could raise them). With the zero-code
entries (`/auto`, the script tag), only `<meta name="genclass">` tags inside `<head>` are read, so markup injected into
the body cannot configure GenClass, and the model, onnxruntime-web and webhook sink URLs a meta tag names must be
same-origin (cross-origin ones are ignored with a warning; [cdn/config.ts](../../packages/runtime/src/cdn/config.ts)
`sameOriginUrl`). The check resolves each URL as the browser does, with the WHATWG URL parser, against both the page
location and `document.baseURI`: a backslash (`/\evil.example/c`), a tab inside `//`, a scheme in another case or an
injected `<base href>` that moves a relative path off the origin all count as cross-origin. A webhook URL is then made
absolute once, at init ([cdn/sinks.ts](../../packages/runtime/src/cdn/sinks.ts)), so a `<base>` injected later cannot
move it. An injected `sink=webhook:<url>` therefore cannot send the sink records (and their evidence text) to another
origin. The other sink name, `console-json`, only prints to the page's own console. The runtime has no Sentry,
PostHog or Datadog adapter, so an injected `sink=sentry` loads and sends nothing: it only prints one console warning.

**Residual.** Markup injected into `<head>` can still set the mode and same-origin sinks (not a cross-origin model or
webhook): pages that let untrusted HTML into `<head>` should configure through `window.GENCLASS_CONFIG` (it wins) or
`GenClass.init(options)`. A same-origin endpoint that forwards elsewhere is the site's own. A production app served
from a loopback name with an explicit port (an Electron app with an embedded server, a self-hosted local tool on
`http://127.0.0.1:<port>`) counts as a development host, so a crafted link can raise its mode with `?genclass=`; such
apps should not rely on the URL switch being demote-only.

## T9. Cached and shared responses

**Threat.** A response cached or shared by GenClass reaches a request it was not meant for.

**Mitigations.** `serve_cached` (heal) answers only an identical GET (same method, URL, headers and body), from memory
only (≤ 64 responses of ≤ 256 KB, never persisted); `coalesce` (guard) shares the response of an identical request in
flight or finished within 2 s; both mark the response `x-genclass`. Neither is offered for protected or cross-origin
requests ([observe/cache.ts](../../packages/runtime/src/observe/cache.ts), [observe/fetch.ts](../../packages/runtime/src/observe/fetch.ts)).

**Residual.** The identity does not include cookies: in a single-page app where a user signs out and another signs in
without a page load, a heal-mode `serve_cached` could answer a GET with the previous user's cached response. Protect
account and sign-in endpoints (`protectPreset("auth")`), `policy.deny: ["serve_cached"]`, or reload on sign-out.

## T10. The coding-agent bridge

`@genclass/mcp` runs a bridge on the developer's machine (127.0.0.1:47357) that pages with `connectAgent`
(`@genclass/runtime/agent`, development builds) send their recording to, and that a coding agent reads through MCP
tools ([AGENT.md](AGENT.md) section 6).

- **A public website, a router or a captive portal planting findings for the agent.** A page on any site can send a
  CORS "simple" POST to a loopback address. The bridge accepts page traffic only with an `Origin` on this machine
  (localhost, 127.x, [::1], `*.localhost`) or listed exactly in `GENCLASS_AGENT_ORIGINS`; `*.test`, LAN, `*.local` and
  `*.internal` pages (DNS names a hostile network can point anywhere), `null` and missing origins get 403. DNS rebinding (a public name resolving to 127.0.0.1) is
  refused by the `Host` check (it must be the loopback address and port).
- **Another page rewriting a run's evidence** (a replay's verdict, an explore run's final state). A run's events are
  accepted only from the origin that registered it, with the token it got at hello.
- **A page or another user driving the agent API (arming replays, clearing findings, reading them).** `/v1/api`
  refuses any request with an `Origin` and requires `x-genclass-api: 1` (a browser cannot send it cross-origin without
  a preflight, which the bridge refuses) and the bridge's token, readable only by the user who started it
  (`~/.genclass/bridge-<port>.token`, mode 0600).
- **Prompt injection through recorded data.** Whoever controls a page's text or an API's response controls the strings
  the bridge records (error messages, values, page lines). The bridge validates and caps every field, strips control
  characters, ANSI escapes, bidi overrides and invisible characters (tag characters, variation selectors), prints
  page strings JSON-quoted (in titles, channel events and the prompt hook too) under headers that say they are
  recorded data, re-validates its own state file on load, and the server's instructions tell the agent they are never
  instructions. Residual: a model may still be
  swayed by quoted text; keep the agent's own permissions as they are for any untrusted input.
- **Code injection into generated tests.** Page strings enter a generated Playwright test only as JSON string literals.
- **A development page on another device of the network.** Its `connectAgent` is inert there (not this machine's
  host), and would talk to its own device's loopback anyway.
- **Running in production by mistake.** The link is a separate entry imported from a development-only branch; on any
  page not served from the developer's machine it is inert unless `anyHost: true`, and it only ever talks to a loopback
  URL.
- **Files.** The bridge writes its state directory (`state.json`, a `.gitignore` inside it, the hook's cursor) with
  fresh temporary names and mode 0600, never through a planted link, and its token file; `init` merges into
  `.mcp.json` and `.claude/settings.json` and refuses to rewrite a file it cannot parse.

## Residual risks, in one list

1. Same-origin scripts have full access to GenClass and its data (as to the rest of the page).
2. The model card is not pinned by an app-supplied hash; the model's meta gate can lower thresholds unless
   `policy.thresholds` is set; onnxruntime-web's wasm has no sha256 check; SRI covers only the script tag's own file.
3. Adversarial data may flip the classifier within the offered actions of one subject (guard/heal only).
4. Up to 30 model evaluations per minute and one hold budget of latency per held subject can be forced (guard/heal).
5. Name-based redaction misses personal data in ordinarily named fields; with default telemetry, such data in situation
   text leaves the page.
6. Discovered state is read and appears in situation text; DevTools-composed Redux stores are actionable.
7. In guard/heal, identical POSTs within 2 s may be coalesced; heal may block requests or roll back whole stores; a
   late revert may make a loop resend (bounded).
8. Meta tags in `<head>` configure the zero-code entries (mode, same-origin model URLs); a crafted `?genclass=` link
   can raise the mode of a production app served from a loopback name with an explicit port.
9. `serve_cached` ignores cookies (cross-user responses in a long-lived SPA session, heal only).
10. Telemetry and sink routes keep path segments that are neither id-like nor hold an `@` (usernames, names, search
    terms in the path); app tokens are public, so anyone can post forged batches to an app's dashboard (T5).
11. The coding-agent bridge shows the agent text recorded from development pages; quoting and the server's
    instructions reduce, but cannot remove, the chance that a model follows instructions inside that text (T10).

## Recommended production setup

```js
import { GenClass, protectPreset } from "@genclass/runtime";
GenClass.init({
  mode: "observe",                                         // explicit: URL parameters can then only lower it
  requests: { protect: protectPreset("payments", "auth") }, // money and identity flows: never acted on
  policy: { thresholds: { guard: 0.9, heal: 0.8 } },        // gate thresholds you control, not the model's meta
  audit: { sink: (e) => myLogger.info("genclass", e) },    // keep the audit trail
  telemetry: false,                                        // if your privacy review requires it
  model: { baseUrl: "/genclass-model/", ortWasmPaths: "/genclass-model/ort/" }, // self-hosted, with a CSP
});
```

Move to guard route by route once `rt.decisions()` and the audit trail show what it would do (`shadow: "guard"`
records that without acting): `mode: "guard"` with `routes: [{ match: "/search*" }, { match: "*", mode: "observe" }]`
(the first matching rule wins and rules can only lower the mode).
