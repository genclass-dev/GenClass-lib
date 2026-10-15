// Stands in for the GenClass fixture (which is developed elsewhere): it writes the unit-test fixture's
// genclass-races/1 files to <outputDir>/genclass/ during the run. No page, so no browser is launched.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("writes the race files the reporter reads at the end of the run", async ({}, testInfo) => {
  const from = join(testInfo.project.testDir, "..", "fixtures", "races");
  const to = join(testInfo.project.outputDir, "genclass");
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).filter((n) => n.endsWith(".json"));
  for (const n of names) copyFileSync(join(from, n), join(to, n));
  expect(names).toHaveLength(4);
});
