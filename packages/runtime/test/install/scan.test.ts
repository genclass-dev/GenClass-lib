// `genclass-runtime scan <url>` / `audit` (bin/lib/scan.mjs): the report's pieces (URL handling, merging, the score,
// the hosted report's mapping), the CLI against a mock hosted page check on loopback (the fallback message without
// Playwright, exit codes, --json on stdout only), and one real local scan of a fixture page in headless Chromium
// when Playwright's Chromium is installed (skipped otherwise; CI's main job has none). No test reaches the network.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { formatReport, hostedReport, localReport, mergeFindings, normaliseUrl, privateHost, visualScore } from "../../bin/lib/scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "..", "bin", "genclass-runtime.mjs");
const DIST = resolve(HERE, "..", "..", "dist");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The CLI, asynchronously (the mock servers below run in this process). */
function cli(env: Record<string, string>, ...args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...env }, timeout: 120000 }, (e, stdout, stderr) => {
      done({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((ok) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

const finding = (kind: string, severity: string, extra: Record<string, unknown> = {}) => ({
  kind,
  severity,
  target: `p "Hello"`,
  selector: "p.x",
  message: `[GenClass] Check (measured): ${kind} on p.x. Suggested CSS: p.x { color: #767676; }`,
  count: 1,
  route: "/",
  measured: { ratio: 1.04 },
  threshold: { value: 1.5, unit: ":1", source: "WCAG" },
  suggestion: { selector: "p.x", css: "color: #767676;", note: null },
  ...extra,
});

/** A hosted report as scan-worker's src/report.ts writes it (the fields the CLI reads). */
const HOSTED_REPORT = {
  v: 16,
  url: "https://example.com/",
  runtime: "0.3.0-beta.0",
  chrome: "140.0.0.0",
  scannedAt: "2026-10-25T00:00:00.000Z",
  views: [
    { id: "desktop", label: "Desktop", width: 1366, height: 768, ok: true, status: 200, ms: 4000 },
    { id: "phone", label: "Phone", width: 390, height: 844, ok: true, status: 200, ms: 3000 },
  ],
  findings: [
    { n: 1, kind: "text-invisible", rule: "text-invisible", category: "visual", severity: "serious", count: 2, views: ["desktop", "phone"], selector: "p.fine", what: "Text that is almost invisible", measured: "contrast 1.08:1", fix: "p.fine { color: #767676; }", unscored: null, standards: [{ label: "WCAG 1.4.3" }] },
    { n: 2, kind: "axe", rule: "axe:image-alt", category: "accessibility", severity: "critical", count: 1, views: ["desktop"], selector: "img", what: "Images must have alternative text", measured: "", why: "no alt", fix: "Add alt text", unscored: null, standards: [] },
    { n: 3, kind: "console-error", rule: "console-error", category: "reliability", severity: "minor", count: 1, views: ["phone"], selector: "", what: "A console error", measured: "", fix: "", unscored: "may come from the scanner's stand-in answers", standards: [] },
  ],
  score: { version: "scan-score/4", value: 41, mean: 50, cap: null, categories: [{ id: "visual", label: "Visual bugs", weight: 20, measured: true, value: 63, raw: 63, count: 1, rules: [] }, { id: "speed", label: "Speed", weight: 12, measured: false, value: null, raw: null, count: 0, rules: [] }] },
  scoreNote: null,
  top: [{ rule: "axe:image-alt", category: "accessibility", what: "Images must have alternative text", severity: "critical", count: 1, n: 2, points: 12.4 }],
  notMeasured: { speed: "no DevTools session" },
  blocked: null,
};

describe("scan: report pieces (bin/lib/scan.mjs)", () => {
  it("normalises URLs: https:// for bare hosts, http:// for loopback, refuses other schemes and credentials", () => {
    expect(normaliseUrl("example.com/pricing")).toBe("https://example.com/pricing");
    expect(normaliseUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normaliseUrl("http://127.0.0.1:8080/a?b=1")).toBe("http://127.0.0.1:8080/a?b=1");
    expect(() => normaliseUrl("ftp://example.com")).toThrow(/http and https/);
    expect(() => normaliseUrl("https://user:pw@example.com")).toThrow(/credentials/);
  });

  it("knows the addresses the hosted check must never get", () => {
    for (const u of ["http://localhost:3000/", "http://127.0.0.1/", "http://192.168.1.4/", "http://10.0.0.2/", "http://172.20.0.1/", "http://[::1]:5173/", "http://app.test/", "http://intranet/", "http://dev.local/"]) expect(privateHost(u), u).toBe(true);
    for (const u of ["https://example.com/", "https://172.32.0.1/", "https://genclass-scan-fixture.mehar-144.workers.dev/"]) expect(privateHost(u), u).toBe(false);
  });

  it("merges views (one finding per kind and element, with its views and the largest count) and sorts worst first", () => {
    const merged = mergeFindings([
      { id: "desktop", findings: [finding("image-broken", "medium"), finding("text-invisible", "high", { count: 2 })] },
      { id: "phone", findings: [finding("text-invisible", "high", { count: 5 }), finding("page-overflow-x", "high", { selector: "div.wide", suggestion: null })] },
    ]);
    expect(merged.map((f: { kind: string }) => f.kind)).toEqual(["text-invisible", "page-overflow-x", "image-broken"]);
    expect(merged[0]).toMatchObject({ count: 5, views: ["desktop", "phone"] });
    expect(merged[1].views).toEqual(["phone"]);
  });

  it("scores like the hosted check's Visual bugs category: one serious rule 75, a critical kind 50, nothing 100", () => {
    expect(visualScore([])).toBe(100);
    expect(visualScore([{ kind: "text-invisible", severity: "high", count: 1 }])).toBe(75);
    expect(visualScore([{ kind: "page-blank", severity: "high", count: 1 }])).toBe(50);
    expect(visualScore([{ kind: "image-broken", severity: "medium", count: 1 }, { kind: "text-placeholder", severity: "low", count: 1 }])).toBe(75); // 0.85 x 0.88
    // ten instances double a rule's points (1 + log10(10)); never below 0
    expect(visualScore([{ kind: "text-invisible", severity: "high", count: 10 }])).toBe(50);
    expect(visualScore(Array.from({ length: 6 }, (_, i) => ({ kind: `k${i}`, severity: "high", count: 1000 })))).toBe(0);
  });

  it("builds the local report: genclass-scan/1, messages without the prefix or the repeated suggestion, the fix as CSS", () => {
    const views = [{ id: "desktop", width: 1280, height: 800, status: 200, ok: true, ms: 10, passes: 2, elements: 40, unsupported: [], error: null, findings: [finding("text-invisible", "high")] }];
    const r = localReport("https://example.com/", views, "Chromium 1", []);
    expect(r).toMatchObject({ format: "genclass-scan/1", ranAt: "local", url: "https://example.com/", score: { value: 75 }, summary: { total: 1, high: 1 } });
    expect(r.findings[0]).toMatchObject({ kind: "text-invisible", message: "text-invisible on p.x.", fix: "p.x { color: #767676; }", views: ["desktop"] });
    const text = formatReport(r);
    expect(text).toContain("Visual score 75/100");
    expect(text).toContain("fix: p.x { color: #767676; }");
    expect(localReport("https://example.com/", [{ ...views[0], ok: false, error: "boom", findings: [] }], "Chromium 1", []).score.value).toBeNull();
  });

  it("maps the hosted report: scored findings worst first, categories, top issues, notes for the unscored and unmeasured", () => {
    const r = hostedReport("https://example.com/", HOSTED_REPORT, "https://scan.example");
    expect(r).toMatchObject({ format: "genclass-scan/1", ranAt: "hosted", score: { value: 41 }, summary: { total: 2, critical: 1, serious: 1 }, fullReport: "https://scan.example/scan?url=https%3A%2F%2Fexample.com%2F" });
    expect(r.findings.map((f: { kind: string }) => f.kind)).toEqual(["axe:image-alt", "text-invisible"]);
    expect(r.findings[1]).toMatchObject({ category: "visual", count: 2, fix: "p.fine { color: #767676; }", standards: ["WCAG 1.4.3"] });
    expect(r.notes.join(" ")).toContain("1 more listed but not scored");
    expect(r.notes.join(" ")).toContain("speed not measured");
    const text = formatReport(r);
    expect(text).toContain("ran remotely on the genclass.dev page check");
    expect(text).toContain("Score 41/100");
    expect(text).toContain("Top issues");
  });
});

describe("scan: the CLI with a mock hosted page check", () => {
  let hosted: { server: Server; url: string };
  const seen: { method?: string; path?: string; body: string; ua?: string }[] = [];
  let answer: (res: ServerResponse) => void = () => undefined;
  beforeAll(async () => {
    hosted = await listen((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push({ method: req.method, path: req.url, body, ua: req.headers["user-agent"] });
        answer(res);
      });
    });
  });
  afterAll(() => hosted.server.close());
  const env = () => ({ GENCLASS_SCAN_HOSTED: hosted.url, GENCLASS_SCAN_PLAYWRIGHT: "none" });
  const ndjson = (lines: unknown[]) => (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  };

  it("--help, a missing URL and an unknown option", async () => {
    const h = await cli({}, "scan", "--help");
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("genclass-runtime scan <url>");
    const top = await cli({}, "--help");
    expect(top.stdout).toContain("scan <url>");
    expect((await cli({}, "audit")).code).toBe(2);
    const bad = await cli({}, "scan", "https://example.com", "--nope");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("unknown option --nope");
  });

  it("without Playwright: says how to install it; a local address is never sent to the hosted check (exit 2)", async () => {
    seen.length = 0;
    const r = await cli(env(), "scan", "http://localhost:5173/");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("npx playwright install chromium");
    expect(r.stderr).toContain("local address");
    expect(seen).toHaveLength(0);
    const h = await cli(env(), "scan", "http://127.0.0.1:5173/", "--hosted");
    expect(h.code).toBe(2);
    // --local: a public page is not sent either
    const l = await cli(env(), "scan", "https://example.com/", "--local");
    expect(l.code).toBe(2);
    expect(l.stderr).toContain("npx playwright install chromium");
    expect(seen).toHaveLength(0);
    expect((await cli(env(), "scan", "https://example.com/", "--local", "--hosted")).code).toBe(2);
  });

  it("without Playwright, a public page falls back to the hosted check: the stream's report, exit 1 when it found something", async () => {
    seen.length = 0;
    answer = ndjson([{ type: "progress", step: "check" }, { type: "progress", step: "desktop" }, { type: "done", report: HOSTED_REPORT }]);
    const r = await cli(env(), "scan", "example.com");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("npx playwright install chromium");
    expect(r.stderr).toContain("genclass.dev page check instead");
    expect(r.stdout).toContain("ran remotely");
    expect(r.stdout).toContain("axe:image-alt");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/scan" });
    expect(JSON.parse(seen[0].body)).toEqual({ url: "https://example.com/" });
    expect(seen[0].ua).toMatch(/^genclass-runtime-cli\//);
  });

  it("--json: only the report on stdout; a cached JSON answer works too; nothing found is exit 0", async () => {
    answer = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cached: true, report: { ...HOSTED_REPORT, findings: [], top: [], score: { ...HOSTED_REPORT.score, value: 100 } } }));
    };
    const r = await cli(env(), "scan", "https://example.com/", "--hosted", "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ format: "genclass-scan/1", ranAt: "hosted", findings: [], score: { value: 100 } });
  });

  it("errors are exit 2: a refusal with retry-after, an error line in the stream, a blocked page, an unreachable check", async () => {
    answer = (res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      res.end(JSON.stringify({ ok: false, code: "rate", message: "You have started five scans in the last minute." }));
    };
    const a = await cli(env(), "scan", "https://example.com/", "--hosted");
    expect(a.code).toBe(2);
    expect(a.stderr).toContain("five scans in the last minute. (rate); try again in 60 s");
    answer = ndjson([{ type: "progress", step: "check" }, { type: "error", code: "robots", message: "robots.txt asks GenClassScan not to load this page" }]);
    const b = await cli(env(), "scan", "https://example.com/", "--hosted", "--json");
    expect(b.code).toBe(2);
    expect(b.stdout).toBe("");
    expect(b.stderr).toContain("(robots)");
    answer = ndjson([{ type: "done", report: { ...HOSTED_REPORT, findings: [], top: [], blocked: { message: "A bot check was shown instead of the page.", status: 403, marks: [] } } }]);
    const c = await cli(env(), "scan", "https://example.com/", "--hosted");
    expect(c.code).toBe(2);
    expect(c.stdout).toContain("A bot check was shown");
    const d = await cli({ GENCLASS_SCAN_HOSTED: "http://127.0.0.1:9", GENCLASS_SCAN_PLAYWRIGHT: "none" }, "scan", "https://example.com/", "--hosted");
    expect(d.code).toBe(2);
    expect(d.stderr).toContain("could not reach the hosted page check");
  });
});

