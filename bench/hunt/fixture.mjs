// A Playwright fixture that puts GenClass on every page of the test's browser context the way hunt.mjs does (lib/inject:
// the runtime run inline from an init script, the agent link connected), so a regression test genclass_explain
// generated for an app that does not include GenClass itself runs against that app unchanged:
//
//   import { test, expect } from "../../../fixture.mjs";   // instead of "@playwright/test"
//
// The test sets its schedule through window.__GENCLASS_SCHEDULE__ and needs no bridge: by default the agent link is
// pointed at an address that answers nothing (lib/inject NO_BRIDGE), so a test run never reaches a GenClass bridge
// the developer runs for their own work. page.goto returns once the agent link exists (it connects asynchronously,
// a moment after the page's first script), so the test's own first check does not race it.
//
// Environment: GENCLASS_HUNT_DIST (the runtime's dist/, default this repository's), GENCLASS_HUNT_OPTS (JSON: anyHost,
// holdProtected, config, model, modelDir, settleMs; hunt.mjs writes it into the generated playwright.config.mjs),
// GENCLASS_HUNT_BRIDGE (a bridge URL, to record the test's runs). Use with `bypassCSP: true` in the config's `use`,
// as the generated playwright.config.mjs does.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { NO_BRIDGE, injectGenClass, pageConfig } from "./lib/inject.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dist = process.env.GENCLASS_HUNT_DIST || resolve(here, "../../packages/runtime/dist");
let opts = {};
try {
  opts = JSON.parse(process.env.GENCLASS_HUNT_OPTS || "{}");
} catch {
  opts = {};
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await injectGenClass(context, {
      dist,
      agentUrl: process.env.GENCLASS_HUNT_BRIDGE || NO_BRIDGE,
      anyHost: !!opts.anyHost,
      holdProtected: !!opts.holdProtected,
      config: opts.config ?? pageConfig({}),
      model: !!opts.model,
      modelDir: opts.modelDir ?? null,
      settleMs: opts.settleMs,
      // no bridge to wait for: the schedule comes from the test
      helloWaitMs: 0,
    });
    await use(context);
  },
  page: async ({ page }, use) => {
    const goto = page.goto.bind(page);
    page.goto = async (...a) => {
      const res = await goto(...a);
      await page.waitForFunction(() => !!window.__GENCLASS_AGENT__ || !!window.__GENCLASS_HUNT__?.error, null, { timeout: 15_000 }).catch(() => undefined);
      return res;
    };
    await use(page);
  },
});
export { expect };
