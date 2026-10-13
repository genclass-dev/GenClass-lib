// A GenClass account for the CLI: the credentials file, the account API on genclass.dev and the device sign-in flow
// (RFC 8628) behind `genclass-runtime login` (owner: INSTALL). No terminal output here (login.mjs prints).
//
// The credentials file holds one CLI session: { host, access_token ("gcs_..."), account { id, email, github_login },
// created }. It lives in $XDG_CONFIG_HOME/genclass/credentials.json, else ~/.config/genclass/credentials.json
// (Windows: %APPDATA%\genclass\credentials.json), mode 600 in a directory with mode 700, and is only used for the
// host it was made for. The session token can read the account's apps and create apps in it; `logout` revokes it
// on genclass.dev and deletes the file. Nothing here touches the network unless a command calls one of the request
// functions, and none of them rejects: each resolves { ok: true, ... } or { ok: false, reason, status? }.

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiHost } from "./host.mjs";
import { TOKEN_RE } from "./token.mjs";

const SESSION_RE = /^gcs_[A-Za-z0-9_-]{16,200}$/;
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const TIMEOUT_MS = 15_000;

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")).version;
  } catch {
    return "0";
  }
})();
const USER_AGENT = `genclass-runtime-cli/${VERSION}`;

// ------------------------------------------------------------------------------------------ credentials

/** The credentials file for this platform and environment. */
export function credentialsPath(env = process.env, platform = process.platform) {
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "genclass", "credentials.json");
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(env.HOME || homedir(), ".config");
  return join(xdg, "genclass", "credentials.json");
}

const cleanAccount = (a) => (a && typeof a === "object" ? { id: String(a.id ?? ""), email: typeof a.email === "string" ? a.email : null, github_login: typeof a.github_login === "string" ? a.github_login : null } : null);

/**
 * The saved CLI session for `host` (default: the host the CLI talks to), or null: no file, unreadable, malformed, or
 * made for another host (readCredentialsFor says which).
 */
export function readCredentials(host = apiHost()) {
  return readCredentialsFor(host).creds;
}

/** { creds, otherHost?, path }: the session for `host`, or why there is none. */
export function readCredentialsFor(host = apiHost()) {
  const path = credentialsPath();
  let j;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { creds: null, path };
  }
  if (!j || typeof j !== "object" || !SESSION_RE.test(String(j.access_token ?? ""))) return { creds: null, path };
  if (j.host !== host) return { creds: null, path, otherHost: typeof j.host === "string" ? j.host : "another host" };
  return { creds: { host: j.host, access_token: j.access_token, account: cleanAccount(j.account) ?? { id: "", email: null, github_login: null }, created: typeof j.created === "string" ? j.created : null }, path };
}

/** Writes the session (mode 600, directory 700, replaced atomically). Returns the file's path. */
export function saveCredentials(creds) {
  const path = credentialsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const tmp = join(dir, `.credentials.${process.pid}.tmp`);
  const body = { host: creds.host, access_token: creds.access_token, account: cleanAccount(creds.account), created: creds.created ?? new Date().toISOString() };
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return path;
}

