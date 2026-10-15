// scan-score/4 site checks (src/site.ts): the main document's security headers and cookies, http:// redirecting, and
// search and sharing; each judge with its passing and failing cases, and the worker's own two requests.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cspDirectives, judgeSearch, judgeSecurity, parseCookie, parseHead, siteProbe, type MainDocument, type PageHead, type SiteProbe } from "../src/site.ts";
import { normaliseTarget, type Target } from "../src/target.ts";

const GOOD: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; script-src 'self' https://cdn.example.net; frame-ancestors 'self'",
  "x-content-type-options": "nosniff",
};
const doc = (headers: Record<string, string>, cookies: string[] = [], status = 200): MainDocument => ({ url: "https://shop.example.com/", status, headers, cookies });
const kinds = (fs: { kind: string }[] | null) => (fs ?? []).map((f) => f.kind).sort();

describe("security (scan-score/4): the main document's headers", () => {
  it("passes a page with HSTS, a CSP that limits scripts and framing, and nosniff", () => {
    assert.deepEqual(judgeSecurity("https://shop.example.com/", doc(GOOD), [], null), []);
  });
  it("names each missing header, with its severity", () => {
    const f = judgeSecurity("https://shop.example.com/", doc({ "content-type": "text/html" }), [], null)!;
    assert.deepEqual(kinds(f), ["clickjack-unprotected", "csp-missing", "hsts-missing", "nosniff-missing"]);
    const sev = Object.fromEntries(f.map((x) => [x.kind, x.detail?.severity]));
    assert.deepEqual(sev, { "hsts-missing": "moderate", "csp-missing": "moderate", "nosniff-missing": "minor", "clickjack-unprotected": "moderate" });
    assert.equal(f.find((x) => x.kind === "csp-missing")!.measured, "The page (shop.example.com/) has no Content-Security-Policy header or meta tag.");
  });
  it("judges HSTS by its max-age, and only on HTTPS", () => {
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", doc({ ...GOOD, "strict-transport-security": "max-age=0" }), [], null)), ["hsts-missing"]);
    const plain = judgeSecurity("http://shop.example.com/", doc({ ...GOOD, "strict-transport-security": "" }), [], null)!;
    assert.deepEqual(kinds(plain), ["https-missing"], "no HSTS finding over http, but the page is not HTTPS (serious)");
    assert.equal(plain[0].detail?.severity, "serious");
  });
  it("counts a CSP only when it limits scripts: script-src, or default-src without it, and no wildcard or bare scheme", () => {
    const csp = (v: string, meta: string[] = []) => kinds(judgeSecurity("https://shop.example.com/", doc({ ...GOOD, "content-security-policy": v, "x-frame-options": "DENY" }), meta, null));
    assert.deepEqual(csp("frame-ancestors 'none'; upgrade-insecure-requests"), ["csp-missing"]);
    assert.equal(judgeSecurity("https://shop.example.com/", doc({ ...GOOD, "content-security-policy": "upgrade-insecure-requests" }), [], null)!.find((x) => x.kind === "csp-missing")!.detail?.severity, "minor", "a CSP that does not limit scripts is minor");
    assert.deepEqual(csp("default-src * 'unsafe-inline'"), ["csp-missing"]);
    assert.deepEqual(csp("script-src https:"), ["csp-missing"]);
    assert.deepEqual(csp("script-src 'self' 'nonce-abc'"), []);
    assert.deepEqual(csp("", ["default-src 'self'"]), [], "a meta tag CSP counts for scripts");
    // the head was not read (no time for the phone audits): a CSP may sit in a meta tag, so its absence is not judged
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", doc({ ...GOOD, "content-security-policy": "", "x-frame-options": "DENY" }), null, null)), []);
    // report-only blocks nothing
    const ro = judgeSecurity("https://shop.example.com/", doc({ "strict-transport-security": "max-age=600", "content-security-policy-report-only": "default-src 'self'", "x-content-type-options": "nosniff", "x-frame-options": "SAMEORIGIN" }), [], null)!;
    assert.match(ro.find((x) => x.kind === "csp-missing")!.measured, /only a Report-Only policy, which blocks nothing/);
  });
  it("accepts X-Frame-Options DENY or SAMEORIGIN, or frame-ancestors in a header (never in a meta tag)", () => {
    const frame = (h: Record<string, string>, meta: string[] = []) => kinds(judgeSecurity("https://shop.example.com/", doc({ "strict-transport-security": "max-age=600", "x-content-type-options": "nosniff", ...h }), meta, null)).includes("clickjack-unprotected");
    assert.equal(frame({ "x-frame-options": "SAMEORIGIN", "content-security-policy": "script-src 'self'" }), false);
    assert.equal(frame({ "x-frame-options": "ALLOW-FROM https://a.example" }), true);
    assert.equal(frame({ "x-frame-options": "SAMEORIGIN\nSAMEORIGIN" }), false, "the same header sent twice");
    assert.equal(frame({ "x-frame-options": "DENY\nSAMEORIGIN" }), true, "two different values: browsers ignore both");
    assert.equal(frame({ "content-security-policy": "script-src 'self'; frame-ancestors https://partner.example" }), false);
    assert.equal(frame({ "content-security-policy": "script-src 'self'; frame-ancestors *" }), true);
    assert.equal(frame({}, ["script-src 'self'; frame-ancestors 'none'"]), true, "browsers ignore frame-ancestors in a meta tag");
  });
  it("names cookies without Secure, and session cookies without HttpOnly; deletions are left out", () => {
    assert.deepEqual(parseCookie("sid=abc; Path=/; Secure; HttpOnly"), { name: "sid", secure: true, httpOnly: true });
    assert.equal(parseCookie("sid=; Max-Age=0"), null);
    assert.equal(parseCookie("old=deleted; expires=Thu, 01 Jan 1970 00:00:00 GMT"), null);
    const f = judgeSecurity("https://shop.example.com/", doc(GOOD, ["sessionid=1; Path=/", "theme=dark; Secure", "_ga=GA1.2; Secure", "PHPSESSID=x; Secure"]), [], null)!;
    const c = f.find((x) => x.kind === "cookie-insecure")!;
    assert.equal(c.detail?.count, 2);
    assert.match(c.measured, /sessionid \(no Secure, a session cookie without HttpOnly\); PHPSESSID \(a session cookie without HttpOnly\)/);
    assert.deepEqual(judgeSecurity("https://shop.example.com/", doc(GOOD, ["theme=dark; Secure", "_ga=GA1.2; Secure"]), [], null), []);
  });
  it("judges nothing it did not see: no headers, or a status other than 2xx (a challenge, an error page)", () => {
    assert.equal(judgeSecurity("https://shop.example.com/", null, [], null), null);
    assert.equal(judgeSecurity("https://shop.example.com/", doc({}, [], 200), [], null), null);
    assert.equal(judgeSecurity("https://shop.example.com/", doc({ "content-type": "text/html" }, [], 403), [], null), null);
  });
  it("reports http:// that answers without going to https://", () => {
    const probe = (end: "https" | "http"): SiteProbe => ({ http: { end, url: "http://shop.example.com/", hops: 0 }, favicon: null });
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", doc(GOOD), [], probe("http"))), ["http-no-redirect"]);
    assert.deepEqual(judgeSecurity("https://shop.example.com/", doc(GOOD), [], probe("https")), []);
    // a host on the browsers' HSTS preload list: browsers never ask for http://, so no visitor gets the http answer
    assert.deepEqual(judgeSecurity("https://shop.example.com/", doc(GOOD), [], { ...probe("http"), preloaded: true }), []);
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", doc(GOOD), [], { ...probe("http"), preloaded: false })), ["http-no-redirect"]);
  });
  it("counts a header as sent when the worker's own fetch of the same page got it, though the browser's copy lacked it", () => {
    const own = (headers: Record<string, string>, url = "https://shop.example.com/", status = 200): SiteProbe => ({ http: null, favicon: null, page: { url, status, headers } });
    const bare = doc({ "content-type": "text/html", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "script-src 'self'" });
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", bare, [], null)), ["hsts-missing"]);
    assert.deepEqual(judgeSecurity("https://shop.example.com/", bare, [], own({ "strict-transport-security": "max-age=600" })), []);
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", bare, [], own({ "strict-transport-security": "max-age=600" }, "https://other.example.com/"))), ["hsts-missing"], "another page's headers do not count");
    assert.deepEqual(kinds(judgeSecurity("https://shop.example.com/", bare, [], own({ "strict-transport-security": "max-age=600" }, "https://shop.example.com/", 403))), ["hsts-missing"], "nor a challenge's");
  });
  it("splits a policy into its directives", () => {
    assert.deepEqual([...cspDirectives("default-src 'self';  Script-Src 'nonce-a' https://x ; ;")], [["default-src", ["'self'"]], ["script-src", ["'nonce-a'", "https://x"]]]);
  });
});

