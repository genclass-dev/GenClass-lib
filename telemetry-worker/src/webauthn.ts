// WebAuthn (passkey) verification with WebCrypto only, no dependencies.
//
// - Registration: attestation "none". Any attestation format is accepted and its statement is NOT verified (we do not
//   need to know the authenticator's make); what we keep is the credential id and its COSE public key.
// - Algorithms: ES256 (COSE -7, P-256, the DER signature converted to raw r||s for WebCrypto) and RS256 (COSE -257,
//   RSASSA-PKCS1-v1_5 with SHA-256, at least 2048-bit keys).
// - Checks: clientDataJSON type and challenge, the exact expected origin, crossOrigin not set, the SHA-256 of the RP ID,
//   user presence, user verification when required, the attested credential id equals rawId, the COSE key matches its
//   algorithm, the assertion signature, and the sign counter never going backwards (a cloned authenticator).
// - The caller makes each challenge single-use and short-lived (src/auth.ts stores it with a 5 minute expiry and
//   deletes it when it is used).
// Every failure throws WebAuthnError with a message that is safe to show.

import { CborError, decodeCbor, decodeFirst, type CborValue } from "./cbor.js";

export const ES256 = -7;
export const RS256 = -257;
export const SUPPORTED_ALGS = [ES256, RS256];

export class WebAuthnError extends Error {}

// --------------------------------------------------------------------------------------------- base64url

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url (padding optional). Throws WebAuthnError on anything else. */
export function fromB64url(s: unknown, what = "value"): Uint8Array {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s) || s.length % 4 === 1) throw new WebAuthnError(`${what} is not base64url`);
  const t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

/** Constant-time comparison of two strings (their lengths may leak). */
export function equalStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return equalBytes(enc.encode(a), enc.encode(b));
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

