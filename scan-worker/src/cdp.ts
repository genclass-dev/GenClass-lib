// What the browser itself reports about one view while it loads, from a DevTools protocol session of the scanner's
// own (Runtime, Network and Log domains), and the reliability findings judged from it:
//   - uncaught exceptions and unhandled rejections (Runtime.exceptionThrown) and console.error calls
//     (Runtime.consoleAPICalled), in the page's own main-frame context only: the scanner's isolated world, the GenClass
//     runtime it injects and its own messages ("GenClassScan") are left out;
//   - same-site requests that the server answered with 4xx or 5xx (Network.responseReceived). Requests the scanner
//     blocked never get a response, and the ones it answered itself get 200 or 204, so neither can count; images,
//     stylesheets, fonts and media are left to the visual checks, which measure what the visitor sees; 401, 403, 407
//     and 429 depend on who is asking (a signed-out visitor, bot protection, rate limits) and are counted but not
//     scored; /favicon.ico is the browser's own request;
//   - mixed content: requests an https page made over http (Network.requestWillBeSent mixedContentType, and
//     Network.loadingFailed blockedReason "mixed-content" for what Chrome blocked);
//   - the bytes transferred per URL (Network.loadingFinished encodedDataLength), for the image audits, the JavaScript
//     total and the page weight (snapshot() at network quiet);
//   - the main document's response headers and the Set-Cookie headers of every response (Network.responseReceived and
//     Network.responseReceivedExtraInfo), for the security checks (src/site.ts);
//   - deprecated APIs Chrome reported in its Issues (Audits.issueAdded, DeprecationIssue).
// Collection stops when the view's checks end (stop()), so nothing the race probe causes is counted.

import type { RawFinding } from "./catalog.ts";
import type { Severity } from "./score.ts";
import { siteOf } from "./target.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, handler: (params: any) => void): unknown;
  detach?(): Promise<void>;
}

/** The scanner's own downloads and code: never the page's. */
const OURS_URL = /^https:\/\/(genclass\.dev\/model\/|cdn\.jsdelivr\.net\/npm\/(@genclass\/runtime@|onnxruntime-web@)|unpkg\.com\/@genclass\/runtime@)|^pptr:|__puppeteer_evaluation_script__/;
const OURS_TEXT = /GenClassScan|\[GenClass\]|__gcs[0-9a-f]{6}/;
/** Deprecations the scanner's own stand-in answers (src/policy.ts, access-control-allow-headers: *) can cause. */
const SCANNER_DEPRECATIONS = new Set(["AuthorizationCoveredByWildcard"]);

const cut = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ");
  return clean.length > n ? clean.slice(0, n) : clean;
};

export interface PageError {
  text: string;
  url: string;
  line: number | null;
}
export interface Answered {
  url: string;
  status: number;
  type: string;
}

/** One view's record. Plain data, so tests can fill one by hand. */
export class PageLog {
  collecting = true;
  mainFrame = "";
  /** Execution contexts: whether each is a frame's default (main world) context, and its frame. */
  contexts = new Map<number, { isDefault: boolean; frameId: string }>();
  exceptions: (PageError & { context: number | null })[] = [];
  consoleErrors: (PageError & { context: number | null })[] = [];
  requests = new Map<string, { url: string; type: string; mixed: string }>();
  responses = new Map<string, Answered & { mime: string }>();
  bytes = new Map<string, number>();
  mixedBlocked: string[] = [];
  mixedSeen: string[] = [];
  /** Document responses: their URL, status, frame and headers (names in lower case, values cut to 1,000 characters). */
  documents = new Map<string, { url: string; status: number; frameId: string; headers: Record<string, string> }>();
  /** Set-Cookie header values by request (from the raw headers Chrome reports separately), values left out. */
  cookies = new Map<string, string[]>();
  /** The raw headers of document requests as received (Network.responseReceivedExtraInfo), lower-case names. */
  rawHeaders = new Map<string, Record<string, string>>();
  /** Deprecated APIs Chrome reported: the deprecation's type and the script that used it. */
  deprecations: { type: string; url: string }[] = [];
  /** Bytes and requests at network quiet (snapshot()). */
  quiet: { bytes: number; requests: number } | null = null;

