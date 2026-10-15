import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The CLI's own request functions (packages/runtime/bin/lib/account.mjs), run against this worker below.
// @ts-expect-error plain ESM module without types
import * as cli from "../../packages/runtime/bin/lib/account.mjs";
import { handle, type Env, type HandleOptions } from "../src/collector.js";
import {
  authRetention,
  checkGoogleClaims,
  CLIENT_NAME_RE,
  CLI_TOKEN_RE,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  GOOGLE_TOKEN_URL,
  normalizeUserCode,
  runtimeHasTokens,
  safeNext,
  secretFromLink,
  USER_CODE_RE,
} from "../src/auth.js";
import { decodeCbor, decodeFirst } from "../src/cbor.js";
import { PROJECT_ID_RE, resetTokenCache, sha256Hex } from "../src/dashboard.js";
import { derToRaw } from "../src/webauthn.js";
import { b64url, cbor, FLAGS, makeAuthenticator, rawToDer } from "./authenticator.mjs";
import { d1 } from "./d1.js";

// Accounts (src/auth.ts): passkeys, sessions, CSRF, the device flow, owned projects, Google and GitHub sign-in.
// Requests go through the real router (handle) against node:sqlite running the real migrations.

const ORIGIN = "https://genclass.dev";
const T0 = new Date("2026-10-13T12:00:00Z");
let clock = new Date(T0);
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
type Auth = Awaited<ReturnType<typeof makeAuthenticator>>;

beforeEach(() => {
  clock = new Date(T0);
  resetTokenCache();
});

function setup(over: Partial<Env> = {}) {
  const sql = d1();
  const puts: string[] = [];
  const env: Env = { BUCKET: { async put(key: string) { puts.push(key); } }, DB: sql.api, ...over };
  return { env, sql, puts };
}

interface CallOpts {
  body?: unknown;
  cookie?: string;
  bearer?: string;
  /** null sends no Origin header */
  origin?: string | null;
  contentType?: string;
  fetch?: HandleOptions["fetch"];
  ip?: string;
}

async function call(env: Env, method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) headers.origin = origin;
  if (o.body !== undefined) headers["content-type"] = o.contentType ?? "application/json";
  if (o.cookie) headers.cookie = o.cookie;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.ip) headers["cf-connecting-ip"] = o.ip;
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  return handle(new Request(`${ORIGIN}${path}`, { method, headers, body }), env, { now: () => clock, fetch: o.fetch });
}

const cookies = (r: Response): string[] => r.headers.getSetCookie();
const cookieValue = (r: Response, name: string): string | null => {
  const c = cookies(r).find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(";")[0]! : null;
};
const sessionOf = (r: Response): string => {
  const v = cookieValue(r, "__Host-gc_session");
  if (!v) throw new Error("no session cookie");
  return `__Host-gc_session=${v}`;
};

async function signUp(env: Env, auth: Auth, email = "ada@example.com", over: Record<string, unknown> = {}) {
  const o = await call(env, "POST", "/api/auth/passkey/register/options", { body: { email } });
  expect(o.status).toBe(200);
  const opts = (await o.json()) as any;
  const credential = await auth.register(opts.publicKey, over);
  const res = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: opts.id, credential } });
  return { res, json: (await res.clone().json()) as any, opts, credential };
}

async function signIn(env: Env, auth: Auth, over: Record<string, unknown> = {}) {
  const o = await call(env, "POST", "/api/auth/passkey/login/options", { body: {} });
  expect(o.status).toBe(200);
  const opts = (await o.json()) as any;
  const credential = await auth.assert(opts.publicKey, over);
  const res = await call(env, "POST", "/api/auth/passkey/login/verify", { body: { id: opts.id, credential } });
  return { res, json: (await res.clone().json()) as any, opts, credential };
}

/** Set Google and GitHub aside on env; returns the function that puts them back. */
function withoutOAuth(env: Env): () => void {
  const keep = { GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET };
  for (const k of Object.keys(keep) as (keyof typeof keep)[]) delete env[k];
  return () => {
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) (env as unknown as Record<string, string>)[k] = v;
  };
}

/**
 * A passkey account, made the way passkey sign-up makes one: only on a server with no OAuth provider (the fallback).
 * In tests that configure Google or GitHub it stands for an account made before they were: they are set aside for the
 * sign-up and put back after it.
 */
async function signedIn(env: Env, email = "ada@example.com", alg = -7) {
  const auth = await makeAuthenticator(alg);
  const restore = withoutOAuth(env);
  let s;
  try {
    s = await signUp(env, auth, email);
  } finally {
    restore();
  }
  expect(s.res.status).toBe(200);
  return { auth, cookie: sessionOf(s.res), account: s.json.account as { id: string; email: string } };
}

/** Start the account's trial of Pro (dashboards come with Pro). */
async function startTrial(env: Env, cookie: string) {
  const r = await call(env, "POST", "/api/billing/trial", { body: {}, cookie });
  expect(r.status).toBe(200);
}

async function me(env: Env, o: CallOpts) {
  const r = await call(env, "GET", "/api/me", o);
  return { status: r.status, json: (await r.json()) as any };
}

async function cliToken(env: Env, cookie: string): Promise<string> {
  const code = (await (await call(env, "POST", "/api/device/code", { origin: null })).json()) as any;
  expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie })).status).toBe(200);
  const tok = (await (await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null })).json()) as any;
  expect(tok.access_token).toMatch(CLI_TOKEN_RE);
  return tok.access_token;
}

// ------------------------------------------------------------------------------------------------- passkeys

