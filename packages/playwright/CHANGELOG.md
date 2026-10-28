# Changelog

Changes to `@genclass/playwright`, the Playwright reporter for
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) race files. Version 0.1.0 is not on npm yet;
everything below is unreleased.

## Unreleased

- **The fixture**, `@genclass/playwright/fixture`: Playwright's `test` (`test.extend`) and `expect`, with a
  `genclass` option (`use: { genclass: {...} }`). On every `page` it puts `@genclass/runtime`'s script-tag build
  before the app's first script, in observe mode with telemetry off, the visual checks and the devtools off, and
  serves the runtime's `dist/` from the installed package (or `runtimeDir`) on the page's origin at `/__genclass__/`
  with `page.route`, never from a CDN. The model is skipped by default (`model: "skip"`: no 13 MB download) and the
  file carries the runtime's witnesses, computed without the model through the agent entry connected with every
  hold off (`overwrote-newer`, `identical-in-flight`); `model: "load"` adds the model's detections with their
  confidence. At the end of each test it writes one `genclass-races/1` file to `test-results/genclass/` (or
  `outDir`), named after the test, its id and its seed, with the seed and the chaos settings. `enabled: false`
  makes it inert. Peer dependencies only (`@playwright/test`, `@genclass/runtime`, both optional: the reporter
  needs neither).
- **Seeded chaos** (`chaos: { seed, delayMs, reorder, match }`): with `page.route` the real response is fetched at
  once and its delivery to the page held for a latency derived from the seed and the request's key (method, path,
  occurrence), so a run repeats exactly; `reorder: false` keeps the request order (latency only). Only fetch and
  XHR requests inside `match` (default: same-origin `/api*` or JSON responses); never the runtime's own files,
  documents, scripts or anything outside the filter. Off unless given. With `repeatEach`, the repeat index is
  added to the seed, so two repeats give the report its two seeds.
- **Witnesses in the report**: signatures with trigger `witness` get their own group (shown only when there are
  any), no confidence on the line (a fact that happened, not a probability) and a footer sentence saying what they
  are; they are never counted as duplicate submits or stale responses. A model state `off` (no model by choice)
  no longer gets the "model was not ready" note. The model-only report is byte for byte what it was.
- **Measured** (`test/e2e`, run by the workflow in Chromium): on the MCP e2e search page with latency 0 to 600 ms
  and reordering, the buggy page gets `witness:overwrote-newer` on `GET /api/search` in 5 of 5 seeds, the same
  page with latency only in 0 of 5, and the fixed page in 0 of 5; no other signature anywhere. With `model: "load"`
  (one run by hand, two seeds) the model loaded through the fixture's path and gave no likely detection on that
  page (`stale` at 0.64 in one seed, below the 0.90 report gate; nothing in the other), while the witness was
  recorded in both.
- First version of the reader side: `@genclass/playwright/reporter` (a Playwright reporter by shape: reads
  `test-results/genclass/*.json` in the `genclass-races/1` format at the end of the run, writes and prints
  `genclass-report.md`), `@genclass/playwright/summarize` (the pure files-to-markdown function, with
  `buildSummary`, `renderMarkdown`, `parseRaces` and `validateRaces`), and the `genclass-playwright-report` command
  for sharded runs. Groups by test and by signature, marks signatures flagged in 2 or more seeds as reproducible,
  lists files that fail validation with the reason, and says nothing about interventions. No runtime dependencies.
- Playwright can load the reporter by name: every export has a `default` condition next to `import`, because
  Playwright resolves a reporter id with CommonJS `require.resolve`, which does not match `import` (before this,
  `reporter: [["@genclass/playwright/reporter"]]` stopped the run with `ERR_PACKAGE_PATH_NOT_EXPORTED`). CI now runs
  a real Playwright run (no browser) that loads it this way.
- `printsToStdio()` is false, so listed alone the reporter no longer stops Playwright from adding its line/dot
  reporter.
- Safe to post on GitHub: `#` before a digit, `GH-` before a digit and `@` before a name get a zero-width space
  (U+200B), so the runtime's request ids (`#15`) do not link the repository's issues and Playwright tags (`@smoke`)
  mention no one. Mode values are escaped like other text from the files.
- `maxChars` (reporter and summariser option, `--max-chars` for the command; default 60000, `0` for no limit) keeps
  the report within one GitHub comment, leaving out list entries, then the least important signatures of each test,
  then whole tests, with a note saying what was left out; the counts include everything.
- The "model was not ready" note is only for files that flagged nothing, and no longer says those runs could not
  flag anything (a file can carry detections with state `unloaded`).
- Docs: the README opens with what the package is and links `@genclass/runtime` on npm; the config example imports
  `defineConfig`; the measured double-submit list names all 14 data layers and the runtime build the matrix ran;
  the privacy note gives the versions that send diagnostics from local hosts (`0.1.0-beta.3` to `0.2.1`); links
  outside the package are absolute, so they work on npm. `homepage` points at the README, and the package
  description says the race files come from the GenClass Playwright fixture, which is not released yet.
