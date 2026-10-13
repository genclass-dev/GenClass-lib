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