describe("accounts: passkey sign-up and sign-in (WebAuthn, attestation none)", () => {
  for (const [name, alg] of [["ES256", -7], ["RS256", -257]] as const) {
    it(`${name}: sign up stores the email unverified and the COSE public key, then sign in with the same passkey`, async () => {
      const { env, sql } = setup();
      const auth = await makeAuthenticator(alg);
      const up = await signUp(env, auth, "  Ada@Example.com ");
      expect(up.res.status).toBe(200);
      expect(up.opts.publicKey).toMatchObject({
        rp: { id: "genclass.dev", name: "GenClass" },
        attestation: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      });
      expect(up.opts.publicKey.user.name).toBe("Ada@Example.com");
      expect(up.json).toMatchObject({ ok: true, account: { email: "Ada@Example.com", github_login: null } });
      const set = cookies(up.res).find((c) => c.startsWith("__Host-gc_session="))!;
      expect(set).toMatch(/^__Host-gc_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);

      const [acct] = sql.rows("SELECT * FROM accounts");
      expect(acct).toMatchObject({ email: "Ada@Example.com", email_verified: 0, google_sub: null, github_id: null });
      const [cred] = sql.rows("SELECT * FROM credentials");
      expect(cred).toMatchObject({ id: auth.credentialId, account_id: acct!.id, alg, sign_count: 0, public_key: b64url(auth.cose) });
      expect(JSON.parse(String(cred!.transports))).toEqual(["internal", "hybrid"]);
      // the user handle is the account id
      expect(new TextDecoder().decode(Uint8Array.from(atob(up.opts.publicKey.user.id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))).toBe(acct!.id);

      expect(await me(env, { cookie: sessionOf(up.res) })).toEqual({ status: 200, json: { account: { id: acct!.id, email: "Ada@Example.com", github_login: null }, projects: [] } });

      // sign in: discoverable credential, no email
      const inn = await signIn(env, auth);
      expect(inn.opts.publicKey).toMatchObject({ rpId: "genclass.dev", userVerification: "required", allowCredentials: [] });
      expect(inn.res.status).toBe(200);
      expect(inn.json.account.id).toBe(acct!.id);
      expect(sql.rows("SELECT sign_count, last_used FROM credentials")[0]).toEqual({ sign_count: 1, last_used: T0.toISOString() });
      expect((await me(env, { cookie: sessionOf(inn.res) })).json.account.id).toBe(acct!.id);
    });
  }

  it("accepts any attestation format without verifying its statement", async () => {
    const { env } = setup();
    const auth = await makeAuthenticator(-7);
    const up = await signUp(env, auth, "ada@example.com", { fmt: "packed", attStmt: new Map<string, unknown>([["alg", -7], ["sig", new Uint8Array([1, 2, 3])]]) });
    expect(up.res.status).toBe(200);
  });

  it("refuses a wrong origin, RP ID, ceremony type, missing user verification and an unsupported algorithm at sign-up", async () => {
    const { env, sql } = setup();
    for (const [over, msg] of [
      [{ origin: "https://evil.example" }, /origin/],
      [{ origin: "http://genclass.dev" }, /origin/],
      [{ rpId: "evil.example" }, /relying party/],
      [{ type: "webauthn.get" }, /type/],
      [{ flags: FLAGS.UP | FLAGS.AT }, /verification/],
      [{ flags: FLAGS.UV | FLAGS.AT }, /presence/],
      [{ crossOrigin: true }, /cross-origin/],
      [{ cose: cbor(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]])) }, /algorithm/],
    ] as const) {
      const auth = await makeAuthenticator(-7);
      const up = await signUp(env, auth, "ada@example.com", over as Record<string, unknown>);
      expect(up.res.status, JSON.stringify(over)).toBe(400);
      expect(up.json.error).toMatch(msg);
      expect(cookieValue(up.res, "__Host-gc_session")).toBeNull();
    }
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
  });

  it("refuses a rawId that is not the attested credential id, and a bad email", async () => {
    const { env } = setup();
    const auth = await makeAuthenticator(-7);
    const up = await signUp(env, auth, "ada@example.com", { rawId: new Uint8Array(32).fill(7) });
    expect(up.res.status).toBe(400);
    for (const email of ["", "nope", "a@b", "<script>@x.io", "a b@example.com", 42]) {
      const r = await call(env, "POST", "/api/auth/passkey/register/options", { body: { email } });
      expect(r.status).toBe(400);
    }
  });

  it("challenges are single-use: a replayed registration or sign-in is refused", async () => {
    const { env } = setup();
    const auth = await makeAuthenticator(-7);
    const up = await signUp(env, auth);
    expect(up.res.status).toBe(200);
    const again = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: up.opts.id, credential: up.credential } });
    expect(again.status).toBe(400);
    const inn = await signIn(env, auth);
    expect(inn.res.status).toBe(200);
    const replay = await call(env, "POST", "/api/auth/passkey/login/verify", { body: { id: inn.opts.id, credential: inn.credential } });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toMatch(/expired/);
  });

  it("challenges expire after 5 minutes", async () => {
    const { env } = setup();
    const auth = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: { email: "ada@example.com" } })).json()) as any;
    const credential = await auth.register(o.publicKey);
    advance(5 * 60_000 + 1000);
    const r = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/expired/);
    // a challenge from another ceremony is not accepted either
    const lo = (await (await call(env, "POST", "/api/auth/passkey/login/options", { body: {} })).json()) as any;
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: lo.id, credential } })).status).toBe(400);
  });

  it("sign-in refuses a wrong origin or RP ID, a bad signature, missing UV, an unknown passkey and a mismatched user handle", async () => {
    const { env } = setup();
    const { auth } = await signedIn(env);
    for (const [over, msg] of [
      [{ origin: "https://genclass.dev.evil.example" }, /origin/],
      [{ rpId: "evil.example" }, /relying party/],
      [{ tamper: true }, /signature/],
      [{ flags: FLAGS.UP }, /verification/],
      [{ type: "webauthn.create" }, /type/],
      [{ challenge: b64url(new Uint8Array(32)) }, /challenge/],
      [{ userHandle: b64url(new TextEncoder().encode("someoneelse")) }, /user handle/],
    ] as const) {
      const r = await signIn(env, auth, over as Record<string, unknown>);
      expect(r.res.status, JSON.stringify(over)).toBe(400);
      expect(r.json.error).toMatch(msg);
    }
    const stranger = await makeAuthenticator(-7);
    stranger.userHandle = null;
    const r = await signIn(env, stranger);
    expect(r.res.status).toBe(400);
    expect(r.json.error).toMatch(/not registered/);
  });

  it("sign counter: a counter that does not increase is refused; authenticators that always send 0 still work", async () => {
    const { env } = setup();
    const { auth } = await signedIn(env);
    expect((await signIn(env, auth, { counter: 5 })).res.status).toBe(200);
    const same = await signIn(env, auth, { counter: 5 });
    expect(same.res.status).toBe(400);
    expect(same.json.error).toMatch(/counter/);
    expect((await signIn(env, auth, { counter: 3 })).res.status).toBe(400);
    expect((await signIn(env, auth, { counter: 6 })).res.status).toBe(200);

    const { env: env2 } = setup();
    const zero = await signedIn(env2, "zero@example.com");
    expect((await signIn(env2, zero.auth, { counter: 0 })).res.status).toBe(200);
    expect((await signIn(env2, zero.auth, { counter: 0 })).res.status).toBe(200);
  });

  it("a signed-in account adds a second passkey; the last way to sign in cannot be removed", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    const first = sql.rows("SELECT id FROM credentials")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie })).status).toBe(409);
    const second = await makeAuthenticator(-257);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie })).json()) as any;
    expect(o.publicKey.excludeCredentials).toEqual([{ type: "public-key", id: first }]);
    const credential = await second.register(o.publicKey);
    const v = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential }, cookie });
    expect(v.status).toBe(200);
    expect(cookieValue(v, "__Host-gc_session")).toBeNull();
    expect(sql.rows("SELECT account_id FROM credentials").map((r) => r.account_id)).toEqual([account.id, account.id]);
    expect((await signIn(env, second)).json.account.id).toBe(account.id);
    expect((await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie, origin: null })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie })).status).toBe(204);
    expect(sql.rows("SELECT COUNT(*) AS n FROM credentials")[0]!.n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------- sessions

describe("accounts: sessions, logout and CSRF", () => {
  it("stores only a hash of the session cookie, expires after 30 days, and logout revokes it", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const value = cookie.split("=")[1]!;
    expect(JSON.stringify(sql.rows("SELECT * FROM auth_sessions"))).not.toContain(value);
    expect(sql.rows("SELECT kind, expires FROM auth_sessions")[0]).toEqual({ kind: "web", expires: new Date(T0.getTime() + 30 * 86_400_000).toISOString() });

    const out = await call(env, "POST", "/logout", { cookie, body: "", contentType: "application/x-www-form-urlencoded" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/login?signed_out=1");
    expect(cookies(out).some((c) => c.startsWith("__Host-gc_session=;") && c.includes("Max-Age=0"))).toBe(true);
    expect((await me(env, { cookie })).status).toBe(401);

    const later = await signedIn(env, "bob@example.com");
    advance(30 * 86_400_000 + 1000);
    expect((await me(env, { cookie: later.cookie })).status).toBe(401);
  });

  it("CSRF: a cookie write without our Origin, or with a foreign one, is refused with 403 and changes nothing", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    for (const origin of [null, "https://evil.example", "http://genclass.dev", "null"]) {
      expect((await call(env, "POST", "/api/account/projects", { body: { name: "x" }, cookie, origin })).status).toBe(403);
      expect((await call(env, "POST", "/logout", { cookie, origin, body: "" })).status).toBe(403);
      expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret: "A".repeat(32) }, cookie, origin })).status).toBe(403);
      expect((await call(env, "POST", "/api/device/approve", { body: { user_code: "BCDF-GHJK", approve: true }, cookie, origin })).status).toBe(403);
      expect((await call(env, "DELETE", "/api/account/sessions/current", { cookie, origin })).status).toBe(403);
      expect((await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie, origin })).status).toBe(403);
      expect((await call(env, "POST", "/api/auth/passkey/login/options", { body: {}, origin })).status).toBe(403);
    }
    expect(sql.rows("SELECT COUNT(*) AS n FROM projects")[0]!.n).toBe(0);
    expect((await me(env, { cookie })).status).toBe(200);
    // the JSON endpoints the pages call require application/json (a cross-site form cannot send it)
    expect((await call(env, "POST", "/api/account/projects", { body: '{"name":"x"}', contentType: "text/plain", cookie })).status).toBe(415);
    expect((await call(env, "POST", "/api/account/projects", { body: "name=x", contentType: "application/x-www-form-urlencoded", cookie })).status).toBe(415);
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "x" }, cookie })).status).toBe(201);
  });

  it("account endpoints send no CORS headers and need a session", async () => {
    const { env } = setup();
    const r = await call(env, "GET", "/api/me", {});
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect((await call(env, "GET", "/api/account/projects", {})).status).toBe(401);
    expect((await call(env, "POST", "/api/account/projects", { body: {} })).status).toBe(401);
    // a web cookie is not a bearer token and a CLI token is not a cookie
    const { cookie } = await signedIn(env);
    expect((await me(env, { bearer: cookie.split("=")[1]!, origin: null })).status).toBe(401);
    const tok = await cliToken(env, cookie);
    expect((await me(env, { cookie: `__Host-gc_session=${tok}` })).status).toBe(401);
    expect((await me(env, { bearer: tok, origin: null })).status).toBe(200);
  });

  it("pages: /account needs a session; signed-in visitors skip /login; strict headers; names are escaped", async () => {
    const { env } = setup();
    const out = await call(env, "GET", "/account", {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe("/login?next=%2Faccount");
    const login = await call(env, "GET", "/login?next=//evil.example", {});
    expect(login.status).toBe(200);
    const csp = login.headers.get("content-security-policy")!;
    expect(csp).toMatch(/default-src 'none'; script-src 'nonce-[A-Za-z0-9]{22}'/);
    expect(csp).toContain("form-action 'self'");
    expect(login.headers.get("x-frame-options")).toBe("DENY");
    // with no-referrer, browsers send `Origin: null` on the same-origin sign-out form post; same-origin keeps it
    expect(login.headers.get("referrer-policy")).toBe("same-origin");
    const html = await login.text();
    expect(html).toContain('<meta name="referrer" content="same-origin">');
    expect(html).not.toContain("evil.example");
    expect(html).toContain("Sign in with a passkey");
    expect(html).not.toMatch(/ style="/);

    const { cookie } = await signedIn(env);
    expect((await call(env, "GET", "/login", { cookie })).headers.get("location")).toBe("/account");
    expect((await call(env, "GET", "/signup?next=/login/device?code=BCDF-GHJK", { cookie })).headers.get("location")).toBe("/login/device?code=BCDF-GHJK");
    const made = (await (await call(env, "POST", "/api/account/projects", { body: { name: "</script><img src=x onerror=alert(1)>" }, cookie })).json()) as any;
    for (const path of ["/account", `/account/apps/${made.project.id}`]) {
      const page = await call(env, "GET", path, { cookie });
      expect(page.status).toBe(200);
      const body = await page.text();
      expect(body).not.toContain("<img src=x");
      expect(body).not.toMatch(/ style="/);
      expect(body).toContain(made.project.token);
    }
  });
});

// ------------------------------------------------------------------------------------------------- device flow

describe("accounts: device flow for the CLI (RFC 8628)", () => {
  it("code, pending, slow_down, approval in the browser, token, /api/me, CLI logout", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    const c = await call(env, "POST", "/api/device/code", { body: { client_name: "genclass-runtime 0.3.0" }, origin: null });
    expect(c.status).toBe(200);
    const code = (await c.json()) as any;
    expect(code).toEqual({
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(USER_CODE_RE),
      verification_uri: "https://genclass.dev/login/device",
      verification_uri_complete: `https://genclass.dev/login/device?code=${code.user_code}`,
      expires_in: 600,
      interval: 5,
    });
    expect(JSON.stringify(sql.rows("SELECT * FROM device_codes"))).not.toContain(code.device_code);

    const poll = async () => {
      const r = await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null });
      return { status: r.status, json: (await r.json()) as any };
    };
    expect(await poll()).toMatchObject({ status: 400, json: { error: "authorization_pending" } });
    advance(1000);
    expect(await poll()).toMatchObject({ status: 400, json: { error: "slow_down", interval: 10 } });
    advance(6000);
    expect(await poll()).toMatchObject({ status: 400, json: { error: "slow_down", interval: 15 } });
    advance(15_000);
    expect(await poll()).toMatchObject({ status: 400, json: { error: "authorization_pending" } });

    // the approval page shows the code and the request; signed out it asks to sign in first
    const out = await (await call(env, "GET", `/login/device?code=${code.user_code.toLowerCase()}`, {})).text();
    expect(out).toContain("Sign in to continue");
    expect(out).toContain(code.user_code);
    expect(out).toContain(encodeURIComponent(`/login/device?code=${code.user_code}`));
    expect(out).not.toContain("genclass-runtime 0.3.0"); // signed out, nothing about the request is shown
    const page = await (await call(env, "GET", `/login/device?code=${code.user_code}`, { cookie })).text();
    expect(page).toContain("Approve this sign-in");
    expect(page).toContain("genclass-runtime 0.3.0");
    // the warning comes before the buttons, and the scope says what a CLI session can and cannot do
    expect(page.indexOf("Approve only a sign-in you started")).toBeLessThan(page.indexOf('id="yes"'));
    expect(page).toContain("It cannot read your apps' stats");

    const ap = await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code.replace("-", " ").toLowerCase(), approve: true }, cookie });
    expect(ap.status).toBe(200);
    advance(15_000);
    const tok = await poll();
    expect(tok.status).toBe(200);
    expect(tok.json).toEqual({ access_token: expect.stringMatching(CLI_TOKEN_RE), token_type: "Bearer", expires_in: 90 * 86_400, account: { id: account.id, email: "ada@example.com", github_login: null } });
    // used once
    advance(15_000);
    expect(await poll()).toMatchObject({ status: 400, json: { error: "expired_token" } });
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie })).status).toBe(404);

    const bearer = tok.json.access_token;
    expect(JSON.stringify(sql.rows("SELECT * FROM auth_sessions"))).not.toContain(bearer);
    expect(sql.rows("SELECT kind, label, expires FROM auth_sessions WHERE kind = 'cli'")[0]).toEqual({ kind: "cli", label: "genclass-runtime 0.3.0", expires: new Date(clock.getTime() - 15_000 + 90 * 86_400_000).toISOString() });
    expect(await me(env, { bearer, origin: null })).toEqual({ status: 200, json: { account: { id: account.id, email: "ada@example.com", github_login: null }, projects: [] } });
    const acct = await (await call(env, "GET", "/account", { cookie })).text();
    expect(acct).toContain("genclass-runtime 0.3.0");

    expect((await call(env, "DELETE", "/api/account/sessions/current", { bearer, origin: null })).status).toBe(204);
    expect((await me(env, { bearer, origin: null })).status).toBe(401);
    expect((await me(env, { cookie })).status).toBe(200);
  });

  it("deny, expiry, unknown codes, approval needs a session", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const mk = async () => (await (await call(env, "POST", "/api/device/code", { origin: null })).json()) as any;
    const poll = async (dc: string) => (await (await call(env, "POST", "/api/device/token", { body: { device_code: dc }, origin: null })).json()) as any;

    const a = await mk();
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: a.user_code, approve: true } })).status).toBe(401);
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: a.user_code, approve: false }, cookie })).status).toBe(200);
    expect((await poll(a.device_code)).error).toBe("access_denied");
    advance(10_000);
    expect((await poll(a.device_code)).error).toBe("expired_token");

    const b = await mk();
    advance(601_000);
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: b.user_code, approve: true }, cookie })).status).toBe(404);
    expect((await poll(b.device_code)).error).toBe("expired_token");
    const page = await (await call(env, "GET", `/login/device?code=${b.user_code}`, { cookie })).text();
    expect(page).toContain("This code is not valid");

    expect((await poll("x".repeat(43))).error).toBe("expired_token");
    expect((await poll("short")).error).toBe("invalid_request");
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: "AEIO-UAEI", approve: true }, cookie })).status).toBe(400);
    // RFC 8628 clients may post a form
    const c = await mk();
    const form = await call(env, "POST", "/api/device/token", { body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=${c.device_code}`, contentType: "application/x-www-form-urlencoded", origin: null });
    expect(((await form.json()) as any).error).toBe("authorization_pending");
  });

  it("user codes: 8 letters without vowels, accepted however they are typed", () => {
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJ")).toBeNull();
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull();
    expect(normalizeUserCode(7)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- projects

describe("accounts: apps owned by an account", () => {
  it("create with a bearer token, list, /api/me, stats once a batch arrives, first_event kept", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const bearer = await cliToken(env, cookie);
    const r = await call(env, "POST", "/api/account/projects", { body: { name: "Acme checkout" }, bearer, origin: null });
    expect(r.status).toBe(201);
    const { project } = (await r.json()) as any;
    expect(project).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      name: "Acme checkout",
      token: expect.stringMatching(/^gc_[A-Za-z0-9]{22}$/),
      dashboard_url: `https://genclass.dev/account/apps/${project.id}`,
      created: clock.toISOString(),
      last_event: null,
      first_event: null,
    });
    expect((await me(env, { bearer, origin: null })).json.projects).toEqual([project]);
    expect(((await (await call(env, "GET", "/api/account/projects", { cookie })).json()) as any).projects).toEqual([project]);

    const batch = (sid: string) => ({ schema: "genclass-telemetry/1", sid, sent: 1, runtime: "0.3.0", model: null, token: project.token, events: [{ t: "session", host: "shop.example", route: "/" }] });
    const t1 = clock.toISOString();
    expect((await handle(new Request(`${ORIGIN}/api/v1/events`, { method: "POST", body: JSON.stringify(batch("aaaaaaaaaaaa")), headers: { "content-type": "text/plain" } }), env, { now: () => clock })).status).toBe(202);
    advance(60_000);
    await handle(new Request(`${ORIGIN}/api/v1/events`, { method: "POST", body: JSON.stringify(batch("bbbbbbbbbbbb")), headers: { "content-type": "text/plain" } }), env, { now: () => clock });
    const [p] = ((await (await call(env, "GET", "/api/account/projects", { cookie })).json()) as any).projects;
    expect(p).toMatchObject({ first_event: t1, last_event: clock.toISOString() });
    // collected all along, shown once the account has Pro (here its trial)
    expect((await call(env, "GET", `/api/account/projects/${project.id}/stats?range=24h`, { cookie })).status).toBe(402);
    await startTrial(env, cookie);
    const st = await call(env, "GET", `/api/account/projects/${project.id}/stats?range=24h`, { cookie });
    expect(st.status).toBe(200);
    expect(((await st.json()) as any).totals.sessions).toBe(2);
    expect(sql.rows("SELECT account_id FROM projects")[0]!.account_id).toBeTruthy();
  });

  it("claim an existing secret-link app: it joins the account and its link keeps working", async () => {
    const { env } = setup();
    const a = await signedIn(env, "ada@example.com");
    const b = await signedIn(env, "bob@example.com");
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old app" }, origin: null })).json()) as any;
    const bearer = await cliToken(env, a.cookie);
    const claim = await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, bearer, origin: null });
    expect(claim.status).toBe(200);
    const { project } = (await claim.json()) as any;
    expect(project).toMatchObject({ name: "Old app", token: anon.token });
    // again: idempotent for the owner
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { secret: anon.dashboardUrl.split("/").pop() }, cookie: a.cookie })).status).toBe(200);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: b.cookie })).status).toBe(409);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: "https://genclass.dev/start" }, cookie: a.cookie })).status).toBe(400);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: `https://genclass.dev/dashboard/${"Z".repeat(32)}` }, cookie: a.cookie })).status).toBe(404);
    expect((await handle(new Request(anon.dashboardUrl), env, { now: () => clock })).status).toBe(200);
    expect((await me(env, { cookie: a.cookie })).json.projects.map((p: any) => p.token)).toEqual([anon.token]);
    expect((await me(env, { cookie: b.cookie })).json.projects).toEqual([]);
  });

  it("ownership: another account gets 404 for the app page, its stats and its sessions", async () => {
    const { env, sql } = setup();
    const a = await signedIn(env, "ada@example.com");
    const b = await signedIn(env, "bob@example.com");
    await startTrial(env, a.cookie);
    await startTrial(env, b.cookie);
    const { project } = (await (await call(env, "POST", "/api/account/projects", { body: { name: "Ada's app" }, cookie: a.cookie })).json()) as any;
    const own = await call(env, "GET", `/account/apps/${project.id}`, { cookie: a.cookie });
    expect(own.status).toBe(200);
    const html = await own.text();
    expect(html).toContain("Connect this app");
    expect(html).toContain("npx @genclass/runtime@beta login"); // latest on npm is 0.2.x until 0.3.0
    expect(html).toContain(`GenClass.init({ token: &#34;${project.token}&#34; })`);
    expect(html).toContain(`data-token=&#34;${project.token}&#34;`);
    expect(html).toContain("0.3.0-beta.0 or later");
    // as the runtime behaves (src/telemetry/config.ts isLocalHost; its console says so): a key does not make a
    // local host send, so the first event comes from a deployed page
    expect(html).toContain("Local hosts (localhost, *.local, *.test, private networks) do not send by default, even with a key");
    expect(html).not.toContain("send only when a key is set");
    expect(html).not.toContain("only send data with an explicit token");
    expect(html).toContain(`/api/account/projects/${project.id}/stats`);
    expect((await call(env, "GET", `/account/apps/${project.id}`, { cookie: b.cookie })).status).toBe(404);
    expect((await call(env, "GET", `/api/account/projects/${project.id}/stats`, { cookie: b.cookie })).status).toBe(404);
    expect((await call(env, "GET", "/account/apps/nothex", { cookie: a.cookie })).status).toBe(404);
    expect((await call(env, "GET", `/account/apps/${project.id}`, {})).headers.get("location")).toBe(`/login?next=${encodeURIComponent(`/account/apps/${project.id}`)}`);
    const aSession = sql.rows("SELECT s.id FROM auth_sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = 'ada@example.com'")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/sessions/${aSession}`, { cookie: b.cookie })).status).toBe(404);
    expect((await me(env, { cookie: a.cookie })).status).toBe(200);
    expect((await call(env, "DELETE", `/api/account/sessions/${aSession}`, { cookie: a.cookie })).status).toBe(204);
    expect((await me(env, { cookie: a.cookie })).status).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------------- rate limits

describe("accounts: rate limits (AUTH_LIMIT)", () => {
  it("limits sign-up, sign-in options and device codes; a limited poll answers slow_down; the IP is never the key", async () => {
    const keys: string[] = [];
    const counts = new Map<string, number>();
    const { env } = setup({
      AUTH_LIMIT: {
        async limit({ key }) {
          keys.push(key);
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { success: counts.get(key)! <= 2 };
        },
      },
    });
    const ip = "203.0.113.7";
    const signup = () => call(env, "POST", "/api/auth/passkey/register/options", { body: { email: "ada@example.com" }, ip });
    const login = () => call(env, "POST", "/api/auth/passkey/login/options", { body: {}, ip });
    const code = () => call(env, "POST", "/api/device/code", { origin: null, ip });
    for (const f of [signup, login, code]) {
      expect((await f()).status).toBe(200);
      expect((await f()).status).toBe(200);
      const r = await f();
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toBe("60");
    }
    expect((await call(env, "POST", "/api/auth/passkey/login/options", { body: {}, ip: "198.51.100.1" })).status).toBe(200);
    counts.clear();
    const dc = (await (await code()).json()) as any;
    for (let i = 0; i < 2; i++) {
      advance(6000);
      expect(((await (await call(env, "POST", "/api/device/token", { body: { device_code: dc.device_code }, origin: null, ip })).json()) as any).error).toBe("authorization_pending");
    }
    advance(6000);
    expect(((await (await call(env, "POST", "/api/device/token", { body: { device_code: dc.device_code }, origin: null, ip })).json()) as any).error).toBe("slow_down");
    expect(keys.join()).not.toContain(ip);
    // a broken limiter lets requests through
    const { env: env2 } = setup({ AUTH_LIMIT: { async limit() { throw new Error("down"); } } });
    expect((await call(env2, "POST", "/api/auth/passkey/login/options", { body: {} })).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------- Google

const GOOGLE = { GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "shh" };

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256", kid: "k" })}.${enc(claims)}.c2ln`;
}

interface GoogleRun {
  res: Response;
  calls: { url: string; body: URLSearchParams }[];
}

/** /auth/google, then Google's redirect back to the callback, with the token endpoint mocked. */
/**
 * The passkey step (/login/passkey) after a Google or GitHub sign-in of an account that has a passkey: the sign-in
 * answered with no session and the step's cookie; the account's passkey answers the step's options.
 */
async function passkeyStep(env: Env, signin: Response, auth: Auth) {
  expect(signin.status).toBe(302);
  expect(signin.headers.get("location")).toBe("/login/passkey");
  expect(cookieValue(signin, "__Host-gc_session")).toBeNull();
  const mfa = `__Host-gc_mfa=${cookieValue(signin, "__Host-gc_mfa")}`;
  const o = await call(env, "POST", "/api/auth/passkey/mfa/options", { body: {}, cookie: mfa });
  expect(o.status).toBe(200);
  const opts = (await o.json()) as any;
  const res = await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: opts.id, credential: await auth.assert(opts.publicKey) }, cookie: mfa });
  return { res, mfa, opts, json: (await res.clone().json()) as any };
}

