// @genclass/playwright: the fixture (this entry) and the reporter (`@genclass/playwright/reporter`).
//
//   import { test as base } from "@playwright/test";
//   import { genclass, type GenClassFixtures } from "@genclass/playwright";
//   export const test = base.extend<GenClassFixtures>(genclass({ mode: "observe", chaos: true }));

export { genclass, cdnScriptUrl, runtimePackage, localRuntimeFile, isRuntimeCdnUrl } from "./fixture.js";
export { ATTACHMENT_NAME, PACKAGE_VERSION } from "./constants.js";
export type { GenClassFixtures } from "./fixture.js";
export { resolveOptions, resolveChaos, routePattern, DEFAULT_CHAOS, DEFAULT_HANDLES, DEFAULT_ROUTES } from "./options.js";
export { ChaosScheduler, hashSeed, mulberry32, requestKey } from "./chaos.js";
export { summarise, summariseAttachment, renderMarkdown, oneLine, normaliseSubject, FINDING_DIAGNOSES, INFO_DIAGNOSES } from "./summarise.js";
export type { Summary, TestSummary, TestInput, Finding, EndpointFailure, SummariseOptions } from "./summarise.js";
export type * from "./types.js";
