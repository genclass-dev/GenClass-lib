// Site-level checks (scan-score/4): the security of the main document and what search engines and link previews read.
//   - judgeSecurity: the page over HTTPS; the main document's response headers as the browser received them
//     (src/cdp.ts PageLog.mainDocument): Strict-Transport-Security, Content-Security-Policy (header or meta tag),
//     X-Content-Type-Options, X-Frame-Options or frame-ancestors, and the Set-Cookie headers of that response; and
//     whether http:// redirects to https:// (siteProbe, from the worker).
//   - judgeSearch: the meta description, robots noindex (meta tag or X-Robots-Tag), link preview tags, a favicon (a
//     link rel=icon, or /favicon.ico answering with an image), links whose whole text is generic; and quirks mode.
// Every judge is pure: measured data in, findings out, each naming what it read. Headers are judged only for a main
// document the server answered with 2xx, so a bot challenge or an error page is never judged as the site.

import type { RawFinding } from "./catalog.ts";
import type { Severity } from "./score.ts";
import { hostAllowedForRequest, type Fetcher as TargetFetcher, type Target } from "./target.ts";

type Fetcher = TargetFetcher;

const cut = (v: unknown, n = 160): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n) : "");
const short = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 120);
  } catch {
    return u.slice(0, 120);
  }
};

/** What the worker measured about the site itself, outside the browser: http:// and /favicon.ico. */
export interface SiteProbe {
  /**
   * Where http:// for the page's address ended up: "https" (redirected to https://), "http" (answered 2xx over http,
   * at `url`), or null (no answer, an error status, or too many hops: not judged).
   */
  http: { end: "https" | "http"; url: string; hops: number } | null;
  /** /favicon.ico on the page's origin: its status and content type, or null when it could not be fetched. */
  favicon: { status: number; type: string } | null;
  /** Whether the host is on the browsers' HSTS preload list (hstspreload.org), or null when that was not known. */
  preloaded?: boolean | null;
  /**
   * The page itself fetched by the worker (redirects followed by hand, the body never read): its final URL, status and
   * security headers. A header the browser's copy lacks but this one has counts as sent (judgeSecurity): a proxy or an
   * edge cache in front of the browser can drop one, and a finding must hold for every visitor.
   */
  page?: { url: string; status: number; headers: Record<string, string> } | null;
}

/** The headers the security checks read, as the worker's own fetch of the page reports them. */
export const SECURITY_HEADERS = ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "x-robots-tag"] as const;