// The real local path: Playwright's Chromium, the built script-tag build, a fixture page with planted problems.
const chromium = (() => {
  try {
    const req = createRequire(join(HERE, "..", "..", "package.json"));
    const pw = req("playwright") as { chromium: { executablePath(): string } };
    return existsSync(pw.chromium.executablePath()) && existsSync(join(DIST, "genclass.global.min.js")) && existsSync(join(DIST, "visual", "index.js"));
  } catch {
    return false;
  }
})();

describe.skipIf(!chromium)("scan: a real local scan in headless Chromium", () => {
  let site: { server: Server; url: string };
  const root = mkdtempSync(join(tmpdir(), "gc-scan-"));
  const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>body{font-family:sans-serif;margin:0;padding:16px;background:#fff}.ghost{color:#fdfdfd;font-size:18px}</style></head><body>${body}</body></html>`;
  writeFileSync(join(root, "bad.html"), page(`<h1>Fixture</h1><p class="ghost">This sentence is nearly white on a white page.</p><p>Total: $NaN</p><img src="/missing.png" alt="missing" width="120" height="80">`));
  writeFileSync(join(root, "clean.html"), page(`<h1>Fine</h1><p>Readable text on a white page.</p>`));
  const requests: string[] = [];
  beforeAll(async () => {
    site = await listen((req, res) => {
      requests.push(String(req.url));
      const name = String(req.url).replace(/^\//, "").split("?")[0];
      const file = join(root, name);
      if (/^[a-z]+\.html$/.test(name) && existsSync(file)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(file));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
  });
  afterAll(() => {
    site.server.close();
    rmSync(root, { recursive: true, force: true });
  });
  it("finds the planted problems at both sizes (--json), and the runtime's files never reach the site", async () => {
    const r = await cli({}, "scan", `${site.url}/bad.html`, "--json");
    expect(r.code, r.stderr).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ format: "genclass-scan/1", ranAt: "local" });
    expect(j.views.map((v: { id: string; ok: boolean }) => [v.id, v.ok])).toEqual([["desktop", true], ["phone", true]]);
    const kinds = j.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["text-invisible", "text-template-leak", "image-broken"]));
    const ti = j.findings.find((f: { kind: string }) => f.kind === "text-invisible");
    expect(ti).toMatchObject({ severity: "high", selector: "p.ghost", views: ["desktop", "phone"] });
    expect(ti.fix).toMatch(/^p\.ghost \{ color: #[0-9a-f]{6}; \}$/);
    expect(j.score.value).toBeLessThan(75);
    expect(requests.some((u) => u.includes("__genclass_scan__"))).toBe(false);
  }, 120000);

  it("a clean page is exit 0 with a score of 100 (--phone: one size)", async () => {
    const r = await cli({}, "scan", `${site.url}/clean.html`, "--phone", "--json");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.views.map((v: { id: string }) => v.id)).toEqual(["phone"]);
    expect(j).toMatchObject({ findings: [], score: { value: 100 }, summary: { total: 0 } });
  }, 120000);
});
