// The browser's own record of a view (a DevTools protocol session) and the reliability findings judged from it:
// uncaught errors and console.error from the page's own main frame only, same-site 4xx and 5xx with the scanner's own
// answers and blocks, the visual checks' file types and who-is-asking statuses left out, mixed content, and the
// JavaScript total.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsNote, judgeReliability, PageLog, type CdpLike } from "../src/cdp.ts";
import { prefixed } from "../src/prefix.ts";
import { MemBucket } from "./helpers.ts";

/** A DevTools session that records what was turned on and lets the test emit events. */
function fakeCdp() {
  const handlers = new Map<string, ((p: any) => void)[]>();
  const sent: string[] = [];
  const cdp: CdpLike = {
    send: async (m: string) => {
      sent.push(m);
      if (m === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN" } } };
      return {};
    },
    on: (e: string, h: (p: any) => void) => void handlers.set(e, [...(handlers.get(e) ?? []), h]),
  };
  const emit = (e: string, p: unknown) => (handlers.get(e) ?? []).forEach((h) => h(p));
  return { cdp, emit, sent };
}

async function logWith(events: (emit: (e: string, p: unknown) => void) => void) {
  const { cdp, emit, sent } = fakeCdp();
  const log = new PageLog();
  await log.attach(cdp);
  emit("Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: true, frameId: "MAIN" } } });
  emit("Runtime.executionContextCreated", { context: { id: 2, auxData: { isDefault: false, frameId: "MAIN", type: "isolated" } } });
  emit("Runtime.executionContextCreated", { context: { id: 3, auxData: { isDefault: true, frameId: "AD-FRAME" } } });
  await log.frame(cdp);
  events(emit);
  return { log, sent };
}
const PAGE = "https://shop.example.com/";
let rid = 0;
const response = (emit: (e: string, p: unknown) => void, url: string, status: number, type: string, bytes = 1000, mime = "text/javascript") => {
  const id = `r${++rid}`;
  emit("Network.requestWillBeSent", { requestId: id, request: { url, method: "GET", mixedContentType: "none" }, type });
  emit("Network.responseReceived", { requestId: id, type, response: { url, status, mimeType: mime } });
  emit("Network.loadingFinished", { requestId: id, encodedDataLength: bytes });
};

describe("uncaught errors and console.error", () => {
  it("count the page's own main frame, merged by message, and leave out iframes, the isolated world and the scanner's own code", async () => {
    const thrown = (ctx: number, text: string, url = "https://shop.example.com/app.js") => ({ exceptionDetails: { text: "Uncaught", exception: { description: `${text}\n    at x (app.js:1:2)` }, url, lineNumber: 41, executionContextId: ctx } });
    const { log, sent } = await logWith((emit) => {
      emit("Runtime.exceptionThrown", thrown(1, "TypeError: a is undefined"));
      emit("Runtime.exceptionThrown", thrown(1, "TypeError: a is undefined"));
      emit("Runtime.exceptionThrown", thrown(1, "ReferenceError: gtag is not defined", "https://www.googletagmanager.com/gtm.js"));
      emit("Runtime.exceptionThrown", thrown(2, "Error: from the scanner's isolated world"));
      emit("Runtime.exceptionThrown", thrown(3, "Error: from an ad frame"));
      emit("Runtime.exceptionThrown", thrown(1, "Error: Service workers are off while GenClassScan loads this page"));
      emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" }, stackTrace: { callFrames: [{ url: "pptr:evaluate;x" }] }, executionContextId: 1 } });
      emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "Config failed:" }, { type: "number", value: 404 }], executionContextId: 1, stackTrace: { callFrames: [{ url: PAGE, lineNumber: 9 }] } });
      emit("Runtime.consoleAPICalled", { type: "warning", args: [{ type: "string", value: "just a warning" }], executionContextId: 1 });
      emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "[GenClass] Check (measured): ..." }], executionContextId: 1 });
    });
    assert.ok(sent.includes("Runtime.enable") && sent.includes("Network.enable"));
    const rel = judgeReliability(log, PAGE, "desktop");
    const js = rel.findings.find((f) => f.kind === "js-error")!;
    assert.equal(js.detail!.count, 2, "two distinct messages from the main frame");
    assert.equal(js.detail!.severity, "moderate");
    assert.match(js.measured, /^2 uncaught errors on the desktop view while it loaded \(1 from scripts on other sites\)\. First: TypeError: a is undefined \(shop\.example\.com\/app\.js, line 42\)\.$/);
    const ce = rel.findings.find((f) => f.kind === "console-error")!;
    assert.equal(ce.detail!.count, 1);
    assert.match(ce.measured, /First: Config failed: 404 \(shop\.example\.com\/\)\./);
  });
  it("are minor when every error came from a script on another site, and nothing is recorded after stop()", async () => {
    const { log } = await logWith((emit) => {
      emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "TypeError: x" }, url: "https://cdn.vendor.example.net/w.js", executionContextId: 1 } });
    });
    log.stop();
    assert.equal(judgeReliability(log, PAGE, "phone").findings[0].detail!.severity, "minor");
  });
});

