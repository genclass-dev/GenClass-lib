# The demo, step by step

Two copies of the same shop live here:

- **`tiny-shop-before/`**: the shop as it is, no GenClass. This is what you open in VS Code and have Claude
  integrate, live, on camera.
- **`tiny-shop/`**: the finished state, already deployed to **https://tiny-shop-gray.vercel.app** (Vercel team
  daybot-8ee5232e, project `tiny-shop`). GenClass from npm, guard mode, the visual fixes on, telemetry on (a public
  host sends by default), the devtools overlay kept on in production so the audience sees what GenClass does. Its
  GenClass project is "tiny-shop (demo)"; the private link is in `tiny-shop/.genclass.local`, never committed. It is
  the fallback if the live integration goes sideways, and the site for acts 1, 4 and 6.

Three URLs of the deployed site tell the story without a redeploy:

| URL | what it shows |
|---|---|
| `https://tiny-shop-gray.vercel.app/?genclass=off` | the shop as it is: nothing installed |
| `https://tiny-shop-gray.vercel.app/?genclass=observe` | GenClass watching and reporting, changing nothing |
| `https://tiny-shop-gray.vercel.app/` | guard mode: GenClass acting, with Undo |

The bugs to trigger, and how:

- **The stale search.** Type `react` fast (under 200 ms between keys). The one-letter query answers after 1.2 s, the
  rest after 200 ms, so the results for "r" arrive last and overwrite the right ones. Without GenClass the list ends on
  eight results for "r" while the box says "react".
- **The double click.** Double-click Add to cart on the Retro keyboard: two requests, the cart counts two.
- **Checkout** always fails; **Load reviews** takes 3.5 s with no spinner; **Show my profile** throws a TypeError;
  **Subscribe** fails every third time.
- **The visual faults** are there on every load: the grey-on-grey banner in mojibake, the broken logo, `{{price}}`,
  lorem ipsum, the strip that scrolls sideways, the cookie dialog under a cover, the "Secret deals" button off screen.

## Before recording

1. **Sign in to GenClass** at https://genclass.dev/login (Google, GitHub, or email and password).
2. **Put the deployed app in your account**, so its dashboard shows under Apps rather than as a private link:

   ```bash
   cd demo-site/tiny-shop
   npx @genclass/runtime@beta login
   ```

   It prints a code and opens https://genclass.dev/login/device; approve it. Back in the terminal it finds the app's
   private link in `.genclass.local` and offers to add that dashboard to your account: say yes.
3. **Warm the dashboard**: open the three URLs above and use the shop for a minute (search fast, double click,
   checkout, reviews, profile, subscribe three times). Events arrive in batches every 10 s. Then Overview, Problems
   and Pages have material when the recording starts.
4. **Prepare the live integration**: `cd demo-site/tiny-shop-before && npm install`, open it in VS Code
   (`code demo-site/tiny-shop-before`), start Claude Code in that folder, and have a terminal ready. Make sure no
   `.genclass.local` or `src/genclass.config.js` is left in it from a rehearsal (`git status` shows nothing to clean
   when it is pristine).
