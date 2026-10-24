# Draft: Umami bug issue and PR body (list search)

Drafts for a person to file upstream if they choose to. Nothing here has been sent to umami-software/umami. Umami asks
for pull requests against `dev` (`CONTRIBUTING.md`); the patch is `umami.patch` in this directory, made against `dev` at
`12cdf5777`.

---

## Issue

**Title:** Search box on list pages drops typed text when the search navigation is slow

**Describe the bug**

On every list page with a search box (Websites, Admin > Users, Admin > Websites, Admin > Teams, team members and
websites, Links, Pixels, Boards, and the website Sessions, Events, Replays, Segments, Cohorts and Errors tables: 18
`DataGrid` call sites with `allowSearch`), text typed after a short pause can disappear. If you type, pause long enough
for the search to start (600 ms), and keep typing before that navigation has finished, the box jumps back to what it
held when the pause began. What you typed after the pause is gone, the list shows the results for the shorter term,
and no further search is made for the text you typed.

When the old value lands in the middle of a word, the characters typed after it are appended to the old value instead:
typing `shop stu` gave `shopu`, `shoptu` or `shopstu` in our runs.

**To reproduce**

1. Run Umami 3.4.1 (or `dev`) and sign in; have a few websites, for example `shop studio 1` and `shop site 1`.
2. In Chrome DevTools > Network, pick the "Slow 4G" preset (any connection where a page navigation takes more than
   about 200 ms will do).
3. Open `/websites`, click the search box and type `shop`.
4. Wait about 0.7 s (the URL gets `?search=shop` once the navigation finishes), then type ` stu` straight away.
5. The box goes back to `shop` while or shortly after you type ` stu`; the list keeps showing every `shop` website.

**Expected behavior**

The box keeps `shop stu`, and after the debounce the URL and the list follow it (`shop studio 1` only).

**Measured**

Headless Chromium with the network emulation Chrome DevTools uses (added round-trip latency, no request interception),
typing `shop` (90 ms per key), a 700 ms pause, then ` stu`; 10 trials per row:

TROTTLE_TABLE

The same steps on `/admin/users` (`anna`, pause, `_sto`) behave the same way.

**Cause**

`src/components/common/DataGrid.tsx` keeps the box's text in local state and syncs it with the URL both ways
(added in 079cfdde, first released in v3.3.0):

```tsx
useEffect(() => {
  setSearch(queryParams?.search || '');
}, [queryParams?.search]);

useEffect(() => {
  const currentSearch = queryParams?.search || '';
  if (search === currentSearch) {
    return;
  }
  const timer = window.setTimeout(() => {
    router.push(updateParams({ search: search || undefined, page: 1 }));
  }, searchDelay || DEFAULT_SEARCH_DELAY);
  return () => window.clearTimeout(timer);
}, [queryParams?.search, router, search, searchDelay, updateParams]);
```

`router.push` is a soft navigation: `useSearchParams()` only changes when the navigation commits, after the RSC
request for the new URL has come back. If the user types more in the meantime, the commit makes the first effect copy
the older, pushed value over the newer text. The second effect then sees `search === currentSearch` and cancels the
pending push, so the newer text is never searched either. (A newer push made before the older navigation commits is
safe: the App Router discards the older navigation.)

**Environment**

Umami `dev` at 12cdf5777 (3.4.1), Next.js 16.4.2, React 19.3.1, PostgreSQL 16, Chromium 153, production build
(`pnpm build && pnpm start`).

Found with GenClass (an open-source tool that reorders and delays a page's responses to look for races); the steps above
reproduce it without it.

---

## Pull request

**Title:** Keep typed search text when the URL catches up with an earlier search

**Base:** `dev`

**What**

`DataGrid` copies `?search=` into its search box whenever the URL changes. When the user keeps typing while the search
navigation is still loading, that copy replaced the newer text with the value that had been pushed, and the pending
push for the newer text was cancelled. Text typed during a slow navigation was lost on all 18 searchable list pages.

This remembers the value `DataGrid` itself pushed and skips the URL-to-state copy once, when the URL arrives at that
value: the box already holds it or something newer, and the debounce then pushes the newer text as usual. Any other URL
change (back and forward, a link to a filtered list) is still copied into the box.

**Tests**

`tests/e2e/data-grid-search.spec.ts` (Playwright, in the style of `session-modal-dismiss.spec.ts`):

- `keeps text typed while the search navigation is loading`: holds the response of the first search navigation with
  `page.route` until the second part has been typed, then checks the box, the URL and the list. TEST_BEFORE_AFTER
- `control: going back restores the previous search`: the URL-to-box sync still works for back navigation. Passes before
  and after.

`pnpm lint` (Biome) is clean on both files; `pnpm build` passes.