/** Deletes the credentials file. Returns true when there was one. */
export function deleteCredentials() {
  const path = credentialsPath();
  try {
    readFileSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

// ------------------------------------------------------------------------------------------------ requests

/**
 * One JSON request to the host. Resolves { ok, status, json } for any HTTP answer (json null when the body is not
 * JSON) or { ok: false, status: 0, reason } for a network error or timeout. Never rejects.
 */
export async function request(path, { method = "GET", token, body, host = apiHost(), fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal } = {}) {
  if (typeof fetchFn !== "function") return { ok: false, status: 0, reason: "this Node.js has no fetch" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers = { accept: "application/json", "user-agent": USER_AGENT };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchFn(`${host}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctl.signal, redirect: "error" });
    let json = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, json };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, reason: "cancelled", cancelled: true };
    const aborted = e?.name === "AbortError";
    return { ok: false, status: 0, reason: aborted ? `no answer within ${timeoutMs / 1000} s` : `network error (${e?.cause?.code ?? e?.message ?? e})` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** A short reason for a failed request. */
export function failure(r, what) {
  if (r.status === 0) return r.reason;
  if (r.status === 401) return "the CLI session is no longer valid (signed out, revoked or expired)";
  if (r.status === 429) return `too many requests from this network right now (HTTP 429)`;
  const msg = typeof r.json?.error === "string" ? `: ${r.json.error}` : "";
  return `${what ? `${what}: ` : ""}the server answered HTTP ${r.status}${msg}`;
}

const sameOrigin = (u, host) => {
  try {
    return new URL(u).origin === host;
  } catch {
    return false;
  }
};

/** One app of the account as the API returns it, or null when it is not one. */
export function cleanProject(p, host = apiHost()) {
  if (!p || typeof p !== "object" || !TOKEN_RE.test(String(p.token ?? ""))) return null;
  return {
    id: String(p.id ?? ""),
    name: typeof p.name === "string" && p.name ? p.name : "unnamed",
    token: p.token,
    dashboard_url: typeof p.dashboard_url === "string" && sameOrigin(p.dashboard_url, host) ? p.dashboard_url : null,
    created: typeof p.created === "string" ? p.created : null,
    last_event: typeof p.last_event === "string" ? p.last_event : null,
  };
}

// ------------------------------------------------------------------------------------------- device flow

/**
 * POST /api/device/code. Resolves { ok: true, device_code, user_code, verification_uri, verification_uri_complete,
 * expires_in, interval } (URLs checked to be on the host) or { ok: false, reason }.
 */
export async function startDeviceLogin(opts = {}) {
  const host = opts.host ?? apiHost();
  const r = await request("/api/device/code", { method: "POST", body: {}, host, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, reason: failure(r) };
  const j = r.json ?? {};
  const uri = typeof j.verification_uri === "string" && sameOrigin(j.verification_uri, host) ? j.verification_uri : null;
  if (typeof j.device_code !== "string" || !j.device_code || !USER_CODE_RE.test(String(j.user_code ?? "")) || !uri) return { ok: false, reason: "the server's answer had no valid device code" };
  const complete = typeof j.verification_uri_complete === "string" && sameOrigin(j.verification_uri_complete, host) ? j.verification_uri_complete : `${uri}?code=${encodeURIComponent(j.user_code)}`;
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return { ok: true, device_code: j.device_code, user_code: j.user_code, verification_uri: uri, verification_uri_complete: complete, expires_in: num(j.expires_in, 600), interval: num(j.interval, 5) };
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Polls POST /api/device/token until the code is approved, denied or expired, waiting `interval` seconds between
 * polls (5 more after each slow_down, and on HTTP 429). Resolves { ok: true, access_token, expires_in, account } or
 * { ok: false, error: "access_denied" | "expired_token" | "cancelled" | "failed", reason }.
 */
export async function pollDeviceLogin(dev, opts = {}) {
  const host = opts.host ?? apiHost();
  const signal = opts.signal;
  let interval = Math.max(1, Number(dev.interval) || 5);
  const deadline = Date.now() + Math.max(1, Number(dev.expires_in) || 600) * 1000;
  let failures = 0;
  for (;;) {
    await sleep(interval * 1000, signal);
    if (signal?.aborted) return { ok: false, error: "cancelled", reason: "cancelled" };
    if (Date.now() > deadline) return { ok: false, error: "expired_token", reason: "the code expired before it was approved" };
    const r = await request("/api/device/token", { method: "POST", body: { device_code: dev.device_code }, host, fetchFn: opts.fetchFn, signal });
    if (r.cancelled || signal?.aborted) return { ok: false, error: "cancelled", reason: "cancelled" };
    if (r.ok) {
      const j = r.json ?? {};
      if (!SESSION_RE.test(String(j.access_token ?? ""))) return { ok: false, error: "failed", reason: "the server's answer had no valid session token" };
      return { ok: true, access_token: j.access_token, expires_in: Number(j.expires_in) || null, account: cleanAccount(j.account) };
    }
    const code = typeof r.json?.error === "string" ? r.json.error : null;
    if (r.status === 400 && code === "authorization_pending") {
      failures = 0;
      opts.onWait?.();
      continue;
    }
    if ((r.status === 400 && code === "slow_down") || r.status === 429) {
      failures = 0;
      interval += 5;
      opts.onSlowDown?.(interval);
      continue;
    }
    if (r.status === 400 && code === "access_denied") return { ok: false, error: "access_denied", reason: "the sign-in was denied in the browser" };
    if (r.status === 400 && code === "expired_token") return { ok: false, error: "expired_token", reason: "the code expired before it was approved" };
    // a network error or a server error: try again a few times before giving up
    if (r.status === 0 || r.status >= 500) {
      if (++failures < 4) continue;
      return { ok: false, error: "failed", reason: failure(r) };
    }
    return { ok: false, error: "failed", reason: failure(r) };
  }
}

// ------------------------------------------------------------------------------------------- account API

/** GET /api/me: { ok: true, account, projects } or { ok: false, status, reason }. */
export async function fetchMe(creds, opts = {}) {
  const r = await request("/api/me", { token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r) };
  const j = r.json ?? {};
  return { ok: true, account: cleanAccount(j.account) ?? creds.account, projects: (Array.isArray(j.projects) ? j.projects : []).map((p) => cleanProject(p, creds.host)).filter(Boolean) };
}

/**
 * POST /api/account/projects {name}: a new app in the account. Resolves the same shape as token.mjs createProject
 * ({ ok: true, token, dashboardUrl, name, created, id, account: true } or { ok: false, reason }), so init can use either.
 */
export async function createAccountProject(creds, name, opts = {}) {
  const r = await request("/api/account/projects", { method: "POST", token: creds.access_token, host: creds.host, body: name ? { name: String(name).slice(0, 80) } : {}, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r) };
  const p = cleanProject(r.json?.project, creds.host);
  if (!p) return { ok: false, reason: "the server's answer had no valid app token" };
  return { ok: true, token: p.token, dashboardUrl: p.dashboard_url, name: p.name, created: p.created ?? undefined, id: p.id, account: true };
}

/**
 * POST /api/account/projects/claim {dashboard_url}: adds an app made without an account (its private link) to the
 * account. Resolves { ok: true, project } or { ok: false, status, reason }.
 */
export async function claimProject(creds, dashboardUrl, opts = {}) {
  const r = await request("/api/account/projects/claim", { method: "POST", token: creds.access_token, host: creds.host, body: { dashboard_url: dashboardUrl }, fetchFn: opts.fetchFn });
  if (!r.ok) return { ok: false, status: r.status, reason: failure(r) };
  return { ok: true, project: cleanProject(r.json?.project, creds.host) };
}

/** DELETE /api/account/sessions/current: revokes this CLI session. 401 counts as done (already revoked). */
export async function revokeSession(creds, opts = {}) {
  const r = await request("/api/account/sessions/current", { method: "DELETE", token: creds.access_token, host: creds.host, fetchFn: opts.fetchFn });
  if (r.ok || r.status === 401) return { ok: true, already: r.status === 401 };
  return { ok: false, status: r.status, reason: failure(r) };
}
