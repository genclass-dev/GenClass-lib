// End to end, with the Svelte CLI's own add-on harness (sv/testing, as in `npx sv create --template addon`): for
// SvelteKit in TypeScript and in JavaScript (JSDoc), it scaffolds the minimal template, applies the add-on through
// sv's engine, installs with pnpm, then per project:
//   - checks package.json, src/hooks.client.(ts|js) and src/app.html;
//   - applies the add-on a second time and checks that nothing changes;
//   - runs the app's type check (`pnpm check`: svelte-check, in TypeScript or JSDoc);
//   - builds the app, serves the production build and loads it once in Chromium: the runtime must be installed in
//     the page (GenClass marks the fetch it wraps) and its model must load in a worker (downloaded from jsDelivr, as
//     in a real app), the telemetry choice must be in <head>, the overlay must not be in the production build, and
//     the console must show no errors and no uncaught exceptions;
//   - runs `genclass-runtime remove` from the installed runtime and checks that it takes out what the add-on wrote.
// Two kinds: `observe` (defaults: observe, telemetry off, no hooks file before) and `guard` (guard, telemetry on,
// an existing hooks file with a handleError hook).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { add } from "sv";
import { createSetupTest } from "sv/testing";
import * as vitest from "vitest";
import addon from "../../src/index.js";
import { RUNTIME_RANGE, newHooksFile } from "../../src/edit.js";
import { RUNTIME_TARBALL } from "./global.js";

const { expect } = vitest;

const EXISTING_HOOKS = {
  ts: `import type { HandleClientError } from '@sveltejs/kit/hooks';

// reports client errors to the console (the app's own hook, kept as is)
export const handleError: HandleClientError = ({ error, event }) => {
	console.info('client error', event.url.pathname, error);
	return { message: 'Something went wrong' };
};
`,
  js: `// reports client errors to the console (the app's own hook, kept as is)
/** @type {import('@sveltejs/kit/hooks').HandleClientError} */
export const handleError = ({ error, event }) => {
	console.info('client error', event.url.pathname, error);
	return { message: 'Something went wrong' };
};
`,
};

const ext = (variant: string) => (variant === "kit-ts" ? "ts" : "js");
const read = (cwd: string, rel: string) => fs.readFileSync(path.join(cwd, rel), "utf8");
const exists = (cwd: string, rel: string) => fs.existsSync(path.join(cwd, rel));
const snapshot = (cwd: string, files: string[]) => Object.fromEntries(files.map((f) => [f, exists(cwd, f) ? read(cwd, f) : null]));

const { test, testCases, prepareServer } = createSetupTest(vitest, { chromium })(
  { addon },
  {
    kinds: [
      { type: "observe", options: { [addon.id]: { mode: "observe", telemetry: false } } },
      { type: "guard", options: { [addon.id]: { mode: "guard", telemetry: true } } },
    ],
    filter: (testCase) => testCase.variant.startsWith("kit"),
    browser: true,
    preAdd: ({ addonTestCase, cwd }) => {
      if (addonTestCase.kind.type === "guard") {
        const e = ext(addonTestCase.variant);
        fs.writeFileSync(path.join(cwd, `src/hooks.client.${e}`), EXISTING_HOOKS[e]);
      }
      // install the runtime this repository builds (see global.ts); the projects' package.json keeps RUNTIME_RANGE
      const workspace = path.join(path.dirname(cwd), "pnpm-workspace.yaml");
      const yaml = fs.readFileSync(workspace, "utf8");
      if (process.env.GENCLASS_SV_RUNTIME !== "registry" && !yaml.includes("overrides:")) {
        fs.writeFileSync(workspace, `${yaml.trimEnd()}\noverrides:\n  "@genclass/runtime": "file:${RUNTIME_TARBALL}"\n`);
      }
    },
  },
);

