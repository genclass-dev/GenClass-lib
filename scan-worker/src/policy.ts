// What happens to each request the scanner's browser makes. Pure: scan.ts feeds it request facts and applies the
// verdict (continue, abort, or answer locally).
//
// The guarantees, in every view and phase:
// - A non-GET request (POST, PUT, PATCH, DELETE, beacons, form posts) never reaches the network. It is answered
//   locally: fetch/XHR get a plausible 200 JSON, a form navigation gets 204 so the page stays where it is.
// - A request to a blocked host (private, loopback, link-local, CGNAT or metadata IP literals, local names) is aborted,
//   redirect hops included.
// - Every request to a hostname is checked in DNS by scan.ts before it continues (cached per scan): a name that points
//   to a private address is not loaded. A main-frame navigation (the first load and its redirects) is also checked
//   against the opt-out list and robots.txt, and one to genclass.dev is aborted here.
// - Once the page has loaded, the main frame never navigates again: the probe does not follow links.
// - While the probe clicks, fetch/XHR/document GETs to other origins are aborted, so nothing is submitted to a third
//   party by GET either.
// - During the probe, same-origin and cross-origin fetch/XHR GETs get extra latency so responses can arrive out of
//   order.

import { classifyIp } from "./ip.ts";
import { blockedName, hostAllowedForRequest } from "./target.ts";

export type Phase = "load" | "type" | "click" | "settle";

export interface RequestFacts {
  url: string;
  method: string;
  /** Puppeteer resource type: document, stylesheet, image, media, font, script, xhr, fetch, ping, other, ... */
  resourceType: string;
  isNavigation: boolean;
  isMainFrame: boolean;
}

export interface PolicyContext {
  /** Origin of the page being scanned (after the first navigation). */
  pageOrigin: string;
  phase: Phase;
  /** Extra latency for a probe GET, in ms (0 to 1500); called once per eligible request. */
  latency: () => number;
  /** Local answer delay for a non-GET fetch/XHR, so a second click can land while the first is in flight. */
  answerDelayMs: number;
}

/** What scan.ts checks before a request continues: nothing (an IP literal already checked here), the host's DNS
 * answer (every request to a hostname), or the full navigation check (main-frame navigations: DNS, opt-out list,
 * robots.txt). */
export type Check = "none" | "dns" | "navigation";

export type Verdict =
  | { kind: "continue"; delayMs: number; check: Check }
  | { kind: "abort"; reason: string }
  | { kind: "fulfill"; status: number; headers: Record<string, string>; body: string; delayMs: number; reason: string };

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const DATA_TYPES = new Set(["fetch", "xhr", "eventsource", "other"]);

const originOf = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** The local answer for a non-GET request: CORS headers for the page's origin so the page's own code can read it. */
export function localAnswer(f: RequestFacts, ctx: PolicyContext, n: number): Verdict {
  const cors: Record<string, string> = ctx.pageOrigin
    ? {
        "access-control-allow-origin": ctx.pageOrigin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-expose-headers": "*",
      }
    : {};
  if (f.method === "OPTIONS") return { kind: "fulfill", status: 204, headers: cors, body: "", delayMs: 0, reason: "preflight answered locally" };
  if (f.resourceType === "document" || f.isNavigation) {
    return { kind: "fulfill", status: 204, headers: {}, body: "", delayMs: 0, reason: "form navigation answered locally (204: the page stays)" };
  }
  return {
    kind: "fulfill",
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors },
    body: JSON.stringify({ ok: true, id: `scan-${n}`, status: "ok" }),
    delayMs: ctx.answerDelayMs,
    reason: `${f.method} answered locally`,
  };
}

/** Decides one request. `n` numbers the local answers (for their ids). */
export function decideRequest(f: RequestFacts, ctx: PolicyContext, n = 0): Verdict {
  let scheme = "";
  try {
    scheme = new URL(f.url).protocol;
  } catch {
    return { kind: "abort", reason: "unparseable URL" };
  }
  if (scheme === "data:" || scheme === "blob:" || scheme === "about:") return { kind: "continue", delayMs: 0, check: "none" };
  const allowed = hostAllowedForRequest(f.url);
  if (!allowed.ok) return { kind: "abort", reason: `blocked host (${allowed.reason})` };
  let host = "";
  try {
    host = new URL(f.url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  // a public IP literal needs no lookup; every name is resolved by scan.ts before the browser resolves it itself
  const named: Check = host && !classifyIp(host) ? "dns" : "none";

  const method = f.method.toUpperCase();
  if (!SAFE_METHODS.has(method)) return localAnswer({ ...f, method }, ctx, n);

  const mainNav = f.isNavigation && f.isMainFrame;
  if (mainNav) {
    if (ctx.phase !== "load") return { kind: "abort", reason: "navigation after load (the probe does not follow links)" };
    if (blockedName(host) === "self") return { kind: "abort", reason: "navigation to genclass.dev (the scanner does not scan itself)" };
    return { kind: "continue", delayMs: 0, check: "navigation" };
  }
  if (ctx.phase === "load") return { kind: "continue", delayMs: 0, check: named };

  const thirdParty = ctx.pageOrigin !== "" && originOf(f.url) !== ctx.pageOrigin;
  const dataLike = DATA_TYPES.has(f.resourceType) || f.resourceType === "document";
  if (ctx.phase === "click" && thirdParty && dataLike) return { kind: "abort", reason: "third-party request during the click probe" };
  if (f.resourceType === "fetch" || f.resourceType === "xhr") return { kind: "continue", delayMs: ctx.latency(), check: named };
  return { kind: "continue", delayMs: 0, check: named };
}

/**
 * Deterministic latency for the probe: a seeded generator (the same URL gets the same sequence) drawing from
 * 0 to 1500 ms, with each draw in a burst shorter than the one before, so a burst of typeahead requests tends to
 * complete in reverse order.
 */
export function latencySequence(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let state = h || 1;
  const rand = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  let ceiling = 1500;
  return () => {
    const v = Math.round(ceiling * (0.6 + 0.4 * rand()));
    ceiling = Math.max(0, v - 150);
    if (ceiling < 150) ceiling = 1500; // start a new burst
    return Math.min(1500, Math.max(0, v));
  };
}
