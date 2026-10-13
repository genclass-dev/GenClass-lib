# Flow expectations (v1: learn and report; no actions)

Status: in `@genclass/runtime` Unreleased (after 0.2.2) as a deterministic, reporting-only layer.
Code: `packages/runtime/src/learn/flows.ts`, wired in `src/runtime.ts`; tests in `test/expectations.test.ts`.
Nothing here is model-visible (CONTRACT §0 rule 1 and AGENTS.md rule 3 are untouched: no new fact, trigger,
question or situation text), and nothing here acts in any mode. The one learned state the model does read, the
transition profiles, is persisted exactly as before this change (only with an explicit `learn.persist`, CONTRACT
§4), so what reaches the model in a default install is unchanged (§4).

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
| observations `n`, of them `rep` repeats of the action within one page load, distinct `sessions`, last session ordinal | every closed flow instance | counts |
| `settle`: time from the action to its last request's end | per instance | 32-sample window |
| `children[sig]`: requests the action starts (ops whose root is the user op): times started (`n`, `r` of them in repeats), times answered ok, delay from the action, the **branch** it started on (`own`: hash of the set of fields the action's own handler wrote, with a count), whether any was under `requests.protect` | `startOp`/`endOp`, store writes | 16 signatures per flow, 8 branches each |
| `writes[sig][field]`: fields each response's handler writes (normalised like transition profiles; secret-named fields never). A write is credited to the nearest request in its causal chain, so a refetch's writes are the refetch's | `onApplied`, per request op of the flow | 16 fields per signature |
| `follows[A → B]`: B started after some A of the flow answered ok, with the delay from the nearest such A and the branch of A's handler (`when`: hash of the fields A's handler wrote) | per instance | 16 pairs per flow, 8 branches each |
| `nav[route]`, `navDelay`, `navKeys`: the route the page navigated to during the flow, and the branch (hash of every field the flow wrote) it navigated on | the nav observer | 8 routes, 8 branches |

A flow **instance** opens when a user op of kind `click`, `submit`, `change` or `key` (Enter) is recorded
(typing never opens one), collects the requests whose causal root is that user op, and closes
`max(1.5 s, 2 × p95 settle, 2 × p95 nav delay)` after the action, and no sooner than the flow's usual tail after its
last answer (that bound minus the p95 settle, at least 0.5 s), so what a slow answer's handler does is still seen
(bounded at 15 s after the action; postponed in 0.5 s steps while a request of the flow is in flight). Closing learns
the instance into the flow record. The second click of a double click (`UserAction.clicks > 1`) and a click on a
disabled control (`UserAction.data.disabled`, set by the DOM observer) open nothing. The same action again while its
instance is still open (a second submit that the app's in-flight guard ignores, a stepper clicked three times) opens
nothing either and marks the open instance **repeated**. Instances open while the page is hidden, and instances
whose page was left by another action's navigation, are neither learned nor reported (timers are throttled in a
background tab; an abandoned flow says nothing about the usual one).

Bounds: 500 flows in total, 64 per route (least-recently-used dropped), 64 open instances (the oldest is dropped
unchecked and unlearned), one timer per open instance, 2,000 flow keys remembered per page load for the repeat
rule; stored records are held to the same bounds (flows per route and in total, steps, pairs, routes, branches and
fields per flow) when they are loaded. When a flow reaches 64 observations every count in it is halved (steps,
pairs, routes and branches that reach 0 are dropped): shares stay, and what the app does now outweighs what it did
long ago. The existing transition profiles (`learn/profiles.ts`) and baselines are unchanged and still feed the
model; the flow layer reads nothing the model reads and writes nothing it reads.

## 2. What is reported, and when

A step is **expected** when the flow has enough observations (`learn.minSupport`: 8 while every observation is from
this page load, 20 once stored observations from earlier page loads count, the audit's "n ≥ 8 in-session or ≥ 20
persisted"), spread over `sessions ≥ minSessions` (default 3 when learned state is kept in localStorage; 1 when
nothing is stored or it is kept in sessionStorage, because another session can then never be seen), and the step
occurred in `≥ minShare` (default 0.95) of them, and it was not reported missing since it was last seen (below).
All three are `InitOptions.learn` options; a number for `minSupport` sets both supports. A **session** is a
browsing session of a tab: its ordinal is kept in sessionStorage (`genclass:learn:session`), so a reload continues
it and only another tab or a later visit is a new one (without sessionStorage every page load counts). The 0.95
share is the brief's number; with `n = 8` it means 8 of 8, at `n = 20` it allows one miss. For a **repeat** of the
action within the same page load the step must also have occurred in `≥ minShare` of as many earlier repeats (a tab
whose data an app cache serves the second time it is opened is held to what second opens did). A step is checked
only on the branch it was learned on (§3).

