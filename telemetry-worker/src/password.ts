// Passwords for genclass.dev accounts: how a password is hashed and checked (PBKDF2-HMAC-SHA256 through WebCrypto), the
// rules a new password must meet, and the schedule of the per-account delay after wrong passwords. No I/O here: the
// routes, the throttle's storage and the sessions are in src/auth.ts.
//
// Invariants:
// - A password is stored only as a versioned string (HASH_RE):
//     $pbkdf2-sha256$v=1$i=600000,l=100000$<salt>$<hash>
//   with a 16-byte random salt and a 32-byte output, both base64url without padding. `i` is the work, in PBKDF2
//   iterations of HMAC-SHA256; `l` is the most iterations one WebCrypto call runs. Cloudflare Workers refuse a PBKDF2
//   call over 100,000 iterations (workerd's DEFAULT_MAX_PBKDF2_ITERATIONS), so i = 600,000 is reached by chaining
//   i / l calls: link 1 is PBKDF2(password, salt, l), link k is PBKDF2(link k-1, salt, l). Every link needs the whole
//   output of the one before, so a guess costs i iterations, as one PBKDF2 call of i would; with i = l it is plain
//   PBKDF2. Checking reads v, i, l and the salt from the stored string, so old strings keep working when the defaults
//   rise, and needsRehash() says when to store a new one after a correct password.
// - The derived bytes are compared in constant time.
// - The rules (NIST SP 800-63B): 10 to 256 characters, counted as code points after NFC normalisation; no composition
//   rules; refused when it is on COMMON (case-insensitive), one character repeated, or the account's email.

import { b64url, equalBytes, fromB64url } from "./webauthn.js";

/** The work of a new hash, in PBKDF2-HMAC-SHA256 iterations (OWASP's 2023 figure for this function). */
export const PASSWORD_ITERATIONS = 600_000;
/** The most iterations one WebCrypto PBKDF2 call may run on Cloudflare Workers (a larger one throws). */
export const PBKDF2_CALL_MAX = 100_000;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const VERSION = 1;

/** `$pbkdf2-sha256$v=1$i=<iterations>,l=<per call>$<salt>$<hash>`. */
export const HASH_RE = /^\$pbkdf2-sha256\$v=(\d{1,3})\$i=(\d{1,9}),l=(\d{1,9})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{43})$/;

/**
 * Common passwords of 10 characters or more (shorter ones fail the length rule anyway), compared case-insensitively.
 * A small list on purpose: the long tail is what the per-account delay is for.
 */
export const COMMON = new Set(
  [
    "0000000000", "0123456789", "0987654321", "1111111111", "1122334455", "1212121212", "1231231231", "1234512345",
    "1234567890", "12345678910", "123123123123", "123456789a", "123456789q", "1234567890a", "1234567890q", "1234qwerty",
    "123456qwerty", "1q2w3e4r5t", "1q2w3e4r5t6y", "1qaz2wsx3edc", "9876543210", "a123456789", "aaaaaa1111",
    "abc1234567", "abcd123456", "abcdefg123", "abcdefgh12", "abcdefghij", "admin12345", "admin123456", "administrator",
    "asdfghjkl1", "asdfghjkl123", "baseball123", "basketball", "batman1234", "changeme123", "chocolate1",
    "computer123", "dragon1234", "everything", "football123", "freedom123", "genclass.dev", "genclass123",
    "genclass1234", "genclass2026", "genclassgenclass", "iloveyou12", "iloveyou123", "iloveyou1234", "letmein123",
    "letmeinplease", "master1234", "michael123", "monkey1234", "mypassword", "mypassword1", "p@ssw0rd123",
    "p@ssword123", "passw0rd123", "password12", "password123", "password1234", "password12345", "passwordpassword",
    "princess123", "q123456789", "q1w2e3r4t5", "q1w2e3r4t5y6", "qazwsxedcrfv", "qwe123qwe123", "qwerty1234",
    "qwerty12345", "qwerty123456", "qwertyuiop", "qwertyuiop123", "secret1234", "starwars123", "sunshine123",
    "superman123", "trustno1234", "welcome123", "welcome1234", "welcometo123", "whatever123", "zaq12wsxcde3",
    "zxcvbnm123",
  ].map((p) => p.toLowerCase()),
);

/** A password as hashed and measured: NFC, so the same characters typed on another system give the same bytes. */
export const normalizePassword = (pw: string): string => pw.normalize("NFC");

