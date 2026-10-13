// The HTTP surface with the browser binding mocked: refusals in order, the rate limit, the 6-hour cache, the
// concurrency cap, a full scan streamed as NDJSON (what the interception did to each request, the race probe with and
// without guard), screenshots, the report page and its escaping, the path form, and the retention sweep.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handle, targetFromPath, type AppDeps, type Env } from "../src/app.ts";
import { acquireSlot, cacheKey, CACHE_MS, reportKey, sweep } from "../src/store.ts";
import { FakeBrowser, fakeFetch, Limiter, MemBucket, ndjson, type PageScript } from "./helpers.ts";

const DNS = { "shop.example.com": ["93.184.215.14"], "evil.example.com": ["10.0.0.7"], "robots.example.com": ["93.184.215.15"], "a.example.com": ["93.184.215.16"], "b.example.com": ["93.184.215.17"] };
const ROBOTS = { "robots.example.com": "User-agent: GenClassScan\nDisallow: /\n" };

function setup(script: PageScript = {}, envExtra: Partial<Env> = {}) {
  let clock = Date.parse("2026-10-13T12:00:00Z");
  const bucket = new MemBucket(() => clock);
  const limiter = new Limiter(5);
  const browsers: FakeBrowser[] = [];
  const net = fakeFetch(DNS, ROBOTS);
  let n = 0;
  const deps: AppDeps = {
    launch: async () => {
      const b = new FakeBrowser(script);
      browsers.push(b);
      return b;
    },
    fetch: net.fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, 0));
    },
    runtimeSource: async () => "window.__rt = 1;",
    scanId: () => `scan${String(++n).padStart(4, "0")}`,
  };
  const env: Env = { BROWSER: { fetch }, BUCKET: bucket, SCAN_LIMIT: limiter, MAX_CONCURRENT: "2", ...envExtra };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
  const call = (path: string, init?: RequestInit & { ip?: string }) =>
    handle(new Request(`https://genclass-scan.example.workers.dev${path}`, { ...init, headers: { "cf-connecting-ip": init?.ip ?? "203.0.113.9", ...(init?.headers as Record<string, string>) } }), env, ctx, deps);
  const post = (url: unknown, ip?: string) => call("/api/scan", { method: "POST", body: JSON.stringify({ url }), headers: { "content-type": "application/json" }, ip });
  return { bucket, limiter, browsers, net, deps, env, ctx, waits, call, post, advance: (ms: number) => (clock += ms) };
}

const SCRIPT: PageScript = {
  load: [
    { url: "https://shop.example.com/app.css", type: "stylesheet" },
    { url: "http://127.0.0.1:9000/internal", type: "fetch" },
    { url: "http://169.254.169.254/latest/meta-data/", type: "image" },
    { url: "https://analytics.example.net/collect", method: "POST", type: "ping" },
    { url: "https://shop.example.com/api/cart", method: "POST", type: "fetch", body: "{}" },
  ],
  findings: (view) =>
    view === "desktop"
      ? [{ kind: "low-contrast", selector: "p.fine-print", box: { x: 40, y: 900, w: 300, h: 16 }, measured: "Contrast 1.08:1 (#F7F7F7 on #FFFFFF), 13 px text", detail: { fg: [247, 247, 247], bg: [255, 255, 255] } }]
      : view === "phone"
        ? [{ kind: "horizontal-overflow", selector: "div.promo", box: { x: 0, y: 300, w: 452, h: 80 }, measured: "Page is 452 px wide on a 390 px screen", detail: { tag: "div", viewport: 390 } }]
        : [],
  search: true,
  button: true,
  postsOnDoubleClick: { observe: 2, guard: 1 },
};