| kind | condition | when it is checked | message (one console line; `Report.expectation` carries the numbers) |
|---|---|---|---|
| `request` | an expected child signature that changes data (method other than GET, HEAD, OPTIONS) did not start, and no request with that signature started from anywhere since the action | a clock timer at `max(1 s, 2 × p95 of its learned delay)` after the action (≤ 10 s) | `Expected a request on /cart: clicking button "Add to cart" usually sends POST /api/cart (41 of 41 times across 6 sessions, within 0.4 s); this time nothing was sent in 2.0 s.` |
| `follow-up` | A answered ok (status below 400), and B, which follows A in `≥ minShare` of A's ok answers (`≥ minSupport` of them), did not start; A or B changes data | `max(1 s, 2 × p95 of the learned A→B delay)` after A's end | `Expected a follow-up on /checkout: after POST /api/orders completes, clicking button "Place order" usually sends GET /api/orders (40 of 41 times, within 0.1 s); this time nothing followed in 1.0 s.` |
| `write` | a request of the flow that changes data answered ok and its handler wrote nothing (not even the value the store already had), while in `≥ minShare` of `≥ minSupport` ok answers it wrote a field; not for a repeated instance | when the instance closes | `Expected a state change on /cart: the response to POST /api/cart after clicking button "Add to cart" usually writes cart.items (41 of 41 times); this time it wrote nothing.` |
| `navigation` | the action usually leads to a route (`≥ minShare` of `n`), no navigation happened during the flow, and no request of the flow is still in flight | when the instance closes | `Expected a navigation on /checkout: clicking button "Place order" usually leads to /confirmation (41 of 41 times, within 1.2 s); this time the page stayed on /checkout for 3.0 s.` |
| `response` | a request whose signature has `≥ minSupport` (8) timed completions in this page load and answered in `≥ minShare` of its recent outcomes is still in flight past `max(2 × p99 latency, 1 s)`, this origin has been seen in `≥ minSessions` sessions (this one included), and no line was printed for the signature since one of its requests last answered | on the stall timer (`watchStall`, extended) | `Expected a response: GET /api/items usually answers within 0.4 s (p99 of the last 64; 20 of 20 recent requests answered); this one has been waiting 2.1 s (bound 1.0 s).` |

A signature that is a learned follow-up of another request is reported only through the follow-up check (so a
failed POST never produces a "missing GET" line, and a missing GET after a good POST is one line, not two). One
report per instance. Repeats of the same line within a minute are folded by the reporter
(`×N more in the last minute`), as for every other report.

Where a report goes: `rt.on("expectation", fn)`, the `report` listener and the `report` option (`kind:
"expectation"`, `expectation: Expectation`), the console (a collapsed group: what was learned, what happened this
time, that no model and no action were involved, `GenClass.runtime.learned()`, how to turn it off), and sinks
(`SinkRecord.kind "expectation"`, `SinkRecord.expectation` with the counts and signatures; the action label only in
`evidence.message` when the sink asked for evidence). `report: "interventions"` prints none of them. Telemetry
never sends them: the telemetry client forwards decisions, detections, actions, undos, breaker and limit events
only (`src/telemetry/client.ts`); TELEMETRY.md says so under its event table.

**After a report.** The step that was reported missing is marked (`missed` in `rt.learned()`, stored with the flow)
and is not expected again until it is seen again; the miss is also learned into the counts (the app's behaviour
defines "usual"). So a permanent change in the app's behaviour (an endpoint renamed, a refetch dropped) gives one
line per changed step, not one per returning visitor: without the mark, a step seen 41 of 41 times would stay above
0.95 for two more misses (41 of 42, 41 of 43), and for about n/19 misses at larger n. An intermittent bug is reported
again the first time it recurs after the step was seen again, and only while the share stays at or above
`minShare`. `test/expectations.test.ts` checks this with 42 stored observations, a renamed endpoint and three more
visits: one line.

Known limits of v1 (not detected): a DOM change that never rendered (the runtime has no DOM or render observer;
store writes and React commits are the proxy), a GET that was never sent or whose answer was never written (an app
cache or an unchanged answer explains both; only its absence as a follow-up of a request that changes data is
reported), a request that is routinely conditional (share below 0.95 is never expected, by design), flows that
depend on which element of a list was clicked (labels with digits are merged, different labels are different
flows), requests started from a timer the runtime does not trace (a debounced save is not a child of the click).
A long-poll request that usually answers at once and sometimes holds for its full timeout would produce a `response`
line; list it in `requests.ignore` or `requests.protect` (neither is checked), or turn the layer off
(`learn.expectations: false`), if that happens.

## 3. False-positive controls

