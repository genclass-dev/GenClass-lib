// @genclass/nuxt: the generated code (exact text, from source.ts) and one real production build of
// test/fixtures/basic through @nuxt/test-utils: the page renders, the plugin is client-only, the config and the
// runtime are in the client bundle and nowhere in the server bundle.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $fetch, setup, useTestContext } from "@nuxt/test-utils/e2e";
import { describe, expect, it } from "vitest";
import { configSource, entryFor, overlayFor, pageConfig, pluginSource, validate } from "../src/source";

/** Every file under `dir` (recursively) whose name matches `re`, concatenated. */
function readAll(dir: string, re: RegExp): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out += readAll(p, re);
    else if (re.test(name)) out += readFileSync(p, "utf8");
  }
  return out;
}

describe("source: the plugin and config modules the module generates", () => {
  it("defaults: /auto, no config import, the overlay in development only", () => {
    const dev = pluginSource({}, true);
    expect(dev).toContain('import genclass from "@genclass/runtime/auto";');
    expect(dev).not.toContain("#build/genclass.config.mjs");
    expect(dev).toContain('import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));');
    const prod = pluginSource({}, false);
    expect(prod).toContain('import "@genclass/runtime/auto";');
    expect(prod).not.toContain("devtools");
    expect(prod).toContain("export default defineNuxtPlugin(() => {});");
  });

  it("mode guard imports /auto/guard", () => {
    expect(entryFor("guard")).toBe("@genclass/runtime/auto/guard");
    expect(entryFor("observe")).toBe("@genclass/runtime/auto");
    expect(entryFor(undefined)).toBe("@genclass/runtime/auto");
    expect(pluginSource({ mode: "guard" }, false)).toContain('import "@genclass/runtime/auto/guard";');
  });

  it("devtools: always loads the overlay in production too, never not even in development", () => {
    expect(overlayFor("always", false)).toBe(true);
    expect(overlayFor("never", true)).toBe(false);
    expect(overlayFor("dev", true)).toBe(true);
    expect(overlayFor("dev", false)).toBe(false);
    expect(overlayFor(undefined, true)).toBe(true);
    expect(pluginSource({ devtools: "always" }, false)).toContain("mountDevtools");
    expect(pluginSource({ devtools: "never" }, true)).not.toContain("devtools");
  });

  it("token and telemetry become window.GENCLASS_CONFIG, imported before the runtime", () => {
    expect(pageConfig({})).toBeNull();
    expect(pageConfig({ mode: "guard", devtools: "never" })).toBeNull();
    expect(pageConfig({ token: "" })).toBeNull();
    expect(pageConfig({ token: "gc_x", telemetry: false })).toEqual({ token: "gc_x", telemetry: false });
    expect(pageConfig({ telemetry: true })).toEqual({ telemetry: true });
    const src = pluginSource({ token: "gc_x" }, false);
    const cfgAt = src.indexOf('import "#build/genclass.config.mjs";');
    const autoAt = src.indexOf('import "@genclass/runtime/auto";');
    expect(cfgAt).toBeGreaterThan(-1);
    expect(autoAt).toBeGreaterThan(cfgAt);
    const cfg = configSource({ token: "gc_x", telemetry: false });
    expect(cfg).toContain('window.GENCLASS_CONFIG = Object.assign({"token":"gc_x","telemetry":false}, window.GENCLASS_CONFIG);');
    expect(cfg).toContain('typeof window !== "undefined"');
  });

  it("rejects values the runtime does not take, with a plain message", () => {
    expect(() => validate({})).not.toThrow();
    expect(() => validate({ mode: "guard", devtools: "never", token: "gc_x", telemetry: true })).not.toThrow();
    expect(() => validate({ mode: "heal" as never })).toThrow(/genclass\.mode must be "observe" or "guard"/);
    expect(() => validate({ devtools: true as never })).toThrow(/genclass\.devtools must be "dev", "always" or "never"/);
    expect(() => validate({ token: 42 as never })).toThrow(/genclass\.token must be a string/);
    expect(() => validate({ telemetry: "off" as never })).toThrow(/genclass\.telemetry must be true or false/);
  });
});

describe("build: a production build of test/fixtures/basic with the module, served", async () => {
  const rootDir = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
  await setup({ rootDir, server: true, browser: false });
  // test-utils builds into .nuxt/<id> and .output/<id> under the fixture; the context knows where
  const dirs = () => {
    const nuxt = useTestContext().nuxt;
    if (!nuxt) throw new Error("no Nuxt instance in the test context");
    const out = nuxt.options.nitro.output?.dir;
    if (!out) throw new Error("no nitro output dir in the test context");
    return { buildDir: nuxt.options.buildDir, outDir: out };
  };

  it("renders the page", async () => {
    const html = await $fetch<string>("/");
    expect(html).toContain("<div>basic</div>");
  });

  it("wrote a client-only plugin: the config first, then /auto/guard, and no overlay in a production build", () => {
    const { buildDir } = dirs();
    const plugin = readFileSync(join(buildDir, "genclass.client.mjs"), "utf8");
    const cfgAt = plugin.indexOf('import "#build/genclass.config.mjs";');
    const autoAt = plugin.indexOf('import "@genclass/runtime/auto/guard";');
    expect(cfgAt).toBeGreaterThan(-1);
    expect(autoAt).toBeGreaterThan(cfgAt);
    expect(plugin).not.toContain("devtools");
    const config = readFileSync(join(buildDir, "genclass.config.mjs"), "utf8");
    expect(config).toContain('{"token":"gc_test_token","telemetry":false}');
  });

  it("the runtime and the config are in the client bundle, and nowhere in the server bundle", () => {
    const { outDir } = dirs();
    const client = readAll(join(outDir, "public/_nuxt"), /\.js$/);
    expect(client).toContain("gc_test_token");
    expect(client).toContain("GENCLASS_CONFIG");
    expect(client).toContain("Disabled by ?genclass=off");
    const server = readAll(join(outDir, "server"), /\.m?js$/);
    expect(server).not.toContain("gc_test_token");
    expect(server).not.toContain("GENCLASS_CONFIG");
    expect(server).not.toContain("Disabled by ?genclass=off");
  });
});