describe("failed same-site requests", () => {
  it("judge scripts, data requests and frames on the same site by status", async () => {
    const { log } = await logWith((emit) => {
      response(emit, "https://shop.example.com/static/app.3f2.js", 404, "Script");
      response(emit, "https://cdn.shop.example.com/chunk.js", 500, "Script");
      response(emit, "https://shop.example.com/api/recs", 503, "Fetch", 200, "application/json");
      response(emit, "https://shop.example.com/api/flags", 404, "XHR", 200, "application/json");
      response(emit, "https://shop.example.com/static/app.3f2.js", 404, "Script");
    });
    const f = judgeReliability(log, PAGE, "desktop").findings.find((x) => x.kind === "request-failed")!;
    assert.equal(f.detail!.count, 4, "each URL once, a subdomain of the same site included");
    assert.equal(f.detail!.severity, "serious", "a script that answers 404 or 5xx");
    assert.match(f.measured, /^4 same-site requests failed on the desktop view: script shop\.example\.com\/static\/app\.3f2\.js answered 404; script cdn\.shop\.example\.com\/chunk\.js answered 500; data request shop\.example\.com\/api\/recs answered 503; and more\.$/);
  });
  it("leave out other sites, the visual checks' files, the main document, favicon.ico, the scanner's own downloads and answers, and count 401/403/407/429 apart", async () => {
    const { log } = await logWith((emit) => {
      response(emit, "https://ads.example.net/pixel.js", 404, "Script");
      response(emit, "https://shop.example.com/hero.png", 404, "Image", 10, "text/html");
      response(emit, "https://shop.example.com/missing.css", 404, "Stylesheet");
      response(emit, "https://shop.example.com/font.woff2", 404, "Font");
      response(emit, PAGE, 404, "Document", 100, "text/html");
      response(emit, "https://shop.example.com/favicon.ico", 404, "Other");
      response(emit, "https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.1/x.js", 404, "Script");
      response(emit, "https://shop.example.com/api/cart", 200, "Fetch", 50, "application/json");
      response(emit, "https://shop.example.com/api/me", 401, "Fetch");
      response(emit, "https://shop.example.com/api/session", 403, "XHR");
      response(emit, "https://shop.example.com/api/rate", 429, "Fetch");
    });
    const rel = judgeReliability(log, PAGE, "desktop");
    assert.equal(rel.findings.filter((f) => f.kind === "request-failed").length, 0);
    assert.equal(rel.whoAsks, 3);
  });
  it("a minor finding for a data request that answered 404 alone, moderate for a frame", async () => {
    const one = await logWith((emit) => response(emit, "https://shop.example.com/api/flags", 404, "Fetch"));
    assert.equal(judgeReliability(one.log, PAGE, "phone").findings[0].detail!.severity, "minor");
    const frame = await logWith((emit) => response(emit, "https://shop.example.com/widget.html", 404, "Document"));
    assert.equal(judgeReliability(frame.log, PAGE, "phone").findings[0].detail!.severity, "moderate");
  });
});