async function google(env: Env, o: { claims?: (nonce: string) => Record<string, unknown>; cookie?: string; link?: boolean; next?: string; state?: (s: string) => string; query?: string; dropCookie?: boolean; tokenStatus?: number } = {}): Promise<GoogleRun> {
  const start = await call(env, "GET", `/auth/google${o.link ? "?link=1" : o.next ? `?next=${encodeURIComponent(o.next)}` : ""}`, { cookie: o.cookie, origin: null });
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  const nonce = loc.searchParams.get("nonce")!;
  const challenge = loc.searchParams.get("code_challenge")!;
  const oauth = cookieValue(start, "gc_oauth_google")!;
  const calls: GoogleRun["calls"] = [];
  const fetchMock = async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ url, body });
    expect(url).toBe(GOOGLE_TOKEN_URL);
    // PKCE: the verifier sent here hashes to the challenge sent to Google
    expect(b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier")!))))).toBe(challenge);
    const claims = o.claims ? o.claims(nonce) : { iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: Math.floor(clock.getTime() / 1000) + 3600, nonce, sub: "g-1001", email: "ada@gmail.com", email_verified: true };
    return new Response(JSON.stringify({ access_token: "ya29.x", id_token: jwt(claims), token_type: "Bearer" }), { status: o.tokenStatus ?? 200, headers: { "content-type": "application/json" } });
  };
  const q = o.query ?? `state=${encodeURIComponent(o.state ? o.state(state) : state)}&code=4%2Fabc`;
  const jar = [o.dropCookie ? "" : `gc_oauth_google=${oauth}`, o.cookie ?? ""].filter(Boolean).join("; ");
  const res = await call(env, "GET", `/auth/google/callback?${q}`, { cookie: jar || undefined, origin: null, fetch: fetchMock });
  return { res, calls };
}

