# Draft issue and pull request text for Vikunja's maintainers

> **DRAFT. The owner rewrites this in their own words before sending anything.** Vikunja's CONTRIBUTING asks for bug
> reports the reporter reproduced themselves, kept short, with AI help disclosed. Nothing here has been posted
> anywhere. Facts and commands come from `vikunja.md` in this directory; the patch is `vikunja.patch`. Before sending:
> run `repro.mjs` (or the steps below) yourself against your own local Vikunja, and say in the issue and the PR that
> an AI coding assistant found the bug and wrote the patch with you. Vikunja's CONTRIBUTING also has a line addressed
> to automated agents (a marker for the PR title); this text does not use it, since a person sends it.

## Issue (Bug Report template)

**Pre-submission checklist:** not done in the hunt (no search on Vikunja's tracker was run); search open and closed issues for "priority", "autosave" and "description lost" before sending.

**Description**

Two quick edits in the task detail can leave the page, and then the server, with the older value:

1. Open a task with a due date and a priority (`/tasks/{id}`).
2. Set the due date (Tomorrow, Confirm): the page sends `PATCH /api/v2/tasks/{id}` (#1).
3. Before #1 answers, set the priority to High: `PATCH #2`, carrying both edits.
4. The server applies #1, then #2, but #1's response reaches the browser after #2's: the priority falls back to Low.
5. Change any other field: its PATCH sends priority Low back, and the server now stores Low.

`saveTask()` in `TaskDetailView.vue` and `updateTaskMutationOptions()` in `taskMutations.ts` apply every PATCH
response in arrival order, so the older one overwrites the newer edit in the draft and in every cached copy. A second
case with the same cause: saving the description, then the title before the description's response is in, stores
the older description (each component sends the whole task as it last saw it).

Reproduced locally with Playwright delaying only the first PATCH response by 800 ms (`route.fetch()` first, so the
server applies the saves in order): 3 of 3 runs end with the old priority on the page, and after the next edit on
the server; 0 of 3 without the delay.

**Vikunja Version:** v2.7.1 (`5619c4a`); the same code is on `main` at `4699814`.

**Browser and version:** Chromium 153.0.8010.12 (headless, Playwright 1.63.0).

**Can you reproduce the bug on the Vikunja demo site?** Not tried: it needs one response delayed relative to the
other, which browser throttling does not do (it slows all requests alike), and we do not run scripts against the demo.

**Screenshots:** none (the evidence is the priority select's value and `GET /api/v2/tasks/{id}`).

## Pull request

**Title:** `fix(tasks): keep the newest edit when task saves answer out of order`

**Body:**

Fixes #<issue>.

Only the newest save of a task writes its response, in the detail's draft and in the query cache; it carries every
edit made before it. The title and the description now send only their own field, so neither writes back the
other's older value.

How to verify:

- `pnpm vitest run src/views/tasks/TaskDetailView.test.ts src/client/queries/taskMutations.test.ts`: the two new
  tests answer the second save before the first and fail without the fix.
- `mage test:e2e "tests/e2e/task/task.spec.ts --grep 'older save arrives last|description save is in flight'"`:
  each holds the first PATCH response until the second is in, then checks the stored task through the API and after
  a reload.

AI disclosure: found with an AI coding assistant and GenClass (a browser tool that reorders response delivery); the
patch and tests were written with the assistant and reviewed and run by me.
