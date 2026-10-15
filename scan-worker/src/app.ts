// HTTP for the scan worker (genclass-scan). Routes it will own on genclass.dev: /api/scan* and /scan* (the owner adds
// the zone routes after review; until then it answers on its workers.dev URL). The site worker hands it
// genclass.dev/<url-like path> as /scan?url=<path> over a service binding. A route ending in * also matches the site's
// own files that start with /scan (genclass.dev/scan-box.js): those go back to the site worker over the SITE binding.
//
//   GET  /scan                 the URL box                      GET /scan?url=...    report page (cached, or starts a scan)
//   GET  /scan/about           what it does, score formula, opt-out, retention
//   POST /api/scan {url}       runs a scan: JSON for refusals and cache hits, else an NDJSON stream of progress then the report
//   GET  /api/scan/report?url= the cached report (404 when none)  GET /api/scan/shot/<key>/<id>-<view>.jpg  a screenshot
//
// Order of checks on POST: shape -> normalise -> opt-out list -> cache hit -> automated client -> per-client rate limit
// -> per-site rate limit -> DNS -> robots.txt -> concurrency slot (one scan per URL and one per client at a time, a few
// across everyone) -> scan. Every main-frame navigation the page makes while loading goes through the same opt-out,
// DNS and robots.txt checks (navigationAllowed).

import { classifyIp, parseIPv6 } from "./ip.ts";
import { JUDGE_MODEL, JUDGE_PROMPT, type JudgeClient } from "./judge.ts";
import { buildReport, guardSetting, judgeCropsToKeep, REPORT_VERSION } from "./report.ts";
import { runScan, ScanError, UA_TOKEN, type BrowserLike, type NavVerdict, type ScanResult } from "./scan.ts";
import { aboutPage, nonce, notFoundPage, scanPage, securityHeaders, type ScanPageData } from "./page.ts";
import { acquireSlot, cachedReport, cacheKey, optedOut, releaseSlot, saveReport, SHOT_PATH, shotKey, type Bucket } from "./store.ts";
import { RUNTIME_VERSION } from "./visual.ts";
import { readVisionModel, VISION_MODEL, visionRunner, type VisionClient, type VisionModel } from "./vision.ts";
import { blockedName, normaliseTarget, publicHostname, resolveCheck, robotsDisallows, robotsRules, siteOf, type Fetcher, type Target } from "./target.ts";

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  BROWSER: { fetch: typeof fetch };
  BUCKET: Bucket;
  /** New scans per client per minute. */
  SCAN_LIMIT?: RateLimiter;
  /** New scans per site (registrable domain, approximately) per minute, whoever asks. */
  SITE_LIMIT?: RateLimiter;
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
  /** A test copy's key prefix in the bucket ("scan-test/"); unset in production. The opt-out list is shared. */
  STORE_PREFIX?: string;
  /**
   * The site worker (genclass-site), for paths under the /scan* route that are the site's, not this worker's (its
   * /scan-box.js). Unset: those paths are 404 here.
   */
  SITE?: { fetch(request: Request): Promise<Response> };
  /** Workers AI, for the model judge (Clef, src/judge.ts). Unset: the judge is off and every finding is measured. */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  /** "off" turns the model judge off even with the AI binding (default on). */
  JUDGE?: string;
  /**
   * "all" keeps the crop of every element the judge was asked about, not only those the report shows, and lists each
   * in the report's judge.asked (the test copy, for calibration). Unset in production.
   */
  JUDGE_CROPS?: string;
  /**
   * The genclass-models R2 bucket, for GenClass Vision's model (src/vision.ts VISION_KEY, a key the site worker does not
   * serve). Unset: Vision is off.
   */
  MODELS?: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> };
  /** "off" turns GenClass Vision off even with the MODELS binding (default on). */
  VISION?: string;
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
  /** axe-core (src/axe-source.ts) and its version, or null. */
  axe?: { source: string; version: string } | null;
  scanId(): string;
  /** GenClass Vision for one scan (tests hand in a fake); unset: visionClient(env) over the MODELS binding. */
  vision?(env: Env): VisionClient | null;
}

export { RUNTIME_VERSION };
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

