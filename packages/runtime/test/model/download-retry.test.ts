// Model downloads retry transient failures (loader.ts -> fetchRetrying): jsDelivr answered HTTP 429 to the model card
// in 5 of ~65 production sessions on 2026-10-12, and those sessions ran with no model. Retries are bounded (two for
// 408/429/5xx, one for a network error), honour a numeric Retry-After, never apply to other statuses, and only run
// when the caller passes timers. A cached card is used at once instead of waiting for retries.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchCard, fetchFile, fetchRetrying, RETRY_DELAYS_MS, type FetchEnv, type TimerEnv } from "../../src/model/loader.js";
import { ModelLoadError } from "../../src/model/errors.js";

/** Timers that fire on the next microtask and record every requested wait. */
function instantTimers(): TimerEnv & { waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    setTimeout(fn: () => void, ms: number) {
      waits.push(ms);
      queueMicrotask(fn);
      return waits.length;
    },
    clearTimeout() {},
  };
}

/** A fetch that answers from a script of outcomes (status number or "net" for a thrown network error), then 200. */
function scripted(outcomes: Array<number | "net" | { status: number; retryAfter: string }>, body = '{"ok":true}') {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const o = outcomes.shift();
    if (o === "net") throw new TypeError("Failed to fetch");
    if (typeof o === "number") return new Response("err", { status: o });
    if (o && typeof o === "object") return new Response("err", { status: o.status, headers: { "retry-after": o.retryAfter } });
    return new Response(body, { status: 200, headers: { "content-length": String(new TextEncoder().encode(body).byteLength) } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const env = (fetchFn: typeof fetch, timers?: TimerEnv, caches: CacheStorage | null = null): FetchEnv => ({ fetch: fetchFn, caches, cacheName: "c", ...(timers ? { timers } : {}) });

describe("prototype: model download retries (loader.ts fetchRetrying)", () => {
  it("retries HTTP 429 twice on the 1 s / 3 s schedule and returns the success", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted([429, 429]);
    const res = await fetchRetrying(env(fetchFn, t), "https://cdn.test/a", {});
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(t.waits).toEqual([...RETRY_DELAYS_MS]);
  });

  it("gives up after two retries and returns the last failed response", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted([503, 503, 503, 503]);
    const res = await fetchRetrying(env(fetchFn, t), "https://cdn.test/a", {});
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("honours a numeric Retry-After, capped at 8 s", async () => {
    const t = instantTimers();
    const { fetchFn } = scripted([{ status: 429, retryAfter: "5" }, { status: 429, retryAfter: "60" }]);
    await fetchRetrying(env(fetchFn, t), "https://cdn.test/a", {});
    expect(t.waits).toEqual([5000, 8000]);
  });

  it("never retries a 404 or other non-transient status", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted([404]);
    const res = await fetchRetrying(env(fetchFn, t), "https://cdn.test/a", {});
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
    expect(t.waits).toEqual([]);
  });

  it("retries a network error once, then throws it", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted(["net", "net", "net"]);
    await expect(fetchRetrying(env(fetchFn, t), "https://cdn.test/a", {})).rejects.toThrow("Failed to fetch");
    expect(calls).toHaveLength(2);
    expect(t.waits).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it("without timers it is a single fetch (the previous behaviour)", async () => {
    const { fetchFn, calls } = scripted([429]);
    const res = await fetchRetrying(env(fetchFn), "https://cdn.test/a", {});
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  it("fetchFile downloads through a 429 and still verifies size and sha256", async () => {
    const t = instantTimers();
    const body = "model-bytes-0123456789";
    const bytes = new TextEncoder().encode(body);
    const { fetchFn, calls } = scripted([429], body);
    const spec = { file: "m.onnx", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    const got = await fetchFile(env(fetchFn, t), "https://cdn.test/m.onnx", spec, "tag");
    expect(new TextDecoder().decode(got.bytes)).toBe(body);
    expect(calls).toHaveLength(2);
  });

  it("fetchCard retries a rate-limited card when nothing is cached (3 requests at most)", async () => {
    const t = instantTimers();
    const card = JSON.stringify({ format: "genclass-runtime-model/1", name: "toy", version: "1", variants: { q8: { file: "q.onnx", provider: "wasm" } } });
    const { fetchFn, calls } = scripted([429, 429], card);
    const got = await fetchCard(env(fetchFn, t), "https://cdn.test/model/");
    expect(got).toMatchObject({ fromCache: false, card: { name: "toy" } });
    expect(calls).toHaveLength(3);
    expect(t.waits).toEqual([...RETRY_DELAYS_MS]);
  });

  it("fetchCard fails with the HTTP status after the retries are spent", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted([429, 429, 429, 429]);
    await expect(fetchCard(env(fetchFn, t), "https://cdn.test/model/")).rejects.toThrow(/HTTP 429/);
    expect(calls).toHaveLength(3);
  });

  it("fetchCard does not retry a 404 card", async () => {
    const t = instantTimers();
    const { fetchFn, calls } = scripted([404]);
    await expect(fetchCard(env(fetchFn, t), "https://cdn.test/model/")).rejects.toBeInstanceOf(ModelLoadError);
    expect(calls).toHaveLength(1);
    expect(t.waits).toEqual([]);
  });

  it("fetchCard uses a cached card at once on a 429 instead of waiting for retries", async () => {
    const card = JSON.stringify({ format: "genclass-runtime-model/1", name: "cached", version: "1", variants: { q8: { file: "q.onnx", provider: "wasm" } } });
    const store = new Map<string, Response>([["https://cdn.test/model/model.json", new Response(card, { status: 200 })]]);
    const caches = {
      open: async () => ({
        match: async (u: string) => store.get(u)?.clone(),
        put: async () => undefined,
        delete: async () => false,
      }),
    } as unknown as CacheStorage;
    const t = instantTimers();
    const { fetchFn, calls } = scripted([429]);
    const got = await fetchCard(env(fetchFn, t, caches), "https://cdn.test/model/");
    expect(got).toMatchObject({ fromCache: true, card: { name: "cached" } });
    expect(calls).toHaveLength(1);
    expect(t.waits).toEqual([]);
  });
});
