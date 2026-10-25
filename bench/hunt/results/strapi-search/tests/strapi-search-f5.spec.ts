// GenClass regression test for finding f5 (race), generated from run r7.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:1337";
const SCHEDULE = {"order":"seeded","seed":5,"delay":{"minMs":0,"maxMs":600},"maxHoldMs":2100};

test("/admin/content-manager/collection-types/api::article.article: the final state does not depend on response order (GenClass f5)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/admin/content-manager/collection-types/api::article.article");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByRole("button", { name: "Search", exact: true }).or(page.locator("[name=\"Search\"], [id=\"Search\"]")).first().click();
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().fill("");
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().pressSequentially("the", { delay: 85 });
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().press("Enter");
  // TODO: the recorded element "form" had no name; check that this locator finds it
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().fill("");
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().pressSequentially("bug", { delay: 77 });
  await page.getByLabel("Search for Article", { exact: true }).or(page.getByPlaceholder("Search for Article", { exact: true })).or(page.getByTitle("Search for Article", { exact: true })).or(page.locator("[name=\"Search for Article\"], [id=\"Search for Article\"]")).first().press("Enter");
  // TODO: the recorded element "form" had no name; check that this locator finds it
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  const SUBJECT = new RegExp("^redux\\.adminApi\\.provided\\.Document\\.ALL_LIST$");
  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
