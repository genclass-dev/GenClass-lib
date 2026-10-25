# Evidence: GenClass end to end, from a broken little shop to a closed loop

A new project, "Tiny Shop", a Vite site with a tiny Node API, written with the problems a rushed Friday leaves
behind: a search that shows results for the wrong query when responses arrive out of order, a double click that adds
to the cart twice, a checkout that always fails, a slow endpoint, a click handler that throws, a newsletter that fails
every third time, and a page full of visual faults (no viewport meta, a broken logo, a broken web font, a missing
stylesheet, an unreadable banner in mojibake, an unrendered `{{price}}`, lorem ipsum, an undefined CSS variable, a
distorted image, a strip wider than the screen, a button off screen, a promo overlay over the checkout button and a
cookie dialog under a cover). The app is in [`app/`](app/) exactly as a user would have it, with no GenClass.

Then GenClass is added the way the docs say, one step at a time, with the **published** `@genclass/runtime@beta`
(0.3.0-beta.1), the **real** genclass.dev dashboard (a project is created for the shop) and the MCP server, driven
by a browser playing the user and a small MCP client playing the coding agent. Every command's output is kept as a
transcript (`out/NN-*.txt`) and as a terminal screenshot (`out/NN-*.png`), every page state as a screenshot, and the
browser session as a video, `out/walkthrough.webm` (3 min 33 s) and `out/walkthrough.gif`.

**Terminal screenshots** are rendered from the captured output: the same text, in a terminal window, by Chromium
(`lib/term.mjs`). The macOS Terminal cannot be driven from this session, and a rendering keeps every character
readable. The dashboard's private link and the app's token are redacted in both the images and the transcripts.

## Run it

From the repository root:

```bash
bash docs/evidence/e2e-walkthrough/run.sh
```

It needs Node 20 or later, Playwright's Chromium (`npx playwright install chromium`), the network (npm, jsDelivr for
the model, genclass.dev for the dashboard; a new project is created at genclass.dev on every run), ffmpeg for the GIF,
and ports 5173, 8788 and 47400 free. `walkthrough.mjs` is the script; `run.log` is the console output of the last
run and `out/summary.json` its numbers. It takes about 6 minutes, most of it the page's model loading, the explore
page loads and the scans.

