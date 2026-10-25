# DRAFT: Gitea bug issue (not filed)

> **For the owner, before anything is sent:** this is a draft written with AI assistance. Reproduce the bug yourself, by
> hand, on your own Gitea (steps below; a slow network in the browser's devtools makes it easy), rewrite the text in
> your own words, search the tracker for duplicates (none found in a web search on 2026-10-25; the closest,
> https://github.com/go-gitea/gitea/issues/19784, was about uncommitted IME input on Android, a different cause), and be
> ready to answer maintainers' questions yourself. The last line says you reproduced it by hand: keep it only once you
> have. Gitea wants an issue before a PR. Evidence:
> [gitea.md](gitea.md); prepared fix and test: [gitea.patch](gitea.patch).

Fields follow Gitea's bug report form (`.github/ISSUE_TEMPLATE/bug-report.yaml`).

---

**Title:** Markdown preview can show outdated text when Preview is clicked again before the previous preview loads

**Gitea Version:** v28.2.0, and `main` at ff68b39c93d7b0d10e0f6629fb188f8f1c0b37d4

**What happened?**

The Preview tab of the markdown editor can end up showing text that is no longer in the editor, with nothing to tell
the user it is stale.

Steps:

1. In the browser's devtools, throttle the network (I used 400 ms latency and 50 KB/s up and down).
2. Open any comment box, for example a new comment on an issue, and paste a long text (I used 1,500 list items, about
   60 KB).
3. Click **Preview**, and about a second later, before it has loaded, click **Write**.
4. Replace the text with something short, `short text`, and click **Preview** again.
5. The preview first shows "short text", then the long text's preview arrives and replaces it. The editor still
   contains "short text".

The long text takes longer to upload, render and download, so its response arrives last. Any first response that is
slower than the time it takes to switch tabs and edit does the same (a long document, a busy instance, a slow
connection). In Playwright it is deterministic: hold the first `POST .../markup` response with `page.route` until the
second preview has rendered.

Expected: the preview always shows the text from the latest Preview click.

The web file editor has the same problem in its **Preview** and **Preview Changes** tabs (edit a file, Preview, Edit
File, change it, Preview again).

Cause: each click sends a request and renders whatever comes back, with no check that the response belongs to the
latest click:

- https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/comp/ComboMarkdownEditor.ts#L244-L254 (all
  markdown editors)
- https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L28-L43 (file editor Preview)
- https://github.com/go-gitea/gitea/blob/v28.2.0/web_src/js/features/repo-editor.ts#L50-L58 (file editor Preview
  Changes)

Suggested fix: keep a request counter in each handler and render only the response to the latest request (a few lines
per handler; an AbortController would also work but needs every handler to catch the `AbortError`). I have the change
and an e2e test (`tests/e2e/markdown-preview.test.ts`: it holds the first response with `page.route`, fails on current
`main` and passes with the fix) ready, and can open a PR if this approach is fine.

**How are you running Gitea?**

Built from source (`make build`), binary, Linux (Ubuntu 24.04), SQLite; Chromium.

---

I found this with the help of an AI coding assistant and GenClass (a tool I work on that reorders network responses to
find race conditions); I reproduced it by hand and with the plain Playwright test above.
