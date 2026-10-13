// Asset checks (docs/runtime/VISUAL.md 3.1 to 3.7): image-broken, image-css-broken, media-failed,
// stylesheet-failed, font-failed, icon-font-failed, csp-blocked. Mostly browser-reported facts (error events,
// FontFace.status, resource timing, securitypolicyviolation); each has a pure verdict function the unit tests drive.

import type { Ctx, Draft } from "../draft.js";
import { named, px } from "../draft.js";
import { coverage } from "../math.js";
import { sameOrigin, sameSite, type Reader } from "../measure.js";

/** What the engine collects for the asset checks. */
export interface AssetEnv {
  /** The resource timing entry for a URL (absolute), if the browser recorded one. */
  entry(url: string): PerformanceResourceTiming | undefined;
  /** Same-origin resources fetched by CSS (initiatorType "css") with responseStatus >= 400. */
  failedCss(): PerformanceResourceTiming[];
  /** responseStatus exists (Chromium). */
  statusSupported: boolean;
  /** link elements that fired `error`. */
  linkErrors: WeakSet<Element>;
  /** securitypolicyviolation events (the stub's early buffer, then live ones). */
  csp: SecurityPolicyViolationEvent[];
  /** Clock time document.fonts.ready resolved (null: not yet). */
  fontsReadyAt: number | null;
}

const statusOf = (e: PerformanceResourceTiming | undefined): number | undefined => {
  const s = (e as { responseStatus?: number } | undefined)?.responseStatus;
  return typeof s === "number" ? s : undefined;
};

const abs = (url: string, ctx: Ctx): string => {
  try {
    return new URL(url, ctx.win.location?.href).href;
  } catch {
    return url;
  }
};

