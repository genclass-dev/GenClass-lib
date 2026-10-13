// Accounts on genclass.dev: sign-up and sign-in with passkeys (WebAuthn, src/webauthn.ts), Google (OpenID Connect,
// authorization code flow with PKCE, confidential client) or GitHub (OAuth web flow); web and CLI sessions; the
// device flow (RFC 8628) behind `npx @genclass/runtime login`; apps (projects) owned by an account.
//
// Invariants:
// - Secrets are stored only as SHA-256 hashes: session cookies, CLI bearer tokens and device codes. Passkeys store a
//   public key. Google and GitHub access tokens are used once during sign-in and never stored.
// - A Google or GitHub identity is attached to an existing account only through "Link" from a signed-in session,
//   never because an email matches: passkey sign-up emails are unverified, so matching on them would let someone
//   register a victim's address first and later receive the victim's sign-in.
// - Every state-changing request authenticated by a cookie must carry an Origin equal to the expected origin (else
//   403). The JSON endpoints the pages call also require Content-Type application/json. Bearer requests (the CLI)
//   carry no ambient credentials and need no Origin.
// - Nothing is logged; the client IP is only a rate-limit key (hashed), never stored.
// Routes: see telemetry-worker/README.md ("Accounts").

import type { Env, HandleOptions } from "./collector.js";
import {
  accountPage,
  appNotFoundPage,
  devicePage,
  loginPage,
  messagePage,
  pendingPage,
  signupPage,
  type AccountView,
} from "./account-pages.js";
import {
  createProject,
  newProjectId,
  PROJECT_COLUMNS,
  PROJECT_ID_RE,
  projectBySecret,
  projectsCreatedSince,
  randomBase62,
  RANGES,
  sanitizeName,
  SECRET_RE,
  sha256Hex,
  stats,
  type D1Like,
  type Project,
  type Range,
} from "./dashboard.js";
import { json, mediaType, readCapped } from "./http.js";
import { dashboardPage, securityHeaders } from "./pages.js";
import {
  b64url,
  equalStrings,
  ES256,
  fromB64url,
  RS256,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
  type Expected,
} from "./webauthn.js";

// --------------------------------------------------------------------------------------------- constants

const MINUTE = 60_000;
const DAY = 86_400_000;
export const WEB_SESSION_MS = 30 * DAY;
export const CLI_SESSION_MS = 90 * DAY;
export const CHALLENGE_MS = 5 * MINUTE;
export const OAUTH_MS = 10 * MINUTE;
export const DEVICE_CODE_MS = 10 * MINUTE;
export const DEVICE_INTERVAL_S = 5;
export const MAX_APPS_PER_ACCOUNT = 200;
/** Global ceiling on new projects per minute, shared with anonymous creation (collector.ts). */
const MAX_PROJECTS_PER_MINUTE = 60;

export const SESSION_COOKIE = "gc_session";
export const PENDING_COOKIE = "gc_pending";
export const GOOGLE_COOKIE = "gc_oauth_google";
export const GITHUB_COOKIE = "gc_oauth_github";

/** CLI bearer token: `gcs_` + 32 random bytes as base64url. */
export const CLI_TOKEN_RE = /^gcs_[A-Za-z0-9_-]{43}$/;
const SECRET43_RE = /^[A-Za-z0-9_-]{43}$/;
const ID22_RE = /^[A-Za-z0-9]{22}$/;
const SESSION_ID_RE = /^[A-Za-z0-9]{16}$/;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,1400}$/;
/** User codes avoid vowels (no words) and look-alikes (RFC 8628 section 6.1). */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

// --------------------------------------------------------------------------------------------- config

export interface AuthConfig {
  /** Expected origin, e.g. https://genclass.dev (AUTH_ORIGIN). */
  origin: string;
  /** WebAuthn RP ID, e.g. genclass.dev (AUTH_RP_ID). */
  rpId: string;
  /** Secure cookies everywhere except plain-HTTP localhost in development. */
  secure: boolean;
  google: boolean;
  github: boolean;
}

export function authConfig(env: Env): AuthConfig {
  const origin = (env.AUTH_ORIGIN || "https://genclass.dev").replace(/\/+$/, "");
  return {
    origin,
    rpId: env.AUTH_RP_ID || "genclass.dev",
    secure: !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin),
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}

interface C {
  req: Request;
  url: URL;
  env: Env;
  db: D1Like;
  opts: HandleOptions;
  now: Date;
  cfg: AuthConfig;
  /** authenticate() result, memoised per request */
  auth?: Auth | null;
}

// --------------------------------------------------------------------------------------------- small helpers

const randomSecret = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

function newUserCode(): string {
  let s = "";
  while (s.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && s.length < 8) s += USER_CODE_ALPHABET[b % 20];
    }
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** "abcd efgh", "ABCD-EFGH" and "abcdefgh" all become "ABCD-EFGH"; anything else is null. */
export function normalizeUserCode(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 32) return null;
  const s = v.toUpperCase().replace(/[^A-Z]/g, "");
  if (s.length !== 8) return null;
  const code = `${s.slice(0, 4)}-${s.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

/** A plausible email as typed (trimmed), or null. Never verified here. */
export function cleanEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 3 || s.length > 254) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f<>()[\]\\,;:"]/.test(s)) return null;
  return /^[^@]+@[^@]+\.[^@.]+$/.test(s) ? s : null;
}

/** Only same-site paths under /account or /login/device may be a `next` target. */
export function safeNext(v: string | null | undefined): string | null {
  if (!v || v.length > 300 || !v.startsWith("/") || v.startsWith("//") || /[\\\u0000-\u001f]/.test(v)) return null;
  return /^\/(account(\/[A-Za-z0-9/]*)?([?#].*)?|login\/device(\?code=[A-Za-z-]{0,12})?)$/.test(v) ? v : null;
}

function fail(status: number, error: string, headers: Record<string, string> = {}): Response {
  return json(status, { ok: false, error }, headers);
}

function withCookies(res: Response, cookies: string[]): Response {
  for (const k of cookies) res.headers.append("set-cookie", k);
  return res;
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  return withCookies(new Response(null, { status, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } }), cookies);
}

function page(status: number, render: (nonce: string) => string, cookies: string[] = []): Response {
  const nonce = randomBase62(22);
  return withCookies(new Response(render(nonce), { status, headers: securityHeaders(nonce, {}, { formSelf: true }) }), cookies);
}

function setCookie(c: C, name: string, value: string, maxAgeS: number, path = "/"): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${c.cfg.secure ? "; Secure" : ""}`;
}
const clearCookie = (c: C, name: string, path = "/"): string => setCookie(c, name, "", 0, path);

