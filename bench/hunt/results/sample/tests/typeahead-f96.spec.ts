// GenClass regression test for finding f96 (race), generated from run r3.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:1337";
const SCHEDULE = {"order":"seeded","seed":1,"delay":{"minMs":0,"maxMs":600},"maxHoldMs":2100};

test("/admin/content-manager/collection-types/api::article.article/s709zfagowrr9dqn13s9ez14: the final state does not depend on response order (G…", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/admin/content-manager/collection-types/api::article.article/s709zfagowrr9dqn13s9ez14");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.getByRole("combobox", { name: "author (1)", exact: true }).or(page.locator("[name=\"author (1)\"], [id=\"author (1)\"]")).first().click();
  await page.getByRole("combobox", { name: "author (1)", exact: true }).or(page.locator("[name=\"author (1)\"], [id=\"author (1)\"]")).first().fill("");
  await page.getByRole("combobox", { name: "author (1)", exact: true }).or(page.locator("[name=\"author (1)\"], [id=\"author (1)\"]")).first().pressSequentially("dav", { delay: 400 });
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  const SUBJECT = new RegExp("^EditViewPage\\.state2$");
  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
