# GenClass in 3 minutes: the shot list

Four sections, recorded as six short clips (A to F) and joined in the edit. Voice-over is added afterwards, so every
step says how long to **hold** still for the line that goes over it. Do exactly what each line says, in order; nothing
else is clicked, typed or opened.

| Clip | Section | What it shows | Real time | In the cut |
|---|---|---|---|---|
| A | 1 | Dashboard: Snowday Predictor, Critical, 1,037+ problems, 458 fixed live, the problems | 45 s | 30 s (1.5x on scrolls) |
| B | 2 | snowday-predictor.ca with GenClass off: the bugs | 40 s | 25 s |
| C | 2 | The same site with GenClass on: fixed on screen, the widget counts each one | 70 s | 45 s |
| D | 3 | Fix them all → Claude Code fixes the code through MCP, proves it, deploys | 4–6 min | 40 s (8–12x, real time on the summary) |
| E | 3 | Dashboard: Closed loop | 15 s | 10 s |
| F | 4 | One prompt installs GenClass in another repo, dry run first | 2–3 min | 20 s (8x, real time on the diff) |

End card (your edit): **Detect → Hotfix → Permanently fix → Monitor.**

---

## 0. Once, before recording (about 20 minutes, nothing here is recorded)

1. **Live versions.** These three must be live (Claude Code reports each one when it is done):
   - genclass.dev: collector version `5602614c` (the Snowday estimate in the dashboard and in MCP).
   - npm: `@genclass/runtime@0.3.0-beta.4` (the widget counts checks).
   - snowday-predictor.ca: `~/snowday-demo` deployed with beta.4 (`cd ~/snowday-demo && npm run deploy`).
2. **Google's overlay ads off** for the recording (they cover the page and steal clicks; a click during the test opened
   an advertiser's site): AdSense → Ads → By site → snowday-predictor.ca → Edit → Ad formats → **Overlay formats**:
   turn off **Vignette ads**, **Anchor ads** and **Side rail ads** → Apply. In-page ads stay on (clip C scrolls to
   them). It takes up to an hour to apply. Turn them back on after recording.
3. **One GenClass MCP server.** Quit every other Claude Code session that runs the GenClass MCP server (right now one
   from `~/jev/claudes-shop` holds the bridge port 127.0.0.1:47357). The one in `~/snowday-demo` must own it.
