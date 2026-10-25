// The e2e scenario (docs/runtime/AGENT.md section 7) against scenarios/e2e-search-server.mjs: type "react" at 80 ms a
// keystroke into the search box. The page URL comes from --url as given (/ for the buggy page, /fixed for the fixed
// one), so one scenario file serves both.
//
//   node bench/hunt/scenarios/e2e-search-server.mjs                         # prints the URL
//   node bench/hunt/hunt.mjs --url http://127.0.0.1:<port>/ --scenario scenarios/e2e-search.mjs --expect race
//   node bench/hunt/hunt.mjs --url http://127.0.0.1:<port>/fixed --scenario scenarios/e2e-search.mjs --expect no-race

import { textLines } from "../lib/dom.mjs";

export const name = "e2e-search";
export const settleMs = 400;

export async function steps(page) {
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
}

/** What the user sees at the end: the heading and the result rows. */
export async function oracle(page) {
  return { heading: await page.locator("#for").textContent(), rows: await textLines(page, "#results") };
}
