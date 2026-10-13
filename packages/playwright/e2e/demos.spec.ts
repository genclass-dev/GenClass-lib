// Three demo apps (demos/) under their own chaos, driven with real input, GenClass in observe mode. The demos
// install the runtime themselves (ESM) and answer /api/* from a Service Worker, which Playwright's routing does
// not see: so `install: "app"` (the runtime is read from window.__demo.gc) and the demos' own chaos knobs
// (window.__demo.setChaos) instead of the fixture's page.route chaos. The model comes from jsDelivr (?model=cdn).
import { expect, test as base, type Page } from "@playwright/test";
import { genclass, type GenClassFixtures } from "@genclass/playwright";

const test = base.extend<GenClassFixtures>(genclass({ mode: "observe", install: "app", handle: "__demo.gc", chaos: false, settle: { quietMs: 2000, maxMs: 10_000 } }));

/** The demos' "Busy" preset (demos/src/shared/chaos.ts): slow, jittery, responses overtake each other. */
const BUSY = { latency: 350, jitter: 320, spikeRate: 0.08, spikeFactor: 5, reorder: 0.35 };

type DemoWindow = Window & { __demo?: { gc?: unknown; setChaos(p: unknown): Promise<void> } };

async function openDemo(page: Page, session: GenClassFixtures["genclass"], demo: string, chaos: Record<string, unknown>): Promise<void> {
  await page.goto(`${demo}/?mode=observe&model=cdn`);
  // the first visit registers the mock server's Service Worker and may reload once to become cross-origin isolated
  await page.waitForFunction(() => crossOriginIsolated && !!(window as DemoWindow).__demo?.gc, null, { timeout: 60_000, polling: 200 });
  await page.evaluate((c) => (window as DemoWindow).__demo!.setChaos(c), chaos);
  const state = await session.ready({ timeout: 150_000 });
  expect(state, "the model loads from jsDelivr on the runner").toBe("ready");
}

test("search: fast typing while responses overtake each other", async ({ page, genclass }) => {
  await openDemo(page, genclass, "search", BUSY);
  const input = page.getByTestId("search-input");
  await input.click();
  await page.keyboard.type("santiago", { delay: 110 });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace", { delay: 60 });
  await page.waitForTimeout(400);
  await page.keyboard.type("portland", { delay: 120 });
  await page.waitForTimeout(2500);
  await genclass.settle();
});

test("checkout: double-click Place order on a slow network", async ({ page, genclass }) => {
  await openDemo(page, genclass, "checkout", { latency: 450, jitter: 250 });
  const add = page.locator('[data-testid^="add-"]');
  await add.first().click();
  await page.waitForTimeout(700);
  await add.nth(1).click();
  await page.waitForTimeout(1500);
  await page.getByTestId("place-order").dblclick();
  await page.waitForTimeout(3000);
  await genclass.settle();
});

test("status: refresh storm while two services' status APIs fail", async ({ page, genclass }) => {
  await openDemo(page, genclass, "status", { latency: 200, jitter: 150, routes: { "status/payments": { failRate: 0.5 }, "status/search": { failRate: 0.4 } } });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("refresh").click();
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(6000);
  await genclass.settle();
});
