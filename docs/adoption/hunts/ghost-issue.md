# Ghost: draft issue and PR text

**Status: nothing to send.** The hunt found no race in Ghost's admin or editor at commit `268846ab` (main,
2026-10-22; 6.73.0-rc.0), so there is no issue and no pull request to propose to Ghost's maintainers. This file keeps
the template that would have been used, filled with what was measured, so the owner can judge the negative result and
so the next hunt starts from a worked example.

An unsolicited "we tested your app and found nothing" issue is noise to a maintainer; it is not proposed. If a channel
to Ghost's team opens for another reason, the paragraph under "What could be said" is accurate and short.

## What was tested (for the record)

Ghost 6.73.0-rc.0 at `268846abf3d3b65d33fc61d84200accc6d21382f`, run locally (core on sqlite, the production admin
build), the owner account, three draft posts. Six scenarios in the React admin, each repeated as 8 page loads per
session with responses delivered in request order twice and then in 6 seeded different orders, with up to 300, 600 and
900 ms of extra latency per response:

- the editor's autosave with typing continuing while a save and its refetch are out;
- creating a new post and typing while the create is out;
- switching from one post to another through the list while the first post's leave save is out;
- changing the posts list's status filter four times in half a second;
- double-clicking Publish's final confirm and the header's Update;
- the settings sidebar's tag picker typed quickly, and the authors picker.

For every load the post was read back through the Admin API and compared with what was typed last, the editor's
title, body and status line were read from the DOM, and GenClass's explore compared the registered state, the page
text and the request counts with the two in-order baselines. Over 114 seeded loads the server never held
anything but the writer's last text, no edit was lost, no duplicate write was sent, no list showed another filter's
rows, and no picker showed another term's results. The differences explore reported were a timing-dependent count
of the email-size estimate request (the estimate is debounced on `updated_at`; the last version always gets one), the
list rows' relative times moving with the wall clock between loads, and, with React state discovery on, which
minified component happened to be registered first. None is a defect in Ghost.

## Why (the code)

The editor's save engine (`apps/admin/src/editor/engine/save-engine.ts`) runs one save at a time and coalesces later
work into one pending slot, re-reading the post after every `await`; the slug machine (`engine/slug-machine.ts`) keeps
one request on the wire and resolves superseded ones stale by ticket; the session refuses a refetched record whose
`updated_at` is not the token it holds and never lets a save's answer replace a later version
(`session/editor-session.ts` `recordRefetched`, `session/use-editor-session.ts` `isLaterVersion`); list and picker
queries are keyed by their request URL (`admin-x-framework/src/utils/api/hooks.ts`), so a late answer fills only its
own cache entry; the publish flow refuses re-entry (`use-publish-flow.ts` `publishRunningRef`) and the Update button is
disabled while a save runs. Ghost's own tests cover these paths (`save-engine.queue.test.ts`,
`editor-refetch.acceptance.test.tsx`, `e2e/tests/admin/posts/editor-react.test.ts`).

## What could be said, if asked

> We ran Ghost 6.73.0-rc.0's admin (commit 268846ab) under a response-reordering harness
> (https://github.com/genclass-dev/GenClass-lib, `@genclass/mcp` explore: the same user steps, responses delivered in
> seeded different orders with up to 900 ms of extra latency, final state compared with in-order runs) across the
> editor's autosave, post creation, switching posts, the list filters, Publish and Update double-clicks and the tag and
> author pickers: 114 reordered page loads, no lost edit, no stale list, no duplicate write. The save engine's
> single-flight queue, the slug machine's ticketing and the session's `updated_at` checks held in every order we
> tried. Nothing to report; the write-up with every verdict is at
> https://github.com/genclass-dev/GenClass-lib/blob/main/docs/adoption/hunts/ghost.md.

## The template that was not needed

Kept so a later hunt on Ghost can fill it in:

```
Title: <component>: <what the user sees> when <which response> arrives after <which response>

Ghost version / commit:
Steps (no tooling needed):
  1. ...
  2. ... (a throttled network in devtools, or the attached Playwright test, makes the order happen every time)
Expected:
Actual:
Root cause: <file>:<lines> (<one sentence>)
Fix: <attached patch, N lines>; regression test: e2e/tests/admin/posts/<behaviour>.test.ts in the style of
  editor-react.test.ts (writes recorded through page.on('request'), the server read back through page.request)
Found with: a response-reordering harness (https://github.com/genclass-dev/GenClass-lib); the harness is not needed
  to reproduce or to run the test.
```
