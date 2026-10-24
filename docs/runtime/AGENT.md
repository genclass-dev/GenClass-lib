# GenClass for coding agents: record, replay, explore

A race condition is a bug in *order*: two responses arrive in an order the code did not expect, and the page ends up
showing the wrong thing. Nothing throws, so error monitors see nothing; and it depends on the network's timing, so it
rarely happens on a developer's fast machine and almost never in a test, where mocked APIs answer in order. A coding
agent asked to fix "sometimes the results are wrong" cannot see it, cannot reproduce it, and has no way to show its
fix worked.

GenClass already sits at the one place where that order is decided: the moment each response is handed to the app
(the runtime's delivery gate), with the causal chain of every request and the version history of every state field.
This feature uses that position for three things:

1. **Record** what happened on a page, in order: user actions, requests, the order their responses were delivered,
   state writes, errors, and two happens-before facts (a response that overwrote newer data; identical requests from
   two clicks).
2. **Replay** a recorded order exactly, on any machine: the same responses, delivered in the same order, so a race
   seen once happens every time, and a fix can be shown to hold.
3. **Explore** orders on purpose: run the same steps several times, deliver overlapping responses in different
   seeded orders (optionally slower, like a bad network), and compare the final state with the runs where responses
   came back in request order. A state that depends on the order is a race, by definition, whatever the app is.

A local MCP server (`@genclass/mcp`) gives all of it to a coding agent: findings as they happen, the evidence in
causal order, a replay switch, an explore switch, and a Playwright regression test that fails while the bug is there.

```
 page (dev build)                                   this machine
 ┌──────────────────────────────┐   loopback HTTP   ┌──────────────────────────┐  stdio  ┌──────────────┐
 │ @genclass/runtime            │ ───────────────►  │ bridge (127.0.0.1:47357) │ ◄─────► │ coding agent │
 │  + @genclass/runtime/agent   │   hello, events   │ store: runs, findings,   │   MCP   │ (Claude Code)│
 │    record · schedule · link  │ ◄───────────────  │ explore, replays         │         └──────────────┘
 └──────────────────────────────┘   the schedule    └──────────────────────────┘
```

Status: new in `@genclass/runtime` 0.3.0-beta.1 (unreleased) and `@genclass/mcp` 0.1.0 (unreleased). Measured
results are in section 7 and in [RESULTS.md](RESULTS.md) section 16.

## 1. Setup

```bash
claude mcp add genclass -- npx -y @genclass/mcp@0.1.0   # or: npx -y @genclass/mcp@0.1.0 init  (writes .mcp.json)
```

Or as a Claude Code plugin from this repository's marketplace (`.claude-plugin/marketplace.json`; the plugin is
`packages/mcp/plugin`: the server, a `UserPromptSubmit` hook and a skill whose description tells Claude when to use
it): `/plugin marketplace add genclass-dev/GenClass-lib`, then `/plugin install genclass@genclass`. Other clients
(Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf, Cline, Goose, Zed, JetBrains, OpenCode): the install blocks in
[packages/mcp/README.md](../../packages/mcp/README.md#install), or `npx -y @genclass/mcp@0.1.0 config <client>`.
Every launcher is pinned to the release. `packages/mcp/server.json` is the entry for the official MCP Registry
(published by the release workflow with GitHub OIDC after the npm package); the listings for other directories are
drafted in [docs/adoption/listings/mcp.md](../adoption/listings/mcp.md).

In the app's browser entry, development builds only (`@genclass/runtime` 0.3.0-beta.1 or later):

```ts
import { GenClass } from "@genclass/runtime";
import { connectAgent } from "@genclass/runtime/agent";

const rt = GenClass.init();
if (import.meta.env.DEV) connectAgent(rt); // Next.js: process.env.NODE_ENV === "development"
```

`connectAgent` is a separate entry: one file with no static import of runtime code, so it is never part of the
first-load bundle (`/auto` and the main entry measure 108.54 KB and 100.40 KB gzip, within the limits), and an app's
production build drops it with the dead branch (the package's `sideEffects` list does not name `dist/agent.js`).

It runs only on pages served from this machine (`localhost`, `127.x`, `[::1]`, `*.localhost`: names the browser itself
resolves to loopback) and talks only to a loopback URL; elsewhere it returns an inert connection. A page on a `*.test`
or `*.local` name or a LAN address (names that go through DNS, which a hostile network controls) needs
`connectAgent(rt, { anyHost: true })`, and the bridge must allow that exact origin
(`GENCLASS_AGENT_ORIGINS=http://myapp.test,http://192.168.1.20:5173`).

## 2. Recording (`src/agent/record.ts`)

The recording reads what the runtime already traces (the event log, the ops registry, the store hub) and keeps bounded
lists. It never writes to the event log and never feeds a situation, a decision or the model.

- **Steps**, in time order (times relative to `connectAgent`):
  - `act`: a user action, with the runtime's element description (`button "Pay"`, `input "Search"`), the value (the
    runtime's redaction applies: sensitive fields are `[redacted]`; at most 500 characters), and for a typing burst its
    keystroke count and duration (the pace a replay types at). A burst that goes on after it was sent is sent again;
  - `send`: a request by **key**: its signature and occurrence in this page load, `GET /api/search#3`. The same steps
    give the same keys on every run, whatever the query values or timing, which is what makes a schedule portable. A
    GenClass retry or hedge gets its request's key with a suffix (`#3~retry2`) and does not shift the numbering;
  - `recv`: the moment the app received the response (and how long a schedule held it);
  - `end`: a request that ended without a delivery (failed, aborted, an XHR aborted while held);
  - `write`: a state write, with the request whose response chain made it;
  - `error`: an uncaught error, with the request and action before it.
- **Witnesses**: two happens-before facts, the same relations the runtime computes for its situations:
  - `overwrote-newer`: a request's response chain wrote a field that, since the request started, a *newer* operation
    (one that started after it, outside its causal chain) or the user had written. In words: older data was put over
    newer data. Not counted: fan-out siblings (requests one click or tick started together, whose completion order is
    arbitrary, as in the runtime's delivery triage), writes more than 10 s after the response, and writes by an
    interval tick or a timer of 1 s or more that the response's handler scheduled (a ticker is not the response).
  - `identical-in-flight`: two identical requests (same method, URL and body) in flight together, started by two
    separate user actions. Not counted: a request the app aborted, GenClass's own retries and hedges, and keystrokes
    of one typing burst.
  A witness is a fact, never a diagnosis. Many apps repair an overwrite a moment later; some overwrites are intended.
  Whether one is a bug is decided by the order comparison (section 5), by the model (its own detections are streamed
  too, labelled as the model's), or by the developer. Writes recorded from before `connectAgent` (replayed from the
  event log) never produce witnesses.
- **Errors** with their stack (read from the page's own `error` / `unhandledrejection` dispatch of that error, never
  an older one with the same message) and the causal chain (newest first: request keys and user actions).
- **Snapshots** at quiet points (no event for `settleMs`, default 400 ms; nothing in flight or held; no pending app
  timer of at most 1 s, so a debounced search is not snapshotted before its request): every store field (registered or
  discovered) as the runtime's redacted summary, the page's visible text by line, form values (password, hidden, file,
  card and one-time-code fields, secret-named or secret-labelled fields and anything in `[data-genclass-ignore]` left
  out; the app's `redact` function applies), and requests sent per signature. When the page goes away, a final
  snapshot is sent only if the page is quiet.

## 3. Schedules (`src/agent/schedule.ts`)

A schedule chooses only **when** each response reaches the app, the way a slower or reordering network would. It never
drops, changes or invents a response, never touches a request, and decides nothing about the app.

| order | what it does |
|---|---|
| `natural` | deliver as responses arrive (no hold): recording only. The default when nothing asks for a schedule. |
| `fifo` | deliver in the order the requests started: the serial baseline an explore run is compared with. |
| `seeded` | each request gets a priority hashed from the seed and its key; a response waits while a request with a higher priority is in flight (probabilistic concurrency testing over the requests that overlap). `focus` signatures go last. |
| `given` | a recorded delivery order: each response waits for the keys listed before it. |

`delay: { minMs, maxMs }` adds latency per response, uniform in that range and hashed from the seed and key: a slow
network, deterministically, so overlaps that only happen on a phone happen on the developer's machine too. The delay is
the emulated network and never counts against the hold limit.

Rules:
- A response is never held longer than its delay plus `maxHoldMs` (default 1.5 s); then it is delivered and the run is
  marked *forced* (it did not follow the schedule exactly; reports say so). A waiting response always has a wake-up of
  its own, so a timer that fires a little early by the clock's measure cannot leave it waiting.
- A response counts as delivered when the **app** receives it: in guard or heal the runtime may hold it further for a
  decision, and until it lets it go, later responses keep waiting (bounded by `maxHoldMs`).
- A request that fails or is aborted stops blocking at once; an XHR the app aborts while its response is held is
  dropped, never delivered. Requests older than 10 s (long polls, streams) neither block nor wait.
- Releases are `gapMs` apart (default 30 ms) so one response's handlers run before the next arrives.
- Protected requests (`requests.protect`, the presets) and routes in mode `"off"` are recorded but never held
  (`holdProtected: true` opts in, to explore a checkout on purpose). WebSocket and EventSource messages are recorded but
  never reordered (a socket's messages are ordered on the wire), and failure responses are not held (v1).
- Responses reach the runtime's own delivery path when released, so its facts and decisions see the actual order.

Where a schedule comes from, first match wins: `connectAgent(rt, { schedule })`, the page global
`__GENCLASS_SCHEDULE__` (a test's `addInitScript`), the URL parameter `genclass-schedule` (`fifo`, `seeded:7`,
`given:[...]`, JSON), then the bridge's answer to the page's hello (what the agent armed with `genclass_explore` or
`genclass_replay`). While the hello is pending, a page load's first responses wait for it, at most `helloTimeoutMs`
(600 ms); with no bridge running the hello fails at once and nothing waits; `hold: false` turns every hold off (and
tells the bridge the page runs `natural`). A hello reply that arrives after the timeout finds the page already on
`natural`: the page says so, and the bridge gives the explore or replay slot back.

Deterministic: priorities and delays are hashes (never `Math.random`), and time comes from the runtime's injected clock.

## 4. The bridge and the MCP server (`packages/mcp`)

### 4.1 Bridge (`src/http.ts`, `src/store.ts`)

Listens on `127.0.0.1:47357` (`GENCLASS_AGENT_PORT`). `POST /v1/hello` registers a page load (a **run**) and answers
with its id, a token and its schedule; `POST /v1/events` takes its batched events, only from the same origin with that
token; `POST /v1/api` is the agent API for local processes; `GET /v1/health` identifies it. One bridge serves every
agent session on the machine: a second MCP server that finds the port taken by a GenClass bridge uses that bridge's API
instead of starting its own, and takes the port over if the first session exits.

The store turns events into **findings**, deduplicated by kind, page and signatures (state paths by shape, so a bug on
a new record each run stays one finding), and ranked: `race` (explore), `stale-write` (an `overwrote-newer` witness),
`error`, `duplicate-request` (an `identical-in-flight` witness), `detection` (the on-device model's, labelled as a model
opinion), `check` (measured visual checks), `expectation`, `intervention`. State is kept in `state.json` in the state
directory (`.genclass/agent`, or `GENCLASS_STATE_DIR` relative to the project; it ignores itself in git), so the next
agent session sees what the last one found; the runs findings need are always kept. Armed explores and replays expire
after 30 minutes and are not restored after a restart.

### 4.2 Tools

| tool | what the agent gets |
|---|---|
| `genclass_status` | connected pages (route, schedule, model state), counts of findings, the explore session, armed replays |
| `genclass_findings` | ranked, deduplicated findings with counts and the last replay verdict |
| `genclass_explain` | one finding: the evidence in causal order, the recorded steps and delivery order, the model's last situation, how to replay, and a Playwright regression test |
| `genclass_explore` | `start` (two baselines + N seeded loads, optional `slow_ms`, `focus`, `route`), `report` (the verdict per scenario, race findings with a replayable seed), `stop` |
| `genclass_replay` | `arm` the next page load with a finding's order; `result`: reproduced, not reproduced, or inconclusive (and why) |
| `genclass_analytics` | `local`: per-endpoint counts, median and p95 latency, error rates, failure streaks, per-page runs, errors and overwritten fields, learned relations and flows; `production`: the GenClass dashboard's sessions, detections by diagnosis and page, latest decisions (`GENCLASS_DASHBOARD`) |
| `genclass_setup` | the lines to add for this project's framework (read from `package.json`); changes no file |
| `genclass_clear` | forget runs and/or findings (runs findings still need are kept) |

The server's `instructions` (sent at initialize) tell the agent when to reach for these on its own: an intermittent bug
report; after changing code that fetches, submits, autosaves, polls, debounces or listens to a socket; before calling a
UI change done; and to confirm a bug before fixing it and prove the fix after.

### 4.3 Agent API

`POST /v1/api` with `{ m, p }`: `status`, `findings`, `finding`, `explore.start|report|stop`, `replay.arm|result`,
`analytics`, `digest` (findings changed since a cursor, tied to the store's epoch so a restarted bridge counts from the
start), `clear`. Local processes of the same user only (section 6).

### 4.4 Command and push

- `genclass-mcp` runs the server on stdio. `genclass-mcp init [--hook]` adds it to `.mcp.json` (merging) and, with
  `--hook`, a `UserPromptSubmit` hook to `.claude/settings.json`. `genclass-mcp status` prints the bridge's status.
- **Push.** New findings are sent as Claude Code channel events (`notifications/claude/channel`, the experimental
  `claude/channel` capability; research preview, enabled with
  `claude --dangerously-load-development-channels server:genclass`), at most 3 every 3 s. Without channels, the
  prompt hook (`genclass-mcp hook`) adds findings changed since the last prompt as additional context. Both carry the
  finding id and kind first and page strings quoted; the agent calls `genclass_explain` for the rest.

## 5. Explore and replay

### 5.1 The explore verdict (`src/compare.ts`)

Runs of one explore session are grouped by page and **scenario** (their user actions, in order, typing bursts with their
final value). In each group, the two `fifo` runs are the baseline; with `slow_ms` they get the same extra latency as the
seeded runs, so timing alone never separates them. Anything that differs between the two baselines is **noise** and is
ignored: a store field whose value differs; the records under a store object whose keys differ (new ids on every run:
compared by their values, not their keys); a page line whose shape differs (tokens holding a digit blanked: times,
counters, ids). A seeded run is reported when its final state differs from the baseline beyond that: a store field, a
form value, a request count, a page line, an error only it had. A run that ended right but recorded an
`overwrote-newer` witness the baselines did not is reported separately (older data showed for a moment before a later
response repaired it). A group with only one baseline gets no verdict (its differences are listed unfiltered), and the
page of the first armed load is the page under test unless `route` says otherwise, so other pages and tabs do not take
a slot. No pattern is matched anywhere: the only question is whether the final state depends on the delivery order.

### 5.2 Replays (`store.ts` `replayResult`)

`genclass_replay arm` gives the next page load of the finding's page the order that produced it: an explore race
replays its run's seeded schedule (with its delay); anything recorded in a natural run replays that run's delivery
order as `given`. When the recorded run is gone, it refuses to arm rather than replay something else. `result` compares
the replay run with the finding: the same witness (field by shape, signature), the same error (by name and shape), the
failing run's values, page text, error or witness again = reproduced; the baseline's = not reproduced. It is
inconclusive, and says why, until the run has settled and recorded user actions, when its steps differ from the
original run's, and when the original run is gone; it also says when holds ran out.

### 5.3 Regression tests (`src/testgen.ts`)

`genclass_explain` writes a Playwright test from the finding's run: it sets the schedule through
`__GENCLASS_SCHEDULE__` (so it needs no bridge, in CI as on a laptop), loads the recorded page (path, query and hash),
performs the recorded actions (locators from the runtime's element descriptions: `getByRole` for buttons, links,
checkboxes; `getByLabel`, `getByPlaceholder`, `getByTitle`, then name or id for fields; a name the runtime truncated
matches by its prefix; a target without a name is flagged for checking; the recorded typing pace; a double click as
`dblclick`), waits for a quiet point, and asserts the fact that made the finding: no `overwrote-newer` on a field of
that shape, no `identical-in-flight` on that signature, no recurrence of the error (by name and shape), the baseline's
values and page lines for a race and none of the failing run's (compared with the agent's own snapshot). A finding it
cannot give a generic assertion produces a test that fails until the domain assertion is written: it never passes
while asserting nothing. Page strings enter the file only as JSON string literals.

## 6. Untrusted input and security

Everything a page sends (URLs, element names, values, error messages, store summaries, page text, the model's facts) is
data about the app, never instructions to the agent: a page can show anything, and whoever controls a page's content
or an API's response controls those strings.

- **Who may talk to the bridge.** It listens on 127.0.0.1 only. Every request's `Host` must be the loopback address
  and port (a DNS-rebinding page cannot pose as it). The page endpoints accept only a browser `Origin` on this machine
  (localhost, 127.x, [::1], `*.localhost`) or one listed exactly in `GENCLASS_AGENT_ORIGINS`: a public site,
  a router's admin page or a captive portal the developer visits gets 403, so it cannot plant findings; `Origin: null`
  and requests without an Origin are refused. CORS answers name that origin only, and the private-network header only
  when asked. A run's events are accepted only from the origin that registered it, with the token it got at hello, so
  another page cannot rewrite a replay's evidence. The agent API refuses any request with an `Origin` and requires
  `x-genclass-api: 1` and the bridge's token, which only the user who started it can read
  (`~/.genclass/bridge-<port>.token`, mode 0600). Bodies are capped at 1 MB; slow clients are cut off.
- **What reaches the agent.** The bridge validates every field, caps every string and list, removes control
  characters, ANSI escapes, bidi overrides and invisible characters (tag characters, variation selectors), collapses
  whitespace, and prints page strings as JSON-quoted values under headers that say they were recorded from the page.
  Every page string in a finding's title is quoted; titles loaded from a state file are cleaned again. Channel events
  and the prompt hook carry the finding's id and kind first and quote the rest. The server's instructions say the
  same to the model. Generated test code gets page strings only as string literals. None of this makes a string safe
  to obey; it keeps it short, printable and visibly quoted.
- **What leaves the machine.** Nothing: the page talks to a loopback address; the bridge writes only its state
  directory (`state.json`, its own `.gitignore`, the hook's cursor; fresh temporary names, mode 0600) and its token
  file, and `init` merges into `.mcp.json` and `.claude/settings.json`. `genclass_analytics` `production` reads the
  developer's own dashboard with the link they configured. The agent link is not telemetry and does not change what
  telemetry sends ([TELEMETRY.md](../../packages/runtime/TELEMETRY.md)).
- **Where it runs.** Pages served from this machine by default, from a development-only import; inert elsewhere. Its
  own requests are passed through by the runtime's fetch observer (no op, no event).

## 7. Measured

On the train VM (Node 22, headless Chromium through Playwright 1.63.0), `packages/mcp/test/e2e/race.e2e.mjs`: a search
page whose results are written by each response (no staleness guard), on an in-order backend that answers in 40 ms;
the agent's steps driven through the real MCP server and bridge; the user types "react" at 80 ms a keystroke.

| step | buggy page | fixed page (keeps only the latest answer) |
|---|---|---|
| natural typing (the two baselines) | right: the race never shows on this fast backend | right |
| `genclass_explore` (2 fifo baselines + 6 seeded, `slow_ms: 600`) | **race in 5 of 6** reordered runs (final results for "reac", "rea" or "r" instead of "react"); the 6th ended right after an older response overwrote newer data along the way | **no race**: 0 of 6 reordered runs differ (no false report) |
| `genclass_replay` of the race | reproduced | not reproduced |
| the generated Playwright test | **fails** (expected the results for "react", received "reac") | **passes** |

Review: an adversarial review of the new code (six independent reviewers, a skeptic per serious finding; 55 agents)
confirmed 43 defects, among them a hold that could outlive its limit when a timer fired early, a replay that could
report a fix after its recorded run was gone, new record ids read as races, LAN origins accepted by default, page
strings unquoted in titles and channel events, and false witnesses from parallel requests of one click. All are fixed
and covered by tests; a second pass (one verifier per area, a skeptic per claim) found 35 of the 43 fixes complete and
8 partial, and confirmed 6 more issues, among them race findings on fresh record ids replayed by a field name no real
snapshot has, and a session that took the bridge over only on its next tool call; those are fixed and tested too. The
measurements above were taken again after all fixes. The first pass also found a reused XHR object
whose aborted held delivery could release the next request's listeners early, a defect of the runtime's own holds as
well, fixed in `src/observe/xhr.ts`.

Tests: 36 in `packages/runtime/test/agent.test.ts`, 57 in `packages/mcp/test/`; the runtime's whole suite passes, and
the first load stays within its limits.

This is one page and one bug class, a proof of the mechanism, not a recall figure. The demos' and real apps' numbers
(with the false-report rate next to each) are the next measurement (section 8).

## 8. Limits and next steps

- Explore needs the same steps repeated, one page load each, and each run must reach a quiet point. A scenario whose
  requests come in a different order on each run gets different keys and is not compared reliably.
- WebSocket and EventSource messages are recorded, not reordered; failure responses are not held. Both are next.
- The script-tag build has no agent entry yet (ESM only).
- Production: today the agent reads production through the dashboard (counts by diagnosis and page) and reproduces
  locally with `focus` on the flagged signature. Sending production witnesses (the recorded order of a real user's
  failing session, without page text) is the natural next step and widens what telemetry sends, so it needs the
  owner's OK first (AGENTS.md rule 8).
- Next measurement: explore on the six demos and the real-apps sweep, reporting races found next to false reports on
  their correct variants.

## 9. Relation to the rules

- **Rule 1 (never make a correct app worse; observe never holds).** The link is a test harness a developer imports in
  development builds, and an exception to "observe never holds", recorded in AGENTS.md rule 1 and CONTRACT.md section
  16: with a schedule it holds responses (each at most its delay plus `maxHoldMs`); without one it holds only a page
  load's first responses until the bridge's hello (at most `helloTimeoutMs`, 600 ms); `hold: false` turns every hold
  off. Every response is still delivered, unchanged; protected requests are never held (unless `holdProtected`). A correct app is, by
  definition, insensitive to the order its responses arrive in, so a schedule cannot make it wrong; it only shows what
  was already wrong.
- **Rule 2 (no hardcoded bug patterns).** Witnesses are happens-before facts the runtime already computes; the explore
  verdict compares final states. Neither maps a pattern to a diagnosis or an action in the runtime, and neither feeds
  the gate. The MCP server labels findings by the fact that made them (a witness, an error, a difference), outside
  the runtime.
- **Rule 3 (model-visible text frozen).** `src/situation/*`, `util.ts`, op and event names are untouched.
- **Rule 5 (determinism).** The agent entry uses the injected clock and hashes; no `Math.random`, `Date.now`,
  `performance.now` or global `setTimeout` (it wraps the page's `setTimeout` to observe pending timers, and schedules
  nothing with it).
- **Rule 7 (dependencies).** None added: `@genclass/mcp` has no runtime dependencies.
- **Rule 8 (telemetry).** Nothing is sent off the machine; telemetry is unchanged.