describe("accounts: Google sign-in (OIDC code flow, PKCE, confidential client)", () => {
  it("redirects to Google with state, nonce, PKCE S256 and the callback derived from the origin", async () => {
    const { env } = setup(GOOGLE);
    const r = await call(env, "GET", "/auth/google?next=%2Flogin%2Fdevice%3Fcode%3DBCDF-GHJK", { origin: null });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({
      client_id: GOOGLE.GOOGLE_CLIENT_ID,
      redirect_uri: "https://genclass.dev/auth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = cookies(r).find((c) => c.startsWith("gc_oauth_google="))!;
    expect(set).toMatch(/; Path=\/auth\/google; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    expect(set).not.toContain("shh");
    // the cookie names a server-side row; state, nonce and verifier never leave the server except to Google
    const id = cookieValue(r, "gc_oauth_google")!;
    expect(id).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(set).not.toContain(loc.searchParams.get("nonce")!);
  });

  it("a forged state cookie that names an account to link is refused (the cookie is only a row id now)", async () => {
    const { env, sql } = setup(GOOGLE);
    const victim = await signedIn(env, "ada@example.com");
    const start = await call(env, "GET", "/auth/google", { origin: null });
    const loc = new URL(start.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    // the format the cookie had before: unsigned JSON with the account to link
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ s: state, n: loc.searchParams.get("nonce"), v: "x".repeat(43), next: null, link: victim.account.id })));
    let called = 0;
    const res = await call(env, "GET", `/auth/google/callback?state=${state}&code=4%2Fabc`, {
      cookie: `gc_oauth_google=${forged}; ${victim.cookie}`,
      origin: null,
      fetch: async () => {
        called++;
        return new Response("{}", { status: 500 });
      },
    });
    expect(res.status).toBe(400);
    expect(called).toBe(0);
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", victim.account.id)[0]!.google_sub).toBeNull();
  });

  it("a Link started by another session is refused: a planted flow cannot attach a Google account to the victim", async () => {
    const { env, sql } = setup(GOOGLE);
    const victim = await signedIn(env, "ada@example.com");
    const attacker = await signedIn(env, "mallory@example.com");
    // the attacker starts Link Google in their own browser and completes Google's consent with their Google account
    const start = await call(env, "GET", "/auth/google?link=1", { cookie: attacker.cookie, origin: null });
    const loc = new URL(start.headers.get("location")!);
    const nonce = loc.searchParams.get("nonce")!;
    const fetchMock = async () =>
      new Response(JSON.stringify({ id_token: jwt({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: Math.floor(clock.getTime() / 1000) + 600, nonce, sub: "g-mallory", email: "m@gmail.com", email_verified: true }) }), { status: 200 });
    // ...then plants that flow's cookie in the victim's browser and sends the victim to the callback
    const res = await call(env, "GET", `/auth/google/callback?state=${loc.searchParams.get("state")}&code=4%2Fabc`, {
      cookie: `gc_oauth_google=${cookieValue(start, "gc_oauth_google")}; ${victim.cookie}`,
      origin: null,
      fetch: fetchMock,
    });
    expect(res.status).toBe(403);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts WHERE google_sub IS NOT NULL")[0]!.n).toBe(0);
  });

  it("the failure page says what to do in one sentence; the failed check is a small detail line", async () => {
    const { env } = setup(GOOGLE);
    const { res } = await google(env, { claims: (n) => ({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: Math.floor(clock.getTime() / 1000) + 600, nonce: `${n}x`, sub: "g-1" }) });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Google&#39;s answer could not be checked. This happens when the sign-in took too long or was finished in another tab. Start again.");
    expect(html).toContain('<p class="detail">Check that failed: nonce does not match</p>');
  });

  it("happy path: a first Google sign-in creates an account (verified email, sub) and a session, and clears the cookie", async () => {
    const { env, sql } = setup(GOOGLE);
    const { res, calls } = await google(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account?welcome=1");
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.body)).toMatchObject({ code: "4/abc", client_id: GOOGLE.GOOGLE_CLIENT_ID, client_secret: "shh", redirect_uri: "https://genclass.dev/auth/google/callback", grant_type: "authorization_code" });
    expect(cookies(res).some((c) => c.startsWith("gc_oauth_google=;") && c.includes("Max-Age=0"))).toBe(true);
    const [a] = sql.rows("SELECT * FROM accounts");
    expect(a).toMatchObject({ email: "ada@gmail.com", email_verified: 1, google_sub: "g-1001" });
    expect((await me(env, { cookie: sessionOf(res) })).json.account.id).toBe(a!.id);
    // the second time: the same account, no new one
    const again = await google(env);
    expect(again.res.headers.get("location")).toBe("/account");
    expect((await me(env, { cookie: sessionOf(again.res) })).json.account.id).toBe(a!.id);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(1);
  });

  const now = () => Math.floor(clock.getTime() / 1000);
  const base = (nonce: string) => ({ iss: "accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: now() + 600, nonce, sub: "g-7", email: "x@gmail.com", email_verified: true });
  for (const [name, claims] of [
    ["nonce mismatch", (n: string) => ({ ...base(n), nonce: "other" })],
    ["wrong aud", (n: string) => ({ ...base(n), aud: "someone-else.apps.googleusercontent.com" })],
    ["wrong iss", (n: string) => ({ ...base(n), iss: "https://evil.example" })],
    ["expired token", (n: string) => ({ ...base(n), exp: now() - 1 })],
    ["no sub", (n: string) => ({ ...base(n), sub: undefined })],
  ] as const) {
    it(`refuses an id_token with ${name}: no account, no session`, async () => {
      const { env, sql } = setup(GOOGLE);
      const { res } = await google(env, { claims });
      expect(res.status).toBe(400);
      expect(cookieValue(res, "__Host-gc_session")).toBeNull();
      expect(cookies(res).some((c) => c.startsWith("gc_oauth_google=;"))).toBe(true);
      expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
    });
  }

  it("refuses a mismatched or missing state, and an error parameter, without calling Google", async () => {
    const { env, sql } = setup(GOOGLE);
    const mismatch = await google(env, { state: (s) => `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}` });
    expect(mismatch.res.status).toBe(400);
    expect(mismatch.calls).toHaveLength(0);
    const nocookie = await google(env, { dropCookie: true });
    expect(nocookie.res.status).toBe(400);
    expect(nocookie.calls).toHaveLength(0);
    const nostate = await google(env, { query: "code=abc" });
    expect(nostate.res.status).toBe(400);
    const err = await google(env, { query: "error=access_denied&state=x" });
    expect(err.res.status).toBe(302);
    expect(err.res.headers.get("location")).toBe("/login?error=google");
    expect(err.calls).toHaveLength(0);
    expect(cookies(err.res).some((c) => c.startsWith("gc_oauth_google=;"))).toBe(true);
    const bad = await google(env, { tokenStatus: 400 });
    expect(bad.res.status).toBe(502);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
  });

  it("linking rule: a Google sign-in never takes over a passkey account with the same email; the person chooses", async () => {
    const { env, sql } = setup(GOOGLE);
    const victim = await signedIn(env, "ada@gmail.com");
    const g = (n: string) => ({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: now() + 600, nonce: n, sub: "g-ada", email: "ADA@gmail.com", email_verified: true });
    const { res } = await google(env, { claims: g });
    expect(res.status).toBe(200);
    expect(cookieValue(res, "__Host-gc_session")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This email already has a GenClass account");
    expect(html).toContain("Link Google");
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", victim.account.id)[0]!.google_sub).toBeNull();
    const pending = cookieValue(res, "__Host-gc_pending")!;
    expect(pending).toMatch(/^[A-Za-z0-9]{22}$/);

    // "Create a separate account"
    expect((await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `__Host-gc_pending=${pending}`, origin: null })).status).toBe(403);
    const ok = await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `__Host-gc_pending=${pending}` });
    expect(ok.status).toBe(200);
    expect(await ok.clone().json()).toEqual({ ok: true, next: "/account?welcome=1" });
    const mine = await me(env, { cookie: sessionOf(ok) });
    expect(mine.json.account.id).not.toBe(victim.account.id);
    expect(mine.json.account.email).toBe("ADA@gmail.com");
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(2);
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", victim.account.id)[0]!.google_sub).toBeNull();
    // the pending choice is single-use
    expect((await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `__Host-gc_pending=${pending}` })).status).toBe(400);
  });

  it("Link Google while signed in attaches it to that account; later Google sign-ins open it; a taken Google account is refused", async () => {
    const { env, sql } = setup(GOOGLE);
    const ada = await signedIn(env, "ada@example.com");
    const linkClaims = (n: string) => ({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: now() + 600, nonce: n, sub: "g-linked", email: "ada.work@gmail.com", email_verified: true });
    // link=1 needs a session
    expect((await call(env, "GET", "/auth/google?link=1", { origin: null })).headers.get("location")).toBe("/login?next=%2Faccount");
    const linked = await google(env, { link: true, cookie: ada.cookie, claims: linkClaims });
    expect(linked.res.status).toBe(302);
    expect(linked.res.headers.get("location")).toBe("/account?linked=google");
    expect(sql.rows("SELECT google_sub, email FROM accounts WHERE id = ?", ada.account.id)[0]).toEqual({ google_sub: "g-linked", email: "ada@example.com" });
    // Ada's account has a passkey, so Google alone opens no session: the passkey step does
    const via = await google(env, { claims: linkClaims });
    const step = await passkeyStep(env, via.res, ada.auth);
    expect(step.res.status).toBe(200);
    expect((await me(env, { cookie: sessionOf(step.res) })).json.account.id).toBe(ada.account.id);

    // the link flow is bound to the account that started it
    const bob = await signedIn(env, "bob@example.com");
    const taken = await google(env, { link: true, cookie: bob.cookie, claims: linkClaims });
    expect(taken.res.headers.get("location")).toBe("/account?error=google_taken");
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", bob.account.id)[0]!.google_sub).toBeNull();
  });

  it("buttons: Google and GitHub are shown only when their secrets are set", async () => {
    const none = await (await call(setup().env, "GET", "/login", {})).text();
    expect(none).not.toContain("Continue with Google");
    expect(none).not.toContain("Continue with GitHub");
    expect((await call(setup().env, "GET", "/auth/google", { origin: null })).status).toBe(404);
    const g = await (await call(setup(GOOGLE).env, "GET", "/signup", {})).text();
    expect(g).toContain("Continue with Google");
    expect(g).not.toContain("Continue with GitHub");
    const both = await (await call(setup({ ...GOOGLE, GITHUB_CLIENT_ID: "Iv1.x", GITHUB_CLIENT_SECRET: "y" }).env, "GET", "/login", {})).text();
    expect(both.indexOf("Continue with Google")).toBeLessThan(both.indexOf("Continue with GitHub"));
    expect(both.indexOf("Continue with GitHub")).toBeLessThan(both.indexOf("Use a passkey"));
  });

  it("claim checks (unit)", () => {
    const n = "nonce-1";
    const t = new Date("2026-10-13T12:00:00Z");
    const ok = { iss: "https://accounts.google.com", aud: "c", exp: t.getTime() / 1000 + 10, nonce: n, sub: "1" };
    expect(checkGoogleClaims(ok, "c", n, t)).toBeNull();
    expect(checkGoogleClaims({ ...ok, aud: ["c", "d"], azp: "c" }, "c", n, t)).toBeNull();
    expect(checkGoogleClaims({ ...ok, aud: ["c", "d"], azp: "d" }, "c", n, t)).toMatch(/audience/);
    expect(checkGoogleClaims(null, "c", n, t)).toMatch(/id_token/);
  });
});

// ------------------------------------------------------------------------------------------------- GitHub

const GITHUB = { GITHUB_CLIENT_ID: "Iv1.abc", GITHUB_CLIENT_SECRET: "gh-shh" };

