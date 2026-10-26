# The demo, step by step

The site: **https://tiny-shop-gray.vercel.app** (Vercel team daybot-8ee5232e, project `tiny-shop`, deployed from
`demo-site/tiny-shop` with `vercel --prod`). It is Tiny Shop with GenClass already in it: the published
`@genclass/runtime@beta`, guard mode, the visual fixes on, telemetry on (a public host sends by default), and the
devtools overlay kept on in production so the audience can see what GenClass does. Its GenClass project is
"tiny-shop (demo)"; the private dashboard link is in `demo-site/tiny-shop/.genclass.local` (never committed).

Three URLs of the same site tell the whole story:

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
2. **Put the demo app in your account**, so the dashboard shows under Apps instead of a private link. In a terminal:

   ```bash
   cd demo-site/tiny-shop
   npx @genclass/runtime@beta login
   ```

   It prints a code and opens https://genclass.dev/login/device; approve it there. Back in the terminal it finds the
   app's private link in `.genclass.local` and offers to add that dashboard to your account: say yes. From then on the
   dashboard is at genclass.dev under Apps → tiny-shop (demo), and it already holds the page loads from today.
3. **Warm the dashboard**: open the three URLs above once each and use the shop for a minute (search fast, double
   click, checkout, reviews, profile, subscribe three times). Events arrive in batches every 10 s. Then the Overview,
   Problems and Pages views have something to show when the recording starts.
4. **Have Claude Code ready** in `demo-site/tiny-shop` with the MCP server added, from the dashboard's own MCP page
   (it generates the exact command with your agent link), or:

   ```bash
   claude mcp add genclass -e GENCLASS_DASHBOARD=<your dashboard link> -e GENCLASS_REPORT=on -- npx -y @genclass/mcp@0.2.0
   ```

   `GENCLASS_REPORT=on` is what mirrors the agent's steps to the dashboard's Closed loop view. Keep the link out of
   anything you commit.
5. **Open VS Code** on `demo-site/tiny-shop` (`code demo-site/tiny-shop`) and the dev server: `npm run dev`
   (the API on 8788, Vite on http://localhost:5173). The agent link only works on localhost, which is why the agent
   act runs on the dev server, not on Vercel.

## The recording

### Act 1. The shop (30 s)

Open `https://tiny-shop-gray.vercel.app/?genclass=off`. Say what it is: a small shop, the kind of code everyone has.
Type `react` fast: the list ends on the wrong results. Double-click Add to cart: two. Point at the banner nobody can
read and the `{{price}}`.

### Act 2. Sign in, one command, the dashboard (60 s)

Show genclass.dev signed in, the app under Apps. Show the one line in `src/main.js` in VS Code:
`import genclass from "@genclass/runtime/auto"` and `src/genclass.config.js` with the key. Say: `npx
@genclass/runtime@beta init` wrote both and created this dashboard.

Open `https://tiny-shop-gray.vercel.app/?genclass=observe`. The overlay at the bottom right: open it, Checks tab:
the measured checks on this page, each with the measurement, the threshold and the CSS fix. Type `react` fast; open
the Detections tab: "Stale response", with the model's confidence and the evidence. Say: observe changes nothing,
it reports, and these reports are already on the dashboard.

Switch to the dashboard: Overview (page loads, problems found, stepped in), Problems (stale responses, double
submits, failing endpoints, each with how to fix it), Pages.

### Act 3. The hot fix (45 s)

Open `https://tiny-shop-gray.vercel.app/` (guard). The banner is readable: GenClass applied the CSS fix at run time,
with an Undo. Type `react` fast: the list ends on the right results. Open the overlay, Interventions: "Reverted a
stale write", stale 99%, discard, the undo button. Say: no code changed; the same model that reported the bug acts
when it is sure, with a minimal, reversible action, and leaves alone what it is not sure about (the double click:
flagged, not acted on, the gain was under the bar).

Back on the dashboard: "It stepped in N times, and nothing it changed was undone."

### Act 4. The coding agent closes the loop (90 s)

In VS Code with Claude Code open on `demo-site/tiny-shop`, the dev server running, the page open at
http://localhost:5173. Type `react` fast on the local page.

In Claude Code:

1. "What's wrong with the search?" → it calls `genclass_findings`: the stale-write findings at the top, with the
   TypeError and the duplicate request under them.
2. "Explain it" → `genclass_explain`: every request, delivery and state write in causal order, the delivery order
   that produced it, and a Playwright test.
3. "Prove it" → `genclass_replay arm`; type `react` on the page again; `genclass_replay result`: **REPRODUCED**.
4. "Fix it" → it edits `src/main.js` (a sequence number per search request; the diff is in
   `../../docs/evidence/e2e-walkthrough/steps/06-main.fixed.js` if you want to paste it); replay again: **not
   reproduced**.
5. "Any other order?" → `genclass_explore`, five page loads typing `react` (the agent asks you to load the page five
   times, or runs it with Playwright): **No race found**.

Switch to the dashboard's **Closed loop** view: found → reproduced → fix proven → closed, with the agent's log under
it: found, evidence read, test written, replay reproduced, replay not reproduced, explore. Say: everything the agent
did, mirrored; a person reads the test and ships.

### Act 5. One command on any page (15 s)

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
- The agent act needs `connectAgent` (it is in `src/main.js`, development builds only) and an MCP server on the
  default port 47357; `genclass_status` says whether the page is connected.

## Redeploy

```bash
cd demo-site/tiny-shop && npm install && vercel --prod --scope daybot-8ee5232e
```