describe("POST /api/scan refusals, in order", () => {
  it("400 for an address it will not load, before any browser starts", async () => {
    const t = setup(SCRIPT);
    for (const u of ["localhost", "127.0.0.1", "http://[::1]/", "ftp://x.com", "genclass.dev", "nope"]) {
      const res = await t.post(u);
      assert.equal(res.status, 400, u);
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    }
    assert.equal(t.browsers.length, 0);
    assert.equal(t.limiter.calls.length, 0, "refusals do not use up the rate limit");
  });
  it("400 when the name resolves to a private address", async () => {
    const t = setup(SCRIPT);
    const res = await t.post("evil.example.com");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, "private");
    assert.equal(t.browsers.length, 0);
  });
  it("403 when robots.txt has a GenClassScan group that disallows the page", async () => {
    const t = setup(SCRIPT);
    const res = await t.post("robots.example.com/");
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { code: string }).code, "robots");
  });
  it("403 for a host on the opt-out list, subdomains included, even with a cached report", async () => {
    const t = setup(SCRIPT, { BLOCKLIST: "other.example.org" });
    await t.bucket.put(reportKey(await cacheKey("https://shop.example.com/")), JSON.stringify({ v: 1, scannedAt: new Date(t.deps.now()).toISOString(), display: "shop.example.com" }));
    await t.bucket.put("scans/blocklist.json", JSON.stringify({ hosts: ["example.com"] }));
    assert.equal((await t.post("shop.example.com")).status, 403);
    assert.equal((await t.post("www.other.example.org")).status, 403);
    assert.equal((await t.call("/api/scan/report?url=shop.example.com")).status, 403);
    assert.doesNotMatch(await (await t.call("/scan?url=shop.example.com")).text(), /"report":\{/);
    assert.equal(t.browsers.length, 0);
  });
  it("403 for a cross-site Origin, 405 for GET, 400 for bad JSON", async () => {
    const t = setup(SCRIPT);
    assert.equal((await t.call("/api/scan", { method: "POST", body: '{"url":"shop.example.com"}', headers: { origin: "https://elsewhere.example.net" } })).status, 403);
    assert.equal((await t.call("/api/scan")).status, 405);
    assert.equal((await t.call("/api/scan", { method: "POST", body: "{" })).status, 400);
  });
});

describe("rate limit and concurrency", () => {
  it("429 after five new scans a minute from one address; other addresses are unaffected", async () => {
    const t = setup(SCRIPT);
    t.limiter.calls.push(...Array(5).fill(await ipKeyOf("203.0.113.9")));
    const res = await t.post("shop.example.com");
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(t.browsers.length, 0);
    const other = await t.post("shop.example.com", "198.51.100.4");
    assert.equal(other.status, 200);
    await ndjson(other);
    await Promise.all(t.waits);
  });
  it("503 when every slot is taken, 409 while the same address is being scanned", async () => {
    const t = setup(SCRIPT);
    const now = t.deps.now();
    assert.equal(await acquireSlot(t.bucket, 2, "x1", await cacheKey("https://a.example.com/"), now), "ok");
    assert.equal(await acquireSlot(t.bucket, 2, "x2", await cacheKey("https://b.example.com/"), now), "ok");
    const busy = await t.post("shop.example.com");
    assert.equal(busy.status, 503);
    const same = await t.post("a.example.com");
    assert.equal(same.status, 409);
    assert.equal(((await same.json()) as { code: string }).code, "in-progress");
    t.advance(80_000); // leases expire by themselves
    const res = await t.post("shop.example.com");
    assert.equal(res.status, 200);
    await ndjson(res);
    await Promise.all(t.waits);
  });
});

