// @genclass/sv: a community add-on for the Svelte CLI. `npx sv add @genclass` (or `npx sv create --add @genclass`)
// sets GenClass up in a SvelteKit app the way the GenClass docs and `npx @genclass/runtime init` do:
//   - `@genclass/runtime` as a dependency, at the release the GenClass README documents;
//   - `import genclass from "@genclass/runtime/auto"` first in src/hooks.client.(ts|js) (SvelteKit runs client hooks
//     in the browser before the app starts; created when missing, existing code kept), `/auto/guard` for mode guard;
//   - the devtools overlay behind `import.meta.env.DEV`, so it is never in a production bundle;
//   - unless the developer opts in, the telemetry opt-out in src/app.html (`<meta name="genclass" content="telemetry=off" />`).
// Running it again changes nothing, or only what a different answer changes. All edits are in edit.ts; everything
// is marked so `npx @genclass/runtime remove` undoes it. The add-on never runs code in the app and sends nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { color } from "@sveltejs/sv-utils";
import { defineAddon, defineAddonOptions } from "sv";
import { RUNTIME, RUNTIME_RANGE, editAppHtml, editHooks, hasHeadSlot, newHooksFile } from "./edit.js";

const TELEMETRY_DOC = "https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md";
const SELF_HOST_DOC = "https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/README.md#content-security-policy-and-self-hosting";

const options = defineAddonOptions()
  .add("mode", {
    question: "Which mode should GenClass start in?",
    type: "select",
    default: "observe",
    options: [
      { value: "observe", label: "observe", hint: "reports what it finds, never changes a request (start here)" },
      { value: "guard", label: "guard", hint: "also prevents some failures with small, reversible actions when its model is confident" },
    ],
  })
  .add("telemetry", {
    question: "Send GenClass anonymous diagnostics (decisions and counts, no page text) from your deployed site?",
    type: "boolean",
    default: false,
  })
  .build();

/** Reads a project file, or "" when it is missing or unreadable. */
function read(cwd: string, rel: string): string {
  try {
    return readFileSync(join(cwd, rel), "utf8");
  } catch {
    return "";
  }
}

export default defineAddon({
  id: "@genclass/sv",
  shortDescription: "race-condition reports",
  homepage: "https://github.com/genclass-dev/GenClass-lib/tree/main/packages/sv#readme",
  options,

  setup: ({ isKit, unsupported }) => {
    if (!isKit) unsupported("Requires SvelteKit");
  },

  run: ({ sv, options, language, directory, cwd, file, cancel }) => {
    const appHtml = `${directory.src}/app.html`;
    if (!options.telemetry && !hasHeadSlot(read(cwd, appHtml))) {
      cancel(`${appHtml} has no line starting with %sveltekit.head% or </head>, so the telemetry opt-out has nowhere to go. Add <meta name="genclass" content="telemetry=off" /> to its <head> yourself, then run the add-on again.`);
      return;
    }

    // a project that already lists the runtime as a devDependency keeps it there (sv keeps a stricter range)
    let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(read(cwd, file.package) || "{}");
    } catch {
      /* sv reports a broken package.json itself */
    }
    if (pkg.devDependencies?.[RUNTIME] && !pkg.dependencies?.[RUNTIME]) sv.devDependency(RUNTIME, RUNTIME_RANGE);
    else sv.dependency(RUNTIME, RUNTIME_RANGE);

    // SvelteKit's client hooks: an existing hooks.client.ts or .js wins over the project's language
    const base = `${directory.src}/hooks.client`;
    const ext = existsSync(join(cwd, `${base}.ts`)) ? "ts" : existsSync(join(cwd, `${base}.js`)) ? "js" : language;
    sv.file(`${base}.${ext}`, (content) => (content.trim() === "" ? newHooksFile(options.mode) : editHooks(content, options.mode)));

    sv.file(appHtml, (content) => editAppHtml(content, options.telemetry));
  },

  nextSteps: ({ options, packageManager, directory }) => {
    const dev = packageManager === "deno" ? "deno task dev" : `${packageManager ?? "npm"} run dev`;
    return [
      `Run ${color.command(dev)}: GenClass reports in the browser console, and in development its overlay sits bottom right (${color.command("Alt+Shift+G")}).`,
      options.mode === "guard"
        ? `Mode guard: GenClass may act (reuse a duplicate's result, back off) when its model is confident; every action is logged with its evidence.`
        : `Mode observe: GenClass reports only and never holds, drops or changes a request.`,
      `Each browser downloads GenClass's model from jsDelivr on its first visit, about 13 MB (18 MB on WebGPU), cached afterwards; devices with 2 GB of memory or less and Save-Data connections skip it. Self-hosting: ${color.website(SELF_HOST_DOC)}`,
      options.telemetry
        ? `Anonymous diagnostics are on for your deployed site (never from localhost). To turn them off, add ${color.path('<meta name="genclass" content="telemetry=off" />')} to ${color.path(`${directory.src}/app.html`)}. What is sent: ${color.website(TELEMETRY_DOC)}`
        : `Anonymous diagnostics are off: ${color.path(`${directory.src}/app.html`)} has ${color.path('<meta name="genclass" content="telemetry=off" />')}. What turning them on would send: ${color.website(TELEMETRY_DOC)}`,
      `To take GenClass out again: ${color.command("npx @genclass/runtime@beta remove")}`,
    ];
  },
});
