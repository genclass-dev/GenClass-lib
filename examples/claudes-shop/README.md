# Claude's Shop

A small shop with the bugs real shops ship, and the same page with GenClass on it:

- `/` is the shop as it is. In dark mode the product cards keep a white background while their text turns light, so
  names and prices disappear. The welcome offer forgets to release the page's scroll lock when it closes, so the page
  stops scrolling. On a slow network the search shows results for an older query, a double click on *Place order*
  places two orders, and the delivery note puts back text you already replaced.
- `/genclass-on` is the same page with GenClass (`@genclass/runtime` 0.3.0-beta.1: guard mode at the eager profile,
  the measured visual checks with their runtime fixes, telemetry to the project's dashboard). GenClass makes the dark
  text readable again and releases the stuck scroll lock on the visitor's first scroll, and lists what it found and
  fixed in a small panel.

Hosted: https://claudes-shop.mehar-144.workers.dev (`worker.js`, `wrangler.toml`, `./deploy.sh path/to/runtime/dist`).
Scan either address at https://genclass.dev/scan to compare.

## Fix it for good with Claude

GenClass's runtime fixes are a safety net; the bugs are still in `public/shop.js`. On your own machine:

```bash
node examples/claudes-shop/server.mjs        # http://localhost:4545 and http://localhost:4545/genclass-on
claude mcp add genclass -- npx -y @genclass/mcp
```

Open http://localhost:4545/genclass-on (GenClass's agent link only runs on pages served from your machine), then ask
Claude Code, in this folder: *"The search sometimes shows old results and the delivery note loses text. Use GenClass to
find out why, fix public/shop.js and prove the fix."* Claude reads what happened in the page (clicks, requests, the
order the answers arrived in, what each wrote), replays the exact order that broke it, fixes the code, replays again,
and writes a Playwright test.