async function ipKeyOf(ip: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`genclass-scan|${ip}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("a full scan with the browser mocked", () => {
  it("streams progress then the report, saves it with the screenshots, and serves the cache for 6 hours", async () => {
    const t = setup(SCRIPT);
    const res = await t.post("shop.example.com");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /ndjson/);
    const msgs = await ndjson(res);
    await Promise.all(t.waits);
    const steps = msgs.filter((m) => m.type === "progress").map((m) => m.step);
    for (const s of ["check", "browser", "views", "probe", "guard", "save"]) assert.ok(steps.includes(s), `progress ${s}: ${steps}`);
    const done = msgs.find((m) => m.type === "done") as { report: Record<string, any> } | undefined;
    assert.ok(done, JSON.stringify(msgs.filter((m) => m.type === "error")));
    const r = done.report;

    // the findings: contrast (desktop), overflow (phone), and the double click that sent two identical POSTs
    assert.deepEqual(r.findings.map((f: { kind: string }) => f.kind).sort(), ["duplicate-submit", "horizontal-overflow", "low-contrast"]);
    assert.equal(r.score.value, 70);
    assert.equal(r.withGenClass.shown, false, "the column is behind the flag by default");
    const dup = r.findings.find((f: { kind: string }) => f.kind === "duplicate-submit");
    assert.match(dup.fixed.how, /coalesced/);
    assert.equal(r.probe.observe.clicked.sent, 2);
    assert.equal(r.probe.guard.clicked.sent, 1);
    assert.equal(r.probe.observe.model.state, "ready");

    // the interception: non-GET answered locally, private hosts aborted, nothing else touched
    const b = t.browsers[0];
    assert.ok(b.closed, "the browser is closed");
    const desk = b.pages[0];
    const by = (u: string) => desk.handled.filter((h) => h.url.startsWith(u));
    assert.equal(by("http://127.0.0.1")[0].outcome, "abort");
    assert.equal(by("http://169.254.169.254")[0].outcome, "abort");
    assert.equal(by("https://analytics.example.net")[0].outcome, "respond");
    assert.equal(by("https://shop.example.com/api/cart")[0].outcome, "respond");
    assert.equal(by("https://shop.example.com/app.css")[0].outcome, "continue");
    for (const p of b.pages) for (const h of p.handled) if (h.method !== "GET") assert.equal(h.outcome, "respond", `${h.method} ${h.url} never reaches the network`);
    const subs = desk.handled.filter((h) => h.url.endsWith("/api/subscribe"));
    assert.equal(subs.length, 2);
    assert.ok(subs.every((h) => h.outcome === "respond" && h.status === 200));
    assert.ok(desk.handled.filter((h) => h.url.includes("/api/search?q=")).length === 3, "typed a, ab, abc");

    // the runtime: observe on the desktop page, guard on the second desktop page, telemetry off, model from the mirror
    assert.ok(desk.onNew.some((s) => s.includes('"mode":"observe"') && s.includes('"telemetry":false') && s.includes("genclass.dev/model/")));
    const guardPage = b.pages.find((p) => p.mode === "guard")!;
    assert.ok(guardPage.onNew.some((s) => s.includes('"holdBudgetMs":900')));
    assert.ok(b.pages.every((p) => p.ua.endsWith("GenClassScan/1.0 (+https://genclass.dev/scan)")));
    assert.deepEqual(b.pages.slice(0, 3).map((p) => [p.viewport!.width, p.scheme]), [[1366, "light"], [390, "light"], [390, "dark"]]);

    // stored: the report and three screenshots, under scans/
    const keys = [...t.bucket.objects.keys()];
    assert.ok(keys.every((k) => k.startsWith("scans/")), keys.join(","));
    assert.equal(keys.filter((k) => k.startsWith("scans/shots/")).length, 3);
    const shot = await t.call(r.views[0].shot);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get("content-type"), "image/jpeg");

    // cache: the next POST and the report endpoint answer without a browser, until 6 hours have passed
    const again = await t.post("https://shop.example.com/");
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { cached: boolean }).cached, true);
    assert.equal(t.browsers.length, 1);
    assert.equal((await t.call("/api/scan/report?url=shop.example.com")).status, 200);
    t.advance(CACHE_MS + 1000);
    assert.equal((await t.call("/api/scan/report?url=shop.example.com")).status, 404);
    // the slot was released
    const slots = JSON.parse(await (await t.bucket.get("scans/slots.json"))!.text());
    assert.deepEqual(slots.leases, []);
  });

  it("reports a page that does not load as an error line, and releases the slot", async () => {
    const t = setup({ gotoError: "net::ERR_NAME_NOT_RESOLVED at https://shop.example.com/" });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const err = msgs.find((m) => m.type === "error");
    assert.ok(err);
    assert.match(String(err.message), /did not resolve/);
    assert.deepEqual(JSON.parse(await (await t.bucket.get("scans/slots.json"))!.text()).leases, []);
  });

  it("says so when the model does not load in time, instead of pretending", async () => {
    const t = setup({ ...SCRIPT, model: { state: "loading" } });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const r = (msgs.find((m) => m.type === "done") as { report: Record<string, any> }).report;
    assert.equal(r.probe.observe.model.state, "loading");
    assert.ok(r.ms.total <= 45_000 + 2000, `budget respected: ${r.ms.total}`);
  });

  it("refuses a redirect to a host that resolves privately", async () => {
    const t = setup({ load: [{ url: "https://evil.example.com/", type: "document", nav: true, main: true }] });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const desk = t.browsers[0].pages[0];
    const hop = desk.handled.find((h) => h.url === "https://evil.example.com/");
    assert.equal(hop?.outcome, "abort");
    assert.ok(msgs.some((m) => m.type === "done"));
  });
});

describe("pages", () => {
  it("GET /scan and /scan/about carry a nonce CSP, noindex, and no inline style attributes", async () => {
    const t = setup(SCRIPT);
    for (const p of ["/scan", "/scan/about", "/scan?url=shop.example.com"]) {
      const res = await t.call(p);
      assert.equal(res.status, 200, p);
      const csp = res.headers.get("content-security-policy")!;
      const nonce = /'nonce-([A-Za-z0-9]+)'/.exec(csp)![1];
      assert.match(res.headers.get("x-robots-tag")!, /noindex/);
      const body = await res.text();
      assert.doesNotMatch(body, /\sstyle="/, `${p} has an inline style attribute (blocked by the CSP)`);
      for (const tag of body.match(/<(script|style)\b[^>]*>/g) || []) if (!/type="application\/json"/.test(tag)) assert.ok(tag.includes(`nonce="${nonce}"`), `${p}: ${tag}`);
      assert.doesNotMatch(body, /<script[^>]+src=/, "no external scripts");
      assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML|document\.write/);
      assert.doesNotMatch(body, /—/, "no em dashes");
    }
  });
  it("escapes a hostile report into the JSON block and the title", async () => {
    const t = setup(SCRIPT);
    const key = await cacheKey("https://shop.example.com/x");
    const evil = "</script><img src=x onerror=alert(1)>";
    await t.bucket.put(reportKey(key), JSON.stringify({ v: 1, scannedAt: new Date(t.deps.now()).toISOString(), display: evil, url: "https://shop.example.com/x", findings: [{ what: evil, selector: evil }], score: { value: 1, categories: [] } }));
    const body = await (await t.call("/scan?url=shop.example.com/x")).text();
    assert.doesNotMatch(body, /<img src=x/);
    assert.equal(body.split("</script>").length - 1, body.split("<script").length - 1, "no early </script>");
    const data = /<script type="application\/json" id="data">([^<]*)<\/script>/.exec(body)![1];
    assert.equal(JSON.parse(data).report.display, evil, "the data survives intact for textContent");
    for (const input of ['shop.example.com/"><svg onload=alert(1)>', '"><svg onload=alert(1)>', "javascript:alert(1)//<svg onload=alert(1)>"]) {
      const page = await (await t.call(`/scan?url=${encodeURIComponent(input)}`)).text();
      assert.doesNotMatch(page, /<svg onload/, input);
    }
  });
  it("shows the refusal for a blocked address without starting anything", async () => {
    const t = setup(SCRIPT);
    const body = await (await t.call("/scan?url=127.0.0.1")).text();
    assert.match(body, /"error":\{"code":"ip"/);
    assert.equal(t.browsers.length, 0);
  });
  it("serves the path form genclass.dev/<url> and 404s other paths", async () => {
    const t = setup(SCRIPT);
    const res = await t.call("/shop.example.com/pricing");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"display":"shop.example.com\/pricing"/);
    assert.equal((await t.call("/https://shop.example.com/")).status, 200);
    assert.equal((await t.call("/not-a-host")).status, 404);
    assert.equal((await t.call("/scan/nothing")).status, 404);
    assert.equal((await t.call("/api/scan/shot/zz/../../x")).status, 404);
  });
  it("targetFromPath accepts hostnames with a TLD and http(s): prefixes only", () => {
    assert.equal(targetFromPath("/example.com"), "example.com");
    assert.equal(targetFromPath("/https://example.com/pricing"), "https://example.com/pricing");
    assert.equal(targetFromPath("/https:/example.com"), "https://example.com");
    for (const p of ["/styles.css", "/mend.js", "/og.png", "/docs", "/a b.com", "/<x>.com", "/foo.notatld"]) assert.equal(targetFromPath(p), null, p);
  });
});

describe("retention sweep", () => {
  it("deletes reports and screenshots older than 24 hours and keeps the rest", async () => {
    let now = Date.parse("2026-10-13T00:00:00Z");
    const bucket = new MemBucket(() => now);
    await bucket.put("scans/shots/k/old-desktop.jpg", "x");
    await bucket.put("scans/reports/old.json", "{}");
    await bucket.put("events/dt=2026-10-12/keep.jsonl.gz", "telemetry is not ours");
    now += 25 * 60 * 60 * 1000;
    await bucket.put("scans/shots/k/new-desktop.jpg", "x");
    assert.equal(await sweep(bucket, now), 2);
    assert.deepEqual([...bucket.objects.keys()].sort(), ["events/dt=2026-10-12/keep.jsonl.gz", "scans/shots/k/new-desktop.jpg"]);
  });
});
