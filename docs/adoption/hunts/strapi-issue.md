# Draft issue and pull request text for Strapi's maintainers

Drafts for the GenClass owner to send, or not. Nothing here has been posted anywhere. Facts and commands are from
`strapi.md` in this directory; the patch is `strapi.patch`.

## Issue

**Title:** Content Manager redirects to its 403 page when the permissions response arrives after its init responses

### Bug report

**Required system information**

- Strapi version: 5.59.0 (`@strapi/strapi` and `@strapi/content-manager` 5.59.0, git head `c04f9bc085eb06219fa7707a484159bed60fce68`)
- Node: 22.22.0, npm 10.9.4
- Database: SQLite (the `create-strapi` quickstart)
- Operating system: Linux (headless Chromium 1243 through Playwright 1.63.0 for the reproduction)
- Admin panel served by `strapi develop`; the same code path runs in the built admin

**Describe the bug**

A logged-in super admin who opens a Content Manager URL directly (a bookmark, a browser reload, the redirect after
login) lands on `/admin/content-manager/403`, "You don't have the permissions to access that content", although they
have every permission. A reload usually shows the list. It happens whenever the response to
`GET /admin/users/me/permissions` arrives after the responses to `GET /content-manager/init` and
`GET /content-manager/content-types-settings`. On a fast local network the permissions answer first almost every
time, so the symptom is intermittent and looks random.

**Steps to reproduce the behavior**

The only thing the reproduction does is delay that one response, as a slower network would; nothing is reordered or
changed otherwise.

1. `npx create-strapi@latest my-app --javascript --use-npm --skip-cloud --no-example` (Strapi 5.59.0), add any
   collection type (an `article` with a `title`), `npm run develop`, create the first admin.
2. Log in once in a Playwright browser context and keep its storage state (or log in inside the script).
3. Run this script (Playwright 1.63, Chromium), which opens the collection type's list URL three times with the
   permissions response delayed by 1.5 s and three times without:

```js
import { chromium } from "@playwright/test";

const APP = "http://localhost:1337";
const LIST = "/admin/content-manager/collection-types/api::article.article";
const FORBIDDEN = "You don't have the permissions to access that content";
const browser = await chromium.launch();
for (const delay of [0, 1500]) {
  for (let t = 0; t < 3; t++) {
    const ctx = await browser.newContext({ storageState: "storageState.json" });
    if (delay) await ctx.route("**/admin/users/me/permissions", async (route) => {
      await new Promise((r) => setTimeout(r, delay));
      await route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(APP + LIST);
    const outcome = await Promise.race([
      page.locator("table tbody tr").first().waitFor().then(() => "list"),
      page.getByText(FORBIDDEN).waitFor().then(() => "403 page"),
    ]);
    console.log(`permissions delayed ${delay} ms: ${outcome} (${new URL(page.url()).pathname})`);
    await ctx.close();
  }
}
await browser.close();
```

Result on 5.59.0:

```
permissions delayed 0 ms: list (/admin/content-manager/collection-types/api::article.article)   x3
permissions delayed 1500 ms: 403 page (/admin/content-manager/403)                              x3
```

**Expected behavior**

The list view, after the permissions have loaded. The 403 page should only be shown to a user whose loaded
permissions do not cover any content type.

**Cause** (file paths and lines at `c04f9bc`)

- `packages/core/admin/admin/src/features/Auth.tsx` lines 183 to 191 and 532 to 544: while
  `GET /admin/users/me/permissions` is pending, the auth context exposes `permissions: []` (the
  `_defaultPermissions` default) and `isLoading: true`.
- `packages/core/content-manager/admin/src/hooks/useContentManagerInitData.ts` lines 186 to 207: as soon as
  `/content-manager/init` and `/content-manager/content-types-settings` have data, `formatData` runs and authorises
  the links through `checkUserHasPermissions` (`Auth.tsx` lines 486 to 496), which filters the links' permissions
  against that empty list, so no link is authorised, and `setInitialData` stores empty link lists with
  `isLoading: false` (`modules/app.ts` line 58).
- `packages/core/content-manager/admin/src/layout.tsx` lines 66 to 105: `authorisedModels.length === 0` with
  content types to display means `<Navigate to="/content-manager/403" replace />`.
- When the permissions arrive, `checkUserHasPermissions` changes identity, `formatData` runs again and the links are
  filled in, but the router is already on `/content-manager/403`, and the redirect to the first authorised model
  (`layout.tsx` lines 113 to 118) is skipped on that path, so the user stays there.

Related: #20332 (Strapi 5 beta, "You don't have permission" on a fresh install until a refresh), closed in June 2024
through #20609. The ordering case above is still present in 5.59.0.

**Fix**

`useContentManagerInitData` waits for the auth context's `isLoading` before computing the links (the Layout keeps
showing its loading state until then), 12 added lines; see the patch. With the fix the script above reaches the list
in 3 of 3 delayed loads, and the regression test below passes.

### Regression test

`tests/e2e/tests/content-manager/permissions-loading.spec.ts` (in the patch): logs in, delays the permissions
response by 1.5 s with `page.route`, opens the Article list URL and expects the "Article" heading rather than the 403
page. It fails on 5.59.0 (the heading never appears, the URL is `/admin/content-manager/403`) and passes with the
fix.

**How it was found**

By reordering the admin's responses with GenClass, an open-source library that reports races in web apps
(https://github.com/genclass-dev/GenClass-lib): on this page, 2 of 6 reordered loads ended on the 403 page, and the
delayed-response script above is the reproduction without it.

## Pull request

**Title:** fix(content-manager): wait for the user's permissions before authorising the content type links

**Body**

### What does it do?

`useContentManagerInitData` now waits for the auth context's `isLoading` to be false, besides the `init` and
`content-types-settings` responses, before it authorises the content type links and dispatches `setInitialData`.
Until then the Content Manager layout keeps its loading state instead of computing an empty link list and sending
the user to `/content-manager/403`.

### Why is it needed?

When the response to `GET /admin/users/me/permissions` arrives after the Content Manager's two init responses (a
slower network, a cold server, a large permission set), the links are authorised against the auth context's empty
default permissions, every link is refused, and `layout.tsx` redirects to the 403 page, where the user stays after
the permissions have arrived. Fixes (issue number).

### How to test it?

- `tests/e2e/tests/content-manager/permissions-loading.spec.ts` delays the permissions response by 1.5 s and opens
  the Article list URL directly: it fails on `main` (the page ends on `/admin/content-manager/403`) and passes with
  this change.
- Manually: in a Playwright script or with a proxy, delay `GET /admin/users/me/permissions` by about 1.5 s and open
  `/admin/content-manager/collection-types/<uid>` while logged in.

### Related issue(s)/PR(s)

(issue number); related to #20332 and #20609.

## A second, smaller observation (not in the patch)

A double click on **Publish** in the edit view sends two `POST /content-manager/collection-types/<uid>/<id>/actions/publish`
requests and shows "Published document" twice; the same double click on **Save** sends one `PUT`. Both buttons are
disabled through the form's `isSubmitting` (`DocumentActions.tsx`: `isDisabled` of `PublishAction` at line 1067 and
of `UpdateAction` at line 1293), and both handlers call `setSubmitting(true)` first (`performPublish` at line 857,
`handleUpdate` at line 1297), so the second publish request was not expected; it is reported as observed, without a
root cause. Its visible effect is the duplicate notification; a second publish also fires the `entry.publish` webhook
again.
