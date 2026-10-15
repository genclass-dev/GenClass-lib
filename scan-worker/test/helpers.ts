// Test doubles: an in-memory R2 bucket (with etag preconditions), a rate limiter, a DNS-over-HTTPS fetch and a fake
// browser whose pages emit request events, answer the page-side scripts with canned results and record what the
// interception policy did to each request.

import type { BrowserLike, PageLike, RequestLike, ResponseLike } from "../src/scan.ts";
import type { Bucket } from "../src/store.ts";

export class MemBucket implements Bucket {
  objects = new Map<string, { body: string | Uint8Array; etag: string; uploaded: Date; contentType?: string; customMetadata?: Record<string, string> }>();
  puts = 0;
  private n = 0;
  private clock: () => number;
  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    const body = o.body;
    return {
      etag: o.etag,
      uploaded: o.uploaded,
      customMetadata: o.customMetadata,
      size: typeof body === "string" ? body.length : body.byteLength,
      text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
      body: new Response(typeof body === "string" ? body : new Uint8Array(body)).body as ReadableStream,
    };
  }
  async put(key: string, value: unknown, options: Record<string, unknown> = {}) {
    const cur = this.objects.get(key);
    const only = options.onlyIf as { etagMatches?: string } | Headers | undefined;
    if (only instanceof Headers) {
      if (only.get("if-none-match") === "*" && cur) return null;
    } else if (only && only.etagMatches !== undefined && (!cur || cur.etag !== only.etagMatches)) return null;
    const body = typeof value === "string" ? value : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    const etag = `e${++this.n}`;
    this.objects.set(key, {
      body, etag, uploaded: new Date(this.clock()), contentType: (options.httpMetadata as { contentType?: string } | undefined)?.contentType,
      customMetadata: options.customMetadata as Record<string, string> | undefined,
    });
    this.puts++;
    return { etag };
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }
  async list(o: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const all = [...this.objects.entries()].filter(([k]) => !o.prefix || k.startsWith(o.prefix)).sort(([a], [b]) => a.localeCompare(b));
    const start = o.cursor ? Number(o.cursor) : 0;
    const limit = o.limit ?? 1000;
    const slice = all.slice(start, start + limit);
    const truncated = start + limit < all.length;
    return { objects: slice.map(([key, v]) => ({ key, uploaded: v.uploaded })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) };
  }
}

export class Limiter {
  calls: string[] = [];
  private allow: number;
  constructor(allow: number) {
    this.allow = allow;
  }
  async limit({ key }: { key: string }) {
    this.calls.push(key);
    return { success: this.calls.filter((k) => k === key).length <= this.allow };
  }
}

/** A fetch that answers DNS-over-HTTPS from a table and robots.txt from another; everything else 404. */
export function fakeFetch(dns: Record<string, string[] | "nx">, robots: Record<string, string> = {}) {
  const calls: string[] = [];
  const f = async (input: string): Promise<Response> => {
    calls.push(input);
    const u = new URL(input);
    if (u.hostname === "cloudflare-dns.com") {
      const name = u.searchParams.get("name") || "";
      const type = u.searchParams.get("type");
      const entry = dns[name];
      if (entry === undefined || entry === "nx") return Response.json({ Status: 3 });
      const want = type === "A" ? 1 : 28;
      const answers = entry.filter((a) => (a.includes(":") ? 28 : 1) === want).map((data) => ({ type: want, data }));
      return Response.json({ Status: 0, Answer: answers });
    }
    if (u.pathname === "/robots.txt" && robots[u.hostname] !== undefined) return new Response(robots[u.hostname]);
    return new Response("not found", { status: 404 });
  };
  return { fetch: f, calls };
}

// ------------------------------------------------------------------------------------------ fake browser

export interface Handled {
  url: string;
  method: string;
  type: string;
  outcome: "continue" | "abort" | "respond";
  status?: number;
  body?: string;
}

