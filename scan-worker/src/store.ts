// Scan storage in the existing R2 bucket genclass-telemetry, under scans/ only:
//   scans/reports/<key>.json          one report per normalised URL (served for 6 hours)
//   scans/shots/<key>/<id>-<view>.jpg  screenshots (deleted after 24 hours by the hourly sweep), with the host in their
//                                     custom metadata so an opt-out also stops them being served
//   scans/slots.json                  the global concurrency leases (compare-and-swap on the etag), one per client at most
//   scans/blocklist.json              owner opt-outs: { "hosts": ["example.com", ...] } (subdomains included)
// <key> is the first 32 hex characters of sha256(normalised URL).

export const CACHE_MS = 6 * 60 * 60 * 1000;
export const RETAIN_MS = 24 * 60 * 60 * 1000;
/** A lease outlives the 45 s scan budget plus the checks before it and the save after it, and no more. */
export const LEASE_MS = 60_000;

export interface Bucket {
  get(key: string): Promise<{ etag: string; uploaded: Date; text(): Promise<string>; body?: ReadableStream; httpEtag?: string; size?: number; customMetadata?: Record<string, string> } | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: Record<string, unknown>): Promise<{ etag: string } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}

export async function cacheKey(url: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const reportKey = (key: string): string => `scans/reports/${key}.json`;
export const shotKey = (key: string, id: string, view: string): string => `scans/shots/${key}/${id}-${view}.jpg`;
export const SHOT_PATH = /^\/api\/scan\/shot\/([0-9a-f]{32})\/([0-9a-z]{6,40})-(desktop|phone|phone-dark)\.jpg$/;

/**
 * A cached report younger than 6 hours made by this version of the scanner, or null. A report from an older build is a
 * miss: it can show results the current checks would not produce.
 */
export async function cachedReport(bucket: Bucket, key: string, now: number, version: number): Promise<Record<string, unknown> | null> {
  const obj = await bucket.get(reportKey(key));
  if (!obj) return null;
  try {
    const r = JSON.parse(await obj.text()) as Record<string, unknown>;
    if (r.v !== version) return null;
    const at = Date.parse(String(r.scannedAt || "")) || obj.uploaded.getTime();
    return now - at < CACHE_MS ? r : null;
  } catch {
    return null;
  }
}

export async function saveReport(bucket: Bucket, key: string, report: Record<string, unknown>): Promise<void> {
  await bucket.put(reportKey(key), JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
}

// ------------------------------------------------------------------------------------- concurrency leases

interface Slots {
  /** `client` is the same hash of the visitor's address the rate limit uses (never the address itself). */
  leases: { id: string; key: string; until: number; client?: string }[];
}

/** New browsers a second across everyone: Browser Rendering on Workers Paid allows 3 (limits page, 2026-09-26). */
export const LAUNCHES_PER_SECOND = 3;

export type SlotAnswer = "ok" | "busy" | "same" | "mine" | "contention";

/**
 * Takes one of `cap` global scan slots, or reports why not: "same" (this URL is already being scanned), "mine" (this
 * client already has a scan running: one at a time per client), "busy" (all taken) or "contention" (slots may be free,
 * but every attempt lost the compare-and-swap race or got R2's 429: worth a retry in a few seconds). Compare-and-swap
 * on the object's etag; a lease expires by itself after LEASE_MS. A lease is not taken while LAUNCHES_PER_SECOND
 * others started in the last second, so new browsers stay under Browser Rendering's rate. `now` is read again on
 * every attempt.
 */
export async function acquireSlot(
  bucket: Bucket,
  cap: number,
  id: string,
  key: string,
  now: number | (() => number),
  client = "",
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SlotAnswer> {
  const clock = typeof now === "function" ? now : () => now;
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = clock();
    const obj = await bucket.get("scans/slots.json");
    let slots: Slots = { leases: [] };
    if (obj) {
      try {
        slots = JSON.parse(await obj.text()) as Slots;
      } catch {
        slots = { leases: [] };
      }
    }
    const live = (slots.leases || []).filter((l) => l.until > t);
    if (live.some((l) => l.key === key)) return "same";
    if (client && live.some((l) => l.client === client)) return "mine";
    if (live.length >= cap) return "busy";
    const recent = live.filter((l) => l.until - LEASE_MS > t - 1000).length;
    if (recent < LAUNCHES_PER_SECOND) {
      live.push({ id, key, until: t + LEASE_MS, ...(client ? { client } : {}) });
      // R2 takes at most one write per second to one key and answers more with 429 (thrown here): that is a retry too
      const put = await bucket
        .put("scans/slots.json", JSON.stringify({ leases: live }), {
          onlyIf: obj ? { etagMatches: obj.etag } : new Headers({ "if-none-match": "*" }),
          httpMetadata: { contentType: "application/json" },
        })
        .catch(() => null);
      if (put) return "ok";
    }
    await wait(250 + attempt * 200 + Math.floor(Math.random() * 150));
  }
  return "contention";
}

/** Gives a slot back. More attempts than taking one: a release that loses every round keeps its slot for LEASE_MS. */
export async function releaseSlot(bucket: Bucket, id: string, now: number | (() => number)): Promise<void> {
  const clock = typeof now === "function" ? now : () => now;
  for (let attempt = 0; attempt < 10; attempt++) {
    const obj = await bucket.get("scans/slots.json");
    if (!obj) return;
    let slots: Slots;
    try {
      slots = JSON.parse(await obj.text()) as Slots;
    } catch {
      return;
    }
    if (!(slots.leases || []).some((l) => l.id === id)) return;
    const t = clock();
    const leases = (slots.leases || []).filter((l) => l.id !== id && l.until > t);
    const put = await bucket.put("scans/slots.json", JSON.stringify({ leases }), { onlyIf: { etagMatches: obj.etag }, httpMetadata: { contentType: "application/json" } }).catch(() => null);
    if (put) return;
    await new Promise((r) => setTimeout(r, 250 + attempt * 200 + Math.floor(Math.random() * 150)));
  }
}

// ------------------------------------------------------------------------------------------- opt-outs

/** Hosts whose owners asked not to be scanned: scans/blocklist.json plus the BLOCKLIST variable (comma-separated). */
export async function optedOut(bucket: Bucket, host: string, extra: string | undefined): Promise<boolean> {
  const hosts: string[] = (extra || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  try {
    const obj = await bucket.get("scans/blocklist.json");
    if (obj) {
      const j = JSON.parse(await obj.text()) as { hosts?: unknown };
      if (Array.isArray(j.hosts)) for (const h of j.hosts) if (typeof h === "string") hosts.push(h.trim().toLowerCase().replace(/^\*\./, ""));
    }
  } catch {
    /* an unreadable list blocks nothing extra; the variable still applies */
  }
  return hosts.some((h) => h && (host === h || host.endsWith(`.${h}`)));
}

// ------------------------------------------------------------------------------------------- retention

/** Deletes scan reports and screenshots older than 24 hours (the hourly cron). Returns how many were deleted. */
export async function sweep(bucket: Bucket, now: number): Promise<number> {
  let deleted = 0;
  for (const prefix of ["scans/shots/", "scans/reports/"]) {
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await bucket.list({ prefix, cursor, limit: 1000 });
      const old = res.objects.filter((o) => now - o.uploaded.getTime() > RETAIN_MS).map((o) => o.key);
      for (let i = 0; i < old.length; i += 1000) await bucket.delete(old.slice(i, i + 1000));
      deleted += old.length;
      if (!res.truncated) break;
      cursor = res.cursor;
    }
  }
  return deleted;
}
