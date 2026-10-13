# Changelog

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
