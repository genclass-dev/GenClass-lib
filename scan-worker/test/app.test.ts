// The HTTP surface with the browser binding mocked: refusals in order, the rate limit, the 6-hour cache, the
// concurrency cap, a full scan streamed as NDJSON (what the interception did to each request, the race probe with and
// without guard), screenshots, the report page and its escaping, the path form, and the retention sweep.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientOf, handle, targetFromPath, type AppDeps, type Env } from "../src/app.ts";
import { REPORT_VERSION } from "../src/report.ts";
import { acquireSlot, cachedReport, cacheKey, CACHE_MS, reportKey, sweep } from "../src/store.ts";
import { FakeBrowser, fakeFetch, Limiter, MemBucket, ndjson, type PageScript } from "./helpers.ts";

const DNS = {
  "shop.example.com": ["93.184.215.14"], "evil.example.com": ["10.0.0.7"], "robots.example.com": ["93.184.215.15"], "a.example.com": ["93.184.215.16"], "b.example.com": ["93.184.215.17"],
  "www.shop.example.com": ["93.184.215.14"], "optout.example.org": ["93.184.215.20"], "live.example.net": ["93.184.215.21"], "sock.example.net": ["192.168.4.4"],
  "cdn.example.net": ["93.184.215.30"], "analytics.example.net": ["93.184.215.31"], "rebind.example.net": ["93.184.215.32"], "inside.example.net": ["fd00::7"],
};
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
    visualSource: "window.__genclassScanVisual = function () {};",
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
      ? [{ kind: "text-invisible", selector: "p.fine-print", box: { x: 40, y: 900, w: 300, h: 16 }, measured: "text contrast 1.08:1 on p.fine-print", detail: { severity: "high", css: "p.fine-print { color: #767676; }" } }]
      : view === "phone"
        ? [{ kind: "page-overflow-x", selector: "div.promo", box: { x: 0, y: 300, w: 452, h: 80 }, measured: "the page scrolls sideways on a 390 px viewport", detail: { severity: "high" } }]
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
  it("one scan at a time per client, and an IPv6 client counts by its /64", async () => {
    const t = setup(SCRIPT);
    assert.equal(clientOf("2001:db8:1:2:aaaa::1"), clientOf("2001:db8:1:2:ffff:1:2:3"));
    assert.notEqual(clientOf("2001:db8:1:2::1"), clientOf("2001:db8:1:3::1"));
    assert.equal(clientOf("203.0.113.9"), "203.0.113.9");
    // a lease held by this client (another page of the same site) blocks a second scan from it, not from others
    const client = await ipKeyOf("2001:db8:1:2::");
    assert.equal(client, await ipKeyOf("2001:db8:1:2::"));
    assert.equal(await acquireSlot(t.bucket, 3, "x1", await cacheKey("https://a.example.com/"), t.deps.now(), await clientHash("2001:db8:1:2::/64")), "ok");
    const mine = await t.post("shop.example.com", "2001:db8:1:2:9999::7");
    assert.equal(mine.status, 429);
    assert.equal(((await mine.json()) as { code: string }).code, "running");
    const other = await t.post("shop.example.com", "2001:db8:1:3::7");
    assert.equal(other.status, 200);
    await ndjson(other);
    await Promise.all(t.waits);
  });
  it("429 when one site has had too many new scans this minute, whoever asks", async () => {
    const t = setup(SCRIPT, { SITE_LIMIT: new Limiter(0) });
    const res = await t.post("shop.example.com");
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as { code: string }).code, "site-rate");
    assert.equal(t.browsers.length, 0);
  });
  it("crawlers and link previews can read a cached report but cannot start a scan", async () => {
    const t = setup(SCRIPT);
    for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Slackbot-LinkExpanding 1.0", "Mozilla/5.0 HeadlessChrome/128.0.0.0 Safari/537.36", "facebookexternalhit/1.1"]) {
      const res = await t.call("/api/scan", { method: "POST", body: JSON.stringify({ url: "shop.example.com" }), headers: { "content-type": "application/json", "user-agent": ua } });
      assert.equal(res.status, 403, ua);
      assert.equal(((await res.json()) as { code: string }).code, "automated");
    }
    assert.equal(t.browsers.length, 0);
  });
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

