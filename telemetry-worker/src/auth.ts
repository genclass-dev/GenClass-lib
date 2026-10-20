// Accounts on genclass.dev: sign-up and sign-in with Google (OpenID Connect, authorization code flow with PKCE,
// confidential client), an email and a password (src/password.ts) or GitHub (OAuth web flow), passkeys (WebAuthn,
// src/webauthn.ts) as optional extra security; web and CLI sessions; the device flow (RFC 8628) behind
// `npx @genclass/runtime login`; apps (projects) owned by an account.
//
// Invariants:
// - Creating an account never needs a passkey: an email and a password (always offered, so the site always has a way
//   in), Google or GitHub. There is no passkey sign-up: a passkey is added to an account that exists.
// - An account with a passkey requires one at sign-in: after its password, Google or GitHub vouched for it, no session is
//   granted until a passkey assertion of that account succeeds (a pending step of MFA_MS, a single-use row named by the
//   __Host-gc_mfa cookie; Origin checked; the WebAuthn challenge single-use). A passkey alone also signs in. Adding a
//   passkey to an account that has one, removing one (the last one turns the requirement off), and adding a password
//   to an account with a passkey need a passkey assertion in this session within FRESH_MS; changing a password needs
//   the current one or that assertion. The device flow rides on the web session, so it gets the same step.
// - Passwords are stored only as PBKDF2-HMAC-SHA256 strings (src/password.ts), keyed by the email as the username
//   (trimmed, lowercased, UNIQUE, never verified: there is no email sender yet). Wrong passwords for one account are
//   spaced out by a growing delay (src/password.ts delayAfter), never a lockout: a browser where that account's
//   password was right before (the __Host-gc_device cookie, a hash in password_devices) skips the delay for a few
//   tries, so a stranger guessing cannot keep the owner out. A sign-in for an email without a password does the same
//   work and gives the same answer as a wrong password.
// - Secrets are stored only as SHA-256 hashes: session cookies, CLI bearer tokens, device codes and device cookies.
//   Passkeys store a public key. Google and GitHub access tokens are used once during sign-in and never stored.
// - A Google or GitHub identity is attached to an existing account only through "Link" from a signed-in session,
//   never because an email matches: emails typed at sign-up are unverified, so matching on them would let someone
//   register a victim's address first and later receive the victim's sign-in.
// - Every state-changing request authenticated by a cookie must carry an Origin equal to the expected origin (else
//   403); so must sign-in and sign-up, with or without a session. The JSON endpoints the pages call also require
//   Content-Type application/json. Bearer requests (the CLI) carry no ambient credentials and need no Origin.
// - A CLI bearer session can do what the CLI needs and the approval page says: read the account and its apps, create
//   apps, add an app from its private link, read each app's short summary (src/summary.ts, what `npx @genclass/runtime
//   stats` prints), and end itself. The dashboard's stats, other sessions, passkeys, passwords, private links and the
//   account itself need the browser session.
// - OAuth state (state, nonce, PKCE verifier, where to go next, which account and session a Link started from) is
//   kept server-side in `challenges`; the cookie holds only that row's random id, so a planted cookie cannot name an
//   account to link to. Session cookies use the __Host- prefix (no Domain, Path=/, Secure), except on plain-HTTP
//   localhost in development.
// - Nothing is logged; the client IP is only a rate-limit key (hashed), never stored.
// Routes: see telemetry-worker/README.md ("Accounts").

import type { Env, HandleOptions } from "./collector.js";
import {
  accountPage,
  appNotFoundPage,
  devicePage,
  forgotPage,
  loginPage,
  messagePage,
  passkeyStepPage,
  pendingPage,
  signupPage,
  type AccountView,
  type DeviceView,
} from "./account-pages.js";
import {
  createProject,
  forgetToken,
  newProjectId,
  PROJECT_COLUMNS,
  PROJECT_ID_RE,
  projectBySecret,
  projectsCreatedSince,
  randomBase62,
  sanitizeName,
  SECRET_RE,
  sha256Hex,
  stats,
  type D1Like,
  type Project,
} from "./dashboard.js";
import { appExtrasData, appExtrasHtml } from "./billing-pages.js";
import { summary, summaryDashboard, summaryLimited, summaryRange } from "./summary.js";
import { forgetExports } from "./export.js";
import { json, mediaType, readCapped } from "./http.js";
import { dashboardPage, securityHeaders } from "./pages.js";
import { DEVICE_FAILURES, DEVICE_MS, DUMMY_HASH, FAILURE_WINDOW_MS, FREE_FAILURES, MAX_DELAY_MS, PASSWORD_MAX, delayAfter, hashPassword, needsRehash, passwordProblem, verifyPassword, waitText } from "./password.js";
import { accountAccess, accountBilling, appLimit, appLimitBody, onSale, pickRange, TRIAL_PLAN, trialDays, trialDaysLeft, viewRanges } from "./plans.js";
import { cancelForDeletion } from "./stripe.js";
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
/** The passkey step after Google or GitHub, for an account that has a passkey. */
export const MFA_MS = 5 * MINUTE;
/** How recent a passkey assertion must be to add or remove a passkey. */
export const FRESH_MS = 5 * MINUTE;
/** Where to write about an account whose passkeys are all lost, or whose password is forgotten (no email reset yet). */
export const RECOVERY_CONTACT = "mehar@daybot.ca";
/** Global ceiling on apps created in accounts per minute (anonymous creation has its own, collector.ts). */
const MAX_ACCOUNT_PROJECTS_PER_MINUTE = 60;

/** The web session cookie: __Host- on HTTPS; the plain name only for plain-HTTP localhost in development. */
export const SESSION_COOKIE = "__Host-gc_session";
export const DEV_SESSION_COOKIE = "gc_session";
/** The email-collision choice a first Google or GitHub sign-in waits on (a challenges row id). */
export const PENDING_COOKIE = "__Host-gc_pending";
export const DEV_PENDING_COOKIE = "gc_pending";
/** The passkey step a Google or GitHub sign-in waits on (a challenges row id, kind `mfa`). */
export const MFA_COOKIE = "__Host-gc_mfa";
export const DEV_MFA_COOKIE = "gc_mfa";
/** A browser where an account's password was right: it skips that account's delay after wrong passwords (a few tries). */
export const DEVICE_COOKIE = "__Host-gc_device";
export const DEV_DEVICE_COOKIE = "gc_device";
export const GOOGLE_COOKIE = "gc_oauth_google";
export const GITHUB_COOKIE = "gc_oauth_github";
/**
 * The only client names the approval page shows and the session list keeps: the CLI's own `genclass-runtime <version>`.
 * Anything else (free text a caller of POST /api/device/code chose) is shown as "Unknown client".
 */
export const CLIENT_NAME_RE = /^genclass-runtime \d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.]{1,20})?$/;

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
  /** Cookie names (SESSION_COOKIE and PENDING_COOKIE, or their development names when not secure). */
  session: string;
  pending: string;
  mfa: string;
  device: string;
  google: boolean;
  github: boolean;
}

export function authConfig(env: Env): AuthConfig {
  const origin = (env.AUTH_ORIGIN || "https://genclass.dev").replace(/\/+$/, "");
  const secure = !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    origin,
    rpId: env.AUTH_RP_ID || "genclass.dev",
    secure,
    session: secure ? SESSION_COOKIE : DEV_SESSION_COOKIE,
    pending: secure ? PENDING_COOKIE : DEV_PENDING_COOKIE,
    mfa: secure ? MFA_COOKIE : DEV_MFA_COOKIE,
    device: secure ? DEVICE_COOKIE : DEV_DEVICE_COOKIE,
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    github: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  };
}

/**
 * Whether the @genclass/runtime on npm (the RUNTIME_ON_NPM var, on any dist-tag) reads project keys and has `login`:
 * 0.3.0-beta.0 or later, so a 0.3.x prerelease on the `beta` dist-tag counts (the pages then name `@beta` in their
 * commands, pages.ts RUNTIME_PKG). Unset or unreadable counts as no, so the pages keep saying it is still to come.
 */
export function runtimeHasTokens(env: Env): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(env.RUNTIME_ON_NPM ?? "").trim());
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 0 || min >= 3;
}