/** At most `n` bytes of a response's body as text; the rest is never read. */
async function firstBytes(res: Response, n: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let got = 0;
  try {
    while (got < n) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      got += value.byteLength;
    }
  } catch {
    /* what arrived is enough */
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(got, n));
  let at = 0;
  for (const p of parts) {
    const take = Math.min(p.byteLength, all.length - at);
    all.set(p.subarray(0, take), at);
    at += take;
    if (at >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

/** Follows redirects by hand (at most 4 hops), each to a public http(s) address only. */
async function follow(start: string, fetcher: Fetcher, ua: string, method: "GET" | "HEAD"): Promise<{ res: Response; url: string; hops: number } | null> {
  let next = start;
  for (let hop = 0; hop < 5; hop++) {
    if (!hostAllowedForRequest(next).ok) return null;
    let res: Response;
    try {
      res = await fetcher(next, { method, redirect: "manual", headers: { "user-agent": ua }, signal: AbortSignal.timeout(3000) });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) return null;
      try {
        next = new URL(loc, next).href;
      } catch {
        return null;
      }
      if (next.startsWith("https:") && start.startsWith("http:")) return { res, url: next, hops: hop + 1 };
      continue;
    }
    return { res, url: next, hops: hop };
  }
  return null;
}

/**
 * The worker's own two requests about the site, started with the scan: http:// for the page's address (redirects
 * followed by hand until one points to https://) and /favicon.ico. Bodies are never read. Never throws.
 */
export async function siteProbe(target: Target, fetcher: Fetcher, ua: string): Promise<SiteProbe> {
  const out: SiteProbe = { http: null, favicon: null, preloaded: null, page: null };
  const page = new URL(target.url);
  await Promise.all([
    (async () => {
      if (page.protocol !== "https:") return;
      const r = await follow(`http://${page.host}${page.pathname}${page.search}`, fetcher, ua, "GET").catch(() => null);
      if (!r) return;
      if (r.url.startsWith("https:")) out.http = { end: "https", url: r.url, hops: r.hops };
      else if (r.res.status >= 200 && r.res.status < 300) {
        // a page answered over http that sends the browser on to https at once (a meta refresh or a script) counts as
        // redirecting: only its first 16 KB are read
        const head = await firstBytes(r.res, 16384);
        const onward = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=\s*['"]?https:\/\//i.test(head) || /location(?:\.href)?\s*=\s*["'`]https:\/\/|location\.(?:replace|assign)\(\s*["'`]https:\/\/|location\.protocol\s*=\s*["'`]https:?["'`]/i.test(head);
        out.http = { end: onward ? "https" : "http", url: r.url, hops: r.hops };
        return;
      }
      await r.res.body?.cancel().catch(() => undefined);
    })(),
    (async () => {
      const r = await follow(target.url, fetcher, ua, "GET").catch(() => null);
      if (!r) return;
      const headers: Record<string, string> = {};
      for (const k of SECURITY_HEADERS) {
        const v = r.res.headers.get(k);
        if (v !== null) headers[k] = cut(v, 2000);
      }
      out.page = { url: r.url, status: r.res.status, headers };
      await r.res.body?.cancel().catch(() => undefined);
    })(),
    (async () => {
      // the HSTS preload list's status for the host (only the hostname is sent)
      if (page.protocol !== "https:") return;
      try {
        const res = await fetcher(`https://hstspreload.org/api/v2/status?domain=${encodeURIComponent(page.hostname)}`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const j = (await res.json()) as { status?: unknown };
        out.preloaded = j.status === "preloaded";
      } catch {
        out.preloaded = null;
      }
    })(),
    (async () => {
      const r = await follow(`${page.origin}/favicon.ico`, fetcher, ua, "GET").catch(() => null);
      if (!r) return;
      out.favicon = { status: r.res.status, type: cut(r.res.headers.get("content-type") ?? "", 80).toLowerCase() };
      await r.res.body?.cancel().catch(() => undefined);
    })(),
  ]);
  return out;
}

// ------------------------------------------------------------------------------------------ security

export interface MainDocument {
  url: string;
  status: number;
  headers: Record<string, string>;
  cookies: string[];
}

/** The same document: host and path equal (query and fragment aside). */
function sameDoc(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/** The directives of one Content-Security-Policy (lower-case names, their sources). */
export function cspDirectives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    const n = (name ?? "").toLowerCase();
    if (n && /^[a-z-]{1,40}$/.test(n) && !out.has(n)) out.set(n, sources.map((x) => x.toLowerCase()));
  }
  return out;
}

/** Session-like cookie names: these carry a sign-in or session and should be HttpOnly. */
const SESSION_COOKIE = /^(?:__(?:host|secure)-)?(?:[a-z0-9_.-]*sess(?:ion)?(?:id)?|sid|[a-z0-9_.-]*_sid|connect\.sid|phpsessid|jsessionid|asp\.net_sessionid|laravel_session|auth(?:_?token)?|access_?token|jwt)$/i;

/** One Set-Cookie value: its name, and which attributes it has. Null for a deletion (expired or empty). */
export function parseCookie(v: string): { name: string; secure: boolean; httpOnly: boolean } | null {
  const [pair, ...attrs] = v.split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const a = attrs.map((x) => x.trim().toLowerCase());
  if (!value || value === "deleted" || a.some((x) => /^max-age=\s*(0|-\d+)$/.test(x))) return null;
  const exp = a.find((x) => x.startsWith("expires="));
  if (exp) {
    const t = Date.parse(exp.slice(8));
    if (Number.isFinite(t) && t < Date.UTC(2000, 0, 1)) return null;
  }
  return { name: cut(name, 60), secure: a.includes("secure"), httpOnly: a.includes("httponly") };
}

/**
 * The security findings for one view: HTTPS, the main document's headers and cookies, and http:// redirecting. Null
 * (not measured) when the main document's headers were not seen or it did not answer 2xx; [] when it passes.
 */
export function judgeSecurity(pageUrl: string, doc: MainDocument | null, metaCsp: readonly string[] | null, probe: SiteProbe | null): RawFinding[] | null {
  const f: RawFinding[] = [];
  const https = pageUrl.startsWith("https:");
  if (!https && pageUrl.startsWith("http:")) {
    f.push({
      kind: "https-missing",
      selector: "",
      box: null,
      measured: `The page was served over plain http (${short(pageUrl)}).`,
      detail: { severity: "serious" satisfies Severity, count: 1 },
    });
  }
  if (!doc || doc.status < 200 || doc.status > 299 || !Object.keys(doc.headers).length) return f.length ? f : null;
  // a security header the browser's copy lacks counts as sent when the worker's own fetch of the same page got it
  const h: Record<string, string> = { ...doc.headers };
  const own = probe?.page && probe.page.status >= 200 && probe.page.status < 300 && sameDoc(probe.page.url, doc.url) ? probe.page.headers : {};
  for (const k of SECURITY_HEADERS) if (!h[k] && own[k]) h[k] = own[k];
  const where = short(doc.url);
  if (https) {
    const hsts = h["strict-transport-security"] ?? "";
    const age = /max-age\s*=\s*"?(\d+)/i.exec(hsts);
    if (!hsts || !age || Number(age[1]) <= 0) {
      f.push({
        kind: "hsts-missing",
        selector: "",
        box: null,
        measured: hsts ? `The page sends Strict-Transport-Security "${cut(hsts, 80)}", which keeps no HTTPS rule (max-age 0 or none).` : `The page (${where}) sends no Strict-Transport-Security header.`,
        detail: { severity: "moderate" satisfies Severity, count: 1 },
      });
    }
  }
  // Content-Security-Policy: the header's and the meta tags' policies; a policy limits scripts with script-src, or with
  // default-src when script-src is absent; "*" or a bare scheme there allows scripts from any host
  const policies = [...(h["content-security-policy"] ?? "").split(/\n|,(?=\s*[a-z-]+\s)/i), ...(metaCsp ?? [])].map((x) => x.trim()).filter(Boolean);
  const reportOnly = !!h["content-security-policy-report-only"];
  const scriptLimit = policies.some((p) => {
    const d = cspDirectives(p);
    const src = d.get("script-src") ?? d.get("default-src");
    return !!src && src.length > 0 && !src.some((x) => x === "*" || x === "http:" || x === "https:" || x === "data:");
  });
  // a CSP can also come in a meta tag: when the page's head was not read (metaCsp null), its absence is not judged
  if (!scriptLimit && metaCsp !== null) {
    const names = [...new Set(policies.flatMap((p) => [...cspDirectives(p).keys()]))].slice(0, 6);
    f.push({
      kind: "csp-missing",
      selector: "",
      box: null,
      measured: policies.length
        ? `The page has a Content-Security-Policy (${names.join(", ") || "no directives"}), but it does not limit where scripts come from (no script-src or default-src without a wildcard).`
        : `The page (${where}) has no Content-Security-Policy header or meta tag${reportOnly ? " (only a Report-Only policy, which blocks nothing)" : ""}.`,
      detail: { severity: (policies.length ? "minor" : "moderate") satisfies Severity, count: 1 },
    });
  }
  if (!/nosniff/i.test(h["x-content-type-options"] ?? "")) {
    f.push({ kind: "nosniff-missing", selector: "", box: null, measured: `The page (${where}) sends no X-Content-Type-Options: nosniff.`, detail: { severity: "minor" satisfies Severity, count: 1 } });
  }
  // framing: X-Frame-Options DENY or SAMEORIGIN, or frame-ancestors in a header policy (browsers ignore it in a meta tag)
  // a header sent twice reaches here joined by a newline; the same value twice still counts, two different ones do not
  const xfos = [...new Set((h["x-frame-options"] ?? "").toLowerCase().split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];
  const xfo = xfos.length === 1 ? xfos[0] : xfos.join(", ");
  const headerPolicies = (h["content-security-policy"] ?? "").split("\n").filter(Boolean);
  const ancestors = headerPolicies.some((p) => {
    const a = cspDirectives(p).get("frame-ancestors");
    return !!a && a.length > 0 && !a.includes("*") && !a.includes("https:") && !a.includes("http:");
  });
  if (!(xfo === "deny" || xfo === "sameorigin") && !ancestors) {
    f.push({
      kind: "clickjack-unprotected",
      selector: "",
      box: null,
      measured: `The page (${where}) sends neither X-Frame-Options (DENY or SAMEORIGIN) nor a Content-Security-Policy frame-ancestors that limits who may frame it${xfo ? ` (X-Frame-Options is "${cut(xfo, 40)}")` : ""}.`,
      detail: { severity: "moderate" satisfies Severity, count: 1 },
    });
  }
  // the cookies this response set
  const bad: string[] = [];
  for (const raw of doc.cookies) {
    const c = parseCookie(raw);
    if (!c) continue;
    const why: string[] = [];
    if (https && !c.secure) why.push("no Secure");
    if (!c.httpOnly && SESSION_COOKIE.test(c.name)) why.push("a session cookie without HttpOnly");
    if (why.length) bad.push(`${c.name} (${why.join(", ")})`);
  }
  if (bad.length) {
    f.push({
      kind: "cookie-insecure",
      selector: "",
      box: null,
      measured: `The page's response set ${bad.length} ${bad.length === 1 ? "cookie" : "cookies"} without the attributes ${bad.length === 1 ? "it needs" : "they need"}: ${bad.slice(0, 4).join("; ")}${bad.length > 4 ? "; and more" : ""}.`,
      detail: { severity: "moderate" satisfies Severity, count: bad.length, examples: bad.slice(0, 5) },
    });
  }
  // a host on the browsers' HSTS preload list is never asked for over http by a browser, so its http answer reaches
  // no visitor: not reported
  if (https && probe?.http?.end === "http" && probe.preloaded !== true) {
    f.push({
      kind: "http-no-redirect",
      selector: "",
      box: null,
      measured: `http://${short(probe.http.url)} answered over plain http${probe.http.hops ? ` after ${probe.http.hops} ${probe.http.hops === 1 ? "redirect" : "redirects"}` : ""} instead of redirecting to https://.`,
      detail: { severity: "moderate" satisfies Severity, count: 1 },
    });
  }
  return f;
}

// ------------------------------------------------------------------------------------------ search and sharing

export interface PageHead {
  title: string;
  description: string | null;
  robots: string[];
  ogTitle: string | null;
  ogImage: string | null;
  twTitle: string | null;
  twImage: string | null;
  icon: boolean;
  compat: string;
  csp: string[];
  generic: number;
  genericEx: string[];
}

const strOrNull = (v: unknown, n: number): string | null => (typeof v === "string" ? cut(v, n) : null);

/** The page side's head read (src/audits.ts pageSide "audit" with head), checked. Null when it is not one. */
export function parseHead(raw: unknown): PageHead | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.compat !== "string") return null;
  const list = (v: unknown, n: number, m: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => cut(x, m)) : []);
  return {
    title: cut(o.title, 200),
    description: strOrNull(o.description, 300),
    robots: list(o.robots, 10, 200),
    ogTitle: strOrNull(o.ogTitle, 300),
    ogImage: strOrNull(o.ogImage, 300),
    twTitle: strOrNull(o.twTitle, 300),
    twImage: strOrNull(o.twImage, 300),
    icon: o.icon === true,
    compat: cut(o.compat, 20),
    csp: list(o.csp, 5, 1000),
    generic: typeof o.generic === "number" && Number.isFinite(o.generic) ? Math.max(0, Math.round(o.generic)) : 0,
    genericEx: list(o.genericEx, 5, 160),
  };
}

