// The page scripts as Wrangler ships them. Wrangler bundles with esbuild's keepNames, which wraps named functions in a
// __name() helper. installPrompt and openSourcePrompt reach the browser as their own source (fn.toString()), where
// that helper does not exist, so a named inner function in them breaks the page (it did: /start/open-source's choices
// threw "__name is not defined"). vitest's transform has no keepNames, so the other tests cannot see this.
import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

/** src/pages.ts bundled as Wrangler does (esm, keepNames), imported. */
async function bundledPages() {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../src/pages.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    keepNames: true,
    write: false,
    logLevel: "silent",
  });
  const code = out.outputFiles[0]!.text;
  const file = join(tmpdir(), `genclass-pages-${process.pid}-${code.length}.mjs`);
  writeFileSync(file, code);
  try {
    return { code, mod: (await import(pathToFileURL(file).href)) as typeof import("../src/pages.js") };
  } finally {
    rmSync(file, { force: true });
  }
}

describe("page scripts survive Wrangler's bundling (keepNames)", () => {
  it("no inline script names the __name helper or holds a control character, and /start/open-source's choices still rewrite its prompt", async () => {
    const { code, mod } = await bundledPages();
    // keepNames is on: the bundle defines the helper, so this test exercises it
    expect(code).toContain("__name");
    const project = { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
    const pages: [string, string][] = [
      ["/start/open-source", mod.openSourcePage("NONCE")],
      ["/start", mod.startPage("NONCE")],
      ["/dashboard", mod.dashboardPage("NONCE", project)],
    ];
    for (const [name, html] of pages) {
      // a raw control character is an HTML parse error (the bundle prints escapes such as "\u0001" as the character)
      expect(html, name).not.toMatch(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      const scripts = [...html.matchAll(/<script nonce="NONCE">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length, name).toBeGreaterThan(0);
      for (const s of scripts) expect(s, name).not.toContain("__name(");
    }
    // run /start/open-source's script from the bundle: ticking guard puts it in the copied prompt
    const html = pages[0]![1];
    const script = /<script nonce="NONCE">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const win = new Window({ url: "https://genclass.dev/start/open-source" });
    win.document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, "");
    new Function("window", "document", "location", "navigator", script)(win, win.document, win.location, win.navigator);
    (win.document.querySelector('#choices [data-choice="guard"]') as unknown as HTMLInputElement).click();
    expect(win.document.getElementById("cp")!.getAttribute("data-copy")).toBe(mod.openSourcePrompt({ guard: true }));
    expect(win.document.getElementById("cp")!.getAttribute("data-copy")).toContain('mode: "guard"');
    await win.happyDOM.close();
  });
});
