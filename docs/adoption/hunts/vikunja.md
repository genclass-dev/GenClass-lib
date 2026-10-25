# Race hunt: Vikunja task detail autosave and kanban (v2.7.1)

A GenClass race hunt on Vikunja's task detail view and kanban board, run on 2026-10-24 in a cloud session, with the
real `@genclass/runtime` (0.3.0-beta.1, this repository at `d77ffd8`) injected into Vikunja's dev frontend by
Playwright and the real `@genclass/mcp` driven the way a coding agent drives it. Vikunja's source was not modified for
the hunt; the fix is a patch for its maintainers (`vikunja.patch`, draft issue and pull request text in
`vikunja-issue.md`). Nothing was sent to Vikunja's repository, forum, chat or maintainers, and nothing ran against
try.vikunja.io or any other public server: the API, the frontend and the browser all ran in this container.

**Headline.** Two real bugs in the task detail, both found by `genclass_explore` and both reproduced without
GenClass:

1. **Out-of-order save responses (the primary finding).** Two quick field edits (the due date, then the priority)
   send two overlapping `PATCH /api/v2/tasks/{id}`. The server applies them in order, but when the first response
   reaches the browser after the second, the page falls back to the older priority, and the next edit sends that
   older priority back, so the server loses it too. Explore: race in every two-edits and three-edits session (4 to 6
   of 6 reordered loads), replay reproduced; the oracle saw the old value on the page in 4 of 6 reordered loads per
   two-edits session, and the server lose an edit in a three-edits load. Without GenClass, delaying only the first
   PATCH response: 3 of 3 runs show Low while the server has High, and after one more edit the server stores Low (0 of 3 without the delay).
2. **Title saved while the description save is in flight (a lost update).** The title and the description each
   send the whole task as they last saw it, so the title's PATCH carries the older description and the server stores
   it over the new one. Oracle: the server lost the description in 17 of 18 reordered loads and in 4 of 6 baselines.
   Without GenClass: the server lost the description in 3 of 3 runs with the description's response delayed (0 of 3 without).