test.concurrent.for(testCases)("@genclass/sv $kind.type $variant", async (testCase, { page, ...ctx }) => {
  const cwd = ctx.cwd(testCase);
  const e = ext(testCase.variant);
  const hooksFile = `src/hooks.client.${e}`;
  const guard = testCase.kind.type === "guard";
  const template = path.resolve(cwd, "..", "..", ".templates", testCase.variant);

  // package.json: the runtime as a dependency, at the documented release
  const pkg = JSON.parse(read(cwd, "package.json"));
  expect(pkg.dependencies["@genclass/runtime"]).toBe(RUNTIME_RANGE);
  expect(pkg.devDependencies?.["@genclass/runtime"]).toBeUndefined();

  // the client hooks file
  const hooks = read(cwd, hooksFile);
  if (guard) {
    const lines = hooks.split("\n");
    expect(lines[0]).toBe("import genclass from '@genclass/runtime/auto/guard'; // genclass:init");
    expect(hooks).toContain(EXISTING_HOOKS[e].trimEnd());
    expect(hooks.trimEnd().split("\n").at(-1)).toBe(
      "if (import.meta.env.DEV) import('@genclass/runtime/devtools').then((d) => d.mountDevtools(genclass)); // genclass:init",
    );
  } else {
    expect(hooks).toBe(newHooksFile("observe"));
  }
  expect(exists(cwd, `src/hooks.client.${e === "ts" ? "js" : "ts"}`)).toBe(false);

  // src/app.html: the opt-out only when telemetry is off
  const appHtml = read(cwd, "src/app.html");
  if (guard) expect(appHtml).toBe(fs.readFileSync(path.join(template, "src/app.html"), "utf8"));
  else expect(appHtml).toContain('<meta name="genclass" content="telemetry=off" /> <!-- genclass:init -->');

  // a second run changes nothing
  const files = ["package.json", hooksFile, "src/app.html"];
  const before = snapshot(cwd, files);
  await add({ cwd, addons: { addon }, options: testCase.kind.options, packageManager: "pnpm" });
  expect(snapshot(cwd, files)).toEqual(before);

  // the app's own type check (svelte-check, TypeScript or JSDoc) still passes
  execFileSync("pnpm", ["check"], { cwd, encoding: "utf8" });

  // build, serve the production build, load it once in Chromium
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`uncaught: ${err.message}`));
  const modelReady = page.waitForEvent("console", { predicate: (m) => m.text().startsWith("[GenClass] Model ready"), timeout: 90_000 });
  // vitest sets NODE_ENV=test, and a Vite build that inherits it is a development build: build as a developer would
  const { close } = await prepareServer({ cwd, page, buildCommand: "env -u NODE_ENV pnpm build" });
  ctx.onTestFinished(async () => await close());

  // the runtime is installed in the page (it marks the fetch it wraps) and its model loads in a worker
  await page.waitForFunction(() => (window.fetch as typeof fetch & { __genclass?: boolean }).__genclass === true, null, { timeout: 20_000 });
  expect((await modelReady).text()).toContain(`Mode: ${testCase.kind.options[addon.id].mode}.`);
  const meta = await page.evaluate(() => document.head.querySelector('meta[name="genclass"]')?.getAttribute("content") ?? null);
  expect(meta).toBe(guard ? null : "telemetry=off");
  // the overlay is development only
  expect(await page.evaluate(() => document.querySelectorAll("[data-genclass-devtools]").length)).toBe(0);
  expect(problems).toEqual([]);

  // `npx @genclass/runtime remove` (the installed CLI) takes out what the add-on wrote
  execFileSync(path.join(cwd, "node_modules", ".bin", "genclass-runtime"), ["remove", "--yes", "--keep-package"], { cwd, encoding: "utf8" });
  expect(read(cwd, "src/app.html")).toBe(fs.readFileSync(path.join(template, "src/app.html"), "utf8"));
  if (guard) expect(read(cwd, hooksFile)).toBe(EXISTING_HOOKS[e]);
  else expect(exists(cwd, hooksFile)).toBe(false);
});
