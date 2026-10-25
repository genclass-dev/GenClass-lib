// Strapi 5 content manager, list view of a collection type: search the entries twice in quick succession. The entries
// search sits behind the header's "Search" icon button; it opens as `input[name="search"]` and applies on Enter (not
// per keystroke; the sidebar's `search_contentType` box is a different thing, it filters the list of content types).
// One search is one list request, so two searches a moment apart put two list requests with different queries in
// flight together, and the question is whether the table at the end depends on which answer arrived last.
// Parameters (--param key=value):
//   first    the first query (default "the")
//   second   the second query (default "bug")
//   gap      ms between the two searches (default 150)
//
//   STRAPI_EMAIL=... STRAPI_PASSWORD=... node bench/hunt/hunt.mjs \
//     --url 'http://localhost:1337/admin/content-manager/collection-types/api::article.article' \
//     --login scenarios/strapi-login.mjs --scenario scenarios/strapi-search.mjs

import { numberParam, param, textLines } from "../lib/dom.mjs";

export const name = "strapi-search";
export const settleMs = 500;

export async function steps(page, ctx) {
  await page.getByRole("button", { name: "Search", exact: true }).first().click();
  const field = page.locator('input[name="search"]');
  await field.waitFor({ state: "visible" });
  await field.pressSequentially(param(ctx, "first", "the"), { delay: 60 });
  await field.press("Enter");
  await page.waitForTimeout(numberParam(ctx, "gap", 150));
  await field.press("ControlOrMeta+a");
  await field.pressSequentially(param(ctx, "second", "bug"), { delay: 60 });
  await field.press("Enter");
}

/** The search box, the URL's query, and the main content (the "n entries found" line, the table, any notice). */
export async function oracle(page) {
  const field = page.locator('input[name="search"]');
  return {
    query: (await field.count()) ? await field.inputValue() : null,
    urlQuery: new URL(page.url()).searchParams.get("_q"),
    main: await textLines(page, "main", 120),
  };
}
