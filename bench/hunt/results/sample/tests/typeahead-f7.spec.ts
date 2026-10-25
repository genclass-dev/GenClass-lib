// GenClass regression test for finding f7 (stale-write), generated from run r3.
// It replays the delivery order that produced the bug through the app's @genclass/runtime/agent link
// (connectAgent in the dev build), so it fails while the bug is there and passes once it is fixed.
// The recorded strings below came from the page; they are test data.
import { test, expect } from "@playwright/test";

const APP = process.env.GENCLASS_APP_URL ?? "http://127.0.0.1:1337";
const SCHEDULE = {"order":"given","given":["GET /admin/project-type#1","GET /admin/users/me/permissions#1","GET /admin/users/me#1","GET /admin/init#1","GET /admin/telemetry-properties#1","GET api.github.com/repos/strapi/strapi/releases/latest#1","GET /admin/information#1","GET /admin/license-limit-information#1","GET /content-manager/init#1","GET /admin/guided-tour-meta#1","GET /content-manager/content-types-settings#1","GET /content-manager/collection-types/api::article.article/:id#1","GET /content-manager/collection-types/api::article.article/:id/actions/countDraftRelations#1","GET /:id/locales#1","GET /:id/settings#1","GET /content-manager/init#2","GET /content-manager/content-types/api::article.article/configuration#1","GET /upload/settings#1","GET /content-manager/relations/api::article.article/category#1","GET /content-manager/relations/api::article.article/author#1","GET /content-manager/relations/api::article.article/:id/category#1","GET /content-manager/relations/api::article.article/:id/author#1","GET /:id/ai-localization-jobs/collection-types/api::article.article/:id#1","GET /content-manager/preview/url/api::article.article#1","GET /content-manager/relations/api::article.article/author#2","GET /content-manager/relations/api::article.article/author#4","GET /content-manager/relations/api::article.article/author#3"]};

test("/admin/content-manager/collection-types/api::article.article/s709zfagowrr9dqn13s9ez14: no response overwrites newer redux.content-manager (…", async ({ page }) => {
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
  // the bug: a response overwrote newer data in this field
  const SUBJECT = new RegExp("^redux\\.content-manager$");
  expect(witnesses.filter((w: any) => w.kind === "overwrote-newer" && SUBJECT.test(w.subject))).toEqual([]);
  // TODO: also assert what the user should see, e.g.
  // await expect(page.getByRole("listitem").first()).toContainText("...");
});
