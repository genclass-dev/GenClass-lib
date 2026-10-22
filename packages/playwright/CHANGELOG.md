# Changelog

Changes to `@genclass/playwright`, the Playwright reporter for
[`@genclass/runtime`](https://www.npmjs.com/package/@genclass/runtime) race files. Version 0.1.0 is not on npm yet;
everything below is unreleased.

## Unreleased

- First version, reader only: `@genclass/playwright/reporter` (a Playwright reporter by shape: reads
  `test-results/genclass/*.json` in the `genclass-races/1` format at the end of the run, writes and prints
  `genclass-report.md`), `@genclass/playwright/summarize` (the pure files-to-markdown function, with
  `buildSummary`, `renderMarkdown`, `parseRaces` and `validateRaces`), and the `genclass-playwright-report` command
  for sharded runs. Groups by test and by signature, marks signatures flagged in 2 or more seeds as reproducible,
  lists files that fail validation with the reason, and says nothing about interventions. No runtime dependencies.
- The fixture that writes the files (runtime injection, seeded chaos with `page.route`) is not part of this package;
  it is developed separately.
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
