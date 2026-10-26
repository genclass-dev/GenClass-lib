# Evidence: onboarding a new project onto GenClass, step by step

A new project, "Tiny Shop", a Vite site with a tiny Node API, written with the problems a rushed Friday leaves
behind: a search that shows results for the wrong query when responses arrive out of order, a double click that adds
to the cart twice, a checkout that always fails, a slow endpoint, a click handler that throws, a newsletter that fails
every third time, and a page full of visual faults (no viewport meta, a broken logo, a broken web font, a missing
stylesheet, an unreadable banner in mojibake, an unrendered `{{price}}`, lorem ipsum, an undefined CSS variable, a
distorted image, a strip wider than the screen, a button off screen, a promo overlay over the checkout button and a
cookie dialog under a cover). The app is in [`app/`](app/) as a user would have it, with no GenClass.

Then GenClass is added the way the docs tell a newcomer to, one step at a time, with the **published packages only**
(`@genclass/runtime@beta`, 0.3.0-beta.2, and `@genclass/mcp@0.2.0`), a **real project at genclass.dev** (created by
`init`) and the published MCP server, driven by a browser playing the user and a small MCP client playing the coding
agent. Every step below shows what the user types (a terminal screenshot) and what the user sees (the page or the
dashboard). The whole browser session is also a video, `out/walkthrough.webm` (4 min) and `out/walkthrough.gif`.

**About the terminal screenshots.** They are rendered from the captured output: the same text, verbatim, in a terminal
window drawn by Chromium (`lib/term.mjs`), because the macOS Terminal cannot be driven from this session and a
rendering keeps every character readable. Each has a plain-text twin, `out/NN-*.txt`. The dashboard's private link is
redacted in both; the project key visible on the dashboard screenshots is the app's public token, which can only add
telemetry to this app.

## Run it yourself

From the repository root:

```bash
bash docs/evidence/e2e-walkthrough/run.sh
```

Needs Node 20 or later, Playwright's Chromium (`npx playwright install chromium`), the network (npm, jsDelivr for the
model, genclass.dev for the dashboard: a new project is created on every run), ffmpeg for the GIF, and ports 5173,
8788 and 47400 free. `walkthrough.mjs` is the script, `run.log` the console output of the last run, `out/summary.json`
its numbers. About six minutes. The only departure from a single-server setup: this machine already runs a GenClass
MCP server on the default port, so the demo's server and the app's `connectAgent` use port 47400; a user with one
server sets no port.

---

## Step 0. The shop, before GenClass

What the user has: a Vite project with one dev dependency and plain `fetch` calls.

![The project before](out/01-tree.png)

What the user sees: the page, and what typing "react" quickly shows: six results, for the query "re", because the
API answers short queries slowly and the last response to arrive wins.

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
with the four things to do next (add the key, load a page, connect a coding agent, turn on analytics).

![The dashboard right after init](out/07-dashboard-fresh-no-data.png)

And the shop with the runtime in it: the overlay at the bottom right, and, in the browser console, the measured checks
reporting with no code of the user's: the `{{price}}` leak, the lorem ipsum, the 1.26:1 banner, the covered dialog,
the broken logo, each with the measurement, the threshold and a fix (10 lines on this load).

![The shop with the runtime](out/08-shop-with-runtime-and-overlay.png)

![The browser console](out/09-browser-console.png)

## Step 3. Three lines more: the shop's state, the agent link, telemetry from localhost

The user wires the store so GenClass sees every write with its cause, adds the agent link for development builds,
and sets `telemetry: true` because the demo runs on localhost, which never sends by default.

![The state, the agent link, telemetry on](out/10-wire-diff.png)

What the user sees a few seconds later: the dashboard has gone from "Waiting" to "Live", with its first page loads
and the model loaded on the device.

![The dashboard with its first events](out/11-dashboard-first-events.png)

## Step 4. The coding agent

```
npx -y @genclass/mcp@0.2.0 init
```

writes the project's `.mcp.json` and prints the setup steps. The agent's client then starts the server with the
dashboard link (`GENCLASS_DASHBOARD`) and `GENCLASS_REPORT=on`, so what the agent does is mirrored to the dashboard.

![The MCP server in the project](out/12-mcp-init.png)

The agent's first two calls: `genclass_setup` (the lines a dev build needs) and `genclass_status` before any page has
connected.

![genclass_setup](out/13-agent-setup.png)

![genclass_status, no page yet](out/14-agent-status-nopage.png)

## Step 5. The user uses the shop; the agent asks what happened

Four page loads, each one thing the user does: the fast search, the double click on Add to cart, checkout plus
reviews plus three subscribes, the profile button.

![The stale search, recorded](out/15-shop-stale-search.png)

![The shop in use](out/16-shop-used.png)

`genclass_status` now: "1 active page(s), 4 recorded run(s) · Findings: 9 check, 2 detection, 1 duplicate-request,
1 error".

![genclass_status](out/17-agent-status.png)