/** The per-request context of the account routes (also used by src/billing.ts through accountContext). */
export interface C {
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

export function fail(status: number, error: string, headers: Record<string, string> = {}): Response {
  return json(status, { ok: false, error }, headers);
}

function withCookies(res: Response, cookies: string[]): Response {
  for (const k of cookies) res.headers.append("set-cookie", k);
  return res;
}

export function redirect(location: string, cookies: string[] = [], status = 302): Response {
  return withCookies(new Response(null, { status, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } }), cookies);
}

export function page(status: number, render: (nonce: string) => string, cookies: string[] = []): Response {
  const nonce = randomBase62(22);
  return withCookies(new Response(render(nonce), { status, headers: securityHeaders(nonce, {}, { account: true }) }), cookies);
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

export const originOk = (c: C): boolean => c.req.headers.get("origin") === c.cfg.origin;
export const csrfFail = (): Response => fail(403, "cross-origin request refused");

/** Parse a JSON object body (Content-Type application/json, at most `cap` bytes; empty means {}). */
export async function readJson(c: C, cap = 16 * 1024): Promise<Record<string, unknown> | Response> {
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
const tooManyPage = (): Response => {
  const r = page(429, (n) => messagePage(n, { title: "Too many requests", text: "Too many requests came from your network in the last minute. Wait a minute, then reload this page.", links: [] }));
  r.headers.set("retry-after", "60");
  return r;
};

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

export interface Auth {
  account: Account;
  sessionId: string;
  via: "cookie" | "bearer";
  /** When this session last proved a passkey (sign-in, the passkey step, or a confirmation), or null. */
  passkeyAt: string | null;
}

const ACCOUNT_COLUMNS = "a.id, a.email, a.email_verified, a.google_sub, a.github_id, a.github_login, a.created";

/** The signed-in account: a CLI bearer token when an Authorization header is present, else the web session cookie. */
export async function authenticate(c: C): Promise<Auth | null> {
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
    const v = getCookie(c.req, c.cfg.session);
    if (!v || !SECRET43_RE.test(v)) return null;
    secret = v;
    kind = "web";
  }
  const row = await c.db
    .prepare(
      `SELECT s.id AS sid, s.last_used AS slu, s.passkey_at AS spk, ${ACCOUNT_COLUMNS} FROM auth_sessions s JOIN accounts a ON a.id = s.account_id ` +
        "WHERE s.hash = ? AND s.kind = ? AND s.revoked IS NULL AND s.expires > ?",
    )
    .bind(await sha256Hex(secret), kind, c.now.toISOString())
    .first<Account & { sid: string; slu: string | null; spk: string | null }>();
  if (!row) return null;
  if (!row.slu || Date.parse(row.slu) < c.now.getTime() - 10 * MINUTE) {
    try {
      await c.db.prepare("UPDATE auth_sessions SET last_used = ? WHERE id = ?").bind(c.now.toISOString(), row.sid).run();
    } catch {
      /* best effort */
    }
  }
  const { sid, slu: _slu, spk, ...account } = row;
  c.auth = { account, sessionId: sid, via: kind === "cli" ? "bearer" : "cookie", passkeyAt: spk ?? null };
  return c.auth;
}

export async function webSession(c: C): Promise<Auth | null> {
  const a = await authenticate(c);
  return a && a.via === "cookie" ? a : null;
}

/** A new session; `passkey`: it was granted on a passkey assertion (it is fresh for FRESH_MS). */
async function createSession(c: C, accountId: string, kind: "web" | "cli", label: string | null, passkey = false): Promise<{ id: string; secret: string; expires: string }> {
  const raw = randomSecret(32);
  const secret = kind === "cli" ? `gcs_${raw}` : raw;
  const id = randomBase62(16);
  const expires = new Date(c.now.getTime() + (kind === "cli" ? CLI_SESSION_MS : WEB_SESSION_MS)).toISOString();
  const iso = c.now.toISOString();
  await c.db
    .prepare("INSERT INTO auth_sessions (id, hash, account_id, kind, created, expires, label, last_used, passkey_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(secret), accountId, kind, iso, expires, label, iso, passkey ? iso : null)
    .run();
  return { id, secret, expires };
}

/** The account's passkeys (id and transports), oldest first. */
async function passkeysOf(c: C, accountId: string): Promise<{ id: string; transports: string | null }[]> {
  const r = await c.db.prepare("SELECT id, transports FROM credentials WHERE account_id = ? ORDER BY created").bind(accountId).all<{ id: string; transports: string | null }>();
  return r.results ?? [];
}

/** WebAuthn allowCredentials for an account's passkeys. */
function allowCredentials(creds: { id: string; transports: string | null }[]): { type: "public-key"; id: string; transports?: string[] }[] {
  return creds.map((k) => {
    let transports: string[] | undefined;
    try {
      transports = k.transports ? (JSON.parse(k.transports) as string[]) : undefined;
    } catch {
      transports = undefined;
    }
    return { type: "public-key" as const, id: k.id, ...(transports?.length ? { transports } : {}) };
  });
}

/** This session proved a passkey within FRESH_MS. */
const fresh = (c: C, a: Auth): boolean => !!a.passkeyAt && Date.parse(a.passkeyAt) > c.now.getTime() - FRESH_MS;
const confirmFirst = (): Response => json(403, { ok: false, error: "confirm with one of your passkeys first", confirm: true });
const noPasskeySignup = (): Response => fail(403, "create an account with your email and a password, Google or GitHub; you can add a passkey for extra security afterwards");

const sessionCookie = (c: C, secret: string): string => setCookie(c, c.cfg.session, secret, WEB_SESSION_MS / 1000);

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

export async function accountProjects(c: C, accountId: string): Promise<Project[]> {
  const r = await c.db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE account_id = ? AND id IS NOT NULL ORDER BY name COLLATE NOCASE, created`)
    .bind(accountId)
    .all<Project>();
  return r.results ?? [];
}

export async function ownedProject(c: C, accountId: string, id: string): Promise<Project | null> {
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
  // a signed-in account adds a passkey (there is no passkey sign-up: an account starts with a password, Google or
  // GitHub); to one that already has a passkey, only after one of them was just used (a stolen session must not be able
  // to add its own passkey and then remove the owner's)
  const session = await webSession(c);
  if (!session) return noPasskeySignup();
  const accountId = session.account.id;
  const name = userName(session.account);
  const exclude = (await passkeysOf(c, accountId)).map((x) => x.id);
  if (exclude.length && !fresh(c, session)) return confirmFirst();
  const ch = await putChallenge(c, "register", accountId, { add: true }, CHALLENGE_MS);
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
  // only an add (a sign-up challenge from before passkey sign-up was removed cannot finish)
  if (ch.data.add !== true) return noPasskeySignup();
  const session = await webSession(c);
  if (!session || session.account.id !== ch.account_id) return fail(403, "sign in again to add a passkey");
  await insertCred.run();
  return json(200, { ok: true, account: accountJson(session.account) });
}

async function passkeyLoginOptions(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (await overLimit(c, "login")) return tooMany();
  const ch = await putChallenge(c, "login", null, null, CHALLENGE_MS);
  return json(200, { id: ch.id, publicKey: { challenge: ch.challenge, rpId: c.cfg.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: [] } });
}

/**
 * Check a passkey assertion for a challenge already taken (single use): the credential, its user handle, the signature
 * and the sign counter (updated only if it is still the one checked, so two concurrent uses cannot both pass).
 * `account`: the passkey must belong to that account. The credential's account id, or the Response to send.
 */
async function checkAssertion(c: C, body: Record<string, unknown>, ch: { challenge: string }, account?: string | null): Promise<string | Response> {
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
  if (account && row.account_id !== account) return fail(400, "this passkey belongs to another GenClass account; use one of this account's passkeys");
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
  return row.account_id;
}

async function passkeyLoginVerify(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 32 * 1024);
  if (body instanceof Response) return body;
  const ch = await takeChallenge(c, body.id, "login");
  if (!ch) return fail(400, "this sign-in request expired; start again");
  const id = await checkAssertion(c, body, ch);
  if (id instanceof Response) return id;
  const account = await accountById(c, id);
  if (!account) return fail(400, "this passkey's account no longer exists");
  const s = await createSession(c, account.id, "web", null, true);
  return withCookies(json(200, { ok: true, account: accountJson(account) }), [sessionCookie(c, s.secret)]);
}

// --------------------------------------------------------------------------------------------- the passkey step

/** The passkey step the mfa cookie names (kind `mfa`), still running; `take` consumes it (single use). */
async function mfaPending(c: C, take: boolean): Promise<{ id: string; account_id: string; next: string | null; via: string | null } | null> {
  const id = getCookie(c.req, c.cfg.mfa);
  if (!id || !ID22_RE.test(id)) return null;
  const sql = take
    ? "DELETE FROM challenges WHERE id = ? AND kind = 'mfa' RETURNING account_id, data, expires"
    : "SELECT account_id, data, expires FROM challenges WHERE id = ? AND kind = 'mfa'";
  const row = await c.db.prepare(sql).bind(id).first<{ account_id: string | null; data: string | null; expires: string }>();
  if (!row || !row.account_id || Date.parse(row.expires) <= c.now.getTime()) return null;
  let d: Record<string, unknown> = {};
  try {
    d = row.data ? (JSON.parse(row.data) as Record<string, unknown>) : {};
  } catch {
    /* none */
  }
  return { id, account_id: row.account_id, next: safeNext(typeof d.next === "string" ? d.next : null), via: d.via === "google" || d.via === "github" || d.via === "password" ? d.via : null };
}

/**
 * After its password, Google or GitHub vouched for an existing account: a session at once, or, for an account with a
 * passkey, the passkey step first (no session until it succeeds). For a page (redirect) or for a JSON answer (`json`).
 */
async function signInTo(c: C, accountId: string, next: string | null, via: Provider | "password", asJson = false): Promise<Response> {
  if ((await passkeysOf(c, accountId)).length) {
    const p = await putChallenge(c, "mfa", accountId, { next, via }, MFA_MS);
    const cookie = setCookie(c, c.cfg.mfa, p.id, MFA_MS / 1000);
    return asJson ? withCookies(json(200, { ok: true, next: "/login/passkey" }), [cookie]) : redirect("/login/passkey", [cookie]);
  }
  const s = await createSession(c, accountId, "web", null);
  const to = next ?? "/account";
  return asJson ? withCookies(json(200, { ok: true, next: to }), [sessionCookie(c, s.secret)]) : redirect(to, [sessionCookie(c, s.secret)]);
}

/** POST /api/auth/passkey/mfa/options: WebAuthn request options for the pending step's account (its passkeys only). */
async function passkeyStepOptions(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c);
  if (body instanceof Response) return body;
  if (await overLimit(c, "login")) return tooMany();
  const p = await mfaPending(c, false);
  if (!p) return fail(400, "this sign-in expired; start again from the sign-in page");
  const creds = await passkeysOf(c, p.account_id);
  if (!creds.length) return fail(400, "this account has no passkey any more; start again from the sign-in page");
  const ch = await putChallenge(c, "mfa-login", p.account_id, { p: p.id }, CHALLENGE_MS);
  return json(200, { id: ch.id, publicKey: { challenge: ch.challenge, rpId: c.cfg.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: allowCredentials(creds) } });
}

/** POST /api/auth/passkey/mfa/verify: the account's passkey; then the session, and the pending step is used up. */
async function passkeyStepVerify(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 32 * 1024);
  if (body instanceof Response) return body;
  const ch = await takeChallenge(c, body.id, "mfa-login");
  const pendingId = getCookie(c.req, c.cfg.mfa);
  if (!ch || !ch.account_id || !pendingId || ch.data.p !== pendingId) return fail(400, "this sign-in expired; start again from the sign-in page");
  const id = await checkAssertion(c, body, ch, ch.account_id);
  if (id instanceof Response) return id;
  const p = await mfaPending(c, true);
  if (!p || p.account_id !== id) return fail(400, "this sign-in expired; start again from the sign-in page");
  const account = await accountById(c, id);
  if (!account) return fail(400, "this account no longer exists");
  const s = await createSession(c, id, "web", null, true);
  return withCookies(json(200, { ok: true, next: p.next ?? "/account", account: accountJson(account) }), [clearCookie(c, c.cfg.mfa), sessionCookie(c, s.secret)]);
}

// --------------------------------------------------------------------------------------------- confirm (fresh)

/** POST /api/auth/passkey/confirm/options: a signed-in browser proves one of its passkeys again (add or remove one). */
async function passkeyConfirmOptions(c: C): Promise<Response> {
  const a = await browserWriter(c, "passkeys can be confirmed");
  if (a instanceof Response) return a;
  const body = await readJson(c);
  if (body instanceof Response) return body;
  const creds = await passkeysOf(c, a.account.id);
  if (!creds.length) return fail(409, "this account has no passkey to confirm with");
  const ch = await putChallenge(c, "confirm", a.account.id, { sid: a.sessionId }, CHALLENGE_MS);
  return json(200, { id: ch.id, publicKey: { challenge: ch.challenge, rpId: c.cfg.rpId, timeout: CHALLENGE_MS, userVerification: "required", allowCredentials: allowCredentials(creds) } });
}

/** POST /api/auth/passkey/confirm/verify: marks this session fresh (passkey_at) for FRESH_MS. */
async function passkeyConfirmVerify(c: C): Promise<Response> {
  const a = await browserWriter(c, "passkeys can be confirmed");
  if (a instanceof Response) return a;
  const body = await readJson(c, 32 * 1024);
  if (body instanceof Response) return body;
  const ch = await takeChallenge(c, body.id, "confirm");
  if (!ch || ch.account_id !== a.account.id || ch.data.sid !== a.sessionId) return fail(400, "this confirmation expired; start again");
  const id = await checkAssertion(c, body, ch, a.account.id);
  if (id instanceof Response) return id;
  await c.db.prepare("UPDATE auth_sessions SET passkey_at = ? WHERE id = ?").bind(c.now.toISOString(), a.sessionId).run();
  return json(200, { ok: true });
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

/** One OAuth flow in progress, as stored server-side (challenges, kind `oauth:<provider>`). */
interface OAuthState {
  /** the `state` sent to the provider (the challenge column) */
  s: string;
  /** Google: the nonce and the PKCE verifier */
  n?: string;
  v?: string;
  next: string | null;
  /** account id when this flow links the provider to a signed-in account */
  link: string | null;
  /** the session that started a Link: the callback must come back on the same one */
  sid: string | null;
}

type Provider = "google" | "github";
const oauthCookie = (p: Provider): string => (p === "google" ? GOOGLE_COOKIE : GITHUB_COOKIE);

/**
 * Store a new flow and return the `state` for the provider plus the cookie that names the stored row. The cookie
 * holds only the row's random id: what it means (which account to link, where to go next) stays on the server.
 */
async function saveOAuth(c: C, p: Provider, st: { next: string | null; link: string | null; sid: string | null }, extra: { n?: string; v?: string } = {}): Promise<{ state: string; cookie: string }> {
  const ch = await putChallenge(c, `oauth:${p}`, st.link, { next: st.next, link: st.link, sid: st.sid, ...extra }, OAUTH_MS);
  return { state: ch.challenge, cookie: setCookie(c, oauthCookie(p), ch.id, OAUTH_MS / 1000, `/auth/${p}`) };
}

/** Take (single use) the flow the cookie names, or null when there is none or it expired. */
async function takeOAuth(c: C, p: Provider): Promise<OAuthState | null> {
  const ch = await takeChallenge(c, getCookie(c.req, oauthCookie(p)), `oauth:${p}`);
  if (!ch) return null;
  const d = ch.data;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    s: ch.challenge,
    n: str(d.n),
    v: str(d.v),
    next: safeNext(str(d.next)),
    link: typeof d.link === "string" && ID22_RE.test(d.link) ? d.link : null,
    sid: typeof d.sid === "string" && SESSION_ID_RE.test(d.sid) ? d.sid : null,
  };
}

/** Shared start of both flows: who is linking, where to go afterwards. A Response when the flow should not start. */
async function oauthStart(c: C): Promise<{ next: string | null; link: string | null; sid: string | null } | Response> {
  const next = safeNext(c.url.searchParams.get("next"));
  const session = await webSession(c);
  if (c.url.searchParams.get("link") === "1") {
    if (!session) return redirect(`/login?next=${encodeURIComponent("/account")}`);
    return { next: "/account", link: session.account.id, sid: session.sessionId };
  }
  if (session) return redirect(next ?? "/account");
  // every start stores a row, so starts are rate limited like the passkey options
  if (await overLimit(c, "oauth")) return tooManyPage();
  return { next, link: null, sid: null };
}

async function googleStart(c: C): Promise<Response> {
  if (!c.cfg.google) return page(404, (n) => messagePage(n, { title: "Google sign-in is not set up", text: "This GenClass server has no Google client configured. Sign in with your email and password instead.", links: [["Sign in", "/login"]] }));
  const st = await oauthStart(c);
  if (st instanceof Response) return st;
  const nonce = randomSecret(32);
  const verifier = randomSecret(32);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const { state, cookie } = await saveOAuth(c, "google", st, { n: nonce, v: verifier });
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
  const bad = (status: number, text: string, detail?: string): Response =>
    done(page(status, (n) => messagePage(n, { title: "Google sign-in did not finish", text, detail, links: [["Try again", "/login"]] })));
  if (!c.cfg.google) return bad(404, "This GenClass server has no Google client configured.");
  const st = await takeOAuth(c, "google");
  if (c.url.searchParams.get("error")) return done(redirect("/login?error=google"));
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
  if (err || !claims) {
    return bad(400, "Google's answer could not be checked. This happens when the sign-in took too long or was finished in another tab. Start again.", `Check that failed: ${err ?? "no id_token"}`);
  }
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
  if (!c.cfg.github) return page(404, (n) => messagePage(n, { title: "GitHub sign-in is not set up", text: "This GenClass server has no GitHub app configured. Sign in with your email and password instead.", links: [["Sign in", "/login"]] }));
  const st = await oauthStart(c);
  if (st instanceof Response) return st;
  const { state, cookie } = await saveOAuth(c, "github", st);
  const q = new URLSearchParams({ client_id: c.env.GITHUB_CLIENT_ID!, redirect_uri: `${c.cfg.origin}/auth/github/callback`, state, allow_signup: "true" });
  return redirect(`${GITHUB_AUTH_URL}?${q}`, [cookie]);
}

async function githubCallback(c: C): Promise<Response> {
  const clear = clearCookie(c, GITHUB_COOKIE, "/auth/github");
  const done = (r: Response): Response => withCookies(r, [clear]);
  const bad = (status: number, text: string): Response =>
    done(page(status, (n) => messagePage(n, { title: "GitHub sign-in did not finish", text, links: [["Try again", "/login"]] })));
  if (!c.cfg.github) return bad(404, "This GenClass server has no GitHub app configured.");
  const st = await takeOAuth(c, "github");
  if (c.url.searchParams.get("error")) return done(redirect("/login?error=github"));
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
    if (!session || session.account.id !== st.link || session.sessionId !== st.sid) {
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
    // an account with a passkey: the passkey step first, then the session
    return signInTo(c, owner.id, st.next, ident.provider);
  }
  // A new identity. If another account already uses this email, ask first: never attach on an email match.
  if (ident.email) {
    const same = await c.db.prepare("SELECT 1 AS x FROM accounts WHERE lower(email) = lower(?) LIMIT 1").bind(ident.email).first();
    if (same) {
      const p = await putChallenge(c, "pending", null, { ...ident, next: st.next }, OAUTH_MS);
      return page(200, (n) => pendingPage(n, { email: ident.email!, provider: ident.provider }), [setCookie(c, c.cfg.pending, p.id, OAUTH_MS / 1000)]);
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
  const clear = clearCookie(c, c.cfg.pending);
  const ch = await takeChallenge(c, getCookie(c.req, c.cfg.pending), "pending");
  if (!ch) return withCookies(fail(400, "this sign-in expired; start again"), [clear]);
  const d = ch.data;
  if ((d.provider !== "google" && d.provider !== "github") || typeof d.sub !== "string") return withCookies(fail(400, "this sign-in expired; start again"), [clear]);
  const ident: Identity = { provider: d.provider, sub: d.sub, email: cleanEmail(d.email), emailVerified: d.emailVerified === true, login: typeof d.login === "string" ? d.login : null };
  const col = ident.provider === "google" ? "google_sub" : "github_id";
  const owner = await c.db.prepare(`SELECT id FROM accounts WHERE ${col} = ?`).bind(ident.sub).first<{ id: string }>();
  const next = safeNext(typeof d.next === "string" ? d.next : null);
  // the identity got an account meanwhile (another tab): sign in to it, with its passkey step if it has a passkey
  if (owner) return withCookies(await signInTo(c, owner.id, next, ident.provider, true), [clear]);
  const id = await createProviderAccount(c, ident);
  const s = await createSession(c, id, "web", null);
  return withCookies(json(200, { ok: true, next: next ?? "/account?welcome=1" }), [clear, sessionCookie(c, s.secret)]);
}

// --------------------------------------------------------------------------------------------- email and password

/** The username of a password: the email as typed, trimmed and lowercased; null when it is not a plausible address. */
export function loginEmail(v: unknown): string | null {
  const e = cleanEmail(v);
  return e ? e.toLowerCase() : null;
}

/** The one answer for an unknown email and for a wrong password (no hint which it was). */
const WRONG_PASSWORD = "that email and password do not match an account; if you made your account with Google or GitHub, continue with it instead";
const tooManyWrong = (wait: number): string => `too many wrong passwords, so wait ${waitText(wait)} before the next try`;

function throttled(waitMs: number): Response {
  const s = Math.max(1, Math.ceil(waitMs / 1000));
  return json(
    429,
    { ok: false, error: `too many wrong passwords for this account; try again in ${waitText(waitMs)}, or sign in another way (Google, GitHub or a passkey) if the account has one`, retry_after: s },
    { "retry-after": String(s) },
  );
}

/** How long the account's delay still runs (0 when it is over). */
async function waitLeft(c: C, accountId: string): Promise<number> {
  const r = await c.db.prepare("SELECT next_try FROM passwords WHERE account_id = ?").bind(accountId).first<{ next_try: string | null }>();
  return r?.next_try ? Math.max(0, Date.parse(r.next_try) - c.now.getTime()) : 0;
}

/**
 * Count one password check against the account before it is made, so parallel guesses cannot all slip in before the
 * first wrong one is written, unless the account's delay is still running. One UPDATE: the new count (restarted after
 * a day without a wrong password) and the time the next check may happen (delayAfter of that count). Returns the new
 * count, or null while the delay runs. A correct password then clears both (passwordLogin, setPassword).
 */
async function accountAttempt(c: C, accountId: string): Promise<{ failed: number } | null> {
  const nowMs = c.now.getTime();
  const iso = c.now.toISOString();
  const stale = new Date(nowMs - FAILURE_WINDOW_MS).toISOString();
  const n = "(CASE WHEN failed_at IS NULL OR failed_at <= ? THEN 1 ELSE failed + 1 END)";
  const steps: [number, string][] = [];
  for (let k = FREE_FAILURES; delayAfter(k) < MAX_DELAY_MS; k++) steps.push([k, new Date(nowMs + delayAfter(k)).toISOString()]);
  const next = `CASE WHEN ${n} < ? THEN NULL ${steps.map(() => `WHEN ${n} = ? THEN ?`).join(" ")} ELSE ? END`;
  const r = await c.db
    .prepare(`UPDATE passwords SET failed = ${n}, failed_at = ?, next_try = ${next} WHERE account_id = ? AND (next_try IS NULL OR next_try <= ?) RETURNING failed`)
    .bind(
      stale,
      iso,
      stale,
      FREE_FAILURES,
      ...steps.flatMap(([k, at]) => [stale, k, at]),
      new Date(nowMs + MAX_DELAY_MS).toISOString(),
      accountId,
      iso,
    )
    .first<{ failed: number }>();
  return r ? { failed: Number(r.failed) } : null;
}

/** This browser's device cookie, hashed, when it holds a well-formed one. */
async function deviceHash(c: C): Promise<string | null> {
  const v = getCookie(c.req, c.cfg.device);
  return v && SECRET43_RE.test(v) ? sha256Hex(v) : null;
}

/**
 * A browser where this account's password was right before: count this try against the browser's own budget
 * (DEVICE_FAILURES wrong ones in a row) instead of the account's delay. Null when the browser is not trusted for the
 * account, or used up its budget (then the account's delay applies to it like to anyone).
 */
async function deviceAttempt(c: C, accountId: string): Promise<string | null> {
  const h = await deviceHash(c);
  if (!h) return null;
  const r = await c.db
    .prepare("UPDATE password_devices SET failed = failed + 1 WHERE hash = ? AND account_id = ? AND failed < ? RETURNING hash")
    .bind(h, accountId, DEVICE_FAILURES)
    .first();
  return r ? h : null;
}

/**
 * Trust this browser for the account (its password was right here): a new device cookie (rotated on every correct
 * password; the accounts this browser was trusted for move to the new value) and the account's row. The Set-Cookie.
 */
async function trustDevice(c: C, accountId: string): Promise<string> {
  const secret = randomSecret(32);
  const hash = await sha256Hex(secret);
  const old = await deviceHash(c);
  const iso = c.now.toISOString();
  const stmts = old ? [c.db.prepare("UPDATE password_devices SET hash = ? WHERE hash = ?").bind(hash, old)] : [];
  stmts.push(
    c.db
      .prepare("INSERT INTO password_devices (hash, account_id, created, last_used, failed) VALUES (?, ?, ?, ?, 0) ON CONFLICT (hash, account_id) DO UPDATE SET last_used = excluded.last_used, failed = 0")
      .bind(hash, accountId, iso, iso),
  );
  await c.db.batch(stmts);
  return setCookie(c, c.cfg.device, secret, DEVICE_MS / 1000);
}

/**
 * Store a new password for an account that has one, and end what the old one may have opened: every other session
 * (browsers and terminals) and every trusted browser. `keep`: the session making the change stays. Also what a future
 * emailed reset calls (resetSender).
 */
export async function storeNewPassword(c: C, accountId: string, password: string, keep: string | null): Promise<void> {
  const hash = await hashPassword(password);
  const iso = c.now.toISOString();
  await c.db.batch([
    c.db.prepare("UPDATE passwords SET hash = ?, updated = ?, failed = 0, failed_at = NULL, next_try = NULL WHERE account_id = ?").bind(hash, iso, accountId),
    c.db.prepare("DELETE FROM password_devices WHERE account_id = ?").bind(accountId),
    c.db.prepare("UPDATE auth_sessions SET revoked = ? WHERE account_id = ? AND id != ? AND revoked IS NULL").bind(iso, accountId, keep ?? ""),
  ]);
}

/**
 * The hook for a future emailed reset. GenClass has no email sender yet, so this is null and /login/forgot asks the
 * person to write to RECOVERY_CONTACT from the address they sign in with. Once a sender exists, return it here, then
 * add POST /api/auth/password/forgot (AUTH_LIMIT; the same answer whether or not the email has a password; a `reset`
 * challenges row of 30 minutes holding the account id and the hash of a secret mailed as /login/reset?id=...&t=...)
 * and a /login/reset page that calls storeNewPassword(c, id, password, null).
 */
export function resetSender(_env: Env): { send(to: string, link: string): Promise<void> } | null {
  return null;
}

/** POST /api/auth/password/signup: a new account with an email and a password, and its session. */
async function passwordSignup(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  if (await overLimit(c, "signup")) return tooMany();
  const email = loginEmail(body.email);
  if (!email) return fail(400, "enter a valid email address");
  const problem = passwordProblem(body.password, email);
  if (problem) return fail(400, problem);
  const next = safeNext(typeof body.next === "string" ? body.next : null);
  // Unavoidable: an email signs in to one account only, so a taken one is refused (no email exists to tell its owner
  // instead). Nothing says how that account signs in.
  const taken = (): Response => fail(409, "an account already signs in with this email; sign in instead, or use Forgot your password on the sign-in page");
  const has = async (): Promise<boolean> => !!(await c.db.prepare("SELECT 1 AS x FROM passwords WHERE email = ?").bind(email).first());
  if (await has()) return taken();
  const hash = await hashPassword(body.password as string);
  const id = randomBase62(22);
  const iso = c.now.toISOString();
  try {
    await c.db.batch([
      c.db.prepare("INSERT INTO accounts (id, email, email_verified, created) VALUES (?, ?, 0, ?)").bind(id, email, iso),
      c.db.prepare("INSERT INTO passwords (account_id, email, hash, created, updated, last_used) VALUES (?, ?, ?, ?, ?, ?)").bind(id, email, hash, iso, iso, iso),
    ]);
  } catch (e) {
    if (await has()) return taken(); // the same email at the same moment
    throw e;
  }
  const s = await createSession(c, id, "web", null);
  const trust = await trustDevice(c, id);
  return withCookies(json(200, { ok: true, account: { id, email, github_login: null }, next: next ?? "/account?welcome=1" }), [sessionCookie(c, s.secret), trust]);
}

/**
 * POST /api/auth/password/login: `{ email, password, next? }`. A session at once, or the passkey step for an account
 * with a passkey (`{ ok, next: "/login/passkey" }`). Wrong passwords: the account's delay (accountAttempt), unless this
 * browser is trusted for the account (deviceAttempt).
 */
async function passwordLogin(c: C): Promise<Response> {
  if (!originOk(c)) return csrfFail();
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  if (await overLimit(c, "password")) return tooMany();
  const email = loginEmail(body.email);
  const pw = typeof body.password === "string" ? body.password : "";
  if (!email || !pw || pw.length > PASSWORD_MAX * 4) return fail(400, "enter your email and your password");
  const next = safeNext(typeof body.next === "string" ? body.next : null);
  const row = await c.db.prepare("SELECT account_id, hash FROM passwords WHERE email = ?").bind(email).first<{ account_id: string; hash: string }>();
  if (!row) {
    await verifyPassword(pw, DUMMY_HASH); // as long as a wrong password for a real account
    return fail(400, WRONG_PASSWORD);
  }
  const device = await deviceAttempt(c, row.account_id);
  let failed = 0;
  if (!device) {
    const t = await accountAttempt(c, row.account_id);
    if (!t) return throttled(await waitLeft(c, row.account_id));
    failed = t.failed;
  }
  if (!(await verifyPassword(pw, row.hash))) {
    const wait = device ? 0 : delayAfter(failed);
    return fail(400, wait ? `${WRONG_PASSWORD}; ${tooManyWrong(wait)}` : WRONG_PASSWORD);
  }
  const iso = c.now.toISOString();
  const done = [c.db.prepare("UPDATE passwords SET failed = 0, failed_at = NULL, next_try = NULL, last_used = ? WHERE account_id = ?").bind(iso, row.account_id)];
  // a hash made with less work than today's is replaced now that the password is at hand
  if (needsRehash(row.hash)) done.push(c.db.prepare("UPDATE passwords SET hash = ? WHERE account_id = ? AND hash = ?").bind(await hashPassword(pw), row.account_id, row.hash));
  await c.db.batch(done);
  const trust = await trustDevice(c, row.account_id);
  return withCookies(await signInTo(c, row.account_id, next, "password", true), [trust]);
}

/**
 * POST /api/auth/password (browser session and our Origin): change the password, with `{ current, password }` or after
 * a passkey in this session within FRESH_MS (`{ password }`; else 403 `{ confirm: true }`), which ends every other
 * session and trusted browser; or add one to an account that signs in with Google, GitHub or a passkey
 * (`{ email, password }`; the email defaults to the account's; a fresh passkey first when the account has one).
 */
async function setPassword(c: C): Promise<Response> {
  const a = await browserWriter(c, "a password can be set");
  if (a instanceof Response) return a;
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const row = await c.db.prepare("SELECT email, hash FROM passwords WHERE account_id = ?").bind(a.account.id).first<{ email: string; hash: string }>();
  const passkeys = (await passkeysOf(c, a.account.id)).length;
  if (row) {
    const problem = passwordProblem(body.password, row.email);
    if (problem) return fail(400, problem);
    const current = typeof body.current === "string" ? body.current : "";
    if (current) {
      // a stolen session must not guess the current password any faster than a sign-in could
      if (await overLimit(c, "password")) return tooMany();
      const t = await accountAttempt(c, a.account.id);
      if (!t) return throttled(await waitLeft(c, a.account.id));
      if (current.length > PASSWORD_MAX * 4 || !(await verifyPassword(current, row.hash))) {
        const wait = delayAfter(t.failed);
        return fail(400, `your current password is not right${wait ? `; ${tooManyWrong(wait)}` : ""}`);
      }
    } else if (!fresh(c, a)) {
      return passkeys ? confirmFirst() : fail(400, "enter your current password");
    }
    await storeNewPassword(c, a.account.id, body.password as string, a.sessionId);
    return withCookies(json(200, { ok: true, changed: true }), [await trustDevice(c, a.account.id)]);
  }
  const email = loginEmail(body.email ?? a.account.email);
  if (!email) return fail(400, "enter the email address you will sign in with");
  const problem = passwordProblem(body.password, email);
  if (problem) return fail(400, problem);
  // like adding a second passkey: a stolen session must not add its own way in to an account with a passkey
  if (passkeys && !fresh(c, a)) return confirmFirst();
  const inUse = (): Response => fail(409, "another GenClass account already signs in with this email; use another address");
  const has = async (): Promise<boolean> => !!(await c.db.prepare("SELECT 1 AS x FROM passwords WHERE email = ?").bind(email).first());
  if (await has()) return inUse();
  const hash = await hashPassword(body.password as string);
  const iso = c.now.toISOString();
  try {
    await c.db.batch([
      c.db.prepare("INSERT INTO passwords (account_id, email, hash, created, updated) VALUES (?, ?, ?, ?, ?)").bind(a.account.id, email, hash, iso, iso),
      // a GitHub account had no email: this one becomes the account's (as typed, unverified, like any sign-up email)
      c.db.prepare("UPDATE accounts SET email = ? WHERE id = ? AND email IS NULL").bind(email, a.account.id),
    ]);
  } catch (e) {
    if (await has()) return inUse();
    throw e;
  }
  return withCookies(json(200, { ok: true, added: true }), [await trustDevice(c, a.account.id)]);
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
  // Only the CLI's own name is kept: free text here would be shown on the genuine approval page (remote phishing).
  const named = typeof body.client_name === "string" ? body.client_name.trim() : "";
  const client = CLIENT_NAME_RE.test(named) ? named : null;
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
  // Over the per-network budget: slow_down before any database read, so polling (with live or made-up codes) cannot
  // cost more than the limit allows. A CLI that honours it waits 10 s and is under the budget again.
  if (await overLimit(c, "poll")) {
    const next = DEVICE_INTERVAL_S + 5;
    return deviceError("slow_down", `poll at most every ${next} seconds`, { interval: next });
  }
  const hash = await sha256Hex(dc);
  const row = await c.db.prepare("SELECT * FROM device_codes WHERE hash = ?").bind(hash).first<DeviceRow>();
  const nowMs = c.now.getTime();
  if (!row) return deviceError("expired_token", "this code has expired; run the command again");
  if (Date.parse(row.expires) <= nowMs) {
    await c.db.prepare("DELETE FROM device_codes WHERE hash = ?").bind(hash).run();
    return deviceError("expired_token", "this code has expired; run the command again");
  }
  const interval = Number(row.poll_interval) || DEVICE_INTERVAL_S;
  // Polling faster than the interval (1 s of slack for network jitter): slow_down, and the interval grows by 5 s for
  // every later request (RFC 8628 section 3.5).
  const early = row.last_poll !== null && nowMs - Date.parse(row.last_poll) < interval * 1000 - 1000;
  if (early) {
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

const noContent = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** A write only the browser may make (passkeys, other sessions, private links, the account): 403 for a CLI session. */
async function browserWriter(c: C, what: string): Promise<Auth | Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  if (a.via !== "cookie") return fail(403, `${what} only in the browser, on your account page`);
  return a;
}

const appCount = async (c: C, accountId: string): Promise<number> =>
  Number((await c.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE account_id = ?").bind(accountId).first<{ n: number }>())?.n ?? 0);
const tooManyApps = (): Response => fail(409, `an account can hold at most ${MAX_APPS_PER_ACCOUNT} apps`);

/** The 409 when one more app would pass the plan's limit (src/plans.ts) or the abuse cap, else null. */
async function overAppLimit(c: C, accountId: string): Promise<Response | null> {
  const n = await appCount(c, accountId);
  if (n >= MAX_APPS_PER_ACCOUNT) return tooManyApps();
  const lim = await appLimit(c.db, c.env, accountId, c.now);
  if (lim.max !== null && n >= lim.max) return json(409, appLimitBody(lim, c.cfg.origin, trialDays(c.env)));
  return null;
}

async function createAccountProject(c: C): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  const body = await readJson(c, 4096);
  if (body instanceof Response) return body;
  const over = await overAppLimit(c, a.account.id);
  if (over) return over;
  if (c.env.CREATE_LIMITER) {
    const { success } = await c.env.CREATE_LIMITER.limit({ key: (await sha256Hex(`create:account:${a.account.id}`)).slice(0, 32) });
    if (!success) return fail(429, "too many apps created; try again in a minute", { "retry-after": "60" });
  }
  // a ceiling of its own: anonymous creation (/api/projects) cannot use it up
  if ((await projectsCreatedSince(c.db, new Date(c.now.getTime() - MINUTE), "account")) >= MAX_ACCOUNT_PROJECTS_PER_MINUTE) {
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
    if (!p.account_id) {
      const over = await overAppLimit(c, a.account.id);
      if (over) return over;
    }
    await c.db
      .prepare("UPDATE projects SET account_id = ?, id = COALESCE(id, ?) WHERE token = ? AND (account_id IS NULL OR account_id = ?)")
      .bind(a.account.id, newProjectId(), p.token, a.account.id)
      .run();
  }
  const owned = await c.db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE token = ? AND account_id = ?`).bind(p.token, a.account.id).first<Project>();
  if (!owned) return fail(409, "this app already belongs to another account");
  return json(200, { project: projectJson(c, owned) });
}

/**
 * DELETE /api/account/projects/<id>/link: turn off an owned app's private dashboard link. The stored hash is replaced
 * by the hash of a secret nobody is given, so the old link stops working (and can no longer be claimed); the app,
 * its key and its data stay in the account.
 */
async function turnOffLink(c: C, id: string): Promise<Response> {
  const a = await browserWriter(c, "a private link can be turned off");
  if (a instanceof Response) return a;
  const p = await ownedProject(c, a.account.id, id);
  if (!p) return fail(404, "not found");
  await c.db
    .prepare("UPDATE projects SET secret_hash = ?, private_link = 0 WHERE id = ? AND account_id = ?")
    .bind(await sha256Hex(`off:${randomSecret(32)}`), id, a.account.id)
    .run();
  return noContent();
}

/**
 * DELETE /api/account/sessions/<id>. A CLI session may end only itself ("current", the CLI's logout); the browser
 * may end any of the account's sessions, or every session but itself ("others").
 */
async function revokeSession(c: C, id: string): Promise<Response> {
  const a = await writer(c);
  if (a instanceof Response) return a;
  const iso = c.now.toISOString();
  if (id === "current") {
    await c.db.prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(iso, a.sessionId).run();
    const res = noContent();
    return a.via === "cookie" ? withCookies(res, [clearCookie(c, c.cfg.session)]) : res;
  }
  if (a.via !== "cookie") return fail(403, "a command line session can only end itself; manage other sessions on your account page");
  if (id === "others") {
    await revokeOthers(c, a);
    return noContent();
  }
  if (!SESSION_ID_RE.test(id)) return fail(404, "no such session");
  const r = await c.db
    .prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND account_id = ? AND revoked IS NULL RETURNING id")
    .bind(iso, id, a.account.id)
    .first();
  if (!r) return fail(404, "no such session");
  const res = noContent();
  return id === a.sessionId ? withCookies(res, [clearCookie(c, c.cfg.session)]) : res;
}

/** End every session of the account except the one making this request (browsers and terminals). */
async function revokeOthers(c: C, a: Auth): Promise<void> {
  await c.db
    .prepare("UPDATE auth_sessions SET revoked = ? WHERE account_id = ? AND id != ? AND revoked IS NULL")
    .bind(c.now.toISOString(), a.account.id, a.sessionId)
    .run();
}

/**
 * Remove a passkey, after a passkey assertion in this session within FRESH_MS (removing the last one turns off the
 * passkey step at sign-in); every other session ends too, since one of them may be where that passkey was used. The
 * account's last way in (a passkey, a password, Google, GitHub) stays.
 */
async function removeCredential(c: C, id: string): Promise<Response> {
  const a = await browserWriter(c, "passkeys can be removed");
  if (a instanceof Response) return a;
  if (!CREDENTIAL_ID_RE.test(id)) return fail(404, "no such passkey");
  const n = await c.db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE account_id = ?").bind(a.account.id).first<{ n: number }>();
  const pw = await c.db.prepare("SELECT 1 AS x FROM passwords WHERE account_id = ?").bind(a.account.id).first();
  const methods = Number(n?.n ?? 0) + (a.account.google_sub ? 1 : 0) + (a.account.github_id ? 1 : 0) + (pw ? 1 : 0);
  const mine = await c.db.prepare("SELECT 1 AS x FROM credentials WHERE id = ? AND account_id = ?").bind(id, a.account.id).first();
  if (!mine) return fail(404, "no such passkey");
  if (methods <= 1) return fail(409, "this is your only way to sign in; add another passkey or a password, or link Google or GitHub first");
  if (!fresh(c, a)) return confirmFirst();
  await c.db.prepare("DELETE FROM credentials WHERE id = ? AND account_id = ?").bind(id, a.account.id).run();
  await revokeOthers(c, a);
  return noContent();
}

/**
 * DELETE /api/account { confirm: "delete" }: delete the signed-in account. Its passkeys, password, trusted browsers,
 * sessions, pending sign-in codes and the account row go. Apps created in the account (no private link) are deleted with their stats; apps
 * that still have a private link leave the account and keep working through that link, as before they were added.
 */
async function deleteAccount(c: C): Promise<Response> {
  const a = await browserWriter(c, "an account can be deleted");
  if (a instanceof Response) return a;
  const body = await readJson(c, 1024);
  if (body instanceof Response) return body;
  if (body.confirm !== "delete") return fail(400, 'send { "confirm": "delete" } to delete this account');
  const id = a.account.id;
  // every subscription of the account's Stripe customer is cancelled first: an account that no longer exists must
  // not be charged again (src/stripe.ts cancelForDeletion)
  const stop = await cancelForDeletion(c.env, c.opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)), await accountBilling(c.db, id), id);
  if (stop) return fail(stop.status, stop.error);
  const gone = await c.db.prepare("SELECT token FROM projects WHERE account_id = ? AND private_link = 0").bind(id).all<{ token: string }>();
  const own = "SELECT token FROM projects WHERE account_id = ? AND private_link = 0";
  const owned = "SELECT id FROM projects WHERE account_id = ?";
  await c.db.batch([
    // paid features of every app in the account (apps that keep a private link leave without them)
    c.db.prepare(`DELETE FROM integrations WHERE project_id IN (${owned})`).bind(id),
    c.db.prepare(`DELETE FROM forward_log WHERE project_id IN (${owned})`).bind(id),
    c.db.prepare("DELETE FROM export_keys WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM custom_requests WHERE account_id = ?").bind(id),
    ...["daily", "hourly", "recent", "sessions"].map((t) => c.db.prepare(`DELETE FROM ${t} WHERE token IN (${own})`).bind(id)),
    c.db.prepare("DELETE FROM projects WHERE account_id = ? AND private_link = 0").bind(id),
    c.db.prepare("UPDATE projects SET account_id = NULL WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM credentials WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM passwords WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM password_devices WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM auth_sessions WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM device_codes WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM challenges WHERE account_id = ?").bind(id),
    c.db.prepare("DELETE FROM accounts WHERE id = ?").bind(id),
  ]);
  for (const p of gone.results ?? []) forgetToken(p.token);
  await forgetExports(c.db, c.env.BUCKET, (gone.results ?? []).map((p) => p.token)).catch(() => undefined);
  return withCookies(noContent(), [clearCookie(c, c.cfg.session)]);
}

