import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The CLI's own request functions (packages/runtime/bin/lib/account.mjs), run against this worker below.
// @ts-expect-error plain ESM module without types
import * as cli from "../../packages/runtime/bin/lib/account.mjs";
import { handle, type Env, type HandleOptions } from "../src/collector.js";
import {
  authRetention,
  checkGoogleClaims,
  CLI_TOKEN_RE,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  GOOGLE_TOKEN_URL,
  normalizeUserCode,
  safeNext,
  secretFromLink,
  USER_CODE_RE,
} from "../src/auth.js";
import { decodeCbor, decodeFirst } from "../src/cbor.js";
import { resetTokenCache, sha256Hex } from "../src/dashboard.js";
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
  const v = cookieValue(r, "gc_session");
  if (!v) throw new Error("no session cookie");
  return `gc_session=${v}`;
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

async function signedIn(env: Env, email = "ada@example.com", alg = -7) {
  const auth = await makeAuthenticator(alg);
  const s = await signUp(env, auth, email);
  expect(s.res.status).toBe(200);
  return { auth, cookie: sessionOf(s.res), account: s.json.account as { id: string; email: string } };
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
      const set = cookies(up.res).find((c) => c.startsWith("gc_session="))!;
      expect(set).toMatch(/^gc_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);

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
      expect(cookieValue(up.res, "gc_session")).toBeNull();
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
    expect(cookieValue(v, "gc_session")).toBeNull();
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
    expect(cookies(out).some((c) => c.startsWith("gc_session=;") && c.includes("Max-Age=0"))).toBe(true);
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
    expect((await me(env, { cookie: `gc_session=${tok}` })).status).toBe(401);
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
    const c = await call(env, "POST", "/api/device/code", { body: { client_name: "genclass-runtime 0.3.0 (darwin)" }, origin: null });
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
    expect(out).toContain("Sign in to approve this code");
    expect(out).toContain(code.user_code);
    expect(out).toContain(encodeURIComponent(`/login/device?code=${code.user_code}`));
    const page = await (await call(env, "GET", `/login/device?code=${code.user_code}`, { cookie })).text();
    expect(page).toContain("Approve this sign-in");
    expect(page).toContain("genclass-runtime 0.3.0 (darwin)");

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
    expect(sql.rows("SELECT kind, label, expires FROM auth_sessions WHERE kind = 'cli'")[0]).toEqual({ kind: "cli", label: "genclass-runtime 0.3.0 (darwin)", expires: new Date(clock.getTime() - 15_000 + 90 * 86_400_000).toISOString() });
    expect(await me(env, { bearer, origin: null })).toEqual({ status: 200, json: { account: { id: account.id, email: "ada@example.com", github_login: null }, projects: [] } });
    const acct = await (await call(env, "GET", "/account", { cookie })).text();
    expect(acct).toContain("genclass-runtime 0.3.0 (darwin)");

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
    const { project } = (await (await call(env, "POST", "/api/account/projects", { body: { name: "Ada's app" }, cookie: a.cookie })).json()) as any;
    const own = await call(env, "GET", `/account/apps/${project.id}`, { cookie: a.cookie });
    expect(own.status).toBe(200);
    const html = await own.text();
    expect(html).toContain("Connect this app");
    expect(html).toContain("npx @genclass/runtime login");
    expect(html).toContain(`GenClass.init({ token: &#34;${project.token}&#34; })`);
    expect(html).toContain(`data-token=&#34;${project.token}&#34;`);
    expect(html).toContain("0.3.0 or later");
    // as the runtime behaves (src/telemetry/config.ts isLocalHost; its console says so): a key does not make a
    // local host send, so the first event comes from a deployed page
    expect(html).toContain("Local hosts (localhost, *.local, *.test, private networks) do not send, even with a key");
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
async function google(env: Env, o: { claims?: (nonce: string) => Record<string, unknown>; cookie?: string; link?: boolean; state?: (s: string) => string; query?: string; dropCookie?: boolean; tokenStatus?: number } = {}): Promise<GoogleRun> {
  const start = await call(env, "GET", `/auth/google${o.link ? "?link=1" : ""}`, { cookie: o.cookie, origin: null });
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
      expect(cookieValue(res, "gc_session")).toBeNull();
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
    expect(cookieValue(res, "gc_session")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This email already has a GenClass account");
    expect(html).toContain("Link Google");
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", victim.account.id)[0]!.google_sub).toBeNull();
    const pending = cookieValue(res, "gc_pending")!;
    expect(pending).toMatch(/^[A-Za-z0-9]{22}$/);

    // "Create a separate account"
    expect((await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `gc_pending=${pending}`, origin: null })).status).toBe(403);
    const ok = await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `gc_pending=${pending}` });
    expect(ok.status).toBe(200);
    expect(await ok.clone().json()).toEqual({ ok: true, next: "/account?welcome=1" });
    const mine = await me(env, { cookie: sessionOf(ok) });
    expect(mine.json.account.id).not.toBe(victim.account.id);
    expect(mine.json.account.email).toBe("ADA@gmail.com");
    expect(sql.rows("SELECT COUNT(*) AS n FROM accounts")[0]!.n).toBe(2);
    expect(sql.rows("SELECT google_sub FROM accounts WHERE id = ?", victim.account.id)[0]!.google_sub).toBeNull();
    // the pending choice is single-use
    expect((await call(env, "POST", "/api/auth/pending", { body: {}, cookie: `gc_pending=${pending}` })).status).toBe(400);
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
    const via = await google(env, { claims: linkClaims });
    expect((await me(env, { cookie: sessionOf(via.res) })).json.account.id).toBe(ada.account.id);

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
    expect(both.indexOf("Continue with GitHub")).toBeLessThan(both.indexOf("Sign in with a passkey"));
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
  async function github(env: Env, o: { state?: (s: string) => string } = {}) {
    const start = await call(env, "GET", "/auth/github", { origin: null });
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
      return new Response(JSON.stringify({ id: 4242, login: "octo-ada", email: "public@example.com" }), { status: 200 });
    };
    const res = await call(env, "GET", `/auth/github/callback?code=c0de&state=${o.state ? o.state(state) : state}`, { cookie: `gc_oauth_github=${cookieValue(start, "gc_oauth_github")}`, origin: null, fetch: fetchMock });
    return { res, calls };
  }

  it("refuses a state mismatch without calling GitHub", async () => {
    const { env, sql } = setup(GITHUB);
    const { res, calls } = await github(env, { state: (s) => `${s.slice(0, -2)}xx` });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(cookieValue(res, "gc_session")).toBeNull();
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