export function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie");
  if (!h) return null;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const originOk = (c: C): boolean => c.req.headers.get("origin") === c.cfg.origin;
const csrfFail = (): Response => fail(403, "cross-origin request refused");

/** Parse a JSON object body (Content-Type application/json, at most `cap` bytes; empty means {}). */
async function readJson(c: C, cap = 16 * 1024): Promise<Record<string, unknown> | Response> {
  if (mediaType(c.req) !== "application/json") return fail(415, "content-type must be application/json");
  const raw = await readCapped(c.req, cap);
  if (raw === null) return fail(413, "body too large");
  const text = new TextDecoder().decode(raw).trim();
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return fail(400, "body must be a JSON object");
}

/** True when this client is over its budget for `bucket` (AUTH_LIMIT, keyed by a hash of route + IP). */
async function overLimit(c: C, bucket: string): Promise<boolean> {
  const lim = c.env.AUTH_LIMIT;
  if (!lim) return false;
  const ip = c.req.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    return !(await lim.limit({ key: (await sha256Hex(`auth:${bucket}:${ip}`)).slice(0, 32) })).success;
  } catch {
    return false; // the limiter is best effort
  }
}

const tooMany = (): Response => fail(429, "too many attempts from your network; try again in a minute", { "retry-after": "60" });

// --------------------------------------------------------------------------------------------- accounts, sessions

export interface Account {
  id: string;
  email: string | null;
  email_verified: number;
  google_sub: string | null;
  github_id: string | null;
  github_login: string | null;
  created: string;
}

interface Auth {
  account: Account;
  sessionId: string;
  via: "cookie" | "bearer";
}

const ACCOUNT_COLUMNS = "a.id, a.email, a.email_verified, a.google_sub, a.github_id, a.github_login, a.created";

/** The signed-in account: a CLI bearer token when an Authorization header is present, else the web session cookie. */
async function authenticate(c: C): Promise<Auth | null> {
  if (c.auth !== undefined) return c.auth;
  c.auth = null;
  const h = c.req.headers.get("authorization");
  let secret: string;
  let kind: "web" | "cli";
  if (h !== null) {
    const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
    if (!m || !CLI_TOKEN_RE.test(m[1]!)) return null;
    secret = m[1]!;
    kind = "cli";
  } else {
    const v = getCookie(c.req, SESSION_COOKIE);
    if (!v || !SECRET43_RE.test(v)) return null;
    secret = v;
    kind = "web";
  }
  const row = await c.db
    .prepare(
      `SELECT s.id AS sid, s.last_used AS slu, ${ACCOUNT_COLUMNS} FROM auth_sessions s JOIN accounts a ON a.id = s.account_id ` +
        "WHERE s.hash = ? AND s.kind = ? AND s.revoked IS NULL AND s.expires > ?",
    )
    .bind(await sha256Hex(secret), kind, c.now.toISOString())
    .first<Account & { sid: string; slu: string | null }>();
  if (!row) return null;
  if (!row.slu || Date.parse(row.slu) < c.now.getTime() - 10 * MINUTE) {
    try {
      await c.db.prepare("UPDATE auth_sessions SET last_used = ? WHERE id = ?").bind(c.now.toISOString(), row.sid).run();
    } catch {
      /* best effort */
    }
  }
  const { sid, slu: _slu, ...account } = row;
  c.auth = { account, sessionId: sid, via: kind === "cli" ? "bearer" : "cookie" };
  return c.auth;
}

async function webSession(c: C): Promise<Auth | null> {
  const a = await authenticate(c);
  return a && a.via === "cookie" ? a : null;
}

async function createSession(c: C, accountId: string, kind: "web" | "cli", label: string | null): Promise<{ id: string; secret: string; expires: string }> {
  const raw = randomSecret(32);
  const secret = kind === "cli" ? `gcs_${raw}` : raw;
  const id = randomBase62(16);
  const expires = new Date(c.now.getTime() + (kind === "cli" ? CLI_SESSION_MS : WEB_SESSION_MS)).toISOString();
  await c.db
    .prepare("INSERT INTO auth_sessions (id, hash, account_id, kind, created, expires, label, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(secret), accountId, kind, c.now.toISOString(), expires, label, c.now.toISOString())
    .run();
  return { id, secret, expires };
}

const sessionCookie = (c: C, secret: string): string => setCookie(c, SESSION_COOKIE, secret, WEB_SESSION_MS / 1000);

async function accountById(c: C, id: string): Promise<Account | null> {
  return c.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ?`).bind(id).first<Account>();
}

export const accountJson = (a: Account): { id: string; email: string | null; github_login: string | null } => ({
  id: a.id,
  email: a.email,
  github_login: a.github_login,
});

export interface ProjectJson {
  id: string;
  name: string;
  token: string;
  dashboard_url: string;
  created: string;
  last_event: string | null;
  first_event: string | null;
}

function projectJson(c: C, p: Project): ProjectJson {
  return {
    id: p.id ?? "",
    name: p.name,
    token: p.token,
    dashboard_url: `${c.cfg.origin}/account/apps/${p.id}`,
    created: p.created,
    last_event: p.last_event,
    first_event: p.first_event,
  };
}

async function accountProjects(c: C, accountId: string): Promise<Project[]> {
  const r = await c.db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE account_id = ? AND id IS NOT NULL ORDER BY name COLLATE NOCASE, created`)
    .bind(accountId)
    .all<Project>();
  return r.results ?? [];
}

