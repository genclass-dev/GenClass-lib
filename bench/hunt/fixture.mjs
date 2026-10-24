// A Playwright fixture that puts GenClass on every page of the test's browser context the way hunt.mjs does (the
// runtime's dist/ on a virtual path, the script tag first in <head>, the agent link connected), so a regression test
// genclass_explain generated for an app that does not include GenClass itself can run against that app unchanged:
//
//   import { test, expect } from "../../../fixture.mjs";   // instead of "@playwright/test"
//
// The test sets its schedule through window.__GENCLASS_SCHEDULE__ (no bridge needed). Environment: GENCLASS_HUNT_DIST
// (the runtime's dist/, default this repository's), GENCLASS_HUNT_OPTS (JSON: anyHost, holdProtected, config, modelDir,
// rewrite), GENCLASS_HUNT_BRIDGE (the bridge URL; default the agent link's own default). Put `bypassCSP: true` and
// `serviceWorkers: "block"` in the config's `use`, as hunt.mjs's generated playwright.config.mjs does.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { injectGenClass, pageConfig } from "./lib/inject.mjs";

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
    await injectGenClass(context, { dist, agentUrl: process.env.GENCLASS_HUNT_BRIDGE || "http://127.0.0.1:47357", anyHost: !!opts.anyHost, holdProtected: !!opts.holdProtected, config: opts.config ?? pageConfig({}), modelDir: opts.modelDir ?? null, rewrite: opts.rewrite !== false, settleMs: opts.settleMs });
    await use(context);
  },
});
export { expect };
