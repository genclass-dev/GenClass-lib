# Interaction analytics (spec for v1; Pro)

Status: **spec only, nothing implemented.** Written 2026-10-13 on branch `wave2/analytics` from `release/0.3.0`
(`f363e92`). No code in this branch sends anything new. Before any code that sends interaction data is merged, the
owner signs off the decisions in §15 (AGENTS.md rule 8: "Widening what is sent needs the owner's OK"). Target: the
first minor release after 0.3.0, not 0.3.0.

The request (owner, 2026-10-13): "can genclass track the number of clicks and how the user interacts with the
webpage too? because that is valuable information we can provide the developer". Pricing set by the owner the same
day: Free $0; Pro $99 a month ("tracking, analytics, get every data"); Custom $599 a month (custom-built
classifiers). Analytics is a Pro entitlement (`entitlements.analytics` in `billing/plans.json`, being built on
`wave2/billing` and not pushed at the time of writing; its Pro feature list has the line "Interaction analytics
(coming next)").

What does not change: GenClass never makes a correct app worse (AGENTS.md rule 1), sends no page text by default,
and says plainly what it sends. "Every data" in this spec means every interaction the runtime can count per element,
page and request. It does not mean replay, screenshots, typed text or page text (§10).

Contents: [1 Principles](#1-principles) · [2 What v1 captures](#2-what-v1-captures) ·
[3 Element keys](#3-element-keys-without-page-text) · [4 Aggregation](#4-aggregation-in-the-browser-and-flush-cadence) ·
[5 Schema](#5-event-schema-genclass-analytics1) · [6 Bytes per hour](#6-byte-cost-per-hour) ·
[7 Turning it on](#7-turning-it-on-consent-and-opt-outs) · [8 Collector and retention](#8-collector-storage-and-retention-by-plan) ·
[9 Dashboard](#9-dashboard) · [10 Never collected](#10-what-genclass-will-never-collect) ·
[11 Disclosure](#11-disclosure-changes) · [12 Bundle](#12-bundle-budget) · [13 Tests](#13-tests) ·
[14 Plan](#14-staged-plan) · [15 Owner decisions](#15-decisions-for-the-owner) · [A Other tools](#appendix-a-how-other-tools-define-these-metrics) ·
[B Legal notes](#appendix-b-legal-notes-not-legal-advice)

## 1. Principles

1. **Off by default.** Nothing in this spec runs unless the app turns analytics on (§7). Off, the analytics code is
   never loaded (a lazy chunk, like `src/learn/flows.ts`).
2. **Reporting only.** Analytics never holds, delays or changes anything. Its listeners are passive and capture-phase,
   it never calls `preventDefault` or `stopPropagation`, and its errors are caught. It never creates a trigger, a
   diagnosis, an action or a console detection, and nothing it computes reaches the model, the policy gate or a
   decision (AGENTS.md rules 1, 3 and 8). The dead-click and rage-click definitions in §2 are fixed metric
   definitions for counting, like a page-view definition. They are not bug patterns in the decision path (rule 2).
3. **No model-visible change.** `describeElement`, user-op names, event names and the situation text stay as they are
   (rule 3, tag `situation-v2.3`). Analytics computes its own element keys (§3) from the element.
4. **Determinism.** Analytics code uses the injected `Clock` for every time and timer, and `crypto.getRandomValues`
   for its page-load id (rule 5). No `Date.now`, `performance.now`, `Math.random` or global `setTimeout`.
5. **A separate stream from telemetry.** Telemetry goes to the GenClass maintainers to evaluate and train the model.
   Analytics goes to the app's own dashboard, processed for the developer. It has its own endpoint, schema, page-load
   id, queue, storage prefix and retention, and it is never used to train the shared model (§8).
6. **Aggregated in the browser.** The page sends counts per page and element, about once a minute while the user is
   active. It never sends one record per action.

## 2. What v1 captures

What the runtime already records, and what analytics adds. "Existing" means `packages/runtime/src` on `f363e92`
records it today, in memory, for the bug model.

| metric | definition (v1) | source |
|---|---|---|
| clicks per element per page | trusted clicks the runtime recorded as user actions, counted per page (normalised route) and element key (§3) | existing: `observe/dom-user.ts` `onClick`; the key is new (§3) |
| dead clicks | §2.1 | new: one `MutationObserver`, scroll and focus listeners in the chunk; requests, writes and navigation are existing |
| rage clicks | §2.2 | existing click times and causal ops |
| errors and failed requests joined to the click | §2.3 | existing: `trace/ops.ts` (`cause`, `root`), `runtime.ts` `reportError` (the `error` event carries the running op) |
| scroll depth per page | §2.4 | new: a passive scroll listener in the chunk |
| page-to-page flows | §2.5 | existing: `observe/nav.ts` (pushState, replaceState, popstate, hashchange); pagehide is new |
| time to first interaction | §2.6 | existing user actions; the page-view start is new |
| submits, changes, typing bursts, Enter/Escape presses | counts per element; never the value or which characters | existing: `dom-user.ts` `onSubmit`, `onChange`, `onInput`, `onKey` |

How the chunk links its own listeners to the runtime's user ops: the runtime's capture listener (installed at init)
runs before the chunk's (installed later), and `runtime.ts` `user()` makes the user op ambient for the rest of the
event's task (`ctx.stickUser`). The chunk reads the ambient op in its own listener; when it is not a `user` op
recorded for this event (a programmatic or untrusted event, or one inside `[data-genclass-ignore]`, all of which
`dom-user.ts` already drops), the chunk does not count the event. So analytics counts exactly the actions the runtime
records, and never one it ignored.

### 2.1 Dead clicks

A **candidate** is a click on an element whose role is `button`, `link`, `tab`, `menuitem`, `option`, `switch` or
`summary` (native or by `role`). Not candidates: form fields (`input`, `select`, `textarea`, `checkbox`, `radio`,
`label`, contenteditable), whose effect is native (focus, toggle); clicks with a modifier key or a non-primary
button; clicks on a disabled control (counted as `dis`, the flag `dom-user.ts` already records); the second and later
clicks of a double click (`MouseEvent.detail > 1`); and a click on the same element within 1 s of the previous one
(part of a possible rage run, §2.2).

A candidate is **dead** when none of the following happens within `DEAD_MS` = 2,500 ms after the click:

- a request starts whose causal root is the click (`ops.userOf(op)` is the click's user op);
- a store write happens in the click's causal chain;
- the DOM changes anywhere in the document (any `childList`, `attributes` or `characterData` record);
- the route changes, the hash changes, or the page is left (pagehide);
- focus moves to another element, or the page scrolls.

When the tab is hidden before the window ends, the click is not counted either way. The window is fixed in v1 and
matches PostHog's DOM-mutation threshold (2,500 ms; appendix A). It is not learned. A request that starts within the
window makes the click **not dead**, however slowly it answers: slow clicks show in the settle-time histogram (§2.3).
So v1 separates "nothing happened" from "something started and was slow", which the time-window tools in appendix A
count as one.

The `MutationObserver` is connected only while at least one click's window is open, and disconnected at its first
record or when the last window closes. It never reads what changed. A change elsewhere on the page (a ticker, an
animation that edits attributes) makes a click count as alive: that can hide a dead click, never invent one.

### 2.2 Rage clicks

A **rage run** is 3 or more trusted clicks on the same element key, each within `RAGE_MS` = 1,000 ms of the one
before. It is counted once (`rage`), when it reaches 3 clicks. Datadog counts "more than three times in a one-second
sliding window" and Sentry 3 or more clicks within 7 s (appendix A).

A run is **not counted** when every click in it was followed, before the next click, by a store write in its own
chain, a DOM change, or the end of a request it started: the control answered each time (a quantity stepper used
quickly, a "Next" button in a carousel). Other tools list such controls by hand (PostHog's `content_ignorelist`,
Sentry's `slowClickIgnoreSelectors`); here the rule is the same for every control and needs no list.

For each counted run, analytics also counts:

- `wait`: the run happened while a request started by its first click was still open (the user clicked again while
  waiting);
- `dup`: requests started by a later click of the run with the same signature as a request from an earlier click
  that was still open (duplicate submissions). In guard or heal mode the runtime may already have stopped such a
  duplicate; `dup` counts requests that started, whatever the runtime did with them afterwards.

### 2.3 Errors and failed requests joined to the click

Joined by the causal chain, not by time. Every op has a `cause` and a `root` (`trace/ops.ts`); the requests a click's
handlers start have the click as their root (`dom-user.ts` header). Context propagation is best effort
(`trace/context.ts`): an error or request whose chain the runtime lost is not joined, so these counts can miss, and a
background poll that the click did not start is never blamed on it.

Per element, within `JOIN_MS` = 10,000 ms of the click:

| field | counted when |
|---|---|
| `req` | the click's chain started at least one request |
| `reqs` | per request signature (method and normalised path, §5): started, answered ok, 4xx, 5xx, network error or timeout. At most 3 signatures per element per batch, the most frequent first |
| `settle` | for clicks with a request: the time from the click to the end of the last request in its chain, in 6 buckets: under 0.1 s, 0.1 to 0.3 s, 0.3 to 1 s, 1 to 3 s, 3 to 10 s, 10 s or more |
| `fail` | a request in the chain answered 400 or above, or failed with a network error or timeout. Aborted requests (an `AbortController` on unmount) are not failures |
| `silent` | of the `fail` clicks: nothing changed on the page (no DOM change, store write or navigation) within 2,500 ms after the failure. The request failed and the user was not told |
| `err` | the chain raised an uncaught error or an unhandled rejection (`runtime.ts` `reportError` records the running op on the `error` event) |
| `exp` | only with `learn.expectations: true`: the click's learned flow reported a missing step (`expectation` event, docs/runtime/EXPECTATIONS.md §2). Off by default; analytics does not turn it on |

The dashboard shows `settle` as estimated p50 and p95 per element and the share over 3 s. There is no fixed "slow"
threshold in the browser.

### 2.4 Scroll depth

Per page view, the deepest point reached: `(scrollY + innerHeight) / scrollHeight` of the document's scrolling
element, as marks at 25, 50, 75 and 100 %. A page whose content fits the viewport sends `fits` instead, and is left
out of scroll-depth figures. The chunk reads the position at most once every 500 ms while the page scrolls (a clock
timer, after a passive `scroll` event), at the start of a view and at each flush: one layout read per sample. Scroll
inside an element (a scrolling panel, a virtualised list) is not measured in v1.

### 2.5 Page-to-page flows

A **page view** is a page load, or a route change that changes the path (pushState, replaceState, popstate). A
replaceState that changes only the query, and a hash change, are not new views; apps that route by hash count as one
page in v1. Per view, analytics sends where it came from (`from`: the previous view's route, or `(entry)` for the
load) and where it went (`to`: the next route, or `(exit)` on pagehide). No referrer is read or sent.

The collector keeps one-step counts: views per page, entries, exits, and transitions from page A to page B. v1 keeps
no per-visit paths, so multi-step funnels (A then B then C in one visit) are not available (§14, v2).

### 2.6 Time to first interaction

Per page view, the time from the start of the view to the first trusted click, submit, change, Enter or Escape
press, or typing burst, in 5 buckets (under 1 s, 1 to 3 s, 3 to 10 s, 10 to 30 s, 30 s or more), plus `none` for a
view that ended with no interaction. The first view starts when GenClass started (the runtime has no earlier time
without `performance.now`, so a late `init` shortens this value); a later view starts at its route change. A view
during which the tab was hidden before the first interaction is not counted.

## 3. Element keys without page text

An element key names the element the user clicked (the nearest interactive ancestor, as `dom-user.ts` `interactive()`
chooses it) using markup, not visible text. Grammar:

```
key     = role [ "(" sub ")" ] [ anchor ] [ "@" landmark [ anchor ] ] [ "~" structure ] [ " " quoted ]
anchor  = "#" value                 a stable attribute
        | "[" target "]"            links only: where the link goes
sub     = the input type (email, search, number, ...) for role input,
          or the tag when the role comes from a role attribute (button(div))
quoted  = '"' developer label, or masked text when the app opted in '"'
```

| part | how it is formed |
|---|---|
| `role` | the `role` attribute, else from the tag as `dom-user.ts` `roleOf` does (`a` is `link`, a submit input is `button`, ...) |
| `anchor` | the first of `data-testid`, `data-test-id`, `data-test`, `data-cy`, `data-qa`, `id`, `name`. A value is dropped when it contains an e-mail address, a URL or 12 or more hex digits, or a `:` or `«` (ids generated by React `useId` and libraries built on it); in what is kept, every run of digits becomes `n` (`row-12` is `row-n`, so the rows of a list share one key). At most 40 characters |
| `target` | links only, from `href`: a same-origin link's path, normalised like routes (§5); another origin's host only; `mailto` or `tel` as the scheme only, never the address or number; nothing for `javascript:` or `#` |
| `landmark` | the nearest ancestor, crossing open shadow roots (at most 32 levels), among `dialog` (and `role=dialog`, `alertdialog`), `form`, `search` (and `role=search`), `nav`, `header`, `footer`, `aside`, `main`; written with its own anchor when it has one (`@form#checkout`) |
| `structure` | only when the key has no anchor and no quoted part: 6 hex digits of `fnv1a` (`util.ts`) over the tag names from the landmark down to the element, at most 8 levels, without positions or classes. Elements built the same way share it (the rows of a list); it changes when wrappers change |
| `quoted` | `data-genclass-label="..."` on the element (the developer's name for it, passed through the same data check as `protect()` names, `client.ts` `fnLabel`: e-mail, URL, 4 or more digits or 12 or more hex digits make it `[redacted]`), else masked text when the app opted in (below) |

Examples (text off, the default):

| element | key |
|---|---|
| `<button id="place-order">Place order</button>` in `<form id="checkout">` | `button#place-order@form#checkout` |
| `<a href="/products/8f3a9c2e-...">Blue mug</a>` in `<main>` | `link[/products/:id]@main` |
| `<button data-genclass-label="Add to cart">Add</button>` in `<main>` | `button@main "Add to cart"` |
| `<div role="button">Apply</div>` in a dialog, no attributes | `button(div)@dialog~2b3c4d` |
| `<input type="email" name="email">` in `<form id="signup">` | `input(email)#email@form#signup` |
| `<a href="mailto:jane@example.com">Email us</a>` in `<footer>` | `link[mailto]@footer` |

**Text, only when the app opts in** (`analytics: { text: true }`, or `data-genclass-text` on an element or an
ancestor to allow it for that part of the page). The quoted part is then the element's accessible name, computed as
`describeElement` computes it (aria-label, aria-labelledby, label, own text, title, placeholder), for the roles in
§2.1 and form fields only, never for `div`, `span`, `p`, `li`, `td`, `img` or other non-interactive elements, in any
setting. Masking, in this order: e-mail addresses become `[email]`, URLs `[url]`, runs of 12 or more hex digits
`[id]`, every run of digits `#` (`Cart (3)` is `Cart (#)`, `Order 123456` is `Order #`); a name longer than 32
characters after masking is dropped, because long text is more likely content than a label. `data-genclass-text="off"`
on an element or an ancestor turns text off there. A field's value is never part of its name.

**Hashing text was considered and rejected for v1**: a hash of a short label ("Place order") is reversed by guessing,
so it would have to be disclosed as page text anyway, while showing the developer nothing readable.

Exclusions: everything inside `[data-genclass-ignore]` (already never recorded), and everything inside
`[data-genclass-analytics="off"]` (still observed for the bug model, never counted for analytics).

Resolving a key: `findByKey(key)` from a new entry, `@genclass/runtime/analytics`, returns the elements on the
current page whose key matches, so a developer can see which element a structure key names, in their own browser.
The dashboard shows the one-line snippet next to each key. No mapping from keys to text is ever sent.

Limits: elements without an anchor that are built alike share a key; a structure key changes when markup changes;
`n` merges ids that differ only in digits (`step-1`, `step-2`), which a developer separates with
`data-genclass-label` or a `data-testid` without digits.

## 4. Aggregation in the browser and flush cadence

- **State per page load:** the open page view and the views not yet fully sent, each with its route, `from`, its
  time-to-first-interaction, the scroll marks reached, and a map from element key to counters (§5). At most 200
  element keys per page load; actions on further keys are counted in `over` only. At most 32 click windows open at a
  time; when a 33rd opens, the oldest closes without a verdict (not counted as dead).
- **Counts are deltas.** Each batch carries what changed since the previous batch. A click's `n` is counted when it
  happens; its outcome (`dead`, `fail`, `settle`, ...) when its window closes, possibly one batch later.
- **Cadence:** a clock timer of `flushMs` (default 60 s, allowed 30 s to 10 min), armed by the first count after a
  flush. An idle tab sends nothing. Also a flush when the tab becomes hidden and on pagehide (by `sendBeacon`, as
  telemetry does), and on `destroy`. Click windows still open at pagehide close without a verdict.
- **Size:** at most 4 KB per batch (`MAX_BATCH_BYTES`); entries that do not fit stay in memory for the next batch.
  This bounds a page to 60 batches and about 240 KB an hour (§6), whatever happens on it.
- **Transport:** the same native `fetch` and `sendBeacon` telemetry captured at load (`telemetry/transport.ts`), so
  GenClass never observes its own requests. Own failure streak and back-off, with the same rules as telemetry (3
  failures in a row stop the page; a 429 or a 503 with `Retry-After` backs off). A 403 from the collector (§8) stops
  analytics for the rest of the page load. At most one refused batch is kept for retry; nothing else is queued.
- **Withdrawal:** `GenClass.consent("analytics", false)` (§7) removes the listeners, drops every unsent count and
  sends nothing more for the page load.

## 5. Event schema `genclass-analytics/1`

`POST https://genclass.dev/api/v1/analytics` (configurable, §7), `content-type: text/plain;charset=UTF-8` (a CORS
simple request, as telemetry), no credentials, no referrer.

```jsonc
{
  "schema": "genclass-analytics/1",
  "token": "gc_…",          // required: no token, no analytics
  "pid": "9b1e…",           // 24 hex from crypto.getRandomValues, new on every page load, never stored.
                            // Not the telemetry sid: the two streams share no identifier
  "seq": 3,                 // batch number in this page load, from 0 (the collector skips a batch it has seen)
  "sent": 182034,           // ms since analytics started on this page (no wall-clock time)
  "runtime": "0.4.0",
  "consent": "granted",     // "granted" (GenClass.consent) or "not-required" (the app's setting)
  "text": false,            // whether quoted parts may carry masked element names (§3)
  "pages": [
    {
      "v": 2,                       // page-view number in this page load (0 = the load)
      "route": "/checkout",         // the path, normalised
      "from": "/cart",              // first batch of the view only: previous route or "(entry)"
      "to": "/confirmation",        // when the view ended: next route or "(exit)"
      "tfi": 1,                     // once per view: bucket 0 to 4, or 5 for none (§2.6)
      "fits": true,                 // once per view, instead of scroll marks, when the page fit the viewport
      "scroll": [1, 2],             // scroll marks newly reached since the last batch (1 = 25 %, 4 = 100 %)
      "els": {
        "button#place-order@form#checkout": {
          "n": 3, "req": 3, "settle": [0, 0, 2, 1, 0, 0],
          "reqs": { "POST /api/orders": [3, 2, 0, 1, 0] },   // started, ok, 4xx, 5xx, network or timeout
          "fail": 1, "silent": 1
        },
        "button@main~3fa2c1": { "n": 4, "dead": 1, "rage": 1 },
        "form#checkout@main": { "sub": 1 },
        "input(email)#email@form#checkout": { "typ": 2 }
      },
      "over": 0                     // actions on keys past the 200-key cap
    }
  ]
}
```

Element counters, all optional and omitted when 0:

| field | meaning | § |
|---|---|---|
| `n` | clicks | 2 |
| `dis` | clicks on a disabled control | 2.1 |
| `dead` | dead clicks | 2.1 |
| `rage`, `wait`, `dup` | rage runs; of them, runs while the first click's request was open; duplicate requests the runs sent | 2.2 |
| `req`, `reqs`, `settle` | clicks that started a request; per request signature; click-to-settle buckets | 2.3 |
| `fail`, `silent`, `err` | clicks with a failed request; of them, failures nothing on the page answered; clicks whose chain threw | 2.3 |
| `exp` | clicks whose learned flow reported a missing step (`learn.expectations` only) | 2.3 |
| `sub`, `chg`, `typ`, `key` | submits, changes, typing bursts, Enter or Escape presses (counts only) | 2 |

Normalisation of every path the schema carries (`route`, `from`, `to`, link targets, request signatures): the path
only, no query or fragment; id-like segments become `:id` (`util.ts` `normalizePath`, as telemetry's `route`);
segments containing `@` or `%40` become `:id` (as `runtime.ts` `toSinkRecord` does for sink routes); any other segment that
contains an e-mail address, a URL, 4 or more digits in a row or 12 or more hex digits becomes `:id`; at most 120
characters. A request signature is the method and that path (`util.ts` `requestSignature`), with the host for another
origin (`GET api.example.com/v1/charges`). GraphQL requests are all `POST /graphql`; operation names are not read.

What is new compared with telemetry (for §15): element keys, request signatures (telemetry sends request paths only
inside the opt-in situation text), link targets, and the interaction counts. Routes and the app token are already
sent by telemetry.

## 6. Byte cost per hour

Estimated from the schema with a deterministic synthetic workload, `docs/runtime/analytics-cost.mjs` (one tab open
for an hour, 6 routes with 8 element keys each, a batch a minute, uncompressed JSON as sent):

| workload, 1 hour, one tab | batches | bytes |
|---|---|---|
| 6 clicks a minute, a route change every 3 minutes | 60 | 25.5 KB (435 B a batch on average, largest 591 B) |
| 60 clicks a minute, a route change every 3 minutes | 60 | 37.3 KB (636 B, largest 760 B) |
| 60 clicks a minute, a route change every minute | 60 | 36.8 KB (628 B, largest 713 B) |
| a short page view: 45 s, 5 clicks, one batch on pagehide | 1 | 463 B |
| ceiling: every batch at the 4 KB cap | 60 | 240 KB |

The envelope alone is 181 B. Cost grows with the number of distinct keys touched per minute, not with the number of
clicks: 60 clicks on 8 keys cost about as much as 6. For comparison, telemetry's summaries cost about 40.7 KB an hour
on a busy tab, and its test fails if the routine case reaches 300 KB an hour (TELEMETRY.md "Volume").

Measured, for the shape only: a counts-only prototype (not committed; per route, kind and element label, sent inside
telemetry batches) ran through the real runtime in vitest on a fake clock, with 16 labels on 6 routes and the route
changing every 16 actions. It sent 16.3 KB of counts an hour at 6 actions a minute and 135.7 KB at 60 a minute (up to
96 route and label pairs), and its first-load hook cost 0.06 KB (§12). The v1 test (§13) replaces the estimates above with
measured numbers and asserts the ceiling.

## 7. Turning it on: consent and opt-outs

### Options

```ts
GenClass.init({
  token: "gc_…",
  analytics: true,                 // or an options object; false = off, and the dashboard cannot turn it on
});

analytics?: boolean | {
  consent?: "required" | "not-required"; // default "required" (decision §15.2)
  text?: boolean;                         // masked names of interactive elements in keys (§3); default false
  local?: boolean;                        // also on local and private hosts; default false
  endpoint?: string;                      // your own collector; default https://genclass.dev/api/v1/analytics
  flushMs?: number;                       // default 60_000; 30_000 to 600_000
  sample?: number;                        // share of page loads; default 1
};

GenClass.consent(purpose: "analytics", granted: boolean): void
rt.analytics: { readonly state: "off" | "waiting" | "on"; readonly reason?: string; flush(): Promise<void> }
```

Zero-code installs: `analytics=on` and `analytics-consent=not-required` in the meta tag, `data-analytics` and
`data-analytics-consent` on the script tag, `window.GENCLASS_CONFIG.analytics` (`src/cdn/config.ts`).

`GenClass.consent` can be called before or after `init`; before, it is kept for the page load and applied at init.
For the script tag before it loads: `window.GENCLASS_CONFIG = { consent: { analytics: true } }`. GenClass stores no
consent: the site's consent tool remembers it and calls `GenClass.consent` on each page load. v1 ships the call and
documented snippets for common consent tools; built-in adapters (Google Consent Mode, IAB TCF) are v2.

### When it runs

Analytics runs on a page only when every row below allows it, checked in this order at init and again when consent
or the dashboard switch changes. `rt.analytics.reason` names the first row that stopped it.

| # | stops analytics | reason |
|---|---|---|
| 1 | `analytics` is false, or unset and the dashboard did not start it (below) | `option` |
| 2 | no valid token | `no-token` |
| 3 | `enabled: false`, `?genclass=off` or `localStorage.genclass = "off"` | `disabled`, `kill-switch` |
| 4 | `telemetry: false` set by the developer (decision §15.4) | `telemetry-off` |
| 5 | `?genclass=no-telemetry` or `?genclass=no-analytics` in the URL | `url` |
| 6 | `localStorage` `genclass.telemetry` or `genclass.analytics` is `"off"` | `localStorage` |
| 7 | Global Privacy Control (`navigator.globalPrivacyControl === true`) | `gpc` |
| 8 | Do Not Track (`navigator.doNotTrack === "1"`, or `window.doNotTrack === "1"`) | `dnt` |
| 9 | a local or private host (`telemetry/config.ts` `isLocalHost`) without `local: true` | `local` |
| 10 | not a browser (no `window` or `document`; `GenClass.init` is inert there) | `headless` |
| 11 | not sampled (`sample`), no `crypto.getRandomValues`, no transport | `sampled-out`, `no-crypto`, `no-transport` |
| 12 | consent required and not granted | state `waiting` |
| 13 | the collector answered 403 (the app is not on a plan with analytics, or its dashboard switch is off) | `refused` |

Telemetry's own sampling (`telemetry.sample`) and its default-off on local hosts do not stop analytics, which has its
own rows 9 and 11. The signal values in rows 5 to 8 are read in the page and never sent. While `waiting`, the chunk
is not loaded and nothing is recorded for analytics (the runtime's own in-memory observation for the bug model goes
on as before). When consent arrives, analytics starts from that moment; nothing from before consent is sent.

A visitor's lasting objection: `localStorage.setItem("genclass.analytics", "off")`, which a site's privacy page can
set from a button (the "simple means of objecting" the UK statistics exception asks for, appendix B).

### The dashboard switch (Pro apps)

Each Pro app's dashboard has one setting with three values:

| value | effect |
|---|---|
| **Pages that ask** (default) | the collector accepts analytics from pages whose code turned it on (`analytics: true`, `analytics=on`) |
| **Every page** | also starts analytics on pages whose code did not mention it (`analytics` unset), with the consent mode chosen on the dashboard (wait for consent, or not required) |
| **Off** | the collector refuses all analytics for the app (403); pages stop for the page load |

"Every page" is how a developer turns analytics on without a code change. The page learns it from the reply to its
first telemetry batch: for a token whose app is on a plan with analytics and set to "Every page", the collector adds
the header `x-genclass-analytics: on; consent=required` (or `consent=not-required`) to its 202 response and exposes
it to the page (`access-control-expose-headers`). The telemetry transport reads that one header, and when it says
`on` and the page's `analytics` option is not `false`, the runtime imports the chunk. Consequences: it needs telemetry
on (sent by `fetch`, not a beacon), so it starts about 10 s after load (telemetry's first batch). Clicks before
that are not counted per element: the runtime's event buffer (500 events by default, `runtime.ts` `historySize`)
keeps their description and time but not the element, and the key needs the element (§3). When consent is not
required, the page view's `from` and its time to first interaction are taken from that buffer (routes and times
only). A page whose code says `analytics: false` never starts, whatever the dashboard says. Whether the
dashboard may start collection on pages that never asked for it is decision §15.3.

Free apps: the collector refuses analytics (403, plan), never sends the header, and the dashboard shows the feature
as part of Pro. A self-hosted collector (`analytics.endpoint`, `telemetry-worker/` deployed to any Cloudflare account)
applies no plan.

### Console lines

Printed by the lazy chunk, so they cost no first-load bytes:

- when analytics starts: `[GenClass] Interaction analytics is on: counts of clicks, scrolling and page changes per
  element, without page text, sent to this app's GenClass dashboard. Opt out: ?genclass=no-analytics.` With
  `text: true`, "without page text" reads "with the masked names of buttons and links, no other page text".
- with `debug: true` only, the reason it is off or waiting, once: `[GenClass] Interaction analytics is waiting for
  consent: GenClass.consent("analytics", true).`

## 8. Collector, storage and retention by plan

The worker `genclass-telemetry` (`telemetry-worker/`) gets a second ingest route.

- **`POST /api/v1/analytics`:** validates the schema (§5) and the token; looks up the token's app, account and plan
  (`telemetry-worker/src/plans.ts` on `wave2/billing`, `entitled(plan, "analytics")`) and the dashboard switch. Not
  entitled or switched off: 403 with a short JSON reason, nothing stored. Same body limits as the event collector
  (256 KB, which a 4 KB batch never approaches); its own rate limit per page-load id (10 batches per 60 s) next to the
  per-IP one (the IP is only the counter key, never stored). No country, no user agent, no IP, no header is kept;
  unknown fields are dropped.
- **Never in the training data.** Analytics batches are never written under the R2 `events/` prefix, which holds the
  telemetry batches used to evaluate and train the model (TELEMETRY.md "Use"). Raw batches go to
  `analytics/dt=YYYY-MM-DD/<uuid>.jsonl.gz` with their own lifecycle rule, only to rebuild aggregates after a
  collector bug; they are not exported and not read by any training job.
- **Aggregates in D1**, new migration `0005_analytics.sql` (`0004` is billing's on `wave2/billing`): `ui_daily`
  (token, day, route, element key, metric, count), `ui_req_daily` (token, day, route, element key, request
  signature, outcome, count), `ui_flow_daily` (token, day, from route, to route, count), and a dedup table of
  (SHA-256 of `pid`, `seq`) kept 2 days, as the `sessions` table does for telemetry. Analytics has its own budget of
  400 counters per batch, so it never pushes telemetry counters out (`dashboard.ts` `MAX_COUNTERS` is 300 per batch
  and silently drops new keys past it). Per app and day, at most 5,000 distinct (route, element) pairs; the rest go to
  an `(other)` row. Routes, keys and signatures are at most 120 characters, as `dashboard.ts` `KEY_MAX`.

Retention by plan (`billing/plans.json` on `wave2/billing`: Free `history_days` 7 and `analytics: false`; Pro and
Custom `history_days` 365 and `analytics: true`):

| data | Free | Pro | Custom |
|---|---|---|---|
| analytics accepted | no (403) | yes | yes |
| daily aggregates (`ui_*` tables) | none | 365 days | 365 days |
| raw batches (R2 `analytics/`) | none | 7 days (decision §15.6) | 7 days |
| dedup state | none | 2 days | 2 days |
| after the plan ends | none | aggregates kept 30 days (`GRACE_DAYS` in `plans.ts`), visible and exportable, then deleted | same |
| export | none | daily aggregates as CSV or JSONL, by download or API (the Pro `export` entitlement) | same |
| use for a model | never | never | only for that customer's own private model, with a separate written opt-in (decision §15.10); never the shared model |

Deleting an app or an account deletes its analytics at once, as it does dashboard data today (PRIVACY.md). Daybot
processes analytics on the developer's instructions: the developer is the controller, Daybot the processor (§11).

## 9. Dashboard

A new **Interactions** section on each Pro app's dashboard (`/dashboard/<secret>` and `/account/apps/<id>`), over
7, 30, 90 or 365 days (daily data; no hourly view in v1):

- **Overview:** page views, clicks, dead-click share, rage runs, silent failures, and the change from the previous
  period.
- **Top clicked elements**, for all pages or one: key, clicks, dead, rage, failed, errors, settle p50 and p95.
- **Dead and rage clicks with the requests behind them:** elements ranked by dead plus rage counts; for each, the
  request signatures its clicks started with their outcomes (ok, 4xx, 5xx, network), `wait`, duplicates sent, and,
  when the app also has GenClass detections on that route, a link to them.
- **Errors after clicks:** elements by `err`, `fail` and `silent`.
- **Scroll depth per page:** share of views that reached 25, 50, 75 and 100 %, and how many fit the viewport.
- **Flows:** top transitions, entry pages, exit pages, and the next-page distribution for a chosen page.
- **Per page:** views, time-to-first-interaction distribution, clicks, top elements, scroll depth.
- **Export:** the daily aggregates as CSV or JSONL (Pro `export`).
- **Naming help:** how keys are formed, `data-genclass-label` and `data-testid`, and the `findByKey` snippet for
  structure keys.
- **The switch** (§7) and what each value sends, with a link to the disclosure text a developer can copy into their
  own privacy policy.

Every metric has a one-line definition on hover that matches §2, including what it cannot see.

## 10. What GenClass will never collect

In any plan, with any option:

- **Keystrokes and input values:** never which keys were pressed (only counts of typing bursts and of Enter or Escape
  presses), never typed text, `input`, `select` or `textarea` values, contenteditable content or file names.
- **Page text by default:** unless the app opts in (`text: true`, or `data-genclass-text` on part of the page), no
  visible text is sent. With it, only the masked names of buttons, links and form fields (§3); never the text of
  other elements.
- **Screenshots, DOM snapshots, session replay or video.**
- **Pointer coordinates, mouse movement, hover or touch paths.** v2 heatmaps are per element, from counts (§14).
- **Cross-site identifiers:** no cookies, nothing stored in `localStorage` or `sessionStorage` by analytics, a
  page-load id that is never stored and is not the telemetry session id, nothing shared across apps; the collector
  never joins data across tokens.
- **Fingerprints:** no device, browser, screen, timezone, language or hardware fields, and no hash of IP address or
  user agent.
- **Stored IP addresses, user agents, referrers, cookies or request headers.** Cloudflare's rate limiter keys on the
  IP for the request; the worker never stores it.
- **Full URLs:** no query strings or fragments; link targets as a normalised path or a host only.
- **Request or response bodies and headers, storage contents, the clipboard.**
- **Who the user is:** there is no `identify()` call; GenClass cannot connect analytics to a person or an account.

§13 lists the tests for these.

## 11. Disclosure changes

Required by AGENTS.md rule 8 before the collector accepts analytics in production:

| where | change |
|---|---|
| console | the lines in §7, printed by the chunk |
| `packages/runtime/TELEMETRY.md` | a section "Interaction analytics (a separate stream)": the schema (§5), endpoint, storage, retention, never-collected list, and the new opt-outs (`?genclass=no-analytics`, `genclass.analytics`, DNT) in the opt-out table; the remote-start header |
| `PRIVACY.md` | a section on interaction analytics for website owners: what, why (the developer's dashboard), Daybot as processor, retention by plan, the never-collected list, how visitors opt out, rights requests through the website owner. Calls the data "pseudonymous", not "anonymous" (appendix B) |
| `README.md` and `packages/runtime/README.md` | "Privacy and telemetry" (analytics is off by default, what it sends when on), "Your dashboard" (the Interactions section), "Costs" (the chunk's size, the bytes per hour) |
| `packages/runtime/CHANGELOG.md`, `docs/runtime/API.md`, `docs/runtime/OPTIONS-SPEC.md`, `src/types.ts` JSDoc | the option, `GenClass.consent`, `rt.analytics`, `@genclass/runtime/analytics` |
| site: `privacy.html` | a section "Interaction analytics", matching PRIVACY.md |
| site: pricing (`billing/plans.json`) | replace "Interaction analytics (coming next)" with what it is: "Interaction analytics: clicks, dead and rage clicks with the requests behind them, scroll depth and page flows, without page text" |
| site: `terms.html` | the processor terms by reference to the DPA |
| new: data processing agreement | GDPR Art. 28 terms, a UK addendum, a CCPA service-provider schedule, PIPEDA 4.1.3 and Quebec Law 25 s. 18.3 terms; breach notice; deletion or return at the end; reviewed by counsel |
| new: sub-processor list | Cloudflare (Workers, R2, D1) for analytics; Stripe for billing account data only; a statement that analytics is not copied to the training infrastructure; a change-notice process |

## 12. Bundle budget

- **First load** (both `/auto` and the main entry): the gate, `GenClass.consent`, the `analytics` keys in
  `src/cdn/config.ts`, and the telemetry transport reading `x-genclass-analytics`. Budget: under 0.3 KB gzip on
  each entry. The current limits (`test/bundle.test.ts` `LIMIT_KB`, 107.74 and 99.71 KB, owner-approved for 0.3.0)
  leave 0.18 KB on `/auto` (107.56 KB measured, CI run 38485063587) and 0.12 KB on the main entry (99.59 KB). The
  prototype's gate cost 0.06 KB on each. If v1's first-load part needs more than that headroom, raising `LIMIT_KB`
  is decision §15.7.
- **The chunk:** `src/analytics/` behind a dynamic import, loaded only when analytics will run; target 4 KB gzip or
  less, printed and limited in `bundle.test.ts`, with marker strings asserted absent from the first load as for
  `flows.ts` and the sinks. For scale: PostHog's lazy dead-click module, `dead-clicks-autocapture.js`, transfers 8.5 KB gzip
  (measured with curl on 2026-10-13); the prototype's counts-only chunk was 732 B.
- **Script tag:** the chunk is a separate file, `dist/analytics.js`, loaded with `load("analytics.js")` in
  `src/cdn/global.ts` as the sink adapters are. The prototype showed the IIFE build inlining a plain dynamic import.
- **Runtime cost:** per click, one ancestor walk of at most 32 elements reading attributes (no layout read), one
  clock timer and a `MutationObserver` only while a click window is open; per 500 ms of scrolling, one layout read.
  Budgets go in `test/review-perf.test.ts`.

## 13. Tests

Runtime (`packages/runtime/test/analytics.test.ts`, vitest, `setup()` from `test/helpers.ts` with a fake clock and
server; the CONTRACT section named in each `describe`):

- **Gates:** each row of §7 alone turns analytics off with its reason; `analytics: false` blocks the dashboard
  header; `waiting` loads no chunk and sends nothing; consent granted later sends nothing from before it;
  `GenClass.consent("analytics", false)` drops unsent counts and sends nothing more; no analytics request at all
  without a token.
- **Element keys:** one fixture per row of §3 (precedence, generated ids, digits to `n`, link targets, landmarks
  across shadow roots, structure hashes); with text off, no text from the fixture page appears in any request body;
  with text on, masking of e-mails, URLs, hex, digits and long names; non-interactive elements never carry text;
  `data-genclass-text="off"`, `data-genclass-analytics="off"` and `data-genclass-ignore`.
- **Never collected (§10):** a seeded page with typed secrets, an e-mail in a link, query strings, fragments and a
  long product description; every request body is scanned for each; `localStorage.setItem`,
  `sessionStorage.setItem` and `document.cookie` are spied and never called by analytics; no device field in any
  body; the `pid` differs from the telemetry `sid`.
- **Metrics:** a click that starts a request is not dead however slow; a click with no request, write, DOM change,
  navigation, focus change or scroll is dead; each liveness signal alone makes it alive; form fields, modifier
  clicks, disabled controls and double clicks are not candidates; a hidden tab gives no verdict. Rage: 3 clicks
  within 1 s each count once; a stepper that answers each click is not counted; `wait` and `dup` with an open
  request. Joins: a failed request in the chain (4xx, 5xx, network) counts `fail`, an abort does not; `silent` only
  when nothing changed after the failure; an error in the chain counts `err`, a background poll's failure counts
  nothing. Scroll marks, `fits`, flows with `(entry)` and `(exit)`, replaceState with the same path, and the
  time-to-first-interaction buckets.
- **Volume:** an hour at 6 and at 60 clicks a minute on a fake clock: measured bytes and requests printed for
  RESULTS.md; the 4 KB batch cap and the 200-key cap hold; a worst case stays at or under 240 KB an hour.
- **Determinism:** the same inputs give byte-identical batches.
- **Never feeds a decision:** with analytics on and off, the same scripted session gives byte-identical situations
  and the same decisions and actions; the review tests (`test/review-*.test.ts`) pass unchanged.
- **Bundle:** first-load growth within §12; the chunk absent from the first load; the script tag's file without the
  chunk.

Collector (`telemetry-worker/test/`): schema validation; 403 for Free tokens, unknown tokens and "Off"; the header
only for entitled apps set to "Every page"; dedup by (`pid`, `seq`) including concurrent repeats; aggregation into
the three tables; the 400-counter and 5,000-pair caps; nothing under `events/`; retention by plan and the grace
period; export contents.

Not in CI (ask first, per AGENTS.md): a Playwright run in real Chromium (MutationObserver timing, scroll, `sendBeacon`
on pagehide, a visible tab), and a false-report measurement on correct apps: the demos' correct runs and the
`realapps/` sweep with scripted clicks whose effect is known, counting dead and rage clicks reported on controls that
worked. That rate goes to `docs/runtime/RESULTS.md` next to the counts, as FIR goes next to recall, and the dashboard
shows it beside each metric's definition.

## 14. Staged plan

| stage | what | done when |
|---|---|---|
| 0 | owner decisions (§15); counsel reviews the DPA | each item in §15 answered |
| v1a, runtime | `src/analytics/` (keys, metrics, aggregation, transport), the gate, `GenClass.consent`, `rt.analytics`, `@genclass/runtime/analytics` (`findByKey`), the zero-code keys, the header read; tests in §13 | AGENTS.md "definition of done"; measured bytes in RESULTS.md |
| v1b, collector | the route, plan and switch gate, D1 migration, R2 prefix and lifecycle rule, retention by plan, export, the header on telemetry replies | worker tests pass; nothing under `events/` |
| v1c, dashboard | the Interactions section and the switch | reviewed on a test app with real traffic from a visible tab |
| v1d, disclosure | every row of §11, the DPA and sub-processor list published | before the collector accepts analytics in production |
| v1e, measurement | false dead and rage clicks on correct apps (§13) | published in RESULTS.md and on the dashboard |
| v2 | heatmaps by element: the dashboard opens the developer's own page with an overlay that resolves keys to elements in their browser (`findByKey`) and colours them by clicks, dead and rage counts; no coordinates or screenshots collected. Also: consent-tool adapters, multi-step funnels (needs a decision on per-visit data), scroll inside elements, hash routing and a `route` naming option, form abandonment counts, forwarding interaction findings through the existing sinks (PostHog, Sentry, Datadog) so a team can open a replay in the tool it already runs, and app-specific outcome labels for Custom | each a separate spec section and owner OK where it widens what is sent |

## 15. Decisions for the owner

1. **The fields sent** (rule 8): element keys (role, tag or input type, stable attributes, landmark, structure
   hash, developer labels), link targets, request signatures with third-party hosts, and the counts in §5. Request
   signatures are not sent by telemetry today outside the opt-in situation text.
2. **Consent default:** `consent: "required"` (recommended: EU guidance puts this transmission under ePrivacy
   Art. 5(3), Quebec requires profiling functions off by default, appendix B) or `"not-required"` (easier start; the
   developer must add consent where it is needed).
3. **Remote start ("Every page"):** may the dashboard start collection on pages whose code never mentioned analytics?
   Recommended yes, with `analytics: false` as a hard off, the console line, and an audit entry on the account.
4. **`telemetry: false` also stops analytics?** As specified (row 4), a developer who turns off diagnostics to the
   maintainers loses analytics too. The alternative is to let `analytics: true` run with `telemetry: false`, which
   the separate streams allow.
5. **Text in keys:** allow `text: true` in v1 (masked, interactive elements only), or keys from markup and developer
   labels only.
6. **Raw batch retention:** 7 days (recommended, for rebuilding aggregates) or none (aggregate on receipt only);
   and whether Pro export includes raw batches.
7. **First-load budget:** approve up to 0.3 KB more per entry if v1's gate does not fit the 0.18 / 0.12 KB left.
8. **Pro wording:** "get every data" against §10. The proposed feature line is in §11.
9. **Legal:** counsel for the DPA, whether Daybot needs an EU and UK representative (GDPR Art. 27), and whether
   telemetry's "anonymous" wording should also become "pseudonymous".
10. **Custom plan:** may a Custom customer's analytics train their private model (separate written opt-in), never
    the shared one?
11. **Existing telemetry and consent:** whether `GenClass.consent` should also gate telemetry for sites that need
    consent for it (separate from this spec; narrowing needs no OK, changing the default does).

## Appendix A: how other tools define these metrics

From vendor documentation and source read on 2026-10-13. Every one of them decides "dead" and "error" by time
windows; LogRocket and Datadog also relate frustration to network requests by timing.

| tool | dead click | rage click | link to requests | default text |
|---|---|---|---|---|
| PostHog | no DOM mutation within 2.5 s, scroll or selection within 100 ms, visibility or focus within 1 s (`posthog-js` `dead-clicks-autocapture.ts`; no network signal in that file) | `rageclick` on by default | none in the dead-click code | autocapture sends element text up to 1,024 characters, classes and attributes by default (`autocapture.ts`; posthog.com/docs/libraries/js/config) |
| Sentry Replay | no DOM update or scroll within 7 s, on button, input and a only | 3 or more clicks in that 7 s window | none | masks all text and media (docs.sentry.io session-replay privacy) |
| FullStory | "nothing on the page changes within a few seconds" | yes | error clicks: a click "right before" an error | text unmasked unless Private by Default; inputs masked for accounts created since 2021-11-10 (help.fullstory.com) |
| Microsoft Clarity | "no feedback in a reasonable amount of time" | yes | click errors: errors "after a user click" | numbers and e-mails masked in Balanced mode; consent signals enforced for EEA, UK and CH since 2025-10-31 (learn.microsoft.com/clarity) |
| Datadog RUM | one of its frustration signals (definition not compared here) | "more than three times in a one-second sliding window" | an action counts requests in progress until 100 ms of no activity, which its docs call inaccurate with polling or streaming | v7 default `mask-user-input` |
| LogRocket | "no visible effect (ie. a DOM change)" | yes | "Frustrating Network Requests": impatient mouse actions during a long request (Pro plan) | text sanitising opt-in |
| GenClass v1 | no request, store write, DOM change, navigation, focus change or scroll within 2.5 s (§2.1) | 3 or more within 1 s each, not counted when the control answered each click (§2.2) | causal: the request's root op is the click (§2.3) | none by default (§3) |

GenClass is not the only tool that relates clicks to requests. What it adds is a causal join that does not depend on
timing, the separation of dead from slow from silently failed, and a dashboard without replay or page text.

## Appendix B: legal notes (not legal advice)

- **ePrivacy Art. 5(3).** EDPB Guidelines 2/2023 v2.0 (adopted 7 October 2024): script code that instructs the
  browser to send information is "gaining of access" (para 33), also when the information is computed locally
  (para 53), while information used only inside the device is not, "as long as the information does not leave the
  device" (para 44). So the runtime's in-memory observation today is outside it, and the analytics transmission is
  inside it; analytics is not "strictly necessary" for a service the user asked for, hence consent by default in the
  EEA.
- **Exemptions.** The CNIL audience-measurement exemption (guidance of 4 July 2025) and the UK statistical-purposes
  exception (ICO guidance on storage and access technologies) both require the provider to act only for the site,
  not reuse the data for itself, not link it with other data, and produce aggregate statistics; the ICO excludes
  "logs or recordings of individual visitors". The design here (processor only, never training, per-app partitions,
  daily aggregates, short raw retention, an objection switch) is meant to let a developer rely on them with
  `consent: "not-required"` where they apply. The UK exception's commencement date was seen only in secondary
  sources.
- **Quebec.** CAI Guidelines 2023-1 (B.4): functions that allow profiling must be off by default and turned on by a
  positive action; its example uses clicks, pages and time on page.
- **Pseudonymous, not anonymous.** A page-load id, routes and element keys can single out a visit, so analytics is
  personal data under GDPR Art. 4(1) and Recital 30, described as pseudonymous.
- **Roles.** For analytics the developer is the controller and Daybot the processor (GDPR Art. 28); for telemetry
  used to train the shared model, Daybot is a controller. Keeping the two streams apart (§1) keeps the roles apart.