4. **The section 3 folder**, `~/snowday-demo` (the live site's code, its own git repo). Copy your MCP setup into it:

   ```bash
   cp ~/snowday-predictor/.mcp.json ~/snowday-demo/
   ```

   It must have `GENCLASS_DASHBOARD` (the Snowday Predictor agent link) and `GENCLASS_REPORT` set to `on`, or the
   Closed loop page (clip E) stays empty.
5. **The dev server**, in a Terminal window you never show:

   ```bash
   cd ~/snowday-demo && npm run dev
   ```

   Then the dev page, as an app window with no address bar, minimized right away (⌘M):

   ```bash
   open -na "Google Chrome" --args --app="http://localhost:8788/?genclass=observe" --window-size=760,952 --window-position=0,30
   ```

6. **Section 4 folder**: any small web app without GenClass, with its own git repo, for example:

   ```bash
   cd ~ && npm create vite@latest my-app -- --template react-ts && cd my-app && npm install && git init -q && git add -A && git commit -qm "my app"
   ```

7. **Chrome**: one new window, your profile, signed in to genclass.dev. Bookmarks bar hidden (⌘⇧B), zoom 100% (⌘0),
   the window 1440×900 or full screen. No other windows. Exactly three tabs:
   - Tab 1: https://genclass.dev/account
   - Tab 2: https://snowday-predictor.ca/?genclass=off
   - Tab 3: https://snowday-predictor.ca/
8. **VS Code**: File → Open Folder → `~/snowday-demo`, open `index.html`, close the sidebar's chat. Terminal → New
   Terminal, drag it to half the window, type `claude` and Enter, accept the folder's MCP server once. Then type
   `/clear` and Enter, so no earlier conversation shows. Keep this window ready behind Chrome.
9. **Practice the fast typing** twice in tab 2: click "Find your school board", type `halton` in under a second.
10. **Reset before every take** of D (the code goes back to broken, the live site too):

    ```bash
    cd ~/snowday-demo && git checkout -- . && git clean -fdq -e .mcp.json && npm run deploy
    ```

---

## Section 1: the dashboard (clip A, 45 s)

Start recording on **tab 1** (genclass.dev/account, your projects).

1. Click the **Snowday Predictor** card. *Hold 4 s.*
   VO: "This is Snow Day Predictor, an app I vibecoded a year ago. I added GenClass a week ago."
2. Point the mouse at the big red **Critical**. *Hold 3 s.*
   VO: "GenClass rates each app Critical, Needs attention or Healthy. This one is critical: 579 problems it couldn't
   fix on its own."
3. Move to the tiles: **1,037+ problems found**, then **458 fixed live**. *Hold 4 s.*
   VO: "Over a thousand production errors in one week, and 458 of them GenClass already hotfixed, live, for users."
4. Point at the **Problems found** chart and its legend (Stale responses, Double submits, Scroll locked, Page stopped
   taking clicks, Ads covering content). *Hold 3 s.*
5. In the left rail click **Problems** (the triangle icon, second). Scroll slowly down over the cards: **Stale
   responses** (race conditions), **Scroll locked**, **Double submits**, **Page stopped taking clicks**, **Ads
   covering content**, **Invisible text**. *Hold 6 s while scrolling.*
   VO: "Race conditions, a page that won't scroll, frozen clicks, double votes, ads on top of the content, invisible
   text. Each with where it happened and how to fix it."

Stop recording.

## Section 2: the same site, without and with GenClass

### Clip B: GenClass off (40 s)

Start recording, click **tab 2** (`?genclass=off` shows in the address bar), press **⌘R**, wait 2 s.

1. Move the mouse along the **white strip under the menu**. *Hold 3 s.*
   VO: "There's a storm warning in that strip. White text on white."
2. Click **Find your school board**, type `halton` **fast**. The list shows **more than the two Halton boards**.
   *Hold 3 s.* VO: "Type fast, and the answer for 'h' arrives last and wins: a race condition."
3. In **Will schools close tomorrow?**, double-click **Snow day**: the count goes **up by 2**. *Hold 2 s.*
   VO: "One person, two votes."
4. Click **OK** on the notice at the bottom left. Scroll down with the wheel: **the page does not move**.
   *Hold 3 s.* VO: "The notice locked scrolling. Every ad on this site is below that line."
5. Click the postal code box, type `L6H`, click **Predict**: the error shows. Click **Snow day**: nothing happens.
   *Hold 3 s.* VO: "One typo, and the page stops taking clicks."

Stop recording.

### Clip C: GenClass on (70 s)

Start recording, click **tab 3** (no `?genclass` in the address), press **⌘R**. Wait until the **GenClass** widget at
the bottom right says **guard** with a green square (about 5 s). Its counters, left to right: shield = interventions,
eye = detections, scan = measured checks.

1. The strip under the menu now reads **"Storm watch tonight: predictions refresh every hour…"** in grey; the widget's
   **scan counter is 1**. *Hold 3 s.* VO: "With GenClass on, the warning is readable. GenClass measured it and fixed
   the colour, on the user's screen."
2. Type `halton` **fast** in **Find your school board**: **Halton DSB** and **Halton Catholic DSB** only; the
   **shield counter turns 1**. *Hold 3 s.* VO: "Same fast typing. GenClass dropped the stale answer."
3. Double-click **Snow day**: still +2; the **eye counter turns 1**. *Hold 2 s.*
   VO: "This one isn't safe to fix on the fly, so GenClass flags it for a real fix."
4. Click **OK** on the notice. Scroll down once, **wait 3 s**, scroll again: **the page scrolls**; the **scan counter
   turns 2**. Keep scrolling slowly to the cards with ads in them. *Hold 4 s.* VO: "Scrolling is back, and so are
   the ads."
5. Press **Home** (back to the top). Click the postal code box, type `L6H`, click **Predict**, **wait 3 s**, click
   the postal code box again: it takes the click; the **scan counter turns 3**. Press **⌘A**, type `L6H3X5`, click
   **Predict**: the prediction shows. *Hold 3 s.* VO: "And the frozen page answers again."
6. Click the **GenClass widget**. **Interventions**: *Prevented a stale response*, with **Undo**. Click **Detections**:
   the duplicate vote. Click **Checks**: **Invisible text**, **Page cannot scroll**, **Page stopped taking clicks**,
   each with *Runtime fix applied* and its CSS. *Hold 6 s.* Press **Esc**.
   VO: "Every fix is reversible, and nothing in the site's code changed. Yet."

Stop recording.

## Section 3: Claude fixes the code for good

### Clip D: Fix them all (4–6 min real time)

Start recording on **tab 1**, the Snowday Predictor project.

1. Left rail: **Problems**. Click **Fix them all: copy one prompt** (the green button above the cards). *Hold 2 s.*
   VO: "One button copies every problem as a prompt for my coding agent."
2. Left rail: **MCP** (the robot icon). *Hold 3 s.* VO: "Claude reads these production findings through GenClass's
   MCP server." (Nothing to click here: this folder is already connected.)
3. Switch to **VS Code** (⌘Tab). Click in Claude Code's input, **⌘V**, **Enter**.
4. Claude checks the dev page is connected, then says in one line what to do on it each time it needs a page load
   (for example: reload, type `halton` fast). Each time: click the minimized dev page in the Dock, do exactly that,
   then click back on VS Code. Claude waits and goes on by itself.
   VO at **REPRODUCED**: "Proven, not guessed." At **not reproduced**: "Same order, no bug."
5. When Claude prints its summary (one line per problem), *hold 5 s*. Type `deploy it with npm run deploy` and
   **Enter**; at the permission question press **Enter** on **Yes**. *Hold until it says the deploy is done.*
   VO: "Fixed in the code, with a test for each, and deployed."

Stop recording.

### Clip E: the closed loop (15 s)

Start recording on **tab 1**. Left rail: **Closed loop**. Point at **Issue found → Reproduced → Fix proven →
Closed**, then scroll to **What your agent did**. *Hold 6 s.*
VO: "GenClass fixes what it can for users right away. Claude uses those same findings to fix the code."

Stop recording.

## Section 4: install in one prompt (clip F, 2–3 min real time)

Start recording on **tab 1**.

1. Top left, the organization name → **All projects** (or open https://genclass.dev/account). Click **New project**,
   name it `my-app`, click **Create new project**.
2. The **Connect** dialog opens on **Framework**. Tick **Guard**. Click **Copy the prompt for your coding agent**.
   *Hold 2 s.* VO: "To add GenClass to any app: one prompt."
3. Switch to a second VS Code window on `~/my-app` with Claude Code open (prepared like step 8 of section 0). Click
   its input, **⌘V**, then type one line before Enter:
   `First run init with --dry-run and show me the diff; apply only after I say yes.`
   Press **Enter**.
4. Claude shows the proposed changes. *Hold 4 s.* VO: "It shows exactly what it will change." Type `yes`, **Enter**.
5. Claude applies and reports. *Hold 3 s.* VO: "No manual integration. Review the diff, and GenClass is running."

Stop recording. After recording: genclass.dev → `my-app` → **Project Settings** → **Delete project**.

---

## The edit

- Join A, B, C, D, E, F in order, hard cuts.
- Speed: A at 1x with scrolls at 1.5x. B and C at 1x, waits (model loading, "wait 3 s") at 3x. D: dashboard clicks
  1x, Claude working 8–12x, **REPRODUCED**, **not reproduced** and the summary back to 1x, the deploy 8x. E at 1x.
  F: dialog 1x, Claude working 8x, the diff 1x.
- Total about 3:00. If it runs long, cut step 2 of D (the MCP page) and step 3 of B (the double vote).

## If something does not fire

- **The race does not show in B or C**: you typed too slowly. Clear the box and type `halton` in under a second.
- **The scroll does not come back in C**: scroll once more and wait 3 s; GenClass needs one scroll attempt after the
  lock has held for a second, and it checks every 2 s.
- **The counters stay 0 in C**: the site still runs beta.3 (section 0, step 1). The fixes still happen; open the widget
  and click **Checks** to show them.
- **A full-screen ad or an ad bar appears**: overlay ads are still on (section 0, step 2). Close it with its × and
  reload the tab before the take.
- **Claude says no page is connected** (D): load the dev page once after Claude started; the dev server must be
  running (section 0, step 5).
- **A Checks card says "Blank page"**: a full-screen ad covered the page when it loaded. Reload the tab.
