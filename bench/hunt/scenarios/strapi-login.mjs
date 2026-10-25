// A login module for --login: runs once in a browser context without GenClass, signs in, and the harness saves the
// context's storage state (cookies, local storage) for every later page load. This one is for a Strapi 5 admin
// (http://localhost:1337/admin); copy it and change the three selectors for another app. Credentials come from
// parameters or the environment, never from the repository:
//
//   STRAPI_EMAIL=you@example.com STRAPI_PASSWORD=... node bench/hunt/hunt.mjs --url http://localhost:1337/admin \
//     --login scenarios/strapi-login.mjs --scenario scenarios/typeahead.mjs ...
//
// The storage state (by default bench/hunt/.storage/<scenario>.json) holds a session: .gitignore covers any .storage/
// directory and any storage-state*.json file.

import { param } from "../lib/dom.mjs";

export async function login(page, ctx) {
  const email = param(ctx, "email", process.env.STRAPI_EMAIL);
  const password = param(ctx, "password", process.env.STRAPI_PASSWORD);
  if (!email || !password) throw new Error("strapi-login: set STRAPI_EMAIL and STRAPI_PASSWORD (or --param email= --param password=)");
  const base = new URL(ctx.url);
  await page.goto(`${base.origin}/admin/auth/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  // signed in: the admin leaves the auth pages
  await page.waitForURL((u) => !u.pathname.includes("/auth/"), { timeout: 30_000 });
  // the content manager's guided tour (a dialog that traps focus and clicks) is dismissed once; Strapi remembers that
  // in local storage, which the storage state carries to every later page load
  await page.goto(`${base.origin}/admin/content-manager`);
  await page.waitForLoadState("networkidle");
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.count()) await skip.first().click();
  await page.waitForTimeout(300);
}
