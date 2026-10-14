// What the collector does after storing a batch from an app in an account, beyond the dashboard counters: index the
// batch for the export (copied under export/ when the owner's plan keeps more than 90 days) and forward its detections
// when the owner's plan includes forwarding and a destination is on. Apps without an account (private links only)
// cannot export or forward, so their batches cost nothing more. Runs in waitUntil; never affects the response.

import type { BucketLike, Env } from "./collector.js";
import { RETENTION_DAYS, type D1Like } from "./dashboard.js";
import { storeForExport } from "./export.js";
import { forwardBatch } from "./forward.js";
import { entitled, keepDays, planById, type Plan } from "./plans.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Owner {
  projectId: string | null;
  name: string;
  accountId: string | null;
  plan: Plan;
  /** Enabled forwarding destinations. */
  destinations: number;
}

const OWNER_MS = 60_000;
const owners = new Map<string, { o: Owner | null; exp: number }>();
export const resetOwnerCache = (): void => owners.clear();
/** Drop one app from this isolate's cache (its destinations or plan just changed). */
export const forgetOwner = (token: string): boolean => owners.delete(token);

/** The app behind a token, its owner's plan and how many destinations are on (cached a minute per isolate). */
export async function ownerOf(db: D1Like, token: string, nowMs: number): Promise<Owner | null> {
  const c = owners.get(token);
  if (c && c.exp > nowMs) return c.o;
  const row = await db
    .prepare(
      "SELECT p.id, p.name, p.account_id, a.plan, (SELECT COUNT(*) FROM integrations i WHERE i.project_id = p.id AND i.enabled = 1) AS n " +
        "FROM projects p LEFT JOIN accounts a ON a.id = p.account_id WHERE p.token = ?",
    )
    .bind(token)
    .first<{ id: string | null; name: string; account_id: string | null; plan: string | null; n: number }>();
  const o: Owner | null = row
    ? { projectId: row.id, name: row.name, accountId: row.account_id, plan: planById(row.account_id ? row.plan : "free"), destinations: Number(row.n) || 0 }
    : null;
  if (owners.size > 5000) owners.clear();
  owners.set(token, { o, exp: nowMs + OWNER_MS });
  return o;
}

export interface StoredBatch {
  token: string;
  runtime: string;
  model: string | null;
  events: Record<string, unknown>[];
  /** The R2 key under events/, its gzip bytes, the time it was received and its id (the key's file name). */
  key: string;
  gz: Uint8Array;
  received: string;
  id: string;
}

export async function afterBatch(env: Env & { BUCKET: BucketLike }, db: D1Like, b: StoredBatch, now: Date, f: Fetch): Promise<void> {
  const owner = await ownerOf(db, b.token, now.getTime());
  if (!owner?.accountId) return;
  const tasks: Promise<unknown>[] = [
    storeForExport(db, env.BUCKET, {
      token: b.token,
      key: b.key,
      gz: b.gz,
      received: b.received,
      events: b.events.length,
      id: b.id,
      keepLong: keepDays(owner.plan) > RETENTION_DAYS,
    }),
  ];
  if (owner.projectId && owner.destinations > 0 && entitled(owner.plan, "forwarding") && b.events.some((e) => e.t === "detect")) {
    const origin = (env.AUTH_ORIGIN || env.DASHBOARD_ORIGIN || "https://genclass.dev").replace(/\/+$/, "");
    tasks.push(forwardBatch(env, db, { id: owner.projectId, name: owner.name, dashboard: `${origin}/account/apps/${owner.projectId}` }, b, now, f));
  }
  await Promise.allSettled(tasks);
}
