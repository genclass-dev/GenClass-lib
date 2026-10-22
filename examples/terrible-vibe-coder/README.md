# The Terrible Vibe Coder

A shop an AI wrote in four minutes (VibeShop). On fast Wi-Fi it works every time. On a phone on a train it shows
search results for an older query, charges twice when you double-click Buy, and puts back note text you already
replaced. Each of these is a race: the code assumes the network answers in the order it asked.

The page shows three things:

1. **Break it.** Switch the network to *Phone on a train* and press *Let an impatient user try it*. The panel on the
   right checks the shop from the outside (what the page shows, what the server charged) and says what went wrong.
2. **GenClass, eager.** Switch GenClass to *Eager* (guard mode, the most willing profile). The on-device model steps
   in only when it is sure a response would undo newer data or repeat a purchase, and the panel lists each time it
   did. It is a safety net: it does not catch every race, and it never changes a correct page (see the numbers).
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

Results: see "Measured" in the pull request that added this demo, and `docs/runtime/RESULTS.md` §17.
