# Flow expectations (v1: learn and report; no actions)

Status: shipped in `@genclass/runtime` (Unreleased, after 0.2.1) as a deterministic, reporting-only layer.
Code: `packages/runtime/src/learn/flows.ts`, wired in `src/runtime.ts`; tests in `test/expectations.test.ts`.
Nothing here is model-visible (CONTRACT §0 rule 1 and AGENTS.md rule 3 are untouched: no new fact, trigger,
question or situation text), and nothing here acts in any mode.

The idea it implements: GenClass should learn how users interact with the page, build a picture of what is
supposed to happen after each action, and report the gap when something that usually happens does not. Every
trigger the runtime had before this fires on something that *happened* (a write, a request, a response, a failure,
an invariant break); the demos' lost-commit and stuck-"Placing…" bugs are silent, so no model fed by those triggers
could ever reach them. This layer fires on *absence*.

## 1. What is learned

Per **flow key** = (route, user action), where the route is the path with ids normalised (`/orders/:id`) and the
action is `kind` + the element description with digits normalised (`click button "Add n items"`):

| learned | from | kept |
|---|---|---|
| observations `n`, distinct `sessions`, last session ordinal | every closed flow instance | counts |
| `settle`: time from the action to its last request's end | per instance | 32-sample window |
| `children[sig]`: requests the action starts (ops whose root is the user op); times started, times completed, delay from the action; whether any was under `requests.protect` | `startOp`/`endOp` | 16 signatures per flow |
| `writes[sig][field]`: fields each response's chain writes (normalised like transition profiles; secret-named fields never) | `onApplied`, per request op of the flow | 16 fields per signature |
| `follows[A → B]`: B started after some A of the flow completed, with the delay | per instance | 16 pairs per flow |
| `nav[route]`, `navDelay`: the route the page navigated to during the flow | the nav observer | 8 routes |

