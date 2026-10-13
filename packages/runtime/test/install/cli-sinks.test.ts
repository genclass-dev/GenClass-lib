// `genclass-runtime init --sink <name>`: findings in the tools the developer already opens, written into the project
// with no code (the option file, data-sink on a script tag, sink= in the Astro meta line), and the suggestion when
// the project depends on Sentry, PostHog or Datadog. Fixture projects, no network, no package manager (--no-install).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM module without types
import { configLiteral, isEmptyConfig, metaContent, sinkImports, tagWithConfig, updateConfigText } from "../../bin/lib/edit.mjs";
// @ts-expect-error plain ESM module without types
import { USAGE, configOf, monitoringSdks, withSinkSdks } from "../../bin/lib/init.mjs";
import { fromDataset, readMetaConfig } from "../../src/cdn/config.js";
import { parseSinkSpec } from "../../src/cdn/sinks-fanout.js";
import { applySinks } from "../../src/cdn/sinks.js";
import { posthog } from "../../src/sinks/posthog.js";
import { sentry } from "../../src/sinks/sentry.js";
import type { Sink, SinkObject } from "../../src/types.js";
import { defaultScript, drain, setup } from "../helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const PKG_JSON = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8")) as {
  exports: Record<string, string | { types?: string; import?: string }>;
  typesVersions?: Record<string, Record<string, string[]>>;
};
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-sink-"));
  roots.push(dir);
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
  return dir;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

function cli(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args, "--cwd", dir], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

/** init --yes, init again (no change), remove --yes (byte for byte). Returns the files after init. */
function roundTrip(dir: string, ...initArgs: string[]): Record<string, string> {
  const before = snapshot(dir);
  const r1 = cli(dir, "init", "--yes", "--no-install", ...initArgs);
  expect(r1.code, r1.out).toBe(0);
  const after = snapshot(dir);
  expect(after).not.toEqual(before);
  const r2 = cli(dir, "init", "--yes", "--no-install", ...initArgs);
  expect(r2.code, r2.out).toBe(0);
  expect(r2.out).toContain("Nothing to do");
  expect(snapshot(dir)).toEqual(after);
  const r3 = cli(dir, "remove", "--yes");
  expect(r3.code, r3.out).toBe(0);
  expect(snapshot(dir)).toEqual(before);
  return after;
}

