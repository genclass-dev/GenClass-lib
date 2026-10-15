// The scanner's own page audits. Two halves:
//
// 1. pageSide(cmd, options) runs in the scanned page (Puppeteer's isolated world), serialised with toString() like the
//    probe's target finder: self-contained, DOM through `any`, and it only reads. It measures and returns plain data:
//      "vitals"  Largest Contentful Paint and layout shifts (PerformanceObserver, buffered), read once the network is
//                quiet and before the scanner presses a key or scrolls; images whose box follows the file's shape and
//                that have no width/height or aspect-ratio, with when each finished loading
//      "audit"   tap targets (phone), the viewport meta tag, text sizes (phone), the images on the page and their size
//      "reflow"  how wide the page is at the current viewport width, whether it can scroll sideways, and what sticks out
// 2. The judges (judgeTapTargets, judgeZoom, judgeFontSize, judgeReflow, judgeImages, judgeUnsized, judgeLcp, judgeCls)
//    are pure: measured data in, findings out, each against a published threshold that the finding names. They are
//    what test/audits.test.ts checks with fixtures.
//
// Every number a finding states is one of these measurements; nothing is estimated.

import type { RawFinding } from "./catalog.ts";
import type { Severity } from "./score.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The page side of the audits. Returns a plain object (or a promise of one for "vitals"). Never changes the page:
 * "reflow" scrolls to measure and scrolls back.
 */
