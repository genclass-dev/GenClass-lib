# Changelog

## Unreleased

- First version: the `genclass` fixture (`install: "inject" | "app"`, `runtime: "local" | "cdn" | <path>`,
  `handle`, `chaos` with latency, reorder and failure injection through `page.route`, `settle`), the
  `@genclass/playwright/reporter` reporter (markdown + JSON, findings vs info, recurring-pattern folding, honest
  interventions line), and the `playwright-reporter.yml` workflow that runs the demos under chaos and posts the
  report on pull requests.