/** The client a request counts against: its IPv4 address, or the /64 an IPv6 address belongs to (one subscriber). */
export function clientOf(ip: string): string {
  const g = ip.includes(":") ? parseIPv6(ip) : null;
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64` : ip;
}

/** A hash of the client (never the address itself): the rate limit key and the lease owner. */
export async function clientKey(request: Request): Promise<string> {
  const ip = clientOf(request.headers.get("cf-connecting-ip") || "unknown");
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`genclass-scan|${ip}`)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** User agents of crawlers, link previews and headless browsers: they can read a cached report but not start a scan. */
const AUTOMATED = /bot\b|bot\/|crawl|spider|slurp|headless|facebookexternalhit|embedly|lighthouse|preview/i;

/**
 * Top-level domains that are mostly seen as file extensions (README.md, backup.zip, install.sh, Main.java): a bare
 * name ending in one is a missing file, not an address, unless it has a path or an explicit http(s):
 * (genclass.dev/https://bun.sh, genclass.dev/bun.sh/). TLDs that many real sites use (.io, .ai, .so, .app, .pl) stay
 * addresses. Kept in step with FILE_TLDS in site/src/scan-path.js (test/tlds.test.ts).
 */
export const FILE_TLDS = new Set(["md", "zip", "mov", "py", "sh", "java"]);
const FILE_PARTS = new Set(["js", "mjs", "css", "html", "htm", "json", "png", "jpg", "jpeg", "gif", "svg", "ico", "txt", "xml", "webp", "avif", "woff", "woff2", "ttf", "wasm", "onnx", "pdf", "gz"]);

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
  const rawHost = p.split(/[/?#]/)[0];
  const host = rawHost.toLowerCase().replace(/\.+$/, "");
  if (!publicHostname(host)) return null;
  const labels = host.split(".");
  if (labels.length >= 3 && FILE_PARTS.has(labels[labels.length - 2])) return null;
  if (FILE_TLDS.has(labels[labels.length - 1]) && p.length === rawHost.length) return null;
  return p;
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
      if (await optedOut(env.BUCKET, t.host, env.BLOCKLIST)) return json({ ok: false, code: "opted-out", message: "The owner of this site asked us not to scan it." }, 403);
      const r = await cachedReport(env.BUCKET, await cacheKey(t.url), deps.now(), REPORT_VERSION);
      return r ? json({ ok: true, report: r }) : json({ ok: false, code: "none", message: "No recent scan for that page." }, 404);
    }
    if (path === "/api/scan/health") return json({ ok: true, ua: UA_TOKEN, runtime: RUNTIME_VERSION, report: REPORT_VERSION, judge: judgeClient(env) ? JUDGE_MODEL : null, prompt: JUDGE_PROMPT, vision: visionOn(env) ? VISION_MODEL : null });
    if (path.startsWith("/api/scan/shot/")) {
      const m = SHOT_PATH.exec(path);
      if (!m || request.method !== "GET") return new Response("Not found", { status: 404 });
      const obj = await env.BUCKET.get(shotKey(m[1], m[2], m[3]));
      // a screenshot carries its host, so an opt-out stops it being served at once, before the 24-hour sweep
      const shotHost = obj?.customMetadata?.host || "";
      if (!obj || !obj.body || !shotHost || (await optedOut(env.BUCKET, shotHost, env.BLOCKLIST))) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
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

    // genclass.dev/scan* also matches the site's own files that start with /scan: they are the site worker's
    if (path.startsWith("/scan") && !OWN_PATH.test(path) && env.SITE) return env.SITE.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const n = nonce();
    if (path === "/scan/about" || path === "/scan/about/") return html(aboutPage(n, guardSetting(...guardConfig(env))), n);
    if (path === "/scan" || path === "/scan/") return html(scanPage(n, await pageData(url.searchParams.get("url"), env, deps, url)), n);
    const fromPath = path.length > 1 && !path.startsWith("/scan/") ? targetFromPath(path + url.search) : null;
    if (fromPath) return html(scanPage(n, await pageData(fromPath, env, deps, url)), n);
    return html(notFoundPage(n), n, 404);
  } catch (e) {
    console.error("scan worker error", e instanceof Error ? e.message : String(e));
    return json({ ok: false, code: "internal", message: "Something went wrong on our side. Try again in a minute." }, 500);
  }
}

/** The paths under /scan this worker answers; anything else that starts with /scan belongs to the site. */
const OWN_PATH = /^\/scan(?:\/(?:about\/?)?)?$/;

/** The guard pass's configuration from the environment: aggressiveness, gain margin (null: shipped gates), hold budget. */
function guardConfig(env: Env): [aggr: "cautious" | "balanced" | "eager", margin: number | null, holdMs: number] {
  const aggr = env.GUARD_AGGRESSIVENESS === "eager" || env.GUARD_AGGRESSIVENESS === "cautious" ? env.GUARD_AGGRESSIVENESS : "balanced";
  const margin = env.GUARD_MARGIN !== undefined && env.GUARD_MARGIN !== "" && Number.isFinite(Number(env.GUARD_MARGIN)) ? Number(env.GUARD_MARGIN) : null;
  return [aggr, margin, Number(env.GUARD_HOLD_MS) || 900];
}

async function pageData(input: string | null, env: Env, deps: AppDeps, url: URL): Promise<ScanPageData> {
  const shareBase = env.PUBLIC_ORIGIN || (url.hostname === "genclass.dev" ? "https://genclass.dev" : url.origin);
  const base: ScanPageData = { target: null, input: input ?? "", error: null, report: null, shareBase };
  if (input === null || input.trim() === "") return base;
  const t = normaliseTarget(input);
  if (!t.ok) return { ...base, error: { code: t.code, message: t.message } };
  const data: ScanPageData = { ...base, input: t.display, target: { url: t.url, display: t.display } };
  if (await optedOut(env.BUCKET, t.host, env.BLOCKLIST)) return { ...data, error: { code: "opted-out", message: "The owner of this site asked us not to scan it." } };
  data.report = await cachedReport(env.BUCKET, await cacheKey(t.url), deps.now(), REPORT_VERSION);
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
  if (await optedOut(env.BUCKET, target.host, env.BLOCKLIST)) return json({ ok: false, code: "opted-out", message: "The owner of this site asked us not to scan it." }, 403);
  const key = await cacheKey(target.url);
  const hit = await cachedReport(env.BUCKET, key, deps.now(), REPORT_VERSION);
  if (hit) return json({ ok: true, cached: true, report: hit });
  if (AUTOMATED.test(request.headers.get("user-agent") || "")) return json({ ok: false, code: "automated", message: "Scans start from a person's browser, not from crawlers or link previews." }, 403);
  const client = await clientKey(request);
  if (env.SCAN_LIMIT) {
    const { success } = await env.SCAN_LIMIT.limit({ key: client });
    if (!success) return json({ ok: false, code: "rate", message: "You have started five scans in the last minute." }, 429, { "retry-after": "60" });
  }
  if (env.SITE_LIMIT) {
    const { success } = await env.SITE_LIMIT.limit({ key: `site|${siteOf(target.host)}` });
    if (!success) return json({ ok: false, code: "site-rate", message: "This site has had several new scans started in the last minute." }, 429, { "retry-after": "60" });
  }
  const dns = await resolveCheck(target.host, deps.fetch);
  if (!dns.ok) return json(dns, 400);
  const rules = await robotsRules(target.url, deps.fetch, ROBOTS_UA);
  const firstPath = new URL(target.url);
  if (rules && robotsDisallows(rules, `${firstPath.pathname}${firstPath.search}`)) {
    return json({ ok: false, code: "robots", message: "This site's robots.txt asks GenClassScan not to load this page, so the scanner does not." }, 403);
  }
  const id = deps.scanId();
  const cap = Math.max(1, Number(env.MAX_CONCURRENT) || 3);
  const slot = await acquireSlot(env.BUCKET, cap, id, key, deps.now, client);
  if (slot === "same") return json({ ok: false, code: "in-progress", message: "A scan of this page is already running." }, 409, { "retry-after": "20" });
  if (slot === "mine") return json({ ok: false, code: "running", message: "You already have a scan running. It finishes within a minute." }, 429, { "retry-after": "30" });
  if (slot === "busy") return json({ ok: false, code: "busy", message: "All scanners are busy." }, 503, { "retry-after": "30" });
  if (slot === "contention") return json({ ok: false, code: "contention", message: "Many scans are starting at once." }, 503, { "retry-after": "3" });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // the person went away (the request was cancelled, or the stream was): stop the browser at once and keep nothing
  const gone = new AbortController();
  writer.closed.catch(() => gone.abort());
  request.signal?.addEventListener("abort", () => gone.abort(), { once: true });
  let open = true;
  const send = (m: Record<string, unknown>) => {
    if (!open) return;
    writer.write(enc.encode(`${JSON.stringify(m)}\n`)).catch(() => {
      open = false;
      gone.abort();
    });
  };
  send({ type: "progress", step: "check" });
  const work = runAndSave(target, key, id, env, deps, send, gone.signal, rules)
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
      await releaseSlot(env.BUCKET, id, deps.now).catch(() => undefined);
      open = false;
      void writer.close().catch(() => undefined); // not awaited: an unread stream must not hold the scan open
    });
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff" },
  });
}

const ROBOTS_UA = `Mozilla/5.0 (compatible; ${UA_TOKEN})`;

/**
 * The check for a main-frame navigation the page makes while it loads (a redirect, or a script changing location): the
 * same rules as the address a person types, so a redirect cannot take the scanner to genclass.dev, a local or private
 * address, a site that opted out, or a page its robots.txt keeps GenClassScan away from. Cached per host for one scan.
 */
export function navigationCheck(target: Target, env: Env, deps: AppDeps, targetRules: { allow: boolean; path: string }[] | null): (url: string) => Promise<NavVerdict> {
  const hosts = new Map<string, Promise<NavVerdict>>([[target.host, Promise.resolve({ ok: true } as NavVerdict)]]);
  const robots = new Map<string, Promise<{ allow: boolean; path: string }[] | null>>([[new URL(target.url).origin, Promise.resolve(targetRules)]]);
  const no = (code: string, message: string): NavVerdict => ({ ok: false, code, message });
  const hostCheck = async (host: string): Promise<NavVerdict> => {
    const named = blockedName(host);
    if (named === "self") return no("self", "The page redirected to genclass.dev, which the scanner does not scan.");
    if (named === "local" || classifyIp(host) || !publicHostname(host)) return no("redirect", "The page redirected to an address the scanner does not load.");
    if (await optedOut(env.BUCKET, host, env.BLOCKLIST)) return no("opted-out", "The page redirected to a site whose owner asked us not to scan it.");
    const d = await resolveCheck(host, deps.fetch);
    if (!d.ok) return d.code === "private" ? no("private", "The page redirected to a hostname that points to a private or reserved address. The scanner only loads public websites.") : no("redirect", "The page redirected to a hostname the scanner could not look up.");
    return { ok: true };
  };
  return async (url: string): Promise<NavVerdict> => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return no("redirect", "The page redirected to an address the scanner does not load.");
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.port || u.username || u.password) return no("redirect", "The page redirected to an address the scanner does not load.");
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    let h = hosts.get(host);
    if (!h) {
      h = hostCheck(host).catch(() => no("redirect", "The page redirected to an address the scanner could not check."));
      hosts.set(host, h);
    }
    const v = await h;
    if (!v.ok) return v;
    let r = robots.get(u.origin);
    if (!r) {
      r = robotsRules(u.href, deps.fetch, ROBOTS_UA).catch(() => null);
      robots.set(u.origin, r);
    }
    const rules = await r;
    if (rules && robotsDisallows(rules, `${u.pathname}${u.search}`)) return no("robots", "The page redirected to a page whose robots.txt asks GenClassScan not to load it, so the scanner does not.");
    return { ok: true };
  };
}

/** The model judge over the AI binding, unless it is missing or switched off (JUDGE=off). */
export function judgeClient(env: Env): JudgeClient | null {
  const ai = env.AI;
  if (!ai || env.JUDGE === "off") return null;
  return { ask: (input) => ai.run(JUDGE_MODEL, input) };
}

/** GenClass Vision is on when the MODELS binding is there and VISION is not "off". */
export const visionOn = (env: Env): boolean => !!env.MODELS && env.VISION !== "off";

/** The model's bytes, read once per isolate (a failed read is tried again on the next scan). */
let visionModelCache: Promise<VisionModel | null> | null = null;
function visionModel(env: Env): Promise<VisionModel | null> {
  const bucket = env.MODELS;
  if (!bucket) return Promise.resolve(null);
  if (!visionModelCache) {
    const p = readVisionModel(bucket).catch(() => null);
    visionModelCache = p;
    void p.then((m) => {
      if (!m && visionModelCache === p) visionModelCache = null;
    });
  }
  return visionModelCache;
}

/** GenClass Vision for one scan over the MODELS binding, or null when it is off. */
export function visionClient(env: Env, now: () => number): VisionClient | null {
  return visionOn(env) ? visionRunner(() => visionModel(env), now) : null;
}

async function runAndSave(
  target: Target,
  key: string,
  id: string,
  env: Env,
  deps: AppDeps,
  send: (m: Record<string, unknown>) => void,
  signal: AbortSignal,
  rules: { allow: boolean; path: string }[] | null,
): Promise<void> {
  const [aggr, margin, guardHoldMs] = guardConfig(env);
  const result: ScanResult = await runScan(target, {
    launch: () => deps.launch(env),
    now: deps.now,
    sleep: deps.sleep,
    resolveHost: async (host) => {
      const r = await resolveCheck(host, deps.fetch);
      return r.ok ? "ok" : r.code === "private" ? "private" : r.code === "nxdomain" ? "nxdomain" : "unknown";
    },
    navigationAllowed: navigationCheck(target, env, deps, rules),
    signal,
    runtimeSource: deps.runtimeSource(),
    visualSource: deps.visualSource ?? null,
    axeSource: deps.axe?.source ?? null,
    visualFixes: env.WITH_GENCLASS === "on",
    modelBaseUrl: env.MODEL_BASE_URL || DEFAULT_MODEL_BASE,
    runtimeVersion: RUNTIME_VERSION,
    guardHoldMs,
    guardAggressiveness: aggr,
    guardMargin: margin,
    judge: judgeClient(env),
    vision: deps.vision ? deps.vision(env) : visionClient(env, deps.now),
    progress: (step, detail) => send({ type: "progress", step, ...(detail || {}) }),
  });
  if (signal.aborted) throw new ScanError("cancelled", "The scan was stopped because the page that asked for it closed.");
  send({ type: "progress", step: "save" });
  const at = new Date(deps.now());
  const saved = new Set<string>();
  await Promise.all(
    result.views.map(async (v) => {
      if (!v.shot) return;
      try {
        await env.BUCKET.put(shotKey(key, id, v.id), v.shot, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { host: target.host } });
        saved.add(v.id);
      } catch {
        /* the report says there is no screenshot */
      }
    }),
  );
  // the crops the report shows: what the model judge saw for each measured finding it was asked about and for each of
  // its own findings (kept like the screenshots: the host in the metadata, deleted by the same 24-hour sweep)
  const crops = env.JUDGE_CROPS === "all" ? result.views.flatMap((v) => v.judged ?? []) : judgeCropsToKeep(result);
  await Promise.all(
    crops.map(async (j) => {
      try {
        await env.BUCKET.put(shotKey(key, id, j.id), Uint8Array.from(atob(j.image), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { host: target.host } });
        saved.add(j.id);
      } catch {
        /* the report says there is no crop */
      }
    }),
  );
  const shotUrl = (view: string) => (saved.has(view) ? `/api/scan/shot/${key}/${id}-${view}.jpg` : null);
  const report = buildReport(
    target,
    { id, key, at, runtime: RUNTIME_VERSION, axe: deps.axe?.version ?? "", guardHoldMs, guardAggressiveness: aggr, guardMargin: margin, shotUrl, cropUrl: shotUrl },
    result,
    { withGenClass: env.WITH_GENCLASS === "on", judgeDetail: env.JUDGE_CROPS === "all" },
  );
  await saveReport(env.BUCKET, key, report as unknown as Record<string, unknown>);
  const j = report.judge;
  console.log(
    `scan ${id}: ${result.ms.total} ms (launch ${result.ms.launch}, views ${result.ms.views}, probe ${result.ms.probe}, guard ${result.ms.guard}), ${report.findings.length} findings, score ${report.score.value}` +
      (j.on ? `; judge ${j.answered}/${j.calls} answered, ${j.timeouts} late, ${j.tokens} tokens, call ms median ${j.msMedian} max ${j.msMax}, wall ${j.wallMs}, kept ${j.kept} fine ${j.fine} found ${j.found}` : "") +
      (report.vision.on ? `; vision ${report.vision.ran ? "ran" : `did not run (${report.vision.error ?? "no crops"})`}, load ${report.vision.loadMs} ms, ${report.vision.scored} scored, ${report.vision.flagged} flagged, ${report.vision.beta.length} beta, crop ms median ${report.vision.msMedian}` : ""),
  );
  send({ type: "done", report });
}