/** Why `pw` cannot be a new password (a sentence for the page), or null when it can. `email` is the account's username. */
export function passwordProblem(pw: unknown, email: string | null): string | null {
  if (typeof pw !== "string" || pw === "") return "enter a password";
  const p = normalizePassword(pw);
  const n = [...p].length;
  if (n < PASSWORD_MIN) return `use at least ${PASSWORD_MIN} characters`;
  if (n > PASSWORD_MAX) return `use at most ${PASSWORD_MAX} characters`;
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/su.test(p)) return "this password is too common; pick another one (a few unrelated words work well)";
  if (email && low.trim() === email.trim().toLowerCase()) return "your password cannot be your email address";
  return null;
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", password as BufferSource, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, HASH_BYTES * 8));
}

/** The chained derivation: ceil(i / l) WebCrypto calls of at most l iterations each, i in all. */
async function derive(pw: string, salt: Uint8Array, iterations: number, link: number): Promise<Uint8Array> {
  let out: Uint8Array = new TextEncoder().encode(normalizePassword(pw));
  for (let done = 0; done < iterations; done += link) out = await pbkdf2(out, salt, Math.min(link, iterations - done));
  return out;
}

/** A new stored string for `pw` (a fresh random salt). `o` is for tests of the format only. */
export async function hashPassword(pw: string, o: { iterations?: number; link?: number; salt?: Uint8Array } = {}): Promise<string> {
  const iterations = o.iterations ?? PASSWORD_ITERATIONS;
  const link = Math.min(o.link ?? PBKDF2_CALL_MAX, iterations, PBKDF2_CALL_MAX);
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const out = await derive(pw, salt, iterations, link);
  return `$pbkdf2-sha256$v=${VERSION}$i=${iterations},l=${link}$${b64url(salt)}$${b64url(out)}`;
}

function parse(stored: string): { v: number; i: number; l: number; salt: Uint8Array; hash: Uint8Array } | null {
  const m = HASH_RE.exec(stored);
  if (!m) return null;
  const [v, i, l] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v !== VERSION || i < 1 || l < 1 || l > PBKDF2_CALL_MAX || i > 10_000_000) return null;
  try {
    return { v, i, l, salt: fromB64url(m[4]!), hash: fromB64url(m[5]!) };
  } catch {
    return null;
  }
}

/** Whether `pw` matches the stored string (constant-time over the derived bytes; false for a malformed string). */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const s = parse(stored);
  if (!s) return false;
  const out = await derive(pw, s.salt, s.i, s.l);
  return equalBytes(out, s.hash);
}

/** A stored string made with less work or an older format than today's: store a new one after a correct password. */
export function needsRehash(stored: string): boolean {
  const s = parse(stored);
  return !s || s.i < PASSWORD_ITERATIONS;
}

/**
 * A well-formed stored string no password is known to match, checked when a sign-in names an email with no password,
 * so that answer takes as long as a wrong password for a real account (no timing hint that the email is unknown).
 */
export const DUMMY_HASH = `$pbkdf2-sha256$v=${VERSION}$i=${PASSWORD_ITERATIONS},l=${PBKDF2_CALL_MAX}$AAAAAAAAAAAAAAAAAAAAAA$${"A".repeat(43)}`;

// --------------------------------------------------------------------------------------------- the delay

/** Wrong passwords in a row (from browsers the account does not trust) before any delay. */
export const FREE_FAILURES = 5;
/** The longest delay between two checked passwords of one account. */
export const MAX_DELAY_MS = 15 * 60_000;
/** A day without a wrong password and the count starts again. */
export const FAILURE_WINDOW_MS = 86_400_000;
/** Wrong passwords a trusted browser may send in a row before it is treated like any other. */
export const DEVICE_FAILURES = 5;
/** How long a browser stays trusted for an account after a correct password there (the cookie's Max-Age). */
export const DEVICE_MS = 400 * 86_400_000;

/**
 * The delay after the `failed`-th wrong password in a row: none for the first FREE_FAILURES - 1, then 30 s doubling
 * each time up to MAX_DELAY_MS (30 s, 1, 2, 4, 8, then 15 minutes). The delay only spaces out the checks; it never
 * locks the account, and a browser where the password was right before skips it (src/auth.ts).
 */
export function delayAfter(failed: number): number {
  if (failed < FREE_FAILURES) return 0;
  return Math.min(MAX_DELAY_MS, 30_000 * 2 ** Math.min(failed - FREE_FAILURES, 10));
}

/** "30 seconds", "1 minute", "15 minutes": a wait rounded up, for the error message. */
export function waitText(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