async function clientHash(client: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`genclass-scan|${client}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    assert.deepEqual(r.findings.map((f: { kind: string }) => f.kind).sort(), ["duplicate-submit", "page-overflow-x", "text-invisible"]);
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
    // the visual checks: report-only with the column off, Tab presses on the desktop only, scrolling everywhere, stopped
    for (const p of b.pages.slice(0, 3)) {
      assert.deepEqual(p.visual.find((c) => c.cmd === "start")!.arg, { id: "a", mode: "observe", fix: false, csp: [] }, p.view);
      assert.equal(p.visual.filter((c) => c.cmd === "start").length, 1, "no re-check without fixes");
      assert.equal(p.visual.at(-1)!.cmd, "stop");
      assert.ok(p.wheels > 0, p.view);
    }
    assert.ok(b.pages[0].keys.length > 0 && b.pages[1].keys.length === 0);

    // stored: the report and three screenshots, under scans/
    const keys = [...t.bucket.objects.keys()];
    assert.ok(keys.every((k) => k.startsWith("scans/")), keys.join(","));
    assert.equal(keys.filter((k) => k.startsWith("scans/shots/")).length, 3);
    const shot = await t.call(r.views[0].shot);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get("content-type"), "image/jpeg");
    // an opt-out stops the screenshots at once too, not only the report
    await t.bucket.put("scans/blocklist.json", JSON.stringify({ hosts: ["shop.example.com"] }));
    assert.equal((await t.call(r.views[0].shot)).status, 404);
    await t.bucket.delete("scans/blocklist.json");
    assert.equal((await t.call(r.views[0].shot)).status, 200);

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

  it("does not serve a cached report from another version of the scanner, or a screenshot without its host", async () => {
    const t = setup(SCRIPT);
    const key = await cacheKey("https://shop.example.com/");
    await t.bucket.put(reportKey(key), JSON.stringify({ v: REPORT_VERSION - 1, scannedAt: new Date(t.deps.now()).toISOString(), display: "shop.example.com" }));
    assert.equal(await cachedReport(t.bucket, key, t.deps.now(), REPORT_VERSION), null);
    assert.equal((await t.call("/api/scan/report?url=shop.example.com")).status, 404);
    await t.bucket.put(`scans/shots/${key}/old0000001-desktop.jpg`, new Uint8Array([0xff, 0xd8]));
    assert.equal((await t.call(`/api/scan/shot/${key}/old0000001-desktop.jpg`)).status, 404);
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

  it("does not load a subresource whose name resolves privately, and leaves out visual findings about files it refused", async () => {
    const t = setup({
      load: [
        { url: "https://inside.example.net/logo.png", type: "image" },
        { url: "https://evil.example.com/app.js", type: "script" },
        { url: "https://gone.example.net/theme.css", type: "stylesheet" },
      ],
    });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const desk = t.browsers[0].pages[0];
    for (const u of ["https://inside.example.net/logo.png", "https://evil.example.com/app.js", "https://gone.example.net/theme.css"]) assert.equal(desk.handled.find((h) => h.url === u)?.outcome, "abort", u);
    assert.ok(msgs.some((m) => m.type === "done"));
    // the hosts the scanner refused are left out of the visual findings; a name with no address fails for visitors too
    const skip = desk.visual.find((c) => c.cmd === "collect")!.arg.skipHosts as string[];
    assert.ok(skip.includes("inside.example.net") && skip.includes("evil.example.com"), skip.join(","));
    assert.ok(!skip.includes("gone.example.net"));
    // each name was looked up once for the whole scan
    const lookups = t.net.calls.filter((c) => c.endsWith("name=inside.example.net&type=A"));
    assert.equal(lookups.length, 1);
  });

  it("with GenClass on, runs the visual checks with their fixes and counts a fix only when the re-check no longer finds it", async () => {
    const fixable = (fixApplied: boolean) => ({ kind: "text-invisible", selector: "p.fine-print", box: null, measured: "text contrast 1.08:1", detail: { severity: "high", fixApplied, fixCss: "p.fine-print { color: rgb(118, 118, 118); }" } });
    const overflow = { kind: "page-overflow-x", selector: "div.promo", box: null, measured: "the page scrolls sideways", detail: { severity: "high" } };
    const script: PageScript = {
      ...SCRIPT,
      findings: (view) => (view === "phone-dark" ? [fixable(false)] : [fixable(true), overflow]),
      recheck: (view) => (view === "phone" ? [fixable(false), overflow] : [overflow]),
    };
    const t = setup(script, { WITH_GENCLASS: "on" });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const r = (msgs.find((m) => m.type === "done") as { report: Record<string, any> }).report;
    const b = t.browsers[0];
    for (const p of b.pages.slice(0, 3)) {
      assert.deepEqual(p.visual.find((c) => c.cmd === "start")!.arg, { id: "a", mode: "guard", fix: true, csp: [] }, p.view);
      assert.equal(p.visual.at(-1)!.cmd, "stop", "engine a is stopped last: every fix is undone before the screenshot");
      assert.equal(p.visual.at(-1)!.arg.id, "a");
    }
    // desktop and phone applied a fix; only the desktop's re-check no longer found it; the dark phone applied none
    assert.ok(b.pages[0].visual.some((c) => c.cmd === "start" && c.arg.id === "c" && c.arg.mode === "observe" && c.arg.fix === false));
    assert.equal(r.views[0].fixes ?? null, null, "the report carries the result per finding, not the raw view data");
    const f = r.findings.find((x: { kind: string }) => x.kind === "text-invisible");
    assert.deepEqual(f.views, ["desktop", "phone", "phone-dark"]);
    assert.equal(f.fixed, null, "not fixed in every view it appeared in");
    assert.equal(f.genclass.status, "not-fixed");
    const o = r.findings.find((x: { kind: string }) => x.kind === "page-overflow-x");
    assert.equal(o.genclass.status, "reported");
    assert.equal(r.withGenClass.shown, true);
    assert.equal(r.withGenClass.fixed, 1, "only the double submit, fixed by guard's own coalesce");
  });

  it("ignores response addresses when the browser reaches the network through a local proxy", async () => {
    const t = setup({ ...SCRIPT, ip: "::1", load: [{ url: "https://cdn.example.net/hero.png", type: "image", ip: "::1" }] });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    assert.ok(msgs.some((m) => m.type === "done"), "every response 'came from' the proxy, which says nothing about the site");
  });

  it("throws the scan away when a response is seen to come from a private address, whatever the name resolved to before", async () => {
    const t = setup({ ...SCRIPT, load: [{ url: "https://rebind.example.net/hero.png", type: "image", ip: "10.1.2.3" }] });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const err = msgs.find((m) => m.type === "error");
    assert.equal(err?.code, "private");
    assert.ok(!msgs.some((m) => m.type === "done"), "no report is streamed");
    assert.deepEqual([...t.bucket.objects.keys()].filter((k) => k.startsWith("scans/shots/") || k.startsWith("scans/reports/")), [], "nothing is saved");
    assert.ok(t.browsers[0].closed);
    assert.deepEqual(JSON.parse(await (await t.bucket.get("scans/slots.json"))!.text()).leases, []);
    // an IPv6 private answer, and an IPv4-mapped one, count the same
    for (const ip of ["fd00::5", "::ffff:127.0.0.1", "169.254.169.254"]) {
      const u = setup({ load: [{ url: "https://rebind.example.net/a.css", type: "stylesheet", ip }] });
      const m = await ndjson(await u.post("shop.example.com"));
      await Promise.all(u.waits);
      assert.equal(m.find((x) => x.type === "error")?.code, "private", ip);
    }
  });

  it("refuses a frame whose host resolves privately, and keeps the scan", async () => {
    const t = setup({ load: [{ url: "https://evil.example.com/widget", type: "document", nav: true, main: false }, { url: "https://unknown-frame.example.net/", type: "document", nav: true, main: false }] });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const desk = t.browsers[0].pages[0];
    assert.equal(desk.handled.find((h) => h.url === "https://evil.example.com/widget")?.outcome, "abort");
    assert.equal(desk.handled.find((h) => h.url === "https://unknown-frame.example.net/")?.outcome, "abort", "a frame name that does not resolve is not loaded either");
    assert.ok(msgs.some((m) => m.type === "done"));
  });

  it("throws the scan away when the page opened a WebSocket to a name that resolves privately", async () => {
    const t = setup({ ...SCRIPT, wsHosts: ["live.example.net", "sock.example.net"] });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    assert.equal(msgs.find((m) => m.type === "error")?.code, "private");
    const ok = setup({ ...SCRIPT, wsHosts: ["live.example.net", "dead.example.net"] });
    const fine = await ndjson(await ok.post("shop.example.com"));
    await Promise.all(ok.waits);
    assert.ok(fine.some((m) => m.type === "done"), "public and unresolvable WebSocket hosts do not stop the scan");
  });

  it("does not follow a redirect to a site that opted out or whose robots.txt says no, and saves nothing", async () => {
    for (const [to, code] of [["https://optout.example.org/", "opted-out"], ["https://robots.example.com/landing", "robots"], ["https://genclass.dev/", "load"]] as const) {
      const t = setup({ ...SCRIPT, redirect: to });
      await t.bucket.put("scans/blocklist.json", JSON.stringify({ hosts: ["optout.example.org"] }));
      const msgs = await ndjson(await t.post("shop.example.com"));
      await Promise.all(t.waits);
      const desk = t.browsers[0].pages[0];
      assert.equal(desk.handled.find((h) => h.url === to)?.outcome, "abort", to);
      const err = msgs.find((m) => m.type === "error");
      assert.equal(err?.code, code, `${to}: ${JSON.stringify(err)}`);
      assert.ok(![...t.bucket.objects.keys()].some((k) => k.startsWith("scans/reports/") || k.startsWith("scans/shots/")), to);
    }
    // an ordinary redirect (to www.) is followed and checked once
    const ok = setup({ ...SCRIPT, redirect: "https://www.shop.example.com/" });
    const msgs = await ndjson(await ok.post("shop.example.com"));
    await Promise.all(ok.waits);
    assert.ok(msgs.some((m) => m.type === "done"));
  });

  it("says when the page's own POSTs got stand-in answers while loading, and does not score what may come from them", async () => {
    const t = setup({
      load: [{ url: "https://shop.example.com/graphql", method: "POST", type: "fetch", body: '{"query":"{products{price}}"}' }],
      findings: (view) => (view === "phone-dark" ? [] : [{ kind: "text-template-leak", selector: "span.price", box: { x: 10, y: 10, w: 80, h: 18 }, measured: '"Price: $NaN"', detail: { severity: "high" } }]),
    });
    const msgs = await ndjson(await t.post("shop.example.com"));
    await Promise.all(t.waits);
    const r = (msgs.find((m) => m.type === "done") as { report: Record<string, any> }).report;
    assert.equal(r.views[0].standIns, 1);
    assert.ok(r.views[0].notes.some((n: string) => /sent 1 request other than GET while loading \(POST shop\.example\.com\/graphql\)/.test(n)), r.views[0].notes.join(" | "));
    const leak = r.findings.find((f: { kind: string }) => f.kind === "text-template-leak");
    assert.match(leak.unscored, /stand-in answer/);
    assert.equal(r.score.value, 100);
  });

  it("stops the browser and keeps nothing when the person who asked goes away", async () => {
    const t = setup({ ...SCRIPT, model: { state: "loading" } });
    const res = await t.post("shop.example.com");
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.all(t.waits);
    assert.ok(t.browsers[0].closed);
    assert.ok(!t.browsers[0].pages.some((p) => p.mode === "guard"), "the scan stopped before the guard pass");
    assert.ok(![...t.bucket.objects.keys()].some((k) => k.startsWith("scans/reports/") || k.startsWith("scans/shots/")));
    assert.deepEqual(JSON.parse(await (await t.bucket.get("scans/slots.json"))!.text()).leases, []);
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
    await t.bucket.put(reportKey(key), JSON.stringify({ v: REPORT_VERSION, scannedAt: new Date(t.deps.now()).toISOString(), display: evil, url: "https://shop.example.com/x", findings: [{ what: evil, selector: evil }], score: { value: 1, categories: [] } }));
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
  it("treats README.md, backup.zip and install.sh as missing files, unless they have a path or a scheme", async () => {
    for (const p of ["/README.md", "/backup.zip", "/install.sh", "/setup.py", "/clip.mov", "/Main.java", "/docs.v2.zip"]) assert.equal(targetFromPath(p), null, p);
    assert.equal(targetFromPath("/https://bun.sh"), "https://bun.sh");
    assert.equal(targetFromPath("/bun.sh/"), "bun.sh/");
    for (const p of ["/socket.io", "/character.ai", "/notion.so", "/web.app", "/allegro.pl"]) assert.ok(targetFromPath(p), p);
    const t = setup(SCRIPT);
    assert.equal((await t.call("/README.md")).status, 404);
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
