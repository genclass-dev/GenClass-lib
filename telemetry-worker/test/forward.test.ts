import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/collector.js";
import { resetTokenCache } from "../src/dashboard.js";
import { checkConfig, detectionRecords, HOURLY_CAP, maskConfig, openConfig, parseSentryDsn, publicHttpsUrl, sealConfig, webhookSignature } from "../src/forward.js";
import { resetOwnerCache } from "../src/paid.js";
import { advance, call, createApp, detection, resetClock, sendBatch, setPlan, setup, signedIn, now, type Fetch } from "./account-helpers.js";

// Forwarding (src/forward.ts): paid plans only, settings encrypted at rest with INTEGRATIONS_KEY, one request per
// record to Sentry, PostHog, Datadog, Slack or a signed webhook, never page text, dedupe per (app, diagnosis and route,
// hour) and at most 60 records per app per hour, failures in last_error and never in the collector's answer.

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i * 7 + 1)).toString("base64");
const LIVE = { STRIPE_SECRET_KEY: "sk_test_fake", INTEGRATIONS_KEY: KEY };
const DSN = "https://0123456789abcdef0123456789abcdef@o12345.ingest.us.sentry.io/4504000000000001";
const SETTINGS: Record<string, Record<string, unknown>> = {
  sentry: { dsn: DSN },
  posthog: { key: "phc_abcdefghijklmnop1234", host: "https://eu.i.posthog.com" },
  datadog: { api_key: "0123456789abcdef0123456789abcdef", site: "datadoghq.eu" },
  slack: { url: "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX" },
  webhook: { url: "https://receiver.example.net/in/genclass" },
};

beforeEach(() => {
  resetClock();
  resetTokenCache();
  resetOwnerCache();
});