  /** Turns on the domains on `cdp` and starts recording. Throws when the session cannot be used. */
  async attach(cdp: CdpLike): Promise<void> {
    cdp.on("Runtime.executionContextCreated", (p) => {
      const c = p?.context;
      if (c && typeof c.id === "number") this.contexts.set(c.id, { isDefault: c.auxData?.isDefault === true, frameId: String(c.auxData?.frameId ?? "") });
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      if (!this.collecting || this.exceptions.length >= 50) return;
      const d = p?.exceptionDetails ?? {};
      const frames: any[] = Array.isArray(d.stackTrace?.callFrames) ? d.stackTrace.callFrames : [];
      const url = String(d.url || frames.find((f) => f?.url)?.url || "");
      const text = String(d.exception?.description || d.exception?.value || d.text || "").split("\n")[0];
      if (frames.some((f) => OURS_URL.test(String(f?.url ?? ""))) || OURS_URL.test(url) || OURS_TEXT.test(text)) return;
      this.exceptions.push({ text: cut(text, 200), url: cut(url, 300), line: typeof d.lineNumber === "number" ? d.lineNumber + 1 : null, context: typeof d.executionContextId === "number" ? d.executionContextId : null });
    });
    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (!this.collecting || p?.type !== "error" || this.consoleErrors.length >= 50) return;
      const args: any[] = Array.isArray(p.args) ? p.args : [];
      const text = args.map((a) => (a?.value !== undefined ? String(a.value) : String(a?.description ?? a?.unserializableValue ?? ""))).join(" ").split("\n")[0];
      const frames: any[] = Array.isArray(p.stackTrace?.callFrames) ? p.stackTrace.callFrames : [];
      const url = String(frames.find((f) => f?.url)?.url ?? "");
      if (OURS_TEXT.test(text) || frames.some((f) => OURS_URL.test(String(f?.url ?? "")))) return;
      this.consoleErrors.push({ text: cut(text, 200), url: cut(url, 300), line: frames[0] && typeof frames[0].lineNumber === "number" ? frames[0].lineNumber + 1 : null, context: typeof p.executionContextId === "number" ? p.executionContextId : null });
    });
    cdp.on("Network.requestWillBeSent", (p) => {
      if (!this.collecting || !p?.requestId || this.requests.size >= 3000) return;
      const mixed = String(p.request?.mixedContentType ?? "none");
      const url = String(p.request?.url ?? "");
      this.requests.set(String(p.requestId), { url, type: String(p.type ?? ""), mixed });
      if (mixed !== "none" && this.mixedSeen.length < 50) this.mixedSeen.push(cut(url, 300));
    });
    cdp.on("Network.responseReceived", (p) => {
      if (!this.collecting || !p?.requestId || this.responses.size >= 3000) return;
      this.responses.set(String(p.requestId), { url: String(p.response?.url ?? ""), status: Number(p.response?.status) || 0, type: String(p.type ?? ""), mime: String(p.response?.mimeType ?? "") });
      if (p.type === "Document" && this.documents.size < 20 && p.response?.headers && typeof p.response.headers === "object") {
        const headers = headersOf(p.response.headers);
        this.documents.set(String(p.requestId), { url: String(p.response?.url ?? ""), status: Number(p.response?.status) || 0, frameId: String(p.frameId ?? ""), headers });
        const sc = headers["set-cookie"];
        if (sc && !this.cookies.has(String(p.requestId))) this.cookies.set(String(p.requestId), splitCookies(sc));
      }
    });
    cdp.on("Network.responseReceivedExtraInfo", (p) => {
      if (!this.collecting || !p?.requestId || !p.headers || typeof p.headers !== "object") return;
      const id = String(p.requestId);
      // the raw headers: the response the renderer sees can leave some out (Set-Cookie, and on some pages HSTS); kept
      // whole for documents only (a navigation's requestId is its loaderId)
      const h = headersOf(p.headers);
      if (h["set-cookie"] && this.cookies.size < 200) this.cookies.set(id, splitCookies(h["set-cookie"]));
      if ((this.requests.get(id)?.type === "Document" || p.requestId === p.loaderId) && this.rawHeaders.size < 20) this.rawHeaders.set(id, h);
    });
    cdp.on("Audits.issueAdded", (p) => {
      const issue = p?.issue;
      if (!this.collecting || issue?.code !== "DeprecationIssue" || this.deprecations.length >= 50) return;
      const d = issue.details?.deprecationIssueDetails ?? {};
      const url = String(d.sourceCodeLocation?.url ?? "");
      // only the page's own scripts (an http(s) source), never the scanner's code, and never a deprecation the
      // scanner's stand-in answers cause: they allow every request header with "*", which Chrome flags as
      // AuthorizationCoveredByWildcard for any request that sends Authorization
      if (!/^https?:/.test(url) || OURS_URL.test(url) || SCANNER_DEPRECATIONS.has(String(d.type ?? ""))) return;
      this.deprecations.push({ type: cut(d.type ?? "", 80), url: cut(url, 300) });
    });
    cdp.on("Network.loadingFinished", (p) => {
      if (!this.collecting || !p?.requestId) return;
      const n = Number(p.encodedDataLength);
      if (Number.isFinite(n) && n > 0) this.bytes.set(String(p.requestId), n);
    });
    cdp.on("Network.loadingFailed", (p) => {
      if (!this.collecting || !p?.requestId) return;
      if (p.blockedReason === "mixed-content" && this.mixedBlocked.length < 50) this.mixedBlocked.push(cut(this.requests.get(String(p.requestId))?.url ?? "", 300));
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => cdp.send("Network.enable"));
    // Chrome's Issues (deprecations); a browser without the domain only loses that check
    await cdp.send("Audits.enable").catch(() => undefined);
  }

  /** Records the bytes transferred and the requests answered so far (at network quiet, before any scrolling). */
  snapshot(): void {
    let bytes = 0;
    let requests = 0;
    for (const [id, r] of this.responses) {
      if (OURS_URL.test(r.url)) continue;
      requests++;
      bytes += this.bytes.get(id) ?? 0;
    }
    this.quiet = { bytes, requests };
  }

  /**
   * The main document as the browser received it: the first main-frame document response of the load (redirect hops
   * have none of their own), with the Set-Cookie headers of that response. Not the last: a page can later fetch other
   * documents for the main frame (a prefetch of the next route, which a single-page app then shows with pushState), and
   * those are not what the visitor's browser loaded. `pageUrl` is kept for callers; null when none was seen.
   */
  mainDocument(_pageUrl: string): { url: string; status: number; headers: Record<string, string>; cookies: string[]; raw: boolean } | null {
    let best: [string, { url: string; status: number; frameId: string; headers: Record<string, string> }] | null = null;
    for (const e of this.documents) {
      if (this.mainFrame && e[1].frameId && e[1].frameId !== this.mainFrame) continue;
      best = e;
      break;
    }
    if (!best) return null;
    const raw = this.rawHeaders.get(best[0]);
    return { url: best[1].url, status: best[1].status, headers: raw ? { ...best[1].headers, ...raw } : best[1].headers, cookies: this.cookies.get(best[0]) ?? [], raw: !!raw };
  }

  /** The main frame's id, once the page has loaded (so main-world errors can be told from iframes' and the scanner's). */
  async frame(cdp: CdpLike): Promise<void> {
    try {
      const t = await cdp.send("Page.getFrameTree");
      this.mainFrame = String(t?.frameTree?.frame?.id ?? "");
    } catch {
      this.mainFrame = "";
    }
  }

  stop(): void {
    this.collecting = false;
  }

  /** Whether an error came from the page's own main world (an unknown context counts only when no frame is known). */
  private mine(context: number | null): boolean {
    if (context === null) return true;
    const c = this.contexts.get(context);
    if (!c) return !this.mainFrame;
    return c.isDefault && (!this.mainFrame || c.frameId === this.mainFrame);
  }

  pageErrors(): PageError[] {
    return this.exceptions.filter((e) => this.mine(e.context)).map(({ text, url, line }) => ({ text, url, line }));
  }
  pageConsoleErrors(): PageError[] {
    return this.consoleErrors.filter((e) => this.mine(e.context)).map(({ text, url, line }) => ({ text, url, line }));
  }
  answered(): (Answered & { mime: string; bytes: number })[] {
    return [...this.responses.entries()].map(([id, r]) => ({ ...r, bytes: this.bytes.get(id) ?? 0 }));
  }
  /** Bytes transferred for a URL (the largest response for it) and its MIME type, or null. */
  bytesOf(url: string): { bytes: number; mime: string } | null {
    const want = url.split("#")[0];
    let best: { bytes: number; mime: string } | null = null;
    for (const [id, r] of this.responses) {
      if (r.url.split("#")[0] !== want) continue;
      const b = this.bytes.get(id) ?? 0;
      if (!best || b > best.bytes) best = { bytes: b, mime: r.mime };
    }
    return best;
  }
}

