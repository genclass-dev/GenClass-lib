// GenClass regression test for finding f1 (race), generated from run r3.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "../../../fixture.mjs";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:4777";
const SCHEDULE = {"order":"seeded","seed":1,"delay":{"minMs":0,"maxMs":600},"maxHoldMs":2100};

test("/: the final state does not depend on response order (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByLabel("Search", { exact: true }).or(page.getByPlaceholder("Search", { exact: true })).or(page.getByTitle("Search", { exact: true })).or(page.locator("[name=\"Search\"], [id=\"Search\"]")).first().fill("");
  await page.getByLabel("Search", { exact: true }).or(page.getByPlaceholder("Search", { exact: true })).or(page.getByTitle("Search", { exact: true })).or(page.locator("[name=\"Search\"], [id=\"Search\"]")).first().pressSequentially("react", { delay: 86 });
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("react one");
  expect(snap.text, "the page shows what it shows with responses in request order").toContain("react two");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("Results for reac");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("reac one");
  expect(snap.text, "the page does not show what only the failing order showed").not.toContain("reac two");
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
