// What the scanner may load: normalisation of the address a person types, the host block list, the DNS check and
// the robots.txt opt-out. Everything here runs before a browser is started, and hostAllowedForRequest() runs again
// for every request the browser makes (redirects included), so a page cannot steer the scanner somewhere private.

import { blockedIPv4, blockedIPv6, classifyIp, parseIPv4, parseIPv6 } from "./ip.ts";
import { TLDS } from "./tlds.ts";

export type Target = {
  ok: true;
  /** The normalised URL that is loaded and cached: http(s), no credentials, no fragment, no trailing dot. */
  url: string;
  host: string;
  /** Short form for headings and share links: host plus path and query, no scheme, no trailing slash. */
  display: string;
};
export type Refusal = { ok: false; code: string; message: string };

/** Hostname suffixes that are never scanned, whatever they resolve to. */
const BLOCKED_SUFFIXES = [
  "localhost", "local", "internal", "test", "example", "invalid", "onion", "arpa", "home", "lan", "corp", "intranet",
  "private", "localdomain", "home.arpa",
];
/** Our own hosts: the scanner never scans genclass.dev (any subdomain), itself or the other genclass workers. */
const SELF_SUFFIXES = ["genclass.dev", "genclass-scan.mehar-144.workers.dev", "genclass-site.mehar-144.workers.dev", "genclass-telemetry.mehar-144.workers.dev"];

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });

const IP_MESSAGES: Record<string, string> = {
  loopback: "That is a loopback address. The scanner only loads public websites.",
  private: "That is a private network address. The scanner only loads public websites.",
  "link-local": "That is a link-local address. The scanner only loads public websites.",
  metadata: "That is a cloud metadata address. The scanner only loads public websites.",
  cgnat: "That is a carrier-grade NAT address. The scanner only loads public websites.",
};

const endsWithLabel = (host: string, suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);

/** True when a hostname (already lowercase ASCII) is one of ours or a reserved or local name. */
export function blockedName(host: string, extraSelf: readonly string[] = []): string | null {
  const h = host.replace(/\.+$/, "");
  for (const s of BLOCKED_SUFFIXES) if (endsWithLabel(h, s)) return "local";
  for (const s of [...SELF_SUFFIXES, ...extraSelf]) if (endsWithLabel(h, s)) return "self";
  return null;
}

/** A syntactically valid public hostname: 2+ labels, LDH labels of 1 to 63 characters, an IANA top-level domain. */
export function publicHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return false;
  return TLDS.has(labels[labels.length - 1]);
}

/**
 * Normalises what a person typed into the URL to scan, or refuses it with a message to show them.
 * Adds https:// when there is no scheme; accepts only http and https on their default ports; strips credentials
 * and the fragment; refuses IP literals, local and reserved names, our own hosts and hosts without a public TLD.
 */
