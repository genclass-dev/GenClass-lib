// A generic typeahead scenario: type a word into a search field, one keystroke at a time, and read what the page shows.
// Parameters (--param key=value):
//   input     a Playwright selector for the field (default: the first search-like input on the page)
//   open      a selector (or text:<name> for a button) to click first, when the field is behind a search icon
//   word      what to type (default "react")
//   delay     ms between keystrokes (default 80; slower typing lets a debounce fire per keystroke)
//   results   a selector for the element whose visible text is the oracle (default: the whole body)
//   click     "no" to skip the focusing click (default: click the field first)
//
//   node bench/hunt/hunt.mjs --url http://localhost:1337/admin/content-manager/collection-types/api::article.article \
//     --scenario scenarios/typeahead.mjs --param input='input[name="search"]' --param word=lorem --storage-state .storage/strapi.json

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
