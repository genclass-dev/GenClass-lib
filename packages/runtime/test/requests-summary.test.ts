// rt.summary().requests (issue 94): request counts and per-host health, so a quiet summary tells "saw the requests,
// found nothing" from "saw no requests". Counted in the measured checks' chunk (src/visual/requests.ts, attached by
// the bridge's follow()), from the ops the runtime holds and its event stream. Reporting only: telemetry does not send
// it, sinks get no hosts without evidence, and it never changes what the app receives.

import { describe, expect, it } from "vitest";
import type { SinkRecord, TelemetryTransport } from "../src/types.js";
import { follow } from "../src/visual/bridge.js";
import { FakeClock, drain, setup as base } from "./helpers.js";

/** A runtime whose summary has `requests`: the checks chunk attached as the visual stub does once it loads. */
function setup(o: Parameters<typeof base>[0] = {}) {
  const s = base(o);
  follow(s.rt, { gateFixes() {}, stop() {}, summary: () => null });
  return s;
}

/** A minimal XMLHttpRequest on the fake clock that answers with a given status and Content-Type. */
function fakeXHR(clock: () => FakeClock, status: number, type: string) {
  return class X extends EventTarget {
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response: unknown = "";
    responseType = "";
    open() {
      this.readyState = 1;
    }
    setRequestHeader() {}
    send() {
      clock().setTimeout(() => {
        this.readyState = 4;
        this.status = status;
        this.responseText = "<p>hi</p>";
        for (const t of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(t));
      }, 20);
    }
    getResponseHeader(k: string): string | null {
      return k.toLowerCase() === "content-type" ? type : null;
    }
    getAllResponseHeaders(): string {
      return `content-type: ${type}\r\n`;
    }
  };
}

const WEATHER = "https://api.weather.test/v1/forecast?city=Oslo";

