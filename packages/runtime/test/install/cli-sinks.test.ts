// `genclass-runtime init --sink <name>`: findings on the developer's own side (console-json, webhook:<url>), written
// into the project with no code (the option file, data-sink on a script tag, sink= in the Astro meta line). The runtime
// has no Sentry, PostHog or Datadog adapter (the genclass.dev collector forwards detections to them, free, from the
// app's dashboard): `--sink sentry` is a usage error that says so, and init suggests no sink for a project that depends
// on those SDKs.
// Fixture projects, no network, no package manager (--no-install).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM module without types
import { configLiteral, isEmptyConfig, metaContent, tagWithConfig, updateConfigText } from "../../bin/lib/edit.mjs";
// @ts-expect-error plain ESM module without types
import { FORWARDING_URL, USAGE, configOf } from "../../bin/lib/init.mjs";
import { fromDataset, readMetaConfig } from "../../src/cdn/config.js";
import { parseSinkSpec } from "../../src/cdn/sinks-fanout.js";
import { applySinks } from "../../src/cdn/sinks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
// Every CLI run gets cli.test.ts's fake fetch, failing like being offline: `init --yes` on a fresh project would
// otherwise create a real project at https://genclass.dev/api/projects (it then sets GenClass up without a token).
const MOCK_FETCH = resolve(HERE, "mock-fetch.mjs");
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
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(MOCK_FETCH).href, BIN, ...args, "--cwd", dir], {
      encoding: "utf8",
      env: { ...process.env, GENCLASS_TEST_FETCH: "fail", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

/** The usage error init prints for a --sink value that names a vendor (the first line of its output). */
const vendorError = (value: string) =>
  `genclass-runtime init: --sink ${value}: the runtime has no Sentry, PostHog or Datadog adapter; the genclass.dev collector forwards detections to them, free, once you turn it on in the app's dashboard: https://genclass.dev/docs#dashboard. The sinks here are console-json (optionally :noevidence) and webhook:<url>`;

describe("init --sink: findings on the developer's own side", () => {
  it("Vite: --sink webhook:/genclass writes sinks: [\"webhook:/genclass\"] to genclass.config.js, imported right before /auto; remove restores everything", () => {
    const dir = viteVue();
    const r = cli(dir, "init", "--dry-run", "--no-install", "--sink", "webhook:/genclass");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Findings\s+webhook:\/genclass \(--sink, written to src\/genclass\.config\.js\)/);
    expect(r.out).toContain("batched POSTs of the records to your endpoint");
    const after = roundTrip(dir, "--sink", "webhook:/genclass");
    expect(after["src/main.js"].split("\n").slice(0, 2)).toEqual([`import "./genclass.config"; // genclass:init`, `import genclass from "@genclass/runtime/auto"; // genclass:init`]);
    expect(after["src/genclass.config.js"]).toContain(`globalThis.GENCLASS_CONFIG = { sinks: ["webhook:/genclass"] };`);
    expect(after["src/genclass.config.js"]).toContain("genclass:init start");
    expect(after["src/genclass.config.js"].split("\n").filter((l) => l.startsWith("import "))).toEqual([]);
    const applied = cli(viteVue(), "init", "--yes", "--no-install", "--sink", "console-json");
    expect(applied.out).toContain("They also reach console-json: one JSON line per record on the console");
  });

  it("repeated flags and comma lists keep their order; webhook:<url>; an unknown name is a usage error", () => {
    const dir = viteVue();
    const r = cli(dir, "init", "--yes", "--no-install", "--sink", "console-json", "--sink", "webhook:/genclass,console-json:noevidence", "--sink", "console-json");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Findings\s+console-json, webhook:\/genclass, console-json:noevidence/);
    expect(r.out).toContain("console-json:noevidence: one JSON line per record on the console (the structured fields only, no evidence text)");
    expect(readFileSync(join(dir, "src/genclass.config.js"), "utf8")).toContain(`GENCLASS_CONFIG = { sinks: ["console-json", "webhook:/genclass", "console-json:noevidence"] };`);
    const bad = cli(viteVue(), "init", "--yes", "--no-install", "--sink", "bogus");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("--sink bogus: the sinks are console-json (optionally :noevidence) and webhook:<url>");
    const noValue = cli(viteVue(), "init", "--yes", "--no-install", "--sink");
    expect(noValue.code).toBe(2);
    // the evidence option only; anything else after the name is a usage error
    expect(cli(viteVue(), "init", "--dry-run", "--no-install", "--sink", "console-json:noevidence").code).toBe(0);
    const opt = cli(viteVue(), "init", "--dry-run", "--no-install", "--sink", "console-json:bogus");
    expect(opt.code).toBe(2);
    expect(opt.out).toContain(":noevidence");
    expect(configOf({ sinks: ["webhook:/g"] })).toEqual({ sinks: ["webhook:/g"] });
    expect(configOf({})).toEqual({});
  });

  it("--sink sentry, posthog or datadog: a usage error that the runtime has no adapter for them and that the collector forwards, free, from the dashboard; nothing is written", () => {
    expect(FORWARDING_URL).toBe("https://genclass.dev/docs#dashboard");
    for (const value of ["sentry", "posthog", "datadog", "Sentry:noevidence", "posthog=evidence"]) {
      const dir = viteVue({ "@sentry/vue": "^9" });
      const before = snapshot(dir);
      const r = cli(dir, "init", "--yes", "--no-install", "--sink", value);
      expect(r.code, `${value}: ${r.out}`).toBe(2);
      expect(r.out.split("\n")[0], value).toBe(vendorError(value));
      expect(snapshot(dir), value).toEqual(before);
    }
    // in a comma list too, after a sink that is fine
    const mixed = cli(viteVue(), "init", "--dry-run", "--no-install", "--sink", "webhook:/genclass,datadog");
    expect(mixed.code).toBe(2);
    expect(mixed.out.split("\n")[0]).toBe(vendorError("datadog"));
  });

  it("a project that depends on @sentry/*, posthog-js or @datadog/browser-rum gets no --sink suggestion and no vendor sink", () => {
    const dir = viteVue({ "@sentry/vue": "^9", "posthog-js": "^1", "@datadog/browser-rum": "^6" });
    const r = cli(dir, "init", "--dry-run", "--no-install");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("--sink");
    expect(r.out).not.toContain("Findings");
    expect(r.out).not.toMatch(/window\.Sentry|sentrySink|@genclass\/runtime\/sinks\//);
    const applied = cli(dir, "init", "--yes", "--no-install");
    expect(applied.code, applied.out).toBe(0);
    expect(applied.out).not.toContain("--sink");
    const files = snapshot(dir);
    expect(Object.values(files).some((t) => /sinks\s*:|data-sink|sink=/.test(t))).toBe(false);
  });

  it("the written statement is what /auto reads: applySinks turns the names into one lazy proxy and ignores the webhook URL", () => {
    const dir = viteVue();
    cli(dir, "init", "--yes", "--no-install", "--sink", "console-json,webhook:/genclass");
    const stmt = readFileSync(join(dir, "src/genclass.config.js"), "utf8").split("\n").find((l) => l.startsWith("globalThis."))!;
    const win: { GENCLASS_CONFIG?: { sinks: string[] } } = {};
    new Function("globalThis", stmt)(win);
    expect(win.GENCLASS_CONFIG).toEqual({ sinks: ["console-json", "webhook:/genclass"] });
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
    const both = roundTrip(viteVue(), "--no-telemetry", "--sink", "webhook:/genclass");
    expect(both["src/genclass.config.js"]).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["webhook:/genclass"] };`);
    const dir = viteVue();
    const before = snapshot(dir);
    expect(cli(dir, "init", "--yes", "--no-install").code).toBe(0);
    const r = cli(dir, "init", "--yes", "--no-install", "--sink", "webhook:/genclass");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("sinks webhook:/genclass");
    const cfg = join(dir, "src/genclass.config.js");
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { sinks: ["webhook:/genclass"] };`);
    expect(readFileSync(join(dir, "src/main.js"), "utf8").split("\n").slice(0, 2)).toEqual([`import "./genclass.config"; // genclass:init`, `import genclass from "@genclass/runtime/auto"; // genclass:init`]);
    expect(cli(dir, "init", "--yes", "--no-install", "--no-telemetry").code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["webhook:/genclass"] };`);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "console-json,webhook:/collect").code).toBe(0);
    expect(readFileSync(cfg, "utf8")).toContain(`GENCLASS_CONFIG = { telemetry: false, sinks: ["console-json", "webhook:/collect"] };`);
    expect(cli(dir, "init", "--yes", "--no-install", "--sink", "console-json,webhook:/collect").out).toContain("Nothing to do");
    expect(cli(dir, "remove", "--yes").code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  it("plain HTML: data-sink on the script tag (what the tag parses back); Astro: sink=a+b in the meta line (what the meta parser reads back)", () => {
    const html = roundTrip(project({ "index.html": PAGE }), "--sink", "console-json,webhook:/genclass", "--no-sri");
    expect(html["index.html"]).toContain(` data-devtools="local" data-sink="console-json,webhook:/genclass"></script> <!-- genclass:init -->`);
    expect(fromDataset({ sink: "console-json,webhook:/genclass" })).toEqual({ sinks: ["console-json", "webhook:/genclass"] });
    const dir = project({ "index.html": PAGE });
    cli(dir, "init", "--yes", "--no-install", "--sink", "console-json", "--no-sri");
    cli(dir, "init", "--yes", "--no-install", "--sink", "webhook:/genclass");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain(`data-sink="webhook:/genclass"`);
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain(`data-sink="console-json"`);
    const layout = roundTrip(astro(), "--sink", "console-json,webhook:/genclass")["src/layouts/Layout.astro"];
    expect(layout).toMatch(/\t\t<meta name="genclass" content="sink=console-json\+webhook:\/genclass" \/> <!-- genclass:init -->\n\t\t<script>import genclass/);
    const content = /content="([^"]*)"/.exec(layout)![1];
    expect(readMetaConfig({ querySelectorAll: () => [{ getAttribute: () => content }] })).toEqual({ sinks: ["console-json", "webhook:/genclass"] });
    const withTelemetry = roundTrip(astro(), "--no-telemetry", "--sink", "console-json")["src/layouts/Layout.astro"];
    expect(withTelemetry).toContain(`content="telemetry=off, sink=console-json"`);
    // a meta tag only takes a same-origin webhook URL: init says so for an absolute one (a path is fine)
    const far = cli(astro(), "init", "--dry-run", "--no-install", "--sink", "webhook:https://hooks.example/g");
    expect(far.code, far.out).toBe(0);
    expect(far.out).toContain("only takes a same-origin webhook URL");
    expect(far.out).toContain(`window.GENCLASS_CONFIG = { sinks: ["webhook:https://hooks.example/g"] }`);
    expect(cli(astro(), "init", "--dry-run", "--no-install", "--sink", "webhook:/genclass").out).not.toContain("same-origin webhook URL");
  });

  it("USAGE documents --sink and that the collector, not the runtime, forwards to Sentry, PostHog and Datadog, free; package.json exports the two adapters with types, and no vendor adapter", () => {
    expect(USAGE).toContain("--sink console-json|webhook:<url>");
    expect(USAGE).toContain("--sink <name>");
    expect(USAGE).toContain("The runtime has no Sentry, PostHog or Datadog adapter; the\n                   genclass.dev collector forwards detections to them, free, once you turn it on\n                   in the app's dashboard: https://genclass.dev/docs#dashboard");
    expect(USAGE).not.toMatch(/GenClass Pro|\bPro\b|trial|not in the free runtime|genclass\.dev\/pricing/);
    expect(USAGE).toContain(FORWARDING_URL);
    const map = PKG_JSON.typesVersions?.["*"] ?? {};
    for (const name of ["index", "console-json", "webhook"]) {
      const key = name === "index" ? "./sinks" : `./sinks/${name}`;
      expect(PKG_JSON.exports[key], key).toEqual({ types: `./dist/sinks/${name}.d.ts`, import: `./dist/sinks/${name}.js` });
      expect(map[key.slice(2)], key).toEqual([`./dist/sinks/${name}.d.ts`]);
    }
    for (const name of ["sentry", "posthog", "datadog"]) {
      expect(PKG_JSON.exports[`./sinks/${name}`], name).toBeUndefined();
      expect(map[`sinks/${name}`], name).toBeUndefined();
    }
    expect(Object.keys(PKG_JSON.exports).filter((k) => k.startsWith("./sinks"))).toEqual(["./sinks", "./sinks/console-json", "./sinks/webhook"]);
  });

  it("edit helpers carry sinks: configLiteral, updateConfigText, metaContent, tagWithConfig, isEmptyConfig", () => {
    expect(configLiteral({ sinks: ["console-json"] })).toBe(`{ sinks: ["console-json"] }`);
    expect(configLiteral({ telemetry: false, sinks: ["console-json", "webhook:/g"] })).toBe(`{ telemetry: false, sinks: ["console-json", "webhook:/g"] }`);
    expect(configLiteral({ sinks: [] })).toBe("{}");
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { telemetry: false };`, { sinks: ["console-json"] })).toBe(`globalThis.GENCLASS_CONFIG = { telemetry: false, sinks: ["console-json"] };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = {};`, { sinks: ["console-json"] })).toBe(`globalThis.GENCLASS_CONFIG = { sinks: ["console-json"] };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { sinks: ["console-json"], debug: true };`, { sinks: ["webhook:/g"] })).toBe(`globalThis.GENCLASS_CONFIG = { sinks: ["webhook:/g"], debug: true };`);
    expect(updateConfigText(`globalThis.GENCLASS_CONFIG = { sinks: ["console-json"] };`, { telemetry: false })).toBe(`globalThis.GENCLASS_CONFIG = { telemetry: false, sinks: ["console-json"] };`);
    // the rest of the file is left as it is
    expect(updateConfigText(`// x\nimport "./y";\nglobalThis.GENCLASS_CONFIG = { sinks: ["console-json"] };\n`, { sinks: ["webhook:/g"] })).toBe(`// x\nimport "./y";\nglobalThis.GENCLASS_CONFIG = { sinks: ["webhook:/g"] };\n`);
    expect(metaContent({ sinks: ["console-json", "webhook:/g"] })).toBe("sink=console-json+webhook:/g");
    expect(metaContent({ telemetry: false, sinks: ["webhook:/g"] })).toBe("telemetry=off, sink=webhook:/g");
    expect(tagWithConfig(`<script src="x">`, { sinks: ["console-json", "webhook:/g"] })).toBe(`<script src="x" data-sink="console-json,webhook:/g">`);
    expect(tagWithConfig(`<script src="x" data-sink="console-json">`, { sinks: ["webhook:/g"] })).toBe(`<script src="x" data-sink="webhook:/g">`);
    expect(isEmptyConfig({ sinks: [] })).toBe(true);
    expect(isEmptyConfig({ sinks: ["console-json"] })).toBe(false);
    expect(isEmptyConfig({})).toBe(true);
  });
});