class FakeRequest implements RequestLike {
  handled: Handled | null = null;
  private page: FakePage;
  private _url: string;
  private _method: string;
  private _type: string;
  private _nav: boolean;
  private _main: boolean;
  private _body?: string;
  constructor(page: FakePage, url: string, method: string, type: string, nav: boolean, main: boolean, body?: string) {
    this.page = page;
    this._url = url;
    this._method = method;
    this._type = type;
    this._nav = nav;
    this._main = main;
    this._body = body;
  }
  url() { return this._url; }
  method() { return this._method; }
  resourceType() { return this._type; }
  isNavigationRequest() { return this._nav; }
  frame() { return this._main ? this.page.main : { sub: true }; }
  postData() { return this._body; }
  failure() { return null; }
  isInterceptResolutionHandled() { return this.handled !== null; }
  private done(h: Omit<Handled, "url" | "method" | "type">) {
    this.handled = { url: this._url, method: this._method, type: this._type, ...h };
    this.page.handled.push(this.handled);
  }
  async continue() { this.done({ outcome: "continue" }); }
  async abort() { this.done({ outcome: "abort" }); }
  async respond(r: { status: number; body?: string }) { this.done({ outcome: "respond", status: r.status, body: r.body }); }
}

export interface PageScript {
  /** Requests the page makes while loading (after the main document); `ip` is the address the response came from. */
  load?: { url: string; method?: string; type?: string; nav?: boolean; main?: boolean; body?: string; ip?: string; hang?: boolean }[];
  /** The main document redirects here (a main-frame navigation request the scanner must allow). */
  redirect?: string;
  /** WebSocket hosts the page opened (what the safety bootstrap would have recorded). */
  wsHosts?: string[];
  /** The address every response that is not listed in `load` came from (default 93.184.215.14). */
  ip?: string;
  /** Findings the visual checks (engine "a") return, per view. */
  findings?: (view: string) => unknown[];
  /** What the report-only re-check (engine "c") finds with the fixes in place, per view (default: the same findings). */
  recheck?: (view: string) => unknown[];
  /** Every finding's identity the re-check reports (`keys`), when it is more than its first 40 findings. */
  recheckKeys?: (view: string) => string[];
  /** How long the re-check ran, as the page reports it (stats.elapsed, ms). */
  recheckElapsed?: number;
  docHeight?: number;
  status?: number;
  gotoError?: string;
  model?: { state: string; device?: string; loadMs?: number };
  search?: boolean;
  button?: boolean;
  /** What a double click makes the page send, by mode: the number of identical POSTs. */
  postsOnDoubleClick?: { observe: number; guard: number };
  /** Where the double click's POSTs go (default the page's own /api/subscribe). */
  postUrl?: string;
  detections?: unknown[];
  /** What axe-core's run returns in each view (the scanner then gets axe built in); unset: no axe-core. */
  axe?: (view: string) => unknown;
  /** What the page audits measure (src/audits.ts pageSide): timings, the layout audit per view, the reflow probe per width. */
  vitals?: (view: string) => unknown;
  audit?: (view: string) => unknown;
  reflow?: (width: number) => unknown;
  /** The window's overflow as the page reads it (html and body overflow-y, scroll and client height). */
  overflow?: (view: string) => unknown;
  /** What the "wall" read returns per view: visible text length, element count, title, challenge markers. */
  wall?: (view: string) => unknown;
  /** What the keyboard focus commands answer (pageSide "focus", "focusOne", "focusBlur", "focusDone") on the desktop. */
  focus?: (cmd: string, arg: Record<string, any>) => unknown;
  /** Response statuses by URL in the browser's own record (default 200), and other DevTools events sent while loading. */
  statuses?: Record<string, number>;
  cdpEvents?: [string, unknown][];
  /** The page has no DevTools session for the scanner (reliability is then not measured). */
  noCdp?: boolean;
  /** What the model judge's page side (src/judge-page.ts) answers per view: "find", "facts" and "restore". */
  judge?: (view: string, cmd: string, arg: Record<string, any>) => unknown;
}

/** A DevTools session the scanner opens on a fake page: it records what was turned on; the page emits events into it. */
export class FakeCdp {
  sent: string[] = [];
  /** The clips of the crops the scanner took (Page.captureScreenshot). */
  clips: Record<string, unknown>[] = [];
  /** Captures in flight now, and the most there ever were at once (Chrome mixes up the clips of concurrent ones). */
  capturing = 0;
  maxCapturing = 0;
  detached = false;
  private handlers = new Map<string, ((p: unknown) => void)[]>();
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push(method);
    if (method === "Page.captureScreenshot") {
      this.clips.push((params?.clip ?? {}) as Record<string, unknown>);
      this.capturing++;
      this.maxCapturing = Math.max(this.maxCapturing, this.capturing);
      await new Promise((r) => setTimeout(r, 1));
      this.capturing--;
      return { data: "/9j/4AAQSkZJRgABAQ==" };
    }
    if (method === "Runtime.enable") this.emit("Runtime.executionContextCreated", { context: { id: 1, auxData: { isDefault: true, frameId: "MAIN" } } });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "MAIN" } } };
    return {};
  }
  on(event: string, h: (p: unknown) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
  }
  emit(event: string, p: unknown) {
    for (const h of this.handlers.get(event) ?? []) h(p);
  }
  async detach() {
    this.detached = true;
  }
}