/**
 * Response headers with lower-case names, at most 80, values cut to 4,000 characters (Set-Cookie: every cookie is
 * kept, its value replaced, so a long cookie value cannot push its attributes out).
 */
function headersOf(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h).slice(0, 80)) {
    const name = k.toLowerCase();
    if (!/^[a-z0-9-]{1,60}$/.test(name)) continue;
    const val = name === "set-cookie" ? compactCookies(typeof v === "string" ? v : String(v ?? "")) : cut(v, 4000);
    out[name] = out[name] ? `${out[name]}\n${val}`.slice(0, 8000) : val;
  }
  return out;
}
/**
 * Set-Cookie lines (Chrome joins repeated headers with a newline), each as its name, a stand-in value and its
 * attributes: the value is never kept ("" and "deleted" stay as they are, they mark a deletion). At most 30.
 */
function compactCookies(v: string): string {
  return v
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((line) => {
      const semi = line.indexOf(";");
      const pair = semi >= 0 ? line.slice(0, semi) : line;
      const attrs = semi >= 0 ? line.slice(semi) : "";
      const eq = pair.indexOf("=");
      const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim().slice(0, 80);
      const value = eq >= 0 ? pair.slice(eq + 1).trim() : "";
      return `${name}=${value === "" || value === "deleted" ? value : "x"}${cut(attrs, 300)}`;
    })
    .join("\n");
}
const splitCookies = (v: string): string[] => v.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30);

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};
const pathOf = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 160);
  } catch {
    return u.slice(0, 160);
  }
};
const sameSite = (u: string, pageHost: string): boolean => {
  const h = hostOf(u);
  return !!h && !!pageHost && siteOf(h) === siteOf(pageHost);
};
/** "TypeError: x is undefined" with its numbers and quoted parts kept: errors from three views are merged on this. */
const errorKey = (e: PageError): string => `${e.text.replace(/\s+/g, " ").trim()}|${e.url.split("?")[0]}`;

