// GenClass regression test for finding f1 (duplicate-request), generated from run r1.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:4777";
const SCHEDULE = {"order":"given","given":["POST /api/items#1"]};

test("/form-nav: POST /api/items is sent once per intent (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/form-nav");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByRole("button", { name: "Save", exact: true }).or(page.locator("[name=\"Save\"], [id=\"Save\"]")).first().click();
  await page.getByRole("button", { name: "Save", exact: true }).or(page.locator("[name=\"Save\"], [id=\"Save\"]")).first().click();
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  // the bug: a second click sent the same request again while the first was in flight
  expect(witnesses.filter((w: any) => w.kind === "identical-in-flight" && w.subject === "POST /api/items")).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