async function accountView(c: C, a: Auth): Promise<AccountView> {
  const iso = c.now.toISOString();
  const access = await accountAccess(c.db, a.account.id, c.env, c.now);
  const [creds, sessions, pw] = await c.db.batch([
    c.db.prepare("SELECT id, created, last_used, transports FROM credentials WHERE account_id = ? ORDER BY created").bind(a.account.id),
    c.db
      .prepare("SELECT id, kind, label, created, expires, last_used FROM auth_sessions WHERE account_id = ? AND revoked IS NULL AND expires > ? ORDER BY created DESC")
      .bind(a.account.id, iso),
    c.db.prepare("SELECT email, created, updated, last_used FROM passwords WHERE account_id = ?").bind(a.account.id),
  ]);
  const rows = (r: unknown) => ((r as { results?: Record<string, unknown>[] })?.results ?? []) as Record<string, unknown>[];
  const session = (r: Record<string, unknown>) => ({
    id: String(r.id),
    label: String(r.label ?? "Command line"),
    created: String(r.created),
    expires: String(r.expires),
    lastUsed: (r.last_used as string | null) ?? null,
    current: r.id === a.sessionId,
  });
  return {
    account: {
      id: a.account.id,
      email: a.account.email,
      emailVerified: !!a.account.email_verified,
      google: !!a.account.google_sub,
      githubLogin: a.account.github_id ? a.account.github_login : null,
      created: a.account.created,
    },
    projects: (await accountProjects(c, a.account.id)).map((p) => ({ ...projectJson(c, p), privateLink: !!p.private_link })),
    passkeys: rows(creds).map((r) => {
      let transports: string[] = [];
      try {
        transports = r.transports ? (JSON.parse(String(r.transports)) as string[]) : [];
      } catch {
        /* none */
      }
      return { id: String(r.id), created: String(r.created), lastUsed: (r.last_used as string | null) ?? null, transports };
    }),
    web: rows(sessions).filter((r) => r.kind === "web").map(session),
    cli: rows(sessions).filter((r) => r.kind === "cli").map(session),
    password: rows(pw).map((r) => ({ email: String(r.email), created: String(r.created), updated: String(r.updated), lastUsed: (r.last_used as string | null) ?? null }))[0] ?? null,
    providers: { google: c.cfg.google, github: c.cfg.github },
    // the one trial of Individual: offered while the plan is on sale and the account has no plan, grant or trial
    trial: onSale(TRIAL_PLAN) && access.source === null && !access.trialUsed ? { days: trialDays(c.env) } : null,
    pick: { trial: c.url.searchParams.get("trial") === "1" },
    recovery: RECOVERY_CONTACT,
  };
}

