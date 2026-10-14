// Export (a paid feature): every event GenClass received for an owned app, as JSON Lines or CSV, read back from the
// gzip batches in R2.
//
// - R2 keys are by day, runtime and model, not by app, so every batch from a known token gets a row in event_batches
//   (token, time, key). For an app whose owner's plan keeps more than 90 days, the batch is also written under
//   export/<token>/ (an R2 lifecycle rule on that prefix keeps it a year; events/ expires after 90 days) and the row
//   points at that copy.
// - A page is at most PAGE_MAX batches, streamed one object at a time; the next page's cursor is in the
//   x-genclass-next-cursor header (and a Link rel="next" header).
// - Every line is checked against the app's token before it is written, so a wrong index row can never put another
//   app's events into an export.
// - The sweep deletes index rows and export copies past the plan's history (src/plans.ts).

import type { BucketLike } from "./collector.js";
import { RETENTION_DAYS, type D1Like } from "./dashboard.js";
import { b64url, fromB64url } from "./webauthn.js";

const DAY = 86_400_000;
export const EXPORT_PREFIX = "export/";
export const PAGE_MAX = 200;
/** Keys per round (D1 binds at most 100 parameters per statement) and rounds per pass of the daily sweep. */
const SWEEP_CHUNK = 90;
const SWEEP_ROUNDS = 40;

export type BucketOps = BucketLike;

// --------------------------------------------------------------------------------------------- ingest

/**
 * Index one stored batch for its app. `keepLong`: the owner's plan keeps more than 90 days, so the batch is copied
 * under export/<token>/ and the row points at the copy (on a failed copy it points at the original).
 */
export async function storeForExport(
  db: D1Like,
  bucket: BucketLike,
  o: { token: string; key: string; gz: Uint8Array; received: string; events: number; id: string; keepLong: boolean },
): Promise<void> {
  let key = o.key;
  if (o.keepLong) {
    const copy = `${EXPORT_PREFIX}${o.token}/dt=${o.received.slice(0, 10)}/${o.id}.jsonl.gz`;
    try {
      await bucket.put(copy, o.gz, { httpMetadata: { contentType: "application/gzip" } });
      key = copy;
    } catch {
      /* keep the events/ key */
    }
  }
  await db.prepare("INSERT OR IGNORE INTO event_batches (token, received, key, events) VALUES (?, ?, ?, ?)").bind(o.token, o.received, key, o.events).run();
}

// --------------------------------------------------------------------------------------------- reading

export interface Cursor {
  received: string;
  key: string;
}

export const encodeCursor = (c: Cursor): string => b64url(new TextEncoder().encode(`${c.received}\n${c.key}`));

export function decodeCursor(v: string | null): Cursor | null | "bad" {
  if (v === null || v === "") return null;
  try {
    const [received, key, extra] = new TextDecoder().decode(fromB64url(v, "cursor")).split("\n");
    if (extra !== undefined || !received || !key || Number.isNaN(Date.parse(received)) || key.length > 512) return "bad";
    return { received, key };
  } catch {
    return "bad";
  }
}

/** A date (YYYY-MM-DD, as UTC midnight) or an ISO time, or null. */
export function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : v;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

const CSV_COLUMNS = ["received_at", "session", "runtime", "model", "country", "type", "seq", "route", "trigger", "diagnosis", "event"];

/** One CSV cell: quoted when needed, and a leading = + - @ (a spreadsheet formula) defused with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(line: Record<string, unknown>): string {
  const e = (line.event && typeof line.event === "object" ? line.event : {}) as Record<string, unknown>;
  return [line.receivedAt, line.sid, line.runtime, line.model, line.country, e.t, e.seq, e.route, e.trigger, e.diagnosis, e].map(csvCell).join(",") + "\r\n";
}

async function gunzipText(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export interface ExportQuery {
  token: string;
  from: Date;
  to: Date;
  cursor: Cursor | null;
  limit: number;
  format: "jsonl" | "csv";
  /** The download's file name (no path). */
  filename: string;
  /** This request's URL without the cursor, for the Link header. */
  url: URL;
}

