// Telemetry transport: the page's fetch and navigator.sendBeacon as they were when this module loaded, so GenClass
// never observes (or holds, or decides about) its own diagnostics, exactly like the model host's downloads
// (index.ts -> NATIVE_FETCH). Never throws; failures are reported to the caller as a rejected promise only, with the
// HTTP status (and a readable Retry-After) on the error.

import type { TelemetryTransport } from "../types.js";

const G = globalThis as unknown as Record<string, unknown>;

const NATIVE_FETCH: typeof fetch | undefined = typeof G.fetch === "function" ? (G.fetch as typeof fetch).bind(globalThis) : undefined;

const NATIVE_BEACON: ((url: string, data?: BodyInit | null) => boolean) | undefined = (() => {
  try {
    const nav = G.navigator as { sendBeacon?: (url: string, data?: BodyInit | null) => boolean } | undefined;
    return typeof nav?.sendBeacon === "function" ? nav.sendBeacon.bind(nav) : undefined;
  } catch {
    return undefined;
  }
})();

/** Whether this environment can send at all (fetch or sendBeacon captured at module load). */
export function nativeTransportAvailable(): boolean {
  return !!NATIVE_FETCH || !!NATIVE_BEACON;
}

/**
 * A Retry-After header's delay-seconds in ms (undefined for none or an HTTP date, which would need the wall clock;
 * a 429 without a usable value backs off by the client's own schedule).
 */
export function retryAfterMs(v: string | null | undefined): number | undefined {
  if (typeof v !== "string" || !/^\s*\d{1,6}\s*$/.test(v)) return undefined;
  return Number(v.trim()) * 1000;
}

/**
 * The default transport. Bodies go as text/plain (a CORS "simple request": no preflight; the collector accepts it),
 * without credentials or referrer. On page exit, sendBeacon; if the browser refuses it, fetch with keepalive.
 */
export const nativeTransport: TelemetryTransport = {
  send(url: string, body: string, o: { beacon: boolean }): Promise<unknown> {
    try {
      if (o.beacon && NATIVE_BEACON && NATIVE_BEACON(url, body)) return Promise.resolve();
    } catch {
      /* fall back to fetch */
    }
    if (!NATIVE_FETCH) return Promise.reject(new Error("no fetch"));
    try {
      return NATIVE_FETCH(url, {
        method: "POST",
        body,
        headers: { "content-type": "text/plain;charset=UTF-8" },
        keepalive: true,
        credentials: "omit",
        mode: "cors",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      }).then((r) => {
        if (r.ok) return;
        // the status, and a Retry-After the collector exposes, decide back-off (429) vs failure (client.ts backoffOf)
        const e = new Error(`HTTP ${r.status}`) as Error & { status?: number; retryAfterMs?: number };
        e.status = r.status;
        const ra = retryAfterMs(r.headers?.get?.("retry-after"));
        if (ra !== undefined) e.retryAfterMs = ra;
        throw e;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  },
};
