// Forwarding (a paid feature): each new detection an owned app reports is sent, server-side from the collector, to
// the destinations its owner turned on: Sentry (envelope API), PostHog (capture API), Datadog (logs intake), Slack
// (incoming webhook) or any HTTPS endpoint (JSON signed with HMAC-SHA256).
//
// Invariants:
// - Only for an app whose owner's plan has the `forwarding` entitlement (checked on every batch), and only for its
//   enabled destinations. Nothing is forwarded for apps without an account.
// - A record holds the diagnosis, confidence, trigger, page route, runtime and model versions, the time and a link
//   to the app's dashboard. Never page text: the collector does not receive it unless an app opted in to situation
//   text, and even then it is not forwarded.
// - The same diagnosis on the same route is forwarded at most once per UTC hour, and at most HOURLY_CAP records per
//   app per hour (forward_log). Sending runs after the collector answered (waitUntil); a failure is written to the
//   destination's last_error and never changes the collector's response.
// - Settings are stored only as AES-GCM ciphertext under the Worker secret INTEGRATIONS_KEY (32 bytes, base64), with
//   the app id and kind as additional data so a row cannot be moved to another app. Without the key nothing can be
//   saved or sent. The pages and the API show masked settings only.

import type { Env } from "./collector.js";
import type { D1Like } from "./dashboard.js";
import { b64url, fromB64url } from "./webauthn.js";

