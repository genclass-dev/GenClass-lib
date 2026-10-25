// @genclass/astro: the generated page script (exact text), the hook's calls (what is injected per command), and one
// real `astro build` of test/fixtures/basic: the page's module script carries the runtime and the config.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "astro";
import { describe, expect, it } from "vitest";
import genclass, { CONFIG_MODULE, configSource, entryFor, overlayFor, pageConfig, pageScript, runtimeImports, validate } from "../src/index";

const FIXTURE = fileURLToPath(new URL("./fixtures/basic/", import.meta.url));

/** Runs the integration's config hook with fakes; returns the injected scripts and what it added to the Vite config. */
function runHook(options: Parameters<typeof genclass>[0], command: "dev" | "build" | "preview" | "sync") {
  const scripts: { stage: string; content: string }[] = [];
  const plugins: { name: string; resolveId(id: string): unknown; load(id: string): unknown }[] = [];
  const optimize: string[] = [];
  const integration = genclass(options);
  const hook = integration.hooks["astro:config:setup"];
  if (!hook) throw new Error("no astro:config:setup hook");
  hook({
    command,
    injectScript: (stage: string, content: string) => void scripts.push({ stage, content }),
    updateConfig: (cfg: { vite?: { plugins?: unknown[]; optimizeDeps?: { include?: string[] } } }) => {
      for (const p of cfg.vite?.plugins ?? []) plugins.push(p as (typeof plugins)[number]);
      optimize.push(...(cfg.vite?.optimizeDeps?.include ?? []));
      return cfg as never;
    },
  } as never);
  return { integration, scripts, plugins, optimize };
}

describe("pageScript: the script injected into every page", () => {
  it("defaults: /auto, no config import, the overlay under astro dev only", () => {
    const dev = pageScript({}, true);
    expect(dev).toBe('import genclass from "@genclass/runtime/auto";\nimport("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));\n');
    expect(pageScript({}, false)).toBe('import "@genclass/runtime/auto";\n');
  });

  it("mode guard imports /auto/guard", () => {
    expect(entryFor("guard")).toBe("@genclass/runtime/auto/guard");
    expect(entryFor(undefined)).toBe("@genclass/runtime/auto");
    expect(pageScript({ mode: "guard" }, false)).toBe('import "@genclass/runtime/auto/guard";\n');
  });

  it("devtools: always loads the overlay in builds too, never not even in dev", () => {
    expect(overlayFor("always", false)).toBe(true);
    expect(overlayFor("never", true)).toBe(false);
    expect(overlayFor(undefined, false)).toBe(false);
    expect(pageScript({ devtools: "always" }, false)).toContain("mountDevtools");
    expect(pageScript({ devtools: "never" }, true)).not.toContain("devtools");
  });

  it("token and telemetry become window.GENCLASS_CONFIG through a module imported before the runtime", () => {
    expect(pageConfig({})).toBeNull();
    expect(pageConfig({ token: "" })).toBeNull();
    expect(pageConfig({ token: "gc_x", telemetry: false })).toEqual({ token: "gc_x", telemetry: false });
    expect(pageScript({ token: "gc_x" }, false)).toBe(`import "${CONFIG_MODULE}";\nimport "@genclass/runtime/auto";\n`);
    expect(configSource({ telemetry: true })).toContain('window.GENCLASS_CONFIG = Object.assign({"telemetry":true}, window.GENCLASS_CONFIG);');
  });

  it("rejects values the runtime does not take", () => {
    expect(() => validate({})).not.toThrow();
    expect(() => genclass({ mode: "heal" as never })).toThrow(/mode must be "observe" or "guard"/);
    expect(() => genclass({ devtools: "local" as never })).toThrow(/devtools must be "dev", "always" or "never"/);
    expect(() => genclass({ token: 1 as never })).toThrow(/token must be a string/);
    expect(() => genclass({ telemetry: "no" as never })).toThrow(/telemetry must be true or false/);
  });
});