/** Whether a robots value says noindex ("noindex" or "none"). */
const noindexIn = (v: string): boolean => v.toLowerCase().split(/[\s,]+/).some((t) => t === "noindex" || t === "none");

/**
 * Search and sharing, and quirks mode, from the head read on the light phone, the main document's X-Robots-Tag, and the
 * worker's /favicon.ico request. A favicon counts as present with a link rel=icon, or /favicon.ico answering 2xx with
 * an image (or a generic binary) type; when /favicon.ico could not be fetched at all, nothing is said about it.
 */
export function judgeSearch(head: PageHead, robotsHeader: string, probe: SiteProbe | null): RawFinding[] {
  const f: RawFinding[] = [];
  if (head.compat === "BackCompat") {
    f.push({ kind: "quirks-mode", selector: "html", box: null, measured: "document.compatMode is BackCompat: the page has no <!doctype html> (or an old one), so it renders in quirks mode.", detail: { severity: "minor" satisfies Severity, count: 1 } });
  }
  if (!head.description) {
    f.push({
      kind: "meta-description-missing",
      selector: "head",
      box: null,
      measured: head.description === "" ? 'The page has <meta name="description"> with no text.' : 'The page has no <meta name="description">.',
      detail: { severity: "moderate" satisfies Severity, count: 1 },
    });
  }
  const metaNo = head.robots.filter(noindexIn);
  const headerNo = robotsHeader.split("\n").filter((line) => {
    // "googlebot: noindex" names one crawler: it counts for Google's and Bing's; a value without a name counts for all
    const m = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(line);
    if (m && !/^(max-|unavailable_after)/i.test(m[1])) return /^(googlebot|bingbot)$/i.test(m[1]) && noindexIn(m[2]);
    return noindexIn(line);
  });
  if (metaNo.length || headerNo.length) {
    f.push({
      kind: "noindex",
      selector: metaNo.length ? 'meta[name="robots"]' : "",
      box: null,
      measured: metaNo.length ? `The robots meta tag says "${cut(metaNo[0], 80)}".` : `The response header X-Robots-Tag says "${cut(headerNo[0], 80)}".`,
      detail: { severity: "serious" satisfies Severity, count: 1 },
    });
  }
  const missing: string[] = [];
  if (!head.ogTitle && !head.twTitle) missing.push("og:title");
  if (!head.ogImage && !head.twImage) missing.push("og:image");
  if (missing.length) {
    f.push({
      kind: "social-preview-missing",
      selector: "head",
      box: null,
      measured: `The page has no ${missing.join(" and no ")} (nor the twitter: equivalent${missing.length > 1 ? "s" : ""}), so shared links show ${missing.length > 1 ? "no title and no picture" : missing[0] === "og:image" ? "no picture" : "no proper title"} of their own.`,
      detail: { severity: "minor" satisfies Severity, count: missing.length, examples: missing },
    });
  }
  if (!head.icon && probe?.favicon) {
    // only a definite answer counts: 404 or 410, or a page (an HTML soft 404); a 403 or 429 may be bot protection
    const fav = probe.favicon;
    const missing = fav.status === 404 || fav.status === 410 || (fav.status >= 200 && fav.status < 300 && /^text\/html/.test(fav.type));
    if (missing) {
      f.push({
        kind: "favicon-missing",
        selector: "head",
        box: null,
        measured: `The page has no <link rel="icon">, and /favicon.ico answered ${probe.favicon.status}${probe.favicon.type ? ` (${probe.favicon.type})` : ""}.`,
        detail: { severity: "minor" satisfies Severity, count: 1 },
      });
    }
  }
  if (head.generic > 0) {
    f.push({
      kind: "link-text-generic",
      selector: head.genericEx[0]?.replace(/ \(".*$/, "") ?? "",
      box: null,
      measured: `${head.generic} ${head.generic === 1 ? "link's" : "links'"} whole text is generic, such as ${head.genericEx.slice(0, 3).join(", ")}.`,
      detail: { severity: "minor" satisfies Severity, count: head.generic, examples: head.genericEx.slice(0, 5) },
    });
  }
  return f;
}
