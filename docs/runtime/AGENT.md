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
The server is free and runs on the developer's machine. Closed-loop development as a service, the MCP server,
collector and dashboard run for a customer's developers and hosted by GenClass or inside their network, is an
Enterprise offer ([genclass.dev/enterprise](https://genclass.dev/enterprise)).

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
claude mcp add genclass -- npx -y @genclass/mcp@0.2.1   # or: npx -y @genclass/mcp@0.2.1 init  (writes .mcp.json and .claude/skills/genclass/SKILL.md)
```

Or as a Claude Code plugin from this repository's marketplace (`.claude-plugin/marketplace.json`; the plugin is
`packages/mcp/plugin`: the server, a `UserPromptSubmit` hook and the `genclass` skill):
`/plugin marketplace add genclass-dev/GenClass-lib`, then `/plugin install genclass@genclass`. The server's
`instructions` carry the triggers (the symptom words, the code changes that call for an explore, the scan before a UI
change is done) and the first call for each, so every client that passes them on gets the "when"; the skill carries
the procedure (section 4.2) and does not need the plugin: `init` writes it into the project, and
`npx skills add genclass-dev/GenClass-lib` installs the repository-root copy (`skills/genclass/SKILL.md`, kept
identical to the plugin's by the version sync) through a skill directory. Other clients
(Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf, Cline, Goose, Zed, JetBrains, OpenCode): the install blocks in
[packages/mcp/README.md](../../packages/mcp/README.md#install), or `npx -y @genclass/mcp@0.2.1 config <client>`.
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
    interval tick or a timer of 1 s or more that the response's handler scheduled (a ticker is not the response), and
    a write that only reordered the field's elements or entries (the same multiset of elements, the same keys and
    values: a cache's list of keys re-sorted by arrival puts nothing older in place of anything newer), and a path the
    hub's layout re-cut in the same write (an object past 32 keys or a store past 200 fields becomes one field, or the
    reverse: the path's "change" is GenClass's layout, not data; RESULTS.md section 20 counts the witnesses and
    stale-write findings before and after).
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
  timer of at most 1 s, so a debounced search is not snapshotted before its request): store fields (registered or
  discovered) as the runtime's redacted summary, at most 1,000 of them and 96,000 characters, taken in an order that
  does not depend on when they were written (registered stores, then discovered component state, then other discovered
  stores such as Redux; shallower paths first, so a cache's deep records go last; then by path), with the count left
  out when the budget ran out (`stateLeft`, `stateTotal`), the page's visible text by line, form values (password, hidden, file,
  card and one-time-code fields, secret-named or secret-labelled fields and anything in `[data-genclass-ignore]` left
  out; the app's `redact` function applies), the lines of ARIA live regions (`live`: status messages, alerts,
  toasts), and requests sent per signature. When the page goes away, a final
  snapshot is sent only if the page is quiet, differs from the last one sent, and fits a keepalive request (48,000
  characters); otherwise the last quiet snapshot stands.

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
| `genclass_scan` | `{url, phone?, hosted?}`: audits any page (no `connectAgent` needed) by running `@genclass/runtime`'s `scan <url> --json` (the project's own runtime when it has the command, else `npx -y @genclass/runtime@beta`) in the project's folder: headless Chromium through Playwright at desktop and phone sizes, the 23 measured visual checks in observe mode; a score and each problem with its element, selector and suggested CSS fix, plus the JSON report (`structuredContent`). `--local` unless `hosted: true` (the genclass.dev page check, public pages only), so the URL leaves the machine only when the agent asks |
| `genclass_clear` | forget runs and/or findings (runs findings still need are kept) |

The server's `instructions` (sent at initialize, under 4,096 characters; the one piece of guidance every MCP client
passes on, where tool descriptions may be deferred until a tool search) carry the "when" and the first call for each:
the symptom words in the first 500 characters ("sometimes", "randomly", "only in production", "on slow connections", a
value that "flips back", stale or old results, lost edits, double submits, sideways scrolling) and `genclass_findings`
then `genclass_explain`; after changing code that fetches, submits, autosaves, polls, debounces, paginates or listens
to a socket, `genclass_explore`; before fixing a finding, `genclass_replay`, and again after the fix; before calling a
UI change done (also after CSS or layout changes and on sites the agent does not own), `genclass_scan`. They name the
`genclass` skill so a client that has it loads it.

The skill (`packages/mcp/plugin/skills/genclass/SKILL.md`; the plugin installs it, `genclass-mcp init` writes it to
`.claude/skills/genclass/SKILL.md`, and `skills/genclass/SKILL.md` at the repository root is the identical copy skill
directories read) carries the "how", which always-loaded context cannot afford: the explore arguments
(`runs: 6, slow_ms: 600`), the Playwright pairing (`--repeat-each 8 --workers 1`), how to read a report
("Compared: 6 of 6" against "No verdict" and "0 compared"; "Internal state only" and "Along the way only" are not
races), what a witness, an explore race and a model detection each are, the reporting rule ("reproduced",
"not reproduced" or "no race in N orders", never "fixed" unless a replay or explore showed it), and what to do when
the `genclass_*` tools are missing (the one-line install, or `npx @genclass/runtime@beta scan <url> --json` for the
visual checks alone). Its frontmatter description repeats the triggers, since that is what a client matches a skill
on; its body does not. `packages/mcp/test/manifests.test.ts` checks the frontmatter, that every `genclass_*` name in
the body is a registered tool, the description's length (Claude Code's 1,024), that the root copy is identical, and
that the instructions stay under 4,096 characters, put the symptom words first and name the skill.

### 4.3 Agent API

`POST /v1/api` with `{ m, p }`: `status`, `findings`, `finding`, `explore.start|report|stop`, `replay.arm|result`,
`analytics`, `digest` (findings changed since a cursor, tied to the store's epoch so a restarted bridge counts from the
start), `clear`. Local processes of the same user only (section 6).

### 4.4 Command and push

- `genclass-mcp` runs the server on stdio. `genclass-mcp init [--hook] [--no-skill]` adds it to `.mcp.json`
  (merging), writes the `genclass` skill to `.claude/skills/genclass/SKILL.md` (the package's copy with a
  `genclass:init` marker line after the frontmatter; a rerun replaces a file that carries the marker and leaves one
  that does not, saying which; `--no-skill` leaves it out) and, with `--hook`, a `UserPromptSubmit` hook to
  `.claude/settings.json`. `genclass-mcp status` prints the bridge's status.
- **Push.** New findings are sent as Claude Code channel events (`notifications/claude/channel`, the experimental
  `claude/channel` capability; research preview, enabled with
  `claude --dangerously-load-development-channels server:genclass`), at most 3 every 3 s. Without channels, the
  prompt hook (`genclass-mcp hook`) adds findings changed since the last prompt as additional context. Both carry the
  finding id and kind first and page strings quoted; the agent calls `genclass_explain` for the rest.

### 4.5 Reporting to the dashboard (opt-in): the closed loop on the dashboard

Everything above stays on the developer's machine. The app's GenClass dashboard has a Closed-loop development view
(Fig. 3 there) that draws every issue's path, found, reproduced, fix proven, closed, or round again, with the period's
counts on each stage, lists the agent's log under it (Table 15) and, below that, the app's production problems with what
the agent does with each (Fig. 6); by default the dashboard cannot know what the agent did, and says so. With
`GENCLASS_REPORT` set, the MCP server mirrors its own log of the loop there.

- **Off by default.** `GENCLASS_REPORT=on` reports to the dashboard named by `GENCLASS_DASHBOARD` (the private link);
  `GENCLASS_REPORT=<link or secret>` names it directly. The sample dashboard is never a target. Unset, nothing is
  sent, and the dashboard's view says reporting is off.
- **What is sent** (`packages/mcp/src/report.ts`): `POST <origin>/api/projects/<secret>/agent`, JSON
  `{ schema: "genclass-agent/1", events: [...] }`, one event per step of the loop, each `{ t, at, ... }`:
  `found` when the bridge makes a finding (`id`, `kind`, one of the eight kinds, `route`, the page path without query
  or fragment, capped at 200 characters); `explain` when the agent reads its evidence (`genclass_explain`); `armed`
  when a replay of it is armed; `replay` with the last verdict `genclass_replay result` gave (`reproduced` true or
  false; an inconclusive one is not sent); `test` when `genclass_explain` produced the regression test; `explore` when
  an explore session is reported (`runs`, the page loads compared, `races`, the race findings it made, and the
  session's `route` when it had one); `cleared` when the developer clears findings, runs or everything (`what`). Never
  a title, an evidence line, a snapshot, a step, a value, an error message or any other page text. The dashboard's
  private link is the credential (it already reads the stats); the agent's own API token never leaves the machine.
- **How it is sent.** Batched (500 ms, at most 50 events a request), best effort: a refusal or a network error is
  logged once to stderr and never thrown, never retried in a loop, and never changes a finding, a verdict or a tool
  result. The session that owns the bridge reports; a session following another's bridge sends nothing (the owner
  already does).
- **What the dashboard keeps** (`telemetry-worker/src/dashboard.ts` `agentReport`, tables `agent_reports` and
  `agent_log`): every accepted event as one log row (at most 500 per app, the oldest go first), and per token and
  finding id the kind, the route (normalised like the runtime's: id-like segments become `:id`), when it was found,
  when its evidence was first read, the last replay time and verdict, whether it ever reproduced, how many replays
  reproduced it, when a test was written and when the fix was proven: a replay that no longer reproduces it after one
  that did. 90 days, like the rest. Rate limited per token (`SESSION_LIMIT`), 16 KB a request. Nothing in it feeds a
  decision: the runtime never reads the dashboard. Events the dashboard does not know are dropped, so an older
  dashboard keeps working with a newer server and the other way round.
- **How it is shown.** Fig. 3 counts, over the findings changed in the period: found (every finding reported),
  reproduced (a replay reproduced it), fix proven (a replay no longer reproduces it after one that did), closed (fix
  proven and a regression test written), open (found and not closed), and round again (replays that still reproduced a
  finding already reproduced once: a fix was tried and the bug was still there); the two back edges, round again and
  the loop back to production, are dashed. Table 15 lists the log newest first: the time, the step, the finding and
  its kind, the page and the outcome ("not reproduced: the fix holds", "8 page loads compared, 1 race found"). Fig. 6
  matches reports to its problem rows by kind (`stale-write` and `race` answer stale responses and write races,
  `duplicate-request` double submits, `error` the failure kinds) and by page, and puts one line on the row ("Agent: f3
  on /search reproduced, test written, fix proven 42 min ago"); Fix says how many tests the agent wrote in the period,
  Prove names the last fix proven. Disclosed in TELEMETRY.md and the package README.

## 5. Explore and replay

### 5.1 The explore verdict (`src/compare.ts`)

Runs of one explore session are grouped by page and **scenario** (their user actions, in order, typing bursts with their
final value). In each group, the two `fifo` runs are the baseline; with `slow_ms` they get the same extra latency as the
seeded runs, so timing alone never separates them. Anything that differs between the two baselines is **noise** and is
ignored: a store field whose value differs; the records under a store object whose keys differ (new ids on every run:
compared by their values, not their keys); a page line whose shape differs (tokens holding a digit blanked: times,
counters, ids). A value the runtime redacted (`[redacted]`) equals any value, alone or inside a summary: whether an
opaque id is redacted depends on the id itself (one with a digit looks like a credential, one without does not), so a
redaction is never a difference.

What a seeded run ends with beyond that is sorted by where it shows, from the evidence the run recorded:

| tier | what differs | reported as |
|---|---|---|
| visible | what the page shows (a page line outside a live region), a form value, the number of unsafe requests (POST, PUT, PATCH, DELETE) to a signature, or an error only this run had | **RACE**, a race finding with a replayable seed |
| internal | store values, the number of safe requests (GET, HEAD, OPTIONS: a cache refetching once more changes nothing the user sees or the server keeps), or lines of ARIA live regions (status messages, alerts, toasts: a slower run lets a toast expire), while the page showed the same as the baseline | "Internal state only", listed with the fields, no finding |
| transient | nothing at the end, but an `overwrote-newer` witness the baselines did not have (a later response repaired it) | "Along the way only", listed with the witness, no finding |

The internal tier exists because a data-fetching cache keeps bookkeeping whose final value depends on arrival order by
construction, with nothing visible attached: on the Strapi admin (Redux Toolkit Query) the request ids, the fulfilled
timestamps, the lists of cache keys a tag provides and the subscriptions differed between orders in every session
while the page did not (RESULTS.md section 20). The rule is generic and measured on the run itself, not a list of
library fields: a store value that matters to the user reaches the page, and when it does the run is in the visible
tier, with the store fields listed beside the page lines. Its limit: a difference that shows only in a control's
state (a button left disabled, a spinner without text) is not in the page text, so it lands in the internal tier
(section 8). No ignore list was added: the tiers and the rules below left no false report on the measured sessions, so
a per-library default would have been code without a measured purpose.

**Scenarios.** Runs are grouped by their actions with element names normalised: digits blanked in typed values and
names (a title made unique per run, "page 3"), parenthesised counts dropped (`combobox "author (1)"` is
`combobox "author"`: the count arrives with a response), and consecutive typing into one field taken as one burst (the
recording splits a burst when the field's label changes under it). A label can still change with the order (a sorted
column header renders its name in another element), so when that grouping leaves reordered runs without two baselines
to compare with, the session is grouped by action kinds and element roles (`click button`; a `div` or `span` is a
generic element), then by action kinds alone: the finest grouping that compares as many reordered runs as any does.
The report says which grouping it used, and how many reordered runs it compared ("Compared: 6 of 6"); a group whose
baselines had no reordered run beside them says "No verdict: 0 reordered runs were compared", never "No race found".

A group with only one baseline gets no verdict (its differences are listed unfiltered), and the page of the first armed
load is the page under test unless `route` says otherwise, so other pages and tabs do not take a slot. A snapshot that
left store fields out (section 2) says so in the report, and a field missing from such a snapshot is not compared. No
pattern is matched anywhere: the only question is whether what the page shows depends on the delivery order.

### 5.2 Replays (`store.ts` `replayResult`)

`genclass_replay arm` gives the next page load of the finding's page the order that produced it: an explore race
replays its run's seeded schedule (with its delay); anything recorded in a natural run replays that run's delivery
order as `given`. When the recorded run is gone, it refuses to arm rather than replay something else. `result` compares
the replay run with the finding: the same witness (field by shape, signature), the same error (by name and shape), the
failing run's page text, form values, request counts or error again = reproduced; the baseline's = not reproduced
(page lines count: a line the page always shows once and the failing run showed twice, a product card and a stale
result, is reproduced only when the replay shows it twice too; the finding's evidence keeps the counts, `textCounts`)
(store values decide only for a finding recorded with nothing else, and a redaction matches any value); a replay whose
element names changed with the order still counts as the same steps when its actions match by kind and role. It is
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
page lines, form values and request counts for a race and none of the failing run's (compared with the agent's own
snapshot; store values only when nothing visible differed, so a cache's bookkeeping cannot keep a fixed page failing). A finding it
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

Tests: 36 in `packages/runtime/test/agent.test.ts`, 104 in `packages/mcp/test/`; the runtime's whole suite passes, and
the first load stays within its limits.

False reports on real apps (RESULTS.md section 20, the Strapi admin with the hunt harness and two small apps on Redux
Toolkit Query and TanStack Query): before the rules of section 5.1, 16 of 21 interaction sessions on Strapi got a
race-like verdict (62 reordered runs, all false by a DOM oracle) and a correct Redux Toolkit Query page got "RACE" in
18 of 18 reordered runs; after, 0 of 21 and 0 of 18, with the real 403 race still found in 6 of 6 reordered runs at
300, 600 and 900 ms (0 false) and every planted stale race found (32 of 32 runs) with the same e2e result as above.

This is one page and one bug class, a proof of the mechanism, not a recall figure. The demos' and real apps' numbers
(with the false-report rate next to each) are the next measurement (section 8).

## 8. Limits and next steps

- Explore needs the same steps repeated, one page load each, and each run must reach a quiet point. A scenario whose
  requests come in a different order on each run gets different keys and is not compared reliably. Runs whose recorded
  actions differ even by kind (a click that a page only offers in some orders) are not compared; the report says
  "0 compared" for them.
- The verdict looks at what the page shows through its text and form values, the writes it sends and its errors. A
  difference that shows only in a control's state (a button left disabled, a spinner without text, a style), beyond
  the snapshot's 300 page lines, only inside a live region (an alert that an order made persist), or only in the
  number of GET requests is reported as internal state only, not as a race. Store fields beyond the snapshot's
  budget (1,000 fields) are not compared; the report says when that happened.
- An overwrite that a later response repaired (a flicker) is reported along the way, not as a race; the stale-write
  findings each witness makes stay as they were, so on an app whose cache writes its own bookkeeping (Redux Toolkit
  Query's statuses, subscriptions) `genclass_findings` still lists those (RESULTS.md section 20 counts them).
- WebSocket and EventSource messages are recorded, not reordered; failure responses are not held. Both are next.
- The script-tag build has no agent entry yet (ESM only).
- Production: today the agent reads production through the dashboard (counts by diagnosis and page) and reproduces
  locally with `focus` on the flagged signature, and with `GENCLASS_REPORT` the dashboard shows what it reproduced
  and fixed (section 4.5). Sending production witnesses (the recorded order of a real user's
  failing session, without page text) is the natural next step and widens what telemetry sends, so it needs the
  owner's OK first (AGENTS.md rule 8).
- Next measurement: explore on the six demos and the real-apps sweep, reporting races found next to false reports on
  their correct variants (the Strapi admin and two small apps are measured, RESULTS.md section 20).

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
- **Rule 8 (telemetry).** Nothing is sent off the machine; telemetry is unchanged. (`genclass_scan` sends a URL to the
  genclass.dev page check only when the agent passes `hosted: true`.)
