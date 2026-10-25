// A generic typeahead scenario: type a word into a search field, one keystroke at a time, and read what the page shows.
// Parameters (--param key=value):
//   input     a Playwright selector for the field (default: the first search-like input on the page)
//   open      a selector (or text:<name> for a button) to click first, when the field is behind a search icon
//   word      what to type (default "react")
//   delay     ms between keystrokes (default 80; slower typing lets a debounce fire per keystroke)
//   results   a selector for the element whose visible text is the oracle (default: the whole body)
//   click     "no" to skip the focusing click (default: click the field first)
//
// Strapi 5's relation picker in the article editor searches the server as you type (behind a debounce: type slower than
// it, so each keystroke sends a request). The committed sample (results/sample/) ran:
//
//   STRAPI_EMAIL=... STRAPI_PASSWORD=... node bench/hunt/hunt.mjs \
//     --url 'http://localhost:1337/admin/content-manager/collection-types/api::article.article/<documentId>' \
//     --login scenarios/strapi-login.mjs --scenario scenarios/typeahead.mjs \
//     --param input='input[name="author"]' --param word=dav --param delay=400 --param results='[role=listbox]'
//
// Keystrokes merge into one typing action while the field keeps its label and the gaps stay under a second, so keep
// `delay` below 1000.

import { numberParam, param, textLines } from "../lib/dom.mjs";

export const name = "typeahead";
export const settleMs = 400;

const DEFAULT_INPUT = 'input[type="search"], input[role="combobox"], [role="searchbox"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i]';

export async function steps(page, ctx) {
  const open = param(ctx, "open", "");
  if (open) await (open.startsWith("text:") ? page.getByRole("button", { name: open.slice(5) }).first() : page.locator(open).first()).click();
  const field = page.locator(param(ctx, "input", DEFAULT_INPUT)).first();
  await field.waitFor({ state: "visible" });
  if (param(ctx, "click", "yes") !== "no") await field.click();
  await field.pressSequentially(param(ctx, "word", "react"), { delay: numberParam(ctx, "delay", 80) });
}

export async function oracle(page, ctx) {
  return textLines(page, param(ctx, "results", "body"));
}