describe("accounts: GitHub sign-in (OAuth web flow)", () => {
  async function github(env: Env, o: { state?: (s: string) => string; cookie?: string; link?: boolean; id?: number; query?: string } = {}) {
    const start = await call(env, "GET", `/auth/github${o.link ? "?link=1" : ""}`, { cookie: o.cookie, origin: null });
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://genclass.dev/auth/github/callback");
    const state = loc.searchParams.get("state")!;
    const calls: string[] = [];
    const fetchMock = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url === GITHUB_TOKEN_URL) {
        expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe("gh-shh");
        return new Response(JSON.stringify({ access_token: "gho_x", token_type: "bearer" }), { status: 200 });
      }
      expect(url).toBe(GITHUB_USER_URL);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer gho_x");
      return new Response(JSON.stringify({ id: o.id ?? 4242, login: "octo-ada", email: "public@example.com" }), { status: 200 });
    };
    const jar = [`gc_oauth_github=${cookieValue(start, "gc_oauth_github")}`, o.cookie ?? ""].filter(Boolean).join("; ");
    const q = o.query ?? `code=c0de&state=${o.state ? o.state(state) : state}`;
    const res = await call(env, "GET", `/auth/github/callback?${q}`, { cookie: jar, origin: null, fetch: fetchMock });
    return { res, calls };
  }

  it("an error parameter (consent refused) sends you back to sign-in without calling GitHub, and clears the cookie", async () => {
    const { env, sql } = setup(GITHUB);
    const { res, calls } = await github(env, { query: "error=access_denied&state=x" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=github");
    expect(calls).toHaveLength(0);
    expect(cookies(res).some((c) => c.startsWith("gc_oauth_github=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
    // the flow it started is used up: the same cookie cannot finish a sign-in later
    expect(sql.rows("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'oauth:github'")[0]!.n).toBe(0);
  });

  it("Link GitHub while signed in sets the GitHub id and login on that account; a GitHub account linked elsewhere is refused", async () => {
    const { env, sql } = setup(GITHUB);
    const ada = await signedIn(env, "ada@example.com");
    const linked = await github(env, { link: true, cookie: ada.cookie });
    expect(linked.res.status).toBe(302);
    expect(linked.res.headers.get("location")).toBe("/account?linked=github");
    expect(sql.rows("SELECT github_id, github_login, email FROM accounts WHERE id = ?", ada.account.id)[0]).toEqual({ github_id: "4242", github_login: "octo-ada", email: "ada@example.com" });
    // signing in with GitHub now opens Ada's account, after its passkey (the account has one)
    const via = await github(env);
    const step = await passkeyStep(env, via.res, ada.auth);
    expect((await me(env, { cookie: sessionOf(step.res) })).json.account.id).toBe(ada.account.id);
    const bob = await signedIn(env, "bob@example.com");
    const taken = await github(env, { link: true, cookie: bob.cookie });
    expect(taken.res.headers.get("location")).toBe("/account?error=github_taken");
    expect(sql.rows("SELECT github_id FROM accounts WHERE id = ?", bob.account.id)[0]!.github_id).toBeNull();
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(2);
  });

  it("refuses a state mismatch without calling GitHub", async () => {
    const { env, sql } = setup(GITHUB);
    const { res, calls } = await github(env, { state: (s) => `${s.slice(0, -2)}xx` });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(cookieValue(res, "__Host-gc_session")).toBeNull();
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
  });

  it("a first sign-in creates an account keyed by the GitHub id (no email kept); the next one opens it", async () => {
    const { env, sql } = setup(GITHUB);
    const first = await github(env);
    expect(first.res.status).toBe(302);
    expect(first.calls).toEqual([GITHUB_TOKEN_URL, GITHUB_USER_URL]);
    expect(sql.rows("SELECT email, github_id, github_login FROM accounts")).toEqual([{ email: null, github_id: "4242", github_login: "octo-ada" }]);
    const m = await me(env, { cookie: sessionOf(first.res) });
    expect(m.json.account).toMatchObject({ email: null, github_login: "octo-ada" });
    const second = await github(env);
    expect((await me(env, { cookie: sessionOf(second.res) })).json.account.id).toBe(m.json.account.id);
    expect(JSON.stringify(sql.rows("SELECT * FROM accounts"))).not.toContain("gho_x");
  });
});

// ------------------------------------------------------------------------------------------------- Google first

describe("accounts: Google first; creating an account never needs a passkey", () => {
  it("with Google or GitHub configured, /signup offers only them, passkey sign-up is refused, and /login leads with them", async () => {
    for (const over of [GOOGLE, GITHUB, { ...GOOGLE, ...GITHUB }]) {
      const { env, sql } = setup(over);
      const signup = await (await call(env, "GET", "/signup", {})).text();
      expect(signup).toContain(over === GITHUB ? "Continue with GitHub" : "Continue with Google");
      expect(signup).not.toContain('<form id="f"');
      expect(signup).not.toContain("Create account with a passkey");
      expect(signup).toContain("Add a passkey on your account page once you are in.");
      const r = await call(env, "POST", "/api/auth/passkey/register/options", { body: { email: "ada@example.com" } });
      expect(r.status).toBe(403);
      expect(((await r.json()) as any).error).toMatch(/Google or GitHub/);
      expect(sql.rows("SELECT COUNT(*) AS n FROM challenges")[0]!.n).toBe(0);
      const login = await (await call(env, "GET", "/login", {})).text();
      expect(login).toContain("Use a passkey");
      expect(login).not.toContain("Sign in with a passkey");
      expect(login).toContain("Dashboards come with Pro. Trials available.");
      // a passkey still signs in directly
      expect((await call(env, "POST", "/api/auth/passkey/login/options", { body: {} })).status).toBe(200);
    }
  });

  it("with no OAuth provider configured, passkey sign-up is the fallback, so the site always has a way in", async () => {
    const { env } = setup();
    const signup = await (await call(env, "GET", "/signup", {})).text();
    expect(signup).not.toContain("Continue with Google");
    expect(signup).not.toContain("Continue with GitHub");
    expect(signup).toContain("Create account with a passkey");
    expect(await (await call(env, "GET", "/login", {})).text()).toContain("Sign in with a passkey");
    const auth = await makeAuthenticator(-7);
    const up = await signUp(env, auth);
    expect(up.res.status).toBe(200);
    // a sign-up started before Google was configured cannot finish after it
    const late = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: { email: "late@example.com" } })).json()) as any;
    Object.assign(env, GOOGLE);
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await late.register(o.publicKey) } })).status).toBe(403);
  });

  it("a first Google sign-in makes an account with no passkey; /account offers one as extra security, off until added", async () => {
    const { env, sql } = setup(GOOGLE);
    const { res } = await google(env);
    expect(res.headers.get("location")).toBe("/account?welcome=1");
    const cookie = sessionOf(res);
    expect(sql.rows("SELECT COUNT(*) AS n FROM credentials")[0]!.n).toBe(0);
    const page = await (await call(env, "GET", "/account", { cookie })).text();
    expect(page).toContain('<section class="blk" id="security">');
    expect(page).toContain("<b>Require a passkey at sign-in: off.</b>");
    expect(page).toContain('id="addpk"');
    expect(page).toContain('Lost all your passkeys? Email <a href="mailto:mehar@daybot.ca?subject=GenClass%20passkeys">mehar@daybot.ca</a>.');
    expect(page.indexOf("<td>Google</td>")).toBeLessThan(page.indexOf('id="addpk"'));
    // the first passkey needs no other one
    const auth = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie })).json()) as any;
    expect(o.publicKey.user.name).toBe("ada@gmail.com");
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await auth.register(o.publicKey) }, cookie })).status).toBe(200);
    expect(await (await call(env, "GET", "/account", { cookie })).text()).toContain("<b>Require a passkey at sign-in: on.</b>");
  });
});

describe("accounts: a passkey as extra security (the passkey step after Google or GitHub)", () => {
  /** A Google account (sub g-1001, ada@gmail.com) that added one passkey on /account; its session and the authenticator. */
  async function googleWithPasskey(env: Env) {
    const { res } = await google(env);
    const cookie = sessionOf(res);
    const auth = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie })).json()) as any;
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await auth.register(o.publicKey) }, cookie })).status).toBe(200);
    return { cookie, auth, id: (await me(env, { cookie })).json.account.id as string };
  }

  it("Google alone grants no session once the account has a passkey; the passkey step does, once", async () => {
    const { env, sql } = setup(GOOGLE);
    const ada = await googleWithPasskey(env);
    const { res } = await google(env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login/passkey");
    expect(cookieValue(res, "__Host-gc_session")).toBeNull();
    const set = cookies(res).find((c) => c.startsWith("__Host-gc_mfa="))!;
    expect(set).toMatch(/^__Host-gc_mfa=[A-Za-z0-9]{22}; Path=\/; Max-Age=300; HttpOnly; SameSite=Lax; Secure$/);
    const mfa = set.split(";")[0]!;
    // the pending step is not a session anywhere
    expect((await me(env, { cookie: mfa })).status).toBe(401);
    expect((await call(env, "GET", "/account", { cookie: mfa })).status).toBe(302);
    const step = await (await call(env, "GET", "/login/passkey", { cookie: mfa })).text();
    expect(step).toContain("Use your passkey");
    expect(step).toContain("Google signed you in as <b>ada@gmail.com</b>");
    expect(step).toContain("Lost your passkeys? Email");
    // options name this account's passkeys only, and need our Origin
    expect((await call(env, "POST", "/api/auth/passkey/mfa/options", { body: {}, cookie: mfa, origin: "https://evil.example" })).status).toBe(403);
    const o = (await (await call(env, "POST", "/api/auth/passkey/mfa/options", { body: {}, cookie: mfa })).json()) as any;
    expect(o.publicKey.allowCredentials).toEqual([{ type: "public-key", id: ada.auth.credentialId, transports: ["internal", "hybrid"] }]);
    expect(o.publicKey.userVerification).toBe("required");
    expect((await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o.id, credential: await ada.auth.assert(o.publicKey) }, cookie: mfa, origin: null })).status).toBe(403);
    const ok = await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o.id, credential: await ada.auth.assert(o.publicKey) }, cookie: mfa });
    expect(ok.status).toBe(200);
    expect(await ok.clone().json()).toMatchObject({ ok: true, next: "/account", account: { id: ada.id } });
    const session = sessionOf(ok);
    expect((await me(env, { cookie: session })).json.account.id).toBe(ada.id);
    expect(cookies(ok).some((c) => c.startsWith("__Host-gc_mfa=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(sql.rows("SELECT passkey_at FROM auth_sessions WHERE hash = ?", await sha256Hex(session.split("=")[1]!))).toEqual([{ passkey_at: clock.toISOString() }]);
    // single use: the step and its challenge are gone
    expect(sql.rows("SELECT COUNT(*) AS n FROM challenges WHERE kind IN ('mfa', 'mfa-login')")[0]!.n).toBe(0);
    expect((await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o.id, credential: await ada.auth.assert(o.publicKey) }, cookie: mfa })).status).toBe(400);
    expect((await call(env, "POST", "/api/auth/passkey/mfa/options", { body: {}, cookie: mfa })).status).toBe(400);
    expect((await call(env, "GET", "/login/passkey", { cookie: mfa })).status).toBe(400);
    // a passkey alone also signs in
    expect((await signIn(env, ada.auth)).json.account.id).toBe(ada.id);
  });

  it("the step refuses another account's passkey, a missing cookie, a challenge from another step, and an expired step", async () => {
    const { env } = setup(GOOGLE);
    const ada = await googleWithPasskey(env);
    const bob = await signedIn(env, "bob@example.com");
    const begin = async () => `__Host-gc_mfa=${cookieValue((await google(env)).res, "__Host-gc_mfa")}`;
    const opts = async (mfa: string) => (await (await call(env, "POST", "/api/auth/passkey/mfa/options", { body: {}, cookie: mfa })).json()) as any;
    const mfa = await begin();
    const o1 = await opts(mfa);
    const wrong = await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o1.id, credential: await bob.auth.assert(o1.publicKey) }, cookie: mfa });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error).toMatch(/another GenClass account/);
    const o2 = await opts(mfa);
    expect((await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o2.id, credential: await ada.auth.assert(o2.publicKey) } })).status).toBe(400);
    // a challenge from one step does not finish another
    const other = await begin();
    const o3 = await opts(other);
    expect((await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o3.id, credential: await ada.auth.assert(o3.publicKey) }, cookie: mfa })).status).toBe(400);
    // the step lasts 5 minutes
    const o4 = await opts(mfa);
    advance(5 * 60_000 + 1000);
    const late = await call(env, "POST", "/api/auth/passkey/mfa/verify", { body: { id: o4.id, credential: await ada.auth.assert(o4.publicKey) }, cookie: mfa });
    expect(late.status).toBe(400);
    expect(cookieValue(late, "__Host-gc_session")).toBeNull();
    const page = await call(env, "GET", "/login/passkey", { cookie: mfa });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("This sign-in expired");
  });

  it("the CLI's device flow rides on the web session, so it waits for the passkey step", async () => {
    const { env } = setup(GOOGLE);
    const ada = await googleWithPasskey(env);
    const code = (await (await call(env, "POST", "/api/device/code", { body: { client_name: "genclass-runtime 0.3.0" }, origin: null })).json()) as any;
    const next = `/login/device?code=${code.user_code}`;
    const { res } = await google(env, { next });
    const mfa = `__Host-gc_mfa=${cookieValue(res, "__Host-gc_mfa")}`;
    // Google done, passkey not yet: still signed out for the approval page and the approval
    const half = await (await call(env, "GET", next, { cookie: mfa })).text();
    expect(half).toContain("Sign in to continue");
    expect(half).not.toContain("genclass-runtime 0.3.0");
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie: mfa })).status).toBe(401);
    const pending = await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null });
    expect(((await pending.json()) as any).error).toBe("authorization_pending");
    // the step, then back to the approval page, signed in
    const step = await passkeyStep(env, res, ada.auth);
    expect(step.json.next).toBe(next);
    const cookie = sessionOf(step.res);
    expect(await (await call(env, "GET", next, { cookie })).text()).toContain("Approve this sign-in");
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie })).status).toBe(200);
    advance(6000);
    const tok = await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null });
    expect(tok.status).toBe(200);
    expect(((await tok.json()) as any).account.id).toBe(ada.id);
  });

  it("adding a second passkey and removing one need a passkey in this session within 5 minutes; removing the last turns the step off", async () => {
    const { env, sql } = setup(GOOGLE);
    const ada = await googleWithPasskey(env); // its session came from Google: no passkey in it yet
    const asked = await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie: ada.cookie });
    expect(asked.status).toBe(403);
    expect(await asked.json()).toEqual({ ok: false, error: "confirm with one of your passkeys first", confirm: true });
    const confirm = async (auth: Auth) => {
      const co = (await (await call(env, "POST", "/api/auth/passkey/confirm/options", { body: {}, cookie: ada.cookie })).json()) as any;
      return call(env, "POST", "/api/auth/passkey/confirm/verify", { body: { id: co.id, credential: await auth.assert(co.publicKey) }, cookie: ada.cookie });
    };
    // browser only, our Origin only
    const bearer = await cliToken(env, ada.cookie);
    expect((await call(env, "POST", "/api/auth/passkey/confirm/options", { body: {}, bearer, origin: null })).status).toBe(403);
    expect((await call(env, "POST", "/api/auth/passkey/confirm/options", { body: {}, cookie: ada.cookie, origin: null })).status).toBe(403);
    expect((await confirm(ada.auth)).status).toBe(200);
    const second = await makeAuthenticator(-257);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie: ada.cookie })).json()) as any;
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await second.register(o.publicKey) }, cookie: ada.cookie })).status).toBe(200);
    const [first, last] = sql.rows("SELECT id FROM credentials ORDER BY created, rowid").map((r) => String(r.id));
    // later, removing one asks again; another passkey of the account answers
    advance(5 * 60_000 + 1000);
    const rm = await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie: ada.cookie });
    expect(rm.status).toBe(403);
    expect(((await rm.json()) as any).confirm).toBe(true);
    expect((await confirm(second)).status).toBe(200);
    expect((await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie: ada.cookie })).status).toBe(204);
    // the last one can go too (Google is linked), after a fresh passkey: the step turns off
    expect((await call(env, "DELETE", `/api/account/credentials/${last}`, { cookie: ada.cookie })).status).toBe(204);
    expect(sql.rows("SELECT COUNT(*) AS n FROM credentials")[0]!.n).toBe(0);
    const { res } = await google(env);
    expect(res.headers.get("location")).toBe("/account");
    expect(await (await call(env, "GET", "/account", { cookie: sessionOf(res) })).text()).toContain("<b>Require a passkey at sign-in: off.</b>");
  });

  it("the email-collision choice signs in to an account that appeared meanwhile only through its passkey step", async () => {
    const { env, sql } = setup(GOOGLE);
    await signedIn(env, "ada@gmail.com");
    const claims = (n: string) => ({ iss: "https://accounts.google.com", aud: GOOGLE.GOOGLE_CLIENT_ID, exp: Math.floor(clock.getTime() / 1000) + 600, nonce: n, sub: "g-ada", email: "ada@gmail.com", email_verified: true });
    const pending = cookieValue((await google(env, { claims })).res, "__Host-gc_pending")!;
    // meanwhile, in another tab, that Google identity got an account and the account a passkey
    const id = "Meanwhile0123456789abc";
    sql.db.prepare("INSERT INTO accounts (id, email, email_verified, google_sub, created) VALUES (?, 'ada@gmail.com', 1, 'g-ada', ?)").run(id, clock.toISOString());
    sql.db.prepare("INSERT INTO credentials (id, account_id, public_key, alg, created) VALUES ('pk-meanwhile', ?, 'AA', -7, ?)").run(id, clock.toISOString());
    const r = await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `__Host-gc_pending=${pending}` });
    expect(r.status).toBe(200);
    expect(await r.clone().json()).toEqual({ ok: true, next: "/login/passkey" });
    expect(cookieValue(r, "__Host-gc_session")).toBeNull();
    expect(cookieValue(r, "__Host-gc_mfa")).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------- units

