// HTTP for the scan worker (genclass-scan). Routes it will own on genclass.dev: /api/scan* and /scan* (the owner adds
// the zone routes after review; until then it answers on its workers.dev URL). The site worker hands it
// genclass.dev/<url-like path> as /scan?url=<path> over a service binding.
//
//   GET  /scan                 the URL box                      GET /scan?url=...    report page (cached, or starts a scan)
//   GET  /scan/about           what it does, score formula, opt-out, retention
//   POST /api/scan {url}       runs a scan: JSON for refusals and cache hits, else an NDJSON stream of progress then the report
//   GET  /api/scan/report?url= the cached report (404 when none)  GET /api/scan/shot/<key>/<id>-<view>.jpg  a screenshot
//
// Order of checks on POST: shape -> normalise -> cache hit -> opt-out list -> per-IP rate limit -> DNS -> robots.txt
// -> global concurrency slot (and one scan per URL at a time) -> scan.

import { buildReport } from "./report.ts";
import { runScan, ScanError, UA_TOKEN, type BrowserLike, type ScanResult } from "./scan.ts";
import { aboutPage, nonce, notFoundPage, scanPage, securityHeaders, type ScanPageData } from "./page.ts";
import { acquireSlot, cachedReport, cacheKey, optedOut, releaseSlot, saveReport, SHOT_PATH, shotKey, type Bucket } from "./store.ts";
import { normaliseTarget, publicHostname, resolveCheck, robotsCheck, type Fetcher, type Target } from "./target.ts";

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  BROWSER: { fetch: typeof fetch };
  BUCKET: Bucket;
  SCAN_LIMIT?: RateLimiter;
  /** Scans at once across everyone (default 3). */
  MAX_CONCURRENT?: string;
  /** "on" shows the with-GenClass score column (off until the runtime ships visual fixes). */
  WITH_GENCLASS?: string;
  /** Extra opted-out hosts, comma-separated (scans/blocklist.json is the main list). */
  BLOCKLIST?: string;
  MODEL_BASE_URL?: string;
  GUARD_HOLD_MS?: string;
  /** The guard pass's aggressiveness (default "balanced", the runtime's shipped default). */
  GUARD_AGGRESSIVENESS?: string;
  /** A guard gain margin for the guard pass (policy.thresholds.guard). Unset: the model's shipped gates. */
  GUARD_MARGIN?: string;
  /** Base of share links (default https://genclass.dev). */
  PUBLIC_ORIGIN?: string;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export interface AppDeps {
  launch(env: Env): Promise<BrowserLike>;
  fetch: Fetcher;
  now(): number;
  sleep(ms: number): Promise<void>;
  runtimeSource(): Promise<string | null>;
  /** The built GenClass visual-checks chunk (src/visual-source.ts), or null. */
  visualSource?: string | null;
  scanId(): string;
}

export const RUNTIME_VERSION = "0.2.1";
export const DEFAULT_MODEL_BASE = "https://genclass.dev/model/@genclass/runtime-model@0.2.0/files/";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
const html = (body: string, n: string, status = 200): Response => new Response(body, { status, headers: securityHeaders(n) });

