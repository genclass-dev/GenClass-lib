# Vendure: draft issue and draft pull request

Drafts for the owner to send. Nothing here has been posted to vendurehq/vendure. Evidence and method:
[`vendure.md`](./vendure.md). The patch: [`vendure.patch`](./vendure.patch) (against `master` at `aba3e9c`).

Before filing: check that nobody has filed the same dashboard bug since 2026-10-24, and decide whether to file a new
issue (below) or to comment on [vendurehq/vendure#2117](https://github.com/vendurehq/vendure/issues/2117). #2117 is the
legacy admin-ui report of the same bug; its last maintainer comment (2025-04-02) says the fix "will be included in a
future release of the new `@vendure/dashboard`". The issue below links it. If the new issue gets a number, the
`#2117` references in the patch's comments and test title can be changed to it.

---

## Draft issue (template: `.github/ISSUE_TEMPLATE/bug_report.md`)

**Title:** `[dashboard] Double-clicking Create on a detail page creates the entity twice`

**Describe the bug**

On every detail page built with `useDetailPage` (collections, products, facets, customers and the rest), a quick
double-click on the **Create** button sends the create mutation twice and creates two entities. A double-click on
**Update** sends the update mutation twice. This is the dashboard counterpart of #2117 (legacy admin-ui).

Two things combine:

1. `useDetailPage` returns `isPending: updateMutation.isPending || detailQuery?.isPending`
   (`packages/dashboard/src/lib/framework/page/use-detail-page.ts`, line 446). `createMutation.isPending` is not part
   of it, so the Create button (`disabled={... || isPending}`) stays enabled while `create*` is in flight.
2. Even where `isPending` is wired in (the Update button), it cannot stop a fast second click. The form's submit
   handler (`packages/dashboard/src/lib/framework/form-engine/use-generated-form.tsx`, lines 293 to 351) awaits
   `form.trigger()` (line 297) before `form.handleSubmit` (line 350) calls `onSubmit`, which calls `mutate()`
   (`use-detail-page.ts` lines 418 and 430). The button only becomes disabled on the render after `mutate()`. A
   second click in that window starts a second submit with the same values.

**To Reproduce**

1. Run the dev server: `cd packages/dev-server && DB=sqlite bun run populate && DB=sqlite bun run dev:direct`, log in
   to http://localhost:5173/dashboard as superadmin / superadmin.
2. Go to Catalog > Collections > New collection and type a name.
3. Double-click **Create**.
4. Open the collection list: there are two collections with that name (two slugs, `name` and `name-2`), and the
   network tab shows two `CreateCollection` requests.

It also reproduces with Playwright's plain `locator.dblclick()`: the regression test in the linked PR fails on
`master` in 5 of 5 runs for Create and 5 of 5 for Update (two mutations each time).

**Expected behavior**

One create (or update) mutation per double-click, and one entity.

**Actual behavior**

Two mutations; two entities on Create. Measured on `master` (`aba3e9c`, 3.8.1) with the SQLite dev server and the
production build of the dashboard, presses sent through CDP 0 to 150 ms apart: 77 of 160 Create trials sent `create*` twice (all 40 at a 0 ms gap, 33 of 40 at 30 ms, 4 of 40 at 80 ms)
and left 60 duplicate collections, products and facets in the database; 23 of 48 Update trials sent the update
twice. With 100 ms of added request latency (a remote server), 37 of 48 Create trials doubled, including every page at
an 80 ms gap. The duplicates get de-duplicated slugs or codes (`name`, `name-2`), so nothing fails visibly.

On Customer the server rejects the second create (the email address is taken), so only the request is duplicated
there.

**Environment**

- @vendure/core version: 3.8.1 (`master` at `aba3e9c`, 2026-10-23)
- Nodejs version: 22.22.0
- Database: SQLite (dev server, `DB=sqlite`)
- Operating System: Linux
- Browser: Chromium 153
- Package manager: bun 1.4.4

**Workaround**

Click once and wait for the toast.

**Additional context**

I intend to fix this and have a patch ready: `createMutation.isPending` added to `isPending`, and a guard in
`useGeneratedForm`'s submit handler that ignores a submit while the previous one is being validated or while the
promise returned by `onSubmit` is pending (`useDetailPage` returns its `mutateAsync` promise). It adds no dependency
and does not change the public API apart from `GeneratedFormOptions.onSubmit` also accepting a returned promise. Unit
tests in `use-generated-form.spec.tsx` and a Playwright regression test in `e2e/tests/regression/` are included. I
found it with GenClass, a browser library that reports duplicate submits; the steps above need nothing but the
dashboard.

---

## Draft pull request (template: `.github/pull_request_template.md`)

**Base:** `master`. **Title (conventional, lower-case subject):** `fix(dashboard): submit a detail form only once on double-click`

# Description

Fixes #ISSUE (dashboard counterpart of #2117).

A double-click on Create on any `useDetailPage` page created the entity twice, and a double-click on Update sent the
update twice:

- `useDetailPage` left `createMutation.isPending` out of the `isPending` it returns, so the Create button stayed
  enabled while the create mutation was in flight.
- Even with `isPending` wired in, the submit handler in `useGeneratedForm` awaits validation before it calls
  `onSubmit`, and the button is only disabled on the next render, so a fast second click still submitted again. Adding
  `createMutation.isPending` alone does not fix it: with only that change the new e2e test still fails 10 of 10 runs.

Changes:

- `useGeneratedForm`: the submit handler ignores a submit while the previous one is being validated, and while the
  promise returned by `onSubmit` is pending. `GeneratedFormOptions.onSubmit` may now return a promise (returning
  nothing keeps the old behavior apart from the validation-time guard).
- `useDetailPage`: `onSubmit` returns the create or update `mutateAsync` promise (errors still go to the mutation's
  `onError`, the rejection is caught), and `isPending` includes `createMutation.isPending`, so the Create button is
  disabled while the request is in flight, like Update.

Tests:

- `use-generated-form.spec.tsx`: a second submit during validation is ignored; further submits are ignored until the
  `onSubmit` promise settles; a submit that fails validation releases the guard. The first two fail on `master`.
- `e2e/tests/regression/double-submit-on-save.spec.ts`: `dblclick()` on Create creates one collection (checked on the
  wire and through the Admin API); `dblclick()` on Update sends one update. On `master` both fail 5 of 5 runs; with
  the fix both pass 5 of 5.

Checked locally: `npm run check-types`, `eslint` and `prettier` on the changed files, the dashboard unit suite (961
passed, 4 skipped), and the new e2e spec.

# Breaking changes

None. `GeneratedFormOptions.onSubmit` widens from `=> void` to `=> void | Promise<unknown>`.

# Screenshots

Not applicable.

# Checklist

📌 Always:
- [x] I have set a clear title
- [x] My PR is small and contains a single feature
- [x] I have checked my own PR

👍 Most of the time:
- [x] I have added or updated test cases
- [ ] I have updated the README if needed (not needed)
