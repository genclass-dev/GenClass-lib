// A software passkey authenticator for tests: ES256 (P-256) and RS256 (RSA 2048) keys made with WebCrypto, a small
// CBOR encoder, and the registration and assertion responses a browser posts (base64url fields, the shape the
// account pages send to /api/auth/passkey/*). Every check the server makes can be broken on purpose through the
// overrides (origin, rpId, flags, counter, challenge, type, signature).
// Plain JavaScript so a local script can drive `wrangler dev` with it too.

const enc = new TextEncoder();

export function b64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function concat(...parts) {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** CBOR for what WebAuthn uses: integers, byte and text strings, arrays, maps (Map), booleans, null. */
export function cbor(value) {
  const out = [];
  const head = (major, n) => {
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  };
  const item = (x) => {
    if (typeof x === "number") {
      if (x >= 0) head(0, x);
      else head(1, -1 - x);
    } else if (x instanceof Uint8Array) {
      head(2, x.length);
      for (const b of x) out.push(b);
    } else if (typeof x === "string") {
      const b = enc.encode(x);
      head(3, b.length);
      for (const c of b) out.push(c);
    } else if (Array.isArray(x)) {
      head(4, x.length);
      x.forEach(item);
    } else if (x instanceof Map) {
      head(5, x.size);
      for (const [k, v] of x) {
        item(k);
        item(v);
      }
    } else if (x === true) out.push(0xf5);
    else if (x === false) out.push(0xf4);
    else if (x === null) out.push(0xf6);
    else throw new Error("cbor: unsupported value");
  };
  item(value);
  return Uint8Array.from(out);
}

const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** Raw r||s (what WebCrypto signs) to the ASN.1 DER form authenticators send. */
export function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat([0x30, body.length], body);
}

export const FLAGS = { UP: 0x01, UV: 0x04, AT: 0x40, ED: 0x80 };

/**
 * A new authenticator holding one credential. `alg` is -7 (ES256) or -257 (RS256).
 * register(options, over) answers navigator.credentials.create(); assert(options, over) answers .get().
 */
export async function makeAuthenticator(alg = -7) {
  const pair =
    alg === -7
      ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
      : await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const cose =
    alg === -7
      ? cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]))
      : cbor(new Map([[1, 3], [3, -257], [-1, fromB64url(jwk.n)], [-2, fromB64url(jwk.e)]]));
  const rawId = crypto.getRandomValues(new Uint8Array(32));
  const a = {
    alg,
    cose,
    credentialId: b64url(rawId),
    /** base64url user handle from the registration options */
    userHandle: null,
    counter: 0,
    async register(options, over = {}) {
      const origin = over.origin ?? "https://genclass.dev";
      const rpId = over.rpId ?? options.rp.id;
      const flags = over.flags ?? FLAGS.UP | FLAGS.UV | FLAGS.AT;
      const counter = over.counter ?? 0;
      a.counter = counter;
      a.userHandle = options.user.id;
      const clientData = enc.encode(JSON.stringify({ type: over.type ?? "webauthn.create", challenge: over.challenge ?? options.challenge, origin, crossOrigin: over.crossOrigin ?? false }));
      const authData = concat(await sha256(enc.encode(rpId)), [flags], u32(counter), new Uint8Array(16), [rawId.length >> 8, rawId.length & 0xff], rawId, over.cose ?? cose);
      const att = cbor(new Map([["fmt", over.fmt ?? "none"], ["attStmt", over.attStmt ?? new Map()], ["authData", authData]]));
      return {
        id: b64url(over.rawId ?? rawId),
        rawId: b64url(over.rawId ?? rawId),
        type: "public-key",
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(att), transports: ["internal", "hybrid"] },
      };
    },
    async assert(options, over = {}) {
      const origin = over.origin ?? "https://genclass.dev";
      const rpId = over.rpId ?? options.rpId;
      const flags = over.flags ?? FLAGS.UP | FLAGS.UV;
      const counter = over.counter ?? a.counter + 1;
      a.counter = counter;
      const clientData = enc.encode(JSON.stringify({ type: over.type ?? "webauthn.get", challenge: over.challenge ?? options.challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(enc.encode(rpId)), [flags], u32(counter));
      const signed = concat(authData, await sha256(clientData));
      let sig = new Uint8Array(await crypto.subtle.sign(alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, signed));
      if (alg === -7) sig = rawToDer(sig);
      if (over.tamper) sig[sig.length - 1] ^= 1;
      return {
        id: b64url(rawId),
        rawId: b64url(rawId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientData),
          authenticatorData: b64url(authData),
          signature: b64url(sig),
          userHandle: over.userHandle === undefined ? a.userHandle : over.userHandle,
        },
      };
    },
  };
  return a;
}