describe("mixed content and the JavaScript total", () => {
  it("is serious when the browser blocked an http request from an https page, minor when it only upgraded one", async () => {
    const { log } = await logWith((emit) => {
      emit("Network.requestWillBeSent", { requestId: "m1", request: { url: "http://shop.example.com/old.js", mixedContentType: "blockable" }, type: "Script" });
      emit("Network.loadingFailed", { requestId: "m1", blockedReason: "mixed-content" });
      emit("Network.requestWillBeSent", { requestId: "m2", request: { url: "http://shop.example.com/logo.png", mixedContentType: "optionally-blockable" }, type: "Image" });
    });
    const f = judgeReliability(log, PAGE, "desktop").findings.find((x) => x.kind === "mixed-content")!;
    assert.equal(f.detail!.severity, "serious");
    assert.equal(f.detail!.count, 2);
    assert.match(f.measured, /^1 request over http blocked by the browser, and 1 file referenced over http that the browser upgraded or allowed on the desktop view\. First: shop\.example\.com\/old\.js\.$/);
    const upgraded = await logWith((emit) => emit("Network.requestWillBeSent", { requestId: "m3", request: { url: "http://x.example.com/a.png", mixedContentType: "optionally-blockable" }, type: "Image" }));
    assert.equal(judgeReliability(upgraded.log, PAGE, "desktop").findings[0].detail!.severity, "minor");
    assert.equal(judgeReliability(upgraded.log, "http://shop.example.com/", "desktop").findings.length, 0, "an http page has no mixed content");
  });
  it("adds up JavaScript bytes without the scanner's own downloads, notes more than 1 MB, and knows each URL's size", async () => {
    const { log } = await logWith((emit) => {
      response(emit, "https://shop.example.com/app.js", 200, "Script", 700_000);
      response(emit, "https://cdn.vendor.example.net/sdk.js", 200, "Script", 400_000);
      response(emit, "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.min.js", 200, "Script", 3_000_000);
      response(emit, "https://shop.example.com/hero.jpg", 200, "Image", 900_000, "image/jpeg");
    });
    const rel = judgeReliability(log, PAGE, "desktop");
    assert.equal(rel.jsBytes, 1_100_000);
    assert.match(jsNote(rel.jsBytes)!.measured, /^1\.10 MB of JavaScript transferred \(compressed\)/);
    assert.equal(jsNote(1_000_000), null);
    assert.deepEqual(log.bytesOf("https://shop.example.com/hero.jpg#x"), { bytes: 900_000, mime: "image/jpeg" });
    assert.equal(log.bytesOf("https://shop.example.com/none.jpg"), null);
  });
});

describe("the test copy's bucket prefix", () => {
  it("keeps reports, screenshots and leases under the prefix, and reads the shared opt-out list", async () => {
    const bucket = new MemBucket();
    const b = prefixed(bucket, "scan-test/");
    await b.put("scans/reports/k.json", "{}");
    await b.put("scans/slots.json", "{}");
    await bucket.put("scans/blocklist.json", JSON.stringify({ hosts: ["optout.example.org"] }));
    assert.deepEqual([...bucket.objects.keys()].sort(), ["scan-test/scans/reports/k.json", "scan-test/scans/slots.json", "scans/blocklist.json"]);
    assert.equal(await (await b.get("scans/blocklist.json"))!.text(), JSON.stringify({ hosts: ["optout.example.org"] }));
    assert.deepEqual((await b.list({ prefix: "scans/reports/" })).objects.map((o) => o.key), ["scans/reports/k.json"]);
    await b.delete(["scans/reports/k.json"]);
    assert.equal(bucket.objects.has("scan-test/scans/reports/k.json"), false);
    assert.throws(() => prefixed(bucket, "../"), /STORE_PREFIX/);
  });
});