A 2-commit patch (26 added and 8 removed lines in 4 source files, 2 component tests and 2 e2e tests in Vikunja's style) fixes both; the tests fail
before and pass after; on the fixed build the oracle found no wrong value in 24 of 24 loads (18 reordered, at 600 ms), the GenClass-free reproduction 0 of 6 delayed runs wrong (3 of 3 per case before), and no `overwrote-newer` witness in any load (one in every two-edits load before); explore still said "race" on all three fixed sessions, every time on relative-time page text only (its false reports, sections 7 and 8). The kanban scenario showed a third, unconfirmed observation
(a second drop lost while the first drop's requests settle, section 6). GenClass itself produced false reports on
relative-time page text and recorded no user action for a drag (section 7).

Sections: 1 setup, 2 how Vikunja was driven, 3 scenarios and verdicts, 4 finding 1, 5 finding 2, 6 the kanban
observation, 7 problems with GenClass itself, 8 what was not run, 9 time spent.

## 1. Setup

| what | version |
|---|---|
| Vikunja | v2.7.1, released 2026-10-20 (`5619c4a9f66ddfc13f7bbba24ada07c3e82ae7a0`, the commit the hunt ran on); the patch also applies unchanged to `main` at `4699814` (2026-10-24), whose files under the patch match v2.7.1 except for an unrelated Shift+T shortcut in `TaskDetailView.vue` |
| backend | Go 1.27.0 (`GOTOOLCHAIN=go1.27.0`), Mage 1.17.2, SQLite (`mattn/go-sqlite3` 1.14.52), `vikunja web` on 127.0.0.1:3456 |
| frontend | Node 24.21.0, pnpm 11.27.0, Vite 8.3.0 dev server on 127.0.0.1:4173 (`DEV_PROXY=http://127.0.0.1:3456`), Vue 3.5.42, `@tanstack/vue-query` 5.102.8, Pinia 4.0.3, Vitest 4.1.11 |
| browser | Chromium 153.0.8010.12 (Playwright's chromium-1243, preinstalled), Playwright 1.63.0 |
| GenClass | `@genclass/runtime` 0.3.0-beta.1 and `@genclass/mcp` from this repository at `d77ffd8`; the harness ran on Node 22.22.0 |

Commands, in order:

```bash
# GenClass (this repository)
ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund
npm run build -w @genclass/runtime && npm run build -w @genclass/mcp
# (Chromium was preinstalled at the Playwright version the lockfile pins; no `playwright install` was needed)

# Vikunja, in its own directory
git clone --branch v2.7.1 https://github.com/go-vikunja/vikunja.git && cd vikunja
mage build                                   # the API binary, no frontend build
VIKUNJA_SERVICE_PUBLICURL=http://127.0.0.1:4173/ VIKUNJA_SERVICE_INTERFACE=127.0.0.1:3456 \
  VIKUNJA_DATABASE_TYPE=sqlite VIKUNJA_DATABASE_PATH=/home/user/vk-run/vikunja.db \
  VIKUNJA_SERVICE_ROOTPATH=/home/user/vk-run VIKUNJA_FILES_BASEPATH=/home/user/vk-run/files \
  VIKUNJA_SERVICE_JWTSECRET=hunt-local-secret VIKUNJA_MAILER_ENABLED=false VIKUNJA_REDIS_ENABLED=false \
  VIKUNJA_RATELIMIT_NOAUTHLIMIT=100000 ./vikunja web
cd frontend && printf 'DEV_PROXY=http://127.0.0.1:3456\n' > .env.local && pnpm install && pnpm dev

# the hunt (this repository)
node docs/adoption/hunts/vikunja/hunt.mjs setup                  # user "hunt", project, task, a 3-card board
node docs/adoption/hunts/vikunja/hunt.mjs explore <scenario> <slow_ms> 6
node docs/adoption/hunts/vikunja/summarise.mjs unfixed           # the table in section 3
node docs/adoption/hunts/vikunja/repro.mjs 3 800                 # the reproduction without GenClass
```

The rate limit for unauthenticated requests was raised because the harness logs in through the API before every
session; nothing else in Vikunja's configuration differs from the defaults the e2e task (`mage test:e2e`) uses.

## 2. How Vikunja was driven

`docs/adoption/hunts/vikunja/hunt.mjs` is the whole loop, modelled on `packages/mcp/test/e2e/race.e2e.mjs` and on the
Strapi hunt's harness:

- **MCP server in-process.** `serve()` from `packages/mcp/dist/index.js` with its bridge on a free port; the tools are
  called through JSON-RPC `tools/call`: `genclass_explore` (start, report), `genclass_status`, `genclass_findings`,
  `genclass_explain`, `genclass_replay` (arm, result).
- **Injection without touching Vikunja.** Playwright's `page.route` serves `packages/runtime/dist/` under the virtual
  same-origin path `/__genclass/` and rewrites the HTML document to add, at the top of `<head>`: a script setting
  `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, visual: false, devtools: false,
  report: "silent" }` and `window.__GENCLASS_AGENT_URL__`; the script-tag build
  `<script src="/__genclass/genclass.global.js" data-base="/__genclass/">`; and a module script that imports
  `/__genclass/agent.js` and calls `connectAgent(window.GenClass.runtime, { url })` (the script-tag build has no agent
  entry yet, so the agent link is the ESM file). No model is loaded (explore needs none), telemetry is off, requests
  to any host but the local frontend are aborted. The browser signs in the way Vikunja's own e2e support does
  (`tests/support/authenticateUser.ts`): the token and `API_URL` in localStorage. Without `API_URL` a deep link to
  `/tasks/{id}` is sent through `/login` to the home page.
- **State registration, said plainly.** Vikunja keeps its state in TanStack Vue Query and component refs, which
  GenClass does not discover (`genclass_status` listed no discovered store). The injected script therefore registers
  one atom, `visible`, that mirrors what the page shows (the detail's title, description, priority, progress and due
  date; the board's cards per column), written from a `MutationObserver`. The write runs in the same microtask
  checkpoint as the Vue render that caused it, so the runtime attributes it to that response or user action, which
  the recordings confirm (`write visible.priority by PATCH /api/v2/tasks/:id#1`). Explore's verdicts therefore rest
  on this atom, the page's form values and its visible text; the `overwrote-newer` witnesses are on `visible.*`.
- **Same start state for every load.** Before each page load the harness resets the task (title, description,
  priority Low, progress 10%, due date 2026-11-02) or the board (the three cards back in To-Do at positions 100,
  250, 300) through the API, outside the browser. The task id is the same in every load, so every run is the same
  page (`/tasks/1`) and the request keys match (`PATCH /api/v2/tasks/:id#1`, `#2`).
- **User actions as a user makes them.** Clicks through the mouse; the selects through the keyboard (focus, then the
  option's first letter), because Playwright's `selectOption` dispatches untrusted events, which the runtime does not
  record as user actions (section 7); the description through Vikunja's own e2e steps (Edit, `fill`, Save); kanban
  drags with `locator.dragTo`, as Vikunja's kanban e2e does.
- **Explore.** `genclass_explore start` with `runs: 6` and `slow_ms` 300, 600 and 900 (8 loads per session: 2 fifo
  baselines, 6 seeded orders), then `report`; on a race, `genclass_explain` for each finding, then `genclass_replay
  arm`, one more load, `genclass_replay result`.
- **The oracle (this harness's own check).** After each load settles: the server's task (`GET /api/v2/tasks/{id}`,
  or the board through `GET /api/v2/projects/{p}/views/{v}/buckets/tasks`) and the page's fields, each compared with
  the last edit the scenario made. It is reported next to the explore verdict, never in place of it.

## 3. Scenarios and verdicts

Every load of every session, from the session files (`summarise.mjs`). "Explore verdict" is the report's own
wording reduced to counts; "oracle" counts loads where the page or the server did not hold the last edit (in
brackets: how many of those had it wrong on the server). A session is 8 loads; "replay" is the one extra load after
`genclass_replay arm` on the first finding.

| scenario | slow_ms | explore verdict (as reported) | groups | oracle: seeded loads wrong (on the server) | oracle: baselines wrong (on the server) | replay | forced | harness errors |
|---|---|---|---|---|---|---|---|---|
| two-edits | 300 | race: 4 of 6 ended differently | 1 | 4 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| two-edits | 600 | race: 6 of 6 ended differently | 1 | 4 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| two-edits | 900 | race: 6 of 6 ended differently | 1 | 4 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| three-edits | 300 | race: 6 of 6 ended differently | 1 | 5 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| three-edits | 600 | race: 6 of 6 ended differently | 1 | 5 of 6 (server 1) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| three-edits | 900 | race: 6 of 6 ended differently | 1 | 5 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| title-description | 300 | race: 6 of 6 ended differently | 1 | 6 of 6 (server 6) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| title-description | 600 | race: 5 of 6 ended differently | 1 | 5 of 6 (server 5) | 2 of 2 (server 2) | reproduced | 0 | 0 |
| title-description | 900 | race: 4 of 6 ended differently | 1 | 6 of 6 (server 6) | 2 of 2 (server 2) | reproduced | 0 | 0 |
| kanban-drags | 300 | no verdict (one baseline in another group) | 2 | 0 of 6 (server 0) | 1 of 2 (server 1) | - | 0 | 0 |
| kanban-drags | 600 | no race | 1 | 0 of 6 (server 0) | 0 of 2 (server 0) | - | 0 | 0 |
| kanban-drags | 900 | race: 1 of 3 ended differently | 2 | 3 of 6 (server 3) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| priority-twice | 300, 600, 900 | race: 4, 3, 2 of 6 (false reports, see below) | 1 | 6 of 6: harness defect | 2 of 2: harness defect | reproduced (false) | 0 | 0 |

The scenarios:

- **two-edits**: the due date through the datepicker (Tomorrow, Confirm: `@closeOnChange` → `saveTask()`), then the
  priority to High (`@update:modelValue` → `setPriority` → `saveTask`) while the first PATCH is in flight.
- **three-edits**: the same, then Progress 50%.
- **title-description**: the description edited and saved (its Save button; the 5 s autosave sends the same
  request), then the title edited and confirmed with Enter while that PATCH is in flight.
- **kanban-drags**: Card A dragged to Doing, then Card B to Review right after the first drop.
- **priority-twice** (priority High, then Urgent) was meant as a fourth detail scenario, and its sessions are a
  harness defect, not a result: the second key press ("u" within a second of "h") extends the select's type-ahead to
  "hu", which matches no option, so only one save was sent and the oracle's expectation (Urgent) was wrong in every
  load. Explore's "races" on it are false reports on relative-time text (section 7). The step was changed to
  ArrowDown afterwards; the scenario was not run again.

How to read the counts. Explore compares each reordered load with the two baselines (responses in request order).
In two-edits the baselines are right, so its count is the race count, with a caveat: at 600 and 900 ms explore says
6 of 6 while the oracle says 4 of 6, because the two loads delivered in request order differed from the baselines
only in "Created 9 minutes ago" against "Created 10 minutes ago" (false reports, section 7). In title-description at
600 and 900 ms the baselines themselves lost the description on the server, so explore's "different" loads include
the one that ended right; explore says the end state depends on the order, the oracle says which order is wrong.

## 4. Finding 1: save responses applied in arrival order

### 4.1 What explore saw (two-edits, 600 ms, run r9, seed 1; the explain output of finding f2, abridged)

```
+4.021s action 0: click button "in 9 days"
+4.120s action 1: click button "Tomorrow Sun"
+4.129s write visible.dueDate by action 1: "in 9 days" → "in 12 hours"
+4.184s action 2: click button "CONFIRM"
+4.194s send PATCH /api/v2/tasks/:id#1 "body" (action 2)
+4.219s action 3: change select "Priority" = "High"
+4.220s write visible.priority by action 3: "1" → "3"
+4.223s send PATCH /api/v2/tasks/:id#2 "body" (action 3)
+4.827s delivered PATCH /api/v2/tasks/:id#2 (held 583 ms)
+4.888s delivered PATCH /api/v2/tasks/:id#1 (held 677 ms)
+4.930s write visible.priority by PATCH /api/v2/tasks/:id#1: "3" → "1"
RACE: state "visible.priority": baseline "3", this run "1"; field "Priority": baseline "3", this run "1"
```

The server had both edits (`GET` after the load: priority 3, due date tomorrow); the page showed Low. In the
baselines the same response also wrote priority 1 for a moment (`overwrote-newer visible.priority by PATCH #1`, in
every load) before the second response put 3 back. In three-edits (600 ms, seed 4: delivered #1, #3, #2) the third
edit was made after #1's response had already put Low back, so #3 sent priority 1 and the server stored it:
`server.priority=1`, the user's High lost.

### 4.2 Reproduction without GenClass

`docs/adoption/hunts/vikunja/repro.mjs`: plain Playwright, nothing injected, its own task. `page.route` lets the first
`PATCH /api/v2/tasks/{id}` reach the server at once (`route.fetch()`, so the server applies the saves in order) and
hands its response to the page 800 ms later; every other request is untouched. Steps: due date Tomorrow + Confirm,
priority High (keyboard), wait for both responses, read the page and `GET` the task; then Progress 50% and `GET`
again.

| case | runs | delivery order (server order) | page after both responses | server after both | server after one more edit |
|---|---|---|---|---|---|
| two edits, first response delayed 800 ms | 3 | #2, #1 (#1, #2) | priority Low (1) in 3 of 3 | High (3) in 3 of 3 | Low (1) in 3 of 3: the edit is lost |
| two edits, no delay (control) | 3 | #1, #2 (#1, #2) | High in 3 of 3 | High in 3 of 3 | High in 3 of 3 |
| description saved, title saved before its response (delayed 800 ms) | 3 | #2, #1 (#1, #2) | description "Edited description" | title new, description **"Original description"** in 3 of 3 | - |
| the same, no delay (control) | 3 | #1, #2 (#1, #2) | description "Edited description" | both new in 3 of 3 | - |

In the description case the page keeps showing the new description (the editor's own text) while the server has the
old one: the loss shows only after a reload or on another device. On the fixed build (`repro-fixed`, same script):
page High, server High, and High after the next edit in 3 of 3 delayed runs; the description kept in 3 of 3.

### 4.3 Root cause (paths and lines at v2.7.1, `5619c4a`; the same code on `main` at `4699814`)

- `frontend/src/views/tasks/TaskDetailView.vue` L1148, in `saveTask()` (L1124-1159):
  `seedTask(mergeTask(task.value, await updateTask.mutateAsync({...currentTask, id: currentTask.id!})))`. Every
  save's response replaces the draft when it arrives. `mergeTask` (`frontend/src/helpers/task.ts` L67-81) spreads the
  response over the draft, so an older response's priority wins over the newer edit.
- `frontend/src/client/queries/taskMutations.ts` L182-198, `updateTaskMutationOptions`: `onSuccess` calls
  `replaceTaskEverywhere(client, task)` (L193) for every response, in arrival order, so the detail, list and board
  caches end with the older task too. `onSettled` only marks the caches stale (`invalidateTaskMembership` with
  `refetchType: 'none'`, `taskCache.ts` L138-150), so nothing refetches them.
- Nothing repairs the draft afterwards: `followServerFields()` (`TaskDetailView.vue` L769-782) keeps priority,
  progress, dates, reminders and repeat local by design, and the priority and progress selects stay enabled while a
  save is in flight (only the datepickers are disabled, after 100 ms). The next `saveTask()` sends the whole draft
  (`taskPatchBody`, every writable field), including the older priority.
- The responses carry no version the client compares, and the backend has no `If-Match` on PATCH.

### 4.4 The fix (`vikunja.patch`, commit 1)

`updateTaskMutationOptions` remembers the newest update per task (`latestTaskUpdates`, keyed by task id, the input
object of the last `mutationFn` call); `isLatestTaskUpdate(input)` says whether a save is still the newest. A
response whose save has been overtaken writes nothing to the caches, and `saveTask()` seeds the draft only from the
newest save's response. The newest save carries every edit made before it (its body is the whole draft), so its
response is the state the server ended in. The success toast and the undo action stay for every save. 24 added and 6
removed lines in two files.

Not covered: if the network also delivers the two *requests* out of order, the server applies the older one last;
only serializing a task's saves would cover that, at the cost of one round trip per edit. If the newest save fails,
an older successful response is not written to the caches either (the detail keeps the user's edits; the caches stay
marked stale).

### 4.5 Tests

- `frontend/src/views/tasks/TaskDetailView.test.ts`, "keeps the newer edit when the response to an older save lands
  last": the existing shallow mount with a real QueryClient; progress, then priority; the second PATCH answers first;
  asserts the priority select, the cached detail, and that the next save sends priority 3.
- `frontend/src/client/queries/taskMutations.test.ts`, "keeps the newer save in the cache when the older response
  lands last": two updates through the real mutation lifecycle, answered in reverse.
- `frontend/tests/e2e/task/task.spec.ts`, "Keeps the newer edit when the response to an older save arrives last":
  `page.route` holds the first PATCH response until the second has been delivered, waits for both success toasts,
  checks the select, makes one more edit, and checks the stored priority through the API and after a reload.

Vikunja's testing guide puts request races in component tests and stored state in e2e tests, hence both.

Results (Vitest 4.1.11, Playwright 1.63.0 through `mage test:e2e`, Chromium 153):

| test | unfixed (v2.7.1 + tests only) | fixed (v2.7.1 + `vikunja.patch`) |
|---|---|---|
| `TaskDetailView.test.ts` new test | fails: `expected 1 to be 3` (the priority select) | passes |
| `taskMutations.test.ts` new test | fails: `expected 2 to be 3` (the cached detail) | passes |
| both files, all tests | 2 failed, 27 passed | 29 passed |
| e2e "older save arrives last" | fails: priority select `Expected: "3"`, `Received: "1"` | passes (4.4 s on the final commit) |
| e2e "description save is in flight" | fails: title `Expected: "New title"`, `Received:` the old title | passes (3.9 s on the final commit) |

The e2e runs used `VIKUNJA_E2E_SKIP_BUILD=true mage test:e2e "tests/e2e/task/task.spec.ts
--grep=older.save.arrives.last|description.save.is.in.flight --reporter=list"` (the binary from `mage build`; mage
splits its argument on spaces, so the grep has none). ESLint on the touched `src/` files: no findings.

## 5. Finding 2: the title's save writes back the older description

### 5.1 Evidence

title-description, 300 ms, seed 3 (delivered #2, #1): the description's PATCH (#1) was sent, then the title's (#2)
before #1's response was delivered; the server ended with title "Edited title" and description "Original
description"; the page showed the old title ("Race hunt task", from #1's late response) and the new description. In
request order (the 600 and 900 ms baselines) the page and the server agreed, both without the description edit. 17 of
18 reordered loads and 4 of 6 baselines lost the description on the server.

### 5.2 Root cause

`frontend/src/components/tasks/partials/Heading.vue` L162-166 saves `{...props.task, id, title}` and
`frontend/src/components/tasks/partials/Description.vue` L208-212 saves `{...props.modelValue, id, description}`. Both
props are the detail's draft, which learns the other component's edit only from that edit's response. A title saved
while the description's PATCH is in flight sends the older description, and the server, applying the saves in order,
stores it. The window is one round trip of the description save (its Save button, or the autosave 5 s after the last
keystroke); the harness types the title at once, a person needs a slow network for it.

### 5.3 The fix (`vikunja.patch`, commit 2) and test

Both components send only their own field (`{id, title}`, `{id, description}`); `taskPatchBody` already skips
undefined fields, and the PATCH endpoint takes partial patches. With commit 1, a late description response no longer
puts the older title back. e2e test: "Keeps the description when the title is saved while the description save is
in flight" (holds the description's response until the title's is in, checks the page and the stored task).

Not covered: a detail field (priority, dates) saved by `saveTask()` while a description save is in flight still sends
the whole draft, including the older description; closing that needs `saveTask()` to send only the fields it edits,
a larger change for the maintainers to decide on.

## 6. The kanban observation (not confirmed without GenClass)

In kanban-drags at 900 ms, 3 of 6 reordered loads (and 1 of 2 baselines at 300 ms) ended with Card B back in To-Do
and no request for it at all: the second drop was lost, on the page and on the server, silently. Each of those loads
also recorded one stray click (a lost drop ends as a click), which put it in a second explore group (section 7). The
code suggests a cause: `updateTaskPosition()` in `frontend/src/components/project/views/ProjectKanban.vue` (L567-605)
calls `board.endDrag()` in its `finally` (L602) when the first drag's requests settle, which drops the drag copy
(`useKanban.ts` L13-16) the second drag is still working on; the second drop then reads the board without Card B in
its target bucket and returns before saving. This was not reproduced without GenClass and not fixed; it is a lead,
not a finding.

## 7. Problems with GenClass itself

- **False reports on relative-time text.** Page lines are blanked as noise only when they differ between the two
  baselines. "Created 9 minutes ago by hunt" in both baselines and "Created 10 minutes ago by hunt" in a later load
  was reported as a different end state: 2 false loads in each of two-edits 600 and 900, and every "race" in the
  priority-twice sessions. `genclass_replay` then called such a finding "reproduced" (the replay load was a minute
  later too). A line whose shape (digits blanked) matches the baselines' should not count.
- **A Vue dev warning shown as page text** ("onDeactivated is called when there is no active component
  instance...", in an error toast of Vikunja's dev build) counted as a difference in one load.
- **Untrusted events are not user actions.** Playwright's `selectOption` dispatches untrusted `input`/`change` events;
  the runtime ignored them, so the edit had no user op and could not yield `overwrote-newer`. Keyboard input worked.
- **Drags are not recorded.** A kanban drag (pointer events through SortableJS) produced no user action, so the
  scenario was empty and a stray click from a lost drop split the loads into two groups ("no verdict" at 300 ms,
  "1 of 3" at 900 ms).
- **No discovery for TanStack Vue Query or Pinia**, as expected; the DOM-mirror atom stood in.
- **The script-tag build has no agent entry**; the agent link was loaded as the ESM file next to it.
- **Local Network Access.** Chromium refuses a page that Playwright fulfilled from reaching the loopback bridge;
  the harness disables `LocalNetworkAccessChecks` (as the Strapi hunt does). A developer's own localhost page is not
  affected.

## 8. Fixed-variant check

The dev frontend with `vikunja.patch` applied (Vite reloaded it), the same harness, server and fixture, 600 ms,
8 loads per session plus the replay load:

| scenario | slow_ms | explore verdict (as reported) | groups | oracle: seeded loads wrong (on the server) | oracle: baselines wrong (on the server) | replay | forced | harness errors |
|---|---|---|---|---|---|---|---|---|
| three-edits | 600 | race: 5 of 6 ended differently | 1 | 0 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| title-description | 600 | race: 4 of 6 ended differently | 1 | 0 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |
| two-edits | 600 | race: 5 of 6 ended differently | 1 | 0 of 6 (server 0) | 0 of 2 (server 0) | reproduced | 0 | 0 |

- **Oracle: 0 wrong in 27 loads** (24 explore loads and the 3 replay loads), on the page and on the server, including
  every load whose responses were delivered in reverse (two-edits seeds 1, 3, 5, 6; three-edits seeds 1 to 6;
  title-description seeds 1, 3, 5, 6). No `overwrote-newer` witness in any of them, no forced delivery.
- **Explore's verdict: "race" in all three sessions (5, 5 and 4 of 6), all false.** Every difference it listed is
  "Created 23 minutes ago by hunt" in the baselines against "Created 24 minutes ago by hunt" in a later load (and the
  same one minute on), the relative-time false report of section 7, and the replay of each such finding said
  "reproduced". Explore's false-report rate on the correct variant in this run: 14 of 18 reordered loads, all from
  that one line. Against it, its recall on the unfixed build: every two-edits, three-edits and title-description
  session reported the race (9 of 9), with the wrong value in 44 of 54 reordered loads by the oracle.
- **Without GenClass:** 0 of 6 delayed runs wrong (section 4.2).

## 9. What was not run

- Vikunja's full unit suite and `pnpm typecheck` (the guide compares the normalized error set against the base
  branch): only the two touched test files (29 tests) and ESLint on the touched `src/` files were run, to keep the
  session short; `mage lint` was not needed (the patch changes no Go code). Run both before sending. The 7 ESLint errors in `task.spec.ts` are on
  lines the patch does not touch (`pnpm lint` covers `src/` only).
- The other e2e specs; the new e2e tests were run alone through `mage test:e2e`.
- Browsers other than Chromium; the demo site (deliberately).

## 10. Time spent

About 2 hours of session time: 20 minutes of setup (toolchain, Vikunja build, harness), 35 minutes for the unfixed
explore matrix (15 sessions, 135 loads), the rest on the reproduction, the fix and its tests, the fixed-variant check
and this report.