// --------------------------------------------------------------------------------------------- parsing

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(b64: unknown): { data: ClientData; raw: Uint8Array } {
  const raw = fromB64url(b64, "clientDataJSON");
  if (raw.length > 8192) throw new WebAuthnError("clientDataJSON too large");
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  const d = data as Record<string, unknown>;
  if (!d || typeof d !== "object" || typeof d.type !== "string" || typeof d.challenge !== "string" || typeof d.origin !== "string") {
    throw new WebAuthnError("clientDataJSON is missing type, challenge or origin");
  }
  return { data: { type: d.type, challenge: d.challenge, origin: d.origin, crossOrigin: d.crossOrigin === true }, raw };
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Uint8Array;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

/** Parse authenticator data (WebAuthn section 6.1): rpIdHash, flags, signCount, attested credential data, extensions. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError("authenticator data too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[32]!;
  const out: AuthenticatorData = {
    rpIdHash: bytes.slice(0, 32),
    flags,
    userPresent: (flags & FLAG_UP) !== 0,
    userVerified: (flags & FLAG_UV) !== 0,
    signCount: view.getUint32(33),
  };
  let pos = 37;
  try {
    if (flags & FLAG_AT) {
      if (bytes.length < pos + 18) throw new WebAuthnError("attested credential data too short");
      pos += 16; // AAGUID: not used (attestation "none")
      const idLen = view.getUint16(pos);
      pos += 2;
      if (idLen === 0 || idLen > 1023 || bytes.length < pos + idLen) throw new WebAuthnError("bad credential id length");
      out.credentialId = bytes.slice(pos, pos + idLen);
      pos += idLen;
      const { end } = decodeFirst(bytes, pos);
      out.publicKey = bytes.slice(pos, end);
      pos = end;
    }
    if (flags & FLAG_ED) pos = decodeFirst(bytes, pos).end;
  } catch (e) {
    if (e instanceof CborError) throw new WebAuthnError("authenticator data is not valid CBOR");
    throw e;
  }
  if (pos !== bytes.length) throw new WebAuthnError("unexpected bytes after authenticator data");
  return out;
}

const stripZeros = (b: Uint8Array): Uint8Array => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

/** Import a COSE_Key (RFC 9053) as a WebCrypto verification key. Returns the key and its COSE algorithm. */
export async function importCoseKey(cose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  let m: CborValue;
  try {
    m = decodeCbor(cose);
  } catch {
    throw new WebAuthnError("public key is not valid CBOR");
  }
  if (!(m instanceof Map)) throw new WebAuthnError("public key is not a COSE key");
  const kty = m.get(1);
  const alg = m.get(3);
  try {
    if (alg === ES256) {
      const crv = m.get(-1);
      const x = m.get(-2);
      const y = m.get(-3);
      if (kty !== 2 || crv !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
        throw new WebAuthnError("ES256 key must be an EC2 P-256 key");
      }
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y), ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return { key, alg };
    }
    if (alg === RS256) {
      const n = m.get(-1);
      const e = m.get(-2);
      if (kty !== 3 || !(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new WebAuthnError("RS256 key must be an RSA key");
      const nn = stripZeros(n);
      if (nn.length < 256) throw new WebAuthnError("RSA keys must be at least 2048 bits");
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: b64url(nn), e: b64url(stripZeros(e)), alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return { key, alg };
    }
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError("public key could not be imported");
  }
  throw new WebAuthnError("unsupported public key algorithm (use ES256 or RS256)");
}

/** ECDSA signature: ASN.1 DER SEQUENCE { r INTEGER, s INTEGER } to the raw r||s form WebCrypto verifies. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let p = 0;
  const bad = (): never => {
    throw new WebAuthnError("malformed ECDSA signature");
  };
  if (der[p++] !== 0x30) bad();
  let len = der[p++] ?? bad();
  if (len & 0x80) {
    if (len !== 0x81) bad();
    len = der[p++] ?? bad();
  }
  if (p + len !== der.length) bad();
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < 2; i++) {
    if (der[p++] !== 0x02) bad();
    const l = der[p++] ?? bad();
    if (l === 0 || l > size + 1 || p + l > der.length) bad();
    let v = der.subarray(p, p + l);
    p += l;
    if (v.length === size + 1) {
      if (v[0] !== 0) bad();
      v = v.subarray(1);
    }
    out.set(v, i * size + (size - v.length));
  }
  if (p !== der.length) bad();
  return out;
}

// --------------------------------------------------------------------------------------------- ceremonies

export interface Expected {
  /** The challenge as base64url, exactly as sent in the options. */
  challenge: string;
  /** e.g. https://genclass.dev */
  origin: string;
  /** e.g. genclass.dev */
  rpId: string;
  /** Reject when the authenticator did not verify the user (PIN or biometrics). */
  requireUserVerification: boolean;
}

async function checkCommon(cd: ClientData, type: string, ad: AuthenticatorData, exp: Expected): Promise<void> {
  if (cd.type !== type) throw new WebAuthnError(`clientDataJSON type must be ${type}`);
  if (!equalStrings(cd.challenge, exp.challenge)) throw new WebAuthnError("challenge does not match");
  if (cd.origin !== exp.origin) throw new WebAuthnError("origin does not match");
  if (cd.crossOrigin) throw new WebAuthnError("cross-origin ceremonies are not allowed");
  if (!equalBytes(ad.rpIdHash, await sha256(new TextEncoder().encode(exp.rpId)))) throw new WebAuthnError("relying party id does not match");
  if (!ad.userPresent) throw new WebAuthnError("user presence flag not set");
  if (exp.requireUserVerification && !ad.userVerified) throw new WebAuthnError("user verification required");
}

export interface RegistrationResponse {
  rawId: unknown;
  clientDataJSON: unknown;
  attestationObject: unknown;
}

export interface VerifiedRegistration {
  /** base64url of the credential id */
  credentialId: string;
  /** COSE_Key bytes */
  publicKey: Uint8Array;
  alg: number;
  signCount: number;
  userVerified: boolean;
}

/** Verify navigator.credentials.create() output. Attestation statements are not verified (attestation "none"). */
export async function verifyRegistration(r: RegistrationResponse, exp: Expected): Promise<VerifiedRegistration> {
  const { data: cd } = parseClientData(r.clientDataJSON);
  const attBytes = fromB64url(r.attestationObject, "attestationObject");
  if (attBytes.length > 64 * 1024) throw new WebAuthnError("attestationObject too large");
  let att: CborValue;
  try {
    att = decodeCbor(attBytes);
  } catch {
    throw new WebAuthnError("attestationObject is not valid CBOR");
  }
  if (!(att instanceof Map) || typeof att.get("fmt") !== "string" || !(att.get("authData") instanceof Uint8Array)) {
    throw new WebAuthnError("attestationObject needs fmt and authData");
  }
  const ad = parseAuthenticatorData(att.get("authData") as Uint8Array);
  await checkCommon(cd, "webauthn.create", ad, exp);
  if (!ad.credentialId || !ad.publicKey) throw new WebAuthnError("no attested credential data");
  const rawId = fromB64url(r.rawId, "rawId");
  if (!equalBytes(rawId, ad.credentialId)) throw new WebAuthnError("credential id does not match the attested one");
  const { alg } = await importCoseKey(ad.publicKey);
  return { credentialId: b64url(ad.credentialId), publicKey: ad.publicKey, alg, signCount: ad.signCount, userVerified: ad.userVerified };
}

export interface AssertionResponse {
  clientDataJSON: unknown;
  authenticatorData: unknown;
  signature: unknown;
}

/**
 * Verify navigator.credentials.get() output against a stored credential. Returns the new sign count to store.
 * The caller has already matched the credential id (and the user handle, when present) to the stored record.
 */
export async function verifyAssertion(
  r: AssertionResponse,
  exp: Expected,
  stored: { publicKey: Uint8Array; alg: number; signCount: number },
): Promise<{ signCount: number; userVerified: boolean }> {
  const { data: cd, raw } = parseClientData(r.clientDataJSON);
  const adBytes = fromB64url(r.authenticatorData, "authenticatorData");
  const ad = parseAuthenticatorData(adBytes);
  await checkCommon(cd, "webauthn.get", ad, exp);
  const { key, alg } = await importCoseKey(stored.publicKey);
  if (alg !== stored.alg) throw new WebAuthnError("stored key algorithm mismatch");
  const sig = fromB64url(r.signature, "signature");
  const signed = new Uint8Array(adBytes.length + 32);
  signed.set(adBytes, 0);
  signed.set(await sha256(raw), adBytes.length);
  const ok =
    alg === ES256
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig) as BufferSource, signed)
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig as BufferSource, signed);
  if (!ok) throw new WebAuthnError("signature does not verify");
  // WebAuthn 7.2 step 21: a counter that does not increase signals a possibly cloned authenticator.
  if ((ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount) {
    throw new WebAuthnError("sign counter did not increase (possible cloned authenticator)");
  }
  return { signCount: ad.signCount, userVerified: ad.userVerified };
}