describe("accounts: CBOR, signatures, links (unit)", () => {
  it("CBOR decodes what authenticators send and rejects malformed input", () => {
    const m = decodeCbor(cbor(new Map<unknown, unknown>([[1, 2], [-1, new Uint8Array([9])], ["fmt", "none"], ["t", true]]))) as Map<unknown, unknown>;
    expect(m.get(1)).toBe(2);
    expect(m.get(-1)).toEqual(new Uint8Array([9]));
    expect(m.get("fmt")).toBe("none");
    expect(decodeCbor(Uint8Array.from([0xf9, 0x3c, 0x00]))).toBe(1); // half float
    expect(decodeFirst(Uint8Array.from([0x01, 0x02]), 0)).toEqual({ value: 1, end: 1 });
    expect(() => decodeCbor(Uint8Array.from([0x01, 0x02]))).toThrow(/trailing/);
    expect(() => decodeCbor(Uint8Array.from([0x5f]))).toThrow(/indefinite/);
    expect(() => decodeCbor(Uint8Array.from([0x42, 0x01]))).toThrow(/end/);
    expect(() => decodeCbor(Uint8Array.from([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/);
    let deep = Uint8Array.from([0x00]);
    for (let i = 0; i < 40; i++) deep = Uint8Array.from([0x81, ...deep]);
    expect(() => decodeCbor(deep)).toThrow(/deep/);
  });

  it("DER ECDSA signatures convert to raw r||s and back", () => {
    const raw = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 || i === 32 ? 0x80 : i));
    expect(derToRaw(rawToDer(raw))).toEqual(raw);
    const small = new Uint8Array(64);
    small[31] = 1;
    small[63] = 2;
    expect(derToRaw(rawToDer(small))).toEqual(small);
    expect(() => derToRaw(Uint8Array.from([0x31, 0x00]))).toThrow();
  });

  it("next targets stay on our own account pages; dashboard links parse", () => {
    for (const ok of ["/account", "/account/apps/0123456789abcdef", "/login/device?code=BCDF-GHJK", "/account?welcome=1"]) expect(safeNext(ok)).toBe(ok);
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "/start", "/account/../x", "/login/device?code=<x>", null]) expect(safeNext(bad as string)).toBeNull();
    const s = "A".repeat(32);
    expect(secretFromLink(`https://genclass.dev/dashboard/${s}`)).toBe(s);
    expect(secretFromLink(` /dashboard/${s} `)).toBe(s);
    expect(secretFromLink(s)).toBe(s);
    expect(secretFromLink("https://genclass.dev/dashboard/short")).toBeNull();
  });

  it("the daily sweep removes expired challenges and device codes and ended sessions", async () => {
    const { env, sql } = setup();
    await signedIn(env);
    await call(env, "POST", "/api/auth/passkey/login/options", { body: {} });
    await call(env, "POST", "/api/device/code", { origin: null });
    advance(31 * 86_400_000);
    await authRetention(sql.api, clock);
    for (const t of ["challenges", "device_codes", "auth_sessions"]) expect(sql.rows(`SELECT COUNT(*) AS n FROM ${t}`)[0]!.n).toBe(0);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------- the CLI

describe("accounts: the CLI's own requests (packages/runtime/bin/lib/account.mjs) against this worker", () => {
  // The CLI half was built against the contract with a fake server (packages/runtime/test/install/mock-account.mjs).
  // Here its real request functions talk to the real router. The worker's clock is the fake timers' clock that also
  // drives the CLI's polling, so both sides see the same intervals.
  afterEach(() => vi.useRealTimers());

  interface Seen {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: any;
    at: number;
    status?: number;
    answer?: any;
  }

  /** A fetch for the CLI that hands each request to handle() and records it with the answer. */
  function wire(env: Env) {
    const log: Seen[] = [];
    const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const req = new Request(url, init);
      const seen: Seen = { method: req.method, path: new URL(url).pathname, headers: Object.fromEntries(req.headers), body: init.body ? JSON.parse(String(init.body)) : null, at: Date.now() };
      log.push(seen);
      const res = await handle(req, env, { now: () => new Date(Date.now()) });
      seen.status = res.status;
      seen.answer = res.status === 204 ? null : await res.clone().json();
      return res;
    };
    return { log, fetchFn };
  }

  const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: clock });

  /** Runs fake time forward in small steps (letting real I/O such as WebCrypto finish between them) until p settles. */
  async function settle<T>(p: Promise<T>, maxMs = 15 * 60_000): Promise<T> {
    let done = false;
    let value: T;
    void p.then((v) => {
      done = true;
      value = v;
    });
    for (let t = 0; !done; t += 250) {
      if (t > maxMs) throw new Error("the CLI's poll did not finish");
      await vi.advanceTimersByTimeAsync(250);
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    }
    return value!;
  }

  const decide = (env: Env, userCode: string, cookie: string, approve: boolean) => call(env, "POST", "/api/device/approve", { body: { user_code: userCode, approve }, cookie });

  it("login, apps, claim and logout: the worker accepts every request as the CLI sends it, and the CLI reads every answer", async () => {
    const { env, sql } = setup();
    const ada = await signedIn(env, "ada@example.com");
    const bob = await signedIn(env, "bob@example.com");
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old app" }, origin: null })).json()) as any;
    const bobToken = await cliToken(env, bob.cookie);
    fakeTime();
    const { log, fetchFn } = wire(env);

    const dev = await cli.startDeviceLogin({ host: ORIGIN, fetchFn });
    expect(dev).toEqual({
      ok: true,
      device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(USER_CODE_RE),
      verification_uri: `${ORIGIN}/login/device`,
      verification_uri_complete: `${ORIGIN}/login/device?code=${dev.user_code}`,
      expires_in: 600,
      interval: 5,
    });
    // JSON with the CLI's name (it labels the session), and no Origin or cookie: a bearer client has no ambient
    // credentials, so the CSRF rule does not apply to it
    expect(log[0]!.body).toEqual({ client_name: cli.CLIENT_NAME });
    expect(cli.CLIENT_NAME).toMatch(/^genclass-runtime \S+$/);
    expect(log[0]!.headers).toMatchObject({ "content-type": "application/json", "user-agent": expect.stringMatching(/^genclass-runtime-cli\//) });
    expect(log[0]!.headers.origin).toBeUndefined();
    expect(log[0]!.headers.cookie).toBeUndefined();

    // the code shows on the approval page with the CLI's name
    const page = await (await call(env, "GET", `/login/device?code=${dev.user_code}`, { cookie: ada.cookie })).text();
    expect(page).toContain(cli.CLIENT_NAME);

    let approval: Promise<Response> | null = null;
    let slowDowns = 0;
    const r = await settle(
      cli.pollDeviceLogin(dev, {
        host: ORIGIN,
        fetchFn,
        onWait: () => {
          approval ??= decide(env, dev.user_code, ada.cookie, true);
        },
        onSlowDown: () => slowDowns++,
      }),
    );
    expect((await approval!)!.status).toBe(200);
    expect(r).toEqual({ ok: true, access_token: expect.stringMatching(CLI_TOKEN_RE), expires_in: 90 * 86_400, account: { id: ada.account.id, email: "ada@example.com", github_login: null } });
    // the CLI keeps to the interval it was given, so the worker never has to answer slow_down
    expect(slowDowns).toBe(0);
    const polls = log.filter((e) => e.path === "/api/device/token");
    expect(polls.map((e) => e.answer?.error ?? "token")).toEqual(["authorization_pending", "token"]);
    expect(polls.every((e) => e.body.device_code === dev.device_code)).toBe(true);
    // the CLI session carries the name the CLI gave
    expect(sql.rows("SELECT label FROM auth_sessions WHERE kind = 'cli' AND account_id = ?", ada.account.id)).toEqual([{ label: cli.CLIENT_NAME }]);

    const creds = { host: ORIGIN, access_token: r.access_token, account: r.account };
    expect(await cli.fetchMe(creds, { fetchFn })).toEqual({ ok: true, account: r.account, projects: [] });

    const made = await cli.createAccountProject(creds, "shop-web", { fetchFn });
    expect(made).toMatchObject({ ok: true, account: true, name: "shop-web", token: expect.stringMatching(/^gc_[A-Za-z0-9]{22}$/), id: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(made.dashboardUrl).toBe(`${ORIGIN}/account/apps/${made.id}`);

    // claim with the CLI session (bearer): the private-link app joins the account and keeps its token
    const claimed = await cli.claimProject(creds, anon.dashboardUrl, { fetchFn });
    expect(claimed).toMatchObject({ ok: true, project: { token: anon.token, name: "Old app", dashboard_url: expect.stringMatching(new RegExp(`^${ORIGIN}/account/apps/[0-9a-f]{16}$`)) } });
    const me1 = await cli.fetchMe(creds, { fetchFn });
    expect(me1.ok).toBe(true);
    expect(me1.projects.map((p: any) => p.token).sort()).toEqual([made.token, anon.token].sort());
    // every app passed the CLI's checks (token format, a dashboard link on the host it talks to)
    expect(me1.projects.every((p: any) => p.dashboard_url !== null && p.created !== null)).toBe(true);

    // the refusals the CLI explains (login.mjs): another account's dashboard, an unknown link
    const bobCreds = { host: ORIGIN, access_token: bobToken, account: null };
    expect(await cli.claimProject(bobCreds, anon.dashboardUrl, { fetchFn })).toMatchObject({ ok: false, status: 409, reason: expect.stringContaining("another account") });
    expect(await cli.claimProject(creds, `${ORIGIN}/dashboard/${"Z".repeat(32)}`, { fetchFn })).toMatchObject({ ok: false, status: 404 });

    for (const e of log.filter((x) => x.path === "/api/me" || x.path.startsWith("/api/account/"))) {
      expect(e.headers.authorization).toMatch(/^Bearer gcs_/);
      expect(e.headers.origin).toBeUndefined();
      expect(e.headers.cookie).toBeUndefined();
    }

    // logout: 204, the token stops working (the CLI then says to sign in again), a second logout counts as done
    expect(await cli.revokeSession(creds, { fetchFn })).toEqual({ ok: true, already: false });
    expect(log.at(-1)).toMatchObject({ method: "DELETE", path: "/api/account/sessions/current", status: 204 });
    expect(await cli.fetchMe(creds, { fetchFn })).toMatchObject({ ok: false, status: 401 });
    expect(await cli.revokeSession(creds, { fetchFn })).toEqual({ ok: true, already: true });
    expect((await me(env, { cookie: ada.cookie })).status).toBe(200); // the browser session is not touched
  });

  it("slow_down: the CLI's next polls keep the interval the worker sets; a denial in the browser ends the poll", async () => {
    // AUTH_LIMIT refuses the first poll (as for a busy network), so the worker answers slow_down
    const pollKey = (await sha256Hex("auth:poll:unknown")).slice(0, 32);
    let tripped = false;
    const { env } = setup({
      AUTH_LIMIT: {
        async limit({ key }: { key: string }) {
          if (key === pollKey && !tripped) {
            tripped = true;
            return { success: false };
          }
          return { success: true };
        },
      },
    });
    const ada = await signedIn(env);
    fakeTime();
    const { log, fetchFn } = wire(env);
    const dev = await cli.startDeviceLogin({ host: ORIGIN, fetchFn });
    expect(dev.ok).toBe(true);
    const told: number[] = [];
    let denial: Promise<Response> | null = null;
    const r = await settle(
      cli.pollDeviceLogin(dev, {
        host: ORIGIN,
        fetchFn,
        onSlowDown: (s: number) => told.push(s),
        onWait: () => {
          denial ??= decide(env, dev.user_code, ada.cookie, false);
        },
      }),
    );
    expect((await denial!)!.status).toBe(200);
    expect(r).toMatchObject({ ok: false, error: "access_denied" });
    const polls = log.filter((e) => e.path === "/api/device/token");
    expect(polls.map((e) => e.answer.error)).toEqual(["slow_down", "authorization_pending", "access_denied"]);
    expect(polls[0]!.answer.interval).toBe(10);
    expect(told).toEqual([10]);
    expect(polls[1]!.at - polls[0]!.at).toBeGreaterThanOrEqual(10_000);
    expect(polls[2]!.at - polls[1]!.at).toBeGreaterThanOrEqual(10_000);
  });
});

// ------------------------------------------------------------------------------------------------- review fixes

/** A batch for `token` through the real collector (what a page running the runtime sends). */
async function sendBatch(env: Env, token: string, sid = "cccccccccccc") {
  const body = { schema: "genclass-telemetry/1", sid, sent: 1, runtime: "0.3.0", model: null, token, events: [{ t: "session", host: "shop.example", route: "/" }] };
  const r = await handle(new Request(`${ORIGIN}/api/v1/events`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "text/plain" } }), env, { now: () => clock });
  expect(r.status).toBe(202);
}

/** The env's DB with every SQL text recorded, to check what a request did (or did not) read. */
function spyDb(env: Env, seen: string[]) {
  const db = env.DB!;
  env.DB = { prepare: (q: string) => (seen.push(q), db.prepare(q)), batch: (s) => db.batch(s) };
}

describe("accounts: the device approval page is no code oracle, and shows only the CLI's own name", () => {
  it("signed out, /login/device reads no device code: a live code and a made-up one get the same page", async () => {
    const { env } = setup();
    const live = (await (await call(env, "POST", "/api/device/code", { body: { client_name: "genclass-runtime 0.3.0" }, origin: null })).json()) as any;
    const fake = live.user_code === "ZXCV-BNMP" ? "ZXCV-BNMQ" : "ZXCV-BNMP"; // not the BCDF-GHJK placeholder the page shows
    const seen: string[] = [];
    spyDb(env, seen);
    const norm = (h: string, code: string) => h.replace(/[A-Za-z0-9]{22}(?=["';])/g, "NONCE").replaceAll(code, "CODE");
    const a = norm(await (await call(env, "GET", `/login/device?code=${live.user_code}`, { origin: null })).text(), live.user_code);
    const b = norm(await (await call(env, "GET", `/login/device?code=${fake}`, { origin: null })).text(), fake);
    expect(a).toBe(b);
    expect(a).toContain("Sign in to continue");
    expect(seen.filter((q) => q.includes("device_codes"))).toEqual([]);
  });

  it("code lookups and polls are rate limited before any database read; unknown device codes count too", async () => {
    const counts = new Map<string, number>();
    const { env } = setup({
      AUTH_LIMIT: {
        async limit({ key }) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { success: counts.get(key)! <= 2 };
        },
      },
    });
    const { cookie } = await signedIn(env);
    for (let i = 0; i < 2; i++) expect((await call(env, "GET", "/login/device?code=BCDF-GHJK", { cookie, origin: null })).status).toBe(200);
    const limited = await call(env, "GET", "/login/device?code=BCDF-GHJK", { cookie, origin: null });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await call(env, "GET", "/login/device", { cookie, origin: null })).status).toBe(200); // no code: no lookup
    const seen: string[] = [];
    spyDb(env, seen);
    const poll = async () => (await (await call(env, "POST", "/api/device/token", { body: { device_code: "y".repeat(43) }, origin: null })).json()) as any;
    expect((await poll()).error).toBe("expired_token");
    expect((await poll()).error).toBe("expired_token");
    const before = seen.length;
    expect(await poll()).toMatchObject({ error: "slow_down", interval: 10 });
    expect(seen.slice(before).filter((q) => q.includes("device_codes"))).toEqual([]);
  });

  it("client_name: only `genclass-runtime <version>` is shown and kept; other text shows as Unknown client", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    const code = (await (await call(env, "POST", "/api/device/code", { body: { client_name: "Acme team invite: approve to join the workspace" }, origin: null })).json()) as any;
    const page = await (await call(env, "GET", `/login/device?code=${code.user_code}`, { cookie })).text();
    expect(page).toContain("Unknown client");
    expect(page).not.toContain("Acme team");
    expect(sql.rows("SELECT client FROM device_codes")[0]!.client).toBeNull();
    expect((await call(env, "POST", "/api/device/approve", { body: { user_code: code.user_code, approve: true }, cookie })).status).toBe(200);
    expect((await call(env, "POST", "/api/device/token", { body: { device_code: code.device_code }, origin: null })).status).toBe(200);
    expect(sql.rows("SELECT label FROM auth_sessions WHERE kind = 'cli'")[0]!.label).toBe("Command line");
    for (const ok of ["genclass-runtime 0.3.0", "genclass-runtime 0.3.0-beta.1", "genclass-runtime 12.0.4"]) expect(CLIENT_NAME_RE.test(ok)).toBe(true);
    for (const bad of ["genclass-runtime 0.3.0 (darwin)", "genclass-runtime", "Approve to join", "genclass-runtime 0.3.0\nApprove", "x genclass-runtime 0.3.0"]) expect(CLIENT_NAME_RE.test(bad)).toBe(false);
  });

  it("the approval page script handles an expired code and the answer (no buttons left to press)", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    const code = (await (await call(env, "POST", "/api/device/code", { body: { client_name: "genclass-runtime 0.3.0" }, origin: null })).json()) as any;
    const page = await (await call(env, "GET", `/login/device?code=${code.user_code}`, { cookie })).text();
    // the expiry time is in the page config, and the 404 answer switches to the "no longer valid" state
    expect(page).toContain(`"expires":"${new Date(clock.getTime() + 600_000).toISOString()}"`);
    expect(page).toContain('finish("Approved"');
    expect(page).toContain("e.status === 404");
  });
});

describe("accounts: what a CLI session may do", () => {
  it("lists and creates apps and claims, but cannot read stats, end other sessions, remove passkeys, turn off links or delete the account", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    await startTrial(env, cookie);
    const bearer = await cliToken(env, cookie);
    // nor start a trial (a browser decision)
    expect((await call(env, "POST", "/api/billing/trial", { body: {}, bearer, origin: null })).status).toBe(403);
    const created = await call(env, "POST", "/api/account/projects", { body: { name: "x" }, bearer, origin: null });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as any;
    expect((await call(env, "GET", "/api/account/projects", { bearer, origin: null })).status).toBe(200);
    const stats = await call(env, "GET", `/api/account/projects/${project.id}/stats`, { bearer, origin: null });
    expect(stats.status).toBe(403);
    expect(((await stats.json()) as any).error).toMatch(/browser/);
    expect((await call(env, "GET", `/api/account/projects/${project.id}/stats`, { cookie })).status).toBe(200);
    const web = sql.rows("SELECT id FROM auth_sessions WHERE kind = 'web'")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/sessions/${web}`, { bearer, origin: null })).status).toBe(403);
    expect((await call(env, "DELETE", "/api/account/sessions/others", { bearer, origin: null })).status).toBe(403);
    expect((await call(env, "DELETE", `/api/account/projects/${project.id}/link`, { bearer, origin: null })).status).toBe(403);
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, bearer, origin: null })).status).toBe(403);
    const cred = sql.rows("SELECT id FROM credentials")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/credentials/${cred}`, { bearer, origin: null })).status).toBe(403);
    expect((await me(env, { cookie })).status).toBe(200);
    expect(sql.rows("SELECT COUNT(*) AS n FROM credentials")[0]!.n).toBe(1);
    // its own logout still works
    expect((await call(env, "DELETE", "/api/account/sessions/current", { bearer, origin: null })).status).toBe(204);
  });
});