export const KINDS = ["sentry", "posthog", "datadog", "slack", "webhook"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_NAMES: Record<Kind, string> = { sentry: "Sentry", posthog: "PostHog", datadog: "Datadog", slack: "Slack", webhook: "Webhook" };
export const isKind = (v: unknown): v is Kind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** Records forwarded per app per UTC hour, at most. */
export const HOURLY_CAP = 60;
/** Distinct records one batch may forward (bounds outgoing requests per batch). */
const PER_BATCH = 20;
const TIMEOUT_MS = 8000;

export const DATADOG_SITES = ["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com"];
export const POSTHOG_HOSTS = ["https://us.i.posthog.com", "https://eu.i.posthog.com"];

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// --------------------------------------------------------------------------------------------- encryption

const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES-GCM key from INTEGRATIONS_KEY (32 bytes, base64 or base64url), or null when unset or malformed. */
export async function integrationsKey(env: Env): Promise<CryptoKey | null> {
  const raw = (env.INTEGRATIONS_KEY ?? "").trim();
  if (!raw) return null;
  let bytes: Uint8Array;
  try {
    bytes = fromB64url(raw.replace(/\+/g, "-").replace(/\//g, "_"), "INTEGRATIONS_KEY");
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  let k = keyCache.get(raw);
  if (!k) {
    k = crypto.subtle.importKey("raw", bytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(raw, k);
  }
  return k;
}

const aadOf = (projectId: string, kind: Kind): Uint8Array => new TextEncoder().encode(`genclass-integration:${projectId}:${kind}`);

/** Encrypt settings: "v1.<iv>.<ciphertext>" (base64url). Throws when INTEGRATIONS_KEY is missing. */
export async function sealConfig(env: Env, projectId: string, kind: Kind, config: Record<string, unknown>): Promise<string> {
  const key = await integrationsKey(env);
  if (!key) throw new Error("INTEGRATIONS_KEY is not set");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadOf(projectId, kind) as BufferSource }, key, new TextEncoder().encode(JSON.stringify(config)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** Decrypt settings, or null (no key, another key, another row, or tampered). */
export async function openConfig(env: Env, projectId: string, kind: Kind, sealed: string): Promise<Record<string, unknown> | null> {
  const key = await integrationsKey(env);
  const m = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/.exec(sealed);
  if (!key || !m) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(m[1]) as BufferSource, additionalData: aadOf(projectId, kind) as BufferSource }, key, fromB64url(m[2]) as BufferSource);
    const v: unknown = JSON.parse(new TextDecoder().decode(pt));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------------- settings

const str = (v: unknown, max = 2048): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** An https URL on a public host name (no credentials, no IP literal, no localhost), else null. */
export function publicHttpsUrl(v: unknown): URL | null {
  const s = str(v);
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || !h.includes(".")) return null;
  if (/^[\d.]+$/.test(h) || h.startsWith("[") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  return u;
}

export interface SentryDsn {
  key: string;
  envelope: string;
}

/** https://<public key>@<host>[/<path>]/<project id> -> the envelope endpoint, or null. */
export function parseSentryDsn(v: unknown): SentryDsn | null {
  const s = str(v);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/^[A-Za-z0-9]{8,64}$/.test(u.username)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const project = parts.pop();
  if (!project || !/^\d{1,20}$/.test(project)) return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  return { key: u.username, envelope: `https://${u.host}${prefix}/api/${project}/envelope/` };
}

/**
 * Check and normalise the settings typed for a destination. Returns the settings to store, or an error for the person.
 * A webhook gets a new signing secret unless `keep` holds the current one (re-saving the URL keeps the secret).
 */
export function checkConfig(kind: Kind, body: Record<string, unknown>, keep?: Record<string, unknown> | null): { config: Record<string, unknown> } | { error: string } {
  switch (kind) {
    case "sentry": {
      const dsn = str(body.dsn);
      if (!parseSentryDsn(dsn)) return { error: "paste the DSN from Sentry's Client Keys page, like https://abc123@o1.ingest.sentry.io/456" };
      return { config: { dsn } };
    }
    case "posthog": {
      const key = str(body.key, 200);
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(key)) return { error: "paste the project API key from PostHog's project settings (it starts with phc_)" };
      const host = str(body.host) || POSTHOG_HOSTS[0]!;
      const u = POSTHOG_HOSTS.includes(host) ? new URL(host) : publicHttpsUrl(host);
      if (!u) return { error: "the PostHog host must be https://us.i.posthog.com, https://eu.i.posthog.com or your own https address" };
      return { config: { key, host: u.origin } };
    }
    case "datadog": {
      const apiKey = str(body.api_key, 100);
      if (!/^[a-f0-9]{32}$/.test(apiKey)) return { error: "paste a Datadog API key (32 hex characters, from Organization Settings, API Keys)" };
      const site = str(body.site, 40) || DATADOG_SITES[0]!;
      if (!DATADOG_SITES.includes(site)) return { error: `the Datadog site must be one of ${DATADOG_SITES.join(", ")}` };
      return { config: { api_key: apiKey, site } };
    }
    case "slack": {
      const u = publicHttpsUrl(body.url);
      if (!u || !/^hooks\.slack(-gov)?\.com$/.test(u.hostname) || !u.pathname.startsWith("/services/")) {
        return { error: "paste a Slack incoming webhook URL, like https://hooks.slack.com/services/T000/B000/XXXX" };
      }
      return { config: { url: u.toString() } };
    }
    case "webhook": {
      const u = publicHttpsUrl(body.url);
      if (!u) return { error: "the webhook URL must be https on a public host name" };
      const secret = typeof keep?.secret === "string" && body.rotate !== true ? keep.secret : `gcw_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
      return { config: { url: u.toString(), secret } };
    }
  }
}

/** What the page may show about stored settings: never a full key, URL path or secret. */
export function maskConfig(kind: Kind, c: Record<string, unknown> | null): string {
  if (!c) return "settings unreadable; save them again";
  const tail = (s: unknown, n = 4) => (typeof s === "string" && s.length > n ? `...${s.slice(-n)}` : "...");
  try {
    switch (kind) {
      case "sentry": {
        const u = new URL(String(c.dsn));
        return `${u.host}, project ${u.pathname.split("/").filter(Boolean).pop()}`;
      }
      case "posthog":
        return `${new URL(String(c.host)).host}, key ${String(c.key).slice(0, 4)}${tail(c.key)}`;
      case "datadog":
        return `${c.site}, key ${tail(c.api_key)}`;
      case "slack":
        return `hooks.slack.com, webhook ${tail(c.url, 6)}`;
      case "webhook": {
        const u = new URL(String(c.url));
        return `${u.host}${u.pathname.length > 1 ? "/..." : ""}`;
      }
    }
  } catch {
    return "settings unreadable; save them again";
  }
}

// --------------------------------------------------------------------------------------------- records

export interface DetectionRecord {
  diagnosis: string;
  confidence: number | null;
  trigger: string | null;
  route: string | null;
  runtime: string;
  model: string | null;
  time: string;
  app: string;
  app_id: string;
  dashboard: string;
  test?: true;
}

interface BatchLike {
  runtime: string;
  model: string | null;
  events: Record<string, unknown>[];
}

const short = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? [...v.trim()].slice(0, max).join("") : null);

/**
 * One record per likely detection in the batch (a `detect` event without tier "possible"), with the route from its
 * decision record. Exported for tests.
 */
export function detectionRecords(batch: BatchLike, app: { id: string; name: string; dashboard: string }, time: string): DetectionRecord[] {
  const decisions = new Map<string, Record<string, unknown>>();
  for (const e of batch.events) if (e.t === "decision" && typeof e.id === "string") decisions.set(e.id, e);
  const out: DetectionRecord[] = [];
  for (const e of batch.events) {
    if (e.t !== "detect" || e.tier === "possible") continue;
    const d = typeof e.decision === "string" ? decisions.get(e.decision) : undefined;
    const p = typeof e.p === "number" && Number.isFinite(e.p) ? Math.round(e.p * 1000) / 1000 : null;
    out.push({
      diagnosis: short(e.diagnosis, 64) ?? "(unknown)",
      confidence: p,
      trigger: short(e.trigger, 64),
      route: short(d?.route ?? e.route),
      runtime: short(batch.runtime, 40) ?? "unknown",
      model: short(batch.model, 80),
      time,
      app: app.name,
      app_id: app.id,
      dashboard: app.dashboard,
    });
  }
  return out;
}

const signature = (r: DetectionRecord): string => `${r.diagnosis}\t${r.route ?? ""}`;
const headline = (r: DetectionRecord): string =>
  `GenClass found ${r.diagnosis} on ${r.route ?? "an unknown page"} in ${r.app}${r.confidence === null ? "" : ` (confidence ${r.confidence})`}`;

// --------------------------------------------------------------------------------------------- senders

async function hmacHex(secret: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The signature header a webhook receiver checks: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. */
export async function webhookSignature(secret: string, body: string, nowSec: number): Promise<string> {
  return `t=${nowSec},v1=${await hmacHex(secret, `${nowSec}.${body}`)}`;
}

const slackEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hex32 = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The request for one record to one destination (exported for tests). */
export async function buildRequest(kind: Kind, c: Record<string, unknown>, r: DetectionRecord, now: Date): Promise<{ url: string; init: RequestInit }> {
  const json = { "content-type": "application/json", "user-agent": "genclass-forwarder/1 (+https://genclass.dev)" };
  switch (kind) {
    case "sentry": {
      const dsn = parseSentryDsn(c.dsn);
      if (!dsn) throw new Error("the Sentry DSN is not valid");
      const id = hex32();
      const event = {
        event_id: id,
        timestamp: Date.parse(r.time) / 1000,
        platform: "other",
        level: "warning",
        logger: "genclass",
        message: { formatted: headline(r) },
        tags: { "genclass.diagnosis": r.diagnosis, "genclass.trigger": r.trigger ?? "", "genclass.route": r.route ?? "", "genclass.runtime": r.runtime, "genclass.model": r.model ?? "" },
        extra: { confidence: r.confidence, dashboard: r.dashboard, app: r.app, ...(r.test ? { test: true } : {}) },
        fingerprint: ["genclass", r.diagnosis, r.route ?? ""],
      };
      const body = `${JSON.stringify({ event_id: id, sent_at: now.toISOString() })}\n${JSON.stringify({ type: "event", content_type: "application/json" })}\n${JSON.stringify(event)}\n`;
      return {
        url: dsn.envelope,
        init: {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope", "user-agent": json["user-agent"], "x-sentry-auth": `Sentry sentry_version=7, sentry_client=genclass-forwarder/1, sentry_key=${dsn.key}` },
          body,
        },
      };
    }
    case "posthog":
      return {
        url: `${String(c.host)}/capture/`,
        init: {
          method: "POST",
          headers: json,
          body: JSON.stringify({
            api_key: c.key,
            event: "genclass detection",
            distinct_id: `genclass:${r.app_id}`,
            timestamp: r.time,
            properties: { ...r, $process_person_profile: false },
          }),
        },
      };
    case "datadog": {
      const tag = (k: string, v: string | null) => (v ? `${k}:${v.replace(/[,\s]+/g, "_").slice(0, 150)}` : null);
      return {
        url: `https://http-intake.logs.${String(c.site)}/api/v2/logs`,
        init: {
          method: "POST",
          headers: { ...json, "dd-api-key": String(c.api_key) },
          body: JSON.stringify([
            {
              ddsource: "genclass",
              service: "genclass",
              status: "warning",
              ddtags: [tag("diagnosis", r.diagnosis), tag("route", r.route), tag("app", r.app_id), tag("runtime", r.runtime)].filter(Boolean).join(","),
              message: headline(r),
              genclass: r,
            },
          ]),
        },
      };
    }
    case "slack":
      return {
        url: String(c.url),
        init: {
          method: "POST",
          headers: json,
          body: JSON.stringify({
            text: `${r.test ? "[test] " : ""}GenClass found *${slackEscape(r.diagnosis)}* on \`${slackEscape(r.route ?? "an unknown page")}\` in ${slackEscape(r.app)}${r.confidence === null ? "" : ` (confidence ${r.confidence})`}. <${r.dashboard}|Open the dashboard>`,
          }),
        },
      };
    case "webhook": {
      const body = JSON.stringify({ type: r.test ? "genclass.test" : "genclass.detection", ...r });
      return {
        url: String(c.url),
        init: {
          method: "POST",
          headers: { ...json, "x-genclass-event": r.test ? "test" : "detection", "x-genclass-signature": await webhookSignature(String(c.secret), body, Math.floor(now.getTime() / 1000)) },
          body,
        },
      };
    }
  }
}

/** Send one record. Resolves on a 2xx answer; otherwise throws an Error whose message is safe to show the owner. */
export async function send(kind: Kind, c: Record<string, unknown>, r: DetectionRecord, now: Date, f: Fetch): Promise<void> {
  const { url, init } = await buildRequest(kind, c, r, now);
  let res: Response;
  try {
    res = await f(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(`${KIND_NAMES[kind]} did not answer within ${TIMEOUT_MS / 1000} s`);
  }
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  if (res.status < 200 || res.status > 299) throw new Error(`${KIND_NAMES[kind]} answered HTTP ${res.status}`);
}

// --------------------------------------------------------------------------------------------- per batch

export interface IntegrationRow {
  kind: Kind;
  config: string;
  enabled: number;
  created: string;
  last_sent: string | null;
  last_error: string | null;
}

export async function integrationRows(db: D1Like, projectId: string): Promise<IntegrationRow[]> {
  const r = await db.prepare("SELECT kind, config, enabled, created, last_sent, last_error FROM integrations WHERE project_id = ? ORDER BY kind").bind(projectId).all<IntegrationRow>();
  return (r.results ?? []).filter((x) => isKind(x.kind));
}

/** Send to one stored destination and record the outcome on its row. Returns the error text, or null on success. */
export async function deliver(env: Env, db: D1Like, projectId: string, row: Pick<IntegrationRow, "kind" | "config">, r: DetectionRecord, now: Date, f: Fetch): Promise<string | null> {
  let error: string | null = null;
  const c = await openConfig(env, projectId, row.kind, row.config);
  if (!c) error = "the saved settings cannot be read on this server; save them again";
  else {
    try {
      await send(row.kind, c, r, now, f);
    } catch (e) {
      error = e instanceof Error ? e.message : "sending failed";
    }
  }
  const at = now.toISOString();
  try {
    if (error) await db.prepare("UPDATE integrations SET last_error = ? WHERE project_id = ? AND kind = ?").bind(`${error} (${at.slice(0, 16).replace("T", " ")} UTC)`, projectId, row.kind).run();
    else await db.prepare("UPDATE integrations SET last_sent = ?, last_error = NULL WHERE project_id = ? AND kind = ?").bind(at, projectId, row.kind).run();
  } catch {
    /* best effort */
  }
  return error;
}

/**
 * Forward a batch's new detections for one app (already known to be on a plan with forwarding). Dedupe and the hourly
 * cap are claimed in forward_log before anything is sent, so concurrent batches never send the same record twice.
 */
export async function forwardBatch(
  env: Env,
  db: D1Like,
  app: { id: string; name: string; dashboard: string },
  batch: BatchLike,
  now: Date,
  f: Fetch,
): Promise<number> {
  const records = detectionRecords(batch, app, now.toISOString());
  if (!records.length) return 0;
  const rows = (await integrationRows(db, app.id)).filter((x) => x.enabled);
  if (!rows.length) return 0;
  const unique = new Map<string, DetectionRecord>();
  for (const r of records) if (!unique.has(signature(r))) unique.set(signature(r), r);
  const hour = now.toISOString().slice(0, 13);
  const claim =
    "INSERT INTO forward_log (project_id, signature, hour) SELECT ?1, ?2, ?3 " +
    "WHERE (SELECT COUNT(*) FROM forward_log WHERE project_id = ?1 AND hour = ?3) < ?4 ON CONFLICT DO NOTHING RETURNING signature";
  const picked: DetectionRecord[] = [];
  for (const [sig, r] of unique) {
    if (picked.length >= PER_BATCH) break;
    const got = await db.prepare(claim).bind(app.id, sig, hour, HOURLY_CAP).first();
    if (got) picked.push(r);
  }
  for (const r of picked) await Promise.allSettled(rows.map((row) => deliver(env, db, app.id, row, r, now, f)));
  return picked.length;
}

/** The record "Send test" sends. */
export function testRecord(app: { id: string; name: string; dashboard: string }, now: Date): DetectionRecord {
  return {
    diagnosis: "duplicate",
    confidence: 0.99,
    trigger: "test",
    route: "/genclass-test",
    runtime: "test",
    model: null,
    time: now.toISOString(),
    app: app.name,
    app_id: app.id,
    dashboard: app.dashboard,
    test: true,
  };
}
