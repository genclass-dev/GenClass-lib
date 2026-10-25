# Mealie: draft texts for the owner to send

Everything here is a draft for the owner. Nothing was posted, forked, pushed or opened on mealie-recipes/mealie.
The evidence is in [mealie.md](mealie.md); the change is [mealie.patch](mealie.patch) (applies to `mealie-next` at
4391aa8a5).

Before sending:

- Mealie maintainers close AI-generated PRs without review, and the template's "AI / LLM Assistance" section is
  required. The fix, the tests and these texts were written by Claude (Claude Code) in this hunt. Read the change, run
  the tests and the manual check yourself, and keep the disclosure line true. Rewrite any sentence that does not
  sound like you.
- Fork from `mealie-next`, open the PR as a draft first, title in Conventional Commits form. No CLA.
- `task py:check` is the backend check (ruff, mypy, semgrep, pytest); this change touches only the frontend, so run
  `task ui:check` (lint and vitest) as well. Neither was run in full here; see mealie.md, "Checks not run".

## 1. Issue #2808: do not comment there

The review that picked Mealie named https://github.com/mealie-recipes/mealie/issues/2808 as related. It is not. #2808
("Multiple patch requests to recipe will duplicate ingredients and steps", open, `bug: confirmed`) is a backend race:
two PATCH requests to the same recipe in flight together (for example Save clicked twice on a slow server) duplicate
its ingredients and steps. A maintainer called it a database-level race (2024-06-27), and an open PR (#8754) is linked
to it. A comment about the search composable would be off topic there and would read as promotion. The search bug has
no issue of its own (searched open and closed issues for stale or out-of-order search results), so the draft below
is a new issue instead. Open it only if you want an issue before the PR; Mealie's template accepts a PR without one.

## 2. Draft issue (optional)

**Title:** `[BUG] - Search can show the results of an earlier search term`

**What is the issue you are experiencing?**

The search dialog (and the recipe link field in the ingredient editor) can end up showing the results of an earlier
search. If you pause partway through typing, a search goes out for the partial term; if that response comes back after
the one for the full term, it replaces the newer results and stays there. `useRecipeSearch` keeps whichever response
arrives last.

**Steps to Reproduce**

1. Have a few recipes whose names share a prefix (for example "Chicken ..." and "Chickpea ...").
2. Open the search dialog with `/`, type `chi`, wait about a second, then type `cken`.
3. On a slow connection, or with the `chi` request throttled in the browser's dev tools, the `chi` response arrives
   after the `chicken` one, and the dialog lists Chickpea recipes for "chicken".

**Mealie Version**

`mealie-next` at 4391aa8a5 (v3.29.0), local dev server, SQLite.

## 3. Draft PR

**Title:** `fix: ignore stale recipe search responses`

**Body:**

```markdown
## What this PR does / why we need it:

`useRecipeSearch` writes whichever search response arrives last. If an earlier search is slower than a later one
(type "chi", pause, finish "chicken"), the "chi" results replace the "chicken" ones and stay on screen, and `loading`
is cleared by whichever response comes back first. This affects the header search dialog and the recipe link field in
the ingredient editor.

- `composables/recipes/use-recipe-search.ts`: count searches and ignore a response that is not for the latest one, so
  it can no longer overwrite newer results or clear `loading`.
- `composables/recipes/__tests__/use-recipe-search.test.ts`: two tests that resolve two searches out of order.

## Which issue(s) this PR fixes:

None filed that I could find. Happy to open one first if you prefer.

## Testing

- The new tests fail on `mealie-next` and pass with this change. The full frontend suite (`vitest run`, 58 files,
  625 tests) and eslint on the changed files pass.
- On a local dev server with 300 recipes: held the first search's response for 2 s in the browser, typed "chi",
  paused, typed "cken". Before: the dialog showed the 20 "chi" results (Chickpea ...) under "chicken" in 3 of 3
  runs. After: the 15 "chicken" results in 6 of 6 runs.

## AI / LLM Assistance

I used Claude (Claude Code) to investigate this, write the fix and the tests, and draft this description; I reviewed
the change and ran the tests and the manual check myself. The race was found with GenClass, a tool I work on, which
replays the same typing with the server's responses delivered in different orders.
```