describe("accounts: sessions on /account", () => {
  it("lists browser sessions, revokes one, signs out everywhere else, and removing a passkey ends the other sessions", async () => {
    const { env, sql } = setup();
    const { auth, cookie } = await signedIn(env);
    advance(1000);
    const other = sessionOf((await signIn(env, auth)).res);
    const page = await (await call(env, "GET", "/account", { cookie })).text();
    expect(page).toContain("This browser");
    expect(page).toContain("Browser 1");
    expect(page).toContain("Sign out everywhere else");
    const otherId = sql.rows("SELECT id FROM auth_sessions WHERE kind = 'web' ORDER BY created DESC")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/sessions/${otherId}`, { cookie })).status).toBe(204);
    expect((await me(env, { cookie: other })).status).toBe(401);
    expect((await me(env, { cookie })).status).toBe(200);

    const third = sessionOf((await signIn(env, auth)).res);
    const bearer = await cliToken(env, cookie);
    expect((await call(env, "DELETE", "/api/account/sessions/others", { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "DELETE", "/api/account/sessions/others", { cookie })).status).toBe(204);
    expect((await me(env, { cookie: third })).status).toBe(401);
    expect((await me(env, { bearer, origin: null })).status).toBe(401);
    expect((await me(env, { cookie })).status).toBe(200);

    // a second passkey, used in another browser; removing the first passkey ends that browser's session too
    const second = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: {}, cookie })).json()) as any;
    expect((await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await second.register(o.publicKey) }, cookie })).status).toBe(200);
    const fourth = sessionOf((await signIn(env, second)).res);
    const first = sql.rows("SELECT id FROM credentials ORDER BY created, rowid")[0]!.id as string;
    expect((await call(env, "DELETE", `/api/account/credentials/${first}`, { cookie })).status).toBe(204);
    expect((await me(env, { cookie: fourth })).status).toBe(401);
    expect((await me(env, { cookie })).status).toBe(200);
  });
});

describe("accounts: deleting an account", () => {
  it("removes its passkeys, sessions and row; apps made in it go with their stats; apps with a private link go back to that link", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    const bearer = await cliToken(env, cookie);
    const made = ((await (await call(env, "POST", "/api/account/projects", { body: { name: "Made here" }, cookie })).json()) as any).project;
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old app" }, origin: null })).json()) as any;
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie })).status).toBe(200);
    await sendBatch(env, made.token);
    await sendBatch(env, anon.token, "dddddddddddd");
    const count = (t: string, token: string) => Number(sql.rows(`SELECT COUNT(*) AS n FROM ${t} WHERE token = ?`, token)[0]!.n);
    expect(count("daily", made.token)).toBeGreaterThan(0);

    expect((await call(env, "DELETE", "/api/account", { body: {}, cookie })).status).toBe(400);
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call(env, "DELETE", "/api/account", { body: { confirm: "delete" } })).status).toBe(401);
    const del = await call(env, "DELETE", "/api/account", { body: { confirm: "delete" }, cookie });
    expect(del.status).toBe(204);
    expect(cookies(del).some((c) => c.startsWith("__Host-gc_session=;") && c.includes("Max-Age=0"))).toBe(true);

    for (const t of ["credentials", "auth_sessions", "device_codes", "challenges"]) expect(sql.rows(`SELECT COUNT(*) AS n FROM ${t} WHERE account_id = ?`, account.id)[0]!.n).toBe(0);
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(0);
    for (const t of ["projects", "daily", "hourly", "recent", "sessions"]) expect(count(t, made.token)).toBe(0);
    expect(sql.rows("SELECT account_id FROM projects WHERE token = ?", anon.token)).toEqual([{ account_id: null }]);
    expect(count("daily", anon.token)).toBeGreaterThan(0);
    expect((await handle(new Request(anon.dashboardUrl), env, { now: () => clock })).status).toBe(200);
    expect((await me(env, { cookie })).status).toBe(401);
    expect((await me(env, { bearer, origin: null })).status).toBe(401);
    expect(await (await call(env, "GET", "/login?deleted=1", {})).text()).toContain("Your account is deleted.");
    // the old link can be added to a new account again
    const again = await signedIn(env, "ada2@example.com");
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: again.cookie })).status).toBe(200);
  });
});

describe("accounts: private links of owned apps", () => {
  it("a claimed app's link keeps working until the owner turns it off; then it opens and claims nothing; the dashboard says which", async () => {
    const { env, sql } = setup();
    const ada = await signedIn(env, "ada@example.com");
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old app" }, origin: null })).json()) as any;
    const { project } = (await (await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: ada.cookie })).json()) as any;
    const appPage = async () => (await call(env, "GET", `/account/apps/${project.id}`, { cookie: ada.cookie })).text();
    expect(await appPage()).toContain("private dashboard link it had before it joined your account");
    expect(await (await call(env, "GET", "/account", { cookie: ada.cookie })).text()).toContain(`data-linkoff="${project.id}"`);

    expect((await call(env, "DELETE", `/api/account/projects/${project.id}/link`, { cookie: ada.cookie, origin: null })).status).toBe(403);
    const bob = await signedIn(env, "bob@example.com");
    expect((await call(env, "DELETE", `/api/account/projects/${project.id}/link`, { cookie: bob.cookie })).status).toBe(404);
    const hash = sql.rows("SELECT secret_hash FROM projects WHERE id = ?", project.id)[0]!.secret_hash;
    expect((await call(env, "DELETE", `/api/account/projects/${project.id}/link`, { cookie: ada.cookie })).status).toBe(204);
    expect(sql.rows("SELECT secret_hash, private_link FROM projects WHERE id = ?", project.id)[0]).toEqual({ secret_hash: expect.not.stringMatching(String(hash)), private_link: 0 });
    expect((await handle(new Request(anon.dashboardUrl), env, { now: () => clock })).status).toBe(404);
    expect((await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie: bob.cookie })).status).toBe(404);
    expect(await appPage()).toContain("Only you can open this page, while signed in.");
    // an app created in the account never had a link
    const made = ((await (await call(env, "POST", "/api/account/projects", { body: { name: "New" }, cookie: ada.cookie })).json()) as any).project;
    expect(sql.rows("SELECT private_link FROM projects WHERE id = ?", made.id)[0]!.private_link).toBe(0);
    expect(await (await call(env, "GET", `/account/apps/${made.id}`, { cookie: ada.cookie })).text()).toContain("Only you can open this page, while signed in.");
  });
});

describe("accounts: app limits", () => {
  /** n projects written straight into the table (tag keeps ids, tokens and hashes distinct between calls). */
  const fill = (sql: ReturnType<typeof d1>, tag: string, n: number, accountId: string | null, created: string) => {
    const ins = sql.db.prepare("INSERT INTO projects (id, token, secret_hash, name, created, account_id, private_link) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < n; i++) {
      const k = `${tag}${i}`;
      ins.run(Buffer.from(k).toString("hex").padStart(16, "0"), `gc_${k.padStart(22, "0")}`, `h-${k}`, `n${i}`, created, accountId, accountId ? 0 : 1);
    }
  };

  it("an account holds at most 200 apps, created or claimed", async () => {
    const { env, sql } = setup();
    const { cookie, account } = await signedIn(env);
    fill(sql, "a", 200, account.id, "2026-01-01T00:00:00.000Z");
    const made = await call(env, "POST", "/api/account/projects", { body: { name: "one more" }, cookie });
    expect(made.status).toBe(409);
    expect(((await made.json()) as any).error).toMatch(/at most 200 apps/);
    const anon = (await (await call(env, "POST", "/api/projects", { body: { name: "Old app" }, origin: null })).json()) as any;
    const claim = await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: anon.dashboardUrl }, cookie });
    expect(claim.status).toBe(409);
    expect(((await claim.json()) as any).error).toMatch(/at most 200 apps/);
    expect(sql.rows("SELECT account_id FROM projects WHERE token = ?", anon.token)).toEqual([{ account_id: null }]);
  });

  it("anonymous and account creation have separate per-minute ceilings: an anonymous flood does not block signed-in owners", async () => {
    const { env, sql } = setup();
    const { cookie } = await signedIn(env);
    fill(sql, "x", 60, null, clock.toISOString());
    expect((await call(env, "POST", "/api/projects", { body: {}, origin: null })).status).toBe(429);
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "mine" }, cookie })).status).toBe(201);
    fill(sql, "y", 60, "Someone0123456789abcde", clock.toISOString());
    expect((await call(env, "POST", "/api/account/projects", { body: { name: "mine too" }, cookie })).status).toBe(429);
  });
});

describe("accounts: migration 0003 on a database that already has projects", () => {
  it("gives old rows an id, a first event and a private link; their links keep working and they can be claimed, a NULL id too", async () => {
    const s1 = "S".repeat(31) + "1";
    const s2 = "S".repeat(31) + "2";
    const [h1, h2] = [await sha256Hex(s1), await sha256Hex(s2)];
    const tok1 = `gc_${"O".repeat(21)}1`;
    const tok2 = `gc_${"O".repeat(21)}2`;
    const sql = d1({
      before: "0003",
      seed: (db) => {
        // as the code before accounts wrote them
        db.prepare("INSERT INTO projects (token, secret_hash, name, created, last_event) VALUES (?, ?, ?, ?, ?)").run(tok1, h1, "Old one", "2026-10-10T00:00:00.000Z", "2026-10-12T10:00:00.000Z");
        db.prepare("INSERT INTO recent (token, t, kind) VALUES (?, ?, 'detect')").run(tok1, "2026-10-10T05:00:00.000Z");
        db.prepare("INSERT INTO projects (token, secret_hash, name, created) VALUES (?, ?, ?, ?)").run(`gc_${"Q".repeat(22)}`, "h-q", "Quiet", "2026-10-11T00:00:00.000Z");
      },
    });
    const env: Env = { BUCKET: { async put() {} }, DB: sql.api };
    const rows = sql.rows("SELECT token, id, first_event, private_link, account_id FROM projects ORDER BY created");
    expect(rows).toEqual([
      { token: tok1, id: expect.stringMatching(PROJECT_ID_RE), first_event: "2026-10-10T05:00:00.000Z", private_link: 1, account_id: null },
      { token: `gc_${"Q".repeat(22)}`, id: expect.stringMatching(PROJECT_ID_RE), first_event: null, private_link: 1, account_id: null },
    ]);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect((await handle(new Request(`${ORIGIN}/dashboard/${s1}`), env, { now: () => clock })).status).toBe(200);
    const { cookie } = await signedIn(env);
    const claimed = (await (await call(env, "POST", "/api/account/projects/claim", { body: { secret: s1 }, cookie })).json()) as any;
    expect(claimed.project).toMatchObject({ id: rows[0]!.id, token: tok1, first_event: "2026-10-10T05:00:00.000Z" });

    // a row the old code inserted between the migration and the deploy has no id; claiming gives it one
    sql.db.prepare("INSERT INTO projects (token, secret_hash, name, created) VALUES (?, ?, ?, ?)").run(tok2, h2, "Late", clock.toISOString());
    expect(sql.rows("SELECT id, private_link FROM projects WHERE token = ?", tok2)).toEqual([{ id: null, private_link: 1 }]);
    expect((await handle(new Request(`${ORIGIN}/dashboard/${s2}`), env, { now: () => clock })).status).toBe(200);
    const late = await call(env, "POST", "/api/account/projects/claim", { body: { dashboard_url: `https://genclass.dev/dashboard/${s2}` }, cookie });
    expect(late.status).toBe(200);
    const lp = ((await late.json()) as any).project;
    expect(lp.id).toMatch(PROJECT_ID_RE);
    expect(sql.rows("SELECT id FROM projects WHERE token = ?", tok2)[0]!.id).toBe(lp.id);
    expect((await me(env, { cookie })).json.projects.map((p: any) => p.token).sort()).toEqual([tok1, tok2].sort());
  });
});

