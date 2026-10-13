// The request policy: non-GET never leaves the browser, blocked hosts are aborted (redirect hops included), the
// probe never navigates, third parties get nothing while it clicks, probe GETs get latency.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideRequest, latencySequence, type PolicyContext, type RequestFacts } from "../src/policy.ts";

const ctx = (phase: PolicyContext["phase"], extra: Partial<PolicyContext> = {}): PolicyContext => ({
  pageOrigin: "https://shop.example.com",
  phase,
  latency: () => 700,
  answerDelayMs: 400,
  ...extra,
});
const req = (url: string, o: Partial<RequestFacts> = {}): RequestFacts => ({ url, method: "GET", resourceType: "fetch", isNavigation: false, isMainFrame: false, ...o });

describe("non-GET requests are answered locally, in every phase", () => {
  for (const phase of ["load", "type", "click", "settle"] as const) {
    it(`POST/PUT/PATCH/DELETE in ${phase}`, () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
        const v = decideRequest(req("https://shop.example.com/api/orders", { method }), ctx(phase), 3);
        assert.equal(v.kind, "fulfill", method);
        if (v.kind !== "fulfill") return;
        assert.equal(v.status, 200);
        assert.deepEqual(JSON.parse(v.body), { ok: true, id: "scan-3", status: "ok" });
        assert.equal(v.headers["access-control-allow-origin"], "https://shop.example.com");
      }
    });
  }
  it("a beacon (ping) to a third party is answered locally too", () => {
    const v = decideRequest(req("https://analytics.example.net/collect", { method: "POST", resourceType: "ping" }), ctx("load"));
    assert.equal(v.kind, "fulfill");
  });
  it("a form POST navigation gets 204 so the page stays put", () => {
    const v = decideRequest(req("https://shop.example.com/subscribe", { method: "POST", resourceType: "document", isNavigation: true, isMainFrame: true }), ctx("click"));
    assert.equal(v.kind, "fulfill");
    if (v.kind === "fulfill") assert.equal(v.status, 204);
  });
  it("a CORS preflight is answered locally", () => {
    const v = decideRequest(req("https://api.example.com/x", { method: "OPTIONS" }), ctx("type"));
    assert.equal(v.kind, "fulfill");
    if (v.kind === "fulfill") assert.equal(v.status, 204);
  });
  it("non-GET to a blocked host is aborted, not answered", () => {
    assert.equal(decideRequest(req("http://127.0.0.1/api", { method: "POST" }), ctx("load")).kind, "abort");
  });
});

describe("blocked hosts are aborted, redirect hops included", () => {
  it("aborts private, loopback, link-local, metadata literals and local names", () => {
    for (const u of ["http://127.0.0.1/", "http://2130706433/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://localhost:8080/", "http://intranet.internal/"]) {
      assert.equal(decideRequest(req(u, { resourceType: "image" }), ctx("load")).kind, "abort", u);
      // a main-frame redirect hop is a navigation request like any other
      assert.equal(decideRequest(req(u, { resourceType: "document", isNavigation: true, isMainFrame: true }), ctx("load")).kind, "abort", u);
    }
  });
  it("asks for a DNS check on main-frame navigations during load", () => {
    const v = decideRequest(req("https://www.example.com/", { resourceType: "document", isNavigation: true, isMainFrame: true }), ctx("load"));
    assert.deepEqual(v, { kind: "continue", delayMs: 0, checkDns: true });
  });
});

describe("the probe never navigates and never submits to a third party", () => {
  it("aborts main-frame navigations after load", () => {
    for (const phase of ["type", "click", "settle"] as const) {
      assert.equal(decideRequest(req("https://shop.example.com/next", { resourceType: "document", isNavigation: true, isMainFrame: true }), ctx(phase)).kind, "abort");
      assert.equal(decideRequest(req("https://other.example.org/", { resourceType: "document", isNavigation: true, isMainFrame: true }), ctx(phase)).kind, "abort");
    }
  });
  it("aborts third-party data GETs while clicking, keeps scripts and images", () => {
    assert.equal(decideRequest(req("https://list-manage.example.net/subscribe/post-json?EMAIL=x"), ctx("click")).kind, "abort");
    assert.equal(decideRequest(req("https://tracker.example.net/p", { resourceType: "document" }), ctx("click")).kind, "abort");
    assert.equal(decideRequest(req("https://cdn.example.net/a.js", { resourceType: "script" }), ctx("click")).kind, "continue");
    assert.equal(decideRequest(req("https://cdn.example.net/a.png", { resourceType: "image" }), ctx("click")).kind, "continue");
  });
  it("delays same-origin and cross-origin fetch/XHR GETs during the probe, not during load", () => {
    assert.deepEqual(decideRequest(req("https://shop.example.com/api/search?q=a"), ctx("type")), { kind: "continue", delayMs: 700, checkDns: false });
    assert.deepEqual(decideRequest(req("https://search.example.net/q?a", { resourceType: "xhr" }), ctx("type")), { kind: "continue", delayMs: 700, checkDns: false });
    assert.deepEqual(decideRequest(req("https://shop.example.com/api/search?q=a"), ctx("load")), { kind: "continue", delayMs: 0, checkDns: false });
  });
});

describe("latencySequence", () => {
  it("is deterministic per seed, stays in 0..1500 ms, and shortens within a burst", () => {
    const a = latencySequence("https://example.com/|desktop");
    const b = latencySequence("https://example.com/|desktop");
    const xs = Array.from({ length: 12 }, () => a());
    assert.deepEqual(xs, Array.from({ length: 12 }, () => b()));
    for (const x of xs) assert.ok(x >= 0 && x <= 1500, String(x));
    assert.ok(xs[0] > xs[1] && xs[1] > xs[2], `first three decrease: ${xs.slice(0, 3)}`);
    assert.notDeepEqual(xs, Array.from({ length: 12 }, latencySequence("other")));
  });
});
