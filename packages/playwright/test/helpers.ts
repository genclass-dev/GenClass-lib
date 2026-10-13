// Shared by the tests: the fixture files (test/fixtures/races: two tests, two seeds each; one signature flagged in
// both seeds of its test, one in a single seed) and the exact report they produce. README.md shows the same report
// (package.test.ts keeps it in sync).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RacesFileInput } from "../src/types.js";

export const here = dirname(fileURLToPath(import.meta.url));
export const racesDir = join(here, "fixtures", "races");

/** The fixture files, as the reporter passes them (names relative to the Playwright config's directory). */
export function fixtureInputs(): RacesFileInput[] {
  return readdirSync(racesDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => ({ name: `test-results/genclass/${n}`, content: readFileSync(join(racesDir, n), "utf8") }));
}

/** U+200B, which the report puts after "#" before a digit (and "@" before a name) so GitHub links nothing. */
export const Z = "\u200B";

/** The exact report for the fixture, with sources ["test-results/genclass"]. */
export const FIXTURE_REPORT = [
  "<!-- genclass-report -->",
  "## GenClass race report",
  "",
  "**2 signatures** in 2 tests, **1 reproducible** (flagged in 2 or more seeds of the same test) · 4 files read in `test-results/genclass`",
  "",
  "| | signatures | reproducible |",
  "|---|---:|---:|",
  "| Duplicate submits | 1 | 1 |",
  "| Stale responses | 1 | 0 |",
  "| Failing endpoints | 0 | 0 |",
  "| Other detections | 0 | 0 |",
  "",
  "### checkout.spec.ts > checkout > places one order",
  "",
  "2 seeds (1, 2) · 1 signature",
  "",
  "**Duplicate submits**",
  "",
  "- **Reproducible**: 2 of 2 seeds (1, 2) · `POST /api/orders` · `request:duplicate` · confidence 0.97",
  `  > 1 identical POST /api/orders request in the last 10s (#${Z}15, 0.03s earlier, still in flight); no user action between them.`,
  "",
  "### search.spec.ts > search > shows the results of the last query",
  "",
  "2 seeds (1, 2) · 1 signature",
  "",
  "**Stale responses**",
  "",
  "- 1 of 2 seeds (2) · `GET /api/search` · `delivery:stale` · confidence 0.91",
  `  > The response of GET /api/search (#${Z}21) arrives after a newer GET /api/search (#${Z}23) was answered; it would replace results.query, which #${Z}23 wrote 0.31s ago.`,
  "",
  "---",
  "",
  "Each line is a diagnosis by GenClass's on-device model in the page under test, one per signature (trigger, diagnosis, operation). Reproducible: flagged in 2 or more seeds of the same test. A signature seen in fewer seeds may depend on that seed's timing: re-run with more seeds before acting on it. Confidence is the model's probability for the diagnosis (the highest over the seeds), and the quoted evidence line is from that seed.",
  "",
].join("\n");
