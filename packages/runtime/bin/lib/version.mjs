// This CLI's own version, the command that runs it again, and what npm's dist-tags say about newer releases
// (owner: INSTALL). While the version is a prerelease, every command the CLI prints names its dist-tag
// (`npx @genclass/runtime@beta ...`): a bare `npx @genclass/runtime` runs npm's `latest`, an older line without the
// token, the dashboard, analytics or this CLI's commands. `init` prints the version line and, once per run, asks npm
// for the dist-tags (`npm view @genclass/runtime dist-tags --json`, at most 3 s) to say when a newer release exists;
// never with --dry-run, --no-network, --no-token or --no-telemetry, never when npm is offline.
// GENCLASS_TEST_DIST_TAGS (tests only) replaces the npm call: a JSON object of tags, or "fail".

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = "@genclass/runtime";
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** This package's version ("latest" if package.json cannot be read). */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version;
  } catch {
    return "latest";
  }
})();

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The prerelease's first identifier ("beta" for 0.3.0-beta.1), or null for a release or something unreadable. */
export function channelOf(version) {
  const m = SEMVER.exec(String(version ?? ""));
  const id = m?.[4]?.split(".")[0];
  return id && /^[a-z][a-z0-9-]*$/i.test(id) ? id : null;
}

/** `npx @genclass/runtime@<channel>` while this is a prerelease, else `npx @genclass/runtime`. */
export const cmdFor = (version) => {
  const ch = channelOf(version);
  return ch ? `npx ${PKG}@${ch}` : `npx ${PKG}`;
};
export const CMD = cmdFor(VERSION);

/** Semver order (prereleases before their release); null when either side is not a version. */
export function compareVersions(a, b) {
  const x = SEMVER.exec(String(a ?? ""));
  const y = SEMVER.exec(String(b ?? ""));
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** The lowest version a dependency spec names ("^0.2.0" -> "0.2.0"), or null (a tag, "*", a path, a URL). */
export function versionInSpec(spec) {
  const m = /^\s*(?:[\^~]|>=?|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(spec ?? ""));
  return m ? m[1] : null;
}

/** The @genclass/runtime version installed for the project in `dir` (its node_modules or a parent's), or null. */
export function installedVersion(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    try {
      const v = JSON.parse(readFileSync(join(d, "node_modules", "@genclass", "runtime", "package.json"), "utf8")).version;
      if (typeof v === "string") return v;
    } catch {
      /* not here */
    }
    if (dirname(d) === d) return null;
  }
}

/**
 * npm's dist-tags for the package ({ latest, beta, ... }), or null: offline, npm missing, slower than `timeoutMs`,
 * or an answer that is not an object of versions.
 */
export function distTags({ timeoutMs = 3000, env = process.env } = {}) {
  const fake = env.GENCLASS_TEST_DIST_TAGS;
  if (fake !== undefined) return Promise.resolve(fake === "fail" ? null : tagsOf(fake));
  if (/^(1|true)$/i.test(String(env.npm_config_offline ?? ""))) return Promise.resolve(null);
  return new Promise((done) => {
    let text = "";
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(v);
    };
    let child;
    try {
      child = spawn("npm", ["view", PKG, "dist-tags", "--json"], { stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32", env });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (b) => (text += b));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? tagsOf(text) : null));
  });
}

function tagsOf(text) {
  try {
    const o = JSON.parse(text);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    const tags = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && SEMVER.test(v)) tags[k] = v;
    return Object.keys(tags).length ? tags : null;
  } catch {
    return null;
  }
}

/**
 * What to say about `version` given npm's `tags` (null: not checked): { tag } the dist-tag that points at it (null:
 * none), and { newer: { version, tag } } the highest release on any dist-tag above it (null: none).
 */
export function versionStatus(version, tags) {
  if (!tags) return { tag: null, newer: null };
  const entries = Object.entries(tags);
  const tag = entries.find(([k, v]) => v === version && k === "latest")?.[0] ?? entries.find(([, v]) => v === version)?.[0] ?? null;
  let newer = null;
  for (const [k, v] of entries) {
    if (compareVersions(v, version) !== 1) continue;
    if (!newer || compareVersions(v, newer.version) === 1) newer = { version: v, tag: k };
  }
  return { tag, newer };
}
