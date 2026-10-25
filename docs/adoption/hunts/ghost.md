# Race hunt: Ghost admin (TryGhost/Ghost)

A GenClass race hunt against Ghost's admin and editor, run on 2026-10-24 in a cloud session without approval
checkpoints. Everything here was done on a local copy of Ghost; nothing was sent to the Ghost project.

**Headline: no race found in Ghost's admin.** Six scenarios (the editor's autosave, creating a post, switching
posts, the posts list's filters, Publish and Update double-clicks, the tag and author pickers), each run as 8 page loads
per session at 300, 600 and 900 ms of extra latency, 20 sessions and 114 seeded reorderings in all: the server held
exactly what was typed last in every load, the editor showed it in every load, no edit was lost, no duplicate write was
sent, no list or picker showed another request's answer. GenClass's explore printed a RACE line for 13 of the 20
sessions, and every one of those lines was a request count that depends on timing, a relative time in the page text, a discovered
React store that exists in some runs and not others, or a witness on the harness's own mirror atom (section 6); the
three oracles agree there is no race, and section 7 quotes the Ghost code that makes the order not matter. No fix, no
regression test and no issue for Ghost come out of this (`ghost.patch`, `ghost-issue.md`); what does come out is a
reusable harness for a React Query app and four false-report classes in GenClass with their mechanism (section 9).

## 1. Versions and commits