function recorder(status = 200) {
  const sent: { url: string; init: RequestInit; body: string; headers: Record<string, string> }[] = [];
  const f: Fetch = async (url, init = {}) => {
    sent.push({ url, init, body: String(init.body ?? ""), headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return new Response("{}", { status });
  };
  return { sent, f };
}

async function paidApp(over: Partial<Env> = {}, plan = "pro") {
  const t = setup({ ...LIVE, ...over });
  const a = await signedIn(t.env);
  setPlan(t.sql, a.account.id, plan);
  const app = await createApp(t.env, a.cookie, "Acme shop");
  const put = (kind: string, body = SETTINGS[kind]!) => call(t.env, "PUT", `/api/account/projects/${app.id}/integrations/${kind}`, { body, cookie: a.cookie });
  return { ...t, ...a, app, put };
}

describe("forwarding settings: encrypted at rest, masked on the way out", () => {
  it("round-trips with INTEGRATIONS_KEY, bound to the app and kind; another key, row or a tampered value reads as nothing", async () => {
    const env = { BUCKET: { async put() {} }, INTEGRATIONS_KEY: KEY } as Env;
    const sealed = await sealConfig(env, "0123456789abcdef", "slack", { url: "https://hooks.slack.com/services/T/B/X" });
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("hooks.slack.com");
    expect(await openConfig(env, "0123456789abcdef", "slack", sealed)).toEqual({ url: "https://hooks.slack.com/services/T/B/X" });
    expect(await openConfig(env, "fedcba9876543210", "slack", sealed)).toBeNull();
    expect(await openConfig(env, "0123456789abcdef", "webhook", sealed)).toBeNull();
    expect(await openConfig({ ...env, INTEGRATIONS_KEY: Buffer.from(new Uint8Array(32)).toString("base64") }, "0123456789abcdef", "slack", sealed)).toBeNull();
    expect(await openConfig(env, "0123456789abcdef", "slack", sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA"))).toBeNull();
    await expect(sealConfig({ BUCKET: env.BUCKET }, "0123456789abcdef", "slack", {})).rejects.toThrow(/INTEGRATIONS_KEY/);
    await expect(sealConfig({ BUCKET: env.BUCKET, INTEGRATIONS_KEY: "c2hvcnQ=" }, "0123456789abcdef", "slack", {})).rejects.toThrow(/INTEGRATIONS_KEY/);
  });

  it("without INTEGRATIONS_KEY nothing can be saved, and the page says so", async () => {
    const t = await paidApp({ INTEGRATIONS_KEY: undefined });
    const r = await t.put("slack");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toMatch(/no encryption key/);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM integrations")[0]!.n).toBe(0);
    expect(await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text()).toContain("Not available on this server yet.");
  });

  it("stored rows hold ciphertext only; the API and the page show masked settings, never a key, URL path or secret", async () => {
    const t = await paidApp();
    for (const kind of Object.keys(SETTINGS)) expect((await t.put(kind)).status, kind).toBe(200);
    for (const r of t.sql.rows("SELECT config FROM integrations")) {
      expect(String(r.config)).toMatch(/^v1\./);
      for (const secret of ["0123456789abcdef0123456789abcdef", "phc_abcdefghijklmnop1234", "XXXXXXXXXXXX", "receiver.example.net"]) expect(String(r.config)).not.toContain(secret);
    }
    const list = await (await call(t.env, "GET", `/api/account/projects/${t.app.id}/integrations`, { cookie: t.cookie })).text();
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    for (const out of [list, html]) {
      for (const secret of ["0123456789abcdef0123456789abcdef", "phc_abcdefghijklmnop1234", "XXXXXXXXXXXX", "/in/genclass", "gcw_"]) expect(out, secret).not.toContain(secret);
    }
    expect(JSON.parse(list).integrations.map((x: any) => x.summary)).toEqual([
      "datadoghq.eu, key ...cdef",
      "eu.i.posthog.com, key phc_...1234",
      "o12345.ingest.us.sentry.io, project 4504000000000001",
      "hooks.slack.com, webhook ...XXXXXX",
      "receiver.example.net/...",
    ]);
  });

  it("checks what is typed for each kind", () => {
    expect(parseSentryDsn(DSN)).toEqual({ key: "0123456789abcdef0123456789abcdef", envelope: "https://o12345.ingest.us.sentry.io/api/4504000000000001/envelope/" });
    expect(parseSentryDsn("https://key12345@sentry.io/prefix/42")?.envelope).toBe("https://sentry.io/prefix/api/42/envelope/");
    expect(parseSentryDsn("https://key12345@o1.ingest.de.sentry.io/42")?.envelope).toBe("https://o1.ingest.de.sentry.io/api/42/envelope/");
    // only Sentry's own hosts, on the default port
    for (const bad of [
      "http://key12345@sentry.io/42",
      "https://sentry.io/42",
      "https://key12345@sentry.example.com/42",
      "https://abcdefgh@127.0.0.1:8443/1",
      "https://abcdefgh@genclass.dev/1",
      "https://abcdefgh@o1.ingest.sentry.io:8443/1",
      "https://abcdefgh@sentry.io.evil.example/1",
      "https://abcdefgh@notsentry.io/1",
    ]) {
      expect(parseSentryDsn(bad), bad).toBeNull();
    }
    expect("error" in checkConfig("datadog", { api_key: "x", site: "datadoghq.com" })).toBe(true);
    expect("error" in checkConfig("datadog", { api_key: "0123456789abcdef0123456789abcdef", site: "evil.com" })).toBe(true);
    expect("error" in checkConfig("slack", { url: "https://evil.example/services/x" })).toBe(true);
    expect("error" in checkConfig("posthog", { key: "phc_abcdefghijklmnop1234", host: "http://posthog.example" })).toBe(true);
    for (const bad of [
      "http://example.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://localhost./x",
      "https://example.com./x",
      "https://example.com:8443/x",
      "https://user:pw@example.com/x",
      "https://[::1]/x",
      "https://intranet/x",
      "https://x.internal/y",
      // GenClass itself: a destination there would post to the collector's own routes
      "https://genclass.dev/api/projects",
      "https://www.genclass.dev/x",
      "https://genclass-telemetry.someone.workers.dev/v1/events",
    ]) {
      expect(publicHttpsUrl(bad), bad).toBeNull();
    }
    expect(publicHttpsUrl("https://example.com:443/x")?.toString()).toBe("https://example.com/x");
    expect(publicHttpsUrl("https://hooks.dev.example/x", ["dev.example"])).toBeNull();
    expect("error" in checkConfig("webhook", { url: "https://genclass.dev/api/projects" })).toBe(true);
    expect("error" in checkConfig("webhook", { url: "https://collector.example.org/x" }, null, ["collector.example.org"])).toBe(true);
    expect("error" in checkConfig("posthog", { key: "phc_abcdefghijklmnop1234", host: "https://genclass.dev" })).toBe(true);
    const w = checkConfig("webhook", { url: "https://example.com/h" }) as { config: Record<string, unknown> };
    expect(w.config.secret).toMatch(/^gcw_[A-Za-z0-9_-]{43}$/);
    // saving the URL again keeps the secret unless asked to rotate it
    expect((checkConfig("webhook", { url: "https://example.com/h2" }, w.config) as any).config.secret).toBe(w.config.secret);
    expect((checkConfig("webhook", { url: "https://example.com/h2", rotate: true }, w.config) as any).config.secret).not.toBe(w.config.secret);
    expect(maskConfig("slack", null)).toMatch(/unreadable/);
  });
});

describe("forwarding: paid plans only", () => {
  it("Free cannot save, test or turn on a destination; the page offers the plans instead", async () => {
    const t = await paidApp({}, "free");
    const r = await t.put("slack");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ upgrade_url: "https://genclass.dev/account/billing" });
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    expect(html).toContain("On Pro and Custom, GenClass sends each new detection");
    expect(html).not.toContain('data-kind="slack"');
  });

  it("an app whose owner went back to Free stops forwarding, even with a destination still on", async () => {
    const t = await paidApp();
    expect((await t.put("slack")).status).toBe(200);
    setPlan(t.sql, t.account.id, "free");
    resetOwnerCache();
    const out = recorder();
    await sendBatch(t.env, t.app.token, detection(), { fetch: out.f });
    expect(out.sent).toEqual([]);
  });

  it("CSRF and sessions: settings change only from the browser with our Origin; another account gets 404", async () => {
    const t = await paidApp();
    const path = `/api/account/projects/${t.app.id}/integrations/slack`;
    expect((await call(t.env, "PUT", path, { body: SETTINGS.slack, cookie: t.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(t.env, "PUT", path, { body: SETTINGS.slack })).status).toBe(401);
    const b = await signedIn(t.env, "bob@example.com");
    setPlan(t.sql, b.account.id, "pro");
    expect((await call(t.env, "PUT", path, { body: SETTINGS.slack, cookie: b.cookie })).status).toBe(404);
    expect((await call(t.env, "GET", `/api/account/projects/${t.app.id}/integrations`, { cookie: b.cookie })).status).toBe(404);
    expect((await call(t.env, "PUT", `/api/account/projects/${t.app.id}/integrations/email`, { body: {}, cookie: t.cookie })).status).toBe(404);
    expect((await call(t.env, "PUT", path, { body: { url: "https://example.com/x" }, cookie: t.cookie })).status).toBe(400);
  });
});

describe("forwarding: one compact record per new detection, to each destination", () => {
  it("Sentry, PostHog, Datadog, Slack and a signed webhook each get the record in their own format, and no page text", async () => {
    const t = await paidApp();
    let secret = "";
    for (const kind of Object.keys(SETTINGS)) {
      const r = await t.put(kind);
      const j = (await r.json()) as any;
      if (kind === "webhook") secret = j.secret;
    }
    expect(secret).toMatch(/^gcw_/);
    const out = recorder();
    await sendBatch(t.env, t.app.token, [{ t: "session", seq: 0, host: "shop.example", route: "/" }, ...detection("duplicate", "/checkout")], { fetch: out.f });
    expect(out.sent.map((s) => s.url).sort()).toEqual(
      [
        "https://o12345.ingest.us.sentry.io/api/4504000000000001/envelope/",
        "https://eu.i.posthog.com/capture/",
        "https://http-intake.logs.datadoghq.eu/api/v2/logs",
        "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX",
        "https://receiver.example.net/in/genclass",
      ].sort(),
    );
    for (const s of out.sent) {
      expect(s.body, s.url).not.toContain("SECRET PAGE TEXT");
      expect(s.body, s.url).not.toContain("situation");
      expect(s.init.redirect).toBe("manual");
    }
    const by = (host: string) => out.sent.find((s) => s.url.includes(host))!;
    const dashboard = `https://genclass.dev/account/apps/${t.app.id}`;

    const sentry = by("sentry.io");
    expect(sentry.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(sentry.headers["x-sentry-auth"]).toBe("Sentry sentry_version=7, sentry_client=genclass-forwarder/1, sentry_key=0123456789abcdef0123456789abcdef");
    const [head, item, event] = sentry.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(head.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toEqual({ type: "event", content_type: "application/json" });
    expect(event).toMatchObject({
      event_id: head.event_id,
      level: "warning",
      message: { formatted: "GenClass found duplicate on /checkout in Acme shop (confidence 0.97)" },
      tags: { "genclass.diagnosis": "duplicate", "genclass.route": "/checkout", "genclass.trigger": "delivery", "genclass.runtime": "0.3.0", "genclass.model": "0.2.0" },
      extra: { confidence: 0.97, dashboard, app: "Acme shop" },
      fingerprint: ["genclass", "duplicate", "/checkout"],
    });

    const posthog = JSON.parse(by("posthog").body);
    expect(posthog).toMatchObject({ api_key: "phc_abcdefghijklmnop1234", event: "genclass detection", distinct_id: `genclass:${t.app.id}`, timestamp: now().toISOString() });
    expect(posthog.properties).toMatchObject({ diagnosis: "duplicate", route: "/checkout", confidence: 0.97, dashboard, $process_person_profile: false });

    const dd = by("datadoghq");
    expect(dd.headers["dd-api-key"]).toBe("0123456789abcdef0123456789abcdef");
    const [log] = JSON.parse(dd.body);
    expect(log).toMatchObject({ ddsource: "genclass", service: "genclass", status: "warning", message: "GenClass found duplicate on /checkout in Acme shop (confidence 0.97)" });
    expect(log.ddtags).toBe(`diagnosis:duplicate,route:/checkout,app:${t.app.id},runtime:0.3.0`);

    expect(JSON.parse(by("slack").body)).toEqual({ text: `GenClass found *duplicate* on \`/checkout\` in Acme shop (confidence 0.97). <${dashboard}|Open the dashboard>` });

    const hook = by("receiver.example.net");
    const body = JSON.parse(hook.body);
    expect(body).toEqual({
      type: "genclass.detection",
      diagnosis: "duplicate",
      confidence: 0.97,
      trigger: "delivery",
      route: "/checkout",
      runtime: "0.3.0",
      model: "0.2.0",
      time: now().toISOString(),
      app: "Acme shop",
      app_id: t.app.id,
      dashboard,
    });
    const t0 = Math.floor(now().getTime() / 1000);
    expect(hook.headers["x-genclass-signature"]).toBe(await webhookSignature(secret, hook.body, t0));
    expect(hook.headers["x-genclass-event"]).toBe("detection");
    expect(t.sql.rows("SELECT kind, last_sent, last_error FROM integrations ORDER BY kind").every((r) => r.last_sent === now().toISOString() && r.last_error === null)).toBe(true);
  });

  it("dedupe: the same problem on the same page goes out once an hour; the next hour it goes again", async () => {
    const t = await paidApp();
    await t.put("slack");
    const out = recorder();
    await sendBatch(t.env, t.app.token, [...detection("duplicate", "/checkout"), ...detection("duplicate", "/checkout")], { fetch: out.f });
    await sendBatch(t.env, t.app.token, detection("duplicate", "/checkout"), { fetch: out.f, sid: "dddddddddddd" });
    expect(out.sent).toHaveLength(1);
    await sendBatch(t.env, t.app.token, detection("duplicate", "/cart"), { fetch: out.f });
    await sendBatch(t.env, t.app.token, detection("stale", "/checkout"), { fetch: out.f });
    expect(out.sent).toHaveLength(3);
    advance(3_600_000);
    await sendBatch(t.env, t.app.token, detection("duplicate", "/checkout"), { fetch: out.f });
    expect(out.sent).toHaveLength(4);
  });

  it(`at most ${HOURLY_CAP} records per app per hour, however many distinct problems arrive`, async () => {
    const t = await paidApp();
    await t.put("slack");
    const out = recorder();
    for (let b = 0; b < 4; b++) {
      const events = Array.from({ length: 20 }, (_, i) => detection("duplicate", `/page-${b}-${i}`)).flat();
      await sendBatch(t.env, t.app.token, events, { fetch: out.f, sid: `batch${b}aaaaaaa` });
    }
    expect(out.sent).toHaveLength(HOURLY_CAP);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM forward_log")[0]!.n).toBe(HOURLY_CAP);
  });

  it("possible-tier detections and apps without destinations send nothing; disabled destinations are skipped", async () => {
    const t = await paidApp();
    const out = recorder();
    await sendBatch(t.env, t.app.token, detection(), { fetch: out.f });
    expect(out.sent).toEqual([]);
    await t.put("slack");
    await t.put("webhook");
    await sendBatch(t.env, t.app.token, detection("stale", "/x", { tier: "possible" }), { fetch: out.f });
    expect(out.sent).toEqual([]);
    expect((await call(t.env, "PATCH", `/api/account/projects/${t.app.id}/integrations/webhook`, { body: { enabled: false }, cookie: t.cookie })).status).toBe(200);
    await sendBatch(t.env, t.app.token, detection("stale", "/y"), { fetch: out.f });
    expect(out.sent.map((s) => new URL(s.url).host)).toEqual(["hooks.slack.com"]);
    expect(detectionRecords({ runtime: "0.3.0", model: null, events: detection("stale", "/z", { tier: "possible" }) }, { id: "x", name: "x", dashboard: "d" }, "t")).toEqual([]);
  });

  it("a failing destination is written to last_error and never changes the collector's answer", async () => {
    const t = await paidApp();
    await t.put("slack");
    const down = recorder(500);
    const r = await sendBatch(t.env, t.app.token, detection(), { fetch: down.f });
    expect(r.status).toBe(202);
    expect(t.sql.rows("SELECT last_sent, last_error FROM integrations")).toEqual([{ last_sent: null, last_error: "Slack answered HTTP 500 (2026-10-13 12:00 UTC)" }]);
    const offline: Fetch = async () => { throw new Error("offline"); };
    expect((await sendBatch(t.env, t.app.token, detection("stale", "/b"), { fetch: offline })).status).toBe(202);
    expect(String(t.sql.rows("SELECT last_error FROM integrations")[0]!.last_error)).toMatch(/^Slack did not answer within 8 s/);
    const html = await (await call(t.env, "GET", `/account/apps/${t.app.id}`, { cookie: t.cookie })).text();
    expect(html).toContain("Slack did not answer within 8 s");
  });

  it("Send test: one test record to that destination, 502 with the reason when it fails; Remove deletes the row", async () => {
    const t = await paidApp();
    await t.put("webhook");
    const ok = recorder();
    const r = await call(t.env, "POST", `/api/account/projects/${t.app.id}/integrations/webhook/test`, { body: {}, cookie: t.cookie, fetch: ok.f });
    expect(r.status).toBe(200);
    expect(ok.sent).toHaveLength(1);
    expect(JSON.parse(ok.sent[0]!.body)).toMatchObject({ type: "genclass.test", test: true, route: "/genclass-test" });
    expect(ok.sent[0]!.headers["x-genclass-event"]).toBe("test");
    const bad = recorder(404);
    const f = await call(t.env, "POST", `/api/account/projects/${t.app.id}/integrations/webhook/test`, { body: {}, cookie: t.cookie, fetch: bad.f });
    expect(f.status).toBe(502);
    expect(((await f.json()) as any).error).toBe("Webhook answered HTTP 404");
    expect((await call(t.env, "POST", `/api/account/projects/${t.app.id}/integrations/slack/test`, { body: {}, cookie: t.cookie, fetch: ok.f })).status).toBe(404);
    expect((await call(t.env, "DELETE", `/api/account/projects/${t.app.id}/integrations/webhook`, { cookie: t.cookie })).status).toBe(204);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM integrations")[0]!.n).toBe(0);
  });

  it(`Send test counts against the app's ${HOURLY_CAP} records an hour, so it cannot post faster than forwarding`, async () => {
    const t = await paidApp();
    await t.put("webhook");
    const ok = recorder();
    const test = () => call(t.env, "POST", `/api/account/projects/${t.app.id}/integrations/webhook/test`, { body: {}, cookie: t.cookie, fetch: ok.f });
    expect((await test()).status).toBe(200);
    expect(t.sql.rows("SELECT COUNT(*) AS n FROM forward_log WHERE project_id = ?", t.app.id)[0]!.n).toBe(1);
    const hour = now().toISOString().slice(0, 13);
    const ins = t.sql.db.prepare("INSERT INTO forward_log (project_id, signature, hour) VALUES (?, ?, ?)");
    for (let i = 1; i < HOURLY_CAP; i++) ins.run(t.app.id, `filler\t${i}`, hour);
    const r = await test();
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error).toBe("this app has sent its forwarding records for this hour; try again next hour");
    expect(ok.sent).toHaveLength(1);
    // the next hour it works again
    advance(3_600_000);
    expect((await test()).status).toBe(200);
  });
});