One false "your button did nothing" on a working checkout costs the same trust as a false intervention, so the
layer reports only when all of these hold. Each control is a learned count or a property of the request (its
method, its answer's status class); none maps a pattern of facts to a verdict.

- support: `n ≥ 8` in one page load or `≥ 20` with stored observations, `sessions ≥ 3` with persistence, share
  `≥ minShare` (above; the audit's recommendation); flows are per route, so `Save` on `/editor` and on `/settings`
  never share counts. The thresholds alone do not make a handler that skips its request 10% of the time by design
  safe (a `confirm()` cancelled, a check kept in state GenClass does not see): it shows 8 of 8 with probability
  0.9^8 ≈ 0.43 and 19 or more of 20 with 0.9^20 + 20 × 0.1 × 0.9^19 ≈ 0.39. What bounds the cost is the next control
  and the share: after one reported skip the share is below 0.95 (at most 19 of 21), so such a handler gets an
  occasional line when its share drifts back up, not one per skip;
- **once per change**: a step reported missing is not expected again until it is seen again (§2, "After a report");
  a run of hanging requests of one signature is one `response` line;
- **branch**: a step is expected only on the branch of the handler it was learned on. For a request, the branch is
  the set of fields the action's own handler wrote (a submit whose handler wrote a validation error and sent nothing
  is another branch: not a gap; the same submit that marked the form as placing and sent nothing is); for a
  follow-up, the set of fields the predecessor's handler wrote; for a navigation, every field the flow wrote;
- **repeats** within a page load are held to what earlier repeats did (above);
- **requests that change data**: only a request whose method is not GET, HEAD or OPTIONS is expected to start, or
  to write after its answer (a GET may be served by an app cache, an unchanged answer may be left unwritten, and a
  typeahead drops stale answers by design); a follow-up only when one of the pair changes data;
- an answer with status 400 or above is the server declining: its handler writing nothing is not a gap, and it is
  no predecessor of a follow-up;
- a request with the expected signature started from anywhere since the action (one whose cause was not traced back
  to the click) counts as sent;
- a write that left the value as it was still counts as handling the answer (atoms and adapters report every write;
  observed stores, such as discovered React state, report it through the observe path);
- the same action again while its instance is open opens nothing, and the open instance's writes are neither
  checked nor learned (a stepper's earlier answer superseded by a later one);
- the instance was opened and checked with the page visible, its page was not left by another action's navigation,
  `navigator.onLine` is not `false`, and the runtime is not paused (`rt.pause()`);
- the step is not a request under `requests.protect` (a protected child marks its signature `protected` for the
  flow; it is never expected, and its writes are not learned); nothing is learned or reported on routes whose
  `routes[]` rule says `mode: "off"`;
- the action was not the second click of a double click, not on a disabled control, and not typing;
- a navigation is not missing while a request of the flow is still in flight (a slow answer), and the flow stays
  open for its usual tail after its last answer;
- deadlines come from the learned delay distribution (p95, doubled) with a 1 s floor, so a slow backend does not
  turn a late request into a missing one; `response` needs twice the p99, at least a second, and (with persistence) the third session;
- one report per instance; reporter rate limit per minute; nothing is ever held, delayed, retried or changed
  because of a report; the layer runs inside `try/catch` and never throws into the app.

Acceptance before this ships to the site's claims: zero expectation reports across the six demos' clean trials
(`demos/results.md` lists 15 clean trials per mode per demo). That run needs the demos' Playwright eval, which is
not part of CI and was not run for this change (see the status note at the end).

## 4. Persistence

What is stored depends on `learn.persist`:

| `learn.persist` | flows (this layer; reporting only) | transition profiles (read by the model) |
|---|---|---|
| unset (the default) | localStorage | memory only, as in 0.2.2 and CONTRACT §4 |
| `true` / `"local"` | localStorage | localStorage |
| `"session"` | sessionStorage | sessionStorage |
| `false` | memory only | memory only |

With `learn.persist` unset, nothing is stored when the page runs in jsdom or happy-dom (an app's unit tests, which
would otherwise share learned state from one test to the next), when `learn.expectations` is false, or when storage
does not work (a probe key, `genclass:learn:probe`, is set and removed once at init; a privacy mode or a full quota
throws). Without stored state the thresholds are those of one page load (8 observations, 1 session), so the layer
still works and says why in `debug` mode.

**Why profiles are not stored by default.** Transition profiles raise `transition` triggers once an operation has 20
completions; storing them by default would let those counts build up across page loads, so more `transition`
situations would reach the model, and in guard or heal its `rollback` or `resync` could act on them. Neither the
demos' nor the real apps' FIR and never-worse runs cover that path (they start each trial in a fresh browser
context), and after an app deploy without a `learn.version` the stored profiles would describe the old app. So this
layer leaves the model's inputs as they were: profiles are stored only when the app asks for it, which is the
0.2.2 behaviour. Storing them by default needs the owner's approval in CONTRACT §13 and a two-session clean-trial
FIR run first.

One key (`learn.key`, default `genclass:learn`), one JSON value:

```json
{ "format": 2, "lib": "<runtime version>", "version": "<learn.version | session.tags.release>", "sessions": 7, "profiles": [], "flows": [...] }
```

A value of another `format`, another runtime version (`lib`) or another `version` is discarded, never migrated (the
0.2.2 value, which had no format, too): learning starts over after every library upgrade and every release that
sets `session.tags.release` or `learn.version`. Without either, an app deploy keeps the stored flows; the `missed`
mark (§2) and the halving at 64 observations (§1) bound what an outdated flow can cost.

`sessions` counts the sessions that stored state; a new session's ordinal is `sessions + 1` (`rt.learned().session`),
a reload in the same tab keeps the tab's ordinal (sessionStorage, `genclass:learn:session`), and a flow's `sessions`
counts the distinct ordinals it was observed in. A new session schedules one save, so sessions are counted even when
nothing was clicked.

What is stored: request signatures (id-like path segments normalised), routes, field names (keys with digits
normalised; secret-named fields never), counts, delay samples, branch hashes, `missed` marks, and for user actions
only `fnv1a(route | kind label)`: no element text, no values, no query strings. Routes and field names are stored as
the app has them apart from that normalisation: a path segment that does not look like an id (`/u/jane.doe@example.com`,
`/search/red-shoes`) or a store keyed by something other than an id (an email as a map key) is stored as is. Transition
profiles of user actions (`user click button "…"`), when stored, are kept under `user#<fnv1a>` and renamed back in
memory when the action is seen again. The stored value is capped at `learn.maxBytes` (default 200,000 characters):
the most-used flows and the profiles with the most completions are kept, taken in turn, until the next one does not
fit; only the stored copy is trimmed, what is in memory stays, and a cap below the value's header removes the stored
value. Stored state is checked field by field and against the learner's bounds when it is loaded (anything malformed
is dropped or zeroed, anything beyond a bound dropped, least used first). `rt.learn.clear()` forgets memory, storage
and a pending save. The runtime's own `setItem`/`removeItem` are not recorded by the storage observer (so they never
enter a timeline). Saves are debounced (5 s), written when the page is hidden or unloads and on `rt.destroy()`, and
never run from a hold path. With several tabs open, the last one to save wins. Base latency baselines are not stored,
so `response` always measures this page load's latencies.

