#!/usr/bin/env node
// For the owner: a password string the telemetry worker accepts (src/password.ts), to reset a forgotten password by
// hand while GenClass has no email sender (README, "Owner steps: a forgotten password"). It reads the new password from
// stdin, so it stays out of the shell's history, and prints the string to store in passwords.hash:
//
//   read -rs PW && printf '%s' "$PW" | node telemetry-worker/scripts/password-hash.mjs; unset PW
//
// The derivation is src/password.ts's: PBKDF2-HMAC-SHA256, 600,000 iterations in chained calls of 100,000, a 16-byte
// random salt, the password NFC-normalised. test/auth.test.ts checks that the worker accepts what this prints.

import { pathToFileURL } from "node:url";

const ITERATIONS = 600_000;
const LINK = 100_000;
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The stored string for `pw`, with a fresh salt. */
export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  let out = new TextEncoder().encode(pw.normalize("NFC"));
  for (let done = 0; done < ITERATIONS; done += LINK) {
    const key = await crypto.subtle.importKey("raw", out, "PBKDF2", false, ["deriveBits"]);
    out = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: Math.min(LINK, ITERATIONS - done) }, key, 256));
  }
  return `$pbkdf2-sha256$v=1$i=${ITERATIONS},l=${LINK}$${b64url(salt)}$${b64url(out)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const pw = input.replace(/\r?\n$/, "");
  if ([...pw.normalize("NFC")].length < 10) {
    console.error("Use at least 10 characters (read from stdin).");
    process.exit(1);
  }
  console.log(await hashPassword(pw));
}
