# Evidence: onboarding a broken shop onto GenClass, step by step, with the hot fixes

A new project, "Tiny Shop", a Vite site with a tiny Node API, written with the problems a rushed Friday leaves
behind: a search that shows results for the wrong query when responses arrive out of order, a double click that adds
to the cart twice, a checkout that always fails, a slow endpoint, a click handler that throws, a newsletter that fails
every third time, and a page full of visual faults (no viewport meta, a broken logo, a broken web font, a missing
stylesheet, an unreadable banner in mojibake, an unrendered `{{price}}`, lorem ipsum, an undefined CSS variable, a
distorted image, a strip wider than the screen, a button off screen, a promo overlay over the checkout button and a
cookie dialog under a cover). The app is in [`app/`](app/) as a user would have it, with no GenClass.

Then GenClass is added the way the docs tell a newcomer to, one step at a time, with the **published packages only**
(`@genclass/runtime@beta`, 0.3.0-beta.2, and `@genclass/mcp@0.2.0`), a **real project at genclass.dev** created by
`init`, and the published MCP server, driven by a browser playing the user and a small MCP client playing the coding
agent. Every step shows what the user types (a terminal screenshot) and what the user sees (the page, the devtools
overlay or the dashboard). The browser session is also a video, `out/walkthrough.webm` and `out/walkthrough.gif`.

**About the terminal screenshots.** They are rendered from the captured output: the same text, verbatim, in a terminal
window drawn by Chromium (`lib/term.mjs`), because the macOS Terminal cannot be driven from this session and a
rendering keeps every character readable. Each has a plain-text twin, `out/NN-*.txt`. The dashboard's private link is
redacted everywhere; the project key visible on the dashboard screenshots is the app's public token, which can only
add telemetry to this app.

## The four moments

**1. A hot fix, with no code change.** Guard mode on the unfixed shop: the user types "react" fast, the slow response
to "r" lands last and overwrites the results, and GenClass reverts that write 0.10 s later. The page ends on the two
right results, the overlay shows the intervention with an Undo button, and the banner nobody could read is recoloured
by the measured checks' fix. [Step 6](#step-6-a-hot-fix-today-guard-mode-on-the-unfixed-shop).

![Guard mode: the stale write reverted, with Undo](out/23-shop-guard-overlay-interventions.png)