**CONTRACT.md.** CONTRACT §4 covers transition profiles only, and their default is unchanged. Storing the learned
flows by default is a new default (a value in the visitor's localStorage on every origin that installs GenClass,
including in observe mode); it should be recorded as a §13 addition once the owner approves it. Nothing else here
departs from the contract: §8's reporting (one line, collapsed evidence, rate-limited repeats) is reused as is, and
the `Report.kind` union it lists had already been extended (`undo`, `breaker`, `error`) before `expectation` was
added.

## 5. Developer-facing output

- `rt.learned()`: `{ route, session, flows, deviations, relations }`, the flows of the current route first (then the
  others, most observed first), each with its children, writes, follow-ups and navigations, their counts, shares,
  delay quantiles and whether they are expected now (`expected` for the first time in a page load,
  `expectedOnRepeat` for a repeat); `deviations` is the last 50 expectation reports; `relations` the learned
  invariants.
- Devtools: an **Expectations** tab (`@genclass/runtime/devtools`) listing recent deviations, the learned flows as
  `click button "Place order" on /checkout: 41 observations (12 repeated in a visit), 6 sessions, settles in 0.8 s`
  followed by its steps (`→ POST /api/orders (41/41, within 0.4 s) · expected`, `✎ POST /api/orders writes
  orders.items (41/41)`, `↳ GET /api/orders after POST /api/orders (40/41)`, `⇒ /confirmation (41/41)`; a step
  reported missing shows `· missed: not expected until seen again`), and the learned relations
  (`test/devtools.test.ts` checks the tab on a real runtime).
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

Done in this change: §1–§5 (learner, five absence kinds, the false-positive controls of §3, flows stored by default
with hashing, a size cap, a format and runtime-version tag, `rt.learned()`, the devtools tab,
console/listener/sink output), with unit tests on the fake clock (`test/expectations.test.ts`,
`test/devtools.test.ts`, run in CI). Not done: the clean-trial acceptance run on the demos (needs Playwright, not in
CI), including a two-session run on the stored path; a stable learning key (role + label + nearest form or test id:
dynamic or localised labels still split one button into several flows); fleet aggregation across visitors (needs a
server and an opt-in); the model phase (§7). The counts in the example lines are illustrations of the format, not measurements. The one measured
number is the first-load JavaScript cost, quoted with its source in RESULTS.md ("Flow expectations") and the
package README ("Costs"). Recall and false-report rate on the demos are unmeasured until the acceptance run above;
the site must not quote this layer until then.