describe("summary().requests: counts per host (API.md summary(), issue 94)", () => {
  it("absent until the checks chunk loads (first load carries no code for it)", () => {
    expect(base({ mode: undefined }).rt.summary().requests).toBeUndefined();
  });

  it("requests made before the chunk loaded are counted from the ops the runtime holds", async () => {
    const s = base({ mode: undefined });
    s.server.on("GET", "/a", { status: 200, body: {} });
    s.server.on("GET", "/slow", { status: 200, body: {}, latency: 5000 });
    const p = s.fetch("/a");
    void s.fetch("/slow");
    await s.clock.advance(100);
    await p;
    follow(s.rt, { gateFixes() {}, stop() {}, summary: () => null });
    expect(s.rt.summary().requests).toMatchObject({ requests: 2, "2xx": 1, pending: 1 });
    await s.clock.advance(5000);
    expect(s.rt.summary().requests).toMatchObject({ requests: 2, "2xx": 2, pending: 0 });
  });

  it("starts at zero: a summary with no requests says GenClass saw none", () => {
    const { rt } = setup({ mode: undefined });
    expect(rt.summary().requests).toEqual({ requests: 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, network: 0, aborted: 0, notJson: 0, byGenClass: 0, pending: 0, hosts: {} });
  });

  it("the reporter's case: two 404s and a 200 that is not JSON, all handled by the app, are counted with nothing detected", async () => {
    const s = setup({ mode: undefined });
    s.server.on("GET", "/v1/forecast", ({ n }) => (n < 3 ? { status: 404, body: "not found", headers: { "content-type": "text/plain" } } : { status: 200, body: "google.com", headers: { "content-type": "text/html" } }));
    const errors: string[] = [];
    for (let i = 0; i < 3; i++) {
      // the app's handler: check ok, then read JSON; its own catch shows the error
      const p = s
        .fetch(WEATHER)
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .catch((e: Error) => errors.push(e.message));
      await s.clock.advance(100);
      await p;
    }
    // the fake server sends every body as JSON text, so the third parse succeeds here; the count reads the header
    expect(errors).toEqual(["HTTP 404", "HTTP 404"]);
    const sum = s.rt.summary();
    expect(sum.detections).toEqual({});
    expect(sum.requests).toMatchObject({ requests: 3, "2xx": 1, "4xx": 2, notJson: 1, pending: 0 });
    expect(sum.requests!.hosts["api.weather.test"]).toMatchObject({ requests: 3, "2xx": 1, "3xx": 0, "4xx": 2, "5xx": 0, network: 0, notJson: 1 });
  });

  it("separates the page's origin from third-party hosts; network errors, aborts, pending requests and latency", async () => {
    const s = setup({ mode: undefined });
    s.server.on("GET", "/api/items", { status: 200, body: [1], latency: 40 });
    s.server.on("GET", "/down", { error: "network", latency: 10 });
    s.server.on("GET", "/slow", { status: 200, body: {}, latency: 60_000 });
    s.server.on("GET", "/boom", { status: 503, body: {} });
    for (let i = 0; i < 4; i++) {
      const p = s.fetch("/api/items");
      await s.clock.advance(50);
      await (await p).json();
    }
    void s.fetch("https://cdn.other.test/down").catch(() => undefined);
    void s.fetch("/boom").catch(() => undefined);
    const ac = new AbortController();
    const aborted = s.fetch("/slow", { signal: ac.signal }).catch(() => "aborted");
    void s.fetch("https://cdn.other.test/slow");
    await s.clock.advance(100);
    ac.abort();
    expect(await aborted).toBe("aborted");
    const r = s.rt.summary().requests!;
    expect(r).toMatchObject({ requests: 8, "2xx": 4, "5xx": 1, network: 1, aborted: 1, pending: 1, notJson: 0 });
    expect(r.hosts["same-origin"]).toMatchObject({ requests: 6, "2xx": 4, "5xx": 1, aborted: 1, latency: { n: 4, p50: 40, p95: 40 } });
    expect(r.hosts["cdn.other.test"]).toMatchObject({ requests: 2, network: 1 });
    expect(r.hosts["cdn.other.test"].latency).toBeUndefined();
  });

  it("not JSON: .json() on a non-JSON content type, any status, once per request; text() and JSON types are not counted", async () => {
    const s = setup({ mode: undefined });
    s.server.on("GET", "/html", { status: 200, body: "x", headers: { "content-type": "text/html" } });
    s.server.on("GET", "/gone", { status: 410, body: "x", headers: { "content-type": "text/html" } });
    s.server.on("GET", "/json", { status: 200, body: { a: 1 } });
    s.server.on("GET", "/problem", { status: 200, body: { a: 1 }, headers: { "content-type": "application/problem+json" } });
    const read = async (u: string, how: "json" | "text" | "none") => {
      const p = s.fetch(u);
      await s.clock.advance(60);
      const r = await p;
      const copy = how === "json" ? r.clone() : null;
      if (how !== "none") await (r[how]() as Promise<unknown>).catch(() => undefined);
      await copy?.json().catch(() => undefined);
    };
    await read("/html", "json"); // 1, read twice (a clone): counted once
    await read("/html", "text"); // read as text: the app did not ask for JSON
    await read("/html", "none");
    await read("/gone", "json"); // 2
    await read("/json", "json");
    await read("/problem", "json");
    expect(s.rt.summary().requests!.notJson).toBe(2);
  });

  it("XHR requests are counted per host too", async () => {
    let clock!: FakeClock;
    const XHR = fakeXHR(() => clock, 200, "text/html");
    const s = setup({ mode: undefined, observe: { fetch: false, xhr: true }, extraGlobal: { XMLHttpRequest: XHR } });
    clock = s.clock;
    for (let i = 0; i < 2; i++) {
      const x = new (s.g.XMLHttpRequest as typeof XHR)() as unknown as XMLHttpRequest;
      x.open("GET", "https://api.weather.test/v1/now");
      x.send();
    }
    await s.clock.advance(100);
    expect(s.rt.summary().requests!.hosts["api.weather.test"]).toMatchObject({ requests: 2, "2xx": 2, pending: 0 });
  });

  it("what the app receives is unchanged: the same status, body and headers with and without the count", async () => {
    const s = setup({ mode: undefined });
    s.server.on("GET", "/html", { status: 200, body: "plain", headers: { "content-type": "text/html" } });
    const p = s.fetch("/html");
    await s.clock.advance(60);
    const r = await p;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html");
    await expect(r.json()).resolves.toBe("plain");
  });

  it("telemetry does not send it; a sink's summary record has the totals and no hosts, evidence or not", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport: TelemetryTransport = {
      send(_u, body) {
        sent.push(...(JSON.parse(body) as { events: Record<string, unknown>[] }).events);
        return Promise.resolve();
      },
    };
    const plain: SinkRecord[] = [];
    const rich: SinkRecord[] = [];
    const s = setup({ mode: undefined, telemetry: { transport }, sinks: [(r) => void plain.push(r), { send: (r) => void rich.push(r), evidence: true }], extraGlobal: { crypto: globalThis.crypto } });
    s.server.on("GET", "/v1/forecast", { status: 404, body: {} });
    const p = s.fetch(WEATHER);
    await s.clock.advance(100);
    await p;
    (s.rt.telemetry as unknown as { summary(r: string): void }).summary("periodic");
    await s.rt.telemetry!.flush();
    const sum = sent.filter((e) => e.t === "summary").at(-1);
    expect(sum).toBeDefined();
    expect(JSON.stringify(sum)).not.toContain("weather");
    expect(JSON.stringify(sum)).not.toContain("requests\":{");
    // the summary record a page exit sends to the app's sinks
    (s.rt as unknown as { emitSummary(): void }).emitSummary();
    await drain();
    const a = plain.find((r) => r.kind === "summary")!;
    const b = rich.find((r) => r.kind === "summary")!;
    for (const r of [a, b]) {
      expect(r.summary!.requests).toMatchObject({ requests: 1, "4xx": 1 });
      expect(r.summary!.requests!.hosts).toEqual({});
    }
    expect(s.rt.summary().requests!.hosts["api.weather.test"]).toMatchObject({ requests: 1 });
  });
});