export function pageSide(cmd: string, options?: any): any {
  const o = options || {};
  const g: any = globalThis as any;
  const doc: any = g.document;
  const de: any = doc.documentElement;
  const styles = new Map();
  const style = (el: any) => {
    let s = styles.get(el);
    if (!s) {
      s = g.getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const sel = (el: any): string => {
    const one = (e: any) => {
      const tag = String(e.tagName || "").toLowerCase();
      const id = e.getAttribute && e.getAttribute("id");
      if (id && /^[A-Za-z][\w-]{0,40}$/.test(id)) return tag + "#" + id;
      const cls = String((e.getAttribute && e.getAttribute("class")) || "")
        .split(/\s+/)
        .filter((c: string) => /^[A-Za-z_][\w-]{0,30}$/.test(c))
        .slice(0, 2);
      return tag + (cls.length ? "." + cls.join(".") : "");
    };
    let s = one(el);
    if (!/#/.test(s) && el.parentElement && el.parentElement !== doc.body && el.parentElement !== de) s = one(el.parentElement) + " > " + s;
    return s.slice(0, 160);
  };
  const sx = g.scrollX || 0;
  const sy = g.scrollY || 0;
  const visible = (el: any) => {
    try {
      if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true });
    } catch (e) {
      /* fall through */
    }
    const s = style(el);
    return s.display !== "none" && s.visibility === "visible" && parseFloat(s.opacity || "1") > 0;
  };

  if (cmd === "vitals") {
    const take = (type: string) =>
      new Promise((resolve: (v: any[]) => void) => {
        const out: any[] = [];
        let po: any = null;
        try {
          po = new g.PerformanceObserver((list: any) => {
            for (const e of list.getEntries()) if (out.indexOf(e) < 0) out.push(e);
          });
          po.observe({ type, buffered: true });
        } catch (e) {
          resolve(out);
          return;
        }
        g.setTimeout(() => {
          try {
            for (const e of po.takeRecords()) if (out.indexOf(e) < 0) out.push(e);
            po.disconnect();
          } catch (e) {
            /* ignore */
          }
          resolve(out);
        }, 80);
      });
    const rect = (r: any) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
    return Promise.all([take("largest-contentful-paint"), take("layout-shift")]).then((all: any[]) => {
      const lcps = all[0];
      const shifts = all[1];
      const last = lcps.length ? lcps[lcps.length - 1] : null;
      const lcp = last ? { t: Math.round(last.startTime), size: Math.round(last.size || 0), sel: last.element && last.element.isConnected ? sel(last.element) : "", url: String(last.url || "").slice(0, 200) } : null;
      const sh = shifts.slice(0, 80).map((s: any) => ({
        t: Math.round(s.startTime),
        v: Math.round(s.value * 10000) / 10000,
        input: !!s.hadRecentInput,
        sources: (s.sources || []).slice(0, 5).map((x: any) => ({
          sel: x.node ? (x.node.nodeType === 1 ? sel(x.node) : x.node.parentElement ? sel(x.node.parentElement) : "") : "",
          prev: rect(x.previousRect),
          cur: rect(x.currentRect),
        })),
      }));
      const unsized: any[] = [];
      const imgs = Array.prototype.slice.call(doc.images, 0, 300);
      for (const img of imgs) {
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || !visible(img)) continue;
        const s = style(img);
        if (s.position === "absolute" || s.position === "fixed") continue; // they push nothing
        const ar = String(s.aspectRatio || "auto");
        const attrs = (img.hasAttribute("width") && img.hasAttribute("height")) || (!!img.style.width && !!img.style.height) || !!img.style.aspectRatio;
        const follows = Math.abs(r.height - (r.width * img.naturalHeight) / img.naturalWidth) <= 2;
        if (attrs || ar !== "auto" || !follows) continue;
        const src = String(img.currentSrc || img.src || "");
        if (!/^https?:/.test(src)) continue;
        const e = g.performance.getEntriesByName(src)[0];
        unsized.push({ sel: sel(img), x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height), end: e ? Math.round(e.responseEnd) : null });
        if (unsized.length >= 40) break;
      }
      // what the page can read about its window and screen (a page that lays itself out from these sees what a
      // visitor's browser would report only when they agree with the viewport)
      const env = [g.innerWidth, g.innerHeight, g.outerWidth, g.outerHeight, g.screen ? g.screen.width : 0, g.screen ? g.screen.height : 0, de.clientWidth].map((x: any) => Math.round(Number(x) || 0));
      const paints = g.performance.getEntriesByType("paint");
      const paint = paints.find((p: any) => p.name === "first-paint");
      const fcpE = paints.find((p: any) => p.name === "first-contentful-paint");
      return {
        lcp, shifts: sh, unsized, visibility: String(doc.visibilityState || ""), env, firstPaint: paint ? Math.round(paint.startTime) : null,
        fcp: fcpE ? Math.round(fcpE.startTime) : null,
      };
    });
  }

  if (cmd === "wall") {
    // whether the page is a bot check or a wall instead of the real page: how much text and how many elements the body
    // has, and which known challenge or captcha markers its HTML carries (judged in report.ts blockedOf)
    const body = doc.body;
    const elements = body ? body.getElementsByTagName("*").length : 0;
    const title = String(doc.title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    // a page this big is the real page, not a wall: skip the text and HTML reads, which take up to the read's timeout
    // on heavy pages (time the view would otherwise give axe-core); text -1 means "not read" (report.ts viewBlocked)
    if (elements >= 1500) return { text: -1, elements, title, marks: [] };
    const text = body ? String(body.innerText || "").replace(/\s+/g, " ").trim() : "";
    const html = String(de.outerHTML || "").slice(0, 400000);
    const MARKS: [string, RegExp][] = [
      ["AWS WAF challenge", /awsWafCookieDomainList|gokuProps|AwsWafIntegration|token\.awswaf\.com|captcha\.awswaf\.com/],
      ["Cloudflare challenge", /_cf_chl_opt|cf-chl-widget|challenge-error-text|<title>\s*Just a moment\.\.\.\s*<\/title>|Attention Required! \| Cloudflare/i],
      ["Akamai block page", /errors\.edgesuite\.net|<title>\s*Access Denied\s*<\/title>/i],
      ["robot check", /Robot Check|\/errors\/validateCaptcha|opfcaptcha/i],
      ["Imperva challenge", /_Incapsula_Resource|Incapsula incident ID/i],
      ["DataDome challenge", /captcha-delivery\.com/i],
      ["PerimeterX challenge", /px-captcha|_pxCaptcha/i],
      ["Sucuri firewall", /Sucuri WebSite Firewall/i],
      ["Kasada challenge", /KPSDK/],
      ["captcha", /g-recaptcha|h-captcha|hcaptcha\.com|recaptcha\/api|challenges\.cloudflare\.com\/turnstile|<form[^>]+captcha/i],
    ];
    const marks = MARKS.filter((m) => m[1].test(html)).map((m) => m[0]);
    return { text: text.length, elements, title, marks };
  }

  if (cmd === "overflow") {
    // the window's own scrolling: html's overflow-y, body's, and how far there is to scroll
    return { html: style(de).overflowY, body: doc.body ? style(doc.body).overflowY : "visible", sh: de.scrollHeight, ch: de.clientHeight };
  }

  if (cmd === "reflow") {
    const width = de.clientWidth;
    const sw = Math.max(de.scrollWidth, doc.body ? doc.body.scrollWidth : 0);
    const htmlX = style(de).overflowX;
    const bodyX = doc.body ? style(doc.body).overflowX : "visible";
    const viewportX = htmlX !== "visible" ? htmlX : bodyX;
    const scrollable = viewportX !== "hidden" && viewportX !== "clip";
    const culprits: any[] = [];
    if (sw > width + 1) {
      const all = doc.body ? doc.body.getElementsByTagName("*") : [];
      const hits: any[] = [];
      for (let i = 0; i < all.length && i < 8000; i++) {
        const el = all[i];
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const right = r.right + sx;
        if (right <= width + 1) continue;
        const s = style(el);
        if (s.position === "fixed") continue;
        let inScroller = false;
        for (let a = el.parentElement; a && a !== doc.body && a !== de; a = a.parentElement) {
          if (style(a).overflowX !== "visible") {
            inScroller = true;
            break;
          }
        }
        if (inScroller) continue;
        hits.push({ el, right, w: r.width, partly: r.left + sx < width });
      }
      const deepest = hits.filter((x) => !hits.some((y) => y !== x && x.el.contains(y.el)));
      deepest.sort((a, b) => (a.partly === b.partly ? b.right - a.right : a.partly ? -1 : 1));
      for (const x of deepest.slice(0, 3)) culprits.push({ sel: sel(x.el), right: Math.round(x.right), w: Math.round(x.w), tag: String(x.el.tagName).toLowerCase() });
    }
    return { width, sw, scrollable, culprits };
  }

  if (cmd === "focus" || cmd === "focusOne" || cmd === "focusBlur" || cmd === "focusDone") {
    // Keyboard focus (WCAG 2.4.7), in two steps. "focus" lists the page's keyboard stops in sequential order (positive
    // tabindex first, then document order), counts those before the main content and looks for a skip link, then
    // focuses each of the first ones by script and compares the computed styles of the element, its pseudo-elements,
    // ancestors and children with and without focus: an element whose styles do not change at all is a candidate.
    // "focusOne" focuses the stop before a candidate so the scanner can press a real Tab; "focusBlur" and
    // "focusDone" take focus away and put the page back. The list lives in this isolated world only.
    const key = String(o.name || "__gcsFocus");
    if (cmd === "focusBlur") {
      const a = doc.activeElement;
      if (a && a !== doc.body && typeof a.blur === "function") a.blur();
      return { ok: true };
    }
    if (cmd === "focusDone") {
      const st = g[key];
      const a = doc.activeElement;
      if (a && a !== doc.body && typeof a.blur === "function") a.blur();
      if (st) {
        try {
          g.scrollTo({ left: st.sx, top: st.sy, behavior: "instant" });
        } catch (e) {
          g.scrollTo(st.sx, st.sy);
        }
      }
      try {
        delete g[key];
      } catch (e) {
        g[key] = undefined;
      }
      return { ok: true };
    }
    if (cmd === "focusOne") {
      const st = g[key];
      const i = Number(o.i);
      if (!st || !(i >= 0 && i < st.list.length)) return { ok: false };
      if (o.check) {
        const el = st.list[i];
        const r = el.getBoundingClientRect();
        let fv = false;
        try {
          fv = el.matches(":focus-visible");
        } catch (e) {
          fv = false;
        }
        return { ok: doc.activeElement === el && fv, x: r.left, y: r.top, w: r.width, h: r.height, vw: g.innerWidth, vh: g.innerHeight, sx: g.scrollX, sy: g.scrollY };
      }
      // the stop before the candidate gets focus by script; the scanner's Tab then moves focus to the candidate
      const a = doc.activeElement;
      if (a && a !== doc.body && typeof a.blur === "function") a.blur();
      if (i > 0) st.list[i - 1].focus({ preventScroll: true });
      return { ok: i === 0 || doc.activeElement === st.list[i - 1] };
    }
    // "focus"
    const sx0 = g.scrollX;
    const sy0 = g.scrollY;
    const Q = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';
    const raw = Array.prototype.slice.call(doc.querySelectorAll(Q), 0, 4000);
    const stops: any[] = [];
    for (const el of raw) {
      if (!(el.tabIndex >= 0) || el.disabled || (el.closest && el.closest("[inert]"))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || !visible(el)) continue;
      stops.push(el);
    }
    const positive = stops.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex);
    const list = positive.concat(stops.filter((e) => e.tabIndex === 0));
    const main = doc.querySelector('main, [role="main"]') || doc.querySelector("h1");
    let beforeMain: number | null = null;
    if (main) {
      beforeMain = 0;
      for (const el of list) if (!main.contains(el) && el.compareDocumentPosition(main) & 4) beforeMain++;
    }
    // a skip link is usually visually hidden until it has focus (1 by 1 px, clipped, or transparent), so the first
    // stops are taken from every focusable element that is displayed, whatever its size or opacity
    const loose: any[] = [];
    for (const el of raw) {
      if (!(el.tabIndex >= 0) || el.disabled || (el.closest && el.closest("[inert]"))) continue;
      let shown = true;
      try {
        shown = typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : style(el).display !== "none";
      } catch (e) {
        shown = true;
      }
      if (shown) loose.push(el);
    }
    const looseOrder = loose.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex).concat(loose.filter((e) => e.tabIndex === 0));
    let skip = "";
    for (const el of looseOrder.slice(0, 3)) {
      // a control that says it skips to the content counts whatever it is (some sites use a button that moves focus)
      const words = String(el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
      if (/^(skip|jump)\b.*\b(content|main|navigation|nav)\b/i.test(words)) {
        skip = sel(el);
        continue;
      }
      const h = String(el.getAttribute("href") || "");
      if (el.tagName !== "A" || h.length < 2 || h.charAt(0) !== "#") continue;
      let id = h.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch (e) {
        /* keep it */
      }
      if (doc.getElementById(id) || doc.getElementsByName(id).length) skip = sel(el);
    }
    const TEXTY = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time)$/;
    const typing = (el: any) =>
      el.tagName === "TEXTAREA" || el.tagName === "IFRAME" || el.isContentEditable || (el.tagName === "INPUT" && TEXTY.test(String(el.type || "text").toLowerCase()));
    const PROPS = ["box-shadow", "background-color", "background-image", "color", "opacity", "transform", "scale", "translate", "filter", "visibility", "font-weight", "letter-spacing", "fill", "stroke", "clip-path", "clip", "position", "left", "top", "width", "height", "padding-top", "padding-bottom", "z-index"];
    // what can be seen of the element, its pseudo-elements, five ancestors and eight descendants, as "where prop=value";
    // an outline, a border side or an underline counts only when it is drawn (Chrome's own a:focus-visible sets
    // outline-offset, which shows nothing while outline-style is none)
    const one = (out: string[], where: string, e: any, pseudo: string | null) => {
      const cs = pseudo ? g.getComputedStyle(e, pseudo) : g.getComputedStyle(e);
      const v = (p: string) => String(cs.getPropertyValue(p));
      if (pseudo) {
        const c = v("content");
        out.push(where + " content=" + c);
        if (c === "none" || c === "normal") return;
      }
      const ol = v("outline-style");
      out.push(where + " outline=" + (ol === "none" || parseFloat(v("outline-width")) === 0 ? "none" : [ol, v("outline-width"), v("outline-color"), v("outline-offset")].join(" ")));
      for (const side of ["top", "right", "bottom", "left"]) {
        const st = v("border-" + side + "-style");
        const w = v("border-" + side + "-width");
        out.push(where + " border-" + side + "=" + (st === "none" || st === "hidden" || parseFloat(w) === 0 ? "none" : [st, w, v("border-" + side + "-color")].join(" ")));
      }
      const tl = v("text-decoration-line");
      out.push(where + " text-decoration=" + (tl === "none" ? "none" : [tl, v("text-decoration-style"), v("text-decoration-color"), v("text-decoration-thickness"), v("text-underline-offset")].join(" ")));
      for (const p of PROPS) out.push(where + " " + p + "=" + v(p));
    };
    const snap = (el: any) => {
      const r = el.getBoundingClientRect();
      const out: string[] = ["box=" + [Math.round(r.left + g.scrollX), Math.round(r.top + g.scrollY), Math.round(r.width), Math.round(r.height)].join(",")];
      one(out, "el", el, null);
      one(out, "el::before", el, "::before");
      one(out, "el::after", el, "::after");
      for (let a = el.parentElement, k = 0; a && a !== de && k < 5; a = a.parentElement, k++) one(out, "up" + (k + 1), a, null);
      const kids = el.getElementsByTagName("*");
      for (let k = 0; k < kids.length && k < 8; k++) {
        one(out, "in" + (k + 1), kids[k], null);
        one(out, "in" + (k + 1) + "::before", kids[k], "::before");
        one(out, "in" + (k + 1) + "::after", kids[k], "::after");
      }
      return out;
    };
    const near = (el: any, anim: any) => {
      const t = anim && anim.effect && anim.effect.target;
      return !!t && (t === el || el.contains(t) || t.contains(el));
    };
    const max = Math.max(1, Math.min(60, Number(o.max) || 40));
    let checked = 0;
    let changed = 0;
    let notVisibleMode = 0;
    const candidates: any[] = [];
    // what changed, for the first stops: the first differing property (calibration and the report's counts)
    const diffs: string[] = [];
    const t0 = g.performance.now();
    for (let i = 0; i < list.length && checked < max && g.performance.now() - t0 < 1500; i++) {
      const el = list[i];
      if (typing(el)) continue;
      const before = snap(el);
      el.focus({ preventScroll: true });
      if (doc.activeElement !== el) continue;
      let fv = false;
      try {
        fv = el.matches(":focus-visible");
      } catch (e) {
        fv = false;
      }
      checked++;
      if (!fv) {
        notVisibleMode++;
        el.blur();
        continue;
      }
      const after = snap(el);
      const moving = typeof doc.getAnimations === "function" && doc.getAnimations().some((an: any) => near(el, an));
      let diff = "";
      for (let k = 0; k < after.length && !diff; k++) if (after[k] !== before[k]) diff = after[k].split("=")[0];
      if (!diff && after.length !== before.length) diff = "structure";
      if (moving || diff) {
        changed++;
        // an outline on the element itself is the common case; the others are worth a look in calibration
        if (diffs.length < 12 && diff !== "el outline") diffs.push(sel(el).slice(0, 40) + ": " + (moving ? "animation" : diff).slice(0, 60));
      }
      else {
        const lab = String(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const r = el.getBoundingClientRect();
        candidates.push({ i, sel: sel(el), lab, x: Math.round(r.left + g.scrollX), y: Math.round(r.top + g.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
      }
      el.blur();
    }
    try {
      g.scrollTo({ left: sx0, top: sy0, behavior: "instant" });
    } catch (e) {
      g.scrollTo(sx0, sy0);
    }
    g[key] = { list, sx: sx0, sy: sy0 };
    return { stops: list.length, beforeMain, main: main ? sel(main) : "", skip, checked, changed, notVisibleMode, candidates, diffs };
  }

  // "audit"
  const out: any = { vw: de.clientWidth, docW: Math.max(de.scrollWidth, de.clientWidth), dpr: g.devicePixelRatio || 1 };
  const metas = doc.querySelectorAll('meta[name="viewport" i]');
  out.viewport = metas.length ? String(metas[metas.length - 1].getAttribute("content") || "").slice(0, 300) : null;

  if (o.targets) {
    const Q =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
    const LINKISH = 'a, button, [role="link"], [role="button"]';
    const els = Array.prototype.slice.call(doc.querySelectorAll(Q), 0, 800);
    const index = new Map();
    const targets: any[] = [];
    const rectOf = new Map();
    const box = (el: any) => {
      let r = rectOf.get(el);
      if (!r) {
        r = el.getBoundingClientRect();
        rectOf.set(el, r);
      }
      return r;
    };
    const shown = (el: any, r: any) => {
      if (r.right + sx <= 0 || r.left + sx >= out.docW || r.bottom + sy <= 0) return false;
      if (!visible(el)) return false;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      for (let a = el.parentElement, i = 0; a && a !== doc.body && a !== de && i < 40; a = a.parentElement, i++) {
        if (a.hasAttribute("inert")) return false;
        const s = style(a);
        if (s.overflowX !== "visible" || s.overflowY !== "visible") {
          const ar = box(a);
          if (cx < ar.left - 1 || cx > ar.right + 1 || cy < ar.top - 1 || cy > ar.bottom + 1) return false;
        }
      }
      return true;
    };
    const inlineInText = (el: any, s: any) => {
      if (s.display !== "inline") return false;
      if (el.tagName !== "A" && el.getAttribute("role") !== "link") return false;
      let b = el.parentElement;
      while (b && b !== doc.body && /^inline/.test(style(b).display)) b = b.parentElement;
      if (!b) return false;
      let own = 0;
      const w = doc.createTreeWalker(b, 4);
      let n = w.nextNode();
      while (n && own < 10) {
        const p = n.parentElement;
        const l = p ? p.closest(LINKISH) : null;
        if (!(l && b.contains(l))) own += (String(n.nodeValue).match(/[\p{L}\p{N}]/gu) || []).length;
        n = w.nextNode();
      }
      return own >= 10;
    };
    const uaControl = (el: any, s: any, r: any) => {
      const type = String(el.type || "").toLowerCase();
      if (el.tagName !== "INPUT" || (type !== "checkbox" && type !== "radio")) return false;
      if (s.appearance !== "none" && r.width <= 16 && r.height <= 16) return true;
      const labels = el.labels ? Array.prototype.slice.call(el.labels) : [];
      return labels.some((l: any) => {
        const b = l.getBoundingClientRect();
        return b.width >= 24 && b.height >= 24;
      });
    };
    for (const el of els) {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const r = box(el);
      if (r.width < 2 || r.height < 2) continue;
      const s = style(el);
      if (s.pointerEvents === "none" || !shown(el, r)) continue;
      const lab = String(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 24);
      targets.push({ el, sel: sel(el), lab, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, inline: inlineInText(el, s), ua: uaControl(el, s, r) });
    }
    // Hit-test every target at its centre, half a screen of the page at a time: a target under another element (a menu
    // kept behind the page, a slide under the current one, a card covered by its own stretched link) is not one a
    // visitor can tap there. Only the middle of each screen is used, clear of sticky bars; fixed and sticky targets are
    // tested where they are. Targets that could not be tested (past 24 half screens) are left out.
    const vh = g.innerHeight || 800;
    const vw = g.innerWidth || out.vw;
    const startX = g.scrollX;
    const startY = g.scrollY;
    const go = (y: number) => {
      try {
        g.scrollTo({ left: startX, top: y, behavior: "instant" });
      } catch (e) {
        g.scrollTo(startX, y);
      }
    };
    const pinned = (el: any) => {
      for (let a = el; a && a !== doc.body && a !== de; a = a.parentElement) {
        const p = style(a).position;
        if (p === "fixed" || p === "sticky") return true;
      }
      return false;
    };
    const tested = new Set();
    const onTop = new Set();
    const test = (t: any, lo: number, hi: number) => {
      const r = t.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cy < lo || cy > hi || cx < 0 || cx > vw) return;
      tested.add(t);
      const hit = doc.elementFromPoint(cx, cy);
      if (hit && (hit === t.el || t.el.contains(hit))) onTop.add(t);
    };
    for (const t of targets) if (pinned(t.el)) test(t, 0, vh);
    const step = Math.max(200, Math.floor(vh / 2));
    for (let band = 0; band < 24 && tested.size < targets.length; band++) {
      go(band * step);
      const at = g.scrollY;
      const last = at + vh >= Math.max(de.scrollHeight, doc.body ? doc.body.scrollHeight : 0) - 1;
      for (const t of targets) if (!tested.has(t)) test(t, band === 0 ? 0 : vh * 0.25, last ? vh : vh * 0.75);
      if (last || (band > 0 && at < band * step - step)) break;
    }
    go(startY);
    const kept = targets.filter((t) => onTop.has(t));
    kept.forEach((t, i) => index.set(t.el, i));
    for (const t of kept) {
      let p = -1;
      for (let a = t.el.parentElement; a && p < 0; a = a.parentElement) if (index.has(a)) p = index.get(a);
      t.p = p;
    }
    out.covered = targets.length - kept.length;
    out.targets = kept.map((t) => ({ sel: t.sel, lab: t.lab, x: t.x, y: t.y, w: t.w, h: t.h, inline: t.inline, ua: t.ua, p: t.p }));
  }

  if (o.text && doc.body) {
    let total = 0;
    let small = 0;
    const blocks = new Map();
    const w = doc.createTreeWalker(doc.body, 4);
    let n = w.nextNode();
    for (let k = 0; n && k < 40000; k++, n = w.nextNode()) {
      const t = String(n.nodeValue || "");
      if (!/\S/.test(t)) continue;
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|OPTION)$/.test(p.tagName) || p.closest("svg")) continue;
      // text in an element marked as a picture or as decoration is not body text (a mock interface in an illustration)
      if (p.closest('[role="img"], [aria-hidden="true"]')) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || !visible(p)) continue;
      const chars = t.replace(/\s+/g, "").length;
      const px = parseFloat(style(p).fontSize) || 16;
      total += chars;
      if (px < 12) {
        small += chars;
        const b = blocks.get(p) || { sel: sel(p), px: Math.round(px * 10) / 10, chars: 0, x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
        b.chars += chars;
        blocks.set(p, b);
      }
    }
    const list = Array.from(blocks.values()).filter((b: any) => b.chars >= 40);
    list.sort((a: any, b: any) => b.chars - a.chars);
    out.text = { total, small, blocks: list.slice(0, 20) };
  }

  if (o.images) {
    const imgs: any[] = [];
    for (const img of Array.prototype.slice.call(doc.images, 0, 300)) {
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || !visible(img)) continue;
      const src = String(img.currentSrc || img.src || "");
      if (!/^https?:/.test(src)) continue;
      imgs.push({ sel: sel(img), src: src.slice(0, 400), natW: img.naturalWidth, natH: img.naturalHeight, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left + sx), y: Math.round(r.top + sy) });
      if (imgs.length >= 120) break;
    }
    out.images = imgs;
  }

  if (o.head) {
    // what search engines and link previews read, and the document mode
    const meta = (q: string) => {
      const els = Array.prototype.slice.call(doc.querySelectorAll(q), 0, 10);
      const vals = els.map((m: any) => String(m.getAttribute("content") || "").trim()).filter((x: string) => x);
      return vals.length ? vals[0].slice(0, 300) : els.length ? "" : null;
    };
    const robots = Array.prototype.slice.call(doc.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]'), 0, 10).map((m: any) => String(m.getAttribute("content") || "").slice(0, 200));
    const csp = Array.prototype.slice.call(doc.querySelectorAll('meta[http-equiv="content-security-policy" i]'), 0, 5).map((m: any) => String(m.getAttribute("content") || "").slice(0, 1000));
    const GENERIC = ["click here", "click this", "go", "here", "information", "learn more", "more", "more info", "more information", "right here", "read more", "see more", "start", "this"];
    let generic = 0;
    const genericEx: string[] = [];
    for (const a of Array.prototype.slice.call(doc.querySelectorAll("a[href]"), 0, 3000)) {
      const href = String(a.getAttribute("href") || "").trim();
      if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) continue;
      const text = String(a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().replace(/[.:!?\u2026\u203a\u00bb>\u2192]+$/, "").trim();
      if (GENERIC.indexOf(text) < 0) continue;
      // a name that says more (aria-label, aria-labelledby, title) tells screen readers where it goes
      const named = String(a.getAttribute("aria-label") || a.getAttribute("title") || "").trim().toLowerCase();
      if (a.getAttribute("aria-labelledby") || (named && named !== text)) continue;
      if (!visible(a)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      generic++;
      if (genericEx.length < 5) genericEx.push(sel(a) + ' ("' + text + '")');
    }
    out.head = {
      title: String(doc.title || "").trim().slice(0, 200),
      description: meta('meta[name="description" i]'),
      robots,
      ogTitle: meta('meta[property="og:title" i]'),
      ogImage: meta('meta[property="og:image" i], meta[property="og:image:url" i]'),
      twTitle: meta('meta[name="twitter:title" i]'),
      twImage: meta('meta[name="twitter:image" i], meta[name="twitter:image:src" i]'),
      icon: !!doc.querySelector('link[rel~="icon" i][href]'),
      compat: String(doc.compatMode || ""),
      csp,
      generic,
      genericEx,
    };
  }

  if (o.fonts && doc.fonts) {
    // web fonts that loaded, with their font-display (CSS Fonts 4; "auto" is what an @font-face without it gets). When
    // two faces match the same family, weight, style and range, the later one is the one text uses, so only it counts
    const last = new Map();
    try {
      doc.fonts.forEach((f: any) => {
        const key = [f.family, f.weight, f.style, f.stretch, f.unicodeRange].map((x: any) => String(x || "")).join("|");
        last.set(key, f);
      });
    } catch (e) {
      /* no font list */
    }
    const faces: any[] = [];
    last.forEach((f: any) => {
      if (faces.length < 60 && f.status === "loaded") faces.push({ family: String(f.family || "").replace(/["']/g, "").slice(0, 60), display: String(f.display || "auto"), weight: String(f.weight || ""), style: String(f.style || "") });
    });
    out.fonts = faces;
  }
  return out;
}

/** The source that runs pageSide in the page and returns its result as a JSON string. */
export function pageSideSource(cmd: "vitals" | "audit" | "reflow" | "overflow" | "wall" | "focus" | "focusOne" | "focusBlur" | "focusDone", options: Record<string, unknown> = {}): string {
  return `(async () => JSON.stringify(await (${pageSide.toString()})(${JSON.stringify(cmd)}, ${JSON.stringify(options)})))()`;
}

// ============================================================================================== the judges

type Box = { x: number; y: number; w: number; h: number };
const n0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s0 = (v: unknown, n = 160): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n) : "");
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const kb = (b: number): string => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1000)} KB`);
const secs = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;
const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------ tap targets

export interface Target {
  sel: string;
  /** The target's text or label, cut short ("" when it has none). */
  lab?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A link inside a sentence: exempt (WCAG 2.5.8 "inline"). */
  inline: boolean;
  /** A checkbox or radio at the browser's own size, or with a label of at least 24 by 24 px: exempt. */
  ua: boolean;
  /** The index of the closest target that contains this one, or -1. */
  p: number;
}

/** The minimum target size of WCAG 2.2 SC 2.5.8, in CSS px. */
export const TARGET_MIN = 24;

/** Distance from a point to a rectangle (0 inside it). */
function pointToRect(cx: number, cy: number, r: Box): number {
  const dx = Math.max(r.x - cx, 0, cx - (r.x + r.w));
  const dy = Math.max(r.y - cy, 0, cy - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA, on the phone view: a target smaller than 24 by 24 CSS px fails
 * unless the spacing exception holds: a 24 px circle centred on it intersects no other target and no other small
 * target's circle. Exempt: links inside a sentence (inline), checkboxes and radios at the browser's own size or with a
 * big enough label (user agent, equivalent). Targets nested in each other are not compared.
 */
export function judgeTapTargets(raw: unknown): RawFinding | null {
  const list: Target[] = (Array.isArray(raw) ? raw : []).slice(0, 800).map((t) => {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    return { sel: s0(o.sel), lab: s0(o.lab, 24), x: n0(o.x), y: n0(o.y), w: n0(o.w), h: n0(o.h), inline: o.inline === true, ua: o.ua === true, p: Math.round(n0(o.p ?? -1)) };
  });
  if (!list.length) return null;
  const small = (t: Target) => t.w < TARGET_MIN || t.h < TARGET_MIN;
  const exempt = (t: Target) => t.inline || t.ua;
  const chain = (i: number): Set<number> => {
    const s = new Set<number>();
    for (let k = list[i].p, guard = 0; k >= 0 && k < list.length && guard < 50; k = list[k].p, guard++) s.add(k);
    return s;
  };
  const ancestors = list.map((_, i) => chain(i));
  const related = (i: number, j: number) => ancestors[i].has(j) || ancestors[j].has(i);
  const failing: { i: number; j: number; d: number; circles: boolean }[] = [];
  let undersized = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (!small(t) || exempt(t)) continue;
    undersized++;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    let hit: { j: number; d: number; circles: boolean } | null = null;
    for (let j = 0; j < list.length && !hit; j++) {
      if (j === i || related(i, j)) continue;
      const u = list[j];
      const d = pointToRect(cx, cy, u);
      if (d < TARGET_MIN / 2) hit = { j, d, circles: false };
      else if (small(u) && !exempt(u)) {
        const dc = Math.hypot(cx - (u.x + u.w / 2), cy - (u.y + u.h / 2));
        if (dc < TARGET_MIN) hit = { j, d: dc, circles: true };
      }
    }
    if (hit) failing.push({ i, ...hit });
  }
  if (!failing.length) return null;
  const f0 = failing[0];
  const first = list[f0.i];
  const near = list[f0.j];
  const name = (t: Target): string => (t.lab ? `${t.sel} ("${t.lab}")` : t.sel);
  const examples = [...new Set(failing.map((f) => name(list[f.i])).filter(Boolean))].slice(0, 5);
  const how = f0.circles
    ? `its centre is ${Math.round(f0.d)} px from the centre of ${name(near)}, another small target (24 px needed)`
    : `${name(near)} is ${Math.round(f0.d)} px from its centre (12 px needed)`;
  return {
    kind: "tap-target-small",
    selector: first.sel,
    box: { x: first.x, y: first.y, w: first.w, h: first.h },
    measured: `${plural(failing.length, "target")} of ${fmt(list.length)} on the phone view ${failing.length === 1 ? "is" : "are"} under 24 by 24 px and too close to another target. First: ${name(first)} is ${Math.round(first.w)} by ${Math.round(first.h)} px and ${how}.`,
    detail: { severity: "serious" satisfies Severity, count: failing.length, undersized, checked: list.length, examples },
  };
}

// ------------------------------------------------------------------------------------------ zoom

/** The viewport meta tag's content as lower-case key/value pairs (separators , and ;). */
export function viewportPairs(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of content.split(/[,;]/)) {
    const [k, v = ""] = part.split("=").map((x) => x.trim().toLowerCase());
    if (k && /^[a-z-]{1,30}$/.test(k)) out[k] = v;
  }
  return out;
}

/**
 * WCAG 2.2 SC 1.4.4 Resize Text, level AA (ACT rule b4f0c3, the same test axe-core's meta-viewport rule runs): the
 * viewport meta tag must not stop zooming: user-scalable=no (or 0), or maximum-scale below 2. Null when zoom is allowed
 * or there is no tag.
 */
export function judgeZoom(content: string | null): RawFinding | null {
  if (content === null) return null;
  const p = viewportPairs(content);
  const why: string[] = [];
  const us = p["user-scalable"];
  if (us === "no" || us === "0") why.push(`user-scalable=${us}`);
  const max = p["maximum-scale"] !== undefined ? Number.parseFloat(p["maximum-scale"]) : Number.NaN;
  if (Number.isFinite(max) && max < 2) why.push(`maximum-scale=${p["maximum-scale"]} (below 2, so text cannot reach 200%)`);
  if (!why.length) return null;
  return {
    kind: "zoom-disabled",
    selector: 'meta[name="viewport"]',
    box: null,
    measured: `The viewport meta tag is "${s0(content, 120)}": ${why.join(" and ")}.`,
    detail: { severity: "serious" satisfies Severity, count: 1 },
  };
}

/**
 * Whether the window scrolls, by CSS overflow propagation (CSS Overflow Module Level 3, 3.3): body's overflow reaches the
 * viewport only when html's is visible. The visual checks blame a scroll lock on body's overflow-y: hidden; when html
 * sets overflow-y: scroll or auto, the window scrolls anyway (measured on a public page: 600 px in a desktop browser),
 * so that finding is left out, provided there is content to scroll to.
 */
export function windowScrolls(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const html = s0(o.html, 20);
  const viewport = html !== "visible" ? html : s0(o.body, 20);
  return (viewport === "auto" || viewport === "scroll") && n0(o.sh) - n0(o.ch) > 100;
}

/** A viewport meta tag that sets width or initial-scale (what Lighthouse's viewport audit asks for). */
export const viewportOk = (content: string | null): boolean => {
  if (content === null) return false;
  const p = viewportPairs(content);
  return p.width !== undefined || p["initial-scale"] !== undefined;
};

// ------------------------------------------------------------------------------------------ text size

export const FONT_MIN = 12;
/** Lighthouse's legible-font-size audit passes when at least 60% of the text is 12 px or more. */
export const LEGIBLE_SHARE = 0.6;
/** Ignore pages with less text than this (characters): the share means little. */
const MIN_TEXT = 200;

/**
 * Text under 12 px on the phone view (Lighthouse's legible font size threshold). A finding when a block of body text of
 * at least 40 characters is under 12 px: moderate when more than 40% of the page's text is (Lighthouse's audit fails),
 * minor otherwise. Not judged without a viewport meta tag that sets the width (the page is shown zoomed out, which the
 * viewport finding covers).
 */
export function judgeFontSize(raw: unknown, viewport: string | null): RawFinding | null {
  if (!viewportOk(viewport) || !raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const total = n0(o.total);
  const small = n0(o.small);
  if (total < MIN_TEXT) return null;
  const blocks = (Array.isArray(o.blocks) ? o.blocks : []).map((b) => {
    const x = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    return { sel: s0(x.sel), px: n0(x.px), chars: n0(x.chars), box: { x: n0(x.x), y: n0(x.y), w: n0(x.w), h: n0(x.h) } };
  }).filter((b) => b.chars >= 40 && b.px > 0 && b.px < FONT_MIN);
  const share = small / total;
  const fails = share > 1 - LEGIBLE_SHARE;
  if (!blocks.length && !fails) return null;
  const top = blocks[0];
  const pct = Math.round(share * 100);
  return {
    kind: "font-size-small",
    selector: top?.sel ?? "",
    box: top?.box ?? null,
    measured:
      `${pct}% of the text on the phone view (${fmt(small)} of ${fmt(total)} characters) is under 12 px${fails ? ", so Lighthouse's legible-font-size audit (60% at 12 px or more) fails" : ""}.` +
      (top ? ` Largest block: ${top.sel}, ${top.px} px, ${fmt(top.chars)} characters.` : ""),
    detail: { severity: (fails ? "moderate" : "minor") satisfies Severity, count: Math.max(1, blocks.length), share: Math.round(share * 1000) / 1000, examples: blocks.slice(0, 5).map((b) => b.sel) },
  };
}

// ------------------------------------------------------------------------------------------ reflow

export interface ReflowAt {
  width: number;
  sw: number;
  scrollable: boolean;
  culprits: { sel: string; right: number; w: number; tag: string }[];
}

const parseReflow = (v: unknown, width: number): ReflowAt | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    width: Math.round(n0(o.width)) || width,
    sw: Math.round(n0(o.sw)),
    scrollable: o.scrollable !== false,
    culprits: (Array.isArray(o.culprits) ? o.culprits : []).slice(0, 3).map((c) => {
      const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return { sel: s0(x.sel), right: Math.round(n0(x.right)), w: Math.round(n0(x.w)), tag: s0(x.tag, 20) };
    }),
  };
};

/**
 * WCAG 2.2 SC 1.4.10 Reflow, level AA, at 360 and 320 CSS px (the phone view resized, no reload): the page must not
 * scroll sideways. Measured as the page's scroll width against the viewport width, when the page can scroll sideways
 * at all (overflow-x hidden on html or body clips instead). Serious at 360 px (many Android phones), moderate at 320 px
 * only; minor when everything that sticks out is a table or preformatted text (content WCAG lets scroll in two
 * directions). Not judged when the page already scrolls sideways at 390 px (that finding covers it) or has no viewport
 * meta tag that sets the width.
 */
export function judgeReflow(at360: unknown, at320: unknown, viewport: string | null, overflowAt390: boolean): RawFinding | null {
  if (overflowAt390 || !viewportOk(viewport)) return null;
  const runs = [parseReflow(at360, 360), parseReflow(at320, 320)].filter((r): r is ReflowAt => r !== null);
  const bad = runs.filter((r) => r.scrollable && r.sw > r.width + 1);
  if (!bad.length) return null;
  const worst = bad[bad.length - 1];
  const culprits = worst.culprits;
  const twoD = culprits.length > 0 && culprits.every((c) => /^(table|pre|code)$/.test(c.tag));
  const severity: Severity = twoD ? "minor" : bad.some((r) => r.width >= 360) ? "serious" : "moderate";
  const widths = bad.map((r) => `at ${r.width} px the page is ${fmt(r.sw)} px wide (${fmt(r.sw - r.width)} px too wide)`).join("; ");
  const sticking = culprits.length ? ` Sticking out at ${worst.width} px: ${culprits.map((c) => `${c.sel} (ends at ${fmt(c.right)} px)`).join(", ")}.` : "";
  return {
    kind: "reflow-overflow",
    selector: culprits[0]?.sel ?? "",
    box: null,
    measured: `${widths.charAt(0).toUpperCase()}${widths.slice(1)}.${sticking}${twoD ? " Only tables or preformatted text stick out, which WCAG lets scroll in two directions." : ""}`,
    detail: { severity, count: 1, widths: bad.map((r) => r.width), examples: culprits.map((c) => c.sel) },
  };
}

// ------------------------------------------------------------------------------------------ images

/** An image is oversized when its file has more than this many times the pixels the screen shows... */
export const OVERSIZE_RATIO = 4;
/** ...and the file is bigger than this (bytes transferred). */
export const OVERSIZE_BYTES = 100 * 1024;
/**
 * The device pixel ratio an image is judged against: the high end of current screens (2 for laptops and desktops, 3 for
 * phones), not the scanner's emulated 1, so an image is flagged only when even a high-density screen would not use it.
 */
export const JUDGE_DPR = { desktop: 2, phone: 3 } as const;

export interface PageImage {
  sel: string;
  src: string;
  natW: number;
  natH: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * Images far bigger than they are shown (Lighthouse's "Properly size images", with a stricter bar): the file has more
 * than 4 times the pixels the image covers at the judged device pixel ratio, and more than 100 KB was transferred for
 * it. SVG and images whose size the browser did not report are skipped. One finding per view, with the images as its
 * instances; moderate when the images transferred more than 1 MB in all, minor otherwise.
 */
export function judgeImages(raw: unknown, bytesOf: (url: string) => { bytes: number; mime: string } | null, dpr: number, view: string): RawFinding | null {
  const seen = new Set<string>();
  const hits: (PageImage & { bytes: number; ratio: number })[] = [];
  for (const v of (Array.isArray(raw) ? raw : []).slice(0, 120)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const img: PageImage = { sel: s0(o.sel), src: s0(o.src, 400), natW: n0(o.natW), natH: n0(o.natH), w: n0(o.w), h: n0(o.h), x: n0(o.x), y: n0(o.y) };
    if (!img.src || seen.has(img.src) || img.w < 8 || img.h < 8 || img.natW < 1 || img.natH < 1) continue;
    const b = bytesOf(img.src);
    if (!b || b.bytes <= OVERSIZE_BYTES || /svg/i.test(b.mime) || /\.svg(?:[?#]|$)/i.test(img.src)) continue;
    const ratio = (img.natW * img.natH) / (img.w * img.h * dpr * dpr);
    if (ratio <= OVERSIZE_RATIO) continue;
    seen.add(img.src);
    hits.push({ ...img, bytes: b.bytes, ratio });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.bytes - a.bytes);
  const top = hits[0];
  const total = hits.reduce((s, h) => s + h.bytes, 0);
  const needW = Math.round(top.w * dpr);
  const needH = Math.round(top.h * dpr);
  return {
    kind: "image-oversized",
    selector: top.sel,
    box: { x: top.x, y: top.y, w: top.w, h: top.h },
    measured: `${plural(hits.length, "image")} on the ${view} view ${hits.length === 1 ? "is" : "are"} over ${OVERSIZE_RATIO} times the pixels a ${dpr}x screen shows (${kb(total)} in all). Largest: ${top.sel}, a ${fmt(top.natW)} by ${fmt(top.natH)} file (${kb(top.bytes)}) shown at ${fmt(top.w)} by ${fmt(top.h)} px, where ${fmt(needW)} by ${fmt(needH)} is enough.`,
    detail: { severity: (total > 1_000_000 ? "moderate" : "minor") satisfies Severity, count: hits.length, bytes: total, examples: hits.slice(0, 5).map((h) => h.sel) },
  };
}

// ------------------------------------------------------------------------------------------ vitals

export interface Shift {
  t: number;
  v: number;
  input: boolean;
  sources: { sel: string; prev: Box | null; cur: Box | null }[];
}

const parseBox = (v: unknown): Box | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { x: n0(o.x), y: n0(o.y), w: n0(o.w), h: n0(o.h) };
};

export function parseShifts(raw: unknown): Shift[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 80).map((s) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    return {
      t: n0(o.t),
      v: Math.max(0, n0(o.v)),
      input: o.input === true,
      sources: (Array.isArray(o.sources) ? o.sources : []).slice(0, 5).map((x) => {
        const y = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
        return { sel: s0(y.sel), prev: parseBox(y.prev), cur: parseBox(y.cur) };
      }),
    };
  });
}

/**
 * Cumulative Layout Shift as web.dev defines it: shifts without recent input, grouped in session windows (a gap of at
 * most 1 s between shifts, at most 5 s per window); the largest window's sum.
 */
export function clsOf(shifts: readonly Shift[]): { value: number; largest: Shift | null } {
  let best = 0;
  let cur = 0;
  let start = -Infinity;
  let prev = -Infinity;
  let largest: Shift | null = null;
  for (const s of [...shifts].filter((x) => !x.input).sort((a, b) => a.t - b.t)) {
    if (s.t - prev > 1000 || s.t - start > 5000) {
      cur = 0;
      start = s.t;
    }
    cur += s.v;
    prev = s.t;
    if (cur > best) best = cur;
    if (!largest || s.v > largest.v) largest = s;
  }
  return { value: Math.round(best * 10000) / 10000, largest };
}

/** web.dev's thresholds. */
export const LCP_GOOD_MS = 2500;
export const LCP_POOR_MS = 4000;
export const CLS_GOOD = 0.1;
export const CLS_POOR = 0.25;
/** What every timing finding says about where it was measured. */
export const TIMING_NOTE = "Measured once in Cloudflare's browser in a data center, so the time is indicative: a visitor's device and network can be faster or slower.";

/** Largest Contentful Paint on the desktop view: moderate above 4 s (web.dev: poor), minor above 2.5 s (needs improvement). */
export function judgeLcp(raw: unknown): RawFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const t = n0(o.t);
  if (t <= LCP_GOOD_MS) return null;
  const poor = t > LCP_POOR_MS;
  const el = s0(o.sel);
  return {
    kind: "lcp-slow",
    selector: el,
    box: null,
    measured: `Largest Contentful Paint at ${secs(t)}${el ? ` (${el})` : ""} on the desktop view: ${poor ? "poor (above 4 s)" : "needs improvement (above 2.5 s)"}. ${TIMING_NOTE}`,
    detail: { severity: (poor ? "moderate" : "minor") satisfies Severity, count: 1, ms: t },
  };
}

/**
 * Cumulative Layout Shift while the desktop view loaded (until the network was quiet, before the scanner pressed a key
 * or scrolled): moderate above 0.25 (poor), minor above 0.1 (needs improvement).
 */
export function judgeCls(raw: unknown): RawFinding | null {
  const { value, largest } = clsOf(parseShifts(raw));
  if (value <= CLS_GOOD) return null;
  const poor = value > CLS_POOR;
  const moved = largest?.sources.find((s) => s.sel)?.sel ?? "";
  return {
    kind: "cls-high",
    selector: moved,
    box: null,
    measured: `Cumulative Layout Shift ${value.toFixed(2)} while the desktop view loaded: ${poor ? "poor (above 0.25)" : "needs improvement (above 0.1)"}.${largest ? ` Largest shift ${largest.v.toFixed(2)} at ${secs(largest.t)}${moved ? `, moving ${moved}` : ""}.` : ""}`,
    detail: { severity: (poor ? "moderate" : "minor") satisfies Severity, count: 1, cls: value },
  };
}

/**
 * Images without width and height (or aspect-ratio, as attributes or inline style) whose box follows the file's shape,
 * tied to a layout shift they caused: the image finished loading after the first paint (before it, its size was known
 * at the first layout), and a shift without input, from 50 ms before to 500 ms after that, moved down an element that
 * was at or below the image's top and overlaps it horizontally. Images that shifted nothing are not reported. Always
 * minor: the defect is the missing dimensions; how far the page moved in the scanner's browser is listed, not used,
 * since shifts there run larger than for most visitors (report.ts SHIFT_NOTE). Measured in calibration: a logo sized by
 * inline style that loaded before the first paint was tied to a shift 660 ms later that something else caused.
 */
export const UNSIZED_WINDOW_MS = 500;
export function judgeUnsized(rawImages: unknown, rawShifts: unknown, firstPaint: unknown = null): RawFinding | null {
  const shifts = parseShifts(rawShifts).filter((s) => !s.input);
  const painted = typeof firstPaint === "number" && Number.isFinite(firstPaint) ? firstPaint : 0;
  const hits: { sel: string; box: Box; end: number; shift: Shift; moved: string }[] = [];
  const used = new Set<Shift>();
  for (const v of (Array.isArray(rawImages) ? rawImages : []).slice(0, 40)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (typeof o.end !== "number" || !Number.isFinite(o.end) || o.end <= painted) continue;
    const img = { sel: s0(o.sel), box: { x: n0(o.x), y: n0(o.y), w: n0(o.w), h: n0(o.h) }, end: o.end };
    for (const s of shifts) {
      if (s.t < img.end - 50 || s.t > img.end + UNSIZED_WINDOW_MS) continue;
      const src = s.sources.find((x) => x.prev && x.cur && x.cur.y > x.prev.y + 1 && x.prev.y >= img.box.y - 4 && x.cur.x < img.box.x + img.box.w && x.cur.x + x.cur.w > img.box.x);
      if (!src) continue;
      hits.push({ ...img, shift: s, moved: src.sel });
      used.add(s);
      break;
    }
  }
  if (!hits.length) return null;
  const total = [...used].reduce((t, s) => t + s.v, 0);
  const h = hits[0];
  return {
    kind: "image-unsized-shift",
    selector: h.sel,
    box: h.box,
    measured: `${plural(hits.length, "image")} without width and height or aspect-ratio moved content when ${hits.length === 1 ? "it" : "they"} loaded (layout shift ${total.toFixed(3)} in all). First: ${h.sel} finished loading at ${secs(h.end)}; a shift of ${h.shift.v.toFixed(3)} at ${secs(h.shift.t)} moved ${h.moved || "the content below it"} down.`,
    detail: { severity: "minor" satisfies Severity, count: hits.length, shift: Math.round(total * 10000) / 10000, examples: hits.slice(0, 5).map((x) => x.sel) },
  };
}

// ============================================================================== scan-score/4: further audits

// ------------------------------------------------------------------------------------------ keyboard focus

/** The first keyboard stops checked for a visible focus indicator, and how many candidates get a real Tab and screenshots. */
export const FOCUS_CHECKED = 40;
export const FOCUS_CONFIRM = 6;
/** Keyboard stops before the main content from which a skip link is expected (best practice). */
export const SKIP_LINK_MIN = 15;

export interface FocusScan {
  stops: number;
  beforeMain: number | null;
  main: string;
  skip: string;
  checked: number;
  changed: number;
  notVisibleMode: number;
  candidates: { i: number; sel: string; lab: string; x: number; y: number; w: number; h: number }[];
  /** For the first stops that changed: the stop and the first property that changed. */
  diffs: string[];
}

/** The "focus" page side's answer, checked. Null when it is not one. */
export function parseFocusScan(raw: unknown): FocusScan | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.stops !== "number") return null;
  return {
    stops: Math.max(0, Math.round(n0(o.stops))),
    beforeMain: typeof o.beforeMain === "number" && Number.isFinite(o.beforeMain) ? Math.max(0, Math.round(o.beforeMain)) : null,
    main: s0(o.main),
    skip: s0(o.skip),
    checked: Math.max(0, Math.round(n0(o.checked))),
    changed: Math.max(0, Math.round(n0(o.changed))),
    notVisibleMode: Math.max(0, Math.round(n0(o.notVisibleMode))),
    candidates: (Array.isArray(o.candidates) ? o.candidates : []).slice(0, 30).map((c) => {
      const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return { i: Math.round(n0(x.i)), sel: s0(x.sel), lab: s0(x.lab, 40), x: n0(x.x), y: n0(x.y), w: n0(x.w), h: n0(x.h) };
    }),
    diffs: (Array.isArray(o.diffs) ? o.diffs : []).slice(0, 12).map((d) => s0(d, 110)),
  };
}

/**
 * WCAG 2.2 SC 2.4.7 Focus Visible, level AA, on the desktop: keyboard stops whose screenshot is the same, pixel for
 * pixel, focused by a real Tab press and not focused (`confirmed`, from the scanner). Only candidates whose computed
 * styles did not change at all when focused by script are screenshotted, and a stop whose pixels changed in any way
 * (an outline, a colour, an animation nearby) counts as visible, so a finding needs both measurements to agree.
 */
export function judgeFocus(scan: FocusScan | null, confirmed: readonly FocusScan["candidates"][number][]): RawFinding | null {
  if (!scan || !confirmed.length) return null;
  const first = confirmed[0];
  const name = (c: { sel: string; lab: string }) => (c.lab ? `${c.sel} ("${c.lab}")` : c.sel);
  return {
    kind: "focus-invisible",
    selector: first.sel,
    box: { x: first.x, y: first.y, w: first.w, h: first.h },
    measured: `${plural(confirmed.length, "keyboard stop")} of the first ${fmt(scan.checked)} on the desktop ${confirmed.length === 1 ? "shows" : "show"} no visible change when reached with Tab: the screenshot with focus is identical to the one without. First: ${name(first)}.`,
    detail: { severity: "serious" satisfies Severity, count: confirmed.length, checked: scan.checked, examples: confirmed.slice(0, 5).map(name) },
  };
}

/**
 * No skip link (WCAG technique G1) when a keyboard user must pass SKIP_LINK_MIN or more stops before the main content
 * (the first main landmark, else the first h1) and none of the first three focusable elements (hidden-until-focused
 * ones included) links to the content or says it skips to it. A best practice: landmarks can meet SC 2.4.1 for screen reader users,
 * but not for sighted keyboard users. Minor.
 */
export function judgeSkipLink(scan: FocusScan | null): RawFinding | null {
  if (!scan || scan.skip || scan.beforeMain === null || scan.beforeMain < SKIP_LINK_MIN) return null;
  return {
    kind: "skip-link-missing",
    selector: scan.main,
    box: null,
    measured: `${fmt(scan.beforeMain)} keyboard stops come before the main content (${scan.main || "the first heading"}) on the desktop, and none of the first three is a link to it.`,
    detail: { severity: "minor" satisfies Severity, count: 1, before: scan.beforeMain },
  };
}

// ------------------------------------------------------------------------------------------ tablet

/** The tablet width the light phone is widened to after the reflow check (a portrait tablet). */
export const TABLET_WIDTH = 768;

/**
 * Sideways scrolling on a 768 px tablet (the light phone widened, no reload): the page's scroll width beyond the
 * viewport, when it can scroll sideways. Moderate; minor when only tables or preformatted text stick out. Not judged
 * without a viewport meta tag that sets the width.
 */
export function judgeTablet(at768: unknown, viewport: string | null): RawFinding | null {
  if (!viewportOk(viewport)) return null;
  const r = parseReflow(at768, TABLET_WIDTH);
  if (!r || !r.scrollable || r.sw <= r.width + 1 || r.width < 700) return null;
  const twoD = r.culprits.length > 0 && r.culprits.every((c) => /^(table|pre|code)$/.test(c.tag));
  return {
    kind: "tablet-overflow",
    selector: r.culprits[0]?.sel ?? "",
    box: null,
    measured: `At ${r.width} px the page is ${fmt(r.sw)} px wide (${fmt(r.sw - r.width)} px too wide).${r.culprits.length ? ` Sticking out: ${r.culprits.map((c) => `${c.sel} (ends at ${fmt(c.right)} px)`).join(", ")}.` : ""}`,
    detail: { severity: (twoD ? "minor" : "moderate") satisfies Severity, count: 1, examples: r.culprits.map((c) => c.sel) },
  };
}

// ------------------------------------------------------------------------------------------ speed

/** Lighthouse's total-byte-weight curve: 90 points at 2,667 KiB, 50 at 4,000 KiB. */
export const WEIGHT_MINOR = 2667 * 1024;
export const WEIGHT_MODERATE = 4000 * 1024;

/** Everything the light phone view downloaded until its network went quiet: minor above 2,667 KiB, moderate above 4,000 KiB. */
export function judgePageWeight(bytes: number, requests: number): RawFinding | null {
  if (!(bytes > WEIGHT_MINOR)) return null;
  const heavy = bytes > WEIGHT_MODERATE;
  return {
    kind: "page-weight",
    selector: "",
    box: null,
    measured: `The phone view downloaded ${kb(bytes)} in ${plural(requests, "request")} before its network went quiet (compressed, as transferred): above Lighthouse's ${heavy ? "4,000 KiB (a score of 50)" : "2,667 KiB (a score of 90)"}.`,
    detail: { severity: (heavy ? "moderate" : "minor") satisfies Severity, count: 1, bytes, requests },
  };
}