describe("the worker's own requests about the site (siteProbe)", () => {
  const target = normaliseTarget("shop.example.com/") as Target;
  const fake = (routes: Record<string, () => Response>) => {
    const calls: string[] = [];
    const f = async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${u}`);
      return (routes[u] ?? (() => new Response("nf", { status: 404, headers: { "content-type": "text/html" } })))();
    };
    return { f, calls };
  };
  it("follows http:// by hand to https://, and reads /favicon.ico's status and type", async () => {
    const { f, calls } = fake({
      "http://shop.example.com/": () => new Response(null, { status: 301, headers: { location: "https://shop.example.com/" } }),
      "https://shop.example.com/favicon.ico": () => new Response("x", { headers: { "content-type": "image/x-icon" } }),
      "https://shop.example.com/": () => new Response("<html>", { headers: { "content-type": "text/html", "Strict-Transport-Security": "max-age=600", "set-cookie": "sid=1" } }),
    });
    const p = await siteProbe(target, f, "ua");
    assert.deepEqual(p, {
      http: { end: "https", url: "https://shop.example.com/", hops: 1 }, favicon: { status: 200, type: "image/x-icon" }, preloaded: null,
      page: { url: "https://shop.example.com/", status: 200, headers: { "strict-transport-security": "max-age=600" } },
    }, "only the security headers of the page are kept");
    assert.deepEqual(calls.sort(), ["GET http://shop.example.com/", "GET https://hstspreload.org/api/v2/status?domain=shop.example.com", "GET https://shop.example.com/", "GET https://shop.example.com/favicon.ico"]);
  });
  it("calls a page served over http a failure, unless it sends the browser on to https at once", async () => {
    const plain = fake({ "http://shop.example.com/": () => new Response("<html><body>hi</body></html>", { headers: { "content-type": "text/html" } }) });
    assert.equal((await siteProbe(target, plain.f, "ua")).http?.end, "http");
    const meta = fake({ "http://shop.example.com/": () => new Response('<meta http-equiv="refresh" content="0; url=https://shop.example.com/">') });
    assert.equal((await siteProbe(target, meta.f, "ua")).http?.end, "https");
    const err = fake({ "http://shop.example.com/": () => new Response("no", { status: 403 }) });
    assert.equal((await siteProbe(target, err.f, "ua")).http, null, "an error status is not judged");
    const down = await siteProbe(target, async () => { throw new Error("refused"); }, "ua");
    assert.deepEqual(down, { http: null, favicon: null, preloaded: null, page: null }, "a site without port 80 is not judged");
    const pre = fake({ "https://hstspreload.org/api/v2/status?domain=shop.example.com": () => Response.json({ status: "preloaded" }) });
    assert.equal((await siteProbe(target, pre.f, "ua")).preloaded, true);
  });
});

describe("search and sharing (scan-score/4): the head, X-Robots-Tag and the favicon", () => {
  const head = (o: Partial<PageHead> = {}): PageHead => ({
    title: "Shop", description: "Shoes and socks.", robots: [], ogTitle: "Shop", ogImage: "https://shop.example.com/og.png", twTitle: null, twImage: null, icon: true, compat: "CSS1Compat", csp: [], generic: 0, genericEx: [], ...o,
  });
  it("passes a page with a description, preview tags and an icon", () => {
    assert.deepEqual(judgeSearch(head(), "", null), []);
  });
  it("reports a missing or empty description, a missing preview, generic links and quirks mode", () => {
    const f = judgeSearch(head({ description: null, ogTitle: null, ogImage: null, twImage: "https://x/p.png", generic: 3, genericEx: ['a.more ("learn more")'], compat: "BackCompat" }), "", null);
    assert.deepEqual(kinds(f), ["link-text-generic", "meta-description-missing", "quirks-mode", "social-preview-missing"]);
    assert.match(f.find((x) => x.kind === "social-preview-missing")!.measured, /no og:title/);
    assert.equal(f.find((x) => x.kind === "social-preview-missing")!.detail?.count, 1, "twitter:image stands in for og:image");
    assert.match(judgeSearch(head({ description: "" }), "", null)[0].measured, /with no text/);
  });
  it("reports noindex from the robots meta tag or X-Robots-Tag, for every crawler or Google's and Bing's", () => {
    assert.deepEqual(kinds(judgeSearch(head({ robots: ["noindex, follow"] }), "", null)), ["noindex"]);
    assert.deepEqual(kinds(judgeSearch(head(), "none", null)), ["noindex"]);
    assert.deepEqual(kinds(judgeSearch(head(), "googlebot: noindex", null)), ["noindex"]);
    assert.deepEqual(kinds(judgeSearch(head(), "otherbot: noindex", null)), []);
    assert.deepEqual(kinds(judgeSearch(head(), "noarchive\nmax-snippet: 20", null)), []);
  });
  it("calls the favicon missing only on a definite answer (404, 410 or an HTML page), never on a 403", () => {
    const probe = (status: number, type: string): SiteProbe => ({ http: null, favicon: { status, type } });
    const missing = (status: number, type = "text/html") => kinds(judgeSearch(head({ icon: false }), "", probe(status, type))).includes("favicon-missing");
    assert.equal(missing(404), true);
    assert.equal(missing(410), true);
    assert.equal(missing(200, "text/html; charset=utf-8"), true, "a soft 404");
    assert.equal(missing(200, "image/x-icon"), false);
    assert.equal(missing(403), false, "bot protection");
    assert.equal(missing(429), false);
    assert.equal(kinds(judgeSearch(head({ icon: false }), "", null)).includes("favicon-missing"), false, "not fetched: not judged");
  });
  it("reads the page side's head and refuses anything else", () => {
    assert.equal(parseHead(null), null);
    assert.equal(parseHead({ title: "x" }), null);
    const h = parseHead({ title: "T\u0000", description: null, robots: ["noindex", 3], ogTitle: "o", ogImage: null, twTitle: null, twImage: null, icon: true, compat: "CSS1Compat", csp: [], generic: 2.4, genericEx: ["a"] })!;
    assert.deepEqual([h.title, h.robots, h.generic], ["T ", ["noindex"], 2]);
  });
});