/** Resource types the reliability check judges; images, stylesheets, fonts and media belong to the visual checks. */
const JUDGED_TYPES = new Set(["Script", "XHR", "Fetch", "Document", "Manifest", "Other", "EventSource", "Prefetch", "Preflight", "TextTrack"]);
/** Statuses that depend on who is asking: counted, not scored. */
const WHO_ASKS = new Set([401, 403, 407, 429]);

export interface Reliability {
  findings: RawFinding[];
  /** Failed same-site requests not scored because their status depends on who asks (401, 403, 407, 429). */
  whoAsks: number;
  /** JavaScript transferred, in bytes (the scanner's own downloads left out). */
  jsBytes: number;
}

/**
 * The reliability findings of one view, from its PageLog. `pageUrl` is where the page ended up (same-site is judged
 * against it); `mainDoc` the main document's URL, which the report covers already (its status is a view note).
 */
export function judgeReliability(log: PageLog, pageUrl: string, view: string): Reliability {
  const findings: RawFinding[] = [];
  const pageHost = hostOf(pageUrl);
  const https = pageUrl.startsWith("https:");

  // uncaught errors: one finding with every distinct message as an instance
  const errs = new Map<string, PageError>();
  for (const e of log.pageErrors()) if (!errs.has(errorKey(e))) errs.set(errorKey(e), e);
  if (errs.size) {
    const list = [...errs.values()];
    const own = list.filter((e) => !e.url || sameSite(e.url, pageHost));
    const first = own[0] ?? list[0];
    const where = first.url ? ` (${pathOf(first.url)}${first.line ? `, line ${first.line}` : ""})` : "";
    findings.push({
      kind: "js-error",
      selector: "",
      box: null,
      measured: `${list.length} uncaught ${list.length === 1 ? "error" : "errors"} on the ${view} view while it loaded${own.length < list.length ? ` (${list.length - own.length} from scripts on other sites)` : ""}. First: ${first.text}${where}.`,
      detail: { severity: (own.length ? "moderate" : "minor") satisfies Severity, count: list.length, examples: list.slice(0, 5).map((e) => e.text.slice(0, 120)) },
    });
  }
  const logs = new Map<string, PageError>();
  for (const e of log.pageConsoleErrors()) if (!logs.has(errorKey(e))) logs.set(errorKey(e), e);
  if (logs.size) {
    const list = [...logs.values()];
    findings.push({
      kind: "console-error",
      selector: "",
      box: null,
      measured: `${list.length} console.error ${list.length === 1 ? "message" : "messages"} on the ${view} view while it loaded. First: ${list[0].text || "(no text)"}${list[0].url ? ` (${pathOf(list[0].url)})` : ""}.`,
      detail: { severity: "minor" satisfies Severity, count: list.length, examples: list.slice(0, 5).map((e) => e.text.slice(0, 120)) },
    });
  }

  // failed same-site requests
  let whoAsks = 0;
  const failed = new Map<string, Answered>();
  for (const r of log.answered()) {
    if (r.status < 400 || r.status > 599 || !/^https?:/.test(r.url) || OURS_URL.test(r.url)) continue;
    if (!JUDGED_TYPES.has(r.type) || !sameSite(r.url, pageHost)) continue;
    if (r.type === "Document" && r.url.split("#")[0] === pageUrl.split("#")[0]) continue;
    let path = "";
    try {
      path = new URL(r.url).pathname;
    } catch {
      path = "";
    }
    if (path === "/favicon.ico") continue;
    if (WHO_ASKS.has(r.status)) {
      whoAsks++;
      continue;
    }
    if (!failed.has(r.url)) failed.set(r.url, r);
  }
  if (failed.size) {
    const list = [...failed.values()];
    const sev = (r: Answered): Severity => (r.type === "Script" && (r.status === 404 || r.status === 410 || r.status >= 500) ? "serious" : r.status >= 500 || r.type === "Document" ? "moderate" : "minor");
    const order: Severity[] = ["critical", "serious", "moderate", "minor"];
    const worst = list.map(sev).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
    list.sort((a, b) => order.indexOf(sev(a)) - order.indexOf(sev(b)));
    const words = (r: Answered) => `${r.type === "Script" ? "script" : r.type === "XHR" || r.type === "Fetch" ? "data request" : r.type.toLowerCase()} ${pathOf(r.url)} answered ${r.status}`;
    findings.push({
      kind: "request-failed",
      selector: "",
      box: null,
      measured: `${list.length} same-site ${list.length === 1 ? "request" : "requests"} failed on the ${view} view: ${list.slice(0, 3).map(words).join("; ")}${list.length > 3 ? "; and more" : ""}.`,
      detail: { severity: worst, count: list.length, examples: list.slice(0, 5).map((r) => `${r.status} ${pathOf(r.url)}`) },
    });
  }

  // mixed content
  if (https) {
    const blocked = [...new Set(log.mixedBlocked.filter(Boolean))];
    const seen = [...new Set(log.mixedSeen.filter((u) => u && !blocked.includes(u)))];
    if (blocked.length || seen.length) {
      const first = blocked[0] ?? seen[0];
      findings.push({
        kind: "mixed-content",
        selector: "",
        box: null,
        measured: `${blocked.length ? `${blocked.length} ${blocked.length === 1 ? "request" : "requests"} over http blocked by the browser` : ""}${blocked.length && seen.length ? ", and " : ""}${seen.length ? `${seen.length} ${seen.length === 1 ? "file" : "files"} referenced over http that the browser upgraded or allowed` : ""} on the ${view} view. First: ${pathOf(first)}.`,
        detail: { severity: (blocked.length ? "serious" : "minor") satisfies Severity, count: blocked.length + seen.length, examples: [...blocked, ...seen].slice(0, 5).map(pathOf) },
      });
    }
  }

  // deprecated APIs Chrome reported (its Issues panel): one finding, every distinct deprecation an instance
  const deps = new Map<string, { type: string; url: string }>();
  for (const d of log.deprecations) if (d.type && !deps.has(d.type)) deps.set(d.type, d);
  if (deps.size) {
    const list = [...deps.values()];
    const own = list.filter((d) => !d.url || sameSite(d.url, pageHost));
    findings.push({
      kind: "deprecated-api",
      selector: "",
      box: null,
      measured: `Chrome reported ${list.length} deprecated ${list.length === 1 ? "API" : "APIs"} on the ${view} view${own.length < list.length ? ` (${list.length - own.length} from scripts on other sites)` : ""}: ${list.slice(0, 3).map((d) => `${d.type}${d.url ? ` (${pathOf(d.url)})` : ""}`).join("; ")}${list.length > 3 ? "; and more" : ""}.`,
      detail: { severity: "minor" satisfies Severity, count: list.length, examples: list.slice(0, 5).map((d) => d.type) },
    });
  }

  const jsBytes = log.answered().filter((r) => r.type === "Script" && !OURS_URL.test(r.url)).reduce((s, r) => s + r.bytes, 0);
  return { findings, whoAsks, jsBytes };
}

/** More than 1 MB (1,000,000 bytes) of JavaScript transferred: listed as a note, never scored. */
export const JS_NOTE_BYTES = 1_000_000;
export function jsNote(jsBytes: number): RawFinding | null {
  if (jsBytes <= JS_NOTE_BYTES) return null;
  return {
    kind: "js-heavy",
    selector: "",
    box: null,
    measured: `${(jsBytes / 1_000_000).toFixed(2)} MB of JavaScript transferred (compressed) while the desktop view loaded, the scanner's own GenClass runtime left out.`,
    detail: { severity: "minor" satisfies Severity, count: 1, bytes: jsBytes },
  };
}