/** One page of an app's export as a streamed response. */
export async function exportResponse(db: D1Like, bucket: BucketLike, q: ExportQuery): Promise<Response> {
  const params: unknown[] = [q.token, q.from.toISOString(), q.to.toISOString()];
  let after = "";
  if (q.cursor) {
    after = " AND (received > ? OR (received = ? AND key > ?))";
    params.push(q.cursor.received, q.cursor.received, q.cursor.key);
  }
  const r = await db
    .prepare(`SELECT received, key FROM event_batches WHERE token = ? AND received >= ? AND received < ?${after} ORDER BY received, key LIMIT ?`)
    .bind(...params, q.limit + 1)
    .all<Cursor>();
  const rows = r.results ?? [];
  const page = rows.slice(0, q.limit);
  const next = rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null;
  const enc = new TextEncoder();
  let i = 0;
  let header = q.format === "csv" && !q.cursor;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (header) {
        header = false;
        ctl.enqueue(enc.encode(CSV_COLUMNS.join(",") + "\r\n"));
        return;
      }
      while (i < page.length) {
        const row = page[i++]!;
        let text = "";
        try {
          const obj = bucket.get ? await bucket.get(row.key) : null;
          if (obj) text = await gunzipText(await obj.arrayBuffer());
        } catch {
          text = "";
        }
        let out = "";
        for (const l of text.split("\n")) {
          if (!l) continue;
          let line: Record<string, unknown>;
          try {
            line = JSON.parse(l) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (line.token !== q.token) continue; // never another app's events
          out += q.format === "csv" ? csvRow(line) : `${JSON.stringify(line)}\n`;
        }
        if (out) {
          ctl.enqueue(enc.encode(out));
          return;
        }
      }
      ctl.close();
    },
  });
  const headers: Record<string, string> = {
    "content-type": q.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="${q.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-genclass-batches": String(page.length),
    "access-control-expose-headers": "x-genclass-next-cursor, x-genclass-batches",
  };
  if (next) {
    const u = new URL(q.url.toString());
    u.searchParams.set("cursor", next);
    headers["x-genclass-next-cursor"] = next;
    headers.link = `<${u.pathname}${u.search}>; rel="next"`;
  }
  return new Response(stream, { status: 200, headers });
}

// --------------------------------------------------------------------------------------------- sweep

/**
 * Delete index rows (and export copies) past retention: rows of events/ batches after RETENTION_DAYS (R2's lifecycle
 * rule removes those objects), export copies of apps no longer kept long after RETENTION_DAYS, and every export copy
 * after the longest plan's history. Bounded per run; the rest goes the next day.
 */
export async function exportSweep(db: D1Like, bucket: BucketLike | undefined, now: Date, long?: { tokens: string; params: unknown[]; days: number }): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY).toISOString();
  const far = new Date(now.getTime() - Math.max(long?.days ?? RETENTION_DAYS, RETENTION_DAYS) * DAY).toISOString();
  const keep = long ? ` AND token NOT IN (${long.tokens})` : "";
  const passes: [string, unknown[]][] = [
    [`SELECT key FROM event_batches WHERE received < ? AND key LIKE 'export/%'${keep} LIMIT ${SWEEP_CHUNK}`, [cutoff, ...(long?.params ?? [])]],
    [`SELECT key FROM event_batches WHERE received < ? AND key LIKE 'export/%' LIMIT ${SWEEP_CHUNK}`, [far]],
  ];
  for (const [sql, params] of passes) {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const keys = ((await db.prepare(sql).bind(...params).all<{ key: string }>()).results ?? []).map((x) => x.key);
      if (!keys.length) break;
      if (bucket?.delete) await bucket.delete(keys);
      await db.prepare(`DELETE FROM event_batches WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys).run();
      if (keys.length < SWEEP_CHUNK) break;
    }
  }
  await db.prepare("DELETE FROM event_batches WHERE received < ? AND key NOT LIKE 'export/%'").bind(cutoff).run();
}

/** Delete an app's export copies and index rows at once (the app or its account was deleted). */
export async function forgetExports(db: D1Like, bucket: BucketLike | undefined, tokens: string[]): Promise<void> {
  for (const token of tokens) {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
      const keys = ((await db.prepare(`SELECT key FROM event_batches WHERE token = ? AND key LIKE 'export/%' LIMIT ${SWEEP_CHUNK}`).bind(token).all<{ key: string }>()).results ?? []).map((x) => x.key);
      if (!keys.length) break;
      if (bucket?.delete) await bucket.delete(keys);
      await db.prepare(`DELETE FROM event_batches WHERE token = ? AND key IN (${keys.map(() => "?").join(", ")})`).bind(token, ...keys).run();
    }
    await db.prepare("DELETE FROM event_batches WHERE token = ?").bind(token).run();
  }
}
