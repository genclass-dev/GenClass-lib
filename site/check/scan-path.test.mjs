// The genclass.dev/<url> rule in the site worker: which paths become a page check, and proof that every existing
// page, asset and route behaves exactly as before. Run: node --test site/check/scan-path.test.mjs (CI: scan-worker job).
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scanTargetFromPath } from "../src/scan-path.js";
import worker from "../src/worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, "..", "public");

/** Every published file as its URL path, plus the extensionless routes html_handling serves for .html files. */
function publishedPaths() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = `/${relative(PUBLIC, full).split("\\").join("/")}`;
        out.push(rel);
        if (rel.endsWith(".html")) out.push(rel === "/index.html" ? "/" : rel.slice(0, -5));
      }
    }
  };
  walk(PUBLIC);
  return out;
}

describe("scanTargetFromPath", () => {
  it("accepts a hostname with a TLD, with a path and query, and http(s): prefixes", () => {
    assert.equal(scanTargetFromPath("/example.com"), "example.com");
    assert.equal(scanTargetFromPath("/example.com/pricing", "?plan=pro"), "example.com/pricing?plan=pro");
    assert.equal(scanTargetFromPath("/https://example.com/pricing"), "https://example.com/pricing");
    assert.equal(scanTargetFromPath("/https:/example.com/pricing"), "https://example.com/pricing");
    assert.equal(scanTargetFromPath("/HTTP://Example.COM"), "http://Example.COM");
    assert.equal(scanTargetFromPath("/shop.example.co.uk"), "shop.example.co.uk");
    assert.equal(scanTargetFromPath("/xn--bcher-kva.de"), "xn--bcher-kva.de");
    assert.equal(scanTargetFromPath("/b%C3%BCcher.de"), null, "non-ASCII after decoding is not URL-safe");
  });
  it("keeps 404 for missing files whose extension is also a TLD, unless a path or a scheme says it is an address", () => {
    for (const p of ["/README.md", "/backup.zip", "/install.sh", "/setup.py", "/clip.mov", "/Main.java", "/docs.v2.zip", "/notes.MD"]) assert.equal(scanTargetFromPath(p), null, p);
    assert.equal(scanTargetFromPath("/https://bun.sh"), "https://bun.sh");
    assert.equal(scanTargetFromPath("/bun.sh/"), "bun.sh/");
    assert.equal(scanTargetFromPath("/bun.sh/docs"), "bun.sh/docs");
    for (const p of ["/socket.io", "/character.ai", "/notion.so", "/web.app", "/allegro.pl"]) assert.equal(scanTargetFromPath(p), p.slice(1), p);
  });
  it("refuses everything that is not clearly an address", () => {
    for (const p of ["/", "/docs", "/pricing", "/styles.css", "/mend.js", "/og.png", "/app.js.map", "/x.css.map", "/foo.html", "/robots.txt", "/sitemap.xml",
      "/site.webmanifest", "/localhost", "/intranet", "/a b.com", "/<script>.com", "/%3Cscript%3E.com", "/example.notatld", "/-a.com", "/https://", "/https://nohost", "/%E0%A4%A"]) {
      assert.equal(scanTargetFromPath(p), null, p);
    }
  });
  it("never matches a published page or asset", () => {
    const paths = publishedPaths();
    assert.ok(paths.includes("/styles.css") && paths.includes("/mend.js") && paths.includes("/og.png"), "the walk found the assets");
    for (const p of paths) assert.equal(scanTargetFromPath(p), null, p);
  });
});

// ------------------------------------------------------------------------------------------- the worker
function env({ scan = true } = {}) {
  const published = new Set(publishedPaths());
  const scanCalls = [];
  const assetCalls = [];
  return {
    scanCalls,
    assetCalls,
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        assetCalls.push(path);
        if (published.has(path)) return new Response(`asset ${path}`, { status: 200, headers: { "content-type": "text/plain", etag: '"x"' } });
        return new Response("<h1>404</h1>", { status: 404, headers: { "content-type": "text/html" } });
      },
    },
    ...(scan
      ? {
          SCAN: {
            fetch: async (req) => {
              scanCalls.push({ url: req.url, method: req.method });
              return new Response("scan shell", { status: 200, headers: { "content-type": "text/html", "x-from": "scan" } });
            },
          },
        }
      : {}),
  };
}
const ctx = { waitUntil() {} };
const get = (e, path, method = "GET") => worker.fetch(new Request(`https://genclass.dev${path}`, { method }), e, ctx);

describe("site worker routing", () => {
  it("serves every published page and asset from ASSETS with the usual headers, never the scan worker", async () => {
    const e = env();
    for (const p of publishedPaths()) {
      const res = await get(e, p);
      assert.equal(res.status, 200, p);
      assert.equal(await res.text(), `asset ${p}`);
      assert.ok(res.headers.get("content-security-policy"), `${p} keeps the site CSP`);
      assert.ok(res.headers.get("cache-control"), `${p} keeps its cache-control`);
    }
    assert.equal(e.scanCalls.length, 0);
    for (const [p, cc] of [["/styles.css", "public, max-age=31536000, immutable"], ["/mend.js", "public, max-age=31536000, immutable"], ["/og.png", "public, max-age=604800"], ["/", "public, max-age=300, must-revalidate"]]) {
      assert.equal((await get(e, p)).headers.get("cache-control"), cc, p);
    }
  });
  it("hands an address-like 404 to the scan worker as /scan?url=", async () => {
    const e = env();
    const res = await get(e, "/example.com/pricing?plan=pro");
    assert.equal(res.headers.get("x-from"), "scan");
    assert.deepEqual(e.scanCalls, [{ url: "https://genclass.dev/scan?url=example.com%2Fpricing%3Fplan%3Dpro", method: "GET" }]);
    await get(e, "/https://example.com/");
    assert.equal(e.scanCalls[1].url, `https://genclass.dev/scan?url=${encodeURIComponent("https://example.com/")}`);
  });
  it("keeps the 404 page for other misses, for POST, and when the scan worker is not bound", async () => {
    const e = env();
    for (const p of ["/nope", "/foo.html", "/app.js.map", "/docs/missing"]) {
      const res = await get(e, p);
      assert.equal(res.status, 404, p);
      assert.equal(await res.text(), "<h1>404</h1>");
    }
    assert.equal((await get(e, "/example.com", "POST")).status, 404);
    assert.equal(e.scanCalls.length, 0);
    const unbound = env({ scan: false });
    assert.equal((await get(unbound, "/example.com")).status, 404);
  });
  it("leaves the routes before the assets alone", async () => {
    const e = env();
    const www = await worker.fetch(new Request("https://www.genclass.dev/example.com"), e, ctx);
    assert.equal(www.status, 301);
    assert.equal((await get(e, "/forms/example.com")).status, 404);
    assert.equal((await get(e, "/forms/waitlist")).status, 405);
    assert.equal(e.scanCalls.length, 0);
    assert.equal(e.assetCalls.length, 0);
  });
});
