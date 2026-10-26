# Record the GenClass demo yourself: the script

The site is a copy of the Snow Day Predictor (snowday-predictor.ca) as it was before GenClass, with five bugs planted,
deployed as its own Cloudflare Pages project: **https://snowday-demo.pages.dev** (the real site is never touched). The
copy lives in `demo-site/snowday-before` (the page, `functions/api/` for the board search, alerts and road conditions).

One take, two windows side by side on one screen: **Chrome on the left** (the site, genclass.dev), **VS Code on the
right** (the site's folder, Claude Code in the integrated terminal). The story: the broken site, live → one prompt
adds GenClass and deploys → the same site, fixed on the user's screen → the dashboard → the agent closes the loop.
About 12 minutes raw; sped up afterwards to 2–3 minutes (only speed changes, no cuts, no zoom). Every prompt you type
into Claude Code is in a box below: copy it. No localhost ever shows: the one act that needs a dev page runs it in a
Chrome app window, which has no address bar.

## What GenClass does about the five bugs (tested, see the last section)

| Bug on the site | On the user's screen, guard mode | In the code, the agent loop |
|---|---|---|
| Board search shows boards for an older query (type fast) | fixed: the stale write is dropped, with Undo | fixed |
| Double click on Subscribe subscribes twice | flagged as a duplicate, both sent | fixed |
| Alert bar at the top: white text on white | fixed: a readable colour, one CSS rule | fixed |
| After the notice's OK the page cannot scroll | fixed: the leaked `overflow: hidden` removed | fixed |
| After "Load road conditions" nothing can be clicked | fixed: the leaked `pointer-events: none` removed | fixed |

## 0. Before you record (15 minutes, not recorded)

1. **Quit the other Claude Code session** on this Mac (the desktop app's Code tab): its GenClass MCP server owns the
   bridge port, and the Claude in VS Code must own it so the dashboard mirror and the replays work.
2. **Reset the site** to its broken state and deploy that, so the link shows the five bugs:

   ```bash
   cd ~/GenClass-lib-main/demo-site/snowday-before && git checkout -- . && git clean -fdqx . && XDG_CONFIG_HOME=~/.config-dizon npx --yes wrangler@4 pages deploy . --project-name snowday-demo --branch main --commit-dirty=true
   ```

   (`XDG_CONFIG_HOME=~/.config-dizon` is the wrangler login for the dizon Cloudflare account; Mehar's login stays as it
   is.) Open https://snowday-demo.pages.dev once.
3. **The dev server**, for act 6 only: `XDG_CONFIG_HOME=~/.config-dizon npx --yes wrangler@4 pages dev . --port 8788`
   in the same folder, in a terminal you will not show. Leave it running.
4. **Chrome**: one window, signed in to Google, no other tabs. Bookmark bar hidden (⌘⇧B). Put it on the left half.
5. **VS Code**: `code ~/GenClass-lib-main/demo-site/snowday-before`, open `index.html`. Open the integrated terminal (⌃`)
   and drag it up to about half the window. Close the chat side bar. Put the window on the right half. In the terminal:

   ```bash
   claude --model opus
   ```

6. **Rehearse the fast typing once**: in "Find your school board", type `halton` fast (under a second). The list ends
   on five boards (the answer for "h") while the box says halton. That is the first bug.

## 1. The broken site, live (40 s)

Chrome: https://snowday-demo.pages.dev. Five bugs, in this order (the last one kills the page, so it goes last):

1. Point at the white strip under the menu. Say: *"There is a snow day alert banner there. White on white."*
2. Type a postal code, `L6H 3X5`, Predict: the real prediction works.
3. In "Find your school board", type `halton` fast: the list shows **five boards** while the box says halton. Say:
   *"The slow answer for the first letter lands last and wins."*
4. Double-click **Subscribe** at a normal pace: **Subscriptions: 2**. Say: *"Two clicks, two subscriptions."*
5. Click **OK** on the notice at the bottom left, then scroll with the wheel: **the page does not move**. Say: *"The
   notice locked scrolling and forgot to unlock it."*
6. Click **Load road conditions**, wait for them, then click anything: **nothing responds**. Say: *"It blocked clicks
   while loading and never unblocked. Five bugs. This is live."*

## 2. Sign in and get the prompt (40 s)

Chrome: https://genclass.dev/login → **Continue with Google** → **New project**, name `snowday`, **Create new project**.
The project opens on its **Connect** dialog. Click **Copy the prompt for your coding agent**. Say: *"That's the whole
setup. One prompt."* Then the **MCP** tab → **Create agent link** (you copy it in 3b).

## 3. Claude adds GenClass and deploys (3–4 minutes of Claude working; this stretch gets sped up)

VS Code terminal. Nothing to show in Chrome during this act.

- **3a.** Paste the copied prompt and add one line at the end before Enter:

  ```text
  This is a static site with no build step (index.html and Cloudflare Pages functions): use the script tag from the dashboard, and load the agent link from the same CDN version only when the page is on localhost.
  ```

  Claude adds the script tag with the key, connects the store, adds the agent link for local pages and the MCP
  server, and reports. Keep `index.html` open so the edit shows. Say: *"No docs read. The dashboard told the agent what
  to do."*
- **3b.** The agent link for the dashboard mirror (paste yours):

  ```text
  Add to the genclass server in .mcp.json the env GENCLASS_DASHBOARD = <paste the agent link> and GENCLASS_REPORT = on, then tell me to restart you.
  ```

  Then `/exit` and `claude --model opus --continue`; approve the project's MCP server once.
- **3c.** The demo settings:

  ```text
  Three small changes for this demo. (1) On the GenClass script tag, or in window.GENCLASS_CONFIG, set mode "guard", aggressiveness "eager" and visual { on: true, fix: true }. (2) Show the devtools overlay on every host, not only locally, so the audience sees what GenClass does. (3) Keep the board search state in one GenClass atom instead of the two store keys: const boards = GenClass.runtime.atom("boards", { query: "", results: [] }); the input handler writes it once per response with boards.set((s) => ({ ...s, results: data.results, query: data.q })), and the list renders from boards.subscribe. Keep everything else as it is. Tell me the lines you changed.
  ```

  Say: *"Guard mode. GenClass may now act, with minimal reversible actions, when it is sure."*
- **3d.** Deploy:

  ```text
  Deploy this to Cloudflare Pages: XDG_CONFIG_HOME=~/.config-dizon npx --yes wrangler@4 pages deploy . --project-name snowday-demo --branch main --commit-dirty=true, and tell me the URL.
  ```

## 4. The same site, fixed on the user's screen (60 s)

Chrome: https://snowday-demo.pages.dev, reloaded (⌘⇧R). Wait for the GenClass badge at the bottom right to say
**guard** and the model to be ready (about 5 s). The same things, same order:

1. The alert banner reads **"Snow day alerts for your board, every evening at 6 pm…"** in grey on white.
2. Type `halton` fast: **the two Halton boards**.
3. Double-click Subscribe: **Subscriptions: 2** still. Leave it: GenClass flagged it (badge → Detections, "Duplicate
   request"), and the agent fixes it in act 6. Say: *"Not everything is safe to fix on the fly. This one it reports."*
4. Click OK on the notice, scroll: **the page scrolls** (a second after OK).
5. Load road conditions, wait, click something: **it works** (a second after they arrive).

Badge → **Interventions**: *"Prevented a stale response … discard · guard"* with **Undo**. **Checks**: the banner's
contrast, the scroll lock and the click block, each with *"Runtime fix: applied"* and its CSS. Say: *"Nothing in the
site's code changed. GenClass fixed four of five on the user's screen, reversibly, and reported the fifth."*

## 5. The dashboard (45 s)

Chrome: the project on genclass.dev (wait about 10 s after act 4). Slowly, scroll a little on each: **Overview**
(page loads, problems, stopped by GenClass, model loaded), **Problems** (stale responses, double submits, each with a
**Copy prompt**), **What GenClass did**, **Pages**. Say: *"Everything production saw, with a prompt per problem."*

## 6. The agent closes the loop (3 minutes; Claude's thinking gets sped up)

The dev build on this Mac, in a Chrome app window (no address bar):

```bash
open -na "Google Chrome" --args --app="http://localhost:8788/?genclass=observe" --window-size=760,952 --window-position=0,30
```

Type `halton` fast once. Say: *"The dev build, where the agent can replay the network."* Then, one prompt at a time
(close the app window with ⌘W while Claude edits; reopen it with the command above when a prompt asks for a load):

1. ```text
   The board search on the dev page shows boards for the wrong query sometimes. Use genclass_status to check the page is connected, then start an explore with genclass_explore (3 runs) on that page; I will load it five times and type the same search. Do not report yet.
   ```
   Five loads: reload (⌘R), wait 3 s, type `halton` fast, wait 3 s.
2. ```text
   Report the explore with genclass_explore and explain the top race finding with genclass_explain, briefly. Then arm a replay of that finding with genclass_replay; I will load the page and type the same search. Do not fix anything yet and do not check the result yet.
   ```
   One load with `halton`. Close the window.
3. ```text
   Check the replay result with genclass_replay. If it reproduced, fix the bug in index.html the simplest way (a sequence number per search request so an older response that arrives later is ignored), save the regression test genclass_explain generates under test/, then arm the replay again. I will load the page and type the same search; do not check the result yet.
   ```
   Say at **REPRODUCED**: *"Proven, not guessed."* One load with `halton`. Close the window.
4. ```text
   Check the replay result with genclass_replay. Then the other four problems GenClass found on this page: the double Subscribe, the alert bar's contrast, the click block after Load road conditions and the scroll lock after the notice. Use genclass_findings and genclass_explain on each, fix the cause in index.html (small, idiomatic fixes), and sum up in five lines what you found, proved and fixed.
   ```
   Say at **not reproduced**: *"Same order, no bug."* Then: *"And the other four, from GenClass's own measurements, a
   line each. Deploy, and GenClass keeps watching."*

## 7. The closed loop on the dashboard (20 s)

The project's **Loop**: **Issue found → Reproduced → Fix proven → Closed**, then **What your agent did**. Say:
*"Everything the agent did, mirrored here. A person reads the test and ships."* Stop the recording.

## After: the 2–3 minute cut

Only speed changes. Real time: acts 1 and 4, the overlay cards, the dashboard, Claude's answers in act 6 (REPRODUCED,
not reproduced, the summary), the Loop page. 8–16x: Claude working in acts 3 and 6, the page loads in act 6. 2–3x:
waits.

## Tested before recording

```bash
npm run build -w @genclass/runtime
node demo-site/record/verify-snowday.mjs --keep      # observe: 5/5 bugs show; guard: 4/5 fixed, the double Subscribe flagged
node demo-site/record/agent-fix-snowday.mjs          # Claude (Opus) fixes all five in index.html from GenClass's findings
node demo-site/record/dashboard-e2e.mjs              # a real genclass.dev project: events, problems, the Loop log mirrored
```

The runtime fixes for the banner need the runtime line in the CHANGELOG's "Unreleased" section (a colour fix kept
while a click block hides the text from hit testing, and while it is out of view); on the published
`0.3.0-beta.2` the banner's fix can drop when road conditions block clicks. Release before recording.

## If something does not fire

- The race needs the six letters within about a second: type fast.
- Wait for the badge's model before typing (the first seconds after a load).
- The board search must be the atom from 3c, or guard cannot drop the stale write.
- `genclass_status` says no page: load the dev page after Claude's MCP server started.
- A replay says the armed load recorded nothing: a reload used it up. Arm again, then load once.
- The shop (`demo-site/tiny-shop-before`, `DEMO.md`) is the fallback demo: five bugs, all five fixed in guard.