describe("scan-score/4: the main document's headers, its cookies, deprecations and the page weight", () => {
  it("keeps the main frame's document response with lower-case headers, and the Set-Cookie headers Chrome reports apart", async () => {
    const { log, sent } = await logWith((emit) => {
      // the raw headers carry what the renderer's copy leaves out (Set-Cookie, here HSTS); a long cookie value is dropped
      // so its attributes are never cut off
      emit("Network.responseReceivedExtraInfo", { requestId: "doc1", loaderId: "doc1", headers: { "Set-Cookie": `sid=1; Path=/\ntheme=dark; Secure\nbig=${"v".repeat(5000)}; Path=/; Secure; HttpOnly`, "Strict-Transport-Security": "max-age=600", "X-Frame-Options": "DENY" } });
      emit("Network.responseReceived", { requestId: "doc1", type: "Document", frameId: "MAIN", response: { url: PAGE, status: 200, mimeType: "text/html", headers: { "X-Frame-Options": "DENY" } } });
      emit("Network.responseReceived", { requestId: "ad1", type: "Document", frameId: "AD-FRAME", response: { url: "https://ads.example.net/f", status: 200, mimeType: "text/html", headers: { "x-frame-options": "" } } });
      // a later document for the main frame (a prefetched route the app then shows with pushState) is not the page
      emit("Network.responseReceived", { requestId: "pre1", type: "Document", frameId: "MAIN", response: { url: "https://shop.example.com/app", status: 200, mimeType: "text/html", headers: { "content-disposition": "inline" } } });
    });
    assert.ok(sent.includes("Audits.enable"), "Chrome's Issues are on");
    const d = log.mainDocument(PAGE)!;
    assert.deepEqual(d.headers, { "strict-transport-security": "max-age=600", "x-frame-options": "DENY", "set-cookie": "sid=x; Path=/\ntheme=x; Secure\nbig=x; Path=/; Secure; HttpOnly" });
    assert.deepEqual(d.cookies, ["sid=x; Path=/", "theme=x; Secure", "big=x; Path=/; Secure; HttpOnly"], "names and attributes only, never the values");
    assert.equal(log.mainDocument("https://shop.example.com/other")!.url, PAGE, "the first main-frame document, whatever the page's address became");
  });
  it("is null when no document response was seen", async () => {
    const { log } = await logWith(() => undefined);
    assert.equal(log.mainDocument(PAGE), null);
  });
  it("reports deprecated APIs from Chrome's Issues, one finding, the scanner's own left out", async () => {
    const issue = (type: string, url: string) => ({ issue: { code: "DeprecationIssue", details: { deprecationIssueDetails: { type, sourceCodeLocation: { url, lineNumber: 1, columnNumber: 1 } } } } });
    const { log } = await logWith((emit) => {
      emit("Audits.issueAdded", issue("UnloadHandler", "https://shop.example.com/app.js"));
      emit("Audits.issueAdded", issue("UnloadHandler", "https://shop.example.com/other.js"));
      emit("Audits.issueAdded", issue("PrefixedStorageInfo", "https://tags.example.net/t.js"));
      emit("Audits.issueAdded", issue("Whatever", "https://cdn.jsdelivr.net/npm/@genclass/runtime@0.2.2/x.js"));
      emit("Audits.issueAdded", { issue: { code: "CookieIssue", details: {} } });
      // caused by the scanner's own stand-in CORS answers, and code without a page URL (the scanner's isolated world)
      emit("Audits.issueAdded", issue("AuthorizationCoveredByWildcard", "https://shop.example.com/app.js"));
      emit("Audits.issueAdded", issue("SomethingOld", ""));
    });
    const f = judgeReliability(log, PAGE, "desktop").findings.find((x) => x.kind === "deprecated-api")!;
    assert.deepEqual([f.detail?.severity, f.detail?.count], ["minor", 2]);
    assert.equal(f.measured, "Chrome reported 2 deprecated APIs on the desktop view (1 from scripts on other sites): UnloadHandler (shop.example.com/app.js); PrefixedStorageInfo (tags.example.net/t.js).");
  });
  it("snapshots the bytes and requests at network quiet, the scanner's own downloads left out", async () => {
    const { log } = await logWith((emit) => {
      response(emit, "https://shop.example.com/a.js", 200, "Script", 300_000);
      response(emit, "https://shop.example.com/b.png", 200, "Image", 200_000, "image/png");
      response(emit, "https://genclass.dev/model/x/model.onnx", 200, "Fetch", 9_000_000, "application/octet-stream");
    });
    log.snapshot();
    assert.deepEqual(log.quiet, { bytes: 500_000, requests: 2 });
  });
});
