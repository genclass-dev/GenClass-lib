// @genclass/playwright: reads the race files the GenClass Playwright fixture writes (`test-results/genclass/*.json`,
// format "genclass-races/1") and turns them into a markdown report for the pull request. This entry is pure (no
// Node APIs): the format, its validator and the summariser, the same as `@genclass/playwright/summarize`. The
// Playwright reporter is `@genclass/playwright/reporter` and the command `genclass-playwright-report`.
//
// This package injects nothing: it does not route requests, start a runtime or touch a page.

export * from "./summarize.js";