`genclass_findings`, most important first: the TypeError in the profile handler; `POST /api/cart` sent twice, 1 ms
apart, by two user actions while the first was in flight; the model's "transient" (98%) at the newsletter's 503 and
"duplicate" (95%) at the cart request; and nine measured checks.

![genclass_findings](out/18-agent-findings.png)

## Step 6. Explore: the same search with the responses in other orders

`genclass_explore` arms five page loads (two baselines in request order, three seeded orders); the browser types
"react" on each. The report: **RACE: 2 of 3 reordered runs ended in a different state than the baseline**: under seed
2 the page shows "Reading lamp" and "Real wood desk" and the query is "rea"; under seed 3, eight results for "r".
**Race finding f14.**

![genclass_explore start](out/19-agent-explore-start-before-fix.png)

![genclass_explore report: a race](out/20-agent-explore-report-before-fix.png)

## Step 7. Explain and replay: reproduced

`genclass_explain f14`: which fields and text differed, every request, delivery and state write of the failing run
in causal order, the delivery order, how to reproduce it, and a Playwright regression test (saved as
`tests/f14.spec.ts`).

![genclass_explain](out/21-agent-explain.png)

`genclass_replay arm` gives the next page load that order (schedule: seeded 2); the browser loads the page and types
the same word; the result: **"REPRODUCED · the page shows the failing run's text again. The bug is still there under
the recorded order."**

![genclass_replay arm](out/22-agent-replay-arm.png)

![The shop under the replayed order](out/23-shop-replay-reproduced.png)

![genclass_replay result: reproduced](out/24-agent-replay-result-before-fix.png)

## Step 8. The fix, then the proof

The agent edits the code: a sequence number per search request, so an older response that arrives later is ignored;
the Add to cart button disabled while its request is in flight; a guard on the profile's missing address.

![The fix](out/25-fix-diff.png)

The same replay again: **"not reproduced · the page shows the baseline's text. The recorded order no longer produces
it: the fix holds for this schedule."**

![genclass_replay arm after the fix](out/26-agent-replay-arm-after-fix.png)

![The shop after the fix, same order](out/27-shop-after-fix.png)

![genclass_replay result: not reproduced](out/28-agent-replay-result-after-fix.png)

Explore once more, five loads: **"No race found."** And the findings list shows f14 with "last replay: not
reproduced"; the double click after the fix adds one item.

![genclass_explore after the fix](out/29-agent-explore-start-after-fix.png)

![genclass_explore report: no race](out/30-agent-explore-report-after-fix.png)

![genclass_findings after the fix](out/31-agent-findings-after-fix.png)

## Step 9. The scan from the agent, and the production numbers

`genclass_scan {url}`: the same 10 visual problems with their fixes, from inside the agent, as JSON too.

![genclass_scan](out/32-agent-scan.png)

`genclass_analytics {source: "production"}` reads the shop's dashboard through the private link: 21 page loads,
detections by diagnosis and page, the latest decisions, with the pointer to `genclass_explore {route, focus}`.

![genclass_analytics production](out/33-agent-analytics-production.png)

## Step 10. The dashboard at the end

The dashboard the user got in step 2, filled by the page's telemetry and the agent's mirror.

![Overview](out/34-dashboard-overview.png)

![Problems](out/35-dashboard-problems.png)

The Closed loop view: its stages for this session, **found 15 · reproduced 1 · fix proven 1 · closed 1**, and the
agent's log: found ×15, explore (1 race found), evidence read, test written, replay armed, replay reproduced, replay
armed, replay not reproduced ("the fix holds"), explore (0 races found).

![The closed loop](out/36-dashboard-closed-loop.png)

![The agent's log](out/38-dashboard-closed-loop-log.png)

The MCP page, with the setup per coding agent and the agent link:

![MCP](out/37-dashboard-mcp.png)

## The recording

![The browser session](out/walkthrough.gif)

`out/walkthrough.webm` is the full recording: the shop before, the stale search, the dashboard waiting and then live,
the user's session, the replays, the explores, then the dashboard's views.

## What building this found in GenClass

The first runs of this walkthrough found two bugs in `@genclass/mcp`, both fixed with tests before 0.2.0 shipped: the
dashboard mirror only ever sent "found" (the tools' in-process calls bypassed the reporting wrapper), and a race
replay could never say "not reproduced" on a page that always shows a line the failing run showed once more (the
verdict checked presence where explore had counted). They also showed that the packages then on npm predated the
mirror and the scan, which is why 0.3.0-beta.2 and 0.2.0 were released; this run uses those published packages only.

One thing about the demo itself: an earlier version gave the results list `aria-live="polite"`, and 0.3.0-beta.2
reports live-region text as announcements (toasts that expire), which explore keeps out of what the page "shows".
A results list is not a status region, so the attribute went; a real app that announces results that way would see
the same.

Not shown here: the generated regression test being run (it needs `@playwright/test` in the shop and
`GENCLASS_APP_URL`); the duplicate-request fix proven by replay (disabling the button changes the user's recorded
actions, so that replay reports "steps differed", which is correct: the second click no longer sends); and the
visual faults being fixed (the scan lists each with its CSS).
