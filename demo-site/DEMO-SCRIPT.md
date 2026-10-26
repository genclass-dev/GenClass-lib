# Record the GenClass demo yourself: the script

The demo runs on the real site, **https://snowday-predictor.ca**: the Snow Day Predictor as it was before GenClass,
with five bugs planted, is deployed to its Worker (`snowday-predictor`, Dizon's Cloudflare account) right before the
recording; GenClass fixes them there; afterwards the site goes back to today's version, which already runs GenClass.
The code is `demo-site/snowday-before`: the real site's pages, `worker.js` and `wrangler.jsonc` (the live Worker's name,
compatibility date and `ASSETS` binding), and `functions/api/` for the school board finder and the community poll.

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
| Double click on a poll button votes twice | flagged as a duplicate, both sent | fixed |
| Alert bar at the top: white text on white | fixed: a readable colour, one CSS rule | fixed |
| After the notice's OK the page cannot scroll | fixed: the leaked `overflow: hidden` removed | fixed |
| After a mistyped postal code nothing can be clicked | fixed: the leaked `pointer-events: none` removed | fixed |

Proven before recording (2026-10-26, on the Pages copy and on the Worker locally): all five bugs show; guard fixes four on the user's screen and
flags the double vote; Claude (Opus) fixes all five in about 40 s from GenClass's findings; the dashboard shows
the page loads, the stale response, the dropped write and the duplicate, and the Loop log gets the agent's steps.

## 0. Before you record (15 minutes, not recorded)