/** A short path for messages: the path and file of a URL (no query), or the URL when it cannot be parsed. */
export function shortUrl(url: string, ctx: Ctx): string {
  try {
    const u = new URL(url, ctx.win.location?.href);
    if (u.protocol === "data:") return "a data: URL";
    return sameOrigin(u.href, ctx.win.location) ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

// ----------------------------------------------------------------------------------------------- image-broken

/** VISUAL.md 3.1: why the image failed, and whether that is reportable here. */
export function brokenImageVerdict(o: { sameSite: boolean; hasEntry: boolean; status?: number; statusSupported: boolean }): { report: boolean; cause: string } {
  let cause: string;
  if (!o.hasEntry) cause = "blocked before the request (a Content-Security-Policy, mixed content or a content blocker)";
  else if (typeof o.status === "number" && o.status >= 400) cause = `HTTP ${o.status}`;
  else if (o.statusSupported && o.status === 0) cause = "status hidden (cross-origin)";
  else if (!o.statusSupported) cause = "status unknown";
  else cause = "the file is not a valid image";
  return { report: o.sameSite || (typeof o.status === "number" && o.status >= 400), cause };
}

export function* brokenImages(ctx: Ctx, env: AssetEnv, roots: Element[], out: Draft[]): Generator<void> {
  if (!ctx.on("image-broken")) return;
  const seen = new Set<Element>();
  for (const root of roots) {
    const imgs: Element[] = root === ctx.r.doc.body ? [...ctx.r.doc.images] : [...(root.tagName === "IMG" ? [root] : []), ...root.querySelectorAll("img")];
    for (const el of imgs.slice(0, ctx.max)) {
      yield;
      const img = el as HTMLImageElement;
      if (seen.has(img)) continue;
      seen.add(img);
      if (!img.complete || img.naturalWidth !== 0) continue;
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src) continue;
      out.push({
        kind: "image-broken",
        el: img,
        key: `image-broken|${abs(src, ctx)}`,
        severity: "medium",
        measured: {},
        threshold: { value: 0, unit: "px natural width", source: "img complete with naturalWidth 0 and decode() rejected, 1 s apart" },
        text: "",
        persistMs: 1000,
        recheck: (r) => confirmBroken(ctx, env, r, img),
      });
    }
  }
}

async function confirmBroken(ctx: Ctx, env: AssetEnv, r: Reader, img: HTMLImageElement): Promise<Draft | null> {
  if (!img.isConnected || !img.complete || img.naturalWidth !== 0) return null;
  const src = img.currentSrc || img.getAttribute("src") || "";
  if (!src) return null;
  try {
    await img.decode();
    return null; // an SVG without intrinsic size, or a fallback that loaded
  } catch {
    /* still broken */
  }
  if (!r.visible(img)) return null;
  const rc = r.rect(img);
  if (rc.width < 16 || rc.height < 16) return null;
  const url = abs(src, ctx);
  const e = env.entry(url);
  const v = brokenImageVerdict({ sameSite: sameSite(url, ctx.win.location), hasEntry: !!e, status: statusOf(e), statusSupported: env.statusSupported });
  if (!v.report) {
    ctx.abstain("image-broken:cross-origin");
    return null;
  }
  const big = coverage(rc, ctx.r.win.innerWidth, ctx.r.win.innerHeight) >= 0.1 || !!img.closest("main, [role=main]");
  const sel = ctx.sel(img);
  const alt = img.getAttribute("alt");
  return {
    kind: "image-broken",
    el: img,
    key: `image-broken|${url}`,
    severity: big ? "high" : "medium",
    measured: { src: shortUrl(url, ctx), width: Math.round(rc.width), height: Math.round(rc.height), naturalWidth: 0, cause: v.cause, ...(alt !== null ? { alt } : {}) },
    threshold: { value: 0, unit: "px natural width", source: "img complete with naturalWidth 0 and decode() rejected, 1 s apart" },
    text: `an image failed to load on ${named(ctx, img)}: ${v.cause} for ${shortUrl(url, ctx)}, shown at ${Math.round(rc.width)} x ${px(rc.height)}.`,
    fixText:
      "correct the image URL. Paths are case-sensitive on Linux hosts; check the base path or asset prefix (Vite base, Next.js basePath/assetPrefix), drop a public/ prefix from URLs, serve the right Content-Type, and send CORS headers when the img has crossorigin",
    suggestion: { selector: sel, css: "background-color: #f3f4f6;", note: "This only makes a failed image look neutral; add width and height attributes too." },
  };
}

// ------------------------------------------------------------------------------------------ image-css-broken

export function* brokenCssImages(ctx: Ctx, env: AssetEnv, out: Draft[]): Generator<void> {
  if (!ctx.on("image-css-broken") || !env.statusSupported) return;
  const failed = env.failedCss();
  if (!failed.length) return;
  const paths = failed.map((e) => {
    try {
      return { e, path: new URL(e.name).pathname };
    } catch {
      return { e, path: e.name };
    }
  });
  const users = new Map<string, Element[]>();
  const all = ctx.r.doc.body?.querySelectorAll("*") ?? [];
  const n = Math.min(all.length, Math.min(1000, ctx.max));
  for (let i = 0; i < n; i++) {
    yield;
    const el = all[i];
    const bi = ctx.r.cs(el).backgroundImage;
    if (!bi || bi === "none" || !bi.includes("url(")) continue;
    for (const p of paths) {
      if (!bi.includes(p.path)) continue;
      if (!ctx.r.visible(el)) continue;
      const list = users.get(p.e.name) ?? [];
      list.push(el);
      users.set(p.e.name, list);
    }
  }
  for (const p of paths) {
    const els = users.get(p.e.name);
    if (!els?.length) {
      ctx.abstain("image-css-broken:unused");
      continue;
    }
    const el = els[0];
    const sel = ctx.sel(el);
    const status = statusOf(p.e) ?? 0;
    out.push({
      kind: "image-css-broken",
      el,
      els,
      count: els.length,
      key: `image-css-broken|${p.e.name}`,
      severity: "medium",
      measured: { url: shortUrl(p.e.name, ctx), status, elements: els.length },
      threshold: { value: 400, unit: "HTTP status", source: "resource timing responseStatus of a CSS-initiated request (Chromium)" },
      text: `a CSS background image returned HTTP ${status} for ${shortUrl(p.e.name, ctx)}, used by ${named(ctx, el)}${els.length > 1 ? ` and ${els.length - 1} more` : ""}.`,
      fixText: "fix the url(): a relative url() resolves against the stylesheet's URL, not the page's, which bundlers often get wrong",
      suggestion: { selector: sel, css: "background-color: #1f2937;", note: "A fallback colour keeps text over the image readable while the image is missing." },
    });
  }
}

// ----------------------------------------------------------------------------------------------- media-failed

const MEDIA_ERR: Record<number, string> = { 1: "MEDIA_ERR_ABORTED", 2: "MEDIA_ERR_NETWORK", 3: "MEDIA_ERR_DECODE", 4: "MEDIA_ERR_SRC_NOT_SUPPORTED" };

/** VISUAL.md 3.3. */
export function mediaVerdict(o: { code?: number; networkState: number; hasSource: boolean; preloadNone: boolean; video: boolean; w: number; h: number; controls: boolean }): boolean {
  if (!o.hasSource) return false;
  if (o.video ? o.w < 48 || o.h < 48 : !o.controls) return false;
  if (o.code === 2 || o.code === 3 || o.code === 4) return true;
  return o.networkState === 3 && !o.preloadNone;
}

export function* failedMedia(ctx: Ctx, roots: Element[], out: Draft[]): Generator<void> {
  if (!ctx.on("media-failed")) return;
  for (const root of roots) {
    for (const el of [...root.querySelectorAll("video, audio")].slice(0, ctx.max)) {
      yield;
      const m = el as HTMLMediaElement;
      const sources = [...m.querySelectorAll("source")];
      const hasSource = !!(m.getAttribute("src") || sources.length);
      const video = m.tagName === "VIDEO";
      if (!ctx.r.visible(m)) continue;
      const rc = ctx.r.rect(m);
      const code = m.error?.code;
      if (!mediaVerdict({ code, networkState: m.networkState, hasSource, preloadNone: m.preload === "none", video, w: rc.width, h: rc.height, controls: m.controls })) continue;
      const types = sources.map((s) => {
        const t = s.getAttribute("type") ?? "";
        return t ? `${t}: ${JSON.stringify(m.canPlayType(t))}` : `${shortUrl(s.src, ctx)} (no type)`;
      });
      const src = m.currentSrc || m.getAttribute("src") || sources[0]?.src || "";
      const why = code ? `${code} ${MEDIA_ERR[code] ?? ""}`.trim() : "no playable source (NETWORK_NO_SOURCE)";
      out.push({
        kind: "media-failed",
        el: m,
        key: `media-failed|${ctx.sel(m)}|${src}`,
        severity: video && coverage(rc, ctx.r.win.innerWidth, ctx.r.win.innerHeight) >= 0.25 ? "high" : "medium",
        measured: { error: why, src: src ? shortUrl(src, ctx) : "none", networkState: m.networkState, ...(types.length ? { sources: types.join("; ") } : {}) },
        threshold: { value: "2, 3 or 4", unit: "MediaError code, or networkState 3", source: "HTMLMediaElement.error and networkState" },
        text: `${video ? "a video" : "an audio player"} has no playable source on ${named(ctx, m)}: ${why}${src ? ` for ${shortUrl(src, ctx)}` : ""}${types.length ? ` (${types.join("; ")})` : ""}.`,
        fixText: "provide <source> in MP4 (H.264) and WebM, set a poster, and use muted playsinline for autoplaying video on iOS",
        suggestion: { selector: ctx.sel(m), css: "background: #111;", note: "Keeps the failed player's box neutral." },
      });
    }
  }
}

// ------------------------------------------------------------------------------------------ stylesheet-failed

export function* failedStylesheets(ctx: Ctx, env: AssetEnv, out: Draft[]): Generator<void> {
  if (!ctx.on("stylesheet-failed")) return;
  const links = [...ctx.r.doc.querySelectorAll('link[rel~="stylesheet"]')] as HTMLLinkElement[];
  for (const link of links.slice(0, 200)) {
    yield;
    if (/\balternate\b/i.test(link.rel) || link.disabled || !link.href) continue;
    try {
      if (!(ctx.win.matchMedia?.(link.media || "all").matches ?? true)) continue;
    } catch {
      continue;
    }
    const e = env.entry(link.href);
    const status = statusOf(e);
    const failed = env.linkErrors.has(link) || (link.sheet === null && !!e) || (typeof status === "number" && status >= 400);
    if (!failed) continue;
    if (!sameSite(link.href, ctx.win.location)) {
      ctx.abstain("stylesheet-failed:third-party");
      continue;
    }
    const body = ctx.r.doc.body;
    const bs = body ? ctx.r.cs(body) : null;
    const anchor = ctx.r.doc.querySelector("a[href]");
    const unstyled = !!bs && bs.marginTop === "8px" && /serif|times/i.test(bs.fontFamily.split(",")[0]) && (!anchor || ctx.r.cs(anchor).color === "rgb(0, 0, 238)");
    const cause = typeof status === "number" && status >= 400 ? `HTTP ${status}` : env.linkErrors.has(link) ? "the error event fired (a missing file or the wrong Content-Type)" : "no stylesheet was created after the response";
    out.push({
      kind: "stylesheet-failed",
      el: link,
      key: `stylesheet-failed|${link.href}`,
      severity: "high",
      measured: { href: shortUrl(link.href, ctx), cause, media: link.media || "all", unstyled },
      threshold: { value: "error", unit: "load", source: "link error event, link.sheet null after the response, or responseStatus >= 400" },
      text: `a stylesheet failed to load: ${shortUrl(link.href, ctx)} (${cause})${unstyled ? "; the page shows browser default styles" : ""}.`,
      fixText:
        "use a root-relative href (/styles.css; a relative styles.css breaks on /blog/post), make the server return 404 rather than index.html for missing assets, and check the bundler's base path",
    });
  }
}

// ------------------------------------------------------------------------------------- font-failed, icon fonts

const ICON_FAMILY = /icon|awesome|material|symbol|glyph|feather|ionicons|remix|lucide|tabler|fontello|icomoon|dashicons|octicons|bootstrap-icons/i;
const ICON_SEL =
  '[class*="fa-"], .fa, .fas, .far, .fab, .fal, .material-icons, [class*="material-icons"], [class*="material-symbols"], [class^="bi-"], [class*=" bi-"], [class*="glyphicon"], [class^="icon-"], [class*=" icon-"], i';

export function firstFamily(fontFamily: string): string {
  return (fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/** Status of a family across its faces: "loaded" if any face loaded, else "error", "pending" or "none" (not declared). */
export function familyStatus(faces: { family: string; status: string }[], family: string): "loaded" | "error" | "pending" | "none" {
  let st: "error" | "pending" | "none" = "none";
  for (const f of faces) {
    if (firstFamily(f.family) !== family) continue;
    if (f.status === "loaded") return "loaded";
    if (f.status === "error") st = "error";
    else if (st === "none") st = "pending";
  }
  return st;
}

/** VISUAL.md 3.6: a failed icon font shows a Private Use Area box, or prints its ligature word. */
export function iconBroken(o: { content: string; text: string; widthPx: number; fontPx: number }): "pua" | "ligature" | null {
  const c = o.content && o.content !== "none" && o.content !== "normal" ? o.content.replace(/^["']|["']$/g, "") : "";
  for (const ch of c) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) return "pua";
  }
  const t = o.text.trim();
  if (t.length >= 3 && /^[a-z0-9_]+$/.test(t) && o.widthPx > 1.6 * o.fontPx) return "ligature";
  return null;
}

function faces(ctx: Ctx): { family: string; status: string; weight: string; style: string }[] {
  const out: { family: string; status: string; weight: string; style: string }[] = [];
  try {
    const set = (ctx.r.doc as Document & { fonts?: Iterable<FontFace> }).fonts;
    if (set) for (const f of set) out.push({ family: f.family, status: f.status, weight: f.weight, style: f.style });
  } catch {
    /* no CSS Font Loading API */
  }
  return out;
}

/** @font-face src values per family from readable stylesheets (at most 2,000 rules). */
function fontSources(ctx: Ctx): Map<string, string> {
  const m = new Map<string, string>();
  let n = 0;
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (n++ > 2000) return;
      const st = (rule as CSSStyleRule).style;
      if (rule.constructor?.name === "CSSFontFaceRule" || (rule as { type?: number }).type === 5) {
        const fam = firstFamily(st?.getPropertyValue("font-family") ?? "");
        if (fam && !m.has(fam)) m.set(fam, st?.getPropertyValue("src") ?? "");
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) walk(inner);
    }
  };
  for (const sh of ctx.r.doc.styleSheets) {
    try {
      walk(sh.cssRules);
    } catch {
      /* cross-origin sheet */
    }
  }
  return m;
}

export function* failedFonts(ctx: Ctx, env: AssetEnv, out: Draft[]): Generator<void> {
  if (!ctx.on("font-failed")) return;
  const fs = faces(ctx);
  const failed = new Map<string, { weight: string; style: string }>();
  for (const f of fs) {
    const fam = firstFamily(f.family);
    if (f.status === "error" && !ICON_FAMILY.test(fam) && familyStatus(fs, fam) === "error") failed.set(fam, f);
  }
  if (!failed.size) return;
  const srcs = fontSources(ctx);
  const users = new Map<string, Element[]>();
  let sampled = 0;
  const els = ctx.r.doc.body?.querySelectorAll("h1, h2, h3, h4, h5, h6, p, a, button, li, span, div, td, th, label, strong, em, small") ?? [];
  for (let i = 0; i < els.length && i < ctx.max && sampled < 200; i++) {
    yield;
    const el = els[i];
    if (![...el.childNodes].some((c) => c.nodeType === 3 && (c as Text).data.trim())) continue;
    if (!ctx.r.inViewport(el) || !ctx.r.visible(el)) continue;
    sampled++;
    const fam = firstFamily(ctx.r.cs(el).fontFamily);
    if (!failed.has(fam)) continue;
    const l = users.get(fam) ?? [];
    l.push(el);
    users.set(fam, l);
  }
  for (const [fam, f] of failed) {
    const list = users.get(fam);
    if (!list?.length) {
      ctx.abstain("font-failed:unused");
      continue;
    }
    const src = srcs.get(fam);
    if (src !== undefined && src && !/url\(/i.test(src)) {
      ctx.abstain("font-failed:local-only");
      continue;
    }
    const el = list[0];
    const url = src ? /url\(\s*["']?([^"')]+)/i.exec(src)?.[1] : undefined;
    out.push({
      kind: "font-failed",
      el,
      els: list,
      count: list.length,
      key: `font-failed|${fam}`,
      severity: "low",
      measured: { family: fam, weight: f.weight, style: f.style, ...(url ? { src: shortUrl(url, ctx) } : {}), elements: list.length, sampled },
      threshold: { value: "error", unit: "FontFace.status", source: "document.fonts after fonts.ready" },
      text: `the web font "${fam}" failed to load${url ? ` from ${shortUrl(url, ctx)}` : ""}; ${list.length} of ${sampled} sampled text elements fall back to another font, for example ${named(ctx, el)}.`,
      fixText: "fix the url() relative to the stylesheet, send Access-Control-Allow-Origin for fonts on another origin (fonts are fetched in CORS mode) and ship woff2",
      suggestion: {
        selector: "@font-face",
        css: `font-family: "${fam}"; src: url("/fonts/${fam.replace(/\s+/g, "-")}.woff2") format("woff2"); font-display: swap;`,
        note: "With a size-adjusted fallback font the swap does not move the layout.",
      },
    });
  }
}

export function* failedIconFonts(ctx: Ctx, env: AssetEnv, out: Draft[]): Generator<void> {
  if (!ctx.on("icon-font-failed")) return;
  const fs = faces(ctx);
  const late = env.fontsReadyAt !== null && ctx.now - env.fontsReadyAt >= 3000;
  const hits = new Map<string, { els: Element[]; how: "pua" | "ligature"; family: string; status: string; label: boolean; glyph: string }>();
  let cands: Element[] = [];
  try {
    cands = [...(ctx.r.doc.body?.querySelectorAll(ICON_SEL) ?? [])].slice(0, Math.min(300, ctx.max));
  } catch {
    return;
  }
  for (const el of cands) {
    yield;
    if (!ctx.r.inViewport(el) || !ctx.r.visible(el)) continue;
    const before = ctx.r.pseudo(el, "::before");
    const s = ctx.r.cs(el);
    const fontPx = parseFloat(s.fontSize) || 16;
    const text = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => (c as Text).data).join("");
    const how = iconBroken({ content: before?.content ?? "", text, widthPx: ctx.r.rect(el).width, fontPx });
    if (!how) continue;
    const family = firstFamily(how === "pua" && before ? before.fontFamily : s.fontFamily);
    const st = familyStatus(fs, family);
    if (st === "loaded" || (st === "pending" && !late)) continue;
    if (st === "none" && how === "ligature" && !ICON_FAMILY.test(family) && !/material/i.test(el.className)) continue;
    const ctl = el.closest("a, button, [role=button]");
    const label = !!ctl && !ctl.getAttribute("aria-label") && !ctl.getAttribute("title") && (ctl.textContent ?? "").replace(text, "").trim() === "";
    const k = `${family}|${how}`;
    const h = hits.get(k) ?? { els: [], how, family, status: st === "none" ? "not declared" : st === "pending" ? "still not loaded 3 s after fonts.ready" : "error", label: false, glyph: how === "ligature" ? text.trim() : `U+${((before?.content ?? "").replace(/^["']|["']$/g, "").codePointAt(0) ?? 0).toString(16).toUpperCase()}` };
    h.els.push(el);
    h.label ||= label;
    hits.set(k, h);
  }
  for (const h of hits.values()) {
    const el = h.els[0];
    out.push({
      kind: "icon-font-failed",
      el,
      els: h.els,
      count: h.els.length,
      key: `icon-font-failed|${h.family}|${h.how}`,
      severity: h.label ? "high" : "medium",
      measured: { family: h.family, status: h.status, shows: h.how === "pua" ? `a box for ${h.glyph}` : `the word "${h.glyph}"`, icons: h.els.length, onlyLabel: h.label },
      threshold: { value: "error", unit: "FontFace.status", source: "an icon glyph (Private Use Area, or a ligature word wider than 1.6 em) without its font" },
      text: `the icon font "${h.family}" is not available (${h.status}): ${h.els.length} icon${h.els.length === 1 ? "" : "s"} show ${h.how === "pua" ? "an empty box" : "their ligature word"}, for example ${named(ctx, el)}${h.label ? "; at least one is the only label of a button or link" : ""}.`,
      fixText: "fix the font path or its CORS headers, self-host the icon font, or switch to inline SVG icons; give icon-only buttons an aria-label",
    });
  }
}

// ------------------------------------------------------------------------------------------------ csp-blocked

const CSP_DIRECTIVES = new Set(["style-src", "style-src-elem", "style-src-attr", "font-src", "img-src", "media-src"]);
const EXT = /^(chrome|moz|safari-web|ms-browser)-extension:/;

/** VISUAL.md 3.7: an enforced violation of a style, font, image or media directive, not caused by an extension. */
export function cspReportable(e: { disposition?: string; effectiveDirective?: string; violatedDirective?: string; blockedURI?: string; sourceFile?: string }): boolean {
  if (e.disposition && e.disposition !== "enforce") return false;
  const d = (e.effectiveDirective || e.violatedDirective || "").split(" ")[0];
  if (!CSP_DIRECTIVES.has(d)) return false;
  return !EXT.test(e.blockedURI ?? "") && !EXT.test(e.sourceFile ?? "");
}

/** The element that requested a blocked URL (the event does not always name it). */
function requester(ctx: Ctx, uri: string): Element | null {
  if (!/^https?:/.test(uri)) return null;
  for (const el of [...ctx.r.doc.querySelectorAll("img[src], source[src], video[src], audio[src], link[href]")].slice(0, 500)) {
    const u = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || (el as HTMLLinkElement).href;
    if (u === uri) return el;
  }
  return null;
}

export function cspBlocked(ctx: Ctx, env: AssetEnv, out: Draft[]): void {
  if (!ctx.on("csp-blocked")) return;
  const groups = new Map<string, { n: number; e: SecurityPolicyViolationEvent; el: Element | null; firstParty: boolean }>();
  for (const e of env.csp) {
    if (!cspReportable(e)) continue;
    const d = (e.effectiveDirective || e.violatedDirective).split(" ")[0];
    let origin = e.blockedURI || "inline";
    try {
      if (/^https?:/.test(origin)) origin = new URL(origin).origin;
    } catch {
      /* keep */
    }
    const k = `${d}|${origin}`;
    const g = groups.get(k);
    const el = e.target instanceof Element && e.target.isConnected && e.target !== ctx.r.doc.documentElement ? e.target : requester(ctx, e.blockedURI);
    if (g) {
      g.n++;
      g.el ??= el;
    } else groups.set(k, { n: 1, e, el, firstParty: d.startsWith("style-src") && /^https?:/.test(e.blockedURI) && sameSite(e.blockedURI, ctx.win.location) });
  }
  for (const [k, g] of groups) {
    const [d, origin] = k.split("|");
    const what = d.startsWith("style") ? "a style" : d === "font-src" ? "a font" : d === "img-src" ? "an image" : "media";
    const el = g.el ?? ctx.r.doc.documentElement;
    out.push({
      kind: "csp-blocked",
      el,
      key: `csp-blocked|${k}`,
      severity: g.firstParty ? "high" : "medium",
      count: g.n,
      measured: { directive: d, blocked: origin === "inline" ? "inline" : shortUrl(origin, ctx), count: g.n },
      threshold: { value: "enforce", unit: "CSP disposition", source: "securitypolicyviolation events (extension sources excluded)" },
      text: `the Content-Security-Policy blocked ${what} from ${origin === "inline" ? "an inline source" : origin} (${d}, ${g.n} time${g.n === 1 ? "" : "s"})${g.el ? ` on ${named(ctx, g.el)}` : ""}.`,
      fixText:
        origin === "inline" || origin === "eval"
          ? `use a nonce or a hash for inline styles, or move style attributes into a stylesheet (${d})`
          : `add ${origin} to ${d} in the Content-Security-Policy header if it is meant to load`,
    });
  }
}
