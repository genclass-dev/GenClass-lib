# Record the GenClass demo yourself: the script

The demo runs on the real site, **https://snowday-predictor.ca**: the Snow Day Predictor as it was before GenClass,
with five bugs planted, is deployed to its Worker (`snowday-predictor`, Dizon's Cloudflare account) right before the
recording; GenClass fixes them there; afterwards the site goes back to today's version, which already runs GenClass.
The code is `demo-site/snowday-before`: the real site's pages, `worker.js` and `wrangler.jsonc` (the live Worker's name,
compatibility date and `ASSETS` binding), and `functions/api/` for the school board finder and the community poll.

One take, two windows side by side on one screen: **Chrome on the left** (the site, genclass.dev), **VS Code on the
right** (the site's folder, Claude Code in the integrated terminal). The story: the broken site, live → one prompt
adds GenClass and deploys → the same site, fixed on the user's screen → the dashboard → the agent closes the loop.
About 12 minutes raw; sped up afterwards to 2–3 minutes (only speed changes, no cuts, no zoom). **Nothing is typed on
camera** except the site's address in the page check and what a visitor types on the site: every prompt comes from a
Copy button on genclass.dev, and Claude Code starts from the Claude logo in VS Code. No localhost ever shows: the one
act that needs a dev page runs it in a Chrome app window, which has no address bar.

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

1. **One GenClass MCP server on this Mac, the one act 6 starts**: it must own the bridge port so the dashboard mirror and
   the replays work. Quit other Claude Code sessions that run one (or stop their genclass server). The repo's own
   `.mcp.json` is set aside as `.mcp.json.off` for the recording.
2. **Reset the code** to its broken state, forget the last take's MCP entry, and **deploy it to snowday-predictor.ca**,
   right before you start recording (real visitors see the five bugs from now until act 3's deploy):

   ```bash
   cd ~/GenClass-lib-main/demo-site/snowday-before && git checkout -- . && git clean -fdqx . && (claude mcp remove genclass -s local 2>/dev/null; true) && npm run deploy
   ```

   (`npm run deploy` is the folder's own deploy script: wrangler with the Dizon login, `XDG_CONFIG_HOME=~/.config-dizon`,
   so Mehar's default login stays as it is. `git clean -fdqx` also removes a practice run's `.mcp.json`; the folder's
   `.vscode` and `.claude` settings are committed, so they stay.) Open https://snowday-predictor.ca once (⌘⇧R, so the cached page
   goes).
3. **The dev server and the dev page**, for act 6 only, in a terminal you will not show: `npx --yes wrangler@4 dev
   --port 8788` in the same folder, then the dev page in a Chrome app window (no address bar), minimized with ⌘M:

   ```bash
   open -na "Google Chrome" --args --app="http://localhost:8788/?genclass=observe" --window-size=760,952 --window-position=0,30
   ```

4. **Chrome**: one window, signed in to Google, **signed out of genclass.dev** (if you are signed in: your account
   menu at the top right of genclass.dev → Sign out), so act 2 shows the sign-in. Exactly two tabs: **tab 1**
   https://genclass.dev (the home page), **tab 2** https://snowday-predictor.ca. Leave tab 1 in front. Bookmark bar
   hidden (⌘⇧B). Put the window on the left half. From here on the recording never types an address: every page is a
   click from these two tabs.
5. **VS Code**: open the folder `~/GenClass-lib-main/demo-site/snowday-before` (File → Open Folder), open `index.html`,
   close every terminal. Put the window on the right half. Do not start Claude: act 3 starts it with the **Claude logo
   at the top right of the editor**, which opens Claude Code in a new terminal (the folder's `.vscode/settings.json`).
   The folder's `.claude/settings.json` picks Opus and lets Claude edit files without asking; it still asks before a
   deploy (press Enter on **Yes**).
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
the frozen page, the double vote. That's what GenClass in the page is for."* Stay on this page: act 2 starts from its
**Fix it with GenClass** button.

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

## 2. Sign in and pick what GenClass does (40 s)

Chrome, tab 1, the page check's result. Every step is a click:

1. **Fix it with GenClass**, under the score.
2. **Continue with Google** → pick your Google account (a first sign-in creates the account).
3. **Create a new project** opens with the name already filled in, `snowday-predictor.ca`. Click **Create new
   project**.
4. The project opens on the **Connect to your project** dialog, **Framework** tab. Tick, top to bottom:
   **Guard**, **Eager**, **Badge on the live site**, **Connect my coding agent to production**, **Deploy when done**.
   Say: *"Guard: fix what it's sure of. The badge, so you can see it. My agent gets production. And deploy."*
5. **Copy the prompt for your coding agent**. Say: *"That's the whole setup. One prompt."*
6. Close the dialog with the **×** at its top right. The project's overview stays open in tab 1, waiting for its
   first event.

## 3. Claude adds GenClass and deploys (3–4 minutes of Claude working; this stretch gets sped up)

VS Code on the right.

1. Click the **Claude logo** at the top right of the editor: Claude Code opens in a terminal.
2. Click in its input box and paste (⌘V): Claude Code shows the prompt folded as *[Pasted text …]*. Press Enter.
3. Claude puts the script tags on every page (guard, eager, the visual fixes, the badge), keeps the board search in one
   atom, adds the agent link for local pages and its own GenClass MCP server with the agent link, checks the site
   locally, then asks to run `npm run deploy`: press Enter on **Yes**. Keep `index.html` open: the edits show as Claude
   makes them.

Say: *"No docs read, nothing typed. The dashboard told the agent what to do."* When Claude says the site is deployed,
go to act 4.

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

Say: *"Everything production saw, with a prompt per problem."* Back on **Problems**, click **Fix them all: copy one
prompt**.

## 6. The agent closes the loop (3 minutes; Claude's thinking gets sped up)

1. VS Code: click the **Claude logo** again. A new conversation opens in a new terminal: it has the GenClass MCP server
   act 3 added. Paste (⌘V), Enter.
2. Click the dev page's window in the Dock (Chrome, minimized in section 0: the dev build, no address bar). Say: *"The
   dev build, where the agent can replay the network."*
3. Claude checks the page is connected, then says in one line what to do on the page each time it needs a load
   (reload, type `halton` fast; double-click **Snow day**; and so on). Do it; Claude waits and goes on by itself. Leave
   the window alone while Claude edits.

Say at **REPRODUCED**: *"Proven, not guessed."* At **not reproduced**: *"Same order, no bug."* At the summary:
*"Every problem, one line each: found, proven, fixed. Deploy, and GenClass keeps watching."*

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
folder as the record of the demo. Section 0, step 2 resets the folder for the next take, and the project from this take
can go with **Project Settings → Delete project** on genclass.dev.

## After: the 2–3 minute cut

Only speed changes. Real time: acts 1 and 4, the overlay cards, the dashboard, Claude's answers in act 6 (REPRODUCED,
not reproduced, the summary), the Loop page. 8–16x: Claude working in acts 3 and 6, the page loads in act 6. 2–3x:
waits.

## Tested before recording

```bash
npm run build -w @genclass/runtime
node demo-site/record/rehearse-act3.mjs              # act 3 from genclass.dev's own copied prompt (Guard, Eager, Badge ticked): guard 4/5 on what Claude wrote
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
- Guard drops the stale search only when the board search is one atom (the prompt's step 4 asks for it) and Eager is
  ticked: guard's default margin lets this site's stale answer through.
- Claude stops with a question instead of going on: press Enter on its suggested answer; the prompts are written so
  it needs no typed reply.
- `genclass_status` says no page: load the dev page after Claude's MCP server started.
- A replay says the armed load recorded nothing: a reload used it up. Arm again, then load once.
- The shop (`demo-site/tiny-shop-before`, `DEMO.md`) is the fallback demo: five bugs, all five fixed in guard.
