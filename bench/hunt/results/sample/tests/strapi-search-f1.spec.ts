// GenClass regression test for finding f1 (stale-write), generated from run r5.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:1337";
const SCHEDULE = {"order":"given","given":["GET /admin/project-type#1","GET /admin/init#1","GET /admin/telemetry-properties#1","GET /admin/information#1","GET /content-manager/init#1","GET /content-manager/content-types-settings#1","GET /admin/license-limit-information#1","GET /admin/users/me/permissions#1","GET /content-manager/init#2","GET /admin/guided-tour-meta#1","GET api.github.com/repos/strapi/strapi/releases/latest#1","GET /admin/users/me#1"]};

test("/admin/content-manager/collection-types/api::article.article: no response overwrites newer NpsSurvey.state7 (GenClass f1)", async ({ page }) => {
  await page.addInitScript((s) => { (window as any).__GENCLASS_SCHEDULE__ = s; }, SCHEDULE);
  await page.goto(APP + "/admin/content-manager/collection-types/api::article.article");
  expect(await page.evaluate(() => !!(window as any).__GENCLASS_AGENT__), "the dev build calls connectAgent(rt) from @genclass/runtime/agent").toBe(true);
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  await page.evaluate(() => (window as any).__GENCLASS_AGENT__.whenSettled(15000));
  const witnesses = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.witnesses());
  const errors = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.errors());
  const snap = await page.evaluate(() => (window as any).__GENCLASS_AGENT__.snapshot());
  void witnesses; void errors; void snap;
  // the bug: a response overwrote newer data in this field
  const SUBJECT = new RegExp("^NpsSurvey\\.state7$");
  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
