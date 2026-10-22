# The Terrible Vibe Coder

A shop an AI wrote in four minutes (VibeShop). On fast Wi-Fi it works every time. On a phone on a train it shows
search results for an older query, charges twice when you double-click Buy, and puts back note text you already
replaced. Each of these is a race: the code assumes the network answers in the order it asked.

The page shows three things:

1. **Break it.** Switch the network to *Phone on a train* and press *Let an impatient user try it*. The panel on the
   right checks the shop from the outside (what the page shows, what the server charged) and says what went wrong.
2. **GenClass, eager.** Switch GenClass to *Eager* (guard mode, the most willing profile). The on-device model steps
   in only when it is sure a response would undo newer data or repeat a purchase, and the panel lists each time it
   did. On this shop it notices the races (about two detections a visit) but is never sure enough to act, and it never changed the correct page (see the numbers).
3. **Claude fixes the code.** With GenClass on and the [MCP server](../../packages/mcp) running, Claude Code sees
   every click, request and answer and the order they arrived in, replays the exact order that broke the shop,
   fixes `public/shop.js`, replays again to show the bug is gone, and writes a Playwright test for it.
   `public/shop-fixed.js` is one careful fix (*Code: Fixed*).

## Run it

```bash
node examples/terrible-vibe-coder/server.mjs    # http://localhost:4545, no dependencies
```

GenClass comes from jsDelivr (`@genclass/runtime@0.3.0-beta.1`); `GENCLASS_LOCAL=1` serves `packages/runtime/dist`
instead (after `npm run build -w @genclass/runtime`). URL switches: `?gc=off|watch|eager`, `?code=buggy|fixed`,
`?claude=0`.

Then, for step 3:

```bash
claude mcp add genclass -- npx -y @genclass/mcp
cd examples/terrible-vibe-coder && claude
```

and ask: *"On a slow network my shop at localhost:4545 shows old search results, charges twice and loses note text.
Use GenClass to find out why, fix public/shop.js and prove the fix."* Reload the page once Claude Code is running.

The hosted copy (`worker.js`, `./deploy.sh`) is the same page on Cloudflare, with a network switch per visitor. Claude
connects only to the copy on your own machine: GenClass's agent link never runs on a public host.

## Measured

`node examples/terrible-vibe-coder/trials.mjs --seeds 10` runs the same impatient visit (the page's own robot) many
times per configuration in headless Chromium and prints the table below. "Stepped in" on the fixed code and on the
fast network are false interventions: the page was correct, so any action there would be one too many.

2026-10-22, train VM, headless Chromium, runtime 0.3.0-beta.1 built from this branch, model 0.2.0 from jsDelivr
(ready before every visit), 6 visits per row:

| | visits that broke | old search | double charge | lost typing | GenClass stepped in | detections |
|---|---|---|---|---|---|---|
| GenClass off, vibe-coded | 6 / 6 | 4 | 6 | 4 | 0 | – |
| GenClass watching, vibe-coded | 6 / 6 | 4 | 6 | 4 | 0 | 11 |
| GenClass eager, vibe-coded | 6 / 6 | 4 | 6 | 4 | 0 | 10 |
| GenClass off, fixed | 0 / 6 | 0 | 0 | 0 | 0 | – |
| GenClass eager, fixed | 0 / 6 | 0 | 0 | 0 | **0** (no false interventions) | 0 |
| GenClass eager, vibe-coded, fast network | 6 / 6 | 0 | 6 | 0 | 0 | 6 |

What this says: on this shop, GenClass on its own, even eager, prevents none of the three bugs. It notices them
(about two detections per visit, none on the fixed code) and it never touched the correct page. The bugs go away when
the code is fixed, which is the step Claude does with GenClass's record. Watching changes nothing by design (same
rows as off). On a fast network the double-click still charges twice: two clicks 90 ms apart are two orders when each
answer takes 40 ms, so that one is a bug on any network.