async function ipKey(request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`genclass-scan|${ip}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** genclass.dev/<url-like path> on this worker too (the site worker uses the same rule): a hostname with a TLD, or http(s):. */
export function targetFromPath(pathname: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (!p || /[^A-Za-z0-9._~:/?#@!$&'()*+,;=%-]/.test(p)) return null;
  if (/^https?:\/*/i.test(p)) return p.replace(/^(https?):\/*/i, "$1://");
  const host = p.split(/[/?#]/)[0].toLowerCase().replace(/\.+$/, "");
  return publicHostname(host) ? p : null;
}

export async function handle(request: Request, env: Env, ctx: Ctx, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path === "/api/scan" || path === "/api/scan/") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
      if (request.method !== "POST") return json({ ok: false, code: "method", message: "Use POST." }, 405, { allow: "POST" });
      return await startScan(request, env, ctx, deps, url);
    }
    if (path === "/api/scan/report") {
      if (request.method !== "GET") return json({ ok: false, code: "method", message: "Use GET." }, 405, { allow: "GET" });
      const t = normaliseTarget(url.searchParams.get("url"));
      if (!t.ok) return json(t, 400);
      const r = await cachedReport(env.BUCKET, await cacheKey(t.url), deps.now());
      return r ? json({ ok: true, report: r }) : json({ ok: false, code: "none", message: "No recent scan for that page." }, 404);
    }
    if (path === "/api/scan/health") return json({ ok: true, ua: UA_TOKEN, runtime: RUNTIME_VERSION });
    if (path.startsWith("/api/scan/shot/")) {
      const m = SHOT_PATH.exec(path);
      if (!m || request.method !== "GET") return new Response("Not found", { status: 404 });
      const obj = await env.BUCKET.get(shotKey(m[1], m[2], m[3]));
      if (!obj || !obj.body) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      return new Response(obj.body, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "private, max-age=3600",
          "x-robots-tag": "noindex, nofollow",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
          "content-security-policy": "default-src 'none'; sandbox",
        },
      });
    }
    if (path.startsWith("/api/")) return json({ ok: false, code: "not-found", message: "Not found." }, 404);

    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const n = nonce();
    if (path === "/scan/about" || path === "/scan/about/") return html(aboutPage(n), n);
    if (path === "/scan" || path === "/scan/") return html(scanPage(n, await pageData(url.searchParams.get("url"), env, deps, url)), n);
    const fromPath = path.length > 1 && !path.startsWith("/scan/") ? targetFromPath(path + url.search) : null;
    if (fromPath) return html(scanPage(n, await pageData(fromPath, env, deps, url)), n);
    return html(notFoundPage(n), n, 404);
  } catch (e) {
    console.error("scan worker error", e instanceof Error ? e.message : String(e));
    return json({ ok: false, code: "internal", message: "Something went wrong on our side. Try again in a minute." }, 500);
  }
}

async function pageData(input: string | null, env: Env, deps: AppDeps, url: URL): Promise<ScanPageData> {
  const shareBase = env.PUBLIC_ORIGIN || (url.hostname === "genclass.dev" ? "https://genclass.dev" : url.origin);
  const base: ScanPageData = { target: null, input: input ?? "", error: null, report: null, shareBase };
  if (input === null || input.trim() === "") return base;
  const t = normaliseTarget(input);
  if (!t.ok) return { ...base, error: { code: t.code, message: t.message } };
  const data: ScanPageData = { ...base, input: t.display, target: { url: t.url, display: t.display } };
  if (await optedOut(env.BUCKET, t.host, env.BLOCKLIST)) return { ...data, error: { code: "opted-out", message: "The owner of this site asked us not to scan it." } };
  data.report = await cachedReport(env.BUCKET, await cacheKey(t.url), deps.now());
  return data;
}

async function startScan(request: Request, env: Env, ctx: Ctx, deps: AppDeps, url: URL): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin && origin !== "https://genclass.dev") return json({ ok: false, code: "origin", message: "Scans start from the page check." }, 403);
  if (Number(request.headers.get("content-length") || 0) > 4096) return json({ ok: false, code: "too-large", message: "Request too large." }, 413);
  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return json({ ok: false, code: "invalid", message: "Send JSON: { \"url\": \"example.com\" }." }, 400);
  }
  const target = normaliseTarget(body && body.url);
  if (!target.ok) return json(target, 400);
  const key = await cacheKey(target.url);
  const hit = await cachedReport(env.BUCKET, key, deps.now());
  if (hit) return json({ ok: true, cached: true, report: hit });
  if (await optedOut(env.BUCKET, target.host, env.BLOCKLIST)) return json({ ok: false, code: "opted-out", message: "The owner of this site asked us not to scan it." }, 403);
  if (env.SCAN_LIMIT) {
    const { success } = await env.SCAN_LIMIT.limit({ key: await ipKey(request) });
    if (!success) return json({ ok: false, code: "rate", message: "Too many scans from your address in the last minute." }, 429, { "retry-after": "60" });
  }
  const dns = await resolveCheck(target.host, deps.fetch);
  if (!dns.ok) return json(dns, 400);
  const robots = await robotsCheck(target, deps.fetch, `Mozilla/5.0 (compatible; ${UA_TOKEN})`);
  if (!robots.ok) return json(robots, 403);
  const id = deps.scanId();
  const cap = Math.max(1, Number(env.MAX_CONCURRENT) || 3);
  const slot = await acquireSlot(env.BUCKET, cap, id, key, deps.now());
  if (slot === "same") return json({ ok: false, code: "in-progress", message: "A scan of this page is already running." }, 409, { "retry-after": "20" });
  if (slot === "busy") return json({ ok: false, code: "busy", message: "All scanners are busy." }, 503, { "retry-after": "30" });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const send = (m: Record<string, unknown>) => {
    if (!open) return;
    writer.write(enc.encode(`${JSON.stringify(m)}\n`)).catch(() => {
      open = false;
    });
  };
  send({ type: "progress", step: "check" });
  const work = runAndSave(target, key, id, env, deps, send)
    .catch((e) => {
      const code = e instanceof ScanError ? e.code : "internal";
      const message =
        e instanceof ScanError
          ? code === "browser"
            ? "Could not start a browser for the scan. Try again in a minute."
            : e.message
          : "The scan failed on our side. Try again in a minute.";
      if (!(e instanceof ScanError)) console.error("scan failed", e instanceof Error ? e.stack || e.message : String(e));
      send({ type: "error", code, message, detail: e instanceof ScanError && code === "browser" ? e.message : "" });
    })
    .finally(async () => {
      await releaseSlot(env.BUCKET, id, deps.now()).catch(() => undefined);
      open = false;
      void writer.close().catch(() => undefined); // not awaited: an unread stream must not hold the scan open
    });
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" },
  });
}

async function runAndSave(target: Target, key: string, id: string, env: Env, deps: AppDeps, send: (m: Record<string, unknown>) => void): Promise<void> {
  const guardHoldMs = Number(env.GUARD_HOLD_MS) || 900;
  const aggr = env.GUARD_AGGRESSIVENESS === "eager" || env.GUARD_AGGRESSIVENESS === "cautious" ? env.GUARD_AGGRESSIVENESS : "balanced";
  const margin = env.GUARD_MARGIN !== undefined && env.GUARD_MARGIN !== "" && Number.isFinite(Number(env.GUARD_MARGIN)) ? Number(env.GUARD_MARGIN) : null;
  const result: ScanResult = await runScan(target, {
    launch: () => deps.launch(env),
    now: deps.now,
    sleep: deps.sleep,
    hostResolvesPublic: async (host) => (await resolveCheck(host, deps.fetch)).ok,
    runtimeSource: deps.runtimeSource(),
    visualSource: deps.visualSource ?? null,
    modelBaseUrl: env.MODEL_BASE_URL || DEFAULT_MODEL_BASE,
    runtimeVersion: RUNTIME_VERSION,
    guardHoldMs,
    guardAggressiveness: aggr,
    guardMargin: margin,
    progress: (step, detail) => send({ type: "progress", step, ...(detail || {}) }),
  });
  send({ type: "progress", step: "save" });
  const at = new Date(deps.now());
  const saved = new Set<string>();
  await Promise.all(
    result.views.map(async (v) => {
      if (!v.shot) return;
      try {
        await env.BUCKET.put(shotKey(key, id, v.id), v.shot, { httpMetadata: { contentType: "image/jpeg" } });
        saved.add(v.id);
      } catch {
        /* the report says there is no screenshot */
      }
    }),
  );
  const report = buildReport(
    target,
    { id, key, at, runtime: RUNTIME_VERSION, guardHoldMs, guardAggressiveness: aggr, guardMargin: margin, shotUrl: (view) => (saved.has(view) ? `/api/scan/shot/${key}/${id}-${view}.jpg` : null) },
    result,
    { withGenClass: env.WITH_GENCLASS === "on" },
  );
  await saveReport(env.BUCKET, key, report as unknown as Record<string, unknown>);
  console.log(`scan ${id}: ${result.ms.total} ms (launch ${result.ms.launch}, views ${result.ms.views}, probe ${result.ms.probe}, guard ${result.ms.guard}), ${report.findings.length} findings, score ${report.score.value}`);
  send({ type: "done", report });
}

