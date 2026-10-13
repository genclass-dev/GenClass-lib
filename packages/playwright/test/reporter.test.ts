import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_NAME } from "../src/constants.js";
import { cdnScriptUrl, isRuntimeCdnUrl, localRuntimeFile } from "../src/fixture.js";
import GenClassReporter, { readAttachment } from "../src/reporter.js";
import type { GenClassAttachment } from "../src/types.js";

const att: GenClassAttachment = {
  schema: 1,
  package: "0.1.0",
  runtimeVersion: "0.2.1",
  test: { title: "t", titlePath: ["spec.ts", "t"], file: "/r/spec.ts", line: 3 },
  options: { mode: "observe", install: "inject", runtime: "cdn", handle: ["GenClass.runtime", "__genclass"] },
  injected: { ok: true },
  chaos: null,
  modelReadyLines: 1,
  warnings: [],
  runtime: {
    handle: "GenClass.runtime",
    href: "http://localhost/",
    title: "",
    mode: "observe",
    status: { state: "ready", model: "m", version: "1", device: "wasm" },
    gates: null,
    summary: null,
    audit: [],
    decisions: [
      { id: "d1", trigger: "request", subject: "POST /api/orders (#2)", at: 1, diagnosis: "duplicate", diagnosisConfidence: 0.95, action: "coalesce", confidence: 0.6, executed: false, ran: "pass", tier: "passive", latencyMs: 300, facts: [], message: "Detected a duplicate request (duplicate, 0.95; coalesce 0.60)" },
    ],
    interventions: [],
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "genclass-pw-"));
  dirs.push(d);
  return d;
}

describe("reporter", () => {
  it("reads the genclass attachment from a body or a file and ignores the rest", () => {
    expect(readAttachment({ attachments: [] })).toBeNull();
    expect(readAttachment({ attachments: [{ name: "screenshot", contentType: "image/png", body: Buffer.from("x") }] })).toBeNull();
    expect(readAttachment({ attachments: [{ name: ATTACHMENT_NAME, contentType: "application/json", body: Buffer.from(JSON.stringify(att)) }] })).toEqual(att);
    const d = tmp();
    const p = join(d, "genclass.json");
    writeFileSync(p, JSON.stringify(att));
    expect(readAttachment({ attachments: [{ name: ATTACHMENT_NAME, contentType: "application/json", path: p }] })).toEqual(att);
    expect(readAttachment({ attachments: [{ name: ATTACHMENT_NAME, contentType: "application/json", body: Buffer.from("{not json") }] })).toBeNull();
    expect(readAttachment({ attachments: [{ name: ATTACHMENT_NAME, contentType: "application/json", body: Buffer.from('{"schema":2}') }] })).toBeNull();
  });

  it("writes the markdown and the JSON under rootDir and keeps the last result of a retried test", async () => {
    const root = tmp();
    const r = new GenClassReporter({ outputFile: "out/genclass-report.md", quiet: true });
    r.onBegin({ rootDir: root } as never, {} as never);
    const test = { id: "t1", title: "t", titlePath: () => ["", "spec.ts", "t"], location: { file: "/r/spec.ts", line: 3, column: 1 } };
    r.onTestEnd(test as never, { status: "failed", attachments: [] } as never);
    r.onTestEnd(test as never, { status: "passed", attachments: [{ name: ATTACHMENT_NAME, contentType: "application/json", body: Buffer.from(JSON.stringify(att)) }] } as never);
    await r.onEnd({ status: "passed" } as never);
    const md = readFileSync(join(root, "out/genclass-report.md"), "utf8");
    expect(md).toContain("**Findings: 1 duplicate submit**");
    expect(md).toContain("Detected a duplicate request (duplicate, 0.95; coalesce 0.60)");
    const json = JSON.parse(readFileSync(join(root, "out/genclass-report.json"), "utf8"));
    expect(json.totals.findings).toEqual({ duplicate: 1 });
    expect(json.tests[0].status).toBe("passed");
    expect(json.tests[0].titlePath).toEqual(["spec.ts", "t"]);
    expect(r.summary?.totals.tests).toBe(1);
  });

  it("json: false writes only the markdown; json: <path> writes there", async () => {
    const root = tmp();
    const a = new GenClassReporter({ json: false, quiet: true });
    a.onBegin({ rootDir: root } as never, {} as never);
    await a.onEnd({ status: "passed" } as never);
    expect(existsSync(join(root, "genclass-report.md"))).toBe(true);
    expect(existsSync(join(root, "genclass-report.json"))).toBe(false);
    const b = new GenClassReporter({ json: "sub/summary.json", quiet: true });
    b.onBegin({ rootDir: root } as never, {} as never);
    await b.onEnd({ status: "passed" } as never);
    expect(existsSync(join(root, "sub/summary.json"))).toBe(true);
  });
});

describe("runtime CDN routing", () => {
  it("pins the script-tag build to a version", () => {
    expect(cdnScriptUrl("0.2.1")).toBe("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/genclass.global.min.js");
  });

  it("recognises the runtime's jsDelivr URLs and nothing else", () => {
    expect(isRuntimeCdnUrl(new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/genclass.global.min.js"))).toBe(true);
    expect(isRuntimeCdnUrl(new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/cdn/worker.js"))).toBe(true);
    expect(isRuntimeCdnUrl(new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime"))).toBe(true);
    expect(isRuntimeCdnUrl(new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime-model@0.2.0/files/model.json"))).toBe(false);
    expect(isRuntimeCdnUrl(new URL("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm"))).toBe(false);
    expect(isRuntimeCdnUrl(new URL("http://localhost:3000/api/x"))).toBe(false);
  });

  it("serves only files under the package's dist/", () => {
    const root = tmp();
    const dist = join(root, "dist");
    const cdn = join(dist, "cdn");
    rmSync(dist, { recursive: true, force: true });
    writeFileSync(join(root, "package.json"), "{}");
    mkdirSync(cdn, { recursive: true });
    writeFileSync(join(dist, "genclass.global.min.js"), "//");
    writeFileSync(join(cdn, "worker.js"), "//");
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/genclass.global.min.js"))).toBe(join(dist, "genclass.global.min.js"));
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1"))).toBe(join(dist, "genclass.global.min.js"));
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/cdn/worker.js"))).toBe(join(cdn, "worker.js"));
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/missing.js"))).toBeNull();
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/package.json"))).toBeNull();
    expect(localRuntimeFile(root, new URL("https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/dist/../package.json"))).toBeNull();
  });
});
