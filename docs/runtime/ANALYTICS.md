# Interaction analytics (spec for v1; Pro)

Status: **spec only, nothing implemented.** Written 2026-10-13 on branch `wave2/analytics` from `release/0.3.0`
(`f363e92`) and revised the same day after a privacy review and an engineering review of the first draft (22
findings; §16 records each one, what changed, and where a finding was corrected or not followed, and why). Code
references were checked on `f363e92`; bundle sizes come from `release/0.3.0` at `0613c32`. No code in this branch
sends anything new. Before any code that sends interaction data is merged, the owner signs off the decisions in §15
(AGENTS.md rule 8: "Widening what is sent needs the owner's OK"). Target: the first minor release after 0.3.0, not
0.3.0.

The request (owner, 2026-10-13): "can genclass track the number of clicks and how the user interacts with the
webpage too? because that is valuable information we can provide the developer". Pricing set by the owner the same
day: Free $0; Pro $99 a month ("tracking, analytics, get every data"); Custom $599 a month (custom-built
classifiers). Analytics is a Pro entitlement (`entitlements.analytics` in `billing/plans.json` on `wave2/billing`,
pushed at `1ff61f2`; its Pro feature list has the line "Interaction analytics (coming next)").

What does not change: GenClass never makes a correct app worse (AGENTS.md rule 1), sends no page text by default (in
v1, in no setting: §3), and says plainly what it sends. "Every data" in this spec means every interaction the runtime
can count per element, page and request. It does not mean replay, screenshots, typed text or page text (§10).

