// Three tests on the e2e search page (server.mjs), all under the fixture's seeded chaos: the buggy page, where a
// slower older answer can land over the newer results; the same page with latency only (reorder off: nothing
// overtakes, so the bug cannot show); and the fixed page, which keeps only the latest answer. The tests themselves
// pass either way: what run.mjs checks is what the fixture wrote for each seed (a witness on the buggy page under
// reordering, none in the other two) and the report the reporter made of it.
// the built package, by name, as a user's spec imports it (run.mjs checks dist/ exists first)
import { expect, test } from "@genclass/playwright/fixture";

async function search(page: import("@playwright/test").Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Search").pressSequentially("react", { delay: 80 });
  // every answer has landed: nothing in flight on the fixture's runtime (its chaos holds each one up to 600 ms)
  await page.waitForTimeout(200);
  await page.waitForFunction(() => {
    const g = (window as unknown as { GenClass?: { runtime?: { inflight(): unknown[] } | null } }).GenClass;
    return !g?.runtime || g.runtime.inflight().length === 0;
  }, null, { timeout: 15_000 });
  await page.waitForTimeout(300);
  await expect(page.locator("#results li")).toHaveCount(2);
}

test.describe("search", () => {
  test("buggy page: results of the last query", async ({ page }) => {
    await search(page, "/");
  });

  test("fixed page: results of the last query", async ({ page }) => {
    await search(page, "/?fixed=1");
    await expect(page.locator("#for")).toHaveText("Results for react");
  });

  test.describe("latency only", () => {
    test.use({ genclass: { chaos: { seed: 1, delayMs: [0, 600], reorder: false } } });

    test("buggy page, latency only: results of the last query", async ({ page }) => {
      await search(page, "/");
      await expect(page.locator("#for")).toHaveText("Results for react");
    });
  });
});