export class FakePage implements PageLike {
  main = { main: true };
  handled: Handled[] = [];
  onNew: string[] = [];
  evaluated: string[] = [];
  private handlers = new Map<string, ((a: unknown) => void)[]>();
  private current = "about:blank";
  closed = false;
  viewport: { width: number; height: number } | null = null;
  scheme = "light";
  ua = "";
  mode: "none" | "observe" | "guard" = "none";
  mouse = {
    click: async (_x: number, _y: number, o?: { count?: number }) => this.click(o?.count ?? 1),
    move: async (x: number, y: number) => void this.moves.push([x, y]),
    wheel: async () => void this.wheels++,
  };
  keyboard = { type: async (text: string) => this.typeText(text), press: async (key: string) => void this.keys.push(key) };
  wheels = 0;
  keys: string[] = [];
  /** Commands the scanner sent to the visual checks, in order. */
  visual: { cmd: string; arg: Record<string, any> }[] = [];
  /** Commands the scanner sent to the model judge's page side, in order. */
  judgeCmds: { cmd: string; arg: Record<string, any> }[] = [];
  /** The page audits the scanner ran (src/audits.ts pageSide), and the views axe-core ran in. */
  audits: { cmd: string; arg: Record<string, any> }[] = [];
  axeRuns: string[] = [];
  /** The keyboard focus commands the scanner sent (src/audits.ts pageSide focus*), in order. */
  focusCmds: { cmd: string; arg: Record<string, any> }[] = [];
  /** Where the pointer was moved, in order, and where it was each time axe-core ran. */
  moves: [number, number][] = [];
  pointerAtAxe: ([number, number] | undefined)[] = [];
  private script: PageScript;
  private settle: () => Promise<void>;
  /** The scanner's DevTools session on this page, once it opened one. */
  cdp: FakeCdp | null = null;
  createCDPSession?: () => Promise<FakeCdp>;
  /** Every viewport width the scanner set, in order. */
  widths: number[] = [];
  private rid = 0;
  constructor(script: PageScript, settle: () => Promise<void>) {
    this.script = script;
    this.settle = settle;
    if (!script.noCdp) this.createCDPSession = async () => (this.cdp = new FakeCdp());
  }
  async setViewport(v: { width: number; height: number }) {
    this.viewport = v;
    this.widths.push(v.width);
  }
  async setUserAgent(ua: string) { this.ua = ua; }
  async emulateMediaFeatures(f: { name: string; value: string }[]) { this.scheme = f.find((x) => x.name === "prefers-color-scheme")?.value || "light"; }
  async setBypassCSP() {}
  async setRequestInterception() {}
  async evaluateOnNewDocument(src: string) {
    this.onNew.push(src);
    const m = /"mode":"(observe|guard)"/.exec(src);
    if (m) this.mode = m[1] as "observe" | "guard";
  }
  on(ev: string, h: (a: unknown) => void) {
    const list = this.handlers.get(ev) || [];
    list.push(h);
    this.handlers.set(ev, list);
  }
  emit(ev: string, a: unknown) {
    for (const h of this.handlers.get(ev) || []) h(a);
  }
  async request(url: string, method = "GET", type = "fetch", nav = false, main = false, body?: string, ip?: string, hang = false): Promise<FakeRequest> {
    const r = new FakeRequest(this, url, method, type, nav, main, body);
    this.emit("request", r);
    for (let i = 0; i < 50 && !r.handled; i++) await this.settle();
    // the browser's own record of the request, as a DevTools session sees it
    if (this.cdp && r.handled) {
      const id = `req${++this.rid}`;
      const cdpType = type === "xhr" ? "XHR" : type.charAt(0).toUpperCase() + type.slice(1);
      this.cdp.emit("Network.requestWillBeSent", { requestId: id, request: { url, method, mixedContentType: "none" }, type: cdpType });
      if (r.handled.outcome === "abort") this.cdp.emit("Network.loadingFailed", { requestId: id, errorText: "net::ERR_BLOCKED_BY_CLIENT" });
      else if (!hang) {
        // the main document answers with the page's status, as the browser's own record shows it
        const status = r.handled.outcome === "respond" ? r.handled.status ?? 200 : this.script.statuses?.[url] ?? (type === "document" && main ? this.script.status ?? 200 : 200);
        this.cdp.emit("Network.responseReceived", { requestId: id, type: cdpType, response: { url, status, mimeType: type === "script" ? "text/javascript" : "text/html", headers: {} } });
        this.cdp.emit("Network.loadingFinished", { requestId: id, encodedDataLength: type === "script" ? 600_000 : 2000 });
      }
    }
    if (r.handled?.outcome === "continue" && !hang) {
      const addr = ip ?? this.script.ip ?? "93.184.215.14";
      this.emit("response", { status: () => 200, url: () => url, request: () => r, remoteAddress: () => ({ ip: addr, port: 443 }) });
      this.emit("requestfinished", r);
    }
    return r;
  }
  async goto(url: string): Promise<ResponseLike | null> {
    if (this.script.gotoError) throw new Error(this.script.gotoError);
    const doc = await this.request(url, "GET", "document", true, true);
    if (doc.handled?.outcome !== "continue") throw new Error("net::ERR_BLOCKED_BY_CLIENT");
    this.current = url;
    if (this.script.redirect) {
      const hop = await this.request(this.script.redirect, "GET", "document", true, true);
      if (hop.handled?.outcome !== "continue") throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      this.current = this.script.redirect;
    }
    for (const l of this.script.load || []) await this.request(l.url, l.method || "GET", l.type || "fetch", !!l.nav, l.main ?? false, l.body, l.ip, !!l.hang);
    for (const [event, params] of this.script.cdpEvents ?? []) this.cdp?.emit(event, params);
    const status = this.script.status ?? 200;
    return { status: () => status, url: () => url, request: () => doc };
  }
  posts: number[] = [];
  private async click(count: number) {
    if (count < 2 || !this.script.postsOnDoubleClick) return;
    const n = this.mode === "guard" ? this.script.postsOnDoubleClick.guard : this.script.postsOnDoubleClick.observe;
    for (let i = 0; i < n; i++) await this.request(this.script.postUrl ?? `${new URL(this.current).origin}/api/subscribe`, "POST", "fetch", false, false, '{"email":""}');
  }
  typed = "";
  private async typeText(text: string) {
    for (const ch of text) {
      this.typed += ch;
      await this.request(`${new URL(this.current).origin}/api/search?q=${this.typed}`, "GET", "fetch");
    }
  }
  async evaluate(src: string): Promise<unknown> {
    this.evaluated.push(src);
    if (src.includes('Object.getOwnPropertyDescriptor(window, "__genclassScanVisual")')) return true; // the visual checks' installer
    if (src.includes('Object.getOwnPropertyDescriptor(window, "axe")')) return !!this.script.axe; // axe-core's installer
    if (src.includes("ax.run(document")) {
      this.axeRuns.push(this.view);
      this.pointerAtAxe.push(this.moves.at(-1));
      return JSON.stringify(this.script.axe ? this.script.axe(this.view) : { ok: false, error: "axe-core is not installed" });
    }
    const side = /\)\("(vitals|audit|reflow|overflow|wall|focus|focusOne|focusBlur|focusDone)", (\{.*\})\)\)\)\(\)$/.exec(src);
    if (side) {
      if (side[1] === "wall") return JSON.stringify(this.script.wall?.(this.view) ?? null);
      if (side[1].startsWith("focus")) {
        this.focusCmds.push({ cmd: side[1], arg: JSON.parse(side[2]) });
        return JSON.stringify(this.script.focus?.(side[1], JSON.parse(side[2])) ?? null);
      }
      this.audits.push({ cmd: side[1], arg: JSON.parse(side[2]) });
      const v = side[1] === "vitals" ? this.script.vitals?.(this.view) : side[1] === "audit" ? this.script.audit?.(this.view) : side[1] === "overflow" ? this.script.overflow?.(this.view) : this.script.reflow?.(this.viewport?.width ?? 0);
      return JSON.stringify(v ?? null);
    }
    const jd = /\)\("(find|facts|vars|restore)", (\{.*\})\)\)\)\(\)$/.exec(src);
    if (jd) {
      this.judgeCmds.push({ cmd: jd[1], arg: JSON.parse(jd[2]) });
      return JSON.stringify(this.script.judge ? this.script.judge(this.view, jd[1], JSON.parse(jd[2])) : { ok: false });
    }
    const vc = /await f\("(\w+)", (\{.*\})\)\); \}\)\(\)$/.exec(src);
    if (vc) return JSON.stringify(this.visualCommand(vc[1], JSON.parse(vc[2])));
    if (src.includes('("read")')) return JSON.stringify({ held: false, wsHosts: this.script.wsHosts ?? [] });
    if (src.includes('("hold"')) return undefined;
    if (src.includes("bootstrap did not run")) {
      const guard = this.mode === "guard";
      const acting = guard && this.script.postsOnDoubleClick && this.script.postsOnDoubleClick.guard < this.script.postsOnDoubleClick.observe;
      const acts = acting
        ? [{ id: "a1", decisionId: "d2", action: "coalesce", trigger: "request", subject: "POST /api/subscribe (#5)", ok: true, changed: "Did not send a duplicate POST /api/subscribe; reused the in-flight response.", late: false }]
        : [];
      const own = acting ? [{ id: "d2", trigger: "request", subject: "POST /api/subscribe (#5)", diagnosis: "duplicate", p: 0.99, action: "coalesce", ran: "coalesce", executed: true, latencyMs: 300 }] : [];
      const m = this.script.model ?? { state: "ready", device: "wasm", loadMs: 3100 };
      return JSON.stringify({
        present: this.mode !== "none", error: null, mode: this.mode, holdBudgetMs: 900, visibility: "visible", decisions: 2,
        status: { state: m.state, device: m.device ?? null, variant: "q8", loadMs: m.loadMs ?? null, error: null, version: "2.0.0-rc4t", effectiveMode: this.mode },
        detections: [...(this.script.detections ?? []), ...own], acts,
      });
    }
    if (src.includes("prepare: true") || src.includes('scrollTo: "search"') || src.includes('scrollTo: "button"')) {
      return JSON.stringify({
        search: this.script.search ? { selector: "input#q", at: { x: 400, y: 40, w: 300, h: 36 } } : null,
        button: this.script.button ? { selector: "button[type=submit].cta", label: "Subscribe", method: "post", form: "form#news", at: { x: 600, y: 500, w: 160, h: 44 } } : null,
      });
    }
    return undefined;
  }
  /** The view this page is: desktop by width, the dark phone by its colour scheme. */
  get view(): string {
    return (this.viewport?.width ?? 0) > 800 ? "desktop" : this.scheme === "dark" ? "phone-dark" : "phone";
  }
  private visualCommand(cmd: string, arg: Record<string, any>): unknown {
    this.visual.push({ cmd, arg });
    const page = { viewport: [this.viewport?.width ?? 0, this.viewport?.height ?? 0], viewportMeta: true, docHeight: this.script.docHeight ?? 1800, docWidth: this.viewport?.width ?? 0, atEnd: true, visibility: "visible" };
    if (cmd === "start" || cmd === "stop" || cmd === "net") return { ok: true };
    if (cmd === "status") return { ok: true, stats: { passes: 1 } };
    if (cmd === "point") return { x: 400, y: 300 };
    if (cmd === "page" || cmd === "top") return page;
    if (cmd === "collect") {
      const list = arg.id === "c" && this.script.recheck ? this.script.recheck(this.view) : this.script.findings ? this.script.findings(this.view) : [];
      const c = arg.id === "c";
      return {
        ok: true, findings: list, skipped: 0,
        ...(c && this.script.recheckKeys ? { keys: this.script.recheckKeys(this.view) } : {}),
        stats: { passes: 2, partial: 0, elements: 100, abstained: 0, ms: 12, ...(c && this.script.recheckElapsed !== undefined ? { elapsed: this.script.recheckElapsed } : {}) },
      };
    }
    return { ok: false };
  }
  async screenshot() { return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); }
  mainFrame() { return this.main; }
  url() { return this.current; }
  async close() { this.closed = true; }
}

export class FakeBrowser implements BrowserLike {
  pages: FakePage[] = [];
  closed = false;
  private script: PageScript;
  constructor(script: PageScript) {
    this.script = script;
  }
  async newPage() {
    const p = new FakePage(this.script, () => new Promise((r) => setTimeout(r, 0)));
    this.pages.push(p);
    return p;
  }
  async version() { return "HeadlessChrome/131.0.6778.33"; }
  async close() { this.closed = true; }
}

/** Reads an NDJSON response into its messages. */
export async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
