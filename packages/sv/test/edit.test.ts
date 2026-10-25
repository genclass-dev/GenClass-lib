import { readFileSync } from "node:fs";
import { isRangeWithin } from "@sveltejs/sv-utils";
import { describe, expect, it } from "vitest";
// @genclass/runtime's CLI, at the same commit: what the add-on writes must be what `remove` takes out and `init` reads
import { planRemoval, switchMode } from "../../runtime/bin/lib/edit.mjs";
import { RUNTIME_RANGE, editAppHtml, editHooks, hasHeadSlot, modeOf, newHooksFile } from "../src/edit.js";

const APP_HTML = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
`;

const SENTRY_HOOKS = `import { handleErrorWithSentry, replayIntegration } from '@sentry/sveltekit';
import * as Sentry from '@sentry/sveltekit';

Sentry.init({ dsn: 'https://example.invalid/1', integrations: [replayIntegration()] });

export const handleError = handleErrorWithSentry();
`;

/** Applies an edit that returns `false` for "nothing to change". */
const apply = (content: string, edit: (c: string) => string | false) => {
  const out = edit(content);
  return out === false ? content : out;
};

describe("new client hooks file", () => {
  it("is one marked block with the /auto import and the dev-only overlay", () => {
    expect(newHooksFile("observe")).toBe(
      [
        "// genclass:init start: GenClass Runtime, added by `npx sv add @genclass` (`npx @genclass/runtime remove` takes it out)",
        'import genclass from "@genclass/runtime/auto";',
        'if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));',
        "// genclass:init end",
        "",
      ].join("\n"),
    );
    expect(newHooksFile("guard")).toContain('import genclass from "@genclass/runtime/auto/guard";');
  });

  it("is deleted whole by `npx @genclass/runtime remove`", () => {
    const r = planRemoval(newHooksFile("guard"));
    expect(r.problems).toEqual([]);
    expect(r.text).toBe("");
  });

  it("is already complete: editing it again changes nothing", () => {
    expect(editHooks(newHooksFile("observe"), "observe")).toBe(false);
    expect(editHooks(newHooksFile("guard"), "guard")).toBe(false);
  });

  it("switches mode in place, keeping the block valid for remove", () => {
    const guard = editHooks(newHooksFile("observe"), "guard");
    expect(guard).not.toBe(false);
    expect(guard).toContain('"@genclass/runtime/auto/guard"');
    expect(guard).not.toContain('"@genclass/runtime/auto";');
    expect(guard).toContain("// genclass:init start");
    expect(guard).toContain("// genclass:init end");
    expect(planRemoval(guard as string)).toEqual({ text: "", problems: [] });
    // and back
    const observe = editHooks(guard as string, "observe");
    expect(observe).toContain('"@genclass/runtime/auto"');
    expect(planRemoval(observe as string)).toEqual({ text: "", problems: [] });
  });
});

describe("existing client hooks file", () => {
  it("gets the /auto import first and the overlay line last, each marked, and keeps the code", () => {
    const out = editHooks(SENTRY_HOOKS, "observe") as string;
    const lines = out.split("\n");
    expect(lines[0]).toBe("import genclass from '@genclass/runtime/auto'; // genclass:init");
    expect(out).toContain(SENTRY_HOOKS.trimEnd().split("\n").slice(0, 2).join("\n"));
    expect(out).toContain("export const handleError = handleErrorWithSentry();");
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      "if (import.meta.env.DEV) import('@genclass/runtime/devtools').then((d) => d.mountDevtools(genclass)); // genclass:init",
    );
  });

  it("is idempotent: a second run with the same mode writes nothing and never duplicates an import", () => {
    const once = editHooks(SENTRY_HOOKS, "observe") as string;
    expect(editHooks(once, "observe")).toBe(false);
    const guard = editHooks(once, "guard") as string;
    expect(guard.match(/@genclass\/runtime\/auto/g)).toHaveLength(1);
    expect(guard.match(/@genclass\/runtime\/devtools/g)).toHaveLength(1);
    expect(guard).toContain("'@genclass/runtime/auto/guard'");
    expect(editHooks(guard, "guard")).toBe(false);
  });

  it("is taken out by `npx @genclass/runtime remove`, byte for byte", () => {
    const leadingComment = "// reports client errors\n/** @type {import('@sveltejs/kit/hooks').HandleClientError} */\nexport const handleError = () => ({ message: 'Oops' });\n";
    const blankEnd = 'import { dev } from "$app/environment";\n\nexport const x = dev;\n\n';
    for (const src of [SENTRY_HOOKS, leadingComment, blankEnd]) {
      for (const mode of ["observe", "guard"] as const) {
        const r = planRemoval(editHooks(src, mode) as string);
        expect(r.problems).toEqual([]);
        expect(r.text).toBe(src);
      }
    }
  });

  it("binds the runtime on the README's one-line import instead of adding a second import", () => {
    const src = 'import "@genclass/runtime/auto";\nimport { dev } from "$app/environment";\n';
    const out = editHooks(src, "observe") as string;
    expect(out.match(/@genclass\/runtime\/auto/g)).toHaveLength(1);
    expect(out.split("\n")[0]).toBe('import genclass from "@genclass/runtime/auto";');
    expect(out).toContain('import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass))');
    expect(editHooks(out, "observe")).toBe(false);
  });

  it("quotes both added lines the way the file quotes its strings", () => {
    const single = "/** @type {import('@sveltejs/kit/hooks').HandleClientError} */\nexport const handleError = () => ({ message: 'Oops' });\n";
    const out = editHooks(single, "observe") as string;
    expect(out).toContain("import genclass from '@genclass/runtime/auto'; // genclass:init");
    expect(out).toContain("import('@genclass/runtime/devtools')");
    const double = editHooks('export const handleError = () => ({ message: "Oops" });\n', "observe") as string;
    expect(double).toContain('import genclass from "@genclass/runtime/auto"; // genclass:init');
    expect(double).toContain('import("@genclass/runtime/devtools")');
  });

  it("uses the name an existing default import already has", () => {
    const src = "import rt from '@genclass/runtime/auto/observe';\n\nexport const init = () => {};\n";
    const out = editHooks(src, "observe") as string;
    expect(out).toContain("import rt from '@genclass/runtime/auto/observe';");
    expect(out).toContain("d.mountDevtools(rt)");
  });

  it("leaves the GenClass SvelteKit template's hooks file alone (it already has the import and the overlay)", () => {
    const template = `// GenClass, in the browser only.