**2. A race found, proven, fixed, and proven fixed.** The coding agent's explore runs the same search with the
responses in other orders and finds the race under two of three; replay reproduces it on demand; the agent fixes the
code; the same replay no longer reproduces it, and explore finds nothing. [Steps 7 to 9](#step-7-explore-the-same-search-with-the-responses-in-other-orders).

![Replay: reproduced, then not reproduced](out/35-agent-replay-result-after-fix.png)

**3. The closed loop on the dashboard.** Everything the agent did is mirrored to the shop's dashboard: found, evidence
read, test written, replay reproduced, replay not reproduced, with the stages found · reproduced · fix proven · closed.
[Step 11](#step-11-the-dashboard-at-the-end).

![The closed loop](out/43-dashboard-closed-loop.png)

**4. Twelve visual faults reported with their CSS fixes, from one command**, before anything is installed, and again
from inside the agent. [Step 1](#step-1-a-scan-with-nothing-installed).

## Run it yourself

From the repository root:

```bash
bash docs/evidence/e2e-walkthrough/run.sh
```

Needs Node 20 or later, Playwright's Chromium (`npx playwright install chromium`), the network (npm, jsDelivr for the
model, genclass.dev for the dashboard: a new project is created on every run), ffmpeg for the GIF, and ports 5173,
8788 and 47400 free. `walkthrough.mjs` is the script, `run.log` the console output of the last run, `out/summary.json`
its numbers. About seven minutes. The only departure from a single-server setup: this machine already runs a GenClass
MCP server on the default port, so the demo's server and the app's `connectAgent` use port 47400; a user with one
server sets no port.

---

## Step 0. The shop, before GenClass

What the user has: a Vite project with one dev dependency and plain `fetch` calls.

![The project before](out/01-tree.png)

What the user sees: the page, and what typing "react" quickly shows: results for "r", because the API answers a
one-letter query slowly and the last response to arrive wins.

![The shop before](out/02-shop-before.png)

![The stale search before](out/03-shop-before-stale-search.png)

## Step 1. A scan, with nothing installed

```
npx @genclass/runtime@beta scan http://localhost:5173
```

The first thing a newcomer can run, before touching the project: the page is loaded in headless Chromium at desktop
and phone sizes with the measured visual checks. **Visual score 8/100, 10 problems (6 high, 3 medium, 1 low)**, each
with its element, the measurement and a suggested CSS fix.

![The scan before any integration](out/04-scan.png)

## Step 2. One command: `npx @genclass/runtime@beta init --yes`

`init` finds "Vite + vanilla" and the entry file, explains telemetry, shows the diff, installs the runtime, creates
the project at genclass.dev and prints the private dashboard link, saved to `.genclass.local`.

![init](out/05-init.png)

What it wrote: two imports at the top of `src/main.js`, one dev-only line at the bottom for the devtools overlay, and
`src/genclass.config.js` with the project key.

![What init wrote](out/06-init-diff.png)

What the user sees when they open the link: the dashboard in its onboarding state, "Waiting for the first event",
with the four things to do next.

![The dashboard right after init](out/07-dashboard-fresh-no-data.png)

And the shop with the runtime in it: the overlay at the bottom right, and, in the browser console, the measured checks
reporting with no code of the user's: the `{{price}}` leak, the lorem ipsum, the 1.26:1 banner, the covered dialog,
the broken logo, each with the measurement, the threshold and a fix.

![The shop with the runtime](out/08-shop-with-runtime-and-overlay.png)

![The browser console](out/09-browser-console.png)

## Step 3. A few lines more: the shop's state, the agent link, telemetry from localhost

The user makes the search state a GenClass atom (the one line from the README's "State it can protect"), wraps the
other keys of the shop's store, adds the agent link for development builds, and sets `telemetry: true` because the
demo runs on localhost, which never sends by default.

![The state, the agent link, telemetry on](out/10-wire-diff.png)

A few seconds later the dashboard has gone from "Waiting" to "Live", with its first page loads.

![The dashboard with its first events](out/11-dashboard-first-events.png)

## Step 4. The coding agent

```
npx -y @genclass/mcp@0.2.0 init
```

writes the project's `.mcp.json` and prints the setup steps. The agent's client then starts the server with the
dashboard link (`GENCLASS_DASHBOARD`) and `GENCLASS_REPORT=on`, so what the agent does is mirrored to the dashboard.

![The MCP server in the project](out/12-mcp-init.png)

![genclass_setup](out/13-agent-setup.png)

![genclass_status, no page yet](out/14-agent-status-nopage.png)

## Step 5. The user uses the shop; the agent asks what happened

Four page loads, each one thing the user does: the fast search, the double click on Add to cart, checkout plus
reviews plus three subscribes, the profile button.

![The stale search, recorded](out/15-shop-stale-search.png)

![The shop in use](out/16-shop-used.png)

`genclass_status`: "1 active page(s), 4 recorded run(s)". `genclass_findings`, most important first: the response to
"GET /api/search?q=r" overwrote `search.query` and `search.results` after a newer response had already written them
(two stale-write findings, from the runtime's own facts); the TypeError in the profile handler; `POST /api/cart` sent
twice, 0 ms apart; the model's "transient" at the newsletter's 503 and "duplicate" at the cart request; nine measured
checks.

![genclass_status](out/17-agent-status.png)

![genclass_findings](out/18-agent-findings.png)

## Step 6. A hot fix today: guard mode on the unfixed shop

Before any code changes, one line in `genclass.config.js`: `mode: "guard"`, with `visual: { on: true, fix: true }`.
Guard acts only when the model is sure, with minimal, reversible actions; the visual fixes apply the measured checks'
CSS and undo themselves if they did not help.

![Guard mode and the visual fixes](out/19-guard-config.png)

The page reloads. The banner is readable (the console: "Applied a CSS fix for check c6: div.banner { color: rgb(6, 6,
6); }", with its Undo).

![The banner fixed at run time](out/20-shop-guard-banner-fixed.png)

The user types "react" fast again. The slow response to "r" lands last, as before, and this time GenClass reverts its
write 0.10 s after it applies: the console says "Reverted a stale write … search.query is back to "react";
search.results is back to 2 items", the page ends on the two right results, and the overlay badge counts one
intervention.

![The search corrected in guard mode](out/21-shop-guard-search-corrected.png)

![The console in guard mode](out/22-browser-console-guard.png)

The overlay's Interventions tab: the action, its confidence (stale 99%, discard, guard), what changed, and an Undo
button. The same console also shows the one it did not take: the duplicate cart request is flagged at 94% but
coalescing a POST scores a gain of 2.41 against the guard margin of 4, so it is left alone; GenClass acts only when
the expected gain clears the bar.

![The overlay: Reverted a stale write, with Undo](out/23-shop-guard-overlay-interventions.png)

The dashboard a few seconds later: "It stepped in 1 time, and nothing it changed was undone", Stopped by GenClass 1.

![The dashboard: stepped in](out/24-dashboard-stepped-in.png)

Then back to observe for the investigation below, since guard would fix the race before explore could see it.

![Back to observe](out/25-observe-config.png)

## Step 7. Explore: the same search with the responses in other orders

`genclass_explore` arms five page loads (two baselines in request order, three seeded orders); the browser types
"react" on each. **RACE: 2 of 3 reordered runs ended in a different state than the baseline.** Race finding f22, on
top of the runtime's own stale-write findings.

![genclass_explore start](out/26-agent-explore-start-before-fix.png)

![genclass_explore report: a race](out/27-agent-explore-report-before-fix.png)

## Step 8. Explain and replay: reproduced

`genclass_explain f10`: the evidence, every request, delivery and state write of the failing run in causal order, the
delivery order, how to reproduce it, and a Playwright regression test (saved as `tests/f10.spec.ts`).

![genclass_explain](out/28-agent-explain.png)

`genclass_replay arm` gives the next page load that order; the browser loads the page and types the same word;
**"REPRODUCED · the same fact was recorded again under the replayed order."**

![genclass_replay arm](out/29-agent-replay-arm.png)

![The shop under the replayed order](out/30-shop-replay-reproduced.png)

![genclass_replay result: reproduced](out/31-agent-replay-result-before-fix.png)

## Step 9. The fix, then the proof

The agent edits the code: a sequence number per search request, so an older response that arrives later is ignored;
the Add to cart button disabled while its request is in flight; a guard on the profile's missing address.

![The fix](out/32-fix-diff.png)

The same replay again: **"not reproduced · not recorded under the replayed order. The recorded order no longer
produces it: the fix holds for this schedule."** Explore once more, five loads: **"No race found."**

![genclass_replay arm after the fix](out/33-agent-replay-arm-after-fix.png)

![The shop after the fix, same order](out/34-shop-after-fix.png)

![genclass_replay result: not reproduced](out/35-agent-replay-result-after-fix.png)

![genclass_explore after the fix](out/36-agent-explore-start-after-fix.png)

![genclass_explore report: no race](out/37-agent-explore-report-after-fix.png)

![genclass_findings after the fix](out/38-agent-findings-after-fix.png)

## Step 10. The scan from the agent, and the production numbers

`genclass_scan {url}`: the same 10 visual problems with their fixes, from inside the agent, as JSON too.
`genclass_analytics {source: "production"}` reads the shop's dashboard through the private link: 20 page loads, 16
detections (stale on /: 14, duplicate 1, transient 1), 1 acted, the latest decisions.

![genclass_scan](out/39-agent-scan.png)

![genclass_analytics production](out/40-agent-analytics-production.png)

## Step 11. The dashboard at the end

![Overview](out/41-dashboard-overview.png)

![Problems](out/42-dashboard-problems.png)

The Closed loop view: the stages for this session, **found 24 · reproduced 1 · fix proven 1 · closed 1**, and the
agent's log: found ×24, explore (1 race found), evidence read, test written, replay armed, replay reproduced, replay
armed, replay not reproduced ("the fix holds"), explore (0 races found).

![The closed loop](out/43-dashboard-closed-loop.png)

![The agent's log](out/45-dashboard-closed-loop-log.png)

![MCP](out/44-dashboard-mcp.png)

## The recording

![The browser session](out/walkthrough.gif)

`out/walkthrough.webm` is the full recording: the shop before, the stale search, the dashboard waiting and then live,
the user's session, guard mode's hot fix, the replays, the explores, then the dashboard's views.

## Notes for whoever changes the demo

- **The search state must be a GenClass atom (or write through `rt.guard`'s handle).** An earlier version wrapped the
  shop's store with `rt.guard` but kept writing through the store's own `set`, so GenClass saw the writes but could not
  attribute or drop them, and guard mode had nothing to act on. The README's "State it can protect" says as much; the
  demo now does what it says.
- **Only the one-letter query is slow** (1200 ms; 200 ms for the rest), so exactly one stale response lands last. With
  two slow queries the model was 99% sure about one and 57% about the other, and the page ended on the half-fixed one.
- **No `aria-live` on the results list.** 0.3.0-beta.2 reports live-region text as announcements (toasts that expire),
  which explore keeps apart from what the page shows, so a results list marked live hides the race from it. A real app
  that announces results that way would see the same.
- **Page loads wait for DOM-ready with a retry**: Vite reloads once when it first optimizes a newly imported package.
- The first runs of this walkthrough found two bugs in `@genclass/mcp`, fixed with tests before 0.2.0 shipped: the
  dashboard mirror only ever sent "found", and a race replay could never say "not reproduced" on a page that always
  shows a line the failing run showed once more.

Not shown here: the generated regression test being run (it needs `@playwright/test` in the shop and
`GENCLASS_APP_URL`); the duplicate-request fix proven by replay (disabling the button changes the user's recorded
actions, so that replay reports "steps differed", which is correct: the second click no longer sends); and the visual
faults being fixed in CSS (the scan lists each with its fix).
