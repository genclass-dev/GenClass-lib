// A generic double-submit scenario: optionally fill fields, then click a submit button twice in quick succession (two
// separate clicks, the way an impatient user does it; GenClass records two actions, and two identical requests in
// flight from them are an `identical-in-flight` witness). Parameters (--param key=value):
//   button    the button: a Playwright selector, or text:<label> for getByRole("button", { name }) (default: the first
//             submit button)
//   fill      JSON object of selector → value to fill before clicking, e.g. '{"input[name=title]":"Hello"}'
//   clicks    how many clicks (default 2)
//   gap       ms between clicks (default 60)
//   results   a selector for the element whose visible text is the oracle (default: the whole body)
//
//   node bench/hunt/hunt.mjs --url http://localhost:3000/posts/new --scenario scenarios/double-click-submit.mjs \
//     --param button='text:Save' --param fill='{"input[name=title]":"Hunt"}' --storage-state .storage/app.json

import { numberParam, param, textLines } from "../lib/dom.mjs";

export const name = "double-click-submit";
export const settleMs = 500;

export async function steps(page, ctx) {
  const fill = param(ctx, "fill", "");
  if (fill) {
    for (const [sel, value] of Object.entries(JSON.parse(fill))) await page.locator(sel).first().fill(String(value));
  }
  const spec = param(ctx, "button", 'button[type="submit"], input[type="submit"]');
  const button = spec.startsWith("text:") ? page.getByRole("button", { name: spec.slice(5) }).first() : page.locator(spec).first();
  await button.waitFor({ state: "visible" });
  const clicks = Math.max(1, numberParam(ctx, "clicks", 2));
  const gap = numberParam(ctx, "gap", 60);
  for (let i = 0; i < clicks; i++) {
    if (i) await page.waitForTimeout(gap);
    // noWaitAfter: the second click must not wait for a navigation the first one may start
    await button.click({ noWaitAfter: true, force: i > 0 });
  }
}

export async function oracle(page, ctx) {
  return textLines(page, param(ctx, "results", "body"));
}