/** An image in an older format is reported when more than this many bytes were transferred for it. */
export const FORMAT_BYTES = 100 * 1024;

/**
 * Images on the page served as JPEG, PNG, GIF or BMP with more than 100 KB transferred (Lighthouse's "Serve images in modern
 * formats"; the browser asked for AVIF and WebP in its Accept header). One finding per view, the images as instances.
 * Minor.
 */
export function judgeImageFormat(raw: unknown, bytesOf: (url: string) => { bytes: number; mime: string } | null, view: string): RawFinding | null {
  const seen = new Set<string>();
  const hits: { sel: string; src: string; bytes: number; mime: string; box: Box }[] = [];
  for (const v of (Array.isArray(raw) ? raw : []).slice(0, 120)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const src = s0(o.src, 400);
    if (!src || seen.has(src)) continue;
    const b = bytesOf(src);
    if (!b || b.bytes <= FORMAT_BYTES || !/^image\/(jpeg|jpg|png|gif|bmp|x-ms-bmp|tiff)$/i.test(b.mime.trim())) continue;
    seen.add(src);
    hits.push({ sel: s0(o.sel), src, bytes: b.bytes, mime: b.mime.toLowerCase().replace("image/", "").toUpperCase(), box: { x: n0(o.x), y: n0(o.y), w: n0(o.w), h: n0(o.h) } });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.bytes - a.bytes);
  const top = hits[0];
  const total = hits.reduce((s, h) => s + h.bytes, 0);
  return {
    kind: "image-format",
    selector: top.sel,
    box: top.box,
    measured: `${plural(hits.length, "image")} on the ${view} view ${hits.length === 1 ? "is" : "are"} JPEG, PNG, GIF or BMP over 100 KB (${kb(total)} in all). Largest: ${shortUrl(top.src)} (${top.mime}, ${kb(top.bytes)}), shown by ${top.sel.slice(0, 50)}.`,
    detail: { severity: "minor" satisfies Severity, count: hits.length, bytes: total, examples: hits.slice(0, 5).map((h) => h.sel) },
  };
}

const shortUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 110);
  } catch {
    return u.slice(0, 110);
  }
};

/** Icon fonts: font-display: block is the advice for them (no text flashes as a ligature name), so they are left out. */
const ICON_FONT = /icon|awesome|glyph|symbol|material|fontello|ionicons|dashicons|lucide|feather|bootstrap-icons|remixicon|tabler|icomoon|icofont|entypo|typicons|octicons|socicon|linearicons|simple-line/i;

/**
 * Web fonts that loaded with font-display auto or block (Lighthouse's "Ensure text remains visible during webfont
 * load"): text in them is invisible for up to 3 s while they load. Icon fonts are left out. Minor.
 */
export function judgeFontDisplay(raw: unknown, view: string): RawFinding | null {
  const families = new Map<string, string>();
  for (const v of (Array.isArray(raw) ? raw : []).slice(0, 60)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const family = s0(o.family, 60).trim();
    const display = s0(o.display, 20).trim().toLowerCase();
    if (!family || ICON_FONT.test(family) || (display !== "auto" && display !== "block")) continue;
    if (!families.has(family)) families.set(family, display);
  }
  if (!families.size) return null;
  const list = [...families.entries()];
  return {
    kind: "font-display",
    selector: "",
    box: null,
    measured: `${plural(list.length, "web font family", "web font families")} on the ${view} view loaded with font-display ${list.every(([, d]) => d === "block") ? "block" : "auto (not set)"}: ${list.slice(0, 4).map(([f, d]) => `${f} (${d})`).join(", ")}${list.length > 4 ? " and more" : ""}.`,
    detail: { severity: "minor" satisfies Severity, count: list.length, examples: list.slice(0, 5).map(([f]) => f) },
  };
}
