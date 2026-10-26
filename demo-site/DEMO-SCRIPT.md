# Record the GenClass demo yourself: the script

One take, two windows side by side on one screen: **Chrome on the left** (the shop on its Vercel link, genclass.dev),
**VS Code on the right** (the shop's folder, Claude Code in the integrated terminal). The story: the broken site on
Vercel → one prompt adds GenClass and deploys → the same site, fixed on the user's screen → the dashboard → the agent
closes the loop. About 12 minutes raw; sped up afterwards to 2–3 minutes (only speed changes, no cuts, no zoom). Every
prompt you type into Claude Code is in a box below: copy it. No localhost ever shows: the one act that needs a dev
page runs it in a Chrome app window, which has no address bar.

## 0. Before you record (15 minutes, not recorded)

1. **Quit the other Claude Code session** on this Mac (the desktop app's Code tab): its GenClass MCP server owns the
   bridge port, and the Claude in VS Code must own it so the dashboard mirror and the replays work.
2. **Reset the shop** to its broken state and deploy that, so the Vercel link shows the five bugs:

   ```bash
   cd ~/GenClass-lib-main/demo-site/tiny-shop-before && git checkout -- src package.json vite.config.js index.html && rm -rf .genclass .mcp.json .vscode src/genclass.js test dist node_modules/@genclass && npm install && vercel --prod --yes
   ```

   Open https://tiny-shop-before.vercel.app once: the white strip above the header, the search, the cookie notice.
   (Vercel answered 402 "fair use limits" for the Daybot team on 2026-10-26: deploys fail until that is cleared on
   vercel.com; the sites already deployed stay up.)
3. **The dev server**, for the last act only: `npm run dev` in the same folder, in a terminal you will not show. Leave
   it running.
4. **Chrome**: one window, signed in to Google, no other tabs. Bookmark bar hidden (⌘⇧B). Zoom 110% (⌘+) reads better on
   video. Put it on the left half of the screen.
5. **VS Code**: `code ~/GenClass-lib-main/demo-site/tiny-shop-before`. Close the Welcome tab. Open the integrated
   terminal (⌃`) and drag its top edge up so the panel takes about half the window. Close the chat side bar. Put the window
   on the right half of the screen. In the terminal:

   ```bash
   claude --model opus
   ```

   Claude Code starts. Leave it at its prompt.
6. **Vercel CLI** signed in (`vercel whoami` prints your name). The folder is linked to the `tiny-shop-before` project
   (`.vercel/` exists).
7. **Recording**: ⌘⇧5 → "Record Entire Screen" (or QuickTime → New Screen Recording). The cursor is recorded; move it
   deliberately. Nothing else on the desktop: hide other apps (⌘⌥H with Chrome in front, then the same with VS Code).
8. **Rehearse the fast typing once**: in the shop, type `react` fast (under a second for the five letters). The list ends
   on the eight results for "r". That is the first bug.

## 1. The broken site, live (40 s)

Chrome: https://tiny-shop-before.vercel.app. Five bugs, in this order (the last one kills the page, so it goes last):

1. Type `react` fast in "Search the shop". The list ends on the **eight results for "r"** while the box says react.
   Say: *"The slow response for the first letter lands last and wins."*
2. Double-click **Add to cart** on the Retro keyboard at a normal pace: the cart says **2**. Say: *"Two clicks, two
   orders."*
3. Point at the blank white strip above the header. Say: *"There is a free-shipping banner there. White on white."*
4. Click **OK** on the cookie notice, then scroll: **the page does not move**. Say: *"The notice locked scrolling and
   forgot to unlock it."*
5. Click **Load reviews**, wait for them, then click anything: **nothing responds**. Say: *"It blocked clicks while
   loading and never unblocked. Five bugs, one Friday. This is live, and users are on it."*

## 2. Sign in and get the prompt (40 s)

Chrome: https://genclass.dev/login

- Click **Continue with Google**, pick your account. You land on **/account**.
- Click **New project** (or go to https://genclass.dev/account/new). Project name: `tiny-shop`. Click **Create new
  project**. The project opens on its **Connect** dialog.
- Click **Copy the prompt for your coding agent**. Say: *"That's the whole setup. One prompt."*
- Still on the dialog, open the **MCP** tab, click **Create agent link**, click its **Copy** button later when you need
  it (step 3b).

## 3. Claude adds GenClass and deploys (3–4 minutes of Claude working; this stretch gets sped up)

VS Code terminal, Claude Code's prompt. Nothing to show in Chrome during this act: the terminal and the editor are the
picture.

- **3a.** Paste the copied prompt, Enter. Claude installs `@genclass/runtime@beta`, writes `src/genclass.js`, wraps the
  store, adds `connectAgent` for dev builds, runs `npx -y @genclass/mcp@0.2.0 init`, loads a page, calls
  `genclass_status` and reports. While it works, click **src → main.js** in the Explorer so the editor shows the file
  changing. Say: *"No docs, no integration guide. The dashboard told the agent what to do."*
- **3b.** Give the MCP server the dashboard link (so the agent's steps show on the dashboard). After Claude is done,
  type (replace the link with the agent link you copied in step 2):

  ```text
  Add to the genclass server in .mcp.json the env GENCLASS_DASHBOARD = <paste the agent link> and GENCLASS_REPORT = on, then tell me to restart you.
  ```

  Then `/exit`, and start again:

  ```bash
  claude --model opus --continue
  ```

  Approve the project's MCP server when Claude Code asks (once).
- **3c.** The second prompt, with `src/main.js` open in the editor so the edits appear live:

  ```text
  Three small changes for this demo. (1) Wherever GenClass.init is called, set mode: "guard", aggressiveness: "eager" and visual: { on: true, fix: true }. (2) Load the devtools overlay on every build, not only in development, so the audience sees what GenClass does: import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt)) (rt is what GenClass.init returned). (3) Keep the search state in one GenClass atom instead of separate store keys: const search = rt.atom("search", { query: "", results: [] }); the search handler writes it once per response with search.set((s) => ({ ...s, results: data.results, query: data.q })), and the results list renders from search.subscribe. Keep everything else as it is. Tell me the lines you changed.
  ```

  Watch the gutter in main.js turn blue/green where lines change. Say: *"Guard mode. GenClass may now act, with
  minimal reversible actions, when it is sure."*
- **3d.** Deploy:

  ```text
  Deploy this to Vercel production with the Vercel CLI, non-interactively (vercel --prod --yes), and tell me the production URL.
  ```

  Say, while it builds: *"Same code, same bugs, plus GenClass."*

## 4. The same site, fixed on the user's screen (60 s)

Chrome: https://tiny-shop-before.vercel.app, reloaded (⌘⇧R). Wait for the GenClass badge at the bottom right to say
**guard** and the model to be ready (about 5 s). Then the same five things, same order:

1. Type `react` fast. The list ends on the **two right results**.
2. Double-click Add to cart at a normal pace (two clicks about a tenth of a second apart; an instant machine
   double-click is below what the eager profile acts on): the cart says **1**.
3. The banner reads **"Free shipping on every order over 50 €"** in grey on white.
4. Click OK on the cookie notice, scroll: **the page scrolls** (a second after OK).
5. Click Load reviews, wait, click something: **it works** (a second after the reviews arrive).

Click the badge → **Interventions**: *"Prevented a stale response … stale 99% · discard · guard"* with **Undo**, and
*"Did not send POST /api/cart … reused the response of the identical request"*. Then **Checks**: the banner's
contrast, the scroll lock and the click block, each with *"Runtime fix: applied"* and its one line of CSS. Say:
*"Nothing in the shop's code changed. GenClass fixed all five on the user's screen, each one reversible, and it tells
you exactly what it changed."* Minimize the overlay.

Optional, 15 s: add `?genclass=observe` to the URL, type `react` fast: the wrong list again, and the overlay's
**Detections** tab says *"Stale write … would have run discard in guard mode"*. Say: *"Observe mode reports and never
touches the page; on a live site the URL switch can only lower the mode."*

## 5. The dashboard (45 s)

Chrome: https://genclass.dev/account/apps/… (the project you made). Wait about 10 s after act 4 for the telemetry
batch. Go slowly, scroll a little on each:

- **Overview** (the home icon): page loads, problems found, stopped by GenClass, model loaded.
- **Problems**: "Stale responses" and "Double submits", each with its fix and a **Copy prompt** for the agent.
- **What GenClass did**: the interventions, with how many were undone.
- **Pages**: which routes had problems.

Say: *"Everything production saw, in one place, with a prompt per problem you can hand to the agent."*

## 6. The agent closes the loop (3 minutes; Claude's thinking gets sped up, the answers stay real time)

This act needs the dev build: the agent link records and reorders a page's responses, so it only ever runs on the
developer's own machine, never on users. Open the dev page in a Chrome **app window**, which has no address bar, so no
localhost shows:

```bash
open -na "Google Chrome" --args --app="http://localhost:5173/?genclass=observe" --window-size=760,952 --window-position=0,30
```

Wait 8 s, type `react` fast. Say: *"The dev build, on my machine, where the agent can replay the network."*

VS Code terminal, one prompt at a time. Between prompts you drive the page as the prompt says. **While Claude edits
files, close the app window** (⌘W) and reopen it with the command above when the prompt asks for a load: a Vite reload
would use up an armed replay.

1. ```text
   The search on the dev page shows results for the wrong query sometimes. Use genclass_status to check the page is connected, then start an explore with genclass_explore (3 runs) on that page; I will load it five times and type the same search. Do not report yet.
   ```
   Then in Chrome: reload the app window (⌘R), wait 3 s, type `react` fast, wait 3 s; five times.
2. ```text
   Report the explore with genclass_explore and explain the top race finding with genclass_explain, briefly. Then arm a replay of that finding with genclass_replay; I will load the page and type the same search. Do not fix anything yet and do not check the result yet.
   ```
   Say, when the report comes: *"Two of the three reordered runs ended on the wrong list. That's the race, found by
   reordering the page's own responses."* Then: reload, wait 5 s, type `react` fast, wait 4 s. Close the app window.
3. ```text
   Check the replay result with genclass_replay. If it reproduced, fix the bug in src/main.js the simplest way (a sequence number per search request so an older response that arrives later is ignored), save the regression test genclass_explain generates under test/, then arm the replay again. I will load the page and type the same search; do not check the result yet.
   ```
   Say at **REPRODUCED**: *"Proven, not guessed."* Watch main.js change in the editor (the sequence number) and
   `test/search-race.spec.ts` appear. Then: reopen the app window, wait 5 s, type `react` fast, wait 4 s. Close it.
4. ```text
   Check the replay result with genclass_replay. Then start another explore with genclass_explore (3 runs) on the same page; I will load it five times again. Do not report yet.
   ```
   Say at **not reproduced**: *"Same delivery order, no bug."* Then five loads with `react`, as before.
5. ```text
   Report the explore with genclass_explore. Then the other four problems GenClass found on this page: the double add-to-cart, the banner's contrast, the click block after Load reviews and the scroll lock after the cookie notice. Use genclass_findings and genclass_explain on each, fix the cause in src/main.js or src/style.css (small, idiomatic fixes), and sum up in five lines what you found, proved and fixed.
   ```
   Watch main.js and style.css change in the editor. Say: *"No race in any order now. Found, reproduced, fixed,
   proven, with a regression test in the repo. And the other four, from GenClass's own measurements: a line each.
   Deploy, and the runtime fixes are no longer needed; GenClass keeps watching."*

## 7. The closed loop on the dashboard (20 s)

Chrome: the project's dashboard, **Loop** (the loop icon in the rail, or `#loop`).

- The figure: **Issue found → Reproduced → Fix proven → Closed**, with the counts from what you just did.
- Scroll to **What your agent did**: explore, evidence read, replay reproduced, test written, replay not reproduced,
  explore clean. Say: *"Everything the agent did, mirrored here. A person reads the test and ships."*

Stop the recording.

## After: the 2–3 minute cut

Only speed changes. Real time: the five bugs in act 1 and the five fixes in act 4, the overlay cards, the dashboard
pages, Claude's final answers in act 6 (REPRODUCED, not reproduced, the summary), the Loop page. 8–16x: Claude working
in acts 3 and 6 (integration, deploy, the fixes), the five page loads in act 6. 2–3x: every wait for a page or the model.

## If something does not fire

- The race needs the five letters within about a second: type fast, or paste `react` with ⌘V after typing `r`.
- The double add-to-cart is merged only when the second click comes while the first post is still running (it takes
  300 ms) and at a human pace: about 60–150 ms apart. The demo's config uses `aggressiveness: "eager"` for this; at
  the default profile the decision sits just under the margin.
- The banner's fix must survive scrolling: that needs the runtime line with the out-of-view rule (CHANGELOG
  "Unreleased"), released after 0.3.0-beta.2; on the older line the fix is undone when the banner leaves the viewport.
- The model loads at idle in the first seconds after a page load: wait for the badge before typing.
- Guard did not intervene on the search: the search state must be the atom from prompt 3c; check `src/main.js` has
  `rt.atom("search"`.
- `genclass_status` says no page: the dev page must be loaded after Claude's MCP server started; reload it. The agent
  link is dev-only and the page must be `localhost` (the app window hides the address, it does not change it).
- A replay says the armed load recorded nothing: a Vite reload used it up. Arm again, then load the page.
- The reference result of the integration is `demo-site/tiny-shop/src`, if Claude's version strays.