const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", private: true, dependencies: deps }, null, 2) + "\n";
const VITE_HTML = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>Vite</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n`;
const VITE_MAIN = `import { createApp } from "vue";\nimport App from "./App.vue";\n\ncreateApp(App).mount("#app");\n`;
const viteVue = (deps: Record<string, string> = {}) => project({ "package.json": pkg({ vue: "^3", vite: "^7", ...deps }), "index.html": VITE_HTML, "src/main.js": VITE_MAIN });
const PAGE = `<!doctype html>\n<html>\n<head>\n  <title>x</title>\n</head>\n<body></body>\n</html>\n`;
const astro = (deps: Record<string, string> = {}) =>
  project({
    "package.json": pkg({ astro: "^5", ...deps }),
    "src/layouts/Layout.astro": `---\n---\n<html>\n\t<head>\n\t\t<title>x</title>\n\t</head>\n\t<body><slot /></body>\n</html>\n`,
  });

/**
 * Runs an option file init wrote, its imports taken from `mods` (a shim for exactly the import forms init writes), and
 * returns the global it set GENCLASS_CONFIG on.
 */
function runOptionFile(src: string, mods: Record<string, Record<string, unknown>>): { GENCLASS_CONFIG?: { sinks: (string | Sink)[] } } {
  const body = src
    .replace(/^import \* as (\w+) from "([^"]+)";$/gm, (_m, name: string, spec: string) => `const ${name} = __m(${JSON.stringify(spec)});`)
    .replace(/^import (\w+) from "([^"]+)";$/gm, (_m, name: string, spec: string) => `const ${name} = __m(${JSON.stringify(spec)}).default;`)
    .replace(/^import \{ (\w+)(?: as (\w+))? \} from "([^"]+)";$/gm, (_m, name: string, alias: string | undefined, spec: string) => `const ${alias ?? name} = __m(${JSON.stringify(spec)}).${name};`);
  expect(body).not.toMatch(/^\s*import\b/m);
  const win: { GENCLASS_CONFIG?: { sinks: (string | Sink)[] } } = {};
  const need = (spec: string) => {
    if (!mods[spec]) throw new Error(`the option file imports ${spec}`);
    return mods[spec];
  };
  new Function("__m", "globalThis", body)(need, win);
  return win;
}

const DELAY = defaultScript({ request: { diagnosis: "overload", action: "delay" } });

describe("init --sink: findings in the tools the developer already opens", () => {
  it("Vite: --sink sentry writes sinks: [\"sentry\"] to genclass.config.js, imported right before /auto; remove restores everything", () => {
    const dir = viteVue();
    const r = cli(dir, "init", "--dry-run", "--no-install", "--sink", "sentry");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Findings\s+sentry \(--sink, written to src\/genclass\.config\.js\)/);
    expect(r.out).toContain("Sentry.captureMessage");
    const after = roundTrip(dir, "--sink", "sentry");
    expect(after["src/main.js"].split("\n").slice(0, 2)).toEqual([`import "./genclass.config"; // genclass:init`, `import genclass from "@genclass/runtime/auto"; // genclass:init`]);
    expect(after["src/genclass.config.js"]).toContain(`globalThis.GENCLASS_CONFIG = { sinks: ["sentry"] };`);
    expect(after["src/genclass.config.js"]).toContain("genclass:init start");
    const applied = cli(viteVue(), "init", "--yes", "--no-install", "--sink", "sentry");
    expect(applied.out).toContain("They also reach sentry");
  });

  it("repeated flags and comma lists keep their order; webhook:<url>; an unknown name is a usage error", () => {
    const dir = viteVue();
    const r = cli(dir, "init", "--yes", "--no-install", "--sink", "sentry", "--sink", "posthog,webhook:/genclass", "--sink", "sentry");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Findings\s+sentry, posthog, webhook:\/genclass/);
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).toContain(`GENCLASS_CONFIG = { sinks: ["sentry", "posthog", "webhook:/genclass"] };`);
    const bad = cli(viteVue(), "init", "--yes", "--no-install", "--sink", "bogus");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("--sink bogus");
    expect(bad.out).toContain("webhook:<url>");
    const noValue = cli(viteVue(), "init", "--yes", "--no-install", "--sink");
    expect(noValue.code).toBe(2);
    expect(configOf({ sinks: ["sentry"] })).toEqual({ sinks: ["sentry"] });
    expect(configOf({})).toEqual({});
  });

  it("the written statement is what /auto reads: applySinks turns the names into one lazy proxy and ignores the webhook URL", () => {
    const dir = viteVue();
    cli(dir, "init", "--yes", "--no-install", "--sink", "sentry,webhook:/genclass");
    const stmt = readFileSync(join(dir, "src/genclass.config.js"), "utf8").split("\n").find((l) => l.startsWith("globalThis."))!;
    const win: { GENCLASS_CONFIG?: { sinks: string[] } } = {};
    new Function("globalThis", stmt)(win);
    expect(win.GENCLASS_CONFIG).toEqual({ sinks: ["sentry", "webhook:/genclass"] });
    for (const s of win.GENCLASS_CONFIG!.sinks) expect(parseSinkSpec(s), s).not.toBeNull();
    const resolve = vi.fn(() => Promise.resolve({ send: vi.fn() }));
    const warn = vi.fn();
    const init = applySinks({}, win.GENCLASS_CONFIG!.sinks, resolve, warn, {});
    expect(init.sinks!.length).toBe(1);
    // the webhook's own endpoint, exactly (a function matcher: /genclass, not /genclassic)
    const ignore = init.requests!.ignore as ((r: { url: string; method: string; channel: "fetch" }) => boolean)[];
    expect(ignore.length).toBe(1);
    expect(ignore[0]({ url: "http://app.test/genclass", method: "POST", channel: "fetch" })).toBe(true);
    expect(ignore[0]({ url: "http://app.test/genclassic", method: "GET", channel: "fetch" })).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("with --no-telemetry: one object with both; on an existing setup --sink adds the option file, a later flag keeps the sinks, another --sink replaces them", () => {
    const both = roundTrip(viteVue(), "--no-telemetry", "--sink", "sentry");
    expect(both["src/genclass.config.js"]).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["sentry"] };`);
    const dir = viteVue();
    const before = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const r = cli(dir, "init", "--yes", "--no-install", "--sink", "sentry");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("sinks sentry");
    const cfg = join(dir, "src/genclass.config.js");
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { sinks: ["sentry"] };`);
    expect(readFileSync(join(dir, "src/main.js"), "utf8").split("\n").slice(0, 2)).toEqual([`import "./genclass.config"; // genclass:init`, `import genclass from "@genclass/runtime/auto"; // genclass:init`]);
    expect(cli(dir, "init", "--yes", "--no-install", "--no-telemetry").code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["sentry"] };`);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "posthog,datadog").code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["posthog", "datadog"] };`);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "posthog,datadog").out).toContain("Nothing to do");
    expect(cli(dir, "remove", "--yes").code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it("plain HTML: data-sink on the script tag (what the tag parses back); Astro: sink=a+b in the meta line (what the meta parser reads back)", () => {
    const html = roundTrip(project({ "index.html": PAGE }), "--sink", "sentry,posthog", "--no-sri");
    expect(html["index.html"]).toContain(` data-devtools="local" data-sink="sentry,posthog"></script> <!-- genclass:init -->`);
    expect(fromDataset({ sink: "sentry,posthog" })).toEqual({ sinks: ["sentry", "posthog"] });
    const dir = project({ "index.html": PAGE });
    cli(dir, "init", "--yes", "--no-install", "--sink", "sentry", "--no-sri");
    cli(dir, "init", "--yes", "--no-install", "--sink", "webhook:/genclass");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain(`data-sink="webhook:/genclass"`);
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain(`data-sink="sentry"`);
    const layout = roundTrip(astro(), "--sink", "sentry,posthog")["src/layouts/Layout.astro"];
    expect(layout).toMatch(/\t\t<meta name="genclass" content="sink=sentry\+posthog" \/> <!-- genclass:init -->\n\t\t<script>import genclass/);
    const content = /content="([^"]*)"/.exec(layout)![1];
    expect(readMetaConfig({ querySelectorAll: () => [{ getAttribute: () => content }] })).toEqual({ sinks: ["sentry", "posthog"] });
    const withTelemetry = roundTrip(astro(), "--no-telemetry", "--sink", "sentry")["src/layouts/Layout.astro"];
    expect(withTelemetry).toContain(`content="telemetry=off, sink=sentry"`);
    // a meta tag only takes a same-origin webhook URL: init says so for an absolute one (a path is fine)
    const far = cli(astro(), "init", "--dry-run", "--no-install", "--sink", "webhook:https://hooks.example/g");
    expect(far.code, far.out).toBe(0);
    expect(far.out).toContain("only takes a same-origin webhook URL");
    expect(far.out).toContain(`window.GENCLASS_CONFIG = { sinks: ["webhook:https://hooks.example/g"] }`);
    expect(cli(astro(), "init", "--dry-run", "--no-install", "--sink", "webhook:/genclass").out).not.toContain("same-origin webhook URL");
  });

  it("suggests --sink when the project depends on @sentry/*, posthog-js or @datadog/browser-rum, and stays quiet once a sink is set", () => {
    expect(monitoringSdks({ deps: { "@sentry/react": "^9", "@sentry/tracing": "^7", "posthog-js": "^1", react: "^19" } })).toEqual([
      { sink: "sentry", dep: "@sentry/react" },
      { sink: "posthog", dep: "posthog-js" },
    ]);
    expect(monitoringSdks({ deps: { "@datadog/browser-rum": "^6" } })).toEqual([{ sink: "datadog", dep: "@datadog/browser-rum" }]);
    expect(monitoringSdks({ deps: { "@datadog/browser-rum-slim": "^6" } })).toEqual([{ sink: "datadog", dep: "@datadog/browser-rum-slim" }]);
    expect(monitoringSdks({ deps: {} })).toEqual([]);
    expect(monitoringSdks({})).toEqual([]);
    const dir = viteVue({ "@sentry/vue": "^9", "posthog-js": "^1" });
    const r = cli(dir, "init", "--dry-run", "--no-install");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("found @sentry/vue, posthog-js; not applied");
    expect(r.out).toContain("init --sink sentry,posthog");
    expect(r.out).toContain("not yours");
    const partial = cli(dir, "init", "--dry-run", "--no-install", "--sink", "sentry");
    expect(partial.out).toContain("init --sink posthog");
    expect(partial.out).not.toContain("init --sink sentry,posthog");
    const none = cli(viteVue(), "init", "--dry-run", "--no-install");
    expect(none.out).not.toContain("init --sink");
    // an existing setup: suggested until a sink is written, then quiet
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    expect(cli(dir, "init", "--dry-run", "--no-install").out).toContain("init --sink sentry,posthog");
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "sentry,posthog").code).toBe(0);
    expect(cli(dir, "init", "--dry-run", "--no-install").out).not.toContain("init --sink");
    const dd = cli(viteVue({ "@datadog/browser-rum": "^6" }), "init", "--dry-run", "--no-install");
    expect(dd.out).toContain("init --sink datadog");
  });

  it("with @sentry/* or posthog-js from npm (no page global), init writes the adapter with the app's SDK passed in, and it reaches that SDK", async () => {
    const dir = viteVue({ "@sentry/vue": "^9", "@sentry/vite-plugin": "^3", "posthog-js": "^1", "@datadog/browser-rum": "^6" });
    const dry = cli(dir, "init", "--dry-run", "--no-install", "--sink", "sentry,posthog:noevidence,datadog,webhook:/genclass");
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain("sentry: Sentry.captureMessage per record, grouped per bug, through @sentry/vue (imported there, passed to the adapter)");
    expect(dry.out).toContain("posthog:noevidence: posthog.capture");
    expect(dry.out).toContain("through window.DD_RUM");
    expect(dry.out).toContain("posthog:noevidence: the structured fields only");
    expect(dry.out).toContain("--sink sentry:noevidence");
    const after = roundTrip(dir, "--sink", "sentry,posthog:noevidence,datadog,webhook:/genclass");
    const file = after["src/genclass.config.js"];
    expect(file.split("\n").filter((l) => l.startsWith("import "))).toEqual([
      `import * as Sentry from "@sentry/vue";`,
      `import { sentry as sentrySink } from "@genclass/runtime/sinks/sentry";`,
      `import posthog from "posthog-js";`,
      `import { posthog as posthogSink } from "@genclass/runtime/sinks/posthog";`,
    ]);
    expect(file).toContain(`globalThis.GENCLASS_CONFIG = { sinks: [sentrySink({ sentry: Sentry }), posthogSink({ posthog, evidence: false }), "datadog", "webhook:/genclass"] };`);
    expect(file).not.toContain("vite-plugin");
    // run the file as the app's bundler would, with fake SDKs: the records reach them
    const fakeSentry = { captureMessage: vi.fn() };
    const fakePosthog = { capture: vi.fn() };
    const win = runOptionFile(file, {
      "@sentry/vue": fakeSentry,
      "posthog-js": { default: fakePosthog },
      "@genclass/runtime/sinks/sentry": { sentry },
      "@genclass/runtime/sinks/posthog": { posthog },
    });
    const listed = win.GENCLASS_CONFIG!.sinks;
    expect(listed.slice(2)).toEqual(["datadog", "webhook:/genclass"]);
    const init = applySinks({}, listed, () => Promise.resolve({ send: vi.fn() }), vi.fn(), {});
    expect(init.sinks!.length).toBe(3); // the two adapters as they are, the names as one proxy
    expect((init.sinks![1] as SinkObject).evidence).toBe(false);
    const s = setup({ sinks: init.sinks, triage: "always", script: DELAY });
    s.server.on("GET", "/api/x", { body: 1, latency: 5 });
    const p = s.fetch("/api/x").catch(() => undefined);
    await s.clock.advance(2000);
    await p;
    await s.clock.advance(10);
    await drain(8);
    expect(s.rt.interventions().length).toBe(1);
    expect(fakeSentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(fakeSentry.captureMessage.mock.calls[0][0]).toMatch(/^\[GenClass\] Slowed down an overload request/);
    expect(fakePosthog.capture).toHaveBeenCalledTimes(1);
    const [event, props] = fakePosthog.capture.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe("genclass_intervention");
    expect(props.diagnosis).toBe("overload");
    expect(props.message).toBeUndefined(); // posthog:noevidence
  });

  it("an import-based option file switches in place: another --sink rewrites the imports with the sinks; remove takes it all out", () => {
    const dir = viteVue({ "@sentry/react": "^9", "posthog-js": "^1" });
    const before = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "sentry").code).toBe(0);
    const cfg = join(dir, "src/genclass.config.js");
    expect(readFileSync(cfg, "utf8")).toContain(`import * as Sentry from "@sentry/react";`);
    const r = cli(dir, "init", "--yes", "--no-install", "--sink", "posthog,console-json");
    expect(r.code, r.out).toBe(0);
    const text = readFileSync(cfg, "utf8");
    expect(text).not.toContain("Sentry");
    expect(text).toContain(`import posthog from "posthog-js";\nimport { posthog as posthogSink } from "@genclass/runtime/sinks/posthog";\nglobalThis.GENCLASS_CONFIG = { sinks: [posthogSink({ posthog }), "console-json"] };`);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "posthog,console-json").out).toContain("Nothing to do");
    expect(cli(dir, "init", "--yes", "--no-install", "--no-telemetry").code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: [posthogSink({ posthog }), "console-json"] };`);
    expect(readFileSync(cfg, "utf8")).toContain(`import posthog from "posthog-js";`);
    expect(cli(dir, "remove", "--yes").code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    // the edit helpers alone
    expect(updateConfigText(`// x\nglobalThis.GENCLASS_CONFIG = { sinks: ["sentry"] };\n`, { sinks: ["sentry"], sdks: { sentry: "@sentry/browser" } })).toBe(
      `// x\nimport * as Sentry from "@sentry/browser";\nimport { sentry as sentrySink } from "@genclass/runtime/sinks/sentry";\nglobalThis.GENCLASS_CONFIG = { sinks: [sentrySink({ sentry: Sentry })] };\n`,
    );
    expect(sinkImports({ sinks: ["sentry", "sentry:noevidence"], sdks: { sentry: "@sentry/browser" } })).toEqual([`import * as Sentry from "@sentry/browser";`, `import { sentry as sentrySink } from "@genclass/runtime/sinks/sentry";`]);
    expect(configLiteral({ sinks: ["sentry:noevidence", "datadog:noevidence"], sdks: { sentry: "@sentry/browser" } })).toBe(`{ sinks: [sentrySink({ sentry: Sentry, evidence: false }), "datadog:noevidence"] }`);
  });

  it("only Sentry's browser SDKs count (framework ones first), never its build plugins or server SDKs; Astro and plain HTML say what a name needs", () => {
    expect(monitoringSdks({ deps: { "@sentry/vite-plugin": "^3", "@sentry/node": "^8", "@sentry/cli": "^2" } })).toEqual([]);
    expect(monitoringSdks({ deps: { "@sentry/browser": "^9", "@sentry/nextjs": "^9" } })).toEqual([{ sink: "sentry", dep: "@sentry/nextjs" }]);
    expect(withSinkSdks({ sinks: ["sentry", "datadog"] }, { framework: "vite", deps: { "@sentry/vue": "^9", "@datadog/browser-rum": "^6" } })).toEqual({ sinks: ["sentry", "datadog"], sdks: { sentry: "@sentry/vue" } });
    expect(withSinkSdks({ sinks: ["sentry"] }, { framework: "astro", deps: { "@sentry/astro": "^9" } })).toEqual({ sinks: ["sentry"] });
    expect(withSinkSdks({ sinks: ["sentry"] }, { framework: "vite", deps: {} })).toEqual({ sinks: ["sentry"] });
    const a = cli(astro({ "@sentry/astro": "^9" }), "init", "--dry-run", "--no-install", "--sink", "sentry");
    expect(a.code, a.out).toBe(0);
    expect(a.out).toContain("@sentry/astro from npm sets no window.Sentry");
    expect(a.out).toContain("window.Sentry = Sentry;");
    const adv = cli(astro({ "@sentry/astro": "^9" }), "init", "--dry-run", "--no-install");
    expect(adv.out).toContain("init --sink sentry");
    expect(adv.out).toContain("window.Sentry = Sentry;");
    const vite = cli(viteVue({ "@sentry/vue": "^9" }), "init", "--dry-run", "--no-install");
    expect(vite.out).toContain("init writes the adapter with your @sentry/vue into its option file");
    // --sink takes the evidence option; anything else after the name is a usage error
    expect(cli(viteVue(), "init", "--dry-run", "--no-install", "--sink", "sentry:noevidence").code).toBe(0);
    const bad = cli(viteVue(), "init", "--dry-run", "--no-install", "--sink", "sentry:bogus");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain(":noevidence");
  });

  it("USAGE documents --sink; package.json exports every adapter with types, mapped in typesVersions", () => {
    expect(USAGE).toContain("--sink sentry|posthog|datadog|console-json|webhook:<url>");
    expect(USAGE).toContain("--sink <name>");
    const map = PKG_JSON.typesVersions?.["*"] ?? {};
    for (const name of ["index", "sentry", "posthog", "datadog", "console-json", "webhook"]) {
      const key = name === "index" ? "./sinks" : `./sinks/${name}`;
      expect(PKG_JSON.exports[key], key).toEqual({ types: `./dist/sinks/${name}.d.ts`, import: `./dist/sinks/${name}.js` });
      expect(map[key.slice(2)], key).toEqual([`./dist/sinks/${name}.d.ts`]);
    }
  });

  it("edit helpers carry sinks: configLiteral, updateConfigText, metaContent, tagWithConfig, isEmptyConfig", () => {
    expect(configLiteral({ sinks: ["sentry"] })).toBe(`{ sinks: ["sentry"] }`);
    expect(configLiteral({ telemetry: false, sinks: ["sentry", "webhook:/g"] })).toBe(`{ telemetry: false, sinks: ["sentry", "webhook:/g"] }`);
    expect(configLiteral({ sinks: [] })).toBe("{}");
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { telemetry: false };`, { sinks: ["sentry"] })).toBe(`globalThis.GENCLASS_CONFIG = { telemetry: false, sinks: ["sentry"] };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = {};`, { sinks: ["sentry"] })).toBe(`globalThis.GENCLASS_CONFIG = { sinks: ["sentry"] };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { sinks: ["sentry"], debug: true };`, { sinks: ["posthog"] })).toBe(`globalThis.GENCLASS_CONFIG = { sinks: ["posthog"], debug: true };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { sinks: ["sentry"] };`, { telemetry: false })).toBe(`globalThis.GENCLASS_CONFIG = { telemetry: false, sinks: ["sentry"] };`);
    expect(metaContent({ sinks: ["sentry", "posthog"] })).toBe("sink=sentry+posthog");
    expect(metaContent({ telemetry: false, sinks: ["webhook:/g"] })).toBe("telemetry=off, sink=webhook:/g");
    expect(tagWithConfig(`<script src="x">`, { sinks: ["sentry", "posthog"] })).toBe(`<script src="x" data-sink="sentry,posthog">`);
    expect(tagWithConfig(`<script src="x" data-sink="sentry">`, { sinks: ["datadog"] })).toBe(`<script src="x" data-sink="datadog">`);
    expect(isEmptyConfig({ sinks: [] })).toBe(true);
    expect(isEmptyConfig({ sinks: ["sentry"] })).toBe(false);
    expect(isEmptyConfig({})).toBe(true);
  });
});