export function normaliseTarget(input: unknown, extraSelf: readonly string[] = []): Target | Refusal {
  if (typeof input !== "string") return refuse("invalid", "Enter the address of a public web page.");
  let s = input.trim();
  if (!s) return refuse("invalid", "Enter the address of a public web page.");
  if (s.length > 2048) return refuse("invalid", "That address is too long.");
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return refuse("invalid", "That address contains spaces or control characters.");
  if (/^https?:/i.test(s)) {
    /* the URL parser handles https:example.com and https:/example.com too */
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|blob|about|mailto|view-source|chrome|ws|wss|ftp|tel|sms):/i.test(s)) {
    return refuse("scheme", "Only http and https pages can be scanned.");
  } else {
    s = s.startsWith("//") ? `https:${s}` : `https://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return refuse("invalid", "That does not look like a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return refuse("scheme", "Only http and https pages can be scanned.");
  u.username = "";
  u.password = "";
  u.hash = "";
  if (u.port) return refuse("port", "Only pages on the standard ports (80 and 443) can be scanned.");
  let host = u.hostname.toLowerCase();
  const ip = classifyIp(host);
  if (ip) {
    return refuse("ip", (ip.blocked && IP_MESSAGES[ip.blocked]) || "Enter a hostname such as example.com, not an IP address.");
  }
  host = host.replace(/\.+$/, "");
  if (!host) return refuse("invalid", "That does not look like a web address.");
  u.hostname = host;
  const named = blockedName(host, extraSelf);
  if (named === "self") return refuse("self", "The scanner does not scan genclass.dev itself.");
  if (named === "local") return refuse("local", "That is a local or reserved name. The scanner only loads public websites.");
  if (!publicHostname(host)) return refuse("tld", "That hostname has no public top-level domain (like .com or .dev).");
  const url = u.href;
  const path = u.pathname === "/" ? (u.search ? "/" : "") : u.pathname.replace(/\/$/, "");
  const display = `${host}${path}${u.search}`;
  return { ok: true, url, host, display };
}

/**
 * Whether the scanner's browser may request this URL at all (every request, every redirect hop). Literal checks
 * only: IP literals in blocked ranges, local and reserved names. Public names are resolved by the browser itself;
 * the main page's name is also checked with resolveCheck() before the browser starts and on each redirect.
 */
export function hostAllowedForRequest(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "unparseable URL" };
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return { ok: true };
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: `scheme ${u.protocol}` };
  const host = u.hostname.toLowerCase();
  const ip = classifyIp(host);
  if (ip) return ip.blocked ? { ok: false, reason: `${ip.blocked} address` } : { ok: true };
  if (blockedName(host) === "local") return { ok: false, reason: "local name" };
  return { ok: true };
}

/** Whether an address from a DNS answer is private, loopback, link-local, CGNAT, metadata or otherwise reserved. */
export function blockedAddress(addr: string): string | null {
  if (addr.includes(":")) {
    const g = parseIPv6(addr);
    return g ? blockedIPv6(g) : "invalid";
  }
  const b = parseIPv4(addr);
  return b ? blockedIPv4(b) : "invalid";
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolves the hostname over DNS-over-HTTPS (A and AAAA) and refuses names that do not resolve or resolve to a
 * blocked address. Fails closed when the resolver cannot be reached.
 */
export async function resolveCheck(host: string, fetcher: Fetcher, timeoutMs = 3000): Promise<{ ok: true; addresses: string[] } | Refusal> {
  const ask = async (type: "A" | "AAAA"): Promise<{ status: number; answers: string[] } | null> => {
    try {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
      const want = type === "A" ? 1 : 28;
      return { status: j.Status ?? -1, answers: (j.Answer ?? []).filter((a) => a.type === want).map((a) => String(a.data)) };
    } catch {
      return null;
    }
  };
  const [a, aaaa] = await Promise.all([ask("A"), ask("AAAA")]);
  if (!a && !aaaa) return refuse("dns", "Could not look up that hostname right now. Try again in a minute.");
  const addresses = [...(a?.answers ?? []), ...(aaaa?.answers ?? [])];
  if (!addresses.length) return refuse("nxdomain", "That hostname does not resolve to an address.");
  for (const addr of addresses) {
    if (blockedAddress(addr)) return refuse("private", "That hostname points to a private or reserved address. The scanner only loads public websites.");
  }
  return { ok: true, addresses };
}

// ------------------------------------------------------------------------------------------------- robots.txt

/**
 * RFC 9309 matching for one product token: returns the rules of the group that names `token` (case-insensitive),
 * ignoring `*` groups. A person asked for this single page, so the scanner honours only rules written for it.
 */
export function robotsRulesFor(text: string, token: string): { allow: boolean; path: string }[] | null {
  const want = token.toLowerCase();
  let rules: { allow: boolean; path: string }[] | null = null;
  let agents: string[] = [];
  let inRules = false;
  let current: { allow: boolean; path: string }[] = [];
  const flush = () => {
    if (agents.some((a) => a === want)) rules = [...(rules ?? []), ...current];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (inRules) {
        flush();
        agents = [];
        current = [];
        inRules = false;
      }
      agents.push(value.toLowerCase().split("/")[0]);
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      if (value || key === "allow") current.push({ allow: key === "allow", path: value });
    }
  }
  flush();
  return rules;
}

const robotsPattern = (p: string): RegExp => {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
};

/** Whether `pathWithQuery` is disallowed by the rules (longest match wins, Allow wins a tie). */
export function robotsDisallows(rules: { allow: boolean; path: string }[], pathWithQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (!r.path) continue;
    if (!robotsPattern(r.path).test(pathWithQuery)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? !best.allow : false;
}

/**
 * Reads the site's robots.txt (redirects followed by hand, each hop checked, at most 3; 2 s; 64 KB) and refuses
 * when a GenClassScan group disallows the page. A missing or unreadable robots.txt allows the scan.
 */
export async function robotsCheck(target: Target, fetcher: Fetcher, userAgent: string): Promise<{ ok: true } | Refusal> {
  let next = new URL("/robots.txt", target.url).href;
  for (let hop = 0; hop < 4; hop++) {
    if (!hostAllowedForRequest(next).ok) return { ok: true };
    let res: Response;
    try {
      res = await fetcher(next, { redirect: "manual", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(2000) });
    } catch {
      return { ok: true };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: true };
      next = new URL(loc, next).href;
      continue;
    }
    if (!res.ok) return { ok: true };
    const text = (await res.text()).slice(0, 65536);
    const rules = robotsRulesFor(text, "GenClassScan");
    if (!rules) return { ok: true };
    const u = new URL(target.url);
    return robotsDisallows(rules, `${u.pathname}${u.search}`)
      ? refuse("robots", "This site's robots.txt asks GenClassScan not to load this page, so the scanner does not.")
      : { ok: true };
  }
  return { ok: true };
}