async function ownedProject(c: C, accountId: string, id: string): Promise<Project | null> {
  if (!PROJECT_ID_RE.test(id)) return null;
  return c.db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? AND account_id = ?`).bind(id, accountId).first<Project>();
}

// --------------------------------------------------------------------------------------------- challenges

async function putChallenge(c: C, kind: string, accountId: string | null, data: unknown, ttlMs: number): Promise<{ id: string; challenge: string }> {
  const id = randomBase62(22);
  const challenge = randomSecret(32);
  await c.db
    .prepare("INSERT INTO challenges (id, kind, challenge, account_id, data, expires) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, kind, challenge, accountId, data === null ? null : JSON.stringify(data), new Date(c.now.getTime() + ttlMs).toISOString())
    .run();
  return { id, challenge };
}

/** Take (delete and return) a challenge: single use. Expired rows are deleted too, and reported as missing. */
async function takeChallenge(c: C, id: unknown, kind: string): Promise<{ challenge: string; account_id: string | null; data: Record<string, unknown> } | null> {
  if (typeof id !== "string" || !ID22_RE.test(id)) return null;
  const row = await c.db
    .prepare("DELETE FROM challenges WHERE id = ? AND kind = ? RETURNING challenge, account_id, data, expires")
    .bind(id, kind)
    .first<{ challenge: string; account_id: string | null; data: string | null; expires: string }>();
  if (!row || Date.parse(row.expires) <= c.now.getTime()) return null;
  let data: Record<string, unknown> = {};
  try {
    data = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  } catch {
    /* treat as empty */
  }
  return { challenge: row.challenge, account_id: row.account_id, data };
}

const expected = (c: C, challenge: string): Expected => ({ challenge, origin: c.cfg.origin, rpId: c.cfg.rpId, requireUserVerification: true });

function transportsJson(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const t = [...new Set(v.filter((x): x is string => typeof x === "string" && TRANSPORTS.has(x)))].slice(0, 6);
  return t.length ? JSON.stringify(t) : null;
}

// --------------------------------------------------------------------------------------------- passkeys

function userName(a: Account): string {
  if (a.email) return a.email;
  if (a.github_login) return `${a.github_login} (GitHub)`;
  return `GenClass account ${a.id.slice(0, 6)}`;
}

async function passkeyRegisterOptions(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  const session = await webSession(c);
  let accountId: string;
  let name: string;
  let data: Record<string, unknown>;
  let exclude: string[] = [];
  if (session) {
    // a signed-in account adds another passkey
    accountId = session.account.id;
    name = userName(session.account);
    data = { add: true };
    const r = await c.db.prepare("SELECT id FROM credentials WHERE account_id = ?").bind(accountId).all<{ id: string }>();
    exclude = (r.results ?? []).map((x) => x.id);
  } else {
    if (await overLimit(c, "signup")) return tooMany();
    const email = cleanEmail(body.email);
    if (!email) return fail(400, "enter a valid email address");
    accountId = randomBase62(22);
    name = email;
    data = { email };
  }
  const ch = await putChallenge(c, "register", accountId, data, CHALLENGE_MS);
  return json(200, {
    id: ch.id,
    publicKey: {
      rp: { id: c.cfg.rpId, name: "GenClass" },
      user: { id: b64url(new TextEncoder().encode(accountId)), name, displayName: name },
      challenge: ch.challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: ES256 },
        { type: "public-key", alg: RS256 },
      ],
      timeout: CHALLENGE_MS,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
    },
  });
}

function credentialParts(body: Record<string, unknown>): { cred: Record<string, unknown>; resp: Record<string, unknown> } | null {
  const cred = body.credential;
  if (!cred || typeof cred !== "object" || Array.isArray(cred)) return null;
  const resp = (cred as Record<string, unknown>).response;
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return null;
  if ((cred as Record<string, unknown>).type !== "public-key") return null;
  return { cred: cred as Record<string, unknown>, resp: resp as Record<string, unknown> };
}

async function passkeyRegisterVerify(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 96 * 1024);
  if (body instanceof Response) return body;
  const ch = await takeChallenge(c, body.id, "register");
  if (!ch || !ch.account_id) return fail(400, "this passkey request expired; start again");
  const parts = credentialParts(body);
  if (!parts) return fail(400, "missing passkey credential");
  let v;
  try {
    v = await verifyRegistration({ rawId: parts.cred.rawId, clientDataJSON: parts.resp.clientDataJSON, attestationObject: parts.resp.attestationObject }, expected(c, ch.challenge));
  } catch (e) {
    if (e instanceof WebAuthnError) return fail(400, `passkey not accepted: ${e.message}`);
    throw e;
  }
  const iso = c.now.toISOString();
  const insertCred = c.db
    .prepare("INSERT INTO credentials (id, account_id, public_key, alg, sign_count, transports, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(v.credentialId, ch.account_id, b64url(v.publicKey), v.alg, v.signCount, transportsJson(parts.resp.transports), iso);
  if (await c.db.prepare("SELECT 1 AS x FROM credentials WHERE id = ?").bind(v.credentialId).first()) {
    return fail(409, "this passkey is already registered; sign in with it instead");
  }
  if (ch.data.add === true) {
    const session = await webSession(c);
    if (!session || session.account.id !== ch.account_id) return fail(403, "sign in again to add a passkey");
    await insertCred.run();
    return json(200, { ok: true, account: accountJson(session.account) });
  }
  const email = cleanEmail(ch.data.email);
  await c.db.batch([
    c.db.prepare("INSERT INTO accounts (id, email, email_verified, created) VALUES (?, ?, 0, ?)").bind(ch.account_id, email, iso),
    insertCred,
  ]);
  const s = await createSession(c, ch.account_id, "web", null);
  return withCookies(json(200, { ok: true, account: { id: ch.account_id, email, github_login: null } }), [sessionCookie(c, s.secret)]);
}

async function passkeyLoginOptions(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (await overLimit(c, "login")) return tooMany();
  const ch = await putChallenge(c, "login", null, null, CHALLENGE_MS);
  return json(200, { id: ch.id, publicKey: { challenge: ch.challenge, rpId: c.cfg.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: [] } });
}

async function passkeyLoginVerify(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 32 * 1024);
  if (body instanceof Response) return body;
  const ch = await takeChallenge(c, body.id, "login");
  if (!ch) return fail(400, "this sign-in request expired; start again");
  const parts = credentialParts(body);
  if (!parts) return fail(400, "missing passkey credential");
  let credId: string;
  let userHandle: string | null = null;
  try {
    credId = b64url(fromB64url(parts.cred.rawId, "rawId"));
    if (typeof parts.resp.userHandle === "string" && parts.resp.userHandle) {
      userHandle = new TextDecoder().decode(fromB64url(parts.resp.userHandle, "userHandle"));
    }
  } catch (e) {
    if (e instanceof WebAuthnError) return fail(400, `passkey not accepted: ${e.message}`);
    throw e;
  }
  if (!CREDENTIAL_ID_RE.test(credId)) return fail(400, "passkey not accepted: bad credential id");
  const row = await c.db
    .prepare("SELECT account_id, public_key, alg, sign_count FROM credentials WHERE id = ?")
    .bind(credId)
    .first<{ account_id: string; public_key: string; alg: number; sign_count: number }>();
  if (!row) return fail(400, "this passkey is not registered with GenClass; create an account first");
  if (userHandle !== null && userHandle !== row.account_id) return fail(400, "passkey not accepted: user handle does not match");
  let v;
  try {
    v = await verifyAssertion(
      { clientDataJSON: parts.resp.clientDataJSON, authenticatorData: parts.resp.authenticatorData, signature: parts.resp.signature },
      expected(c, ch.challenge),
      { publicKey: fromB64url(row.public_key), alg: Number(row.alg), signCount: Number(row.sign_count) },
    );
  } catch (e) {
    if (e instanceof WebAuthnError) return fail(400, `passkey not accepted: ${e.message}`);
    throw e;
  }
  // Conditional on the counter we checked, so two concurrent sign-ins with the same counter cannot both pass.
  const upd = await c.db
    .prepare("UPDATE credentials SET sign_count = ?, last_used = ? WHERE id = ? AND sign_count = ? RETURNING id")
    .bind(v.signCount, c.now.toISOString(), credId, row.sign_count)
    .first();
  if (!upd) return fail(409, "passkey was used twice at once; sign in again");
  const account = await accountById(c, row.account_id);
  if (!account) return fail(400, "this passkey's account no longer exists");
  const s = await createSession(c, account.id, "web", null);
  return withCookies(json(200, { ok: true, account: accountJson(account) }), [sessionCookie(c, s.secret)]);
}

// --------------------------------------------------------------------------------------------- Google, GitHub

interface Identity {
  provider: "google" | "github";
  /** Google `sub` or GitHub numeric id (as text) */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  login: string | null;
}

interface OAuthState {
  s: string;
  n?: string;
  v?: string;
  next: string | null;
  /** account id when this flow links the provider to a signed-in account */
  link: string | null;
}

function readOAuthCookie(c: C, name: string): OAuthState | null {
  const v = getCookie(c.req, name);
  if (!v || v.length > 2048) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(fromB64url(v))) as Record<string, unknown>;
    if (typeof o.s !== "string" || !SECRET43_RE.test(o.s)) return null;
    return {
      s: o.s,
      n: typeof o.n === "string" ? o.n : undefined,
      v: typeof o.v === "string" ? o.v : undefined,
      next: typeof o.next === "string" ? safeNext(o.next) : null,
      link: typeof o.link === "string" && ID22_RE.test(o.link) ? o.link : null,
    };
  } catch {
    return null;
  }
}

/** Shared start of both flows: who is linking, where to go afterwards. A Response when the flow should not start. */
async function oauthStart(c: C): Promise<{ next: string | null; link: string | null } | Response> {
  const next = safeNext(c.url.searchParams.get("next"));
  const session = await webSession(c);
  if (c.url.searchParams.get("link") === "1") {
    if (!session) return redirect(`/login?next=${encodeURIComponent("/account")}`);
    return { next: "/account", link: session.account.id };
  }
  if (session) return redirect(next ?? "/account");
  return { next, link: null };
}

const encodeState = (o: OAuthState): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function googleStart(c: C): Promise<Response> {
  if (!c.cfg.google) return page(404, (n) => messagePage(n, { title: "Google sign-in is not set up", text: "This GenClass server has no Google client configured. Sign in with a passkey instead.", links: [["Sign in", "/login"]] }));
  const st = await oauthStart(c);
  if (st instanceof Response) return st;
  const state = randomSecret(32);
  const nonce = randomSecret(32);
  const verifier = randomSecret(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${c.cfg.origin}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  const cookie = setCookie(c, GOOGLE_COOKIE, encodeState({ s: state, n: nonce, v: verifier, ...st }), OAUTH_MS / 1000, "/auth/google");
  return redirect(`${GOOGLE_AUTH_URL}?${q}`, [cookie]);
}

/** Decode a JWT's payload without checking the signature (only for an id_token from a direct TLS token response). */
function jwtPayload(t: unknown): Record<string, unknown> | null {
  if (typeof t !== "string" || t.length > 16 * 1024) return null;
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    const o: unknown = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Check a Google id_token's claims. OIDC Core 3.1.3.7 lets a confidential client that received the token directly from
 * the token endpoint over TLS skip the signature check; the claims are still checked here. Returns an error or null.
 */
export function checkGoogleClaims(claims: Record<string, unknown> | null, clientId: string, nonce: string, now: Date): string | null {
  if (!claims) return "no id_token";
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) return "wrong issuer";
  const aud = claims.aud;
  const audOk = aud === clientId || (Array.isArray(aud) && aud.includes(clientId) && claims.azp === clientId);
  if (!audOk) return "wrong audience";
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return "expired";
  if (typeof claims.nonce !== "string" || !equalStrings(claims.nonce, nonce)) return "nonce does not match";
  if (typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(claims.sub)) return "no subject";
  return null;
}

async function googleCallback(c: C): Promise<Response> {
  const clear = clearCookie(c, GOOGLE_COOKIE, "/auth/google");
  const done = (r: Response): Response => withCookies(r, [clear]);
  const bad = (status: number, text: string): Response =>
    done(page(status, (n) => messagePage(n, { title: "Google sign-in did not finish", text, links: [["Try again", "/login"]] })));
  if (!c.cfg.google) return bad(404, "This GenClass server has no Google client configured.");
  if (c.url.searchParams.get("error")) return done(redirect("/login?error=google"));
  const st = readOAuthCookie(c, GOOGLE_COOKIE);
  const state = c.url.searchParams.get("state");
  if (!st || !st.n || !st.v || !state || !equalStrings(state, st.s)) {
    return bad(400, "This sign-in link expired or was opened in another browser. Start again from the sign-in page.");
  }
  const code = c.url.searchParams.get("code");
  if (!code || code.length > 2048) return bad(400, "Google did not send a sign-in code. Start again.");
  const f = c.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  let tok: Record<string, unknown>;
  try {
    const r = await f(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID!,
        client_secret: c.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${c.cfg.origin}/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: st.v,
      }).toString(),
    });
    if (!r.ok) throw new Error(`token endpoint ${r.status}`);
    tok = (await r.json()) as Record<string, unknown>;
  } catch {
    return bad(502, "Google did not accept the sign-in code. Start again.");
  }
  const claims = jwtPayload(tok.id_token);
  const err = checkGoogleClaims(claims, c.env.GOOGLE_CLIENT_ID!, st.n, c.now);
  if (err || !claims) return bad(400, `Google's answer did not pass our checks (${err ?? "no id_token"}). Start again.`);
  const email = cleanEmail(claims.email);
  const ident: Identity = {
    provider: "google",
    sub: claims.sub as string,
    email,
    emailVerified: !!email && (claims.email_verified === true || claims.email_verified === "true"),
    login: null,
  };
  return done(await finishProvider(c, ident, st));
}

