// The built-in visual checks, injected into the scanned page and called as window[<per-scan name>](options) -> result.
//
// This is the minimal subset the scanner ships while the GenClass visual checks (packages/runtime/src/visual, branch
// wave2/visual) are not built yet; a built chunk from there, when present, defines __genclassScanChecks while the
// installer runs, and then this one is not used (installChecksSource). The scanner never calls a function the page
// itself defined: it runs the installer in an isolated world when the browser offers one, and installs under a random,
// non-writable name either way. Interface of a chunk (also docs in scan-worker/README.md):
//
//   window.__genclassScanChecks({ view, phone, failedImages, max }) -> { findings: RawFinding[], notes: string[], page }
//   window.__genclassScanFixes?(findings) -> { applied: { kind, selector, how }[] }   (optional; the visual chunk only)
//
// RULES: scanChecks is serialised with Function.prototype.toString and run in the page, so it must be
// self-contained (no imports, no outer variables, no TypeScript-only runtime features) and must not change the page
// beyond scrolling it (it scrolls in bands to hit-test what is drawn, then scrolls back to the top). It reads the
// DOM through `any` because this package type-checks against the Workers runtime, not the DOM.

/* eslint-disable @typescript-eslint/no-explicit-any */
export function scanChecks(options?: any): any {
  const o = options || {};
  const g: any = globalThis as any;
  const doc: any = g.document;
  const MAX = typeof o.max === "number" ? o.max : 12;
  const t0 = g.performance ? g.performance.now() : 0;
  const notes: string[] = [];
  const findings: any[] = [];

  // ---------------------------------------------------------------------------------------------- helpers
  // computed colours come back as rgb()/rgba(), color(srgb ...), or (Tailwind 4 and friends) lab()/oklch(): those go
  // through a 1x1 canvas, which converts any CSS colour to sRGB. No canvas (tests): unknown spaces give null.
  const colourCache: Record<string, number[] | null> = {};
  let ctx2d: any = null;
  const viaCanvas = (c: string): number[] | null => {
    if (c in colourCache) return colourCache[c];
    let out: number[] | null = null;
    try {
      if (!ctx2d && g.document) {
        const cv = g.document.createElement("canvas");
        cv.width = 1;
        cv.height = 1;
        ctx2d = cv.getContext("2d", { willReadFrequently: true });
      }
      if (ctx2d) {
        ctx2d.clearRect(0, 0, 1, 1);
        ctx2d.fillStyle = "rgba(0, 0, 0, 0)";
        ctx2d.fillStyle = c;
        ctx2d.fillRect(0, 0, 1, 1);
        const d = ctx2d.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
      }
    } catch (e) {
      out = null;
    }
    colourCache[c] = out;
    return out;
  };
  const parseColor = (c: string): number[] | null => {
    if (!c) return null;
    if (c === "transparent") return [0, 0, 0, 0];
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c);
    if (!m) m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(c);
    if (!m) return /^(lab|lch|oklab|oklch|hwb|hsl|color)\(/.test(c) ? viaCanvas(c) : null;
    const scale = c.startsWith("color(") ? 255 : 1;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [parseFloat(m[1]) * scale, parseFloat(m[2]) * scale, parseFloat(m[3]) * scale, a];
  };
  const blend = (top: number[], bottom: number[]): number[] => {
    const a = top[3];
    return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
  };
  const lum = (c: number[]): number => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]): number => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const hex = (c: number[]): string =>
    "#" + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const leakIn = (text: string): string | null => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return null;
    let m = /\[object Object\]/.exec(t);
    if (!m) m = /\{\{\s*[\w$.[\]'"| :()-]{1,60}?\s*\}\}/.exec(t);
    if (!m && t.length <= 200) m = /(?:^|[^\w])(NaN)(?:[^\w]|$)/.exec(t);
    if (!m && t.length <= 40) m = /(?:^|[^\w-])(undefined)(?:[^\w-]|$)/.exec(t);
    if (!m) return null;
    const at = Math.max(0, m.index - 20);
    return t.slice(at, at + 60);
  };
  if (o.helpersOnly) return { parseColor, blend, lum, ratio, hex, leakIn };

  const win = g;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const cssEsc = (s: string) => (g.CSS && g.CSS.escape ? g.CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const cleanClass = (c: string) => /^[A-Za-z][\w-]{0,30}$/.test(c) && !/\d{3,}|^css-|^sc-|^jsx-|^_|__[a-z0-9]{5,}$/i.test(c);
  const selectorOf = (el: any): string => {
    if (!el || el.nodeType !== 1) return "";
    const parts: string[] = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
      const tag = String(cur.tagName).toLowerCase();
      if (cur.id && /^[A-Za-z][\w-]{0,40}$/.test(cur.id) && doc.querySelectorAll("#" + cssEsc(cur.id)).length === 1) {
        parts.unshift(tag + "#" + cur.id);
        break;
      }
      let part = tag;
      const classes = String(cur.getAttribute("class") || "").split(/\s+/).filter(cleanClass).slice(0, 2);
      if (classes.length) part += "." + classes.map(cssEsc).join(".");
      const parent = cur.parentElement;
      if (parent && tag !== "body" && tag !== "html") {
        const same = Array.prototype.filter.call(parent.children, (c: any) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      if (tag === "body" || tag === "main" || tag === "header" || tag === "footer" || tag === "nav") break;
      cur = parent;
    }
    const s = parts.join(" > ");
    return s.length > 120 ? s.slice(s.length - 120).replace(/^[^>]*>\s*/, "") : s;
  };
  const docBox = (r: any) => ({ x: Math.round(r.left + win.scrollX), y: Math.round(r.top + win.scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const opacityChain = (el: any): number => {
    let op = 1;
    for (let cur = el, i = 0; cur && cur.nodeType === 1 && i < 40; cur = cur.parentElement, i++) op *= parseFloat(win.getComputedStyle(cur).opacity || "1");
    return op;
  };
  const shown = (el: any, r: any): boolean => {
    if (!r || r.width < 2 || r.height < 2) return false;
    const cs = win.getComputedStyle(el);
    if (cs.visibility !== "visible" || cs.display === "none") return false;
    if (r.right < 0 || r.bottom + win.scrollY < 0 || r.left > Math.max(vw, doc.documentElement.scrollWidth)) return false;
    return opacityChain(el) > 0.1;
  };
  const shortUrl = (u: string) => {
    try {
      const x = new URL(u, win.location.href);
      const same = x.origin === win.location.origin;
      const s = (same ? "" : x.host) + x.pathname;
      return s.length > 90 ? s.slice(0, 44) + "..." + s.slice(-40) : s;
    } catch (e) {
      return String(u).slice(0, 90);
    }
  };
  const push = (kind: string, el: any, rect: any, measured: string, detail: any) => {
    if (findings.filter((f) => f.kind === kind).length >= MAX) return false;
    findings.push({ kind, selector: el ? selectorOf(el) : "", box: rect ? docBox(rect) : null, measured, detail: detail || {} });
    return true;
  };

  // ---------------------------------------------------------------------------------------- broken images
  const failed: string[] = Array.isArray(o.failedImages) ? o.failedImages : [];
  for (const img of Array.prototype.slice.call(doc.images, 0, 2000)) {
    const src = img.currentSrc || img.src || "";
    if (!src || !img.complete) continue;
    if (img.naturalWidth > 0) continue;
    const isSvg = /\.svg(\?|#|$)/i.test(src) || /^data:image\/svg/i.test(src);
    if (isSvg && failed.indexOf(src) < 0) continue; // an SVG with no intrinsic size reports 0 too
    const r = img.getBoundingClientRect();
    if (!shown(img, r)) continue;
    push("broken-image", img, r, failed.indexOf(src) >= 0 ? "Failed to load " + shortUrl(src) : "Loaded with no image data: " + shortUrl(src), { src: shortUrl(src) });
  }

  // ----------------------------------------------------------------------------------------- failed fonts
  try {
    const seen: Record<string, boolean> = {};
    doc.fonts.forEach((f: any) => {
      if (f.status === "error" && !seen[f.family]) {
        seen[f.family] = true;
        push("failed-font", null, null, "Font " + String(f.family).replace(/["']/g, "") + " " + (f.weight || "") + " failed to load", { family: String(f.family).replace(/["']/g, "") });
      }
    });
  } catch (e) {
    notes.push("Could not read document.fonts.");
  }

  // ---------------------------------------------------------------------------- text: leaks and contrast
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SAMP|VAR|TEMPLATE|SVG|MATH|OPTION|SELECT)$/;
  const textEls: any[] = [];
  const seenEl = new Set();
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(), count = 0; n && count < 8000 && textEls.length < 4000; n = walker.nextNode(), count++) {
    const t = n.nodeValue;
    if (!t || !/\S/.test(t)) continue;
    const el = n.parentElement;
    if (!el || seenEl.has(el)) continue;
    let excluded = false;
    for (let cur = el, i = 0; cur && i < 30; cur = cur.parentElement, i++) {
      if (SKIP.test(String(cur.tagName).toUpperCase()) || cur.isContentEditable || cur.getAttribute("aria-hidden") === "true") {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;
    seenEl.add(el);
    textEls.push({ el, node: n });
  }

  // template leaks: on the element's own text
  for (const { el } of textEls) {
    const own = Array.prototype.filter.call(el.childNodes, (c: any) => c.nodeType === 3).map((c: any) => c.nodeValue).join(" ");
    const leak = leakIn(own);
    if (!leak) continue;
    const r = el.getBoundingClientRect();
    if (!shown(el, r)) continue;
    push("template-leak", el, r, '"' + leak + '"', { text: leak });
  }

  // contrast: hit-test each text box in bands of one viewport, top to bottom, over the captured height
  const canvas = (() => {
    const scheme = String(win.getComputedStyle(doc.documentElement).colorScheme || "normal");
    const dark = win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches;
    return (scheme.indexOf("dark") >= 0 && (dark || scheme.indexOf("light") < 0)) ? [18, 18, 18, 1] : [255, 255, 255, 1];
  })();
  const MEDIA = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|OBJECT|EMBED|PICTURE)$/;
  const skips: Record<string, number> = {};
  const skip = (why: string) => {
    skips[why] = (skips[why] || 0) + 1;
  };
  // the solid colour behind a point, composited from the stack under it, or null (with the reason tallied) when it is
  // not a solid known colour: an image, a gradient, video, a blend mode, or something covering the text
  const backgroundAt = (el: any, x: number, y: number): number[] | null => {
    const stack: any[] = doc.elementsFromPoint(x, y) || [];
    let i = stack.indexOf(el);
    if (i < 0) {
      for (let cur = el.parentElement; cur && i < 0; cur = cur.parentElement) i = stack.indexOf(cur);
      if (i < 0) return (skip("not-hit"), null);
    } else {
      // anything above the text that is not its ancestor covers it: not a contrast question
      for (let k = 0; k < i; k++) if (!stack[k].contains(el) && !el.contains(stack[k])) return (skip("covered"), null);
    }
    const layers: number[][] = [];
    for (let k = i; k < stack.length; k++) {
      const e = stack[k];
      const tag = String(e.tagName).toUpperCase();
      if (e !== el && MEDIA.test(tag)) return (skip("over-media"), null);
      const cs = win.getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return (skip("over-image-or-gradient"), null);
      if (cs.backdropFilter && cs.backdropFilter !== "none") return (skip("backdrop-filter"), null);
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return (skip("blend-mode"), null);
      const c = parseColor(cs.backgroundColor);
      if (!c) return (skip("colour-space"), null);
      if (c[3] > 0) {
        const op = parseFloat(cs.opacity || "1");
        layers.push([c[0], c[1], c[2], c[3] * op]);
        if (c[3] * op >= 0.999) break;
      }
    }
    let bg = canvas;
    for (let k = layers.length - 1; k >= 0; k--) bg = blend(layers[k], bg);
    return bg;
  };
  const contrastSeen: Record<string, any> = {};
  const capH = typeof o.captureHeight === "number" ? o.captureHeight : vh * 3;
  const docH = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
  const bands = Math.max(1, Math.min(6, Math.ceil(Math.min(docH, capH) / vh)));
  let checkedText = 0;
  const done = new Set();
  for (let b = 0; b < bands; b++) {
    win.scrollTo(0, b * vh);
    for (const { el, node } of textEls) {
      if (done.has(el)) continue;
      let r: any;
      try {
        const range = doc.createRange();
        range.selectNodeContents(node);
        r = range.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      if (!r || r.width < 2 || r.height < 2) continue;
      const cx = r.left + Math.min(r.width, vw) / 2;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy >= vh || cx < 0 || cx >= vw) continue;
      done.add(el);
      const cs = win.getComputedStyle(el);
      if (cs.visibility !== "visible") { skip("hidden"); continue; }
      if (String(node.nodeValue).replace(/\s/g, "").length < 2) { skip("too-short"); continue; }
      if (parseFloat(cs.fontSize) < 6) { skip("tiny"); continue; }
      if (cs.textShadow && cs.textShadow !== "none") { skip("text-shadow"); continue; }
      if (parseFloat(cs.webkitTextStrokeWidth || "0") > 0) { skip("text-stroke"); continue; }
      if (/text/.test(String(cs.webkitBackgroundClip || "") + String(cs.backgroundClip || ""))) { skip("clipped-background"); continue; }
      if (cs.filter && cs.filter !== "none") { skip("filter"); continue; }
      const fg0 = parseColor(cs.color);
      if (!fg0) { skip("colour-space"); continue; }
      if (fg0[3] < 0.1) { skip("transparent-text"); continue; }
      const op = opacityChain(el);
      if (op <= 0.1) { skip("faded-out"); continue; }
      const bg = backgroundAt(el, cx, cy);
      if (!bg) continue;
      checkedText++;
      const fg = blend([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
      const rt = ratio(fg, bg);
      if (rt >= 1.5) continue;
      const key = hex(fg) + hex(bg) + String(el.tagName) + String(el.getAttribute("class") || "");
      if (contrastSeen[key]) {
        contrastSeen[key].detail.count++;
        continue;
      }
      const sample = String(node.nodeValue).replace(/\s+/g, " ").trim().slice(0, 40);
      if (push("low-contrast", el, r, "Contrast " + (Math.round(rt * 100) / 100).toFixed(2) + ":1 (" + hex(fg) + " on " + hex(bg) + "), " + Math.round(parseFloat(cs.fontSize)) + " px text", { fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round), ratio: Math.round(rt * 100) / 100, fontSize: Math.round(parseFloat(cs.fontSize)), sample, count: 1 })) {
        contrastSeen[key] = findings[findings.length - 1];
      }
    }
  }
  win.scrollTo(0, 0);

  // ------------------------------------------------------------------------------- horizontal overflow
  // with a viewport meta tag the page should fit the device width; Chrome's mobile emulation zooms a wider page out
  // (innerWidth grows), so the device width is the yardstick. Without the tag the layout is 980 px by design.
  if (o.phone) {
    const hasMeta = !!doc.querySelector('meta[name="viewport" i]');
    const fit = hasMeta && typeof o.deviceWidth === "number" ? o.deviceWidth : vw;
    const before = win.scrollX;
    win.scrollTo(100000, 0);
    const slid = win.scrollX;
    win.scrollTo(before, 0);
    const docW = doc.documentElement.scrollWidth;
    if (slid > 0 || docW > fit + 1) {
      const clipsX = (el: any): boolean => {
        for (let cur = el.parentElement; cur && cur !== doc.body && cur !== doc.documentElement; cur = cur.parentElement) {
          const ox = win.getComputedStyle(cur).overflowX;
          if (ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll") return true;
        }
        return false;
      };
      const offenders: any[] = [];
      const all = doc.body ? doc.body.getElementsByTagName("*") : [];
      for (let k = 0; k < all.length && k < 6000; k++) {
        const el = all[k];
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.right <= fit + 1) continue;
        const cs = win.getComputedStyle(el);
        if (cs.position === "fixed" || cs.visibility !== "visible") continue;
        const pr = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
        if (pr && pr.right > fit + 1 && el.parentElement !== doc.body) continue; // the parent already overflows
        if (clipsX(el)) continue;
        offenders.push({ el, r });
      }
      offenders.sort((a, b) => b.r.right - a.r.right);
      const top = offenders[0];
      push(
        "horizontal-overflow",
        top ? top.el : null,
        top ? top.r : null,
        "Page is " + docW + " px wide on a " + fit + " px screen" + (top ? "; the widest element reaches " + Math.round(top.r.right) + " px" : ""),
        { docWidth: docW, viewport: fit, tag: top ? String(top.el.tagName).toLowerCase() : "", others: offenders.slice(1, 4).map((x) => selectorOf(x.el)) },
      );
    }
  }

  // ---------------------------------------------------------------------------------- covered controls
  win.scrollTo(0, 0);
  const CONTROLS = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem]";
  const CONSENT = /cookie|consent|gdpr|onetrust|cookiebot|truste|didomi|usercentrics|cmp|privacy/i;
  const covers: any[] = [];
  let skippedDialog = 0;
  const controls = doc.querySelectorAll(CONTROLS);
  for (let k = 0; k < controls.length && k < 3000; k++) {
    const el = controls[k];
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
    const cs = win.getComputedStyle(el);
    if (cs.visibility !== "visible" || cs.pointerEvents === "none" || opacityChain(el) <= 0.1) continue;
    const hit = doc.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    const label = hit.closest ? hit.closest("label") : null;
    if (label && (label.control === el || label.contains(el))) continue;
    // the covering layer: the highest ancestor of the hit element that does not contain the control
    let layer = hit;
    while (layer.parentElement && !layer.parentElement.contains(el) && layer.parentElement !== doc.body) layer = layer.parentElement;
    let dialog = false;
    for (let cur = hit; cur && cur !== doc.body; cur = cur.parentElement) {
      const role = cur.getAttribute && cur.getAttribute("role");
      if (String(cur.tagName) === "DIALOG" || role === "dialog" || role === "alertdialog" || (cur.getAttribute && cur.getAttribute("aria-modal") === "true") || CONSENT.test(String(cur.id || "") + " " + String(cur.getAttribute && cur.getAttribute("class") || ""))) {
        dialog = true;
        break;
      }
    }
    if (dialog) {
      skippedDialog++;
      continue;
    }
    let entry = covers.find((c) => c.layer === layer);
    if (!entry) {
      entry = { layer, hit, first: el, rect: r, cx, cy, controls: [] };
      covers.push(entry);
    }
    entry.controls.push(el);
  }
  for (const c of covers) {
    push(
      "covered-control",
      c.first,
      c.rect,
      "Centre of the control (" + Math.round(c.cx) + ", " + Math.round(c.cy) + ") hits " + selectorOf(c.hit) + (c.controls.length > 1 ? "; " + c.controls.length + " controls covered by the same layer" : ""),
      { cover: selectorOf(c.layer), count: c.controls.length, controls: c.controls.slice(0, 5).map(selectorOf) },
    );
  }
  if (skippedDialog) notes.push(skippedDialog + " controls sat under a dialog or consent banner at load; those are not counted.");

  return {
    findings,
    notes,
    page: {
      viewport: [vw, vh], docWidth: doc.documentElement.scrollWidth, docHeight: docH, textChecked: checkedText, textElements: textEls.length,
      textOutsideCapture: textEls.length - done.size, contrastSkipped: skips, viewportMeta: !!doc.querySelector('meta[name="viewport" i]'),
      ms: Math.round((g.performance ? g.performance.now() : 0) - t0),
    },
  };
}

/**
 * The page-side expression that installs the checks as window[name] (non-writable, non-configurable) and returns
 * whether visual fixes are installed as window[name + "Fix"]. A page cannot supply its own results or fixes: a
 * function the page defined before the installer ran is never used, under the chunk's names or any other. A built
 * visual chunk (`visualSource`) runs inside the installer, and its functions are taken only when it defined them
 * itself as plain properties; otherwise the built-in subset is installed.
 */
export function installChecksSource(name: string, visualSource: string | null = null): string {
  const chunk = visualSource
    ? `const free = (k) => { const d = Object.getOwnPropertyDescriptor(window, k); return !d || ("value" in d && d.writable && d.configurable); };
  let own = free("__genclassScanChecks") && free("__genclassScanFixes");
  if (own) { try { delete window.__genclassScanChecks; delete window.__genclassScanFixes; } catch (e) { own = false; } }
  if (own) {
    try {
${visualSource}
    } catch (e) { own = false; }
  }
  const took = (k) => { const d = Object.getOwnPropertyDescriptor(window, k); return own && d && "value" in d && typeof d.value === "function" ? d.value : null; };
  checks = took("__genclassScanChecks");
  fixes = checks ? took("__genclassScanFixes") : null;
`
    : "";
  return `(() => { const __name = (t) => t; let checks = null, fixes = null;
  ${chunk}const def = (k, v) => { if (!Object.getOwnPropertyDescriptor(window, k)) Object.defineProperty(window, k, { value: v, writable: false, configurable: false, enumerable: false }); };
  def(${JSON.stringify(name)}, checks || ${scanChecks.toString()});
  if (fixes) def(${JSON.stringify(`${name}Fix`)}, fixes);
  return !!fixes; })()`;
}