// --------------------------------------------------------------------------------------------- routes

/** The context the account routes use, for src/billing.ts (null without a database). */
export function accountContext(request: Request, url: URL, env: Env, opts: HandleOptions): C | null {
  if (!env.DB) return null;
  return { req: request, url, env, db: env.DB, opts, now: (opts.now ?? (() => new Date()))(), cfg: authConfig(env) };
}

const PREFIXES = ["/auth/", "/api/auth/", "/api/device/", "/api/account/", "/account/"];
const EXACT = new Set(["/signup", "/login", "/login/device", "/login/passkey", "/login/forgot", "/logout", "/account", "/api/me", "/api/account"]);

/** Account routes. Returns null for paths this module does not own (the caller continues routing). */
export async function routeAuth(request: Request, url: URL, path: string, env: Env, opts: HandleOptions): Promise<Response | null> {
  if (!EXACT.has(path) && !PREFIXES.some((p) => path.startsWith(p))) return null;
  if (!env.DB) {
    if (path.startsWith("/api/")) return fail(503, "accounts unavailable");
    return page(503, (n) => messagePage(n, { title: "Accounts are unavailable", text: "This GenClass server has no database configured.", links: [] }));
  }
  const c: C = { req: request, url, env, db: env.DB, opts, now: (opts.now ?? (() => new Date()))(), cfg: authConfig(env) };
  const m = request.method;
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
    case "/login/forgot":
      // no email sender yet (resetSender): the page says whom to write to
      return get ? page(200, (n) => forgotPage(n, { contact: RECOVERY_CONTACT })) : method();
    case "/login/passkey": {
      // the passkey step after Google or GitHub, for an account with a passkey (no session until it succeeds)
      if (!get) return method();
      const p = await mfaPending(c, false);
      if (!p) return page(400, (n) => messagePage(n, { title: "This sign-in expired", text: "The passkey step lasts 5 minutes. Sign in again.", links: [["Sign in", "/login"]] }), [clearCookie(c, c.cfg.mfa)]);
      const who = await accountById(c, p.account_id);
      return page(200, (n) => passkeyStepPage(n, { via: p.via, who: who ? (who.email ?? (who.github_login ? `@${who.github_login}` : null)) : null, recovery: RECOVERY_CONTACT }));
    }
    case "/logout": {
      if (get) return redirect("/account");
      if (!post) return method();
      if (!originOk(c)) return csrfFail();
      const a = await webSession(c);
      if (a) await c.db.prepare("UPDATE auth_sessions SET revoked = ? WHERE id = ? AND revoked IS NULL").bind(c.now.toISOString(), a.sessionId).run();
      return redirect("/login?signed_out=1", [clearCookie(c, c.cfg.session)], 303);
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
      // A code lookup is rate limited, and only a signed-in visitor learns whether a code is live: signed out, the
      // page shows the typed code and the ways to sign in, whatever the code is (no oracle for guessing codes).
      if (raw !== null && (await overLimit(c, "lookup"))) return tooManyPage();
      const a = await webSession(c);
      let request: DeviceView["request"] = null;
      if (code && a) {
        const r = await c.db
          .prepare("SELECT user_code, client, created, expires FROM device_codes WHERE user_code = ? AND status = 'pending' AND expires > ?")
          .bind(code, c.now.toISOString())
          .first<{ user_code: string; client: string | null; created: string; expires: string }>();
        if (r) request = { userCode: r.user_code, client: r.client && CLIENT_NAME_RE.test(r.client) ? r.client : null, created: r.created, expires: r.expires };
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
    case "/api/auth/passkey/mfa/options":
      return post ? passkeyStepOptions(c) : method();
    case "/api/auth/passkey/mfa/verify":
      return post ? passkeyStepVerify(c) : method();
    case "/api/auth/passkey/confirm/options":
      return post ? passkeyConfirmOptions(c) : method();
    case "/api/auth/passkey/confirm/verify":
      return post ? passkeyConfirmVerify(c) : method();
    case "/api/auth/pending":
      return post ? confirmPending(c) : method();
    case "/api/auth/password/signup":
      return post ? passwordSignup(c) : method();
    case "/api/auth/password/login":
      return post ? passwordLogin(c) : method();
    case "/api/auth/password":
      return post ? setPassword(c) : method();
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
    case "/api/account":
      return m === "DELETE" ? deleteAccount(c) : method();
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

  const sum = /^\/api\/account\/projects\/([^/]+)\/summary$/.exec(path);
  if (sum) {
    if (!get) return method();
    const a = await authenticate(c);
    if (!a) return signedOut();
    // the browser session or a CLI session: the approval page says a CLI session can read this summary
    const limited = await summaryLimited(env, request, `account:${a.account.id}`);
    if (limited) return limited;
    const p = await ownedProject(c, a.account.id, sum[1]!);
    if (!p) return fail(404, "not found");
    return json(200, await summary(c.db, p, summaryRange(url.searchParams.get("range")), c.now, summaryDashboard(`${c.cfg.origin}/account/apps/${p.id}`)));
  }
  const stat = /^\/api\/account\/projects\/([^/]+)\/stats$/.exec(path);
  if (stat) {
    if (!get) return method();
    const a = await authenticate(c);
    if (!a) return signedOut();
    // the dashboard reads stats with the browser session; a CLI session was approved for the summary only
    if (a.via !== "cookie") return fail(403, "a command line session cannot read the dashboard's stats (npx @genclass/runtime stats reads the summary); open the dashboard in the browser");
    const p = await ownedProject(c, a.account.id, stat[1]!);
    if (!p) return fail(404, "not found");
    // the dashboard is free (every plan has it; src/plans.ts accountAccess): the plan only sets the ranges it shows,
    // and a longer one is answered with the longest it shows
    const access = await accountAccess(c.db, a.account.id, env, c.now);
    const range = pickRange(url.searchParams.get("range"), viewRanges(access.plan));
    return json(200, await stats(c.db, p, range, c.now));
  }
  const link = /^\/api\/account\/projects\/([^/]+)\/link$/.exec(path);
  if (link) return m === "DELETE" ? turnOffLink(c, link[1]!) : method();
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
    const access = await accountAccess(c.db, a.account.id, env, c.now);
    const base = {
      account: { apps, current: p.id!, email: a.account.email ?? a.account.github_login },
      id: p.id!,
      firstEvent: p.first_event,
      privateLink: !!p.private_link,
      runtimeReady: runtimeHasTokens(env),
    };
    const project = { name: p.name, token: p.token, created: p.created, lastEvent: p.last_event };
    // plan-dependent parts: ranges, retention, forwarding and export (src/billing-pages.ts); the dashboard itself is
    // free, whatever the plan
    const extras = await appExtrasData(c.db, env, a.account.id, p, c.now);
    return page(200, (n) =>
      dashboardPage(n, project, {
        ...base,
        ranges: extras.ranges,
        keepDays: extras.keep,
        extra: appExtrasHtml(n, extras),
        // the trial's days left are said here, inside the dashboard, and nowhere else
        trialDaysLeft: access.source === "trial" && access.trialEndsAt ? trialDaysLeft(access.trialEndsAt, c.now) : undefined,
      }),
    );
  }

  if (path.startsWith("/api/")) return fail(404, "not found");
  return null;
}

function loginNotice(url: URL): string | null {
  if (url.searchParams.get("signed_out") === "1") return "You are signed out.";
  if (url.searchParams.get("deleted") === "1") return "Your account is deleted.";
  const e = url.searchParams.get("error");
  if (e === "google") return "Google sign-in was cancelled or refused. You can try again, or use your email and password.";
  if (e === "github") return "GitHub sign-in was cancelled or refused. You can try again, or use your email and password.";
  return null;
}

function accountNotice(url: URL): AccountView["notice"] {
  const q = url.searchParams;
  if (q.get("welcome") === "1") return { kind: "ok", text: "Your account is ready." };
  if (q.get("started") === "1") return { kind: "ok", text: `Your ${TRIAL_PLAN.name} trial has started.` };
  if (q.get("linked") === "google") return { kind: "ok", text: "Google is linked. You can now sign in with it." };
  if (q.get("linked") === "github") return { kind: "ok", text: "GitHub is linked. You can now sign in with it." };
  if (q.get("password") === "changed") return { kind: "ok", text: "Your password is changed. Every other browser and terminal is signed out." };
  if (q.get("password") === "added") return { kind: "ok", text: "Your password is set. You can now sign in with your email and password." };
  if (q.get("error") === "google_taken") return { kind: "bad", text: "That Google account is already linked to another GenClass account, so it was not linked here." };
  if (q.get("error") === "github_taken") return { kind: "bad", text: "That GitHub account is already linked to another GenClass account, so it was not linked here." };
  return undefined;
}

// --------------------------------------------------------------------------------------------- retention

/** Daily: expired challenges and device codes, expired or revoked sessions, and browsers not trusted any more. */
export async function authRetention(db: D1Like, now: Date): Promise<void> {
  const iso = now.toISOString();
  await db.batch([
    db.prepare("DELETE FROM challenges WHERE expires < ?").bind(iso),
    db.prepare("DELETE FROM device_codes WHERE expires < ?").bind(iso),
    db.prepare("DELETE FROM auth_sessions WHERE expires < ? OR revoked IS NOT NULL").bind(iso),
    db.prepare("DELETE FROM password_devices WHERE last_used < ?").bind(new Date(now.getTime() - DEVICE_MS).toISOString()),
  ]);
}