5. **Claude Code's MCP server** for act 5: added from the dashboard's MCP page (it generates the exact command with your
   agent link), or

   ```bash
   claude mcp add genclass -e GENCLASS_DASHBOARD=<your dashboard link> -e GENCLASS_REPORT=on -- npx -y @genclass/mcp@0.2.0
   ```

   `GENCLASS_REPORT=on` is what mirrors the agent's steps to the Closed loop view. Keep the link out of anything you
   commit. Then in `tiny-shop-before`, `npm run dev` (the API on 8788, Vite on http://localhost:5173) when act 5
   starts; the agent link works on localhost only, which is why that act runs on the dev server.

## The recording

### Act 1. The shop (30 s)

Open `https://tiny-shop-gray.vercel.app/?genclass=off`. Say what it is: a small shop, the kind of code everyone has.
Type `react` fast: the list ends on the wrong results. Double-click Add to cart: two. Point at the banner nobody can
read and the `{{price}}`.

### Act 2. The user flow: copy the prompt, paste it, everything happens (90 s)

This is how a developer adds GenClass: one prompt from the dashboard into their coding agent.

1. **genclass.dev, signed in.** Apps → New app → name it `tiny-shop`. Its page opens on the Connect dialog with the
   project key and the big button **"Copy the prompt for your coding agent"**. Click it. Say: that's the whole
   setup. (What it copies, with the key filled in, is the eight-step prompt: install the runtime, start it with the
   key in observe mode, connect the state responses write, the agent link for dev builds, the GenClass MCP server for
   the agent itself, a dev-server check, "tell me what you changed".)

2. **VS Code on `tiny-shop-before`, Claude Code open.** Paste it. Claude installs `@genclass/runtime@beta`, adds
   the key (two lines, or `npx @genclass/runtime@beta init --token gc_… --yes`), makes the search state a GenClass
   atom and wraps the shop's store, adds `connectAgent` for development builds, runs `npx -y @genclass/mcp@0.2.0 init`
   so it has the GenClass tools itself, starts the dev server, loads a page, calls `genclass_status` and reports back.
   Show the diff: `src/main.js` and the config. Say: no docs read, no integration guide; the dashboard told the agent
   what to do, and the agent now sees the app.

3. **One sentence more, the beat that sets up act 4**: "Turn on guard mode with the visual fixes." Claude sets
   `mode: "guard"` and `visual: { on: true, fix: true }` in the config (one line). Load http://localhost:5173: the
   overlay's badge at the bottom right says guard. (The reference result is `tiny-shop/src`, if it strays.)

4. **Deploy.** "Deploy this to Vercel, production." Claude runs `vercel --prod` (the CLI is signed in). Or cut to the
   already deployed `tiny-shop-gray.vercel.app`, which is this exact state.

### Act 3. The dashboard (45 s)

Open `https://tiny-shop-gray.vercel.app/?genclass=observe`. Open the overlay, Checks tab: the measured checks on this
page, each with the measurement, the threshold and the CSS fix. Type `react` fast; Detections tab: "Stale response",
with the model's confidence and the evidence. Say: observe changes nothing, it reports, and these reports are already
on the dashboard.

Switch to genclass.dev: Overview (page loads, problems found, stepped in), Problems (stale responses, double submits,
failing endpoints, each with how to fix it), Pages.

### Act 4. The hot fix (45 s)

Open `https://tiny-shop-gray.vercel.app/` (guard). The banner is readable: GenClass applied the CSS fix at run time,
with an Undo. Type `react` fast: the list ends on the right results. Open the overlay, Interventions: "Reverted a
stale write", stale 99%, discard, the Undo button. Say: no code changed; the same model that reported the bug acts
when it is sure, with a minimal, reversible action, and leaves alone what it is not sure about (the double click:
flagged, not acted on, the gain was under the bar).

Back on the dashboard: "It stepped in N times, and nothing it changed was undone."

### Act 5. The coding agent closes the loop (90 s)

VS Code on the integrated shop, the dev server running, the page open at http://localhost:5173, Claude Code with the
MCP server. Prompt it the way the dashboard's MCP page suggests, or just talk:

1. "Connect to GenClass and check the page is seen." → `genclass_status`: 1 active page.
2. Type `react` fast on the local page. "What's wrong with the search?" → `genclass_findings`: the stale-write
   findings at the top, the TypeError and the duplicate request under them.
3. "Explain it." → `genclass_explain`: every request, delivery and state write in causal order, the delivery order
   that produced it, and a Playwright test.
4. "Prove it." → `genclass_replay arm`; type `react` again; `genclass_replay result`: **REPRODUCED**.
5. "Fix it." → Claude edits `src/main.js` (a sequence number per search request; the reference fix is
   `../docs/evidence/e2e-walkthrough/steps/06-main.fixed.js`); replay again: **not reproduced**.
6. "Any other order?" → `genclass_explore`: five page loads typing `react` (Claude asks you to load the page five
   times, or drives it with Playwright): **No race found**.

Switch to the dashboard's **Closed loop** view: found → reproduced → fix proven → closed, and the agent's log under
it: found, evidence read, test written, replay reproduced, replay not reproduced, explore. Say: everything the agent
did, mirrored; a person reads the test and ships.

### Act 6. One command on any page (15 s)

```bash
npx @genclass/runtime@beta scan https://tiny-shop-gray.vercel.app
```

Visual score 8/100, 10 problems, each with its CSS fix. Say: before anything is installed, on any site.

## If something does not fire

- The race needs the first keystroke's response to arrive last: type fast, and start from an empty box (clear it
  between tries). On a slow network the 1.2 s is still the slowest answer.
- The model loads at idle in the first second; wait for the overlay's badge before typing.
- Guard's revert happens 0.1 s after the stale write lands: the list flashes to the wrong results and snaps back.
  That is the moment; the overlay's Interventions tab is the proof.
- The agent act needs `connectAgent` in the page (development builds only) and an MCP server on the default port
  47357; `genclass_status` says whether the page is connected.
- If Claude's live integration strays, `demo-site/tiny-shop/src` is the finished state to compare with or copy in.

## Redeploy the finished site

```bash
cd demo-site/tiny-shop && npm install && vercel --prod --scope daybot-8ee5232e
```