describe("accounts: the Connect panel and the account-mode sidebar", () => {
  it("says first that keys are not on npm until RUNTIME_ON_NPM reaches 0.3.0-beta.0; the status line sits under the key", async () => {
    for (const [v, notYet] of [[undefined, true], ["0.2.2", true], ["0.3.0-beta.0", false], ["0.3.0", false]] as const) {
      const { env } = setup(v === undefined ? {} : { RUNTIME_ON_NPM: v });
      const { cookie } = await signedIn(env);
      const { project } = (await (await call(env, "POST", "/api/account/projects", { body: { name: "App" }, cookie })).json()) as any;
      const html = await (await call(env, "GET", `/account/apps/${project.id}`, { cookie })).text();
      expect(html.includes("Not on npm yet"), String(v)).toBe(notYet);
      if (notYet) expect(html.indexOf("Not on npm yet")).toBeLessThan(html.indexOf("Project API key"));
      expect(html.indexOf('id="cstatus"')).toBeLessThan(html.indexOf("1 · Run in your project"));
      expect(html).toContain('aria-label="Copy the project API key"');
      expect(html).toContain('aria-label="Copy the script tag"');
      expect(html).toContain('<a class="skip" href="#mc">Skip to content</a>');
    }
    expect(runtimeHasTokens({ BUCKET: { async put() {} }, RUNTIME_ON_NPM: "0.10.1" })).toBe(true);
    expect(runtimeHasTokens({ BUCKET: { async put() {} }, RUNTIME_ON_NPM: "1.0.0" })).toBe(true);
    // a 0.3 prerelease on the beta dist-tag reads keys (the pages name @beta in their commands); 0.2.x never does
    expect(runtimeHasTokens({ BUCKET: { async put() {} }, RUNTIME_ON_NPM: "0.3.0-beta.1" })).toBe(true);
    expect(runtimeHasTokens({ BUCKET: { async put() {} }, RUNTIME_ON_NPM: "0.2.3-beta.0" })).toBe(false);
    expect(runtimeHasTokens({ BUCKET: { async put() {} }, RUNTIME_ON_NPM: "0.3.0-" })).toBe(false);
  });

  it("while an app waits for its first event the sidebar shows Connect only; more than 4 apps collapse to the current one", async () => {
    const { env } = setup();
    const { cookie } = await signedIn(env);
    await startTrial(env, cookie);
    const ids: string[] = [];
    let token = "";
    for (const name of ["a", "b", "c", "d", "e"]) {
      const { project } = (await (await call(env, "POST", "/api/account/projects", { body: { name }, cookie })).json()) as any;
      ids.push(project.id);
      token ||= project.token;
    }
    const waiting = await (await call(env, "GET", `/account/apps/${ids[0]}`, { cookie })).text();
    expect(waiting).toContain('<div id="period" class="hidden">');
    expect(waiting).toContain('<a href="#connect" aria-current="true">Connect</a>');
    expect(waiting).toContain("All apps <span>5</span>");
    expect(waiting).not.toContain(`href="/account/apps/${ids[1]}"`);
    expect(waiting).not.toContain(">Elsewhere<");
    await sendBatch(env, token);
    const live = await (await call(env, "GET", `/account/apps/${ids[0]}`, { cookie })).text();
    expect(live).toContain('<div id="period">');
  });
});

describe("accounts: cookies in development", () => {
  it("on plain-HTTP localhost the session cookie has no __Host- prefix and no Secure; elsewhere it has both", async () => {
    const DEV = "http://localhost:8787";
    const { env } = setup({ AUTH_ORIGIN: DEV, AUTH_RP_ID: "localhost" });
    const auth = await makeAuthenticator(-7);
    const o = (await (await call(env, "POST", "/api/auth/passkey/register/options", { body: { email: "dev@example.com" }, origin: DEV })).json()) as any;
    const res = await call(env, "POST", "/api/auth/passkey/register/verify", { body: { id: o.id, credential: await auth.register(o.publicKey, { origin: DEV }) }, origin: DEV });
    expect(res.status).toBe(200);
    const set = cookies(res).find((c) => c.startsWith("gc_session="))!;
    expect(set).toMatch(/^gc_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
    expect((await me(env, { cookie: set.split(";")[0] })).status).toBe(200);
  });
});