Contents: [1 Principles](#1-principles) · [2 What v1 captures](#2-what-v1-captures) ·
[3 Element keys](#3-element-keys-without-page-text) · [4 Aggregation](#4-aggregation-in-the-browser-and-flush-cadence) ·
[5 Schema](#5-event-schema-genclass-analytics1) · [6 Cost](#6-byte-and-collector-cost) ·
[7 Turning it on](#7-turning-it-on-consent-and-opt-outs) · [8 Collector and retention](#8-collector-storage-and-retention-by-plan) ·
[9 Dashboard](#9-dashboard) · [10 Never collected](#10-what-genclass-will-never-collect) ·
[11 Disclosure](#11-disclosure-changes) · [12 Bundle](#12-bundle-budget) · [13 Tests](#13-tests-and-ship-gates) ·
[14 Plan](#14-staged-plan) · [15 Owner decisions](#15-decisions-for-the-owner) · [16 Review log](#16-review-log) ·
[A Other tools](#appendix-a-how-other-tools-define-these-metrics) · [B Legal notes](#appendix-b-legal-notes-not-legal-advice)

## 1. Principles

1. **Off by default.** Nothing in this spec runs unless the page's code turns analytics on or grants analytics
   consent (§7). The dashboard can stop analytics or make its consent stricter; it never starts it on a page whose
   code did neither. Off, the analytics code is never loaded (a lazy chunk, like `src/learn/flows.ts`).
2. **Reporting only.** Analytics never holds, delays or changes anything. Its listeners are passive and capture-phase,
   it never calls `preventDefault` or `stopPropagation`, and its errors are caught. It never creates a trigger, a
   diagnosis, an action or a console detection, and nothing it computes reaches the model, the policy gate or a
   decision (AGENTS.md rules 1, 3 and 8). The dead-click and rage-click definitions in §2 are fixed metric
   definitions for counting, like a page-view definition. They are not bug patterns in the decision path (rule 2).
   A count can be wrong (§2 says where, §13 measures how often); the app is never changed.
3. **No model-visible change.** `describeElement`, `util.ts` `normalizePath`, user-op names, event names and the
   situation text stay as they are (rule 3, tag `situation-v2.3`). Analytics computes its own element keys (§3) and
   applies its own stricter path rule (§5) in `src/analytics/`. The only first-load change to an observer is an
   optional element hook in `dom-user.ts` (§2), which renders nothing.
4. **Determinism.** Analytics code uses the injected `Clock` for every time and timer, and `crypto.getRandomValues`
   for its page-load id (rule 5). No `Date.now`, `performance.now`, `Math.random` or global `setTimeout`.
5. **A separate stream from telemetry.** Telemetry goes to the GenClass maintainers to evaluate and train the model.
   Analytics goes to the app's own dashboard, processed for the developer. It has its own endpoint, schema, page-load
   id, queue, storage and retention, and it is never used to train the shared model (§8). Neither stream's settings
   switch the other: `telemetry: false` does not stop analytics, and analytics needs no telemetry batch to start (§7).
6. **Aggregated in the browser and on receipt.** The page sends counts per page and element, about once a minute
   while the user is active, never one record per action. The collector adds them to per-app counters and keeps no
   per-visit record beyond the short in-memory state listed in §8.
7. **Enforced, not only tested.** Each promise in §10 names the code that enforces it in the browser and the check
   that enforces it again at the collector.

## 2. What v1 captures

What the runtime already records, and what analytics adds. "Existing" means `packages/runtime/src` on `f363e92`
records it today, in memory, for the bug model.

| metric | definition (v1) | source |
|---|---|---|
| clicks per element per page | trusted clicks the runtime recorded as user actions, counted per page (normalised route, §5) and element key (§3) | existing: `observe/dom-user.ts` `onClick`, passed to analytics by a new element hook (below); the key is new (§3) |
| dead clicks | §2.1 | new: `MutationObserver`s on the document and on open shadow roots, and focus, blur, scroll, selection and resource-timing listeners in the chunk; requests, writes and navigation are existing |
| rage clicks | §2.2 | existing click times and causal ops; the answers of §2.1 |
| requests, failures and errors joined to the click | §2.3 | existing: `trace/ops.ts` (`cause`, `root`), `runtime.ts` `reportError`; new: two internal fields on fetch ops (below) |
| scroll depth per page | §2.4 | new: a passive scroll listener in the chunk |
| page-to-page flows | §2.5 | existing: `observe/nav.ts` (pushState, replaceState, popstate, hashchange); `pageshow` is new |
| time to first interaction | §2.6 | existing user actions and the clock's time origin |
| submits, changes, typing bursts, Enter/Escape presses | counts per element; never the value or which characters | existing: `dom-user.ts` `onSubmit`, `onChange`, `onInput`, `onKey`, through the same hook |

**How the chunk sees the runtime's user actions.** `dom-user.ts` gains an optional hook, `onAction(kind, element)`,
called inside its own listener right after `sink.user` recorded the action. The chunk sets the hook when it loads and
clears it when it stops. So analytics counts exactly the actions the runtime records: a programmatic `click()` (such
as `hiddenFileInput.click()` inside a click handler), an untrusted event, or one inside `[data-genclass-ignore]` is
dropped by `dom-user.ts` before the hook runs, and an app listener that calls `stopImmediatePropagation` cannot hide
an event from analytics alone, because analytics adds no listener of its own for actions. The hook passes the element,
never `describeElement`'s text. The chunk never reads the `target` or `value` of the runtime's user events, which hold
page text for the bug model (§10). With `observe.user` off there are no actions to count, and with `observe.nav` off no
page views: analytics then stays off with the reason `no-observer` (§7).

**Two internal fields on fetch ops**, so outcomes are counted as the app received them (§2.3): `by: "genclass"` on the
retry and hedge ops the runtime starts (`observe/fetch.ts` starts `retryOp` with `cause: failedOp` and hedges with
`cause: op`, so today they sit in the click's chain like the app's own requests), and `delivered` on the original op:
the outcome its promise resolved with, from a retry, a hedge or `serve_cached`. Neither field is rendered in the
situation text; the exact-text tests show it.

### 2.1 Dead clicks

A **candidate** is a click on an element whose role is `button`, `link`, `tab`, `menuitem`, `option`, `switch` or
`summary` (native or by `role`). Not candidates:

- form fields (`input`, `select`, `textarea`, `checkbox`, `radio`, `label`, contenteditable), whose effect is native
  (focus, toggle);
- clicks with a modifier key or a non-primary button;
- clicks on a disabled control (counted as `dis`, below);
- the second and later clicks of a multi-click (`MouseEvent.detail > 1`), and a click on the same element within 1 s
  of the previous one (part of a possible rage run, §2.2);
- controls whose effect is outside the page or already in place: an element with a `download` attribute; a link
  whose `href` scheme is not `http`, `https` or relative (`mailto:`, `tel:`, `blob:`, ...); an element with
  `aria-selected="true"`, `aria-current`, `aria-haspopup` or `aria-expanded` (the selected tab, the link to the current
  page, menu and disclosure triggers, which may open on hover or on `mousedown`); a link whose normalised target (§5)
  equals the current route;
- a custom element (a tag name with a hyphen) without an open shadow root: a closed shadow root can change with no
  mutation analytics can observe;
- anything inside `[data-genclass-analytics="no-dead"]`, the marker for controls whose effect v1 cannot see (below).

A candidate gets its verdict `JOIN_MS` = 10,000 ms after the click. It is **alive** when one of the following happens
within `DEAD_MS` = 2,500 ms, **late** when the first of them happens between 2.5 s and 10 s, and **dead** when none
happens within 10 s:

- a request starts anywhere on the page (fetch, XHR, a WebSocket send, an EventSource), whatever its causal chain;
- a resource load starts anywhere on the page (a script, a style sheet, a dynamic `import()` chunk, an image: a
  `PerformanceObserver` entry of type `resource` whose `startTime` falls in the window);
- a store write happens anywhere on the page;
- the DOM changes in the document, in any open shadow root `dom-user.ts` has adopted, or in a shadow root on the
  click's composed path (any `childList`, `attributes` or `characterData` record; one `MutationObserver` with
  `subtree: true` on the document does not see inside shadow roots, so each root gets its own);
- the route changes, the hash changes, or the page is left (pagehide);
- focus moves, either in the window or from the click's own `pointerdown` in the 500 ms before the click (a
  `:focus-within` menu opens at `mousedown`, before the click), or the window loses focus (`blur`: a file picker, a
  print or share dialog, a new tab);
- the page or an element scrolls, the selection changes (`selectionchange`), or `beforeprint` fires.

Every signal counts from anywhere on the page, so an unrelated change (a ticker, a poll, an animation that edits
attributes) makes a click count as alive. For the signals listed, that can hide a dead click and cannot invent one.
§13 measures how many it hides (recall) and makes it a ship gate. Late clicks are counted apart (`late`); the
dashboard shows them as slow, not dead.

**What v1 cannot see**, so it can still report a dead click on a correct app: a copy through `navigator.clipboard`, a
download started from an anchor that is never attached to the page, a share sheet that does not take focus from the
window, a change inside a closed shadow root of a widget whose host is not the clicked element, and a change drawn only
on a canvas. Mark such controls `data-genclass-analytics="no-dead"`; the dashboard's definition of the metric says
so. The false-dead rate on correct apps is measured and gated before the dashboard shows dead clicks (§13).

When the tab is hidden before the verdict, or the page is left with the window still open, the click gets no verdict.
`cand` (§5) counts candidates with a verdict, so the dead share is `dead / cand`. The two windows are fixed in v1, not
learned: 2.5 s matches PostHog's DOM-mutation threshold (appendix A), 10 s is `JOIN_MS`.

The observers (mutation and resource timing) are connected only while at least one click's window is open, and
disconnected at their first record (every open window is answered then) or when the last window closes. They never
read what changed.

`dis` counts clicks the runtime records with the disabled flag `dom-user.ts` already sets: in practice controls with
`aria-disabled="true"`, or a `disabled` attribute on an element that is not a form control. Browsers do not dispatch
`click` to a natively `disabled` form control (HTML Standard, "disabled" form controls), so those clicks are not seen
in v1. Whether `pointerdown` reaches them consistently across browsers is checked in the
Chromium spec (§13) before it is counted.

### 2.2 Rage clicks

A **rage run** is `RAGE_N` = 4 or more trusted clicks on the same element key within a sliding window of
`RAGE_MS` = 1,000 ms, on a dead-click candidate role (§2.1). Form fields and non-interactive elements never form a
run, so selecting a paragraph or an address with a triple click, ticking three rows of a checkbox list, or a number
input's spinner is not rage. Datadog counts "more than three times in a one-second sliding window", Sentry 3 or more
clicks within 7 s (appendix A). The §13 measurement reports the false-rage rate with 3 and with 4 clicks; the owner may
lower `RAGE_N` to 3 if it meets the gate (§15.12).

A run ends 1 s after its last click and is decided then. It is counted once (`rage`) unless every click in it was
answered, before the next click (the last one: within 1 s), by a DOM change, a store write, a `change`, `input` or
`selectionchange` event, or the end of a request it started. Such a control answered each time (a quantity stepper
used quickly, a carousel's "Next"). Sibling controls that share a key (the rows of a list) count as one key, and a run
across them that the page answered is not counted.

For each counted run, analytics also counts:

- `wait`: the run happened while a request started by its first click was still open (the user clicked again while
  waiting);
- `dup`: requests started by a later click of the run with the same signature as a request from an earlier click
  that was still open (duplicate submissions). In guard or heal mode the runtime may already have stopped such a
  duplicate; `dup` counts requests the app started, whatever the runtime did with them afterwards.

### 2.3 Requests, failures and errors joined to the click

Joined by the causal chain, not by time. Every op has a `cause` and a `root` (`trace/ops.ts`); the requests a click's
handlers start have the click as their root (`dom-user.ts` header). Context propagation is best effort
(`trace/context.ts`; `observe/timers.ts` wraps only `setTimeout` and `setInterval`): a request or error whose chain the
runtime lost (started from `requestAnimationFrame`, a `MessageChannel`, an observer callback or a worker) is not
joined, so these counts can miss. A background poll that the click did not start is never blamed on it. (Dead clicks
do not depend on the chain: §2.1 counts a request from anywhere as an answer.)

Counted by what the app received. One entry per request the app's code started in the click's chain. A retry or hedge
GenClass started (`by: "genclass"`) is not a new start, and neither is a request with the same signature as an earlier
request in the chain that failed (an app-level retry: React Query's default of 3 retries, an axios refresh-and-replay
after a 401); both count in `retry`. An entry's outcome is what its last attempt delivered to the app.

Per element, within `JOIN_MS` = 10,000 ms of the click:

| field | counted when |
|---|---|
| `req` | the click's chain started at least one request |
| `reqs` | per request signature (§5): started, ok, 4xx, 5xx, network error or timeout, by the delivered outcome. At most 3 signatures per element per batch, the most frequent first, plus an `(other)` entry with the rest, so `reqs` sums to every start |
| `retry` | attempts after the first, by GenClass or by the app |
| `healed` | requests whose delivered answer GenClass changed (a retry's, a hedge's or a `serve_cached` answer; guard and heal modes only) |
| `settle` | for clicks with a request: the time from the click to the first moment no request in its chain is open, in 6 buckets: under 0.1 s, 0.1 to 0.3 s, 0.3 to 1 s, 1 to 3 s, 3 to 10 s, still open at 10 s (a chain that polls stays in the last) |
| `fail` | a request's delivered outcome was 400 or above, a network error or a timeout. Aborted requests (an `AbortController` on unmount) are not failures; a 401 that the app refreshed and replayed with success is not a failure |
| `silent` | of the `fail` clicks: nothing answered within 2,500 ms after the chain's last failure (no DOM change, store write, navigation, or new request in the same chain). The request failed and the user was not told |
| `err` | the chain raised an uncaught error or an unhandled rejection (`runtime.ts` `reportError` records the running op on the `error` event) |
| `exp` | only with `learn.expectations: true`: the click's learned flow reported a missing step (`expectation` event, docs/runtime/EXPECTATIONS.md §2). Off by default; analytics does not turn it on |

The envelope carries `mode` (§5), so the dashboard can say where GenClass changed answers. The dashboard shows
`settle` as estimated p50 and p95 per element and the share over 3 s. There is no fixed "slow" threshold in the
browser.

### 2.4 Scroll depth

Per page view, the deepest point reached: `(scrollY + innerHeight) / scrollHeight` of the document's scrolling
element, as marks at 25, 50, 75 and 100 %. Samples come only from `scroll` events, at most one every 500 ms (a clock
timer after a passive `scroll` event), and none in a view's first 500 ms. So no sample is taken at the route change
itself: `nav.ts` calls its hook synchronously inside `pushState`, before the router renders or resets the scroll
position, and a sample there would credit the previous page's position to the new view.

When the view ends, one more read decides `sc`: `fits` when the document did not scroll and its content fit the
viewport, `inner` when the document did not scroll but an element did (an app shell that scrolls a panel), absent
otherwise. Views with `fits` or `inner` are left out of scroll-depth figures. One layout read per sample. Scroll depth
inside an element (a scrolling panel, a virtualised list) is not measured in v1.

### 2.5 Page-to-page flows

A **page view** is a page load, a restore from the back/forward cache (`pageshow` with `persisted: true`), or a route
change that changes the normalised route (§5) through pushState, replaceState or popstate. So `/products/1` to
`/products/2` is one view, and a replaceState that changes only the query, or a hash change, is not a new view; apps
that route by hash count as one page in v1. A view that ends within 1 s of its start without an interaction (an auth
redirect, `/` to `/en`, a trailing-slash fix) is merged into the next view, which takes its `from`.

Per view, analytics sends `from` in the view's first batch: the previous view's route, `(entry)` for the load,
`(restore)` for a back/forward-cache restore (timers restart; `pid` and `seq` continue), or `(start)` for the view that
was open when analytics started (after consent, §7), which is left out of flows and of time to first interaction. No
referrer is read or sent (decision §15.13 asks whether a same-origin referrer's route may be).

The collector counts a transition from each view's `from` only, so each one is counted once. Exits are inferred at
the collector: a page load's last view counts as its exit when no batch with that `pid` arrives for 30 minutes (the
aggregator holds each `pid` and its current route in memory for that time, never on disk, §8). pagehide often does not
fire on mobile, so a page-side exit marker would undercount. A tab left idle for 30 minutes counts as an exit even if
the visitor comes back to it.

Multi-page sites (a new document per page) send one view per page load with `from: "(entry)"`, so every view is an
entry and an exit and no transitions exist. For an app where most page loads have a single view, the dashboard marks
flows as not measured (§9).

The collector keeps one-step counts: views per page, entries, exits, and transitions from page A to page B. v1 keeps
no per-visit paths, so multi-step funnels (A then B then C in one visit) are not available (§14, v2).

### 2.6 Time to first interaction

Per page view, the time from the start of the view to the first trusted click, submit, change, Enter or Escape press,
or typing burst, in 5 buckets (under 1 s, 1 to 3 s, 3 to 10 s, 10 to 30 s, 30 s or more), plus `none` for a view that
ended with no interaction. View 0 starts at clock time 0: the browser clock is `performance.now()` (`src/clock.ts`),
measured from the navigation's time origin, so a late `init` does not shorten the value and tests stay deterministic
(the fake clock also starts at 0). A later view starts at its route change, a restored view at `pageshow`. Not
counted: a view during which the tab was hidden before the first interaction, and a `(start)` view.

## 3. Element keys without page text

An element key names the element the user clicked (the element `dom-user.ts` passes to the hook: the nearest
interactive ancestor, or the clicked element itself, as `interactive()` chooses it) from markup, never from visible
text. Grammar:

```
key     = role [ "(" sub ")" ] [ anchor ] [ "@" landmark [ anchor ] ] [ "~" structure ] [ " " label ]
anchor  = "#" value                 a stable attribute (not on links)
        | "#?"                      an anchor the collector withheld (below)
        | "[" target "]"            links only: where the link goes
sub     = the input type (email, search, number, ...) for role input,
          or the tag when the role comes from a role attribute (button(div))
label   = '"' developer label '"'
```

| part | how it is formed |
|---|---|
| `role` | the `role` attribute, else from the tag as `dom-user.ts` `roleOf` does (`a` is `link`, a submit input is `button`, ...) |
| `anchor` | the first of `data-testid`, `data-test-id`, `data-test`, `data-cy`, `data-qa`, `id`, `name` that passes every rule below; when none passes, the key has no anchor. Rules: no e-mail address, URL, 12 or more hex digits, `:` or `«` (ids generated by React `useId` and libraries built on it); no whitespace and only printable ASCII (an id built from a title, or a name in another script, is page text in another form); every run of digits becomes `n` (`row-12` is `row-n`, so the rows of a list share one key); at most 40 characters; and at most 3 distinct values on the page for the same role, landmark and structure hash. A fourth distinct value means the attribute names records (`call-jane-doe`, `call-john-roe`, ...), so from then on that family keys by structure for the rest of the page load |
| `target` | links only, from `href`; links are keyed by target, not by attributes. A same-origin link's route (§5); another origin's host only; `mailto` or `tel` as the scheme only, never the address or number; nothing for `javascript:` or `#` |
| `landmark` | the nearest ancestor, crossing open shadow roots (at most 32 levels), among `dialog` (and `role=dialog`, `alertdialog`), `form`, `search` (and `role=search`), `nav`, `header`, `footer`, `aside`, `main`; written with its own anchor when one passes the rules above (`@form#checkout`) |
| `structure` | only when the key has no anchor of its own and no label: 6 hex digits of `fnv1a` (`util.ts`) over the tag names from the landmark down to the element, at most 8 levels, without positions or classes. Elements built the same way share it (the rows of a list); it changes when wrappers change |
| `label` | `data-genclass-label="..."` on the element: the developer's name for it, passed through the data check of `protect()` names (`client.ts` `fnLabel`: e-mail, URL, 4 or more digits or 12 or more hex digits make it `[redacted]`), at most 32 characters. The attribute is for fixed names: a label that renders data (`data-genclass-label={contact.name}`) sends that data, and the docs say so |

**At the collector, every literal waits for 5 page loads.** An anchor value, a label, and each path segment of a
route or link target that is not `:id` is stored only after batches from at least 5 different page loads (`pid`s)
carried it on the same day. Until then the collector stores `#?` for the anchor, `:id` for the segment, and no label.
The aggregator holds the waiting values in memory for the day and never writes them (§8). So a value one visitor's page
produced (an id on one contact's page in a small app, a typed term in a path) never reaches storage, while
`place-order` on a checkout page does within its first page loads. A value that 5 page loads share in a day, such as
a popular public profile's slug, is stored; §10 says so. Small apps see more `#?` early in the day, and the dashboard
explains it.

Examples (the browser side; the right column is what is stored):

| element | key sent | stored |
|---|---|---|
| `<button id="place-order">Place order</button>` in `<form id="checkout">` | `button#place-order@form#checkout` | the same, once 5 page loads sent it that day |
| `<a href="/products/8f3a9c2e-...">Blue mug</a>` in `<main>` | `link[/products/:id]@main` | the same |
| `<button data-genclass-label="Add to cart">Add</button>` in `<main>` | `button@main "Add to cart"` | the same, once 5 page loads sent it |
| `<div role="button">Apply</div>` in a dialog, no attributes | `button(div)@dialog~2b3c4d` | the same |
| `<input type="email" name="email">` in `<form id="signup">` | `input(email)#email@form#signup` | the same, once 5 page loads sent it |
| `<a href="mailto:jane@example.com">Email us</a>` in `<footer>` | `link[mailto]@footer` | the same |
| `<button id="call-jane-doe">Call</button>` in each row of a contacts list in `<main>` | `button#call-jane-doe@main` for the first 3 rows, then `button@main~5d02c1` | `button#?@main` (no id has 5 page loads), `button@main~5d02c1` |
| `<a href="/u/jane-smith">Jane</a>` in `<main>` | `link[/u/jane-smith]@main` | `link[/u/:id]@main` until `jane-smith` has 5 page loads in a day |

**Text from the page: not in v1** (the recommended answer to decision §15.5). Keys come from markup and developer
labels only. The first draft allowed the accessible name with `text: true`, masked; that sends page text the masking
does not catch. `describeElement` follows `aria-labelledby` into any element (a message subject, a person's name), and
the names of options and menu items in comboboxes and autocomplete lists are suggestions built from what the user
typed: an address autocomplete gives `# Main Street, Springfield` after masking, 32 characters or fewer. If the owner
allows text in a later version, these limits apply, and §10 and the console line change to say exactly what is sent:

- read only from `aria-label`, the element's own text, `title` or a button input's value; never through
  `aria-labelledby`;
- never for `option` or `menuitem`, anything inside `role=listbox`, a combobox's popup (the element its
  `aria-controls` names), or an `aria-live` region;
- never for a link whose normalised target contains `:id` (a link to one record, named by that record's title or a
  person's name);
- masked as the first draft specified (e-mails `[email]`, URLs `[url]`, 12 or more hex digits `[id]`, digit runs `#`),
  names over 32 characters dropped;
- at most 3 distinct names per key family (role, landmark, structure) on a page, then none for that family;
- written in single quotes (`'Place order'`), so the collector can reject page text when the envelope says
  `text: false` (§8), and subject to the 5-page-load rule;
- `data-genclass-text="off"` on an element or an ancestor turns it off there.

**Hashing text was considered and rejected**: a hash of a short label ("Place order") is reversed by guessing, so it
would have to be disclosed as page text anyway, while showing the developer nothing readable.

Exclusions: everything inside `[data-genclass-ignore]` (already never recorded), and everything inside
`[data-genclass-analytics="off"]` (still observed for the bug model, never counted for analytics).
`[data-genclass-analytics="no-dead"]` is counted but never judged dead (§2.1).

Resolving a key: `findByKey(key)` from a new entry, `@genclass/runtime/analytics`, returns the elements on the
current page whose key matches, so a developer can see which element a structure key names, in their own browser.
The dashboard shows the one-line snippet next to each key. No mapping from keys to text is ever sent.

Limits: elements without an anchor that are built alike share a key; a structure key changes when markup changes;
`n` merges ids that differ only in digits (`step-1`, `step-2`), which a developer separates with
`data-genclass-label` or a `data-testid` without digits; `#?` and `:id` hide values until 5 page loads share them.

## 4. Aggregation in the browser and flush cadence

- **State per page load:** the open page view and the views not yet fully sent, each with its route, `from`, time to
  first interaction, the scroll marks reached, and a map from element key to counters (§5).
- **Key cap per batch, not per page load:** at most 200 keys pending. A key is freed once its deltas are sent and no
  open click window or join refers to it, so a tab open for days (webmail, a dashboard, an admin tool) keeps
  counting per element. Actions on keys past the cap count in the view's `over`.
- **Click windows and joins are separate.** Dead-click tracking holds at most 64 open windows (10 s each, so about 6
  clicks a second sustained); when a 65th opens, the oldest stops tracking liveness and gets no verdict. Joins (§2.3)
  are kept for every click for `JOIN_MS`, in a map from user op to key bounded at 256 entries (about 25 clicks a
  second sustained), so a click evicted from dead-click tracking still counts its `fail`, `err` and `settle`.
- **Per-event cost:** the chunk listens to runtime events (op starts and ends, store writes) only to answer open
  windows and joins. While none is open its handler returns after one check, so an app that writes stores hundreds of
  times a second pays one comparison per write.
- **Counts are deltas.** Each batch carries what changed since the previous batch. A click's `n` is counted when it
  happens; its outcome (`dead`, `fail`, `settle`, ...) when its window or join closes, possibly one batch later.
- **Cadence:** a clock timer of `flushMs` (default 60 s, allowed 30 s to 10 min), armed by the first count after a
  flush. An idle tab sends nothing. Also a flush when the tab becomes hidden, on pagehide, on `destroy` and on
  `rt.analytics.flush()`. Click windows still open at pagehide close without a verdict.
- **Size:** at most 4 KB per batch (`MAX_BATCH_BYTES`); entries that do not fit stay in memory for the next batch.
  Timer batches are at most `3,600 / flushMs` (in seconds) an hour: 60 at the default, 120 at 30 s. Each hide,
  pagehide or `flush()` call adds one. So at the default a page sends at most 240 KB an hour from the timer, plus 4 KB
  per extra flush (§6).
- **Transport:** the native `fetch` captured at load (`telemetry/transport.ts`), so GenClass never observes its own
  requests, with `credentials: "omit"`, `referrerPolicy: "no-referrer"`, and `keepalive: true` for the hidden and
  pagehide flushes. A beacon is used only where `fetch` with `keepalive` is not available. A beacon cannot set those
  options: it carries the page's own `Referer` under the page's referrer policy (with `unsafe-url`, the full URL with
  its query) and is sent with credentials (genclass.dev's session cookie is `SameSite=Lax`, so it is not sent on this
  cross-site POST). §10 and §11 disclose that case.
- **Config first:** before recording anything, the chunk asks the collector whether this app may send (§7). A Free or
  switched-off app records nothing and sends no batch.
- **Failures:** a 429, or a 503 with `Retry-After`, backs off as telemetry does. After 3 failures in a row, analytics
  pauses for 5 minutes, then 10, then 30, and then tries every 30 minutes, keeping counts within the caps; a
  `securitypolicyviolation` event naming the endpoint (a CSP blocks it) stops analytics for the page load. A 403
  (§8) stops it for the page load. At most one refused batch is kept for retry, resent byte-identical with the same
  `seq`; nothing else is queued.
- **Withdrawal:** `GenClass.consent("analytics", false)` (§7) removes the hook and the listeners, drops every unsent
  count and sends nothing more for the page load.

## 5. Event schema `genclass-analytics/1`

`POST https://genclass.dev/api/v1/analytics` (configurable, §7), `content-type: text/plain;charset=UTF-8` (a CORS
simple request, as telemetry), `credentials: "omit"`, `referrerPolicy: "no-referrer"` (the beacon fallback is the
exception, §4).

```jsonc
{
  "schema": "genclass-analytics/1",
  "token": "gc_…",          // required: no token, no analytics
  "pid": "9b1e…",           // 24 hex from crypto.getRandomValues, new on every page load, never stored by the page.
                            // Not the telemetry sid: the two streams share no identifier
  "seq": 3,                 // batch number in this page load, from 0 (the collector skips a batch it has seen)
  "sent": 182034,           // ms since analytics started on this page (no wall-clock time)
  "runtime": "0.4.0",
  "mode": "observe",        // the runtime's effective mode: observe, guard or heal (§2.3)
  "sample": 1,              // analytics.sample in effect, so the dashboard can scale counts and say they are sampled
  "consent": "granted",     // "granted" (GenClass.consent) or "not-required" (the page's own setting, §7)
  "text": false,            // always false in v1 (§3)
  "pages": [
    {
      "v": 2,                       // page-view number in this page load (0 = the load)
      "route": "/checkout",         // the path, normalised (below)
      "from": "/cart",              // first batch of the view only: previous route, "(entry)", "(restore)" or "(start)"
      "tfi": 1,                     // once per view: bucket 0 to 4, or 5 for none (§2.6)
      "scroll": [1, 2],             // scroll marks newly reached since the last batch (1 = 25 %, 4 = 100 %)
      "sc": "fits",                 // in the batch that closes the view: "fits" or "inner" (§2.4); absent otherwise
      "els": {
        "button#place-order@form#checkout": {
          "n": 3, "cand": 3, "req": 3, "settle": [0, 0, 2, 1, 0, 0],
          "reqs": { "POST /api/orders": [3, 2, 0, 1, 0] },   // started, ok, 4xx, 5xx, network or timeout
          "fail": 1, "silent": 1
        },
        "button@main~3fa2c1": { "n": 5, "cand": 2, "dead": 1, "rage": 1 },
        "form#checkout@main": { "sub": 1 },
        "input(email)#email@form#checkout": { "typ": 2 }
      },
      "over": 0                     // actions on keys past the per-batch key cap (§4)
    }
  ]
}
```

Element counters, all optional and omitted when 0:

| field | meaning | § |
|---|---|---|
| `n` | clicks | 2 |
| `cand` | dead-click candidates that got a verdict (alive, late or dead) | 2.1 |
| `dis` | clicks on a control flagged disabled (mostly `aria-disabled`) | 2.1 |
| `dead`, `late` | dead clicks; clicks first answered between 2.5 s and 10 s | 2.1 |
| `rage`, `wait`, `dup` | rage runs; of them, runs while the first click's request was open; duplicate requests the runs sent | 2.2 |
| `req`, `reqs`, `settle` | clicks that started a request; per request signature, with an `(other)` entry; click-to-settle buckets | 2.3 |
| `retry`, `healed` | attempts after the first; requests whose delivered answer GenClass changed | 2.3 |
| `fail`, `silent`, `err` | clicks with a failed request; of them, failures nothing on the page answered; clicks whose chain threw | 2.3 |
| `exp` | clicks whose learned flow reported a missing step (`learn.expectations` only) | 2.3 |
| `sub`, `chg`, `typ`, `key` | submits, changes, typing bursts, Enter or Escape presses (counts only) | 2 |

**Paths.** Every path the schema carries (`route`, `from`, link targets, same-origin request signatures) goes through
`src/analytics/paths.ts` `analyticsPath`, and the collector applies it again (§8):

1. the path only, no query or fragment;
2. `util.ts` `normalizePath`, as telemetry's `route` (numbers, UUIDs, long hex, long mixed tokens and short slug ids
   become `:id`);
3. then any segment that, decoded, contains whitespace, `+`, a character outside printable ASCII, `@`, an e-mail
   address, a URL, 4 or more digits in a row or 12 or more hex digits, or is longer than 24 characters, becomes `:id`
   (a typed search term or an address in a path);
4. at one path position under the same prefix, the fourth and later distinct values in a page load become `:id`. At
   the collector, more than 20 distinct values at one position under one prefix in a day make that position `:id` for
   the app for the rest of the day, and the 5-page-load rule of §3 applies to every literal segment;
5. at most 120 characters.

`normalizePath` itself does not change (it shapes model-visible text, rule 3); the stricter rule lives in analytics
only. A request signature is the method and, for the page's own origin, that path (`POST /api/orders`). For another
origin it is the method and the host only (`GET api.mapbox.com`), as link targets are. GraphQL requests are all
`POST /graphql`; operation names are not read.

| path | `normalizePath` alone (telemetry today) | sent by analytics | stored |
|---|---|---|---|
| `/u/jane-smith` | `/u/jane-smith` | `/u/jane-smith` | `/u/:id` until the value has 5 page loads in a day |
| `/search/divorce-lawyer` | `/search/divorce-lawyer` | `/search/divorce-lawyer` | `/search/:id`, the same rule |
| `/search/divorce%20lawyer` | `/search/divorce%20lawyer` | `/search/:id` | `/search/:id` |
| `/s/Toronto--ON/homes` | unchanged | unchanged | `/s/:id/homes` until 5 page loads |
| `GET https://api.mapbox.com/geocoding/v5/mapbox.places/123%20Main%20St.json` | `GET api.mapbox.com/geocoding/v5/mapbox.places/123%20Main%20St.json` | `GET api.mapbox.com` | `GET api.mapbox.com` |

(The second column was produced by running `normalizePath` and `requestSignature` from `f363e92`.)

What is new compared with telemetry (for §15.1): element keys, same-origin request signatures and the hosts of
third-party requests (telemetry sends request paths only inside the opt-in situation text), link targets, the
interaction counts, `mode` and `sample`, and the config request (§7). Routes and the app token are already sent by
telemetry, with the weaker path rule in the second column above (§16, P1).

## 6. Byte and collector cost

### Bytes from the page

Estimated from the schema with a deterministic synthetic workload, `docs/runtime/analytics-cost.mjs` (one tab open
for an hour, 6 routes with 8 element keys each, a batch a minute, uncompressed JSON as sent; updated for the revised
schema):

| workload, 1 hour, one tab | batches | bytes |
|---|---|---|
| 6 clicks a minute, a route change every 3 minutes | 60 | 28.8 KB (492 B a batch on average, largest 622 B) |
| 60 clicks a minute, a route change every 3 minutes | 60 | 40.6 KB (694 B, largest 828 B) |
| 60 clicks a minute, a route change every minute | 60 | 40.8 KB (696 B, largest 824 B) |
| a short page view: 45 s, 5 clicks, one batch on pagehide | 1 | 495 B |
| ceiling from the timer at the default `flushMs` (60 s) | 60 | 240 KB, plus 4 KB per hide, pagehide or `flush()` batch (§4) |

Plus the config request (§7): at most one a page load, answered from the browser's HTTP cache for 5 minutes; a
60-byte request line and a 32-byte reply body, plus headers.

The envelope alone is 209 B. Cost grows with the number of distinct keys touched per minute, not with the number of
clicks: 60 clicks on 8 keys cost about as much as 6. For comparison, telemetry's summaries cost about 40.7 KB an hour
on a busy tab, and its test fails if the routine case reaches 300 KB an hour (TELEMETRY.md "Volume").

Measured, for the shape only: a counts-only prototype (not committed; per route, kind and element label, sent inside
telemetry batches) ran through the real runtime in vitest on a fake clock, with 16 labels on 6 routes and the route
changing every 16 actions. It sent 16.3 KB of counts an hour at 6 actions a minute and 135.7 KB at 60 a minute (up to
96 route and label pairs), and its first-load hook cost 0.06 KB (§12). The v1 test (§13) replaces the estimates above
with measured numbers and asserts the ceiling.

### Collector cost (estimates; v1b measures them)

Cloudflare D1 on Workers Paid (developers.cloudflare.com/d1/platform/pricing and /limits, read 2026-10-13): $1.00 per
million rows written after 50 million a month, and the 50 million are shared by every app on the account; an index
adds a written row when a write includes the indexed column; each database runs queries one at a time; a database
holds at most 10 GB, a limit that cannot be raised.

| design | D1 rows written | at 10M page views a month |
|---|---|---|
| an upsert per counter per batch (the first draft) | 45 to 90 per 3-minute page view (3 batches of 15 to 30 counters) | 450M to 900M rows: $450 to $900 a month before the account's included 50M, on a $99 plan |
| a per-app aggregator that writes changed counters once a minute (§8) | one per counter touched in that minute, whatever the page views | an app touching 500 counters every minute of the day: 21.6M rows a month, at most about $22; most apps far less |

Storage, assuming about 100 bytes a row with its index, daily rows kept 90 days and monthly roll-ups for a year (§8):

| app | daily rows | stored for a year |
|---|---|---|
| typical: 300 (route, element) pairs, 10 metrics each | 3,000 | about 40 MB |
| at the cap: 5,000 pairs, 20 metrics each | 100,000 | about 1.5 GB |

A 10 GB database therefore holds about 6 apps at the cap or a few hundred typical ones, so analytics is sharded by
account (§8). A monthly page-view quota per plan is decision §15.15.

## 7. Turning it on: consent and opt-outs

### Options

```ts
GenClass.init({
  token: "gc_…",
  analytics: true,                 // or an options object; false = off, and nothing on the dashboard changes that
});

analytics?: boolean | {
  consent?: "required" | "not-required"; // default "required" (decision §15.2)
  local?: boolean;                        // also on local and private hosts; default false
  endpoint?: string;                      // your own collector; default https://genclass.dev/api/v1/analytics
  flushMs?: number;                       // default 60_000; 30_000 to 600_000
  sample?: number;                        // share of page loads; default 1
};

GenClass.consent(purpose: "analytics" | "telemetry", granted: boolean): void
rt.analytics: { readonly state: "off" | "waiting" | "on"; readonly reason?: string; flush(): Promise<void> }
```

There is no `text` option in v1 (§3). Zero-code installs: `analytics=on` and `analytics-consent=not-required` in the
meta tag, `data-analytics` and `data-analytics-consent` on the script tag, `window.GENCLASS_CONFIG.analytics`
(`src/cdn/config.ts`).

`GenClass.consent` can be called before or after `init`; before, it is kept for the page load and applied at init.
For the script tag before it loads: `window.GENCLASS_CONFIG = { consent: { analytics: true } }`. GenClass stores no
consent: the site's consent tool remembers it and calls `GenClass.consent` on each page load. v1 ships the call and
documented snippets for common consent tools; built-in adapters (Google Consent Mode, IAB TCF) are v2.

`GenClass.consent("telemetry", granted)` switches telemetry on or off after `init`, so a site that starts with
`telemetry: false` until consent no longer has to destroy and re-create the runtime, as TELEMETRY.md advises today.
It ships in v1a and is a prerequisite for recommending GenClass to sites in the EEA, the UK and Quebec (§15.11,
appendix B). It turns nothing on by default.

### When it runs

Analytics runs on a page only when every row below allows it, checked in this order at init and again when consent
or the config reply changes. `rt.analytics.reason` names the first row that stopped it.

| # | stops analytics | reason |
|---|---|---|
| 1 | `analytics` is false, or unset and no consent call started it under the dashboard switch (below) | `option` |
| 2 | no valid token | `no-token` |
| 3 | `enabled: false`, `?genclass=off` or `localStorage.genclass = "off"` | `disabled`, `kill-switch` |
| 4 | `?genclass=no-telemetry` or `?genclass=no-analytics` in the URL | `url` |
| 5 | `localStorage` `genclass.telemetry` or `genclass.analytics` is `"off"` | `localStorage` |
| 6 | Global Privacy Control (`navigator.globalPrivacyControl === true`) | `gpc` |
| 7 | Do Not Track (`navigator.doNotTrack === "1"`, or `window.doNotTrack === "1"`) | `dnt` |
| 8 | a local or private host (`telemetry/config.ts` `isLocalHost`) without `local: true` | `local` |
| 9 | not a browser (no `window` or `document`; `GenClass.init` is inert there) | `headless` |
| 10 | `observe.user` or `observe.nav` is off (no actions or page views to count) | `no-observer` |
| 11 | not sampled (`sample`), no `crypto.getRandomValues`, no transport | `sampled-out`, `no-crypto`, `no-transport` |
| 12 | consent required and not granted | state `waiting` |
| 13 | the config reply or the collector refused (the app is not on a plan with analytics, or its switch is Off) | `refused` |

The visitor's signals (rows 4 to 7) stop both streams. The developer's `telemetry: false` is a choice about the
diagnostics stream only and does not stop analytics (§1.5). Telemetry's own sampling (`telemetry.sample`) and its
default-off on local hosts do not stop analytics, which has its own rows 8 and 11. The signal values in rows 4 to 7
are read in the page and never sent.

While `waiting`, the chunk is not loaded and nothing is recorded for analytics (the runtime's own in-memory observation
for the bug model goes on as before). When consent arrives, analytics starts from that moment: nothing from before
consent is recorded, sent, or taken from the runtime's event buffer, and the view open at that moment is sent as
`(start)` (§2.5).

A visitor's lasting objection: `localStorage.setItem("genclass.analytics", "off")`, which a site's privacy page can
set from a button (the "simple means of objecting" the UK statistics exception asks for, appendix B; the snippet is
in §11).

### The config request

When every row up to 12 passes, the chunk loads and sends `GET <endpoint>/config?token=gc_…` (by default
`https://genclass.dev/api/v1/analytics/config`) with the native fetch, `credentials: "omit"` and
`referrerPolicy: "no-referrer"`, before it records anything. The reply is `{"on": true}`, `{"on": true, "consent":
"required"}` (the dashboard's "Always wait for consent", below) or `{"on": false, "reason": "plan" | "off"}`, with
`Cache-Control: public, max-age=300`, so later page loads of a multi-page site are answered from the browser's HTTP
cache for 5 minutes.

The reply can only stop analytics or make its consent stricter. `consent: "required"` in the reply makes a page whose
code said `not-required` wait for `GenClass.consent("analytics", true)`; a reply can never turn a page's `required`
into `not-required`. The request carries the app's public token and nothing about the visitor beyond what any HTTP
request carries (Cloudflare sees the IP to route it; the worker stores nothing). It is sent only after consent, or on a
page whose own code said consent is not required, so the start of analytics never rests on a transmission made before
consent. A self-hosted collector answers it without a plan.

### The dashboard switch (Pro apps)

Each Pro app has two settings, changed only on the signed-in account page (`/account/apps/<id>`). The bearer
dashboard links (`/dashboard/<secret>`) show them read-only, so a person a link was shared with cannot change what the
site collects. A change asks the account owner to confirm that the site's privacy notice names GenClass interaction
analytics, and writes an audit entry on the account (who, when, old and new value).

| setting | values |
|---|---|
| **Collection** | **On** (the default once on Pro): the config reply says `on` to pages whose code turned analytics on. **On, and start on consent**: also to pages whose code did not set `analytics` but called `GenClass.consent("analytics", true)`; such a page always runs with consent `required`. **Off**: the reply says `on: false` and the collector refuses every batch for the app (403) |
| **Consent** | **As each page says** (default), or **Always wait for consent**: the reply says `consent: "required"` to every page |

"On, and start on consent" never starts analytics on a page with no code for it: the consent wiring is code (the
site's consent tool calls `GenClass.consent`). What it saves is a redeploy. A site that added the consent call once can
turn collection on and off on the dashboard. It needs no telemetry batch, so it works with `telemetry: false`, with
telemetry sampled out, and with a custom `telemetry.transport` (decision §15.3).

Free apps: the config reply says `{"on": false, "reason": "plan"}`. The chunk records nothing and sends no batch, and
the collector refuses batches (403) as a second check. The dashboard shows the feature as part of Pro.

### Console lines

Printed by the lazy chunk, so they cost no first-load bytes:

- when analytics starts: `[GenClass] Interaction analytics is on: counts of clicks, scrolling and page changes per
  element, and the API paths those clicks call, without page text, sent to this app's GenClass dashboard
  (genclass.dev). Opt out for this page: ?genclass=no-analytics. For this browser:
  localStorage.setItem("genclass.analytics", "off").`
- with `debug: true` only, the reason it is off or waiting, once: `[GenClass] Interaction analytics is waiting for
  consent: GenClass.consent("analytics", true).`
- with `debug: true` only, once when it starts: `[GenClass] Routes, element ids and API paths can describe what a
  visitor does (for example /conditions/:id). In apps that handle health, financial or children's data, ask counsel
  before turning analytics on.`

## 8. Collector, storage and retention by plan

The worker `genclass-telemetry` (`telemetry-worker/`) gets a config route, an ingest route with a validator, and a
per-app aggregator.

- **`GET /api/v1/analytics/config`:** looks up the token's app, account, plan (`telemetry-worker/src/plans.ts` on
  `wave2/billing`, `entitled(plan, "analytics")`) and the two settings, cached per isolate for 60 s; the reply carries
  `Cache-Control: public, max-age=300` (§7). Telemetry ingest is unchanged: it still answers 202 before any D1 read.
- **`POST /api/v1/analytics`:** `telemetry-worker/src/analytics.ts` `validateBatch` checks every batch and rejects the
  whole batch (400, nothing stored) on any violation, rather than trimming it:
  - the envelope's fields and types; `text` is false; `mode` and `sample` in range; unknown fields reject the batch
    (new fields come with a new schema version);
  - every element key against the §3 grammar, with an allowlist of characters outside the label
    (`A-Z a-z 0-9 _ . - : / ( ) # @ ~ [ ] ?`), anchors without whitespace or non-ASCII, at most 120 characters; a
    single-quoted page-text part is rejected while `text` is false (always in v1); a label passes the data check of
    §3;
  - every route, `from`, link target and signature through §5's rule again (no `?`, `#`, `@` or whitespace, no 4 or
    more digits in a row, no 12 or more hex digits, host only for another origin);
  - counters are non-negative integers within bounds (`n` at most 1,000 per key per batch, arrays of the stated
    lengths, at most 200 keys and 4 KB per batch);
  - the `Origin` header, when present, matches one of the app's origins (set on the account page; until set, the
    hostnames its telemetry reported). This stops other sites' pages from posting with the token; it does not stop a
    script outside a browser, which can send any header;
  - a budget per token and day (batches, and new keys) next to the per-IP limit. A per-`pid` limit alone does nothing
    against forged `pid`s, which cost nothing to make.

  Not entitled or switched off: 403 with a short JSON reason, nothing stored. Body limit 16 KB. No country, user agent,
  IP or header is kept.
- **Per-app aggregator:** a Durable Object per app receives each accepted batch, adds it to counters in memory, and
  writes the counters that changed to D1 once a minute (an alarm), so D1 writes grow with the counters an app touches,
  not with page views (§6). It also holds, in memory only:
  - the (`pid`, `seq`) pairs of the last 2 hours, to skip a batch it has seen (a restart forgets them, so a batch
    retried across a restart can count twice);
  - the literal values waiting for their fifth page load (§3), per app and day, at most 10,000 (past that, new
    literals are stored as `:id` or `#?` directly);
  - each `pid`'s current route for 30 minutes, to infer exits (§2.5);
  - a space-saving count of (route, element) pairs per app and day, which decides which 5,000 pairs get rows and
    which go to `(other)`, so a burst of forged keys early in the day cannot take the cap (first come, first served
    could).

  A restart of the object (a deploy, an eviction) loses at most the last minute's counts and this in-memory state;
  the dashboard's definitions say so.
- **Storage:** analytics has its own D1 databases, apart from the database that holds telemetry aggregates, accounts
  and dashboards. Accounts are assigned to one of N analytics databases at their first write, so one busy app cannot
  slow the ingest or dashboards of others, and no database nears the 10 GB limit (§6). Tables: `ui_daily` (app, day,
  route, element key, metric, count), `ui_req_daily` (app, day, route, element key, request signature, outcome,
  count; the same 5,000-pair cap and `(other)` row), `ui_flow_daily` (app, day, from route, to route, count), and a
  monthly roll-up of each for the 365-day view. Their location is decision §15.14.
- **No raw batches** (recommended, decision §15.6): batches are aggregated on receipt and not kept. If the owner keeps
  them for rebuilding aggregates after a collector bug, they go to `analytics/app=<id>/dt=YYYY-MM-DD/<uuid>.jsonl.gz`
  without `pid` and `seq`, are deleted with the app by prefix, kept 7 days, never exported and never read by a training
  job.
- **Never in the training data.** Analytics is never written under the R2 `events/` prefix, which holds the
  telemetry batches used to evaluate and train the model (TELEMETRY.md "Use").
- **Processor only.** Daybot never uses analytics data for its own purposes: no admin or marketing figures across
  customers, no product statistics, no model training (the Custom exception in §15.10 is that customer's own model, on
  their written instruction). Staff read an app's analytics only for support, at the customer's request. Enforced in
  code: only the account's own dashboard, its export and the aggregator have a binding to the analytics databases, and
  a worker test fails if any other module in `telemetry-worker/src/` names a `ui_` table or that binding (the admin
  pages included).

Retention by plan (`billing/plans.json` on `wave2/billing`: Free `history_days` 7 and `analytics: false`; Pro and
Custom `history_days` 365 and `analytics: true`):

| data | Free | Pro | Custom |
|---|---|---|---|
| analytics accepted | no (config reply `off`, 403) | yes | yes |
| daily aggregates (`ui_*` tables) | none | 90 days, then monthly roll-ups to 365 days (decision §15.6) | same |
| raw batches | none | none (recommended; else 7 days, §15.6) | same |
| in-memory state in the aggregator | none | dedup 2 hours, waiting literals 1 day, exits 30 minutes | same |
| after the plan ends | none | aggregates kept 30 days (`GRACE_DAYS` in `plans.ts`), visible and exportable, then deleted | same |
| export | none | daily and monthly aggregates as CSV or JSONL, by download or API (the Pro `export` entitlement); counts under 5 as `<5` (§9) | same |
| use for a model | never | never | only for that customer's own private model, with a separate written opt-in (decision §15.10); never the shared model |

Deleting an app or an account deletes its analytics rows (and raw batches, if kept, by their app prefix) at once.
Daybot processes analytics on the developer's instructions: the developer is the controller, Daybot the processor
(§11, appendix B).

## 9. Dashboard

A new **Interactions** section on each Pro app's account page (`/account/apps/<id>`) and, read-only, on its dashboard
link (`/dashboard/<secret>`), over 7, 30, 90 or 365 days (daily data to 90 days, monthly beyond; no hourly view in
v1):

- **Overview:** page views, clicks, dead-click share (`dead / cand`), late clicks, rage runs, silent failures, healed
  requests (guard and heal), and the change from the previous period. Coverage: the page loads analytics counted
  next to the sessions telemetry counted on the same days when telemetry is on, marked approximate. With `sample`
  under 1, counts are scaled and marked as sampled.
- **Top clicked elements**, for all pages or one: key, clicks, dead, late, rage, failed, errors, settle p50 and p95.
- **Dead and rage clicks with the requests behind them:** elements ranked by dead plus rage counts; for each, the
  request signatures its clicks started with their outcomes (ok, 4xx, 5xx, network), `wait`, duplicates sent, retries,
  and, when the app also has GenClass detections on that route, a link to them.
- **Errors after clicks:** elements by `err`, `fail` and `silent`.
- **Scroll depth per page:** share of views that reached 25, 50, 75 and 100 %, and how many fit the viewport or scroll
  an inner element.
- **Flows:** top transitions, entry pages, exit pages, and the next-page distribution for a chosen page. For an app
  where most page loads have a single view, flows show "not measured: this site loads a new page for each view" with
  a link to decision §15.13's outcome.
- **Per page:** views, time-to-first-interaction distribution, clicks, top elements, scroll depth.
- **Export:** the aggregates as CSV or JSONL (Pro `export`).
- **Naming help:** how keys are formed, what `#?` and `:id` mean, `data-genclass-label` and `data-testid`, and the
  `findByKey` snippet for structure keys.
- **The settings** (§7), on the account page only, with what each value sends and a link to the privacy-notice text
  (§11).

Counts from 1 to 4 in a (day, route, key) row are shown and exported as `<5`; totals over a period are exact. This
makes a single visit harder to pick out in a small app. It does not make the data anonymous: small counts are still
pseudonymous personal data (appendix B).

Keys, routes and signatures are visitor-controlled strings (anyone with the public token can post a batch, §8), so the
dashboard HTML-escapes them wherever they are rendered and embeds JSON only through `pages.ts` `embed`.

Every metric has a one-line definition on hover that matches §2, including what it cannot see and its measured
false-report rate (§13).

## 10. What GenClass will never collect

In any plan, with any option. Each item names where it is enforced; "source scan" is
`packages/runtime/test/analytics-source.test.ts` (below), "validator" is `validateBatch` (§8).

- **Keystrokes and input values:** never which keys were pressed (only counts of typing bursts and of Enter or Escape
  presses, from the runtime's user actions), never typed text, `input`, `select` or `textarea` values, contenteditable
  content or file names. Browser: the source scan. Collector: the validator accepts strings only in keys, routes and
  signatures, each checked again.
- **Page text:** in v1, no visible text in any setting. Keys come from markup (role, tag, input type, stable
  attributes, landmark, structure hash) and from developer labels; routes and link targets from URLs. The rules in §3
  and §5 drop values that look like content: with whitespace, outside printable ASCII, long, many distinct values in
  one place, or seen on fewer than 5 page loads in a day. A short ASCII id or path segment that an app builds from
  content and that 5 page loads share in a day (a popular public profile's slug) can still be stored; §13 tests the
  common shapes (typed search paths, geocoder paths, place routes, ids built from names and subjects, autocomplete
  lists, contact lists). Browser: `src/analytics/keys.ts` is the only module that reads element data, through an
  exported allowlist of attributes (the key attributes of §3 and those §2.1 needs: `role`, `href`, `download`,
  `aria-selected`, `aria-current`, `aria-haspopup`, `aria-expanded`, `aria-disabled`, `data-genclass-*`). Collector:
  the validator rejects page-text parts and re-checks every string.
- **Screenshots, DOM snapshots, session replay or video.**
- **Pointer coordinates, mouse movement, hover or touch paths.** v2 heatmaps are per element, from counts (§14).
  Browser: the source scan.
- **Cross-site identifiers:** no cookies, nothing stored in `localStorage` or `sessionStorage` by analytics (it only
  reads the visitor's `genclass.analytics` opt-out), a page-load id that the page never stores and that is not the
  telemetry session id, nothing shared across apps; the collector never joins data across tokens. Browser: the source
  scan.
- **Fingerprints:** no device, browser, screen, timezone, language or hardware fields, and no hash of IP address or
  user agent. Collector: the validator rejects unknown fields.
- **Stored IP addresses, user agents, referrers, cookies or request headers.** Cloudflare's rate limiter keys on the
  IP for the request; the worker never stores it. The beacon fallback (§4) carries the page's `Referer` header under
  the page's referrer policy; the worker never reads or stores it.
- **Full URLs:** no query strings or fragments; another origin as its host only, for links and for requests.
- **Request or response bodies and headers, storage contents, the clipboard.**
- **Who the user is:** there is no `identify()` call; GenClass cannot connect analytics to a person or an account.

**The source scan.** `test/analytics-source.test.ts` reads every file under `src/analytics/` and fails if any of them
reads `.value`, `textContent`, `innerText`, `innerHTML`, `outerHTML`, `clientX`, `clientY`, `pageX`, `pageY`,
`screenX`, `screenY`, `offsetX`, `offsetY`, an event's `.key`, `document.cookie`, or the `target` or `value` of a
runtime user event; calls `getAttribute` or `closest` outside `keys.ts`; or calls `setItem`. A text module, if the
owner ever allows text (§3), is the only file that may read `textContent` or `innerText`.

## 11. Disclosure changes

Required by AGENTS.md rule 8 before the collector accepts analytics in production:

| where | change |
|---|---|
| console | the lines in §7, printed by the chunk, including the regulated-data line under `debug` |
| `packages/runtime/TELEMETRY.md` | a section "Interaction analytics (a separate stream)": the schema (§5), the config request, the endpoint, storage locations, retention, the never-collected list, the beacon fallback, and the new opt-outs (`?genclass=no-analytics`, `genclass.analytics`, DNT) in the opt-out table. In "If you ship GenClass in your app": the Art. 5(3) conclusion for telemetry (appendix B), `GenClass.consent("telemetry", true)` in place of "create the runtime after consent", and the regulated-data warning extended to analytics. Also correct "without credentials or referrer" for the beacon path, here and in the `telemetry/transport.ts` comment |
| `PRIVACY.md` | a section on interaction analytics for website owners: what, why (the developer's dashboard), Daybot as processor, retention by plan, storage locations, the never-collected list, how visitors opt out, rights requests through the website owner. Calls the data "pseudonymous", not "anonymous" (appendix B). "For developers" names the consent call. The sentence "Data from browsers that opted out or send Global Privacy Control never reaches a dashboard" adds Do Not Track and `no-analytics` for analytics |
| `README.md` and `packages/runtime/README.md` | "Privacy and telemetry" (analytics is off by default, what it sends when on), "Your dashboard" (the Interactions section), "Costs" (the chunk's size, the bytes per hour) |
| `packages/runtime/CHANGELOG.md`, `docs/runtime/API.md`, `docs/runtime/OPTIONS-SPEC.md`, `src/types.ts` JSDoc | the option, `GenClass.consent` with both purposes, `rt.analytics`, `@genclass/runtime/analytics`, the `no-dead` and `off` markers |
| `docs/runtime/THREAT-MODEL.md` | a new write surface: anyone with an app's public token can post analytics batches and request its config. What the validator, the Origin check, the per-token budget and the top-K cap stop and do not stop; HTML escaping on the dashboard |
| site docs pages that mirror the docs: `site/public/docs/telemetry.html`, `options.html`, `api.html`, `threat-model.html` | match the rows above |
| site: `privacy.html` | a section "Interaction analytics", matching PRIVACY.md |
| site: pricing (`billing/plans.json` on `wave2/billing`) | the feature line becomes "Interaction analytics: clicks, dead and rage clicks with the requests behind them, scroll depth and page flows, without page text". The export line ("Full data export: every event GenClass received for your apps") adds that interaction analytics exports as daily and monthly counts, because no raw analytics events are kept (§8) |
| site: `terms.html` | the processor terms by reference to the DPA |
| new: privacy-notice text for developers | a template a site copies into its own notice, with these fields: Daybot as processor (name, contact), the purpose (the site's own usage statistics and error analysis), the data categories (§5: routes, element keys, request signatures and hosts, counts, a page-load id; no page text or input values), retention (§8), storage locations and sub-processors, international transfers, how to object, and how to exercise rights through the site. With it, an objection button: `<button type="button" onclick="try{localStorage.setItem('genclass.analytics','off')}catch(e){}">Turn off GenClass analytics in this browser</button>` |
| new: data processing agreement | GDPR Art. 28 terms with every Art. 28(3) item (instructions only, confidentiality, security, sub-processors, help with data subject requests and DPIAs, deletion or return, audits); an annex of technical and organisational measures (§4, §8 and §10 as controls); a UK addendum; a CCPA service-provider schedule that meets Cal. Code Regs. tit. 11 § 7051; PIPEDA principle 4.1.3 and Quebec Law 25 s. 18.3 terms; breach notice. Accepted at Stripe checkout (a checkbox linking the DPA, recorded with the account) and on the account page by existing customers. Reviewed by counsel |
| new: sub-processor list and data map | Cloudflare (Workers, Durable Objects, D1, and R2 if raw batches are kept) with the jurisdiction or location of each store (§15.14), Stripe for billing account data only, Daybot in Canada; a statement that analytics is not copied to the training infrastructure; a change-notice process. A Quebec developer needs this for the s. 17 assessment (appendix B) |
| new: CNIL self-assessment and attestation | Daybot completes the CNIL audience-measurement self-assessment (July 2025 tool) for a stated configuration and gives customers the attestation document with the settings it needs (consent mode, no text, the objection button, retention, storage location). A site outside that configuration cannot rely on the exemption through it |

## 12. Bundle budget

- **First load** (both `/auto` and the main entry): the gate, `GenClass.consent` with both purposes, the `analytics`
  keys in `src/cdn/config.ts`, and the element hook in `dom-user.ts`. Telemetry's transport does not change (the first
  draft's header read is gone, §7). Budget: under 0.3 KB gzip on each entry. The limits (`test/bundle.test.ts`
  `LIMIT_KB`, 107.74 and 99.71 KB, owner-approved for 0.3.0) leave 0.01 KB on `/auto` (107.73 KB measured, CI run
  38491077597, `release/0.3.0` at `0613c32`) and 0.10 KB on the main entry (99.61 KB). The prototype's gate cost
  0.06 KB on each, so v1 needs a `LIMIT_KB` raise in any case (decision §15.7).
- **The chunk:** `src/analytics/` behind a dynamic import, loaded only when analytics will run; target 5 KB gzip or
  less, printed and limited in `bundle.test.ts`, with marker strings asserted absent from the first load as for
  `flows.ts` and the sinks. For scale: PostHog's lazy dead-click module, `dead-clicks-autocapture.js`, transfers
  8.5 KB gzip (measured with curl on 2026-10-13); the prototype's counts-only chunk was 732 B.
- **Script tag:** the chunk is a separate file, `dist/analytics.js`, loaded with `load("analytics.js")` in
  `src/cdn/global.ts` as the sink modules are. The prototype showed the IIFE build inlining a plain dynamic import.
- **Runtime cost:** per click, one ancestor walk of at most 32 elements reading attributes (no layout read), one clock
  timer, and observers only while a click window is open; per runtime event while no window or join is open, one
  check; per 500 ms of scrolling, one layout read, and one at the end of a view.
- **How the cost is checked:** a deterministic work count in the blocking unit tests (`test/analytics.test.ts`): in
  one fake-clock hour with 100 store writes a second and a click a second, the chunk does no work on runtime events
  while no window or join is open, connects its observers at most once per click, and walks at most 32 ancestors per
  click. Timing
  budgets also go in `test/review-perf.test.ts`, which `ci.yml` runs in its own step that reports and does not block
  ("Perf budgets", `continue-on-error: true`); `release.yml` does not run it. Counting work instead of timing it lets
  the first check block without the runner noise that made the timing step non-blocking.

## 13. Tests and ship gates

Runtime (`packages/runtime/test/analytics.test.ts`, vitest, `setup()` from `test/helpers.ts` with a fake clock and
server; the CONTRACT section named in each `describe`):

- **Gates:** each row of §7 alone turns analytics off with its reason; `telemetry: false` with `analytics: true` runs
  analytics; `observe.user: false` gives `no-observer`; `waiting` loads no chunk and sends nothing; consent granted
  later sends nothing from before it and opens a `(start)` view; `GenClass.consent("analytics", false)` drops unsent
  counts and sends nothing more; no request at all without a token; a refused config reply (plan, Off) means nothing
  recorded and no batch; a reply that says `required` makes a `not-required` page wait, and no reply makes a
  `required` page `not-required`; "start on consent" starts only after the consent call; `GenClass.consent("telemetry",
  true)` after `telemetry: false` starts telemetry without re-creating the runtime.
- **Element keys:** one fixture per row of §3 (precedence, generated ids, digits to `n`, whitespace and non-ASCII
  anchors dropped, the fourth distinct anchor of a family falling back to structure, link targets, landmarks across
  shadow roots, structure hashes); `data-genclass-analytics="off"`, `"no-dead"` and `data-genclass-ignore`.
- **Never collected (§10):** fixtures from the review, each scanned in every request body (batches and the config
  request): a search button whose handler calls `/api/search/<typed text>`; a geocoder request to another origin with
  an address in its path; a `/s/<place>/homes` route; ids and test ids built from content (`id="contact-jane-doe"`,
  `data-testid="thread-Re: diagnosis"`); an address autocomplete list built from typed input; a contacts list whose
  links carry names and `aria-labelledby`; plus typed secrets, an e-mail in a link, query strings, fragments and a
  long product description. None of the typed strings, addresses or names appears. `localStorage.setItem`,
  `sessionStorage.setItem` and `document.cookie` are spied and never called by analytics; no device field in any
  body; the `pid` differs from the telemetry `sid`.
- **Source scan:** `test/analytics-source.test.ts` (§10).
- **Dead clicks:** a click answered only by a re-render inside an open shadow root is alive; a custom element with a
  closed root is not a candidate; a request started from `requestAnimationFrame`, a `MessageChannel` or a dynamic
  `import()` (a chain the runtime loses) makes the click alive; download, `mailto:`, the selected tab, a link to the
  current route and an `aria-expanded` trigger are not candidates; focus moved at `pointerdown`, a window `blur` and
  `beforeprint` each make a click alive; an answer between 2.5 s and 10 s counts `late`; a click with no signal for
  10 s is dead; form fields, modifier clicks, disabled controls and multi-clicks are not candidates; a hidden tab
  gives no verdict and no `cand`.
- **Rage clicks:** a triple click that selects a paragraph's text is no run; ticking 4 checkboxes of a list is no run;
  a number input's spinner is no run; 4 clicks within a sliding 1 s on an unanswering button count once, when the run
  ends; 3 clicks count nothing (and the measurement reports both); a stepper that answers each click is not counted;
  `wait` and `dup` with an open request.
- **Joins:** a failed request in the chain (4xx, 5xx, network) counts `fail`, an abort does not; in heal mode a
  retry, a hedge and a `serve_cached` answer each count one start, the delivered outcome, `healed`, and no `fail` when
  the delivered answer is ok; React Query style app retries (3 failures, then ok) count `retry` 3, no `fail`, no
  `silent`; an axios refresh-and-replay after a 401 counts no `fail`; `silent` only when nothing answered after the
  chain's last failure; a polling chain settles as "still open at 10 s"; an error in the chain counts `err`; a
  background poll's failure counts nothing.
- **Lifecycle:** a back/forward-cache restore starts a `(restore)` view with `pid` and `seq` continuing; a
  replaceState redirect within 1 s merges into the next view; `/products/1` to `/products/2` is one view; a
  `pushState` before render takes no scroll sample; an app shell that scrolls a panel gives `sc: "inner"`; a
  multi-page site sends `v: 0` views only; time to first interaction counts from clock time 0.
- **Long-lived tab:** 24 fake-clock hours touching 1,000 distinct keys over time, each counted per key; a 3-minute
  collector outage backs off and resumes; a CSP violation for the endpoint stops analytics; joins survive eviction
  from dead-click tracking.
- **Transport:** the pagehide flush uses `fetch` with `keepalive`, `credentials: "omit"` and
  `referrerPolicy: "no-referrer"`; the beacon only when keepalive fetch is missing.
- **Volume:** an hour at 6 and at 60 clicks a minute on a fake clock: measured bytes and requests printed for
  RESULTS.md; the 4 KB batch cap and the per-batch key cap hold; the timer ceiling holds at `flushMs` 30 s and 60 s.
- **Cost:** the work-count budget (§12).
- **Determinism:** the same inputs give byte-identical batches.
- **Never feeds a decision:** with analytics on and off, the same scripted session gives byte-identical situations
  and the same decisions and actions; the review tests (`test/review-*.test.ts`) pass unchanged; the exact-text tests
  show the two new op fields are not rendered.
- **Bundle:** first-load growth within §12; the chunk absent from the first load; the script tag's file without the
  chunk.

Collector (`telemetry-worker/test/`): the validator (each rule; a violation rejects the whole batch; forged page text,
whitespace anchors, query strings and 4-digit runs rejected); the config route (plan, both settings, cache headers,
tighten-only replies); 403 for Free tokens, unknown tokens and Off; the Origin check; the per-token budget; the
top-K under a burst of forged keys; the aggregator (a batch writes no D1 row directly; a flush writes one row per
counter touched, asserted); dedup by (`pid`, `seq`), including concurrent repeats, a byte-identical retry with the
same `seq`, and a hidden flush and a pagehide flush that each carry their own `seq`; transitions counted once, from
`from`; exits inferred after 30 minutes; the 5-page-load rule (4 page loads give `#?` and `:id`, 5 give the literal)
and the 20-distinct-values rule; nothing under `events/`; no raw batches (or the app prefix without `pid` and `seq`,
if kept); retention, roll-ups and the grace period; export contents with `<5`; the admin source check (no `ui_` table
outside the allowed modules); a key containing `<script>` rendered escaped.

**Real browser, in CI:** `packages/runtime/test/browser/analytics.spec.ts` in Chromium, as a new CI job. Unlike the
existing browser specs it needs no model; AGENTS.md lists Playwright as ask-first, so adding the job is part of
decision §15.12. It covers what happy-dom (vitest runs with `environment: "node"` and happy-dom per file) cannot:
`MutationObserver` timing in documents and shadow roots, layout for scroll marks and `sc`, the keepalive fetch on
pagehide with its headers (no `Referer`, no cookie), the back/forward cache, `pointerdown` on natively disabled
buttons, and a visible tab.

**Ship gates (v1e).** Measured on correct apps (the demos' correct runs, the `realapps/` sweep with scripted clicks
whose effect is known, a web-component app (Lit or Shoelace; `compat/` has none today, so one is added for this) and
an app with lazy routes and no spinner) and on seeded broken controls, including apps whose libraries change the DOM
on press or hover (MUI ripple, React Aria `data-pressed` and `data-hovered`, Radix `data-state`), which can push dead
clicks toward zero:

| rate | proposed gate (decision §15.12) |
|---|---|
| false dead clicks: dead verdicts on controls that worked, per candidate with a verdict | at most 1 % |
| false rage runs on correct apps | at most 1 per 10,000 clicks |
| recall: seeded dead controls reported dead | at least 70 % |
| recall: seeded unanswering controls clicked 4 times in 1 s reported as rage | at least 70 % |

A metric does not appear on the dashboard until it meets its gate. The rates go to `docs/runtime/RESULTS.md` next to
the counts, as FIR goes next to recall, and the dashboard shows them beside each metric's definition.

## 14. Staged plan

| stage | what | done when |
|---|---|---|
| 0 | owner decisions (§15); counsel reviews the DPA, the notice template and appendix B | each item in §15 answered |
| v1a, runtime | `src/analytics/` (keys, paths, metrics, aggregation, transport, config request), the `dom-user.ts` hook, the two op fields, the gate, `GenClass.consent` (analytics and telemetry), `rt.analytics`, `@genclass/runtime/analytics` (`findByKey`), the zero-code keys; the tests in §13, the source scan, the work-count budget and the Chromium job | AGENTS.md "definition of done"; measured bytes in RESULTS.md |
| v1b, collector | the config route, the validator, the per-app aggregator, the analytics D1 databases (location per §15.14), roll-ups, retention by plan, export, the Origin check, budgets, top-K, the admin source check | worker tests pass; rows written per flush measured and put in §6; nothing under `events/` |
| v1c, dashboard | the Interactions section; the settings on the account page with the audit entry and the notice confirmation; read-only on dashboard links; escaping; `<5` | reviewed on a test app with real traffic from a visible tab |
| v1d, disclosure | every row of §11: the docs, the DPA, the sub-processor list and data map, the notice template, the CNIL self-assessment and attestation | before the collector accepts analytics in production |
| v1e, measurement | the ship gates (§13) | each metric meets its gate before the dashboard shows it |
| v2 | heatmaps by element: the dashboard opens the developer's own page with an overlay that resolves keys to elements in their browser (`findByKey`) and colours them by clicks, dead and rage counts; no coordinates or screenshots collected. Also: consent-tool adapters, multi-step funnels (needs a decision on per-visit data), scroll inside elements, hash routing and a `route` naming option, form abandonment counts, forwarding interaction findings through Pro forwarding (Sentry, PostHog, Datadog, Slack or a webhook, configured on the dashboard; the vendor adapters left the free runtime on `release/0.3.0` in `31ddc98`), app-specific outcome labels for Custom, and text in keys if §15.5 ever allows it | each a separate spec section and owner OK where it widens what is sent |

## 15. Decisions for the owner

1. **The fields sent** (rule 8): element keys (role, tag or input type, stable attributes that pass §3, landmark,
   structure hash, developer labels), link targets, same-origin request signatures and the hosts of third-party
   requests, the counts in §5, `mode` and `sample`, and the config request (token only, after consent). Request
   signatures are not sent by telemetry today outside the opt-in situation text.
2. **Consent default:** `consent: "required"` (recommended: EU guidance puts this transmission under ePrivacy
   Art. 5(3), and Quebec s. 8.1 asks for the means to activate profiling functions; appendix B) or `"not-required"`
   (easier start; the developer must add consent where it is needed).
3. **Starting on consent from the dashboard:** recommended yes, only on §7's terms: changed on the signed-in account
   page with an audit entry and a privacy-notice confirmation; starts only on a page that calls
   `GenClass.consent("analytics", true)`, and then always with consent required; the config reply can only stop or
   tighten; no backfill; `analytics: false` stays a hard off. On these terms it never starts analytics without code;
   it saves a redeploy. The first draft's version (a header on telemetry replies, `not-required` set from the
   dashboard, a backfill from the event buffer) is withdrawn (§16, P4 and E7).
4. **`telemetry: false` and analytics:** answered by the review. It no longer stops analytics (the first draft's row 4
   is removed), because the streams are separate and GenClass's own consent advice for telemetry would otherwise
   block analytics after consent. The owner confirms.
5. **Text in keys:** recommended no text in v1, keys from markup and developer labels only. §3 lists the limits for
   any later version.
6. **Raw batches and history:** recommended none (aggregate on receipt), so nothing per visit is kept beyond the
   aggregator's in-memory state; if kept, 7 days, app prefix, no `pid` or `seq`, not exported. And daily rows for 90
   days with monthly roll-ups to 365 days (instead of 365 days of daily rows), for D1 size and dashboard speed (§6).
7. **First-load budget:** approve up to 0.3 KB more per entry. The headroom is 0.01 KB on `/auto` and 0.10 KB on the
   main entry, so a raise is needed whatever v1's gate costs.
8. **Pro wording:** "get every data" against §10; the proposed feature line and the export line are in §11.
9. **Legal:** counsel for the DPA, the notice template and appendix B; whether Daybot needs an EU and UK
   representative (GDPR Art. 27); whether telemetry's "anonymous" wording should become "pseudonymous"; regulated
   sectors (Washington's My Health My Data Act, HHS guidance on tracking technologies) and whether the docs should say
   not to turn analytics on there; CIPA exposure in California.
10. **Custom plan:** may a Custom customer's analytics train their private model (separate written opt-in), never
    the shared one?
11. **Telemetry and consent:** `GenClass.consent("telemetry", granted)` ships in v1a (it narrows nothing and changes
    no default, so it needs no OK under rule 8). Open: the Art. 5(3) conclusion for telemetry itself (appendix B),
    whether TELEMETRY.md should tell EEA and UK sites that telemetry needs consent there, and whether telemetry's
    default should change for them (changing a default needs the owner).
12. **Ship gates and CI:** the thresholds in §13; `RAGE_N` 4, or 3 if the measurement allows; adding the Chromium
    analytics job to `ci.yml`.
13. **Same-origin referrer for multi-page flows:** read `document.referrer` only when it is same-origin, and send its
    route (§5 rules) as view 0's `from`. Recommended yes: the value is a route of the same site, normalised like every
    route, and without it flows are empty on multi-page sites. It widens what is sent (rule 8).
14. **Storage location:** create the analytics D1 databases (and the R2 prefix, if raw batches are kept) with an EU
    jurisdiction, which D1 and R2 both offer at creation, or state their locations in the data map. Recommended: EU
    jurisdiction, which removes the transfer question for stored data; processing at Cloudflare's edge still crosses
    borders under Cloudflare's DPF certification and SCCs (appendix B).
15. **Page-view quota per plan:** a monthly analytics page-load quota for Pro in `billing/plans.json` (with §6's
    collector cost), or none. Recommended: a soft quota with an e-mail when reached, never a cutoff without notice.

## 16. Review log

A privacy review (P1 to P10) and an engineering review (E1 to E12) of the first draft, both 2026-10-13. Each entry
gives the finding, what changed, and, where a finding was corrected or not followed, why.

- **P1 (major) Word slugs and content ids pass the path and anchor rules.** Confirmed: `normalizePath` on `f363e92`
  keeps `/u/jane-smith`, `/s/Toronto--ON/homes`, `/search/divorce-lawyer` and `mapbox.places/123%20Main%20St.json`
  unchanged. Changed: an analytics-only path rule, anchor rules, host-only third-party signatures, the per-page
  cardinality rule, the collector's re-check and 20-per-day rule, and the fixtures (§3, §5, §13). Extended: the
  cardinality rules alone keep a value that one visitor's page produced once (one contact's page in a small app), so
  the collector also holds every literal until 5 page loads share it in a day (§3). Also found: telemetry's
  `session.route` uses the same `normalizePath` and sends such slugs today. That is shipped telemetry, outside this
  spec, and is raised with the owner separately; rule 3 freezes `normalizePath`, so a fix there would be a
  telemetry-only rule.
- **P2 (major) `text: true` sends names and suggestions built from typed input.** Confirmed in `describeElement`,
  which follows `aria-labelledby` into any element. Changed: no text in v1 (§3, recommended for §15.5), the limits for
  any later version, exact wording in §10 and the console line, fixtures with an autocomplete list and a contacts list
  (§13), and page text in its own quoting so the collector can reject it (§8).
- **P3 (major) Coupling to telemetry, and Art. 5(3) for telemetry.** Confirmed: TELEMETRY.md "If you ship GenClass in
  your app" advises `telemetry: false` and creating the runtime after consent, which conflicted with row 4 and with a
  remote start carried on a telemetry reply. Changed: row 4 removed; no telemetry header (§7);
  `GenClass.consent("telemetry", ...)` in v1a as a prerequisite for EEA, UK and Quebec use (§7, §15.11); the
  conclusion for telemetry in appendix B. TELEMETRY.md and PRIVACY.md are not edited on this branch: they describe
  shipped behaviour, and the consent call they should point to does not exist yet. Their edits are §11 rows that land
  with v1a.
- **P4 (major) A server-side value could start collection without consent.** Changed as proposed, and further: the
  header on telemetry replies is removed. A page learns entitlement and settings from a config request sent only
  after consent (or when its own code says consent is not required), and the reply can only stop or tighten (§7).
  Starting from the dashboard needs the page's consent call and then always runs with consent required; there is no
  backfill; the settings change only on the signed-in account page with an audit entry and a notice confirmation;
  dashboard links show them read-only (§7, §9, §15.3).
- **P5 (major) The never-collect promises are tested, not enforced.** Changed: `keys.ts` as the only reader of
  element data with an attribute allowlist, the source scan, `validateBatch` rejecting whole batches, per-token
  budgets, HTML escaping, and collector tests (§8, §9, §10, §13). Corrected: the validator cannot reject every quoted
  part when text is off, because developer labels are quoted parts by design; page text, if ever allowed, gets its own
  quoting instead (§3).
- **P6 (major) Missing legal scope.** Changed: appendix B adds transfers, Quebec s. 8.1 and s. 17, California (§ 7051
  and CIPA), PIPEDA consent and regulated data; §8 adds the processor-only rule with a code check; §11 adds the CNIL
  self-assessment and attestation, the measures annex, the data map, and DPA acceptance at checkout. The CNIL tool and
  its attestation model were checked on cnil.fr (July 2025). The section number "CAI Guidelines 2023-1 (B.4)" could
  not be verified here either and is replaced by s. 8.1.
- **P7 (minor) A beacon sends the page's referrer.** Confirmed: `telemetry/transport.ts` sets
  `referrerPolicy: "no-referrer"` and `credentials: "omit"` on its fetch only. Changed: analytics flushes on hide and
  pagehide with keepalive fetch, and the beacon fallback is disclosed (§4, §10). The telemetry transport's comment and
  TELEMETRY.md make the same claim for telemetry's pagehide beacon; that is a §11 row for the telemetry docs and is
  not changed here (shipped code, outside this spec).
- **P8 (minor) Raw batches were not split by app and were per-visit records.** Changed: §15.6 recommends none; if
  kept, an app prefix, no `pid` or `seq`, not exported (§8).
- **P9 (minor) Incomplete disclosure list.** Changed: the notice template with its required fields and the objection
  snippet, the site docs pages, THREAT-MODEL.md, PRIVACY.md's GPC sentence, the console line (API paths and the lasting
  opt-out), and entitlement learned before anything is recorded (§7, §11).
- **P10 (minor) Small counts and regulated sectors.** Changed: `<5` in the dashboard and export, the statement that
  small counts stay pseudonymous personal data, the regulated-data console line and docs, and a counsel question (§7,
  §9, §11, §15.9). Not chosen: suppressing small counts entirely, which would hide most of a small app's dashboard.
- **E1 (blocker) The liveness rules report dead clicks on correct apps.** Confirmed for shadow roots (a
  `MutationObserver` with `subtree` does not observe inside shadow trees), for lost chains (`observe/timers.ts` wraps
  only `setTimeout` and `setInterval`), and for the listed controls. Changed: every signal counts from anywhere,
  including resource loads; observers on open shadow roots; focus from `pointerdown`, window `blur`, selection and
  `beforeprint` count; the exclusions; the verdict at 10 s with `late`; the `no-dead` marker; ship gates with numbers
  (§2.1, §13, §15.12). Not every case has a signal in markup: clipboard writes, downloads from detached anchors and
  some share sheets cannot be seen, so the marker and the gate cover them, and the first draft's claim that the rule
  needs no list is withdrawn.
- **E2 (major) Rage-click false positives.** Confirmed: `dom-user.ts` `interactive()` falls back to the clicked
  element, so a triple click on a paragraph is three recorded clicks on one key. Changed: candidate roles only;
  `change`, `input` and `selectionchange` as answers; 4 clicks in a sliding 1 s window, with 3 measured too; the run
  decided when it ends (§2.2). Not followed: treating one multi-click gesture (`detail` 1, 2, 3) as one click.
  Browsers raise `detail` for any fast clicks on one spot, which is what rage clicking is, so that rule would hide real
  runs; limiting runs to interactive roles already removes text selection.
- **E3 (major) GenClass's and the app's retries inside the joins.** Confirmed: `observe/fetch.ts` starts `retryOp`
  with `cause: failedOp` and hedges with `cause: op`. Changed: outcomes as delivered, one start per original request,
  `retry`, `healed`, `mode` in the envelope, `silent` measured from the last failure with new requests in the chain as
  answers, and `settle` up to "still open at 10 s" (§2, §2.3, §5).
- **E4 (major) Page lifecycle.** Confirmed: nothing in `src/` handles `pageshow`, and `nav.ts` calls its hook inside
  `pushState`. Changed: `(restore)` views; transitions counted from `from` only, `to` removed, exits inferred at the
  collector; views by normalised route, merged when shorter than 1 s without an interaction; flows marked not measured
  on multi-page sites, with a referrer decision (§15.13); scroll samples only from scroll events after 500 ms; `sc` at
  view end with `inner` (§2.4, §2.5).
- **E5 (major) Long-lived tabs.** Changed: the key cap per batch with keys freed after sending, back-off instead of
  stopping, a one-check return while nothing is open, joins kept apart from the dead-click window cap (§4), and a cost
  check that blocks in CI (§12). Corrected: `ci.yml` does run `test/review-perf.test.ts`, in its own step with
  `continue-on-error: true`, so its budgets report and do not block; `release.yml` does not run it. The new check
  counts work on a fake clock instead of timing it, so it can block without that step's runner noise.
- **E6 (major) D1 per-batch upserts.** Confirmed against Cloudflare's D1 pricing and limits pages (rows written $1.00
  per million after 50 million a month for the account; index rows count; one database runs queries one at a time;
  10 GB per database, not raisable). Changed: a per-app Durable Object aggregates and writes once a minute; analytics
  in its own sharded D1 databases; monthly roll-ups; a collector cost table; a quota decision (§6, §8, §15.15). Rows
  written per flush is a worker test (§13).
- **E7 (major) Remote start through telemetry replies misses traffic.** Changed: no header; the config request (§7),
  cached per isolate and in the browser (§8); a coverage figure on the dashboard (§9); the consent call stated (§7).
  The config request is a new request to genclass.dev (token only, after consent) and is listed in §15.1.
- **E8 (major) Real-browser behaviour untested in CI.** Changed: every listed case in §13, a Chromium job in CI
  (decision §15.12, since AGENTS.md lists Playwright as ask-first), and gated rates with proposed thresholds,
  including recall on apps whose libraries change the DOM on press or hover.
- **E9 (minor) Linking by the ambient op counts programmatic clicks.** Confirmed: `programmatic()` drops an untrusted
  `click()` while the outer click's user op is still ambient, so a check of the ambient op would count it. Changed:
  the `dom-user.ts` hook (§2) instead of a second listener, which also removes the listener-order and
  `stopImmediatePropagation` cases; the gate row `no-observer` (§7).
- **E10 (minor) Schema gaps.** Changed: `cand`, `sample` and an `(other)` signature entry, and also `late`, `retry`,
  `healed` and `mode` (§5).
- **E11 (minor) Stale figures.** Changed: the headroom from `release/0.3.0` at `0613c32` (107.73 / 99.61 KB, CI run
  38491077597), which supersedes the review's 0.13 / 0.10 KB from `8641dd7`: 0.01 KB is left on `/auto` (§12); the
  240 KB ceiling stated for `flushMs` 60 s with the formula (§4, §6); view 0 at time 0 (§2.6); what `dis` can see
  (§2.1); the export line against plans.json (§11).
- **E12 (minor) Public tokens can fill an app's daily cap.** Changed: a space-saving top-K per day, validation against
  the grammar, the Origin check, a per-token daily budget (§8), and a THREAT-MODEL.md row (§11).

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
| GenClass v1 | no request, resource load, store write, DOM change (document and open shadow roots), navigation, focus change, window blur, selection change or scroll within 10 s; answers between 2.5 s and 10 s count as late (§2.1) | 4 or more within a sliding 1 s on interactive controls, not counted when the control answered each click (§2.2) | causal: the request's root op is the click; outcomes as delivered to the app (§2.3) | none in v1 (§3) |

GenClass is not the only tool that relates clicks to requests. What it adds is a causal join that does not depend on
timing, the separation of dead from late from silently failed, and a dashboard without replay or page text.

## Appendix B: legal notes (not legal advice)

- **ePrivacy Art. 5(3).** EDPB Guidelines 2/2023 v2.0 (adopted 7 October 2024): script code that instructs the
  browser to send information is "gaining of access" (para 33), also when the information is computed locally
  (para 53), while information used only inside the device is not, "as long as the information does not leave the
  device" (para 44). So the runtime's in-memory observation is outside it, and the analytics transmission is inside
  it; analytics is not "strictly necessary" for a service the user asked for, hence consent by default in the EEA.
  The same reading covers telemetry: the script instructs the transmission, it is not strictly necessary for the
  service the visitor asked for, and Daybot uses it as a controller to train its model, so no audience-measurement
  exemption fits it. In the EEA and the UK, telemetry therefore needs the visitor's consent unless counsel finds
  otherwise (§15.9, §15.11).
- **Exemptions.** The CNIL audience-measurement exemption (guidance of 4 July 2025) and the UK statistical-purposes
  exception (ICO guidance on storage and access technologies) both require the provider to act only for the site,
  not reuse the data for itself, not link it with other data, and produce aggregate statistics; the ICO excludes
  "logs or recordings of individual visitors". The CNIL's self-assessment tool (July 2025) also checks transfers
  outside the EU, and asks the provider to give customers a document attesting the conditions and the settings to use
  (§11). The design here (processor only and enforced in code, never training, no raw batches, aggregates on receipt,
  in-memory per-page-load state only, counts under 5 shown as `<5`, an objection switch) is meant to let a developer
  rely on them with `consent: "not-required"` where they apply; counsel to confirm. The UK exception's commencement
  date was seen only in secondary sources.
- **International transfers.** Daybot operates from Canada, which has an EU adequacy decision for organisations
  subject to PIPEDA (Decision 2002/2/EC, kept in the Commission's January 2024 review); the UK recognises it too.
  Cloudflare is certified under the EU-US Data Privacy Framework and offers standard contractual clauses in its DPA.
  D1 and R2 keep data where Cloudflare places it unless a jurisdiction is set at creation (D1: `eu`, `us`,
  `fedramp`; a location hint is not a guarantee); decision §15.14.
- **Quebec.** Act respecting the protection of personal information in the private sector, s. 8.1: a business that
  collects personal information through technology with functions that allow the person to be identified, located or
  profiled must first inform the person of that technology and of the means available to activate those functions.
  Law-firm summaries of the CAI's consent guidelines (October 2023) read this as off by default. GenClass does not
  know where a visitor is, so `consent: "not-required"` has no Quebec path. s. 17: before personal information is
  communicated outside Quebec, the business assesses privacy factors, including the legal framework where it goes; a
  Quebec developer needs Daybot's data map and storage locations for that (§11). The first draft's citation "CAI
  Guidelines 2023-1 (B.4)" is removed: that section number was not verified.
- **California.** CCPA: a service provider's contract must meet Cal. Code Regs. tit. 11 § 7051 (the specified
  purposes, no selling or sharing, no combining with other data, compliance and audit terms). CIPA: suits under Penal
  Code § 631 (wiretapping) and § 638.51 (pen registers) against website analytics vendors are common. Courts have split
  between treating a vendor that uses the data only for the site as an extension of the site (Graham v. Noom, N.D. Cal.
  2021) and asking whether the vendor is capable of using it for itself (Javier v. Assurance IQ, N.D. Cal. 2023). That
  is why §8's processor-only rule is enforced in code, not only written in the DPA.
- **Canada outside Quebec (PIPEDA).** The OPC's Guidelines for obtaining meaningful consent (2018) call for express
  consent when information is sensitive, when the use is outside the person's reasonable expectations, or when it
  creates a meaningful risk of significant harm. Aggregate usage statistics a site gathers for itself through a
  processor are commonly treated as implied consent with notice and an easy opt-out; `consent: "not-required"` in
  Canada outside Quebec rests on that reading and on the notice (§11). Counsel to confirm.
- **Regulated data.** Routes and keys such as `/conditions/:id` with `button#book-test` can be consumer health data
  under Washington's My Health My Data Act. HHS's guidance on online tracking technologies (December 2022, revised
  March 2024; vacated for unauthenticated public pages in American Hospital Association v. Becerra, N.D. Tex., June
  2024) treats similar data on HIPAA covered entities' sites as protected health information. TELEMETRY.md tells
  developers to turn telemetry off in apps that handle regulated data; analytics carries the same warning (§7, §11,
  §15.9).
- **Pseudonymous, not anonymous.** A page-load id, routes and element keys can single out a visit, so analytics is
  personal data under GDPR Art. 4(1) and Recital 30, described as pseudonymous. Showing counts under 5 as `<5` lowers
  the chance of singling out a visit; it does not remove it.
- **Roles.** For analytics the developer is the controller and Daybot the processor (GDPR Art. 28), and only that:
  §8 bars Daybot's own use of analytics data. For telemetry used to train the shared model, Daybot is a controller.
  Keeping the two streams apart (§1) keeps the roles apart.