| what | version |
|---|---|
| Ghost | `TryGhost/Ghost` at `268846abf3d3b65d33fc61d84200accc6d21382f` (2026-10-22, main), `ghost/package.json` 6.73.0-rc.0 |
| Ghost admin | `apps/admin` (React, Vite, `@tryghost/admin-x-framework`, TanStack Query; the Ember admin is gone), production build served by Ghost core from `ghost/core/built/admin` |
| GenClass | this repository at `d77ffd8` (main, 2026-10-22): `@genclass/runtime` 0.3.0-beta.1, `@genclass/mcp` 0.1.0, both built from source |
| Node, pnpm | Node 22.22.0 (Ghost asks for 22.23.4; see section 2), pnpm 12.10.1 |
| browser | Playwright 1.63.0, headless Chromium 153.0.8010.12 |
| database | better-sqlite3 (Ghost's `config.development.json` default) |

The hunt brief described Ghost's admin as an Ember app. It no longer is: the `apps/admin` on main is React with React
Query, hash-routed under `/ghost/#/...`, and the editor is Koenig (Lexical) with a save engine written in TypeScript
(`apps/admin/src/editor/engine/`). That changed what GenClass could see (section 8) and what the scenarios could test.

## 2. Running Ghost

Ghost's contributing guide (`docs/contributing/development-setup.md`) runs MySQL, Redis and Mailpit in Docker and Ghost
core plus the admin's Vite dev server on the host. This container has a Docker client but no daemon, so Ghost core was
run natively on sqlite, which its development config already defaults to, with the production admin build served by
core itself (no Vite dev server, no HMR socket in the way of the observer):

```bash
git clone --depth 1 https://github.com/TryGhost/Ghost.git            # 268846ab
cd Ghost && git submodule update --init --recursive --depth 1       # the two theme submodules
npm install --prefix ../tools pnpm@12.10.1                           # corepack could not fetch the pinned pnpm here
PATH=../tools/node_modules/.bin:$PATH pnpm install --frozen-lockfile # 35 s
NX_DAEMON=false pnpm nx run @tryghost/admin:build                    # admin + 20 dependent packages, about 3 min
cd ghost && node scripts/build-stale-assets.mts \
  && NODE_ENV=development url=http://localhost:2368/ server__host=127.0.0.1 server__port=2368 \
     node --conditions=source --import=tsx index.js                  # "Ghost booted in 9.69s"
# owner account, once:
curl -X POST http://localhost:2368/ghost/api/admin/authentication/setup/ -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:2368' -d '{"setup":[{"name":"Hunt Owner","email":"owner@example.com","password":"...","blogTitle":"GenClass Hunt"}]}'
```

Deviations from Ghost's guide, none of which touch the code under test: sqlite instead of MySQL (Ghost logs that the
jobs outbox needs MySQL and falls back to direct dispatch), no Redis or Mailpit, Node 22.22.0 where Ghost pins 22.23.4
(pnpm's `devEngines` download was not needed; nothing failed on the version), and `yarn setup`/`yarn dev` from the brief
are now `pnpm bootstrap`/`pnpm dev` (Ghost's `preinstall` refuses Yarn).

Ghost was up about 25 minutes after the session started.

## 3. Attaching GenClass without touching Ghost

`docs/adoption/hunts/ghost/hunt.mjs` (in this repository) drives everything. It starts `@genclass/mcp`'s `serve()`
in-process (the bridge on a free port) and talks to it over JSON-RPC `tools/call`, the way `packages/mcp/test/e2e/race.e2e.mjs`
does. In Playwright it then:

- routes the virtual same-origin path `/__genclass/*` to `packages/runtime/dist/` (the script-tag build
  `genclass.global.js`, `agent.js` and its chunks);
- sets `window.GENCLASS_CONFIG = { telemetry: false, mode: "observe", model: false, devtools: false, visual: false,
  analytics: false, report: "silent", autoState }` and `window.__GENCLASS_AGENT_URL__` from an init script (no model
  download, no telemetry, observe only);
- rewrites the admin's `index.html` response so its `<head>` starts with `<script src="/__genclass/genclass.global.js"
  data-base="/__genclass/">` (GenClass is on the page before react-dom and sees every request), an inline script that
  registers the mirror atom below, and `<script type="module">` that imports `/__genclass/agent.js` and calls
  `connectAgent(window.GenClass.runtime, { url })`;
- opens each run in a fresh context from a saved `storageState` (the owner's session cookie), `bypassCSP: true`.

**The mirror atom.** GenClass discovers no store on its own in this app that is worth comparing (section 8), so the
injected script registers `rt.atom("ghost", ...)` and keeps it current from events only (no polling, so the page can
still reach a quiet point): the editor's title textarea value, the Koenig body's text and the status line from the
DOM (`MutationObserver` and `input` events, coalesced per animation frame), and from Ghost's React Query cache
(`window.__TANSTACK_QUERY_CLIENT__`, which the admin exposes) the editor's post record (title, status, `updated_at`,
plaintext, lexical length, tags, authors) and the titles held by every posts, tags and users list query, keyed by
their URL. That is the state explore compares, next to the page text, form values and request counts it always compares.

**Oracles, per run and labelled in every result file** (`docs/adoption/hunts/ghost/results/*.json`):

1. *explore*: GenClass's verdict as `genclass_explore report` printed it, nothing removed;
2. *API*: `GET /ghost/api/admin/posts/<id>/?formats=plaintext` after the run settled, compared with what was typed last
   (the strongest oracle for autosave: what the server holds against what the writer typed);
3. *DOM*: the editor's title, body text and status line read by the harness itself after `whenSettled`.

Each explore session: `genclass_explore start` with `runs: 6`, `slow_ms` 300, 600 or 900 and `route: "/ghost/"`
(every admin page has that path; the router is hash-based), then 8 page loads of the same scenario (2 fifo baselines,
6 seeded orders), then `report`. The fixture posts are reset through the Admin API before every load so each run starts
from byte-identical content.

## 4. Scenarios

Each is one page load per run, the same user steps each time (typing with `pressSequentially` at 60 to 90 ms a key).

| id | scenario | what overlaps on the wire |
|---|---|---|
| a | **autosave**: in draft A, type in the title, click the body and type a burst, pause 3.1 s (just past the 3 s autosave debounce), type a second burst while that save is out, pause 3.1 s, type in the title and the body again, wait for "Draft - Saved" | per run 4 or 5 `PUT /posts/:id/` (autosaves and the title-blur field save), after each a `GET /posts/:id/` refetch from the mutation's invalidation and a `GET /email_previews/posts/:id/` (email size), plus `GET /slugs/post/...` for the draft's slug |
| b | **switch**: edit A's title, click "Posts" (the leave save), open B from the list at once, edit B's title and body | A's leave `PUT`, the list's `GET /posts/?filter=...` buckets, B's opening read, A's refetch, B's saves |
| c | **list**: open `#/posts`, switch the status filter four times within about half a second (`type=draft`, `published`, `draft`, none) | up to three bucket queries per filter (scheduled, draft, published and sent), all in flight together |
| d | **publish**: edit C's title, open the publish flow, continue, double-click the final "Publish", close the celebration the admin shows on the posts list, reopen C by URL (a click on the list row would be recorded with the row's relative time, see section 9), edit the title, double-click "Update" | the publish `PUT` (status change) and its refetch, the list's bucket queries and member-count request; the title-blur field save and the update `PUT`; the second click of each double-click |
| e | **pickers**: open the settings sidebar, type `ne`, pause, `ws` in the tag picker, pick "news", type `alp`, pick "alpha", open the authors picker | `GET /tags/?filter=tags.name:~'ne'`, `...'news'`, `...'alp'` (one per debounced term), the settings saves, `GET /users/` |
| f | **create**: open `#/editor/post/` (a new post), type a title, click the body and type while the create is out, two more bursts 3.1 s apart | `POST /posts/`, the URL swap to the new id, `GET /posts/:id/` refetches, `PUT` autosaves, slug `GET`s |

The brief's "posts list filter and search typed quickly" has no server-side search in this admin: the list's free-text
search is the global search (`Ctrl+K`), which loads the whole index once and filters in the browser; its filters are
chips whose values become NQL filters in the list queries. Scenario c changes those filters.

## 5. Results

Twenty explore sessions (one of them with React state discovery on), 8 loads each: 160 page loads, of them 114 with a seeded order. Each row is one session; the columns are the three oracles. "as typed" means the Admin API (or the DOM) held exactly the title and body the scenario typed last, in that many of the session's 8 loads. The table is generated by `docs/adoption/hunts/ghost/summarise.mjs` from the result files.

| scenario | slow_ms | discovery | explore verdict (as reported) | what differed | API read-back | DOM | forced holds | file |
|---|---|---|---|---|---|---|---|---|
| autosave | 300 | off | no race, 0 of 6 | nothing | 8/8 as typed | 8/8 as typed | 0 | `autosave-slow300-seed1.json` |
| autosave | 600 | on | RACE: 3 of 6 | state: state "controlShape_2.state0"; state "controlShape_2.state1"; state "controlShape_2.external6.context"; +4 more | 8/8 as typed | 8/8 as typed | 0 | `autosave-slow600-seed1-discovery.json` |
| autosave | 600 | off | RACE: 2 of 6 (+1 witness only) | request count, witness: requests sent to "GET /ghost/api/admin/email_previews/posts/:id/"; witness only here: overwrote-newer ghost.editor.status by GET /ghost/api/admin/posts/ | 8/8 as typed | 8/8 as typed | 0 | `autosave-slow600-seed1.json` |
| autosave | 900 | off | RACE: 3 of 6 | request count: requests sent to "GET /ghost/api/admin/email_previews/posts/:id/" | 8/8 as typed | 8/8 as typed | 1 | `autosave-slow900-seed1.json` |
| create | 300 | off | RACE: 0 of 6 ended differently (3 witness only) | witness: overwrote-newer ghost.cache.post <id>.lexical by PUT /ghost/api/admin/posts/:id/ | 8/8 as typed | 8/8 as typed | 0 | `create-slow300-seed1.json` |
| create | 600 | off | RACE: 2 of 6 (+2 witness only) | request count, witness: requests sent to "GET /ghost/api/admin/email_previews/posts/:id/"; witness only here: overwrote-newer ghost.cache.post 6add094c0bf36d052b0bb299.lexical by P; witness only here: overwrote-newer ghost.cache.post 6add094c0bf36d052b0bb299.updated_at b; +1 more | 8/8 as typed | 8/8 as typed | 0 | `create-slow600-seed1.json` |
| create | 900 | off | RACE: 2 of 6 (+1 witness only) | request count, witness: requests sent to "GET /ghost/api/admin/email_previews/posts/:id/"; witness only here: overwrote-newer ghost.cache.post 6add0a3c0bf36d052b0bb30e.lexical by P; witness only here: overwrote-newer ghost.cache.post 6add0a3c0bf36d052b0bb30e.updated_at b; +1 more | 8/8 as typed | 8/8 as typed | 0 | `create-slow900-seed1.json` |
| list | 300 | off | no race, 0 of 6 | nothing | n/a (no post) | 8/8 same rows (times stripped) | 0 | `list-slow300-seed1.json` |
| list | 600 | off | RACE: 6 of 6 | page text: page text only in this run: "By Hunt Owner - a minute ago | n/a (no post) | 8/8 same rows (times stripped) | 0 | `list-slow600-seed1.json` |
| list | 900 | off | RACE: 5 of 6 | page text: page text only in this run: "By Hunt Owner - 2 minutes ago | n/a (no post) | 8/8 same rows (times stripped) | 2 | `list-slow900-seed1.json` |
| pickers | 300 | off | no race, 0 of 6 | nothing | 8/8 as typed | n/a | 0 | `pickers-slow300-seed1.json` |
| pickers | 600 | off | RACE: 2 of 6 | request count: requests sent to "GET /ghost/api/admin/tags/" | 8/8 as typed | n/a | 0 | `pickers-slow600-seed1.json` |
| pickers | 900 | off | RACE: 3 of 6 | request count: requests sent to "GET /ghost/api/admin/tags/" | 8/8 as typed | n/a | 1 | `pickers-slow900-seed1.json` |
| publish | 300 | off | RACE: 3 of 6 (+1 witness only) | request count, witness: requests sent to "GET /ghost/api/admin/posts/:id/"; requests sent to "PUT /ghost/api/admin/posts/:id/"; requests sent to "POST /ghost/api/admin/stats/posts-member-counts/"; +1 more | 8/8 as typed | 8/8 as typed | 1 | `publish-slow300-seed1.json` |
| publish | 600 | off | RACE: 3 of 6 | request count: requests sent to "GET /ghost/api/admin/posts/:id/"; requests sent to "PUT /ghost/api/admin/posts/:id/"; requests sent to "POST /ghost/api/admin/stats/posts-member-counts/" | 8/8 as typed | 8/8 as typed | 2 | `publish-slow600-seed1.json` |
| publish | 900 | off | RACE: 4 of 6 | request count: requests sent to "POST /ghost/api/admin/stats/posts-member-counts/"; requests sent to "GET /ghost/api/admin/email_previews/posts/:id/" | 8/8 as typed | 8/8 as typed | 5 | `publish-slow900-seed1.json` |
| switch | 300 | off | no race, 0 of 6 | nothing | 8/8 as typed | 8/8 as typed | 0 | `switch-slow300-seed1.json` |
| switch | 600 | off | no race, 0 of 6 | nothing | 8/8 as typed | 8/8 as typed | 1 | `switch-slow600-seed1.json` |
| switch | 900 | off | no race, 0 of 6 | nothing | 8/8 as typed | 8/8 as typed | 4 | `switch-slow900-seed1.json` |

"forced holds" counts responses the schedule released only because their hold ran out (the report marks those runs "hold(s) ran out"); every response was still delivered unchanged.

**Every RACE line above is one of four things, none of them a difference in Ghost's data**: a discovered React store present in one run and not another (the one discovery-on session), a request count that depends on timing (the email-size estimate, the tag search, the list's member-count request, one extra save in a run whose hold ran out), the list rows' relative times moving with the wall clock, or a witness on the mirror atom. Section 6 goes through each. The Admin API read-back matched what was typed in every one of the 128 loads that typed into a post, the editor's DOM matched in every one, and the list showed the same rows in every load of the list sessions.

## 6. The findings explore reported, and what they were

Every RACE line explore printed is in the table above and in the result files. In causal order, what each was:

**A. Discovered React stores present in some runs and absent in others** (autosave, 600 ms, discovery on: 3 of 6).
The report's differences were all of one shape, for example run r3 (seed 1):

```
state "controlShape_2.state0":   baseline "\"6add01070bf36d052b0bafe4\"", this run "(absent)"
state "controlShape_2.state1":   baseline "{id: \"6add0107…\", uuid: \"935c7679-…\", +43}", this run "(absent)"
state "controlShape_2.external6.context": baseline "undefined", this run "(absent)"
```

`controlShape_2.state0` is a post id and `state1` the post record: the store belongs to the editor's loader component
(`useState(id)`, `useState<EditorRecord>()`), registered under a name the minifier left on it. In the seeded runs no
store was registered for that instance (a different instance of a same-named type took the slot, or the 48-store cap
was reached first), so the fields are absent rather than different. The mirror atom (`ghost.editor.*`,
`ghost.cache.post <id>.*`), the page text and the request counts were identical in all 6 runs, the Admin API held
the typed title and body in 8 of 8 loads, and the DOM showed them in 8 of 8. No race; a discovery artefact
(section 9, item 2). The session was repeated with discovery off.

**B. One fewer email-size estimate request** (autosave, 600 ms: 2 of 6; 900 ms: 3 of 6; discovery off). The only
difference in those runs:

```
requests sent to "GET /ghost/api/admin/email_previews/posts/:id/": baseline "6", this run "5"
```

Ghost estimates the email size of a draft after each save, keyed on a 500 ms debounce of the post's `updated_at`
(`apps/admin/src/editor/use-email-size.ts`). When two acknowledgements land within 500 ms of each other, which a
reordered schedule makes likelier, the first `updated_at` never becomes the debounced value and one estimate is
skipped; the trailing one for the final version is always made. The editor's state, the cache, the page text and the
server were the baseline's in every run. By explore's definition the final state did depend on order (a request
count is part of the compared state); by a maintainer's definition nothing is wrong (section 9, item 3).

The same class made up every other RACE line of the hunt: in the pickers sessions (600 ms: 2 of 6; 900 ms: 3 of 6)
`requests sent to "GET /ghost/api/admin/tags/": baseline "4", this run "3"` or `"5"`, the tag picker's one query per
debounced term plus the tag-list refetch each settings save triggers, with "news, alpha" saved in 8 of 8 loads; in the
publish session (900 ms: 4 of 6) `requests sent to "POST /ghost/api/admin/stats/posts-member-counts/": baseline "1",
this run "(absent)"`, the posts list's member-count request, which the list page fired in the baselines before the
scenario left it for the editor and in three seeded runs had not fired yet (its trigger waits for the list query the
schedule was holding), and the email-size count once more; the post was `published` with the right title in 8 of 8
loads.

The same session also listed, apart from the RACE verdict, "1 more ended right but had an older response overwrite
newer data along the way": `overwrote-newer ghost.editor.status by GET /ghost/api/admin/posts/`. That is the mirror
atom's status-line field being rewritten when a response's handlers changed the status line, attributed to that
response; the two `stale-write` findings in the same session (f1, f2) are the same fact from other responses. A
fact about the mirror, not about Ghost (section 9, item 4).

**C. Relative times in the list rows** (list, 600 ms: 6 of 6; 900 ms: 5 of 6). Every difference was a page text
line of the form:

```
page text only in the baseline: "By Hunt Owner - a few seconds ago", "By Hunt Owner - 7 minutes ago"
page text only in this run:     "By Hunt Owner - a minute ago",      "By Hunt Owner - 8 minutes ago"
```

The two baselines ran within the same minute and agreed; the seeded loads ran in the next minutes and the rows'
relative times had moved. The row titles with the times stripped were the same in 8 of 8 loads, and the mirror atom's
copy of every list query's titles never differed. A wall-clock artefact of comparing page text verbatim (section 9).
The 300 ms session, whose 8 loads fitted in one minute, reported no race.

**D. Witnesses on the mirror atom's cache fields in the create sessions** (300 ms: 3 of 6 "ended right but had an
older response overwrite newer data"; 600 ms: 2; 900 ms: 1; the 300 ms session's RACE line is only this). The
findings read:

```
f1 [stale-write] The response to "PUT /ghost/api/admin/posts/:id/" overwrote "ghost.cache.post 6add094c….lexical"
   after a newer "POST /ghost/api/admin/posts/" had already written it
```

The field is the mirror atom's copy of the post record in Ghost's query cache: the create's acknowledgement writes
it first, the next save's acknowledgement rewrites it. The same witness was recorded in baseline (in-order) runs of
the 300 and 900 ms sessions, so it is not produced by reordering; the report lists only runs whose witnesses the
baselines lacked, which is why some seeded runs carry it and others not. Every create run ended with the title and
both body bursts on the server and in the editor (8 of 8, three sessions). As with the status line (B), a mirror
written from the cache's subscription is attributed to whichever response's handlers updated the cache; nothing here
says Ghost showed older content.

**E. One extra save and refetch** (publish, 300 and 600 ms, in the runs marked "hold(s) ran out"):
`requests sent to "PUT /ghost/api/admin/posts/:id/": baseline "3", this run "4"` with one more `GET /posts/:id/`. In
those runs a response was held to the limit, so the title-blur field save and the Update's explicit save ran one after
the other instead of coalescing into one request. Two saves of the same content; the post was `published` with the
right title in 8 of 8 loads, and no `identical-in-flight` witness was recorded (the two payloads differ).

Nothing else was reported: no state field of the mirror atom (other than the cache witnesses in D), no form value,
no error and no `identical-in-flight` witness differed in any session.

`genclass_explain` was called for each race finding and its output is in the result files (`explains`). It gave the
recorded steps and delivery order and offered a replay and a generated test for each; none was replayed as a race
because the DOM and API oracles had already shown the state was the baseline's, and the difference each test would
have asserted on (a request count, a relative time, a discovered store) is not an assertion about Ghost.

## 7. Why Ghost's editor did not race

The scenarios put the requests a race needs on the wire together, and explore delivered them in 6 different orders
per scenario and latency; the server and the editor ended the same every time. The code that makes the order not
matter, at commit `268846ab`:

- **One save at a time, later work coalesced** (`apps/admin/src/editor/engine/save-engine.ts`). `enqueue` runs a
  command only when nothing is in flight, otherwise it coalesces it into the single pending slot (lines 616 to 623);
  `coalesce` keeps the higher-priority intent and lets a later status command supersede an earlier one (598 to 614);
  `drain` starts the pending slot only after the in-flight one has settled (625 to 636). Inside `run`, every `await`
  re-reads the post and re-runs the drop rules (`dropInFlight`, 795 to 833), so the payload is the post as it is
  now, never a stale copy captured at dispatch. Two autosaves therefore cannot be on the wire together, and the second
  always carries the newer content and the `updated_at` the first was acknowledged with (`reconcile`, 883;
  `editor-session.ts` 882 and 891).
- **The slug request has one slot on the wire** (`apps/admin/src/editor/engine/slug-machine.ts`). "At most one request
  is on the wire. A submission behind it waits in the single deferred slot; the submission it replaces resolves stale
  without reaching the server" (lines 282 to 289); an answer is applied only while its ticket is the current request's
  (`reduceSlug`, 412 to 416), and a document boundary resolves everything from the previous post stale (385 to 396).
- **A refetch that is not the version the session holds is refused** (`apps/admin/src/editor/session/editor-session.ts`,
  `recordRefetched`, lines 1122 to 1152): a record whose `updated_at` is not the held token is not adopted; if it is
  later it only raises the "newer version" notice. The acknowledgement path checks the other direction
  (`use-editor-session.ts`, `isLaterVersion` 195 to 206 and `onSaveAcknowledged` 273 to 287): a save's answer never
  replaces a later version a read already put in the cache. The editor's own query mounts with `refetchOnMount: false`
  (`use-editor-session.ts` 426 to 437, `editor-screen.tsx` 666 to 677) and the loader reads the post itself, cancelling
  a read still in flight from an earlier visit rather than joining it (`editor-screen.tsx` 681 to 711).
- **List and picker queries are keyed by their URL** (`apps/admin-x-framework/src/utils/api/hooks.ts` line 71 and
  161 to 164: `queryKey: [dataType, url]`). A response can only ever fill the cache entry of the request that asked for
  it, so a late answer for `type=draft` cannot show under `type=published`. The posts list keeps the previous page
  visible while the next filter loads (`use-posts-list.ts` 48 to 59, `placeholderData: keepPreviousData`) and renders
  only once every bucket's first page is in (`compose-post-buckets.ts`). The tag picker fetches one keyed query per
  debounced term (`shared/tags/tag-picker.tsx` 70 to 86) and treats the search as settled only when the answer for what
  is typed has arrived (`searchSettled`, 86).
- **Publish and Update cannot double-fire** (`apps/admin/src/editor/publish/use-publish-flow.ts`): `publishRunningRef`
  refuses a second confirm while one runs (lines 372, 533, 554) and the confirm button is disabled while `status ===
  'running'` (`publish/components/confirm-step.tsx` 140); the header's Update item is `disabled: !session.isDirty() ||
  isSaving` (`editor-header-actions.tsx` 599) and runs `saveExplicit`, which the engine coalesces anyway.

Ghost's own tests cover the same ground: `apps/admin/src/editor/engine/save-engine.queue.test.ts`,
`editor-refetch.acceptance.test.tsx`, `editor-conflict.acceptance.test.tsx`, and in `e2e/tests/admin/posts/`
`editor-react.test.ts` (autosaves observed through the network and the server read back) and
`editor-conflict-recovery.test.ts`. There was nothing left for a fix or a regression test to add.

### 7.1 One observation that is not a race

While building the create scenario, a title-only edit made after a body edit stayed unsaved as long as the title field
kept focus: the status line read "Draft", the server kept the old title for the 16 s the probe waited
(`docs/adoption/hunts/ghost/probe-title-autosave.mjs`, steps 4, 5, 8 and 9, natural timing, no GenClass on the page),
and the edit was saved by the next body change. This is Ghost's documented design, not a defect: the engine's README
lists `autosave` as "body change" and `field` as "a canvas commit: the title, the excerpt under it, the feature image",
`onTitleChange` only patches the session and `onTitleBlur` dispatches the `field` save
(`apps/admin/src/editor/session/use-editor-session.ts` 536 to 549; the only `dispatchAutosave` call is in
`onLexicalChange`, 551 to 556), leaving the editor saves it (`leaveRequested`), and the Ember editor behaved the same
(`ghost/admin/app/controllers/lexical-editor.js` at v6.0.0: `updateScratch` performs the autosave task,
`updateTitleScratch` does not). A title-only edit made within a second of opening a post does get saved about 3 s
later, while the same edit after 6 s of idling is not (`probe-title-first.mjs`: step A saved, step B unsaved until
the body edit of step C): Koenig's mount-time change arms the body debounce once, and that one autosave carries
whatever is dirty when it fires. That is why the smoke run's title-only edit landed. Worth knowing when writing a
scenario or a test against this editor; not something to raise with the maintainers from this hunt.

## 8. What GenClass could and could not see on this React app

The brief expected an Ember app with no discoverable state. The React admin is different, in both directions.

**What it could see.**

- Every request and response at the delivery gate, so the schedules held and reordered exactly what the scenarios
  put on the wire: in the autosave scenario the `PUT`s, the refetch `GET`s, the slug and email-size `GET`s; in the list
  scenario three bucket queries per filter change. Across the 160 loads, 17 responses were released because their
  hold ran out (the "forced holds" column), most at 900 ms, which the report flags per run; every response was still
  delivered unchanged.
- The user's actions as a scenario key: the explore report groups runs by the recorded actions, and with the typing
  bursts recorded by their final value the 8 loads of every session landed in one group, which is what makes a verdict
  possible on a hash-routed app where every page is `/ghost/`.
- App state, through the mirror atom: Ghost exposes its React Query client on `window.__TANSTACK_QUERY_CLIENT__`,
  so the editor's post record and every list query's contents could be registered with `rt.atom` from the page's edge
  without touching Ghost. On a React Query app this is the natural store to mirror: it is the data the screens render
  from, keyed by request URL, and it is exactly what a reordering could corrupt. That the mirror never differed from
  the baseline is the strongest "no race" signal GenClass gave.
- React component state, through automatic discovery, but not usefully (below).
- Page text, form values and request counts per signature, which `compare.ts` compares in every run whatever the app
  registers. On an app with no state at all explore can still conclude from these: a stale list would show in the page
  text, a lost edit in the title field's value, a duplicate submit in the request count.

**What it could not, or should not, have used.**

- *Discovered React stores in a production build.* The names are the minifier's (`Kfe`, `IU`, `NU`, `tp`) or inferred
  from an unrelated identifier (`controlShape`, `admin7`, `reactAdminMounted`), the same name covers several
  components, the slots and the 48-store cap are filled in an order that depends on response timing, and only
  components that change state after mount get a store at all. In the discovery-on session this produced the only
  "race" in the autosave scenario, with no data behind it (section 6). Discovery was turned off for the hunt
  (`autoState: false`); on a development build with real component names it would be a different tool.
- *The DOM as state.* The list rows carry relative times ("a few seconds ago", "7 minutes ago") that move with the
  wall clock between a session's first and last load. Lines that already differ between the two baselines are blanked
  by shape and ignored; lines that happen to agree between the baselines (loaded within the same minute) and change
  by the time the seeded loads run are reported verbatim (`compare.ts`, `textOnlyBaseline`/`textOnlyRun` are exact
  lines, and `lineShape` is consulted only for baseline-vs-baseline differences). That is the list scenario's 6 of 6
  at 600 ms (section 6). A clock the page cannot see is not a race; comparing page lines by shape would remove this
  class.
- *The model.* It was off throughout (`model: false`), as the brief asked: nothing was downloaded, and no situation
  was rendered. The hunt used only the explore mechanism and the witnesses; the model's own detections are not part
  of this result.
- *The schedule's reach.* Protected requests are never held, and the agent connects after the first HTML and scripts
  load, so a page load's first responses were held only until the hello. Nothing the scenarios tested depends on the
  initial boot requests.

## 9. Runtime problems hit

Things in GenClass itself that this hunt ran into, in the order they cost time. None changed the verdict; all are worth
an owner's look.

1. **Chromium refuses the agent link's loopback fetch.** On Playwright 1.63's Chromium 153 a page on
   `http://localhost:2368` fetching `http://127.0.0.1:<port>/v1/hello` fails with "Permission was denied for this
   request to access the `loopback` address space" (Local Network Access checks, which now want a permission prompt
   headless Chromium cannot answer). `connectAgent` never connects, silently from the page's point of view. The harness
   launches Chromium with `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks`.
   `packages/mcp/test/e2e/race.e2e.mjs` uses the same `localhost` page plus `127.0.0.1` bridge pairing and will hit this
   on the same Chromium; `docs/runtime/AGENT.md` section 1 should say so, and the generated test (section 5.3) too.
2. **React state discovery produces order-dependent stores in a production build, and explore reports them as a
   race.** With `autoState` on (the script-tag default), the first autosave session reported 3 of 6 seeded runs
   different, every difference of the form `state "controlShape_2.state0": baseline "6add…", this run "(absent)"`
   (section 6). `controlShape` is not a component: it is a value Ghost's `useShade()` returns, and the minifier left it
   as the inferred name of several different components. GenClass names a store after the component's function name
   and gives same-named types the slots `Name`, `Name_2`, `Name_3` in the order their instances first change state
   (`packages/runtime/src/discover/react.ts`, lines 503 to 532, with `MAX_INSTANCES` 3 and `MAX_COMPONENT_STORES` 48),
   so which component owns `controlShape_2`, or whether the slot is filled before the cap, depends on response timing.
   The mirror atom, the page text, the request counts and the Admin API agreed with the baseline in all 6 runs. With
   discovery off the artefact is gone. `compare.ts` could treat a store that exists in one run and not another as
   noise when its name was minified (`tr.minified` is known at discovery time), or the discovery could refuse to
   register minified names at all.
3. **A request count that depends on timing is a race by explore's definition.** With discovery off, 2 of 6 (600 ms)
   and 3 of 6 (900 ms) autosave runs were reported for one thing: `requests sent to "GET
   /ghost/api/admin/email_previews/posts/:id/": baseline "6", this run "5"`. The email size estimate re-runs per
   debounced `updated_at` (`apps/admin/src/editor/use-email-size.ts`, `useDebounce(post.updatedAt ?? null, EMAIL_SIZE_REFETCH_DEBOUNCE_MS)`
   with `EMAIL_SIZE_REFETCH_DEBOUNCE_MS = 500`), so
   when two acknowledgements land inside the debounce window one estimate is skipped; the last version always gets
   its estimate. True to the definition ("the final state depends on the delivery order"), and not something a
   maintainer would fix. A request-count-only difference deserves its own label in the report ("fewer or more
   requests, same state") rather than the RACE headline, and the two baselines here agreed only by luck: the first
   session (discovery on) had listed the same count as baseline noise.
4. **The mirror atom's witnesses.** Writing an atom from a `MutationObserver` attributes the write to whichever
   response's handlers mutated the DOM, so the status line ("Saving…" to "Draft - Saved") produced `overwrote-newer
   ghost.editor.status by GET /ghost/api/admin/posts/` witnesses and two `stale-write` findings (f1, f2 in the
   discovery-off session). They are facts about the mirror, not about Ghost; the report lists them separately
   ("ended right but had an older response overwrite newer data along the way"), which is the right place. An app's
   own `rt.atom` writes from a response handler would be attributed the same way, correctly.
5. **Quiet points and a 3 s debounce.** `whenSettled` counts app timers of at most 1 s as "not quiet"
   (`SHORT_TIMER_MS`), so Ghost's 3 s autosave debounce looks quiet and the first snapshot of a run is taken before
   the save fires. Harmless here because the harness waits for "Draft - Saved" and the bridge keeps the last quiet
   snapshot, but a scenario that ends with typing and a settle alone would compare pre-save states.
6. **Hash routing.** Every admin page is `/ghost/`, so `route` cannot separate scenarios and the "page under test" is
   one page; grouping by recorded actions did that work. A `route` that read `location.hash` for hash routers would
   help the report and the generated test.
7. **Recorded action names carry volatile text and split the scenario.** Runs are grouped by their recorded
   actions, and a click on a list row is recorded with the row's accessible name, which in Ghost includes a relative
   time: `click link "Hunt post C live By Hunt Owner - 12 min…"`. The first publish session at 600 ms therefore had
   eight groups of one run each and no verdict at all (its report read `## /ghost/ · 1 run(s) ·` eight times, with
   `- 12 min…`, `- 13 min…` and so on in the recorded click), and the first at 300 ms a group of 3 and a group of 5.
   The scenario was changed to re-enter the editor by URL and both sessions were rerun; the result files hold the
   reruns.
   `scenarioOf` in `compare.ts` could blank digit tokens in targets the way `lineShape` does for page lines, or group
   by the target's role and the first few words.
8. **Minor.** The explore `start` text suggests `npx playwright test <spec> --repeat-each 8 --workers 1`; the
   corresponding `hunt.mjs` loop is a plain `for` over 8 loads and works the same. The admin's writing-focus feature
   hides the header while the writer types, so clicks on "Publish" and "Update" need a mouse move first; that is
   Ghost's design, not a GenClass problem, but a generated test would need the same move.

## 10. Time spent

Wall clock of the session, from the first command (18:38 UTC) to the final commit, about 1 h 35 min:

| phase | time |
|---|---|
| building GenClass, cloning Ghost, reading `AGENT.md`, the e2e loop, `compare.ts`, the injection entries | 15 min (in parallel with the clone and install) |
| getting Ghost to run: pnpm 12 by hand, install, admin build, core on sqlite, owner account | 20 min (the admin build is 3 of them) |
| reading Ghost's editor: the save engine, the slug machine, the session, the framework's query hooks, the pickers, the publish flow | 25 min, overlapping the above |
| the harness: injection, mirror atom, MCP loop, the Local Network Access block, the six scenarios and their fixes (writing focus, the celebration dialog, volatile row names) | 45 min |
| explore sessions: 20 sessions of 8 loads, run back to back (19:03 to 19:49), including the reruns after scenario fixes | 46 min |
| reading the reports, checking every flagged run against the API and DOM oracles, the title-save probes | 25 min, overlapping the sessions |
| the write-up | 25 min |

## 11. Reproducing

```bash
# this repository, both packages built; Ghost running as in section 2; the owner account created
node docs/adoption/hunts/ghost/hunt.mjs smoke                       # injection, connection, mirror atom, read-back
node docs/adoption/hunts/ghost/hunt.mjs autosave --slow 600         # one explore session: 2 baselines + 6 seeded
node docs/adoption/hunts/ghost/hunt.mjs autosave --slow 600 --autostate on   # with React state discovery
node docs/adoption/hunts/ghost/hunt.mjs publish --once              # one natural load, for checking a scenario
```

Results land in `docs/adoption/hunts/ghost/results/<scenario>-slow<ms>-seed<n>[-discovery].json` with the explore
report, the findings, every `genclass_explain`, and per load the DOM and API oracles.