async function githubStart(c: C): Promise<Response> {
  if (!c.cfg.github) return page(404, (n) => messagePage(n, { title: "GitHub sign-in is not set up", text: "This GenClass server has no GitHub app configured. Sign in with a passkey instead.", links: [["Sign in", "/login"]] }));
  const st = await oauthStart(c);
  if (st instanceof Response) return st;
  const state = randomSecret(32);
  const q = new URLSearchParams({ client_id: c.env.GITHUB_CLIENT_ID!, redirect_uri: `${c.cfg.origin}/auth/github/callback`, state, allow_signup: "true" });
  const cookie = setCookie(c, GITHUB_COOKIE, encodeState({ s: state, ...st }), OAUTH_MS / 1000, "/auth/github");
  return redirect(`${GITHUB_AUTH_URL}?${q}`, [cookie]);
}

async function githubCallback(c: C): Promise<Response> {
  const clear = clearCookie(c, GITHUB_COOKIE, "/auth/github");
  const done = (r: Response): Response => withCookies(r, [clear]);
  const bad = (status: number, text: string): Response =>
    done(page(status, (n) => messagePage(n, { title: "GitHub sign-in did not finish", text, links: [["Try again", "/login"]] })));
  if (!c.cfg.github) return bad(404, "This GenClass server has no GitHub app configured.");
  if (c.url.searchParams.get("error")) return done(redirect("/login?error=github"));
  const st = readOAuthCookie(c, GITHUB_COOKIE);
  const state = c.url.searchParams.get("state");
  if (!st || !state || !equalStrings(state, st.s)) {
    return bad(400, "This sign-in link expired or was opened in another browser. Start again from the sign-in page.");
  }
  const code = c.url.searchParams.get("code");
  if (!code || code.length > 2048) return bad(400, "GitHub did not send a sign-in code. Start again.");
  const f = c.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  let user: Record<string, unknown>;
  try {
    const r = await f(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "genclass.dev" },
      body: new URLSearchParams({ client_id: c.env.GITHUB_CLIENT_ID!, client_secret: c.env.GITHUB_CLIENT_SECRET!, code, redirect_uri: `${c.cfg.origin}/auth/github/callback` }).toString(),
    });
    const tok = (await r.json()) as Record<string, unknown>;
    if (!r.ok || typeof tok.access_token !== "string") throw new Error("no access token");
    const u = await f(GITHUB_USER_URL, {
      headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "genclass.dev", "x-github-api-version": "2022-11-28" },
    });
    if (!u.ok) throw new Error(`user ${u.status}`);
    user = (await u.json()) as Record<string, unknown>;
  } catch {
    return bad(502, "GitHub did not accept the sign-in code. Start again.");
  }
  const id = user.id;
  const login = typeof user.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || !login) return bad(400, "GitHub's answer did not pass our checks. Start again.");
  return done(await finishProvider(c, { provider: "github", sub: String(id), email: null, emailVerified: false, login }, st));
}

