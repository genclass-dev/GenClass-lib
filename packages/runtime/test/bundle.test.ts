// What an app's bundler makes of the published dist/ (pilot trial, 2026-10-09: Next/Turbopack emitted 41 MB of
// onnxruntime-web .wasm/.mjs that the runtime never requests, and the first-load cost was ~97 KB gzip, not 83).
// Needs a build (`npx tsup`): skipped without dist/.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const PKG = resolve(__dirname, "..");
const DIST = join(PKG, "dist");
const built = existsSync(join(DIST, "auto.js")) && existsSync(join(DIST, "cdn", "ort-webgpu.js"));

function files(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push({ path: p, bytes: statSync(p).size });
  }
  return out;
}

describe.skipIf(!built)("dist as an app bundles it", () => {
  it("no chunk in dist/ imports onnxruntime-web by name: the worker and the inline path load dist/cdn/ort-*.js", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of files(DIST).filter((x) => /\.js$/.test(x.path) && !x.path.includes(`${join("dist", "cdn")}`) && !/genclass\.global/.test(x.path))) {
      expect(readFileSync(f.path, "utf8"), f.path).not.toMatch(/["']onnxruntime-web(\/[\w-]+)?["']/);
    }
    // the prepared ORT copies keep no `new URL("<file>", import.meta.url)` a bundler would emit as an asset
    for (const f of ["ort-webgpu.js", "ort-wasm.js"]) {
      const src = readFileSync(join(DIST, "cdn", f), "utf8");
      expect(src).not.toMatch(/new\s+\w+\(\s*["'][^"']+["']\s*,\s*import\.meta\.url\s*\)/);
      // nor a plain alias of it, which Turbopack (Next 16) propagates into those calls
      expect(src).not.toMatch(/\b[\w$]+\s*=\s*import\.meta\.url\s*[;,]/);
      expect(src).toContain("ort-wasm-simd-threaded"); // still the real ORT (it names its files)
    }
  });

  it("Vite: no .wasm and nothing over 25 MiB is emitted for `import \"@genclass/runtime/auto\"`", async () => {
    let vite: typeof import("vite");
    try {
      vite = await import("vite");
    } catch {
      return; // vite not installed here
    }
    const dir = mkdtempSync(join(tmpdir(), "genclass-vite-"));
    try {
      writeFileSync(join(dir, "index.html"), '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>');
      writeFileSync(join(dir, "main.js"), `import genclass from ${JSON.stringify(join(DIST, "auto.js"))};\nconsole.log(genclass.mode);\n`);
      await vite.build({ root: dir, logLevel: "silent", configFile: false, build: { outDir: join(dir, "out"), emptyOutDir: true } });
      const out = files(join(dir, "out"));
      expect(out.filter((f) => /\.wasm$/.test(f.path))).toEqual([]);
      expect(out.filter((f) => f.bytes > 25 * 1024 * 1024)).toEqual([]);
      expect(out.reduce((n, f) => n + f.bytes, 0)).toBeLessThan(2_000_000); // was ~41 MB with the two ORT wasm builds
      expect(out.some((f) => /worker/.test(f.path))).toBe(true); // the model worker is still bundled
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // /auto carries automatic state discovery (autoState, beta.4: about 6.5 KB); the main entry does not. The audit trail,
  // protect presets and the hold-budget fixes (0.2.0) added about 1.6 KB to both; 0.2.2 +0.35 KB (URL/meta hardening,
  // model download retries, the telemetry failure streak; this test measures 0.2.2 at 99.17 KB / 91.70 KB, CI run
  // 38441488459); app tokens and protect() (0.3.0) about 1.8 KB more (/auto 100.68 KB, the main entry 93.19 KB, CI run
  // 38436014497); the device floor, telemetry sampling and Request replays about 1.5 KB more; the sink names' proxy
  // about 0.8 KB on /auto (102.94 / 94.79 KB, CI run 38462380432). Sinks by name: only the proxy (src/cdn/sinks.ts) is
  // in /auto's first load; the name table, the fan-out and the adapters are lazy chunks (asserted below). The flow
  // expectations (src/learn/flows.ts, opt-in: learn.expectations) are a lazy chunk too, imported only when the option
  // is on; their runtime side (learned-state persistence, the report line, the hooks) and the util chunk it shares
  // with them add about 3.3 KB. 0.3.0-beta.0 measures 106.24 / 98.21 KB (CI run 38465242176); the limits are those
  // plus 1.5 KB, as the owner approved for 0.3.0 (README "Performance", docs/runtime/RESULTS.md §10). Observe's
  // detection tiers and deferred situations (wave2/detect-observe) took 1.42 / 1.48 KB of that: 107.66 / 99.69 KB (CI
  // run 38471973596, RESULTS.md §11). Both sizes are printed before either is asserted.
  const LIMIT_KB: Record<string, number> = { "auto.js": 107.74, "index.js": 99.71 };
  it("first-load cost of /auto and the main entry, minified + gzip: under the limits", async () => {
    const { build } = await import("esbuild");
    const uses: Record<string, string> = { "auto.js": "", "index.js": "GenClass.init({});" };
    const measured: { entry: string; kb: number; code: string }[] = [];
    for (const entry of ["auto.js", "index.js"]) {
      const spec = JSON.stringify(join(DIST, entry));
      const r = await build({
        stdin: { contents: uses[entry] ? `import { GenClass } from ${spec};\n${uses[entry]}` : `import ${spec};`, resolveDir: PKG, loader: "js" },
        bundle: true,
        splitting: true,
        format: "esm",
        minify: true,
        write: false,
        outdir: "/out",
        metafile: true,
        platform: "browser",
        external: ["react", "redux", "zustand"],
        logLevel: "silent",
      });
      const outs = r.metafile!.outputs;
      const byPath = new Map(r.outputFiles!.map((f) => [f.path, f.contents]));
      const first = new Set<string>();
      const walk = (k: string) => {
        if (first.has(k)) return;
        first.add(k);
        for (const i of outs[k].imports) if (i.kind === "import-statement" && outs[i.path]) walk(i.path);
      };
      // the app's own entry: the metafile marks a lazily imported chunk (a sink adapter of /auto) as an entry point too
      const stdin = Object.keys(outs).find((k) => outs[k].entryPoint === "<stdin>");
      expect(stdin, `${entry}: the stdin entry in the metafile`).toBeDefined();
      walk(stdin!);
      const per = [...first].map((k) => gzipSync(byPath.get(resolve("/", k))!, { level: 9 }).length);
      const gz = per.reduce((n, b) => n + b, 0);
      // each file is gzipped on its own, so a chunk split out of the first load costs its own overhead too
      const files = per.map((b) => (b / 1024).toFixed(2)).join(" + ");
      console.info(`[bundle] ${entry}: ${(gz / 1024).toFixed(2)} KB minified + gzip in ${per.length} file(s): ${files} (limit ${LIMIT_KB[entry]} KB)`);
      const code = [...first].map((k) => new TextDecoder().decode(byPath.get(resolve("/", k))!)).join("\n");
      measured.push({ entry, kb: gz / 1024, code });
    }
    for (const { entry, kb, code } of measured) {
      expect(kb, entry).toBeLessThan(LIMIT_KB[entry]);
      // the model's tokenizer, packer and engine are not in it (the worker has them; the inline path loads them lazily)
      expect(code, entry).not.toContain("BPE dropout is not supported at inference"); // src/model/tokenizer.ts
      expect(code, entry).toContain("new Worker("); // the host itself is there
      // the sink adapters (@genclass/runtime/sinks/*) and the name table and fan-out (src/cdn/sinks-fanout.ts) are lazy
      // chunks of /auto and absent from the main entry
      expect(code, entry).not.toContain("genclass-sink/1"); // src/sinks/webhook.ts
      expect(code, entry).not.toContain("GenClassDetection"); // src/sinks/datadog.ts
      expect(code, entry).not.toContain("console-json"); // src/cdn/sinks-fanout.ts SINK_NAMES, src/cdn/sinks-load.ts
      expect(code, entry).not.toContain("unknown sink"); // src/cdn/sinks-fanout.ts
      // the flow expectations (src/learn/flows.ts) are a lazy chunk, loaded only with learn.expectations
      expect(code, entry).not.toContain("Expected a follow-up on"); // src/learn/flows.ts
      expect(code, entry).not.toContain("Expected a response:"); // src/learn/flows.ts
      // state discovery survives an app's bundler in /auto (a dropped side-effect import once lost it) and stays out
      // of the main entry
      if (entry === "auto.js") expect(code, entry).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
      else expect(code, entry).not.toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
    }
  });

  // the script tag's one file (README "Install", option 3): printed so the README can quote a measured number; it
  // carries the sink names' proxy and fan-out, and loads the adapters themselves from dist/sinks/ on demand
  it("the script tag's file, dist/genclass.global.min.js, minified + gzip: printed; no sink adapter inside it", async () => {
    const { readFileSync } = await import("node:fs");
    const f = join(DIST, "genclass.global.min.js");
    if (!existsSync(f)) return;
    const buf = readFileSync(f);
    const gz = gzipSync(buf, { level: 9 }).length / 1024;
    console.info(`[bundle] script tag genclass.global.min.js: ${gz.toFixed(2)} KB minified + gzip (${(buf.length / 1024).toFixed(1)} KB minified)`);
    const code = buf.toString("utf8");
    expect(code).not.toContain("genclass-sink/1"); // src/sinks/webhook.ts
    expect(code).not.toContain("GenClassDetection"); // src/sinks/datadog.ts
    expect(code).toContain("sinks/"); // the adapters' path on the CDN (dist/sinks/<name>.js)
    expect(gz).toBeGreaterThan(0);
  });
});