describe("the astro:config:setup hook", () => {
  it("is named, has a default export that is a function (astro add), and injects one page script", () => {
    const { integration, scripts, plugins, optimize } = runHook({}, "build");
    expect(integration.name).toBe("@genclass/astro");
    expect(typeof genclass).toBe("function");
    expect(scripts).toEqual([{ stage: "page", content: 'import "@genclass/runtime/auto";\n' }]);
    expect(plugins).toEqual([]);
    expect(optimize).toEqual(["@genclass/runtime/auto"]);
  });

  it("under astro dev the script also mounts the overlay; under build it does not", () => {
    expect(runHook({}, "dev").scripts[0].content).toContain("mountDevtools");
    expect(runHook({}, "build").scripts[0].content).not.toContain("devtools");
    expect(runHook({}, "preview").scripts[0].content).not.toContain("devtools");
    expect(runHook({ devtools: "always" }, "build").scripts[0].content).toContain("mountDevtools");
  });

  it("pre-declares the runtime modules the script imports for Vite's dependency optimizer", () => {
    expect(runtimeImports({}, false)).toEqual(["@genclass/runtime/auto"]);
    expect(runtimeImports({}, true)).toEqual(["@genclass/runtime/auto", "@genclass/runtime/devtools"]);
    expect(runtimeImports({ mode: "guard", devtools: "never" }, true)).toEqual(["@genclass/runtime/auto/guard"]);
    expect(runHook({}, "dev").optimize).toEqual(["@genclass/runtime/auto", "@genclass/runtime/devtools"]);
    expect(runHook({ mode: "guard" }, "build").optimize).toEqual(["@genclass/runtime/auto/guard"]);
  });

  it("with token or telemetry it adds the Vite plugin that serves the config module", () => {
    const { scripts, plugins } = runHook({ mode: "guard", token: "gc_x", telemetry: false }, "build");
    expect(scripts[0].content).toBe(`import "${CONFIG_MODULE}";\nimport "@genclass/runtime/auto/guard";\n`);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("@genclass/astro:config");
    const resolved = plugins[0].resolveId(CONFIG_MODULE) as string;
    expect(resolved).toBe(`\0${CONFIG_MODULE}`);
    expect(plugins[0].resolveId("other")).toBeUndefined();
    expect(plugins[0].load(resolved)).toContain('{"token":"gc_x","telemetry":false}');
    expect(plugins[0].load("other")).toBeUndefined();
  });
});

describe("build: astro build of test/fixtures/basic with the integration", () => {
  it("the page's module script carries the runtime and the config; no overlay in a production build", async () => {
    rmSync(join(FIXTURE, "dist"), { recursive: true, force: true });
    await build({
      root: FIXTURE,
      logLevel: "error",
      integrations: [genclass({ mode: "guard", token: "gc_test_token", telemetry: false })],
    });
    const html = readFileSync(join(FIXTURE, "dist/index.html"), "utf8");
    expect(html).toContain('<div id="basic">basic</div>');
    const m = /<script type="module" src="(\/_astro\/[^"]+\.js)"><\/script>/.exec(html);
    expect(m, "one bundled page script").not.toBeNull();
    const chunk = join(FIXTURE, "dist", m![1]);
    expect(existsSync(chunk)).toBe(true);
    // the entry chunk, plus every chunk it imports statically (the runtime may be split out)
    const seen = new Set<string>();
    const read = (file: string): string => {
      if (seen.has(file)) return "";
      seen.add(file);
      const src = readFileSync(file, "utf8");
      let out = src;
      for (const im of src.matchAll(/(?:^|[;\n])import[^"']*["'](\.\/[^"']+\.js)["']/g)) out += read(join(file, "..", im[1]));
      return out;
    };
    const js = read(chunk);
    expect(js).toContain("gc_test_token");
    expect(js).toContain("GENCLASS_CONFIG");
    expect(js).toContain("Disabled by ?genclass=off");
  });
});