/** After Google or GitHub vouched for an identity: link it, sign in to its account, or create one (see the header). */
async function finishProvider(c: C, ident: Identity, st: OAuthState): Promise<Response> {
  const col = ident.provider === "google" ? "google_sub" : "github_id";
  const owner = await c.db.prepare(`SELECT id FROM accounts WHERE ${col} = ?`).bind(ident.sub).first<{ id: string }>();
  if (st.link) {
    const session = await webSession(c);
    if (!session || session.account.id !== st.link) {
      return page(403, (n) => messagePage(n, { title: "Sign in again to link", text: "Your session changed while you were away. Sign in, then choose Link on your account page again.", links: [["Sign in", "/login?next=%2Faccount"]] }));
    }
    if (owner && owner.id !== session.account.id) return redirect(`/account?error=${ident.provider}_taken`);
    if (ident.provider === "google") {
      await c.db.prepare("UPDATE accounts SET google_sub = ? WHERE id = ?").bind(ident.sub, session.account.id).run();
    } else {
      await c.db.prepare("UPDATE accounts SET github_id = ?, github_login = ? WHERE id = ?").bind(ident.sub, ident.login, session.account.id).run();
    }
    return redirect(`/account?linked=${ident.provider}`);
  }
  if (owner) {
    if (ident.provider === "github") await c.db.prepare("UPDATE accounts SET github_login = ? WHERE id = ?").bind(ident.login, owner.id).run();
    const s = await createSession(c, owner.id, "web", null);
    return redirect(st.next ?? "/account", [sessionCookie(c, s.secret)]);
  }
  // A new identity. If another account already uses this email, ask first: never attach on an email match.
  if (ident.email) {
    const same = await c.db.prepare("SELECT 1 AS x FROM accounts WHERE lower(email) = lower(?) LIMIT 1").bind(ident.email).first();
    if (same) {
      const p = await putChallenge(c, "pending", null, { ...ident, next: st.next }, OAUTH_MS);
      return page(200, (n) => pendingPage(n, { email: ident.email!, provider: ident.provider }), [setCookie(c, PENDING_COOKIE, p.id, OAUTH_MS / 1000)]);
    }
  }
  const id = await createProviderAccount(c, ident);
  const s = await createSession(c, id, "web", null);
  return redirect(st.next ?? "/account?welcome=1", [sessionCookie(c, s.secret)]);
}

async function createProviderAccount(c: C, ident: Identity): Promise<string> {
  const id = randomBase62(22);
  await c.db
    .prepare("INSERT INTO accounts (id, email, email_verified, google_sub, github_id, github_login, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(
      id,
      ident.email,
      ident.emailVerified ? 1 : 0,
      ident.provider === "google" ? ident.sub : null,
      ident.provider === "github" ? ident.sub : null,
      ident.provider === "github" ? ident.login : null,
      c.now.toISOString(),
    )
    .run();
  return id;
}

/** POST /api/auth/pending: the person chose "Create a separate account" on the email-collision page. */
async function confirmPending(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  const clear = clearCookie(c, PENDING_COOKIE);
  const ch = await takeChallenge(c, getCookie(c.req, PENDING_COOKIE), "pending");
  if (!ch) return withCookies(fail(400, "this sign-in expired; start again"), [clear]);
  const d = ch.data;
  if ((d.provider !== "google" && d.provider !== "github") || typeof d.sub !== "string") return withCookies(fail(400, "this sign-in expired; start again"), [clear]);
  const ident: Identity = { provider: d.provider, sub: d.sub, email: cleanEmail(d.email), emailVerified: d.emailVerified === true, login: typeof d.login === "string" ? d.login : null };
  const col = ident.provider === "google" ? "google_sub" : "github_id";
  const owner = await c.db.prepare(`SELECT id FROM accounts WHERE ${col} = ?`).bind(ident.sub).first<{ id: string }>();
  const id = owner ? owner.id : await createProviderAccount(c, ident);
  const s = await createSession(c, id, "web", null);
  const next = safeNext(typeof d.next === "string" ? d.next : null) ?? "/account?welcome=1";
  return withCookies(json(200, { ok: true, next }), [clear, sessionCookie(c, s.secret)]);
}

// --------------------------------------------------------------------------------------------- device flow