import genclass from '@genclass/runtime/auto';

// The devtools overlay, in development only (not in your production bundle).
if (import.meta.env.DEV) import('@genclass/runtime/devtools').then((d) => d.mountDevtools(genclass));
`;
    expect(editHooks(template, "observe")).toBe(false);
    const guard = editHooks(template, "guard") as string;
    expect(guard).toContain("import genclass from '@genclass/runtime/auto/guard';");
    expect(guard.match(/devtools/g)).toHaveLength(2); // the comment and the one import
  });

  it("is recognised by init's mode switch", () => {
    const out = editHooks(SENTRY_HOOKS, "observe") as string;
    expect(switchMode(out, "guard")).toContain("'@genclass/runtime/auto/guard'; // genclass:init");
  });
});

describe("src/app.html: the telemetry opt-out", () => {
  it("adds one marked meta line before %sveltekit.head%, with its indentation", () => {
    const out = editAppHtml(APP_HTML, false) as string;
    expect(out).toContain('\t\t<meta name="genclass" content="telemetry=off" /> <!-- genclass:init -->\n\t\t%sveltekit.head%');
    expect(out.split("\n")).toHaveLength(APP_HTML.split("\n").length + 1);
    expect(editAppHtml(out, false)).toBe(false);
  });

  it("is taken out by `npx @genclass/runtime remove`, byte for byte", () => {
    const out = editAppHtml(APP_HTML, false) as string;
    expect(planRemoval(out)).toEqual({ text: APP_HTML, problems: [] });
  });

  it("writes nothing when telemetry is on, and takes its own opt-out back out", () => {
    expect(editAppHtml(APP_HTML, true)).toBe(false);
    expect(editAppHtml(editAppHtml(APP_HTML, false) as string, true)).toBe(APP_HTML);
  });

  it("adds telemetry=off to a genclass meta tag the page already has", () => {
    const src = APP_HTML.replace("%sveltekit.head%", '<meta name="genclass" content="mode=guard, devtools=local">\n\t\t%sveltekit.head%');
    const out = editAppHtml(src, false) as string;
    expect(out).toContain('<meta name="genclass" content="mode=guard, devtools=local, telemetry=off">');
    expect(out.match(/name="genclass"/g)).toHaveLength(1);
    expect(editAppHtml(out, false)).toBe(false);
  });

  it("keeps an opt-out the developer wrote, whatever the answer", () => {
    const src = APP_HTML.replace("%sveltekit.head%", '<meta name="genclass" content="telemetry=no">\n\t\t%sveltekit.head%');
    expect(editAppHtml(src, false)).toBe(false);
    expect(editAppHtml(src, true)).toBe(false);
  });

  it("keeps CRLF line endings and falls back to </head>", () => {
    const crlf = '<html>\r\n  <head>\r\n    <meta charset="utf-8" />\r\n  </head>\r\n</html>\r\n';
    expect(editAppHtml(crlf, false)).toBe('<html>\r\n  <head>\r\n    <meta charset="utf-8" />\r\n    <meta name="genclass" content="telemetry=off" /> <!-- genclass:init -->\r\n  </head>\r\n</html>\r\n');
  });

  it("says when there is nowhere to put it", () => {
    expect(hasHeadSlot(APP_HTML)).toBe(true);
    expect(hasHeadSlot("<html><head>%sveltekit.head%</head><body></body></html>")).toBe(false);
    expect(editAppHtml("<html><head>%sveltekit.head%</head><body></body></html>", false)).toBe(false);
  });
});

describe("versions and modes", () => {
  it("asks for a range that holds the release the README documents and the one this repository builds", () => {
    const runtime = JSON.parse(readFileSync(new URL("../../runtime/package.json", import.meta.url), "utf8")) as { version: string };
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const documented = /\*\*Status: `@genclass\/runtime@([^`]+)`/.exec(readme)?.[1];
    expect(documented).toBeTruthy();
    expect(isRangeWithin(documented as string, RUNTIME_RANGE)).toBe(true);
    expect(isRangeWithin(runtime.version, RUNTIME_RANGE)).toBe(true);
    expect(isRangeWithin("0.4.0", RUNTIME_RANGE)).toBe(false);
  });

  it("reads the mode of every /auto entry", () => {
    expect(modeOf("@genclass/runtime/auto")).toBe("observe");
    expect(modeOf("@genclass/runtime/auto/observe")).toBe("observe");
    expect(modeOf("@genclass/runtime/auto/guard")).toBe("guard");
    expect(modeOf("@genclass/runtime/auto/heal")).toBe("heal");
    expect(modeOf("@genclass/runtime")).toBe(null);
  });
});
