// Minimal CBOR decoder (RFC 8949) for WebAuthn: the attestationObject and COSE_Key structures (src/webauthn.ts).
//
// - Definite lengths only (CTAP2 authenticators emit canonical CBOR); indefinite lengths are rejected.
// - Maps keep integer and text keys in a Map; any other key type, or a duplicate key, is rejected.
// - Tags are unwrapped (the tag number is dropped); half, single and double floats are decoded; integers beyond
//   Number.MAX_SAFE_INTEGER are rejected.
// - Nesting depth and the number of items are bounded, so hostile input cannot exhaust the isolate.
// Every malformed input throws CborError; callers turn it into a 400.

export class CborError extends Error {}

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<number | string, CborValue>;

const MAX_DEPTH = 16;
const MAX_ITEMS = 10_000;

function half(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/**
 * Decode the first CBOR item of `buf` starting at `start`. Returns the value and the offset just past it, so a caller
 * can find where an embedded item ends (the COSE key inside authenticator data is followed by extensions).
 */
export function decodeFirst(buf: Uint8Array, start = 0): { value: CborValue; end: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  let items = 0;
  const need = (n: number): void => {
    if (n < 0 || pos + n > buf.length) throw new CborError("unexpected end of CBOR data");
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[pos++]!;
    }
    if (info === 25) {
      need(2);
      const v = view.getUint16(pos);
      pos += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(pos);
      pos += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("CBOR integer too large");
      return Number(v);
    }
    throw new CborError(info === 31 ? "indefinite-length CBOR is not supported" : "reserved CBOR additional information");
  };
  const item = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError("CBOR nested too deeply");
    if (++items > MAX_ITEMS) throw new CborError("too many CBOR items");
    need(1);
    const ib = buf[pos++]!;
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        need(n);
        const out = buf.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = length(info);
        need(n);
        let s: string;
        try {
          s = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(pos, pos + n));
        } catch {
          throw new CborError("invalid UTF-8 in CBOR text");
        }
        pos += n;
        return s;
      }
      case 4: {
        const n = length(info);
        if (n > MAX_ITEMS) throw new CborError("CBOR array too long");
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const n = length(info);
        if (n > MAX_ITEMS) throw new CborError("CBOR map too long");
        const m = new Map<number | string, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== "number" && typeof k !== "string") throw new CborError("CBOR map keys must be integers or text");
          if (m.has(k)) throw new CborError("duplicate CBOR map key");
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 6:
        length(info);
        return item(depth + 1);
      default: {
        // major type 7: simple values and floats
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 25) {
          need(2);
          const v = half(view.getUint16(pos));
          pos += 2;
          return v;
        }
        if (info === 26) {
          need(4);
          const v = view.getFloat32(pos);
          pos += 4;
          return v;
        }
        if (info === 27) {
          need(8);
          const v = view.getFloat64(pos);
          pos += 8;
          return v;
        }
        throw new CborError("unsupported CBOR simple value");
      }
    }
  };
  const value = item(0);
  return { value, end: pos };
}

/** Decode a buffer that must hold exactly one CBOR item. */
export function decodeCbor(buf: Uint8Array): CborValue {
  const { value, end } = decodeFirst(buf, 0);
  if (end !== buf.length) throw new CborError("trailing bytes after CBOR item");
  return value;
}