function deviceError(error: string, description: string, extra: Record<string, unknown> = {}): Response {
  return json(400, { error, error_description: description, ...extra });
}

/** Body of a device-flow request: JSON, a form (RFC 8628 clients), or empty. */
async function readLoose(c: C): Promise<Record<string, unknown> | Response> {
  const mt = mediaType(c.req);
  if (mt === "application/x-www-form-urlencoded") {
    const raw = await readCapped(c.req, 4096);
    if (raw === null) return fail(413, "body too large");
    return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(raw)));
  }
  if (mt === "" || mt === "text/plain") {
    const raw = await readCapped(c.req, 4096);
    if (raw === null) return fail(413, "body too large");
    if (new TextDecoder().decode(raw).trim() === "") return {};
    return fail(415, "content-type must be application/json");
  }
  return readJson(c, 4096);
}

async function deviceCode(c: C): Promise<Response> {
  const body = await readLoose(c);
  if (body instanceof Response) return body;
  if (await overLimit(c, "device")) return tooMany();
  const client = typeof body.client_name === "string" && body.client_name.trim() ? sanitizeName(body.client_name).slice(0, 60) : null;
  const device = randomSecret(32);
  const hash = await sha256Hex(device);
  const iso = c.now.toISOString();
  const expires = new Date(c.now.getTime() + DEVICE_CODE_MS).toISOString();
  for (let attempt = 0; ; attempt++) {
    const user = newUserCode();
    try {
      await c.db.batch([
        c.db.prepare("DELETE FROM device_codes WHERE user_code = ? AND expires <= ?").bind(user, iso),
        c.db
          .prepare("INSERT INTO device_codes (hash, user_code, status, client, created, expires, poll_interval) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
          .bind(hash, user, client, iso, expires, DEVICE_INTERVAL_S),
      ]);
      const uri = `${c.cfg.origin}/login/device`;
      return json(200, {
        device_code: device,
        user_code: user,
        verification_uri: uri,
        verification_uri_complete: `${uri}?code=${user}`,
        expires_in: DEVICE_CODE_MS / 1000,
        interval: DEVICE_INTERVAL_S,
      });
    } catch (e) {
      if (attempt >= 4) throw e; // a live user code collided five times: not plausible, so a real error
    }
  }
}

interface DeviceRow {
  hash: string;
  user_code: string;
  account_id: string | null;
  status: "pending" | "approved" | "denied";
  client: string | null;
  created: string;
  expires: string;
  last_poll: string | null;
  poll_interval: number;
}

async function deviceToken(c: C): Promise<Response> {
  const body = await readLoose(c);
  if (body instanceof Response) return body;
  const dc = body.device_code;
  if (typeof dc !== "string" || !SECRET43_RE.test(dc)) return deviceError("invalid_request", "device_code is missing or malformed");
  const hash = await sha256Hex(dc);
  const row = await c.db.prepare("SELECT * FROM device_codes WHERE hash = ?").bind(hash).first<DeviceRow>();
  const nowMs = c.now.getTime();
  if (!row) return deviceError("expired_token", "this code has expired; run the command again");
  if (Date.parse(row.expires) <= nowMs) {
    await c.db.prepare("DELETE FROM device_codes WHERE hash = ?").bind(hash).run();
    return deviceError("expired_token", "this code has expired; run the command again");
  }
  const interval = Number(row.poll_interval) || DEVICE_INTERVAL_S;
  // Polling faster than the interval (1 s of slack for network jitter), or over the per-network budget: slow_down,
  // and the interval grows by 5 s for every later request (RFC 8628 section 3.5).
  const early = row.last_poll !== null && nowMs - Date.parse(row.last_poll) < interval * 1000 - 1000;
  if (early || (await overLimit(c, "poll"))) {
    const next = Math.min(interval + 5, 60);
    await c.db.prepare("UPDATE device_codes SET poll_interval = ?, last_poll = ? WHERE hash = ?").bind(next, c.now.toISOString(), hash).run();
    return deviceError("slow_down", `poll at most every ${next} seconds`, { interval: next });
  }
  if (row.status === "pending") {
    await c.db.prepare("UPDATE device_codes SET last_poll = ? WHERE hash = ?").bind(c.now.toISOString(), hash).run();
    return deviceError("authorization_pending", "waiting for approval at the verification link");
  }
  if (row.status === "denied") {
    await c.db.prepare("DELETE FROM device_codes WHERE hash = ?").bind(hash).run();
    return deviceError("access_denied", "the request was denied in the browser");
  }
  // approved: consume the code exactly once
  const taken = await c.db
    .prepare("DELETE FROM device_codes WHERE hash = ? AND status = 'approved' RETURNING account_id, client")
    .bind(hash)
    .first<{ account_id: string | null; client: string | null }>();
  const account = taken?.account_id ? await accountById(c, taken.account_id) : null;
  if (!account) return deviceError("expired_token", "this code has expired; run the command again");
  const s = await createSession(c, account.id, "cli", taken!.client ?? "Command line");
  return json(200, { access_token: s.secret, token_type: "Bearer", expires_in: CLI_SESSION_MS / 1000, account: accountJson(account) });
}

async function deviceApprove(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  const session = await webSession(c);
  if (!session) return fail(401, "sign in first");
  if (await overLimit(c, "approve")) return tooMany();
  const code = normalizeUserCode(body.user_code);
  if (!code) return fail(400, "enter the 8-letter code your terminal shows");
  const approve = body.approve === true || body.action === "approve";
  const deny = body.approve === false || body.action === "deny";
  if (approve === deny) return fail(400, "say whether to approve or deny");
  const r = await c.db
    .prepare("UPDATE device_codes SET status = ?, account_id = ? WHERE user_code = ? AND status = 'pending' AND expires > ? RETURNING user_code")
    .bind(approve ? "approved" : "denied", session.account.id, code, c.now.toISOString())
    .first();
  if (!r) return fail(404, "this code has expired or was already used; run the command again for a new one");
  return json(200, { ok: true, status: approve ? "approved" : "denied" });
}

// --------------------------------------------------------------------------------------------- account API

const signedOut = (): Response => fail(401, "not signed in");

/** For a write: the session, or a Response (401, or 403 for a cookie write without our Origin). */
async function writer(c: C): Promise<Auth | Response> {
  const a = await authenticate(c);
  if (!a) return signedOut();
  if (a.via === "cookie" && !originOk(c)) return csrfFail();
  return a;
}

export function secretFromLink(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  const s = v.trim();
  if (SECRET_RE.test(s)) return s;
  const m = /^(?:https?:\/\/[^/\s]+)?\/dashboard\/([A-Za-z0-9]{32})\/?(?:[?#]\S*)?$/.exec(s);
  return m ? m[1]! : null;
}

async function createAccountProject(c: C): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const n = await c.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE account_id = ?").bind(a.account.id).first<{ n: number }>();
  if (Number(n?.n ?? 0) >= MAX_APPS_PER_ACCOUNT) return fail(409, `an account can hold at most ${MAX_APPS_PER_ACCOUNT} apps`);
  if (c.env.CREATE_LIMITER) {
    const { success } = await c.env.CREATE_LIMITER.limit({ key: (await sha256Hex(`create:account:${a.account.id}`)).slice(0, 32) });
    if (!success) return fail(429, "too many apps created; try again in a minute", { "retry-after": "60" });
  }
  if ((await projectsCreatedSince(c.db, new Date(c.now.getTime() - MINUTE))) >= MAX_PROJECTS_PER_MINUTE) {
    return fail(429, "too many apps created; try again in a minute", { "retry-after": "60" });
  }
  const p = await createProject(c.db, sanitizeName(body.name), c.now, a.account.id);
  const project = await ownedProject(c, a.account.id, p.id);
  return json(201, { project: projectJson(c, project!) });
}

async function claimProject(c: C): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const secret = secretFromLink(body.dashboard_url ?? body.secret);
  if (!secret) return fail(400, "paste a dashboard link like https://genclass.dev/dashboard/...");
  const p = await projectBySecret(c.db, secret);
  if (!p) return fail(404, "no dashboard matches this link");
  if (p.account_id && p.account_id !== a.account.id) return fail(409, "this app already belongs to another account");
  if (!p.account_id || !p.id) {
    await c.db
      .prepare("UPDATE projects SET account_id = ?, id = COALESCE(id, ?) WHERE token = ? AND (account_id IS NULL OR account_id = ?)")
      .bind(a.account.id, newProjectId(), p.token, a.account.id)
      .run();
  }
  const owned = await c.db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE token = ? AND account_id = ?`).bind(p.token, a.account.id).first<Project>();
  if (!owned) return fail(409, "this app already belongs to another account");
  return json(200, { project: projectJson(c, owned) });
}

async function revokeSession(c: C, id: string): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  const iso = c.now.toISOString();
  if (id === "current") {
    await c.db.prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(iso, a.sessionId).run();
    const res = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return a.via === "cookie" ? withCookies(res, [clearCookie(c, SESSION_COOKIE)]) : res;
  }
  if (!SESSION_ID_RE.test(id)) return fail(404, "no such session");
  const r = await c.db
    .prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND account_id = ? AND revoked IS NULL RETURNING id")
    .bind(iso, id, a.account.id)
    .first();
  if (!r) return fail(404, "no such session");
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function removeCredential(c: C, id: string): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  if (a.via !== "cookie") return fail(403, "passkeys can only be removed in the browser");
  if (!CREDENTIAL_ID_RE.test(id)) return fail(404, "no such passkey");
  const n = await c.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE account_id = ?").bind(a.account.id).first<{ n: number }>();
  const methods = Number(n?.n ?? 0) + (a.account.google_sub ? 1 : 0) + (a.account.github_id ? 1 : 0);
  const mine = await c.db.prepare("SELECT 1 AS x FROM credentials WHERE id = ? AND account_id = ?").bind(id, a.account.id).first();
  if (!mine) return fail(404, "no such passkey");
  if (methods <= 1) return fail(409, "this is your only way to sign in; add another passkey or link Google or GitHub first");
  await c.db.prepare("DELETE FROM credentials WHERE id = ? AND account_id = ?").bind(id, a.account.id).run();
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

async function accountView(c: C, a: Auth): Promise<AccountView> {
  const iso = c.now.toISOString();
  const [creds, cli] = await c.db.batch([
    c.db.prepare("SELECT id, created, last_used, transports FROM credentials WHERE account_id = ? ORDER BY created").bind(a.account.id),
    c.db
      .prepare("SELECT id, label, created, expires, last_used FROM auth_sessions WHERE account_id = ? AND kind = 'cli' AND revoked IS NULL AND expires > ? ORDER BY created DESC")
      .bind(a.account.id, iso),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];
  return {
    account: {
      id: a.account.id,
      email: a.account.email,
      emailVerified: !!a.account.email_verified,
      google: !!a.account.google_sub,
      githubLogin: a.account.github_id ? a.account.github_login : null,
      created: a.account.created,
    },
    projects: (await accountProjects(c, a.account.id)).map((p) => projectJson(c, p)),
    passkeys: rows(creds).map((r) => {
      let transports: string[] = [];
      try {
        transports = r.transports ? (JSON.parse(String(r.transports)) as string[]) : [];
      } catch {
        /* none */
      }
      return { id: String(r.id), created: String(r.created), lastUsed: (r.last_used as string | null) ?? null, transports };
    }),
    cli: rows(cli).map((r) => ({ id: String(r.id), label: String(r.label ?? "Command line"), created: String(r.created), expires: String(r.expires), lastUsed: (r.last_used as string | null) ?? null })),
    providers: { google: c.cfg.google, github: c.cfg.github },
  };
}

// --------------------------------------------------------------------------------------------- routes

const PREFIXES = ["/auth/", "/api/auth/", "/api/device/", "/api/account/", "/account/"];
const EXACT = new Set(["/signup", "/login", "/login/device", "/logout", "/account", "/api/me", "/api/account"]);

/** Account routes. Returns null for paths this module does not own (the caller continues routing). */
export async function routeAuth(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (!EXACT.has(path) && !PREFIXES.some((p) => path.startsWith(p))) return null;
  if (!env.DB) {
    if (path.startsWith("/api/")) return fail(503, "accounts unavailable");
    return page(503, (n) => messagePage(n, { title: "Accounts are unavailable", text: "This GenClass server has no database configured.", links: [] }));
  }
  const c: C = { req: request, url, env, db: env.DB, opts, now: (opts.now ?? (() => new Date()))(), cfg: authConfig(env) };  const m = request.method;
  const get = m === "GET" || m === "HEAD";
  const post = m === "POST";
  const method = (): Response => fail(405, "method not allowed");

  switch (path) {
    case "/signup":
    case "/login": {
      if (!get) return method();
      const next = safeNext(url.searchParams.get("next"));
      if (await webSession(c)) return redirect(next ?? "/account");
      const notice = path === "/login" ? loginNotice(url) : null;
      const o = { google: c.cfg.google, github: c.cfg.github, next, notice };
      return page(200, (n) => (path === "/login" ? loginPage(n, o) : signupPage(n, o)));
    }
    case "/logout": {
      if (get) return redirect("/account");
      if (!post) return method();
      if (!originOk(c)) return csrfFail();
      const a = await webSession(c);
      if (a) await c.db.prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(c.now.toISOString(), a.sessionId).run();
      return redirect("/login?signed_out=1", [clearCookie(c, SESSION_COOKIE)], 303);
    }
    case "/account": {
      if (!get) return method();
      const a = await webSession(c);
      if (!a) return redirect("/login?next=%2Faccount");
      const view = await accountView(c, a);
      view.notice = accountNotice(url);
      return page(200, (n) => accountPage(n, view));
    }
    case "/login/device": {
      if (!get) return method();
      const raw = url.searchParams.get("code");
      const code = raw === null ? null : normalizeUserCode(raw);
      const a = await webSession(c);
      let request: { userCode: string; client: string | null; created: string; expires: string } | null = null;
      if (code) {
        const r = await c.db
          .prepare("SELECT user_code, client, created, expires FROM device_codes WHERE user_code = ? AND status = 'pending' AND expires > ?")
          .bind(code, c.now.toISOString())
          .first<{ user_code: string; client: string | null; created: string; expires: string }>();
        if (r) request = { userCode: r.user_code, client: r.client, created: r.created, expires: r.expires };
      }
      const next = `/login/device${code ? `?code=${code}` : ""}`;
      return page(200, (n) =>
        devicePage(n, {
          signedIn: a ? { email: a.account.email, githubLogin: a.account.github_login } : null,
          code,
          typed: raw !== null,
          request,
          next,
          providers: { google: c.cfg.google, github: c.cfg.github },
        }),
      );
    }
    case "/auth/google":
      return get ? googleStart(c) : method();
    case "/auth/google/callback":
      return get ? googleCallback(c) : method();
    case "/auth/github":
      return get ? githubStart(c) : method();
    case "/auth/github/callback":
      return get ? githubCallback(c) : method();
    case "/api/auth/passkey/register/options":
      return post ? passkeyRegisterOptions(c) : method();
    case "/api/auth/passkey/register/verify":
      return post ? passkeyRegisterVerify(c) : method();
    case "/api/auth/passkey/login/options":
      return post ? passkeyLoginOptions(c) : method();
    case "/api/auth/passkey/login/verify":
      return post ? passkeyLoginVerify(c) : method();
    case "/api/auth/pending":
      return post ? confirmPending(c) : method();
    case "/api/device/code":
      return post ? deviceCode(c) : method();
    case "/api/device/token":
      return post ? deviceToken(c) : method();
    case "/api/device/approve":
      return post ? deviceApprove(c) : method();
    case "/api/me": {
      if (!get) return method();
      const a = await authenticate(c);
      if (!a) return signedOut();
      return json(200, { account: accountJson(a.account), projects: (await accountProjects(c, a.account.id)).map((p) => projectJson(c, p)) });
    }
    case "/api/account/projects": {
      if (get) {
        const a = await authenticate(c);
        if (!a) return signedOut();
        return json(200, { projects: (await accountProjects(c, a.account.id)).map((p) => projectJson(c, p)) });
      }
      return post ? createAccountProject(c) : method();
    }
    case "/api/account/projects/claim":
      return post ? claimProject(c) : method();
  }

  const stat = /^\/api\/account\/projects\/([^/]+)\/stats$/.exec(path);
  if (stat) {
    if (!get) return method();
    const a = await authenticate(c);
    if (!a) return signedOut();
    const p = await ownedProject(c, a.account.id, stat[1]!);
    if (!p) return fail(404, "not found");
    const r = url.searchParams.get("range") as Range | null;
    return json(200, await stats(c.db, p, r && RANGES.includes(r) ? r : "7d", c.now));
  }
  const ses = /^\/api\/account\/sessions\/([^/]+)$/.exec(path);
  if (ses) return m === "DELETE" ? revokeSession(c, ses[1]!) : method();
  const cred = /^\/api\/account\/credentials\/([^/]+)$/.exec(path);
  if (cred) return m === "DELETE" ? removeCredential(c, cred[1]!) : method();

  const app = /^\/account\/apps\/([^/]+)$/.exec(path);
  if (app) {
    if (!get) return method();
    const a = await webSession(c);
    if (!a) return redirect(`/login?next=${encodeURIComponent(`/account/apps/${PROJECT_ID_RE.test(app[1]!) ? app[1] : ""}`)}`);
    const p = await ownedProject(c, a.account.id, app[1]!);
    if (!p) return page(404, (n) => appNotFoundPage(n));
    const apps = (await accountProjects(c, a.account.id)).map((x) => ({ id: x.id!, name: x.name }));
    return page(200, (n) =>
      dashboardPage(
        n,
        { name: p.name, token: p.token, created: p.created, lastEvent: p.last_event },
        { account: { apps, current: p.id!, email: a.account.email ?? a.account.github_login }, id: p.id!, firstEvent: p.first_event },
      ),
    );
  }

  if (path.startsWith("/api/")) return fail(404, "not found");
  return null;
}

function loginNotice(url: URL): string | null {
  if (url.searchParams.get("signed_out") === "1") return "You are signed out.";
  const e = url.searchParams.get("error");
  if (e === "google") return "Google sign-in was cancelled or refused. You can try again, or use a passkey.";
  if (e === "github") return "GitHub sign-in was cancelled or refused. You can try again, or use a passkey.";
  return null;
}

function accountNotice(url: URL): AccountView["notice"] {
  const q = url.searchParams;
  if (q.get("welcome") === "1") return { kind: "ok", text: "Your account is ready. Create an app, or add a dashboard you already have." };
  if (q.get("linked") === "google") return { kind: "ok", text: "Google is linked. You can now sign in with it." };
  if (q.get("linked") === "github") return { kind: "ok", text: "GitHub is linked. You can now sign in with it." };
  if (q.get("error") === "google_taken") return { kind: "bad", text: "That Google account is already linked to another GenClass account, so it was not linked here." };
  if (q.get("error") === "github_taken") return { kind: "bad", text: "That GitHub account is already linked to another GenClass account, so it was not linked here." };
  return undefined;
}

// --------------------------------------------------------------------------------------------- retention

/** Daily: expired challenges and device codes, and expired or revoked sessions. */
export async function authRetention(db: D1Like, now: Date): Promise<void> {
  const iso = now.toISOString();
  await db.batch([
    db.prepare("DELETE FROM challenges WHERE expires < ?").bind(iso),
    db.prepare("DELETE FROM device_codes WHERE expires < ?").bind(iso),
    db.prepare("DELETE FROM auth_sessions WHERE expires < ? OR revoked IS NOT NULL").bind(iso),
  ]);
}