1. **Quit the other Claude Code session** on this Mac (the desktop app's Code tab): its GenClass MCP server owns the
   bridge port, and the Claude in VS Code must own it so the dashboard mirror and the replays work.
2. **Reset the code** to its broken state and **deploy it to snowday-predictor.ca**, right before you start recording
   (real visitors see the five bugs from now until act 3's deploy):

   ```bash
   cd ~/GenClass-lib-main/demo-site/snowday-before && git checkout -- . && git clean -fdqx . && XDG_CONFIG_HOME=~/.config-dizon CLOUDFLARE_ACCOUNT_ID=4daefdf7440d182204be114a9c9f5074 npx --yes wrangler@4 deploy
   ```

   (`XDG_CONFIG_HOME=~/.config-dizon` is a separate wrangler login, so Mehar's default login stays as it is; it reaches
   both the Dizon and Daybot accounts, so `CLOUDFLARE_ACCOUNT_ID` picks Dizon.) Open https://snowday-predictor.ca once
   (⌘⇧R, so the cached page goes).
3. **The dev server**, for act 6 only: `npx --yes wrangler@4 dev --port 8788` in the same folder, in a terminal you
   will not show. Leave it running.
4. **Chrome**: one window, signed in to Google, **signed out of genclass.dev** (if you are signed in: your account
   menu at the top right of genclass.dev → Sign out), so act 2 shows the sign-in. Exactly two tabs: **tab 1**
   https://genclass.dev (the home page), **tab 2** https://snowday-predictor.ca. Leave tab 1 in front. Bookmark bar
   hidden (⌘⇧B). Put the window on the left half. From here on the recording never types an address: every page is a
   click from these two tabs.
5. **VS Code**: `code ~/GenClass-lib-main/demo-site/snowday-before`, open `index.html`. Open the integrated terminal (⌃`)
   and drag it up to about half the window. Close the chat side bar. Put the window on the right half. In the terminal:

   ```bash
   claude --model opus
   ```

6. **Rehearse the fast typing once**: in "Find your school board", type `halton` fast (under a second). The list ends
   on five boards (the answer for "h") while the box says halton. That is the first bug.

## 0b. The page check first (30 s)

Chrome, tab 1, the genclass.dev home page. Scroll down one screen to **Check any page.**, click the box that says
`your-site.com`, type `snowday-predictor.ca` and click **Scan**. A cached result comes back in a few seconds (a fresh
scan takes about 40 s; results are cached for 6 hours, so run it once before recording). Show:

- **50/100 without GenClass, 56 with GenClass on.** Scroll the categories: Visual bugs 75, Accessibility 56, Phone
  75, Speed 84, Security 46, Search and sharing 82, **Races 75**.
- **Text that is almost invisible on its background**: the white banner, measured at 1.00:1, with the CSS fix, and
  "With GenClass on: fixed".
- **Search results for an older query stayed on the page**: the page check typed `a`, `ab`, `abc` into the board
  finder, the answers came back out of order, and the page showed seven boards where the last query alone shows none.
- The rest, each with its element and a one-line fix: low-contrast buttons, a small tap target, missing security
  headers, "read more" links.

Say: *"Before touching any code: a free page check on genclass.dev. It already finds the invisible banner and the
search race, each with the fix. What a scan can't do is click through the page the way people do: the stuck scroll,
the frozen page, the double vote. That's what GenClass in the page is for."*

## 1. The broken site, live (60 s)

Chrome: click **tab 2** (snowday-predictor.ca) and reload it (⌘R). Open DevTools docked at the bottom (⌥⌘I), **Network**
tab, type `boards` in its filter box.
Five bugs, in this order (the last one freezes the page, so it goes last):

1. Point at the white strip under the menu. Say: *"There is a storm-watch banner there. White on white."*
2. Type `L6H 3X5`, Predict: the real prediction works.
3. In "Find your school board", type `halton` fast: the list shows **five boards** while the box says halton. Point at
   the Network tab: the request for `q=h` is the longest bar and finishes **after** `q=halton`. Say: *"The slow answer
   for the first letter lands last and wins. A race condition: every autocomplete has one."*
4. In "Will schools close tomorrow?", double-click **Snow day** at a normal pace: the count goes **124 → 126**. Say:
   *"One person, two votes."*
5. Click **OK** on the notice at the bottom left, then scroll with the wheel: **the page does not move**. Point out
   that there is not one ad on screen: the site runs Google ads, and the first one sits in the cards just below the
   bottom of the window. Say: *"The notice locked scrolling and forgot to unlock it. And this site lives on ads: every
   one of them is below this line, and nobody can scroll to them. This bug costs money."*
6. Mistype the postal code, `L6H`, and Predict: the error shows, then click anything: **nothing responds**. Say:
   *"Predict blocks clicks while it works and only unblocks when it succeeds. One typo and the page is dead. Five
   bugs, live."*

## 2. Sign in and get the prompt (40 s)

Chrome, tab 1 (still on the page check's result). Every step is a click:

1. The **GenClass** logo at the top left: back to the home page.
2. **Sign in**, at the top right → **Continue with Google** → pick your Google account. (A first sign-in with Google
   creates the account.) You land on **Projects**.
3. **New project**, at the top right of the project list (on an account with no projects yet, the **New project**
   button under *Create your first project*).
4. **Project name**: type `snowday` → **Create new project**.
5. The project opens with the **Connect to your project** dialog, on its **Framework** tab. Click the big green
   **Copy the prompt for your coding agent**. Say: *"That's the whole setup. One prompt."*
6. Close the dialog with the **×** at its top right. The project's overview stays open in tab 1, waiting for its
   first event.

## 3. Claude adds GenClass and deploys (3–4 minutes of Claude working; this stretch gets sped up)

VS Code on the right, Claude Code running in its terminal (from section 0). Chrome only for 3b's agent link.

- **Before 3a**: click once in Claude Code's input box, then press **Shift+Tab** until the line under it says
  **accept edits on**. Claude then edits files without stopping; it still asks before running a command (choose
  **Yes**).
- **3a.** Paste (⌘V): Claude Code shows the prompt folded as *[Pasted text …]*. Type a space and this line after it,
  then Enter:

  ```text
  This is a static site with no build step (index.html served by a Cloudflare Worker, worker.js): use the script tag from the dashboard, and load the agent link from the same CDN version only when the page is on localhost.
  ```

  Claude adds the script tag with the key, connects the store, adds the agent link for local pages and the MCP
  server, and reports. Keep `index.html` open in VS Code: the edit shows as Claude makes it. Say: *"No docs read. The
  dashboard told the agent what to do."*
- **3b.** The agent link, so the dashboard shows what the agent does in act 6:
  1. Chrome, tab 1 (the project). Left sidebar: **MCP**.
  2. Scroll down to **Agent access** → **Create agent link**. The link shows once: click **Copy** next to it. Say:
     *"One link, and my agent can read production."*
  3. VS Code, Claude's input box: type the line below, and paste (⌘V) the link where it says `<paste the agent
     link>`, then Enter:

     ```text
     Add to the genclass server in .mcp.json the env GENCLASS_DASHBOARD = <paste the agent link> and GENCLASS_REPORT = on, then tell me to restart you.
     ```

  4. When Claude says to restart: type `/exit`, Enter, then `claude --model opus --continue`, Enter. Claude Code
     asks about the new MCP server in `.mcp.json` (genclass): choose **Use this MCP server**. Shift+Tab to **accept
     edits on** again.
- **3c.** The demo settings. Type or paste into Claude, then Enter:

  ```text
  Three small changes for this demo. (1) On the GenClass script tag, or in window.GENCLASS_CONFIG, set mode "guard", aggressiveness "eager" and visual { on: true, fix: true }. (2) Show the devtools overlay on every host, not only locally, so the audience sees what GenClass does. (3) Keep the board search state in one GenClass atom instead of the two store keys: const boards = GenClass.runtime.atom("boards", { query: "", results: [] }); the input handler writes it once per response with boards.set((s) => ({ ...s, results: data.results, query: data.q })), and the list renders from boards.subscribe. Keep everything else as it is. Tell me the lines you changed.
  ```

  Say: *"Guard mode. GenClass may now act, with minimal reversible actions, when it is sure."*
- **3d.** Deploy. Type or paste into Claude, then Enter; when Claude asks to run `wrangler deploy`, choose **Yes**:

  ```text
  Deploy this to production with XDG_CONFIG_HOME=~/.config-dizon CLOUDFLARE_ACCOUNT_ID=4daefdf7440d182204be114a9c9f5074 npx --yes wrangler@4 deploy, and tell me when https://snowday-predictor.ca serves it.
  ```

  When Claude says the site serves it, go to act 4.

## 4. The same site, fixed on the user's screen (75 s)

Chrome: click **tab 2** (snowday-predictor.ca) and reload it with ⌘⇧R. DevTools stays open, now on the **Console** tab: every line
GenClass prints starts with `[GenClass]`. Wait for the badge at the bottom right to say **guard** and the model to be
ready (about 5 s). The same things, same order:

1. The banner reads **"Storm watch tonight: predictions refresh every hour…"** in grey on white. Console: *Check
   (measured): text contrast 1.00:1 on div.alert-bar…*, then *Applied a CSS fix … color: rgb(118, 118, 118)*.
2. Type `halton` fast: **the two Halton boards**. Console: *Flagged a stale response*, then *Reverted a stale write:
   boards.query was written 5 times by other operations…*. Switch to Network for a second: `q=h` still finishes last,
   and the page ignored it.
3. Double-click **Snow day**: the count still goes up by 2. Console: *Flagged a duplicate request … Not acted on*. Say:
   *"Not everything is safe to fix on the fly. This one it reports, and the agent fixes it in the code."*
4. Click OK on the notice, scroll: **the page scrolls** a second later. Console: *the page cannot scroll: html has
   overflow-y: hidden…*, then *Applied a CSS fix: removed the inline overflow: hidden*. Keep scrolling, slowly, down
   the page: **the ads load** in the cards, the FAQ and the article list as each comes into view. Say: *"And there
   are the ads. One CSS fix on the user's screen, and the site's revenue is back."* Scroll back to the top for the last
   one.
5. Mistype `L6H`, Predict: the error shows, and a second later **clicks work**. Console: *pointer-events: none has been
   left on body…*, then *Applied a CSS fix: removed the inline pointer-events: none on body*.

Click the GenClass badge at the bottom right → **Interventions**: *"Prevented a stale response … discard · guard"* with **Undo**. **Checks**: the banner's
contrast, the scroll lock and the click block, each with *"Runtime fix: applied"* and its CSS. Say: *"Nothing in the
site's code changed. GenClass fixed four of five on the user's screen, reversibly, and reported the fifth."*

## 5. The dashboard (45 s)

Chrome: click **tab 1** (the project), about 10 s after act 4, and click **Refresh** at the top right. Then the left
sidebar, one item at a time, scrolling a little on each:

1. **Project overview**: page loads, problems found, stopped by GenClass, the model loaded.
2. **Problems**: *What GenClass found*, the stale responses and the double submits, each with a **Copy prompt**.
3. **Actions**: *What GenClass did*, the reverted write and the CSS fixes.
4. **Pages**: which pages had them.

Say: *"Everything production saw, with a prompt per problem."*

## 6. The agent closes the loop (3 minutes; Claude's thinking gets sped up)

The dev build on this Mac, in a Chrome app window (no address bar). Run this in the off-screen terminal from section
0, step 3; only the window it opens is on camera:

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
   Check the replay result with genclass_replay. Then the other four problems GenClass found on this page: the double vote in the poll, the alert bar's contrast, the click block after a mistyped postal code and the scroll lock after the notice. Use genclass_findings and genclass_explain on each, fix the cause in index.html (small, idiomatic fixes), and sum up in five lines what you found, proved and fixed.
   ```
   Say at **not reproduced**: *"Same order, no bug."* Then: *"And the other four, from GenClass's own measurements, a
   line each. Deploy, and GenClass keeps watching."*

## 7. The closed loop on the dashboard (20 s)

Chrome's main window, **tab 1** (the project), left sidebar: **Closed loop**. It shows **Issue found → Reproduced →
Fix proven → Closed**; scroll to **What your agent did**. Say:
*"Everything the agent did, mirrored here. A person reads the test and ships."* Stop the recording.

## 8. After the recording: the real site back, GenClass on

Put back today's version of the site (it already runs GenClass, in heal mode, with its own project):

```bash
cd ~/GenClass-lib-main/demo-site/snowday-before && XDG_CONFIG_HOME=~/.config-dizon CLOUDFLARE_ACCOUNT_ID=4daefdf7440d182204be114a9c9f5074 npx --yes wrangler@4 rollback 3b0ff5e1-37cf-412f-8e52-b83c30381647 --name snowday-predictor --message "after the GenClass demo"
```

`3b0ff5e1-…` is the version Mehar deployed on 2026-10-25, live when the demo was prepared. The demo's board finder
and poll are demo data and must not stay on the real site; the agent's fixes from act 6 stay in the
folder as the record of the demo. Then `git checkout -- . && git clean -fdqx .` resets the folder for the next take.

## After: the 2–3 minute cut

Only speed changes. Real time: acts 1 and 4, the overlay cards, the dashboard, Claude's answers in act 6 (REPRODUCED,
not reproduced, the summary), the Loop page. 8–16x: Claude working in acts 3 and 6, the page loads in act 6. 2–3x:
waits.

## Tested before recording

```bash
npm run build -w @genclass/runtime
node demo-site/record/verify-snowday.mjs --keep      # observe: 5/5 bugs show; guard: 4/5 fixed, the double vote flagged
node demo-site/record/agent-fix-snowday.mjs          # Claude (Opus) fixes all five in index.html from GenClass's findings
node demo-site/record/dashboard-e2e.mjs              # a real genclass.dev project: events, problems, the Loop log mirrored
```

The banner's fix needs `@genclass/runtime` 0.3.0-beta.3 or later (a colour fix kept while a click block hides the text
from hit testing, and while it is out of view). It is published and the dashboard's Connect dialog pins it.

## If something does not fire

- A full-screen Google ad after a reload, or an ad bar pinned to the bottom over the notice or the badge: close it
  with its × or its arrow tab. They are Google's, not the bugs; Google shows them less often to someone who has
  loaded the site many times, so a few may come up and then stop.
- After the scroll fix some ad slots stay empty (a gap in the card): Google fills most slots, not every one.
- The race needs the six letters within about a second: type fast.
- Wait for the badge's model before typing (the first seconds after a load).
- The board search must be the atom from 3c, or guard cannot drop the stale write.
- `genclass_status` says no page: load the dev page after Claude's MCP server started.
- A replay says the armed load recorded nothing: a reload used it up. Arm again, then load once.
- The shop (`demo-site/tiny-shop-before`, `DEMO.md`) is the fallback demo: five bugs, all five fixed in guard.