A flow **instance** opens when a user op of kind `click`, `submit`, `change` or `key` (Enter) is recorded
(typing never opens one), collects the requests whose causal root is that user op, and closes
`max(1.5 s, 2 × p95 settle, 2 × p95 nav delay)` after the action (bounded at 15 s; postponed in 0.5 s steps while a
request of the flow is still in flight). Closing learns the instance into the flow record. The second click of a
double click (`UserAction.clicks > 1`) and a click on a disabled control (`UserAction.data.disabled`, set by the
DOM observer) open nothing. Instances opened or checked while the page is hidden are neither learned nor reported
(timers are throttled there; a browser's "usual delay" measured in a background tab means nothing).

Bounds: 500 flows in total, 64 per route (least-recently-used dropped), 64 open instances, one timer per open
instance. The existing transition profiles (`learn/profiles.ts`) and baselines are unchanged and still feed the
model; the flow layer reads nothing the model reads and writes nothing it reads.

## 2. What is reported, and when

A step is **expected** when the flow has `n ≥ minSupport` (default 8) observations over `sessions ≥ minSessions`
(default 2; 1 when `learn.persist` is false, because a second session can then never be seen) and the step occurred
in `≥ minShare` (default 0.95) of them. All three are `InitOptions.learn` options. The 0.95 share is the brief's
number; with `n = 8` it means 8 of 8, at `n = 20` it allows one miss.

| kind | condition | when it is checked | message (one console line; `Report.expectation` carries the numbers) |
|---|---|---|---|
| `request` | an expected child signature did not start | a clock timer at `max(0.5 s, 2 × p95 of its learned delay)` after the action (≤ 10 s) | `Expected a request on /cart: clicking button "Add to cart" usually sends POST /api/cart (41 of 41 times across 6 sessions, within 0.4 s); this time nothing was sent in 2.0 s.` |
| `follow-up` | A completed with status ok, and B, which follows A in `≥ minShare` of A's completions (`≥ minSupport` of them), did not start | `max(0.5 s, 2 × p95 of the learned A→B delay)` after A's end | `Expected a follow-up on /checkout: after POST /api/orders completes, clicking button "Place order" usually sends GET /api/orders (40 of 41 times, within 0.1 s); this time nothing followed in 0.5 s.` |
| `write` | a request of the flow completed ok and its response chain wrote nothing, while in `≥ minShare` of `≥ minSupport` completions it wrote a field | when the instance closes | `Expected a state change on /cart: the response to POST /api/cart after clicking button "Add to cart" usually writes cart.items (41 of 41 times); this time it wrote nothing.` |
| `navigation` | the action usually leads to a route (`≥ minShare` of `n`) and no navigation happened during the flow | when the instance closes | `Expected a navigation on /checkout: clicking button "Place order" usually leads to /confirmation (41 of 41 times, within 1.2 s); this time the page stayed on /checkout for 3.0 s.` |
| `response` | a request whose signature has `≥ minSupport` timed completions and answered in `≥ minShare` of its recent outcomes is still in flight past `max(2 × p99 latency, 1 s)` | on the stall timer (`watchStall`, extended) | `Expected a response: GET /api/items usually answers within 0.4 s (p99 of the last 64; 20 of 20 recent requests answered); this one has been waiting 2.1 s (bound 1.0 s).` |

A signature that is a learned follow-up of another request is reported only through the follow-up check (so a
failed POST never produces a "missing GET" line, and a missing GET after a good POST is one line, not two). One
report per instance and signature. Repeats of the same line within a minute are folded by the reporter
(`×N more in the last minute`), as for every other report.

Where a report goes: `rt.on("expectation", fn)`, the `report` listener and the `report` option (`kind:
"expectation"`, `expectation: Expectation`), the console (a collapsed group: what was learned, what happened this
time, that no model and no action were involved, `GenClass.runtime.learned()`, how to turn it off), and sinks
(`SinkRecord.kind "expectation"`, `SinkRecord.expectation` with the counts and signatures; the action label only in
`evidence.message` when the sink asked for evidence). `report: "interventions"` prints none of them. Each miss is
also learned into the flow (the app's behaviour defines "usual"), so a permanent change in the app's behaviour
silences itself after one line, and after a single miss at `n = 8` the step needs about 11 clean observations
before it is expected again; an intermittent bug is reported each time the share recovers.

Known limits of v1 (not detected): a DOM change that never rendered (the runtime has no DOM or render observer;
store writes and React commits are the proxy), a request that is routinely conditional (share below 0.95 is never
expected, by design), flows that depend on which element of a list was clicked (labels with digits are merged,
different labels are different flows).

## 3. False-positive controls

One false "your button did nothing" on a working checkout costs the same trust as a false intervention, so the
layer reports only when all of these hold:

- support: `n ≥ minSupport`, `sessions ≥ minSessions`, share `≥ minShare` (above); flows are per route, so
  `Save` on `/editor` and on `/settings` never share counts;
- the instance was opened and checked with the page visible, and `navigator.onLine` is not `false`;
- the step is not a request under `requests.protect` (a protected child marks its signature `protected` for the
  flow; it is never expected, and its writes are not learned); nothing is learned or reported on routes whose
  `routes[]` rule says `mode: "off"`;
- the action was not the second click of a double click, not on a disabled control, and not typing;
- a missing follow-up needs its predecessor to have completed with status ok;
- deadlines come from the learned delay distribution (p95, doubled) with a 0.5 s floor, so a slow backend does not
  turn a late request into a missing one; `response` needs twice the p99 and at least a second;
- one report per instance and signature; reporter rate limit per minute; nothing is ever held, delayed, retried
  or changed because of a report.

Acceptance before this ships to the site's claims: zero expectation reports across the six demos' clean trials
(`demos/results.md` lists 15 clean trials per mode per demo). That run needs the demos' Playwright eval, which is
not part of CI and was not run for this change (see the status note at the end).

## 4. Persistence

Learned state persists per origin **by default** (`learn.persist` defaults to `"local"`; `"session"` uses
sessionStorage; `false` keeps it in memory). One key (`learn.key`, default `genclass:learn`), one JSON value:

```json
{ "version": "<learn.version | session.tags.release>", "sessions": 7, "profiles": [...], "flows": [...] }
```

`sessions` counts the sessions that persisted state before; the current session's ordinal is `sessions + 1`
(`rt.learned().session`), and a flow's `sessions` counts the distinct ordinals it was observed in. What is stored:
request signatures (ids normalised), normalised routes, normalised field names (secret-named ones never), counts,
delay samples, and for user actions only `fnv1a(route | kind label)`: no element text, no values, no URLs with
query strings. Transition profiles of user actions (`user click button "…"`) are stored under `user#<fnv1a>` for the
same reason and renamed back in memory when the action is seen again. The value is capped at `learn.maxBytes`
(default 200,000 characters): the least-used flows and the smallest profiles are dropped first. A `version` change
discards the stored value; `rt.learn.clear()` forgets memory and storage. The runtime's own `setItem`/`removeItem`
are not recorded by the storage observer (so they never enter a timeline). Saves are debounced (5 s) and never run
from a hold path.

Before this change `learn.persist` defaulted to false, which is why user-action learning almost never activated:
transition profiles need 20 completions of the same action and nobody clicks "Place order" 20 times in one visit.

**Conflict with CONTRACT.md, stated rather than resolved here:** CONTRACT §4 ("Transition profiles") says profiles
are "per app session (in memory), optionally persisted to `localStorage` behind `learn: { persist: true }`". This
change makes persistence the default (the brief for this layer asks for it; `learn.persist: false` restores the
contract's behaviour). CONTRACT §13 is where the owner records approved deviations; until it does, the contract text
and the shipped default disagree on this one point. Nothing else here departs from the contract: §8's reporting
(one line, collapsed evidence, rate-limited repeats) is reused as is, and the `Report.kind` union it lists had
already been extended (`undo`, `breaker`, `error`) before `expectation` was added.

## 5. Developer-facing output

- `rt.learned()`: `{ route, session, flows, deviations, relations }`, the flows of the current route first, each
  with its children, writes, follow-ups and navigations, their counts, shares, delay quantiles and whether they are
  expected now; `deviations` is the last 50 expectation reports; `relations` the learned invariants.
- Devtools: an **Expectations** tab (`@genclass/runtime/devtools`) listing recent deviations, the learned flows as
  `click button "Place order" on /checkout: 41 observations, 6 sessions, settles in 0.8 s` followed by its steps
  (`→ POST /api/orders (41/41, within 0.4 s) · expected`, `✎ POST /api/orders writes orders.items (41/41)`,
  `↳ GET /api/orders after POST /api/orders (40/41)`, `⇒ /confirmation (41/41)`), and the learned relations.
- Console: one line per deviation in the house style, with the collapsed evidence group described in §2.

## 6. v2 candidates: filling the gap safely

Nothing in v1 acts. Of the owner's "fill the gap" half, three candidates are compatible with CONTRACT §0.5 and §7
(guard actions never invent data or fail a request; `retry` harm on committed POSTs is documented in RESULTS.md):

1. **`refetch`** (heal tier): re-issue an idempotent GET that the flow says always follows (a `follow-up` miss whose
   signature is a GET without a body), gated like every heal action (policy, rate limits, breaker, protected
   scopes) and reported with undo (nothing to undo: the response is delivered as any other).
2. **`resync`** (existing heal action): call the store's `resync` handler on a `write` miss for a store that has one.
3. **An app hook, `learn.onGap(e: Expectation)`** (or `rt.on("expectation")` today): the app decides (re-enable the
   button, show "still saving…", refetch). This is the recommended path: it needs no gate and cannot be wrong
   about intent.

Never: re-firing a click or a handler, replaying a non-idempotent POST, navigating for the user, synthesising a
render. These are the uninstall scenario of §0.5.

Both automatic candidates need a decision, and v1 deliberately has none: a `refetch` on a missed follow-up is only
safe when the predecessor's commit is certain and the GET is idempotent. They should go behind the model gate, not
an if/then, which is §7 below.

## 7. What would need the model (a new situation tag)

Teaching the model about expectations means new facts (`This click usually sends POST /api/cart within 0.3 s
(41 of 41); 2.1 s have passed and nothing was sent`), an `expectation` trigger with passive `ignore` and the
actions `resync` / `refetch`, simulator features that drop a handler's request or follow-up (the sim's fault
vocabulary has swallow/stale/timeout/duplicate/conflict/reorder/5xx and nothing for a dead click), a new tag
(`situation-v2.4`), regenerated data, an `rt.py` mirror update and retraining, plus the demo-oracle rows for the
stuck-"Placing…" and lost-commit cases. That is the owner's call (AGENTS.md rule 3) and is out of scope here.

## Status note

Done in this change: §1–§5 (learner, five absence kinds, FIR controls, persistence on by default with hashing and a
size cap, `rt.learned()`, the devtools tab, console/listener/sink output), with unit tests on the fake clock.
Not done: the clean-trial acceptance run on the demos (needs Playwright, not in CI); fleet aggregation across
visitors (needs a server and an opt-in); the model phase (§7). No number in this document is a measurement; the
counts in the example lines are illustrations of the format.