Two things are run from this repository rather than from npm, and the transcripts say so where it happens: the
page scan, because the `scan` command is newer than the published 0.3.0-beta.1 CLI, and the MCP server process,
because the `@genclass/mcp` 0.1.0 on npm predates the dashboard mirror (`GENCLASS_REPORT`) and `genclass_scan`,
both in this repository's unreleased 0.1.0. The MCP server's `init` is the published one. See
[What this run found](#what-this-run-found-in-genclass-itself).

## The steps, as the user does them

### 0. The shop, before

[`01-tree`](out/01-tree.png): the project (`package.json` has one dev dependency, Vite; `src/main.js` is plain
fetch calls). [`02-shop-before`](out/02-shop-before.png) is the page; [`03-shop-before-stale-search`](out/03-shop-before-stale-search.png)
is what typing "react" quickly shows: six results, for the query "re", because the API answers short queries
slowly and the last response to arrive wins.

![The shop before](out/02-shop-before.png)

### 1. A scan, with nothing installed

```
node ../../../../packages/runtime/bin/genclass-runtime.mjs scan http://localhost:5173
```

[`04-scan`](out/04-scan.png): the page is loaded in headless Chromium at desktop and phone sizes with the measured
visual checks; **visual score 8/100, 10 problems (6 high, 3 medium, 1 low)**, each with its element, the measurement
and a suggested fix (the `scan` command is run from this repository; see above).

![The scan](out/04-scan.png)

### 2. One command: `npx @genclass/runtime@beta init --yes`

[`05-init`](out/05-init.png): `init` finds "Vite + vanilla" and the entry file, explains telemetry, shows the diff,
installs `@genclass/runtime@^0.3.0-beta.1`, **creates the project at genclass.dev** and prints the private
dashboard link, saved to `.genclass.local` (added to `.gitignore`). [`06-init-diff`](out/06-init-diff.png) is what it
wrote: two lines at the top of `src/main.js` (`import "./genclass.config"` and
`import genclass from "@genclass/runtime/auto"`), one dev-only line at the bottom (the devtools overlay), and
`src/genclass.config.js` with the token.

![init](out/05-init.png)

[`07-shop-with-runtime-and-overlay`](out/07-shop-with-runtime-and-overlay.png): the page with the overlay at the
bottom right. [`08-browser-console`](out/08-browser-console.png): with no code of the user's, the measured checks
report in the console: the `{{price}}` leak, the lorem ipsum, the 1.26:1 banner, the covered dialog, the broken logo,
each with the measurement, the threshold and a fix (10 `[GenClass]` lines on this load).

### 3. Three lines more

[`09-wire-diff`](out/09-wire-diff.png): the user wires the shop's state and the agent link, following what
`genclass_setup` prints (step 4):

```js
import { connectAgent } from "@genclass/runtime/agent";
// GenClass watches the shop's state: every write to a key is recorded with the response or click that caused it.
for (const k of store.keys()) genclass.guard(k, { get: () => store.get(k), set: (v) => store.set(k, v), subscribe: (fn) => store.subscribe(k, () => fn()) });
if (import.meta.env.DEV) connectAgent(genclass, { url: "http://127.0.0.1:47400" });
```

and sets `telemetry: true` in `genclass.config.js`, because the demo runs on localhost, which never sends by
default. The port is set only because another GenClass MCP server already owns the default one on this machine
(`GENCLASS_AGENT_PORT` on the server side matches); a user with one server needs no port.

### 4. The coding agent

[`10-mcp-init`](out/10-mcp-init.png): `npx -y @genclass/mcp@0.1.0 init` writes `.mcp.json` and prints the three
setup steps. The agent's client then starts the server with `GENCLASS_DASHBOARD` (the private link) and
`GENCLASS_REPORT=on`, so the loop is mirrored to the dashboard. [`11-agent-setup`](out/11-agent-setup.png) is
`genclass_setup`; [`12-agent-status-nopage`](out/12-agent-status-nopage.png) is `genclass_status` before any page
connected: "0 active page(s)… see genclass_setup".

### 5. The user uses the shop; the agent asks what happened

Four page loads, each one thing the user does: the fast search, the double click on Add to cart, checkout plus
reviews plus three subscribes, the profile button ([`13`](out/13-shop-stale-search.png), [`14`](out/14-shop-used.png)).
[`15-agent-status`](out/15-agent-status.png): "1 active page(s), 4 recorded run(s) · Findings: 9 check, 2 detection,
1 duplicate-request, 1 error". [`16-agent-findings`](out/16-agent-findings.png), most important first:

- `f13 [error]` Uncaught "TypeError: Cannot read properties of undefined (reading 'city')"
- `f10 [duplicate-request]` "POST /api/cart" was sent twice, 1 ms apart, by two separate user actions while the first was in flight
- `f11 [detection]` the on-device model diagnosed "transient" (98%) at the failure of POST /api/newsletter (HTTP 503)
- `f9 [detection]` the on-device model diagnosed "duplicate" (95%) at the request of POST /api/cart
- nine `[check]` findings: image-broken, font-failed, page-overflow-x, text-encoding, text-template-leak, text-placeholder, text-invisible, dialog-covered, control-unreachable

![The findings](out/16-agent-findings.png)

### 6. Explore: the same search, responses in other orders

[`17`](out/17-agent-explore-start-before-fix.png), [`18-agent-explore-report-before-fix`](out/18-agent-explore-report-before-fix.png):
`genclass_explore` arms five page loads (two baselines in request order, three seeded orders); the browser types
"react" on each. The report: **RACE: 2 of 3 reordered runs ended in a different state than the baseline**: under
seed 2 the page shows "Reading lamp" and "Real wood desk" and `search.query` is "rea"; under seed 3 it shows eight
results for "r". One run differed in internal state only and is listed apart, not as a race. **Race finding f14.**

### 7. Explain and replay: reproduced

[`19-agent-explain`](out/19-agent-explain.png): the evidence (which fields differed, which text only the failing run
showed), the run's steps with every request, delivery and state write in causal order, the delivery order
(`#5 → #2 → #1 → #4 → #3`), how to reproduce it, and a Playwright regression test, saved as `tests/f14.spec.ts`.
[`20`](out/20-agent-replay-arm.png) arms the replay (schedule: seeded 2); the browser loads the page and types the
same word; [`22-agent-replay-result-before-fix`](out/22-agent-replay-result-before-fix.png): **"r10: REPRODUCED ·
the page shows the failing run's text again. The bug is still there under the recorded order."**

![Explain](out/19-agent-explain.png)

### 8. The fix, then the proof

[`23-fix-diff`](out/23-fix-diff.png): a sequence number per search request, so an older response that arrives later
is ignored; the Add to cart button disabled while its request is in flight; a guard on the profile's missing address.
[`26-agent-replay-result-after-fix`](out/26-agent-replay-result-after-fix.png): **"r13: not reproduced · the page
shows the baseline's text. The recorded order no longer produces it: the fix holds for this schedule."**
[`28-agent-explore-report-after-fix`](out/28-agent-explore-report-after-fix.png): explore again, five loads: **"No race
found: none of the 3 compared reordered runs ended with a different page, form values, writes or errors than the
baseline."** [`29-agent-findings-after-fix`](out/29-agent-findings-after-fix.png) lists f14 with "last replay: not
reproduced", and the double click after the fix adds one item (`cartAfterFix` in `summary.json`).

![The fix](out/23-fix-diff.png)

### 9. The scan from the agent, and the production numbers

[`30-agent-scan`](out/30-agent-scan.png): `genclass_scan {url}` from the agent: the same 10 problems with their
fixes, as JSON too. [`31-agent-analytics-production`](out/31-agent-analytics-production.png):
`genclass_analytics {source: "production"}` reads the shop's dashboard through the private link: 22 page loads,
detections by diagnosis and page (duplicate on /, transient on /), the latest decisions, with the pointer to
`genclass_explore {route, focus}`.

### 10. The dashboard

The dashboard the user got in step 2, filled by the page's telemetry (`telemetry: true`) and the agent's mirror:
[`32-dashboard-overview`](out/32-dashboard-overview.png), [`33-dashboard-problems`](out/33-dashboard-problems.png),
[`35-dashboard-mcp`](out/35-dashboard-mcp.png), and the Closed loop view, [`34-dashboard-closed-loop`](out/34-dashboard-closed-loop.png)
with its stages for this session, **found 15 · reproduced 1 · fix proven 1 · closed 1**, and the agent's log
[`36-dashboard-closed-loop-log`](out/36-dashboard-closed-loop-log.png): found ×15, explore (1 race found), evidence
read, test written, replay armed, replay reproduced, replay armed, replay not reproduced ("the fix holds"), explore
(0 races found).

![The closed loop on the dashboard](out/34-dashboard-closed-loop.png)

![The agent's log on the dashboard](out/36-dashboard-closed-loop-log.png)

## The recording

![The browser session](out/walkthrough.gif)

`out/walkthrough.webm` is the full recording: the shop before, the stale search, the page with the runtime, the
user's session, the replays, the explores, then the dashboard's views.

## What this run found in GenClass itself

The walkthrough is the first time the whole loop ran on the published packages against the real dashboard, and it
found three things, two of them fixed in this change (`packages/mcp`, with tests):

1. **The dashboard mirror only ever sent "found".** `serve()` wrapped the API with the reporter for the bridge's HTTP
   path but gave the tools' own in-process calls a fresh, unwrapped API, so explain, tests, replays and explores never
   reached the dashboard. Fixed in `src/server.ts` (`test/mcp.test.ts`, "GENCLASS_REPORT mirrors the tools' own calls").
2. **A race replay could never say "not reproduced" on this page.** Explore compares page text as counts ("Reading
   lamp" once on the product card, twice when a stale result shows it too), but the replay verdict checked presence
   only, so the product card alone made every replay "reproduced", after the fix too. The finding's evidence now keeps
   the counts and the verdict needs the line as many times as the failing run showed it (`src/compare.ts`,
   `src/store.ts`; `test/store.test.ts`, "a race replay counts page lines").
3. **npm is behind the repository.** `@genclass/mcp@0.1.0` on npm has eight tools, no `genclass_scan` and no
   `GENCLASS_REPORT`; the published runtime CLI has no `scan`. Both are in the repository under the same version
   numbers. Until a release, a user who follows the docs gets the loop without the dashboard mirror and without the
   scan tool; the walkthrough runs those two from the repository and says so.

Not shown here: the generated regression test being run (it needs `@playwright/test` in the shop and
`GENCLASS_APP_URL`); the duplicate-request fix proven by replay (disabling the button changes the user's recorded
actions, so that replay reports "steps differed", which is correct; the second click simply no longer sends); and
the visual faults being fixed (the scan lists each with its CSS).
