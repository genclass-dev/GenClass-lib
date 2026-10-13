// In-page feature extractor for the visual crawl (vision/README.md has the row schema). A classic script with no
// imports: crawl.mjs evaluates it in the page (page.evaluate, which CSP does not block), and test/extract.test.mjs
// loads it into a Node vm context to test the pure parts with fixtures, no browser needed.
//
// It defines globalThis.__visionLib (pure helpers) and globalThis.__visionExtract(opts), which returns
// { v, page, rows, cost }: page-level facts, one row per rendered element (visible ones first when capped), and the
// time each phase took. Everything here is what a browser runtime can compute cheaply from the DOM: computed
// styles, layout boxes, CSSOM reads, a few hit tests per target. It never reads pixels.
//
// Invariants:
// - Read-only: it changes nothing in the page (no inserted probes, no scrolling, no focus, no events).
// - No page text leaves the page: rows carry text lengths, leak-pattern ids and the matched characters of a leak
//   (at most 24 per match), never the text itself. No attribute values except data-bench-fault labels, role and
//   tag names, colour values, font family names and the class of an image URL (same-origin, cross-origin, data,
//   placeholder host), never the URL.
// - Bounded: rows are capped (opts.maxRows), hit tests and paint-stack reads are capped per page, and the CSS
//   variable pass checks at most opts.maxVarRules rules that use var().
// - Approximations, stated so the training side can weigh them: the clip rect treats absolutely positioned
//   elements like in-flow ones (a non-positioned overflow ancestor clips them here, not in the browser); the
//   ancestor-chain background ignores positioned layers painted behind an element (the paint-stack read covers
//   text in the viewport); the var() pass ignores the cascade (a later rule may override the declaration).

(function (root) {
  "use strict";

  const VERSION = "vision-extract-1";

  // ---------------------------------------------------------------- colour (CSS Color 4, as VISUAL.md 2.5)

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  function encode(c) {
    const a = Math.abs(c);
    return a <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
  }
  function decode(c) {
    const a = Math.abs(c);
    return a <= 0.04045 ? c / 12.92 : Math.sign(c) * Math.pow((a + 0.055) / 1.055, 2.4);
  }
  function mul(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  const XYZ65_TO_LSRGB = [3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796, 1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652, 1.0569715142428786];
  const D50_TO_D65 = [0.955473421488075, -0.02309845494876471, 0.06325924320057072, -0.0283697093338637, 1.0099953980813041, 0.021041441191917323, 0.012314014864481998, -0.020507649298898964, 1.330365926242124];
  const LP3_TO_XYZ65 = [0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0, 0.04511338185890264, 1.043944368900976];
  const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const fromLinear = (l, alpha) => [clamp01(encode(l[0])) * 255, clamp01(encode(l[1])) * 255, clamp01(encode(l[2])) * 255, clamp01(alpha)];
  function oklabToLinear(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  }
  function labToLinear(L, a, b) {
    const k = 24389 / 27;
    const e = 216 / 24389;
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const xyz50 = [(fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * D50_WHITE[0], (L > k * e ? fy ** 3 : L / k) * D50_WHITE[1], (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * D50_WHITE[2]];
    return mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, xyz50));
  }
  function hslToRgb(h, s, l) {
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }
  function hue(t) {
    const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|grad|turn)?$/i.exec(t);
    if (!m) return t === "none" ? 0 : NaN;
    const v = Number(m[1]);
    const u = (m[2] || "deg").toLowerCase();
    const d = u === "rad" ? (v * 180) / Math.PI : u === "grad" ? v * 0.9 : u === "turn" ? v * 360 : v;
    return ((d % 360) + 360) % 360;
  }
  function num(t, pct) {
    if (t === "none") return 0;
    const m = /^(-?[\d.]+(?:e-?\d+)?)(%)?$/i.exec(t);
    if (!m) return NaN;
    const v = Number(m[1]);
    return m[2] ? (v / 100) * pct : v;
  }
  function hex(s) {
    const h = s.slice(1);
    if (!/^[\da-f]+$/i.test(h) || [3, 4, 6, 8].indexOf(h.length) < 0) return null;
    const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    const n = (i) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }

  /** A computed colour string to [r, g, b] 0..255 and alpha 0..1, or null when it does not parse. */
  function parseColor(input) {
    const s = String(input == null ? "" : input).trim().toLowerCase();
    if (!s) return null;
    if (s === "transparent") return [0, 0, 0, 0];
    if (s === "white") return [255, 255, 255, 1];
    if (s === "black") return [0, 0, 0, 1];
    if (s[0] === "#") return hex(s);
    const m = /^([a-z-]+)\((.*)\)$/.exec(s);
    if (!m) return null;
    const fn = m[1];
    let body = m[2].trim();
    let space = "";
    if (fn === "color") {
      const sp = /^([a-z0-9-]+)\s+(.*)$/.exec(body);
      if (!sp) return null;
      space = sp[1];
      body = sp[2];
    }
    let parts;
    let alphaT;
    if (body.indexOf(",") >= 0) {
      parts = body.split(",").map((x) => x.trim());
      if (parts.length === 4) alphaT = parts.pop();
    } else {
      const sl = body.split("/").map((x) => x.trim());
      parts = sl[0].split(/\s+/).filter(Boolean);
      alphaT = sl[1];
    }
    if (parts.length !== 3) return null;
    const alpha = alphaT === undefined ? 1 : num(alphaT, 1);
    if (!Number.isFinite(alpha)) return null;
    let out = null;
    switch (fn) {
      case "rgb":
      case "rgba": {
        const v = parts.map((p) => num(p, 255));
        out = [Math.min(255, Math.max(0, v[0])), Math.min(255, Math.max(0, v[1])), Math.min(255, Math.max(0, v[2])), clamp01(alpha)];
        break;
      }
      case "hsl":
      case "hsla": {
        const rgb = hslToRgb(hue(parts[0]), clamp01(num(parts[1], 100) / 100), clamp01(num(parts[2], 100) / 100));
        out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
        break;
      }
      case "hwb": {
        const h = hue(parts[0]);
        const w = clamp01(num(parts[1], 100) / 100);
        const bl = clamp01(num(parts[2], 100) / 100);
        if (w + bl >= 1) {
          const g = w / (w + bl);
          out = [g * 255, g * 255, g * 255, clamp01(alpha)];
          break;
        }
        const rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - bl) + w);
        out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
        break;
      }
      case "lab":
        out = fromLinear(labToLinear(num(parts[0], 100), num(parts[1], 125), num(parts[2], 125)), alpha);
        break;
      case "lch": {
        const H = (hue(parts[2]) * Math.PI) / 180;
        const C = num(parts[1], 150);
        out = fromLinear(labToLinear(num(parts[0], 100), C * Math.cos(H), C * Math.sin(H)), alpha);
        break;
      }
      case "oklab":
        out = fromLinear(oklabToLinear(num(parts[0], 1), num(parts[1], 0.4), num(parts[2], 0.4)), alpha);
        break;
      case "oklch": {
        const H = (hue(parts[2]) * Math.PI) / 180;
        const C = num(parts[1], 0.4);
        out = fromLinear(oklabToLinear(num(parts[0], 1), C * Math.cos(H), C * Math.sin(H)), alpha);
        break;
      }
      case "color": {
        const v = parts.map((p) => num(p, 1));
        if (space === "srgb") out = [clamp01(v[0]) * 255, clamp01(v[1]) * 255, clamp01(v[2]) * 255, clamp01(alpha)];
        else if (space === "srgb-linear") out = fromLinear(v, alpha);
        else if (space === "display-p3") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(LP3_TO_XYZ65, [decode(v[0]), decode(v[1]), decode(v[2])])), alpha);
        else if (space === "xyz" || space === "xyz-d65") out = fromLinear(mul(XYZ65_TO_LSRGB, v), alpha);
        else if (space === "xyz-d50") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, v)), alpha);
        else return null;
        break;
      }
      default:
        return null;
    }
    return out && out.every((x) => Number.isFinite(x)) ? out : null;
  }

  /** `top` painted over `bottom` (source-over in sRGB). */
  function over(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    const c = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [c(0), c(1), c(2), a];
  }

  /** WCAG 2.2 relative luminance (alpha ignored). */
  function luminance(c) {
    const v = [c[0], c[1], c[2]].map((x) => decode(x / 255));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }

  /** WCAG 2.2 contrast ratio, truncated to two decimals (as axe-core reports it). */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return Math.floor(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100 + 1e-9) / 100;
  }

  /** Contrast of text colour `fg` (alpha scaled by `opacity`) over an opaque background `bg`. */
  function textContrast(fg, bg, opacity) {
    if (!fg || !bg) return null;
    const a = fg[3] * (opacity == null ? 1 : opacity);
    const shown = over([fg[0], fg[1], fg[2], a], [bg[0], bg[1], bg[2], 1]);
    return contrast(shown, bg);
  }

  /**
   * Resolve a background from layers ordered from the element outwards (or downwards in a paint stack). Each layer:
   * { color: RGBA|null, image: bool, media: bool, filter: bool }. Stops at the first opaque colour; layers before it
   * that carry an image, a replaced element or a filter mark the result unreliable. Returns { rgb, status }, where
   * status is 0 solid, 1 no opaque layer (the canvas `base` was used), 2 image or gradient, 3 replaced element,
   * 4 filter or blend, 5 a colour that did not parse.
   */
  function resolveLayers(layers, base) {
    let status = 0;
    const seen = [];
    let opaque = null;
    for (const l of layers) {
      if (!l.color) {
        status = status || 5;
        continue;
      }
      if (l.image && status === 0) status = 2;
      if (l.media && status === 0) status = 3;
      if (l.filter && status === 0) status = 4;
      if (l.color[3] >= 1) {
        opaque = l.color;
        break;
      }
      if (l.color[3] > 0) seen.push(l.color);
    }
    let acc = opaque;
    if (!acc) {
      acc = base || [255, 255, 255, 1];
      if (status === 0) status = 1;
    }
    for (let i = seen.length - 1; i >= 0; i--) acc = over(seen[i], acc);
    return { rgb: [acc[0], acc[1], acc[2]], status };
  }

  // ---------------------------------------------------------------- text patterns (VISUAL.md 3.9 to 3.11)

  const LEAK_PATTERNS = [
    ["object-object", /\[object Object\]/],
    ["invalid-date", /\bInvalid Date\b/],
    ["mustache", /\{\{\s*[\w.$[\]]+\s*\}\}/],
    ["template-literal", /\$\{\s*[\w.]+\s*\}/],
    ["jinja", /\{%\s*\w+[^%]*%\}/],
    ["erb", /<%=?\s*[\w.]+\s*%>/],
    ["currency-nan", /[$€£¥]\s?(?:NaN|undefined|null)\b|\b(?:NaN|undefined|null)\s?(?:%|px|USD|EUR)(?![\w])/],
    ["nan-time", /\bNaN:NaN\b/],
    ["lorem", /\blorem ipsum\b|\bdolor sit amet\b/i],
    ["mojibake", /â€[™œ“”˜¦–—]|Ã[©¨¢¤¶¼½¡]|Â[©®°]/],
    ["replacement-char", /�/],
    ["double-escaped", /&(?:amp|lt|gt|quot|#39|#x27|nbsp);/],
    ["placeholder-contact", /\b(?:john\.?doe|jane\.?doe|your-?email|you@example|example\.com|\(555\) ?555|555-0\d\d\d|123 Main St)\b/i],
  ];
  const WEAK_VALUES = { undefined: 1, null: 1, NaN: 1 };
  const PLACEHOLDER_HOSTS = ["placehold.co", "via.placeholder.com", "placeholder.com", "dummyimage.com", "picsum.photos", "placekitten.com", "placehold.it", "fakeimg.pl", "loremflickr.com"];

  /** Leak patterns in `text`: [[id, matched chars (max 24)]]. An exact weak value gives "weak-<value>". */
  function scanLeaks(text) {
    const out = [];
    if (!text) return out;
    const t = String(text);
    if (WEAK_VALUES[t.trim()] === 1) out.push(["weak-" + t.trim(), t.trim()]);
    if (t.length < 3) return out;
    for (const p of LEAK_PATTERNS) {
      const m = p[1].exec(t);
      if (m) out.push([p[0], m[0].slice(0, 24)]);
    }
    return out;
  }

  /** Class of an image URL: "data", "blob", "ph" (placeholder host), "same", "cross", "" when empty or bad. */
  function urlClass(url, origin) {
    if (!url) return "";
    if (/^data:/i.test(url)) return "data";
    if (/^blob:/i.test(url)) return "blob";
    let u;
    try {
      u = new URL(url, origin || "http://x.invalid/");
    } catch (e) {
      return "";
    }
    const host = u.hostname.toLowerCase();
    for (const h of PLACEHOLDER_HOSTS) if (host === h || host.endsWith("." + h)) return "ph";
    if (/(^|\.)unsplash\.com$/.test(host)) return "unsplash";
    return origin && u.origin === new URL(origin).origin ? "same" : "cross";
  }

  /** The viewport meta content as flags (VISUAL.md 3.15, catalog #3 and #11). */
  function parseViewportMeta(content) {
    if (content == null) return { present: 0 };
    const o = { present: 1, deviceWidth: 0, fixedWidth: 0, initialScale: null, maxScale: null, userScalableNo: 0 };
    for (const part of String(content).toLowerCase().split(/[,;]/)) {
      const kv = part.split("=").map((x) => x.trim());
      if (kv.length < 2) continue;
      const k = kv[0];
      const v = kv[1];
      if (k === "width") {
        if (v === "device-width") o.deviceWidth = 1;
        else if (/^\d+/.test(v)) o.fixedWidth = parseFloat(v);
      } else if (k === "initial-scale") o.initialScale = parseFloat(v);
      else if (k === "maximum-scale") o.maxScale = parseFloat(v);
      else if (k === "user-scalable") o.userScalableNo = v === "no" || v === "0" ? 1 : 0;
    }
    o.zoomBlocked = o.userScalableNo || (o.maxScale != null && o.maxScale <= 1) ? 1 : 0;
    return o;
  }

  /** var() references in a declaration value: [{name, fallback (string or null)}], fallbacks with nesting kept. */
  function varRefs(value) {
    const out = [];
    const s = String(value);
    let i = 0;
    while ((i = s.indexOf("var(", i)) >= 0) {
      let depth = 0;
      let j = i + 3;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = s.slice(i + 4, j);
      const comma = inner.indexOf(",");
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      if (/^--[\w-]+$/.test(name)) out.push({ name, fallback: comma < 0 ? null : inner.slice(comma + 1).trim() });
      i = i + 4;
    }
    return out;
  }

  /** Replace every var() in `value` by lookup(name) or its fallback; null when a reference cannot resolve. */
  function substituteVars(value, lookup, depth) {
    depth = depth || 0;
    if (depth > 8) return null;
    const s = String(value);
    let out = "";
    let i = 0;
    for (;;) {
      const k = s.indexOf("var(", i);
      if (k < 0) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, k);
      let d = 0;
      let j = k + 3;
      for (; j < s.length; j++) {
        if (s[j] === "(") d++;
        else if (s[j] === ")") {
          d--;
          if (d === 0) break;
        }
      }
      const inner = s.slice(k + 4, j);
      const comma = inner.indexOf(",");
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const v = lookup(name);
      if (v != null && String(v).trim() !== "") out += String(v).trim();
      else if (comma >= 0) {
        const fb = substituteVars(inner.slice(comma + 1).trim(), lookup, depth + 1);
        if (fb == null) return null;
        out += fb;
      } else return null;
      i = j + 1;
    }
    return out;
  }

  /** Split a style rule's cssText body ("a: b; c: d") into [prop, value] pairs (enough for var() scanning). */
  function declarations(cssText) {
    const body = String(cssText);
    const open = body.indexOf("{");
    const close = body.lastIndexOf("}");
    const inner = open >= 0 && close > open ? body.slice(open + 1, close) : body;
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      const ch = inner[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if ((ch === ";" && depth === 0) || i === inner.length) {
        const decl = inner.slice(start, i);
        const c = decl.indexOf(":");
        if (c > 0) out.push([decl.slice(0, c).trim().toLowerCase(), decl.slice(c + 1).replace(/!important\s*$/, "").trim()]);
        start = i + 1;
      }
    }
    return out;
  }

  /** Does this computed style create a stacking context? Returns a short reason or "". */
  function stackingReason(cs, parentDisplay) {
    const pos = cs.position;
    const z = cs.zIndex;
    if ((pos === "fixed" || pos === "sticky")) return "pos";
    if (pos !== "static" && z !== "auto") return "z";
    if (z !== "auto" && /(flex|grid)/.test(parentDisplay || "")) return "z-item";
    if (parseFloat(cs.opacity) < 1) return "opacity";
    if (cs.transform && cs.transform !== "none") return "transform";
    if (cs.filter && cs.filter !== "none") return "filter";
    if (cs.backdropFilter && cs.backdropFilter !== "none") return "backdrop";
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") return "blend";
    if (cs.isolation === "isolate") return "isolation";
    if (cs.clipPath && cs.clipPath !== "none") return "clip-path";
    if (cs.maskImage && cs.maskImage !== "none") return "mask";
    if (/\b(transform|opacity|filter|z-index)\b/.test(cs.willChange || "")) return "will-change";
    if (/\b(paint|layout|strict|content)\b/.test(cs.contain || "")) return "contain";
    return "";
  }

  /** Does this style make the element the containing block for position: fixed descendants? */
  function trapsFixed(cs) {
    return (cs.transform && cs.transform !== "none") || (cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") ||
      (cs.perspective && cs.perspective !== "none") || /\b(paint|layout|strict|content)\b/.test(cs.contain || "") ||
      /\b(transform|filter|perspective)\b/.test(cs.willChange || "") || (cs.containerType && cs.containerType !== "normal") ? true : false;
  }

  /** Intersect two rects {l, t, r, b}. */
  function intersect(a, b) {
    return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
  }
  /** Share of rect `r` (l, t, r, b) inside `clip`, 0..1 (1 for a zero-area rect inside it). */
  function insideShare(r, clip) {
    const w = r.r - r.l;
    const h = r.b - r.t;
    const i = intersect(r, clip);
    const iw = Math.max(0, i.r - i.l);
    const ih = Math.max(0, i.b - i.t);
    if (w <= 0 || h <= 0) return iw >= 0 && ih >= 0 && r.l >= clip.l && r.r <= clip.r && r.t >= clip.t && r.b <= clip.b ? 1 : 0;
    return (iw * ih) / (w * h);
  }

  const OVF = { visible: "v", hidden: "h", clip: "c", auto: "a", scroll: "s", overlay: "a" };
  const POS = { static: "", relative: "r", absolute: "a", fixed: "f", sticky: "s" };
  const OBJECT_FIT = { fill: "", contain: "c", cover: "v", none: "n", "scale-down": "d" };
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, WBR: 1, TITLE: 1, BASE: 1, SOURCE: 1, TRACK: 1, PARAM: 1 };
  const MEDIA = { IMG: 1, PICTURE: 1, VIDEO: 1, CANVAS: 1, SVG: 1, IFRAME: 1, OBJECT: 1, EMBED: 1 };
  const INTERACTIVE_ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, combobox: 1, textbox: 1, slider: 1, spinbutton: 1, searchbox: 1, treeitem: 1 };
  const GENERIC_FAMILIES = { serif: 1, "sans-serif": 1, monospace: 1, cursive: 1, fantasy: 1, "system-ui": 1, "ui-sans-serif": 1, "ui-serif": 1, "ui-monospace": 1, "ui-rounded": 1, "-apple-system": 1, blinkmacsystemfont: 1, emoji: 1, math: 1, fangsong: 1, inherit: 1, initial: 1 };
  const COLOR_PROPS = /(^|-)(color|background|fill|stroke|border|outline|shadow|caret|accent)/;

  /** The implicit ARIA role of an element (the common cases only). */
  function implicitRole(el) {
    const t = el.tagName;
    switch (t) {
      case "A":
      case "AREA":
        return el.hasAttribute("href") ? "link" : "";
      case "BUTTON":
        return "button";
      case "SUMMARY":
        return "button";
      case "SELECT":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "INPUT": {
        const ty = (el.getAttribute("type") || "text").toLowerCase();
        if (ty === "hidden") return "";
        if (ty === "checkbox" || ty === "radio") return ty;
        if (ty === "range") return "slider";
        if (ty === "number") return "spinbutton";
        if (ty === "search") return "searchbox";
        if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
        return "textbox";
      }
      case "IMG":
        return el.getAttribute("alt") === "" ? "presentation" : "img";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "HEADER":
        return "banner";
      case "FOOTER":
        return "contentinfo";
      case "ASIDE":
        return "complementary";
      case "FORM":
        return "form";
      case "DIALOG":
        return "dialog";
      case "UL":
      case "OL":
        return "list";
      case "LI":
        return "listitem";
      case "TABLE":
        return "table";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      default:
        return "";
    }
  }

  const r1 = (x) => Math.round(x * 10) / 10;
  const r2 = (x) => Math.round(x * 100) / 100;
  const rgbOut = (c) => (c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] : null);
  const rgbaOut = (c) => (c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), r2(c[3])] : null);

  /** Rows ranked for the cap: labelled first, then visible in the viewport, then visible, then the rest. */
  function rankForCap(c) {
    if (c.lab) return 0;
    if (c.vis && c.inv > 0) return 1;
    if (c.vis) return 2;
    return 3;
  }

  // ---------------------------------------------------------------- the DOM pass

  function extract(opts) {
    opts = opts || {};
    const maxRows = opts.maxRows || 2500;
    const maxHit = opts.maxHit || 900;
    const maxStack = opts.maxStack || 500;
    const maxVarRules = opts.maxVarRules || 2500;
    const labelAttr = opts.labelAttr || "data-bench-fault";
    const now = () => performance.now();
    const t0 = now();
    const cost = {};
    const doc = document;
    const html = doc.documentElement;
    const body = doc.body;
    const vw = innerWidth;
    const vh = innerHeight;
    const origin = location.origin;
    const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;

    // ---- page level
    const page = { v: VERSION };
    page.vw = vw;
    page.vh = vh;
    page.dpr = devicePixelRatio;
    page.vvScale = visualViewport ? r2(visualViewport.scale) : 1;
    page.scrollW = html.scrollWidth;
    page.scrollH = html.scrollHeight;
    page.clientW = html.clientWidth;
    page.bodyScrollW = body ? body.scrollWidth : 0;
    page.visibility = doc.visibilityState;
    const vm = doc.querySelector('meta[name="viewport" i]');
    page.viewportMeta = parseViewportMeta(vm ? vm.getAttribute("content") : null);
    const htmlCs = getComputedStyle(html);
    const bodyCs = body ? getComputedStyle(body) : null;
    page.colorScheme = htmlCs.colorScheme;
    page.prefersDark = prefersDark ? 1 : 0;
    page.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0;
    page.forcedColors = matchMedia("(forced-colors: active)").matches ? 1 : 0;
    page.appDark = html.classList.contains("dark") || /dark/i.test(html.getAttribute("data-theme") || "") || (body && body.classList.contains("dark")) ? 1 : 0;
    page.htmlBg = rgbaOut(parseColor(htmlCs.backgroundColor));
    page.bodyBg = bodyCs ? rgbaOut(parseColor(bodyCs.backgroundColor)) : null;
    page.bodyColor = bodyCs ? rgbaOut(parseColor(bodyCs.color)) : null;
    page.bodyFont = bodyCs ? String(bodyCs.fontFamily).split(",")[0].replace(/["']/g, "").trim().toLowerCase().slice(0, 40) : "";
    page.bodyFontSize = bodyCs ? parseFloat(bodyCs.fontSize) : 0;
    page.lang = (html.getAttribute("lang") || "").slice(0, 12);
    page.dir = htmlCs.direction;
    page.titleLen = (doc.title || "").length;
    page.bodyOverflowX = bodyCs ? OVF[bodyCs.overflowX] || bodyCs.overflowX : "";
    page.htmlOverflowX = OVF[htmlCs.overflowX] || htmlCs.overflowX;
    page.bodyPointerEvents = bodyCs ? bodyCs.pointerEvents : "";
    page.bodyOverflowY = bodyCs ? OVF[bodyCs.overflowY] || bodyCs.overflowY : "";
    page.htmlOverflowY = OVF[htmlCs.overflowY] || htmlCs.overflowY;
    page.lab = html.getAttribute(labelAttr) || null;
    // canvas colour when nothing is opaque (VISUAL.md 2.4 step 5; Chrome's dark canvas)
    const darkCanvas = prefersDark && /dark/.test(htmlCs.colorScheme || "");
    const canvas = darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];
    const hb = parseColor(htmlCs.backgroundColor);
    const bb = bodyCs ? parseColor(bodyCs.backgroundColor) : null;
    const rootBase = hb && hb[3] > 0 ? over(hb, canvas) : bb && bb[3] > 0 ? over(bb, canvas) : canvas;
    page.canvas = rgbOut(rootBase);

    // fonts
    const fontState = {};
    let fontsN = 0;
    try {
      doc.fonts.forEach((f) => {
        fontsN++;
        const fam = String(f.family).replace(/["']/g, "").trim().toLowerCase();
        const s = fontState[fam] || (fontState[fam] = { loaded: 0, error: 0, loading: 0, unloaded: 0 });
        s[f.status] = (s[f.status] || 0) + 1;
      });
    } catch (e) {
      // document.fonts missing: leave empty
    }
    page.fonts = Object.keys(fontState).slice(0, 30).map((k) => [k.slice(0, 40), fontState[k].loaded, fontState[k].error, fontState[k].loading + fontState[k].unloaded]);
    page.fontFaces = fontsN;
    page.fontsStatus = doc.fonts ? doc.fonts.status : "";
    const famCode = (fam) => {
      const s = fontState[fam];
      if (!s) return GENERIC_FAMILIES[fam] ? "g" : "s";
      if (s.loaded) return "l";
      if (s.error) return "e";
      if (s.loading) return "p";
      return "u";
    };

    // stylesheets and resources
    const sheets = { n: 0, inline: 0, same: 0, cross: 0, unreadable: 0, rules: 0, disabled: 0, linkFailed: 0, links: 0 };
    const readable = [];
    for (const s of Array.from(doc.styleSheets)) {
      sheets.n++;
      if (s.disabled) sheets.disabled++;
      if (!s.href) sheets.inline++;
      else if (urlClass(s.href, origin) === "same") sheets.same++;
      else sheets.cross++;
      try {
        const n = s.cssRules.length;
        sheets.rules += n;
        readable.push(s);
      } catch (e) {
        sheets.unreadable++;
      }
    }
    try {
      // constructed sheets (CSS-in-JS libraries, and the injector's fallback under a strict CSP)
      for (const s of Array.from(doc.adoptedStyleSheets || [])) {
        sheets.adopted = (sheets.adopted || 0) + 1;
        readable.push(s);
      }
    } catch (e) {
      // no adoptedStyleSheets
    }
    for (const l of Array.from(doc.querySelectorAll('link[rel~="stylesheet" i]'))) {
      sheets.links++;
      if (!l.sheet && !l.disabled && !/alternate/i.test(l.rel) && (!l.media || matchMedia(l.media).matches)) sheets.linkFailed++;
    }
    page.sheets = sheets;
    const res = { n: 0, failed: 0, cssFailed: 0, imgFailed: 0, fontFailed: 0, scriptFailed: 0, bytes: 0 };
    try {
      for (const e of performance.getEntriesByType("resource")) {
        res.n++;
        res.bytes += e.transferSize || 0;
        const st = e.responseStatus || 0;
        if (st >= 400) {
          res.failed++;
          const it = e.initiatorType;
          if (it === "link" && /\.css(\?|$)/.test(e.name)) res.cssFailed++;
          else if (it === "css" && /\.(woff2?|ttf|otf)(\?|$)/.test(e.name)) res.fontFailed++;
          else if (it === "img" || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/.test(e.name)) res.imgFailed++;
          else if (it === "script") res.scriptFailed++;
        }
      }
    } catch (e) {
      // no resource timing
    }
    page.res = res;
    // builder fingerprints: ids only (which tool made the page), never URLs
    const fp = [];
    const has = (sel) => {
      try {
        return !!doc.querySelector(sel);
      } catch (e) {
        return false;
      }
    };
    const scriptSrcs = Array.from(doc.scripts).map((s) => s.src || "").join(" ");
    const gen = doc.querySelector('meta[name="generator" i]');
    page.generator = gen ? String(gen.getAttribute("content") || "").slice(0, 40) : "";
    if (/gpteng|lovable/i.test(scriptSrcs) || has("#lovable-badge") || has('a[href*="lovable.dev"]') || has("[data-lov-id]")) fp.push("lovable");
    if (has('a[href*="bolt.new"]') || /bolt\.new/i.test(scriptSrcs)) fp.push("bolt");
    if (/replit/i.test(scriptSrcs) || has('a[href*="replit.com"]')) fp.push("replit");
    if (/base44/i.test(scriptSrcs) || has('a[href*="base44"]')) fp.push("base44");
    if (has('a[href*="manus.im"]') || /manus/i.test(scriptSrcs)) fp.push("manus");
    if (has("[data-v0-t]") || has('a[href*="v0.dev"]') || has('a[href*="v0.app"]')) fp.push("v0");
    if (has("#__next") || has("script#__NEXT_DATA__") || /\/_next\//.test(scriptSrcs)) fp.push("next");
    if (has("#__nuxt")) fp.push("nuxt");
    if (has('script[type="module"][src*="/assets/index-"]')) fp.push("vite");
    if (has("#root")) fp.push("root-div");
    if (has("[data-radix-popper-content-wrapper],[data-radix-collection-item],[data-state]")) fp.push("radix");
    if (/cdn\.tailwindcss\.com/.test(scriptSrcs)) fp.push("tailwind-play-cdn");
    if (has("wix-image,#wix-warmup-data") || /wixstatic|parastorage/.test(scriptSrcs)) fp.push("wix");
    if (has("html[data-wf-page]") || /webflow/.test(scriptSrcs)) fp.push("webflow");
    if (/framerusercontent|framer\.com/.test(scriptSrcs)) fp.push("framer");
    if (has('link[href*="wp-content"],script[src*="wp-content"]')) fp.push("wordpress");
    if (/shopify/.test(scriptSrcs)) fp.push("shopify");
    page.fp = fp;
    // running animations (VISUAL.md 2.3 persistence gate): their targets
    const animated = new Set();
    try {
      for (const a of doc.getAnimations()) if (a.playState === "running" && a.effect && a.effect.target) animated.add(a.effect.target);
    } catch (e) {
      // no Web Animations
    }
    page.animations = animated.size;
    cost.page = r1(now() - t0);

    // ---- walk: every rendered element, with inherited state (effective opacity, background chain, clip rect)
    const t1 = now();
    const state = new Map();
    const cands = [];
    const rootClip = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    const viewport = { l: 0, t: 0, r: vw, b: vh };
    let visited = 0;
    const walker = doc.createTreeWalker(body || html, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (SKIP[n.tagName]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const rootState = { eop: 1, layers: null, ah: 0, an: 0, clip: rootClip, fixedTrap: 0, sc: -1, depth: 0, row: -1, disp: htmlCs.display, details: 0 };
    // the body is a row too; the walker yields its descendants
    let node;
    const visitList = [];
    if (body) visitList.push(body);
    while ((node = walker.nextNode())) visitList.push(node);
    for (const el of visitList) {
      visited++;
      const parent = el.parentElement;
      const ps = (parent && state.get(parent)) || rootState;
      if (ps.none) {
        // inside a display: none subtree: nothing renders; keep a labelled target as a box-less row
        state.set(el, ps);
        if (el.hasAttribute(labelAttr)) cands.push({ el, cs: null, rect: null, ps, st: null, lab: el.getAttribute(labelAttr), vis: 0, why: "display-none", inv: 0 });
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.display === "none") {
        if (el.hasAttribute(labelAttr)) cands.push({ el, cs, rect: null, ps, st: null, lab: el.getAttribute(labelAttr), vis: 0, why: "display-none", inv: 0 });
        state.set(el, { ...ps, none: 1 });
        continue;
      }
      const op = parseFloat(cs.opacity);
      const isSvgChild = el instanceof SVGElement && el.tagName.toLowerCase() !== "svg";
      const bgc = parseColor(cs.backgroundColor);
      const bgImg = cs.backgroundImage && cs.backgroundImage !== "none";
      const filt = (cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.mixBlendMode && cs.mixBlendMode !== "normal");
      const layer = { color: isSvgChild ? [0, 0, 0, 0] : bgc, image: !!bgImg, media: !!MEDIA[el.tagName.toUpperCase()], filter: !!filt };
      // background layers from this element outwards, cut at the first opaque one (bounded)
      let layers;
      if (layer.color && layer.color[3] >= 1) layers = [layer];
      else {
        layers = [layer];
        if (ps.layers) for (let i = 0; i < ps.layers.length && layers.length < 24; i++) layers.push(ps.layers[i]);
      }
      const pos = cs.position;
      let clip = ps.clip;
      if (pos === "fixed" && !ps.fixedTrap) clip = rootClip;
      const rect = el.getBoundingClientRect();
      const ox = cs.overflowX;
      const oy = cs.overflowY;
      const clipsSelf = ox !== "visible" || oy !== "visible" || /\b(paint|strict|content)\b/.test(cs.contain || "");
      let childClip = clip;
      if (clipsSelf) {
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const bbw = parseFloat(cs.borderBottomWidth) || 0;
        const pad = { l: rect.left + bl, t: rect.top + bt, r: rect.right - br, b: rect.bottom - bbw };
        childClip = intersect(clip, { l: ox !== "visible" ? pad.l : -Infinity, r: ox !== "visible" ? pad.r : Infinity, t: oy !== "visible" ? pad.t : -Infinity, b: oy !== "visible" ? pad.b : Infinity });
      }
      const scReason = stackingReason(cs, ps.disp);
      const st = {
        eop: ps.eop * (Number.isFinite(op) ? op : 1),
        layers,
        ah: ps.ah || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert") ? 1 : 0,
        an: ps.an || animated.has(el) ? 1 : 0,
        clip: childClip,
        selfClip: clip,
        fixedTrap: ps.fixedTrap || trapsFixed(cs) ? 1 : 0,
        trappedByAncestor: ps.fixedTrap,
        sc: ps.sc,
        scReason,
        depth: ps.depth + 1,
        disp: cs.display,
        nClipAnc: (ps.nClipAnc || 0) + (clipsSelf ? 1 : 0),
        details: ps.details || (parent && parent.tagName === "DETAILS" && !parent.open && el.tagName !== "SUMMARY") ? 1 : 0,
        row: -1,
      };
      state.set(el, st);
      const area = rect.width * rect.height;
      const lab = el.getAttribute(labelAttr);
      if (area <= 0 && !lab) continue;
      // VISUAL.md 2.1 visible(), plus the reason when not
      let vis = 1;
      let why = "";
      let cv = true;
      try {
        cv = el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) : cs.visibility !== "hidden" && st.eop > 0;
      } catch (e) {
        cv = true;
      }
      const srOnly = (cs.clip && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) || /inset\(\s*50%/.test(cs.clipPath || "") || (rect.width <= 1 && rect.height <= 1 && ox !== "visible") || parseFloat(cs.textIndent) <= -999 || rect.right < -500 || rect.bottom < -500;
      if (!cv) (vis = 0), (why = cs.visibility === "hidden" ? "visibility" : st.eop <= 0 ? "opacity" : "check");
      else if (rect.width < 2 || rect.height < 2) (vis = 0), (why = "tiny");
      else if (st.ah) (vis = 0), (why = "aria-hidden");
      else if (st.details) (vis = 0), (why = "details");
      else if (srOnly) (vis = 0), (why = "sr-only");
      const inv = insideShare({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, viewport);
      cands.push({ el, cs, rect, ps, st, lab, vis, why, inv, srOnly: srOnly ? 1 : 0, cv: cv ? 1 : 0 });
    }
    cost.walk = r1(now() - t1);
    page.elements = visited;
    page.rendered = cands.length;

    // ---- choose rows (cap), keep document order
    let chosen = cands;
    if (cands.length > maxRows) {
      const idx = cands.map((c, i) => [rankForCap(c), i]);
      idx.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const keep = new Set(idx.slice(0, maxRows).map((x) => x[1]));
      chosen = cands.filter((_, i) => keep.has(i));
    }
    page.rows = chosen.length;
    page.truncated = cands.length - chosen.length;
    const rowOf = new Map();
    chosen.forEach((c, i) => {
      rowOf.set(c.el, i);
      if (c.st) c.st.row = i;
    });
    const nearestRow = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const r = rowOf.get(n);
        if (r !== undefined) return r;
      }
      return -1;
    };

    // ---- per-row features
    const t2 = now();
    const rows = [];
    let hits = 0;
    let stacks = 0;
    let textInView = 0;
    let visInView = 0;
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      const el = c.el;
      const cs = c.cs;
      const row = { i, tag: el.tagName.toLowerCase() };
      if (c.lab) row.lab = c.lab;
      if (!c.rect) {
        row.vis = 0;
        row.why = c.why;
        rows.push(row);
        continue;
      }
      const st = c.st;
      const rect = c.rect;
      row.p = el.parentElement ? nearestRow(el.parentElement) : -1;
      row.d = st.depth;
      row.x = r1(rect.left);
      row.y = r1(rect.top);
      row.w = r1(rect.width);
      row.h = r1(rect.height);
      row.inv = r2(c.inv);
      row.vis = c.vis;
      if (c.why) row.why = c.why;
      if (c.srOnly) row.sr = 1;
      const role = el.getAttribute("role") || implicitRole(el);
      if (role) row.role = role.slice(0, 24);
      const tabIndex = el.tabIndex;
      const natively = !!implicitRole(el) && INTERACTIVE_ROLES[implicitRole(el)] ? 1 : 0;
      const ia = natively || INTERACTIVE_ROLES[role] || el.hasAttribute("onclick") || (tabIndex >= 0 && el.hasAttribute("tabindex")) || el.isContentEditable ? 1 : 0;
      if (ia) row.ia = 1;
      if (cs.cursor === "pointer") row.cur = 1;
      if (cs.pointerEvents === "none") row.pen = 1;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") row.dis = 1;
      if (tabIndex >= 0) row.foc = 1;
      const pos = POS[cs.position];
      if (pos) row.pos = pos;
      const disp = cs.display;
      if (disp !== "block") row.disp = disp.slice(0, 16);
      // text: own direct text nodes, lengths only
      let own = "";
      let firstText = null;
      for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          const v = n.nodeValue;
          if (v && v.trim()) {
            own += (own ? " " : "") + v.trim();
            if (!firstText) firstText = n;
          }
        }
      }
      if (own) row.tl = own.length;
      const tc = el.textContent;
      if (tc) row.tt = Math.min(tc.length, 100000);
      const fs = parseFloat(cs.fontSize);
      const fw = parseInt(cs.fontWeight, 10) || 400;
      row.fs = r1(fs);
      if (fw !== 400) row.fw = fw;
      if (own || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
        const lh = cs.lineHeight === "normal" ? -1 : r1(parseFloat(cs.lineHeight));
        row.lh = lh;
        const fam = String(cs.fontFamily).split(",")[0].replace(/["']/g, "").trim().toLowerCase();
        row.ff = fam.slice(0, 40);
        row.fst = famCode(fam);
        if (cs.textShadow && cs.textShadow !== "none") row.tsh = 1;
        if (cs.whiteSpace === "nowrap" || cs.textWrapMode === "nowrap") row.nw = 1;
        if (cs.textOverflow === "ellipsis") row.ell = 1;
        const lc = cs.webkitLineClamp || cs.getPropertyValue("-webkit-line-clamp");
        if (lc && lc !== "none") row.lcl = parseInt(lc, 10) || 1;
        if (cs.textAlign && cs.textAlign !== "start" && cs.textAlign !== "left") row.ta = cs.textAlign.slice(0, 8);
      }
      // colours
      const fg = parseColor(cs.color);
      row.c = rgbaOut(fg);
      const bgc = st.layers[0].color;
      if (bgc && bgc[3] > 0) row.bg = rgbaOut(bgc);
      const bi = cs.backgroundImage;
      if (bi && bi !== "none") row.bgi = /url\(/.test(bi) && /gradient\(/.test(bi) ? 3 : /url\(/.test(bi) ? 1 : 2;
      const bclip = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text" || cs.getPropertyValue("-webkit-background-clip") === "text";
      if (bclip) row.bclip = 1;
      const tfc = parseColor(cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color"));
      if (tfc && fg && (tfc[3] !== fg[3] || tfc[0] !== fg[0])) row.tfc = rgbaOut(tfc);
      // effective background along the ancestor chain (VISUAL.md 2.4 without the hit test)
      const eb = resolveLayers(st.layers, rootBase);
      row.eb = rgbOut(eb.rgb);
      if (eb.status) row.ebs = eb.status;
      if (st.eop < 1) row.eop = r2(st.eop);
      const op = parseFloat(cs.opacity);
      if (op < 1) row.op = r2(op);
      if (cs.visibility !== "visible") row.vsb = cs.visibility.slice(0, 8);
      if (own && fg) {
        const shownFg = bclip && fg[3] === 0 ? null : tfc && tfc[3] === 0 && !bclip ? tfc : fg;
        row.cr = shownFg ? textContrast(shownFg, eb.rgb, st.eop) : null;
      }
      // paint-stack background at the text centre (VISUAL.md 2.4 with elementsFromPoint), in the viewport only
      if (own && c.vis && c.inv > 0 && stacks < maxStack) {
        const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
        const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
        stacks++;
        const stack = doc.elementsFromPoint(cx, cy);
        const k = stack.indexOf(el);
        const topOk = stack.length && (stack[0] === el || el.contains(stack[0]));
        if (k < 0) row.sbs = 7;
        else {
          const layers = [];
          for (let j = k; j < stack.length && layers.length < 24; j++) {
            const s = stack[j];
            const scs = j === k ? cs : getComputedStyle(s);
            const sbi = scs.backgroundImage && scs.backgroundImage !== "none";
            const sf = (scs.filter && scs.filter !== "none") || (scs.backdropFilter && scs.backdropFilter !== "none") || (scs.mixBlendMode && scs.mixBlendMode !== "normal");
            layers.push({ color: s instanceof SVGElement && s.tagName.toLowerCase() !== "svg" ? [0, 0, 0, 0] : parseColor(scs.backgroundColor), image: !!sbi, media: j > k && !!MEDIA[s.tagName.toUpperCase()], filter: !!sf });
          }
          const sb = resolveLayers(layers, rootBase);
          row.sb = rgbOut(sb.rgb);
          row.sbs = topOk ? sb.status : 6;
          if (fg) row.scr = textContrast(bclip && fg[3] === 0 ? null : fg, sb.rgb, st.eop);
        }
      }
      if (own && c.vis && c.inv > 0) (textInView += own.length);
      if (c.vis && c.inv > 0) visInView++;
      // lines of the first text node (wrapping, clipping)
      if (firstText && c.vis && c.inv > 0) {
        try {
          const rg = doc.createRange();
          rg.selectNodeContents(firstText);
          const rs = rg.getClientRects();
          let lines = 0;
          let lastTop = -1e9;
          for (const q of rs) if (Math.abs(q.top - lastTop) > 1) (lines++, (lastTop = q.top));
          row.ln = lines;
          const b = rg.getBoundingClientRect();
          // text ink box beyond the element box (overflowing text)
          const spill = Math.max(0, b.right - rect.right, rect.left - b.left, b.bottom - rect.bottom, rect.top - b.top);
          if (spill > 0.5) row.tspill = r1(spill);
        } catch (e) {
          // ranges unsupported
        }
      }
      // overflow and clipping
      const ox = OVF[cs.overflowX] || "v";
      const oy = OVF[cs.overflowY] || "v";
      if (ox !== "v") row.ox = ox;
      if (oy !== "v") row.oy = oy;
      const sw = el.scrollWidth;
      const sh = el.scrollHeight;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (sw > cw + 1 || sh > ch + 1 || ox !== "v" || oy !== "v") {
        row.sw = sw;
        row.sh = sh;
        row.cw = cw;
        row.ch = ch;
      }
      if (st.nClipAnc) {
        const anc = c.ps.nClipAnc || 0;
        if (anc) row.nca = anc;
      }
      const cvisShare = insideShare({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, st.selfClip);
      if (cvisShare < 1) row.cvis = r2(cvisShare);
      if (cs.clipPath && cs.clipPath !== "none") row.cpath = 1;
      if (cs.clip && cs.clip !== "auto") row.clip = 1;
      // stacking
      const z = cs.zIndex;
      if (z !== "auto") row.z = parseInt(z, 10) || 0;
      if (st.scReason) row.sc = st.scReason;
      if (cs.position === "fixed" && st.trappedByAncestor) row.ftrap = 1;
      if (cs.transform && cs.transform !== "none") row.tf = 1;
      if ((cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none")) row.flt = 1;
      if (st.an) row.an = 1;
      // replaced content
      const tag = el.tagName;
      if (tag === "IMG") {
        row.nw = el.naturalWidth;
        row.nh = el.naturalHeight;
        row.cmp = el.complete ? 1 : 0;
        row.iok = el.complete && el.naturalWidth > 0 ? 1 : 0;
        row.src = urlClass(el.currentSrc || el.getAttribute("src") || "", origin);
        if (el.getAttribute("loading") === "lazy") row.lazy = 1;
        const of = OBJECT_FIT[cs.objectFit];
        if (of) row.of = of;
        if (!el.hasAttribute("width") || !el.hasAttribute("height")) row.nosize = 1;
        if (el.hasAttribute("alt")) row.alt = el.getAttribute("alt").length;
        else row.alt = -1;
        if (el.naturalWidth > 0 && el.naturalHeight > 0 && rect.width > 0 && rect.height > 0) row.dist = r2(Math.abs(rect.width / rect.height / (el.naturalWidth / el.naturalHeight) - 1));
      } else if (tag === "VIDEO") {
        row.rs = el.readyState;
        if (el.error) row.verr = el.error.code;
      } else if (tag.toLowerCase() === "svg") {
        row.vb = el.hasAttribute("viewBox") ? 1 : 0;
        row.wa = el.hasAttribute("width") ? 1 : 0;
      } else if (tag === "CANVAS" || tag === "IFRAME") {
        row.rw = el.width || 0;
      }
      if (bi && /url\(/.test(bi)) {
        const m = /url\(["']?([^"')]+)/.exec(bi);
        if (m) row.bsrc = urlClass(m[1], origin);
      }
      // leaks: ids and matched characters only
      const leaks = scanLeaks(own);
      if (tag === "IMG" && el.getAttribute("alt")) for (const l of scanLeaks(el.getAttribute("alt"))) leaks.push(["alt:" + l[0], l[1]]);
      if (leaks.length) row.lk = leaks;
      rows.push(row);
    }
    // stacking ancestor indices need the row of the context; recompute with the map now that rows exist
    for (const c of chosen) {
      if (!c.st || !c.rect) continue;
      const r = rows[c.st.row];
      if (!r) continue;
      let sca = -1;
      for (let n = c.el.parentElement; n; n = n.parentElement) {
        const s = state.get(n);
        if (s && s.scReason) {
          sca = rowOf.has(n) ? rowOf.get(n) : -2;
          break;
        }
      }
      if (sca !== -1) r.sca = sca;
      else delete r.sca;
    }
    cost.rows = r1(now() - t2);

    // ---- occlusion: elementFromPoint at five points per target in the viewport
    const t3 = now();
    for (let i = 0; i < chosen.length && hits < maxHit; i++) {
      const c = chosen[i];
      const row = rows[i];
      if (!c.rect || !c.vis || c.inv <= 0) continue;
      const target = row.tl || row.ia || row.tag === "img" || row.tag === "svg" || row.tag === "input" || row.lab || row.tag === "video" || row.tag === "canvas";
      if (!target) continue;
      hits++;
      const rect = c.rect;
      const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
      let self = 0;
      let other = 0;
      let anc = 0;
      let none = 0;
      const by = {};
      for (const p of pts) {
        const x = rect.left + rect.width * p[0];
        const y = rect.top + rect.height * p[1];
        if (x < 0 || y < 0 || x >= vw || y >= vh) {
          none++;
          continue;
        }
        const top = doc.elementFromPoint(x, y);
        if (!top) none++;
        else if (top === c.el || c.el.contains(top)) self++;
        else if (top.contains(c.el)) anc++;
        else {
          other++;
          const r = nearestRow(top);
          by[r] = (by[r] || 0) + 1;
        }
      }
      row.hs = self;
      if (other) {
        row.ho = other;
        let best = -1;
        let bn = 0;
        for (const k in by) if (by[k] > bn) (bn = by[k]), (best = Number(k));
        row.hb = best;
      }
      if (anc) row.ha = anc;
      if (none) row.hn = none;
    }
    cost.hit = r1(now() - t3);

    // ---- CSS variables: var() without a usable value, and colours that are invalid after substitution
    const t4 = now();
    let varRules = 0;
    let varUndef = 0;
    let varInvalid = 0;
    const csCache = new Map();
    const csOf = (el) => {
      let s = csCache.get(el);
      if (!s) {
        const idx = rowOf.get(el);
        s = idx !== undefined ? chosen[idx].cs : getComputedStyle(el);
        csCache.set(el, s);
      }
      return s;
    };
    const visitRules = (list) => {
      for (const rule of Array.from(list)) {
        if (varRules >= maxVarRules) return;
        if (typeof CSSImportRule !== "undefined" && rule instanceof CSSImportRule) {
          try {
            if (rule.styleSheet && (!rule.media || !rule.media.mediaText || matchMedia(rule.media.mediaText).matches)) visitRules(rule.styleSheet.cssRules);
          } catch (e) {
            // a cross-origin import
          }
          continue;
        }
        if (rule.cssRules && rule.cssRules.length && !(rule instanceof CSSStyleRule)) {
          if (rule.media && rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) continue;
          if (rule.conditionText && typeof CSS !== "undefined" && rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue;
          visitRules(rule.cssRules);
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) continue;
        const text = rule.cssText;
        if (text.indexOf("var(") < 0) continue;
        const decls = declarations(text).filter((d) => d[1].indexOf("var(") >= 0 && d[0].slice(0, 2) !== "--");
        if (!decls.length) continue;
        varRules++;
        let sel = rule.selectorText.replace(/::?(before|after|placeholder|marker|selection|backdrop|first-line|first-letter|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)/g, "");
        if (!sel.trim()) continue;
        let els;
        try {
          els = doc.querySelectorAll(sel);
        } catch (e) {
          continue;
        }
        for (const el of Array.from(els)) {
          const ri = rowOf.get(el);
          if (ri === undefined) continue;
          const ecs = csOf(el);
          for (const d of decls) {
            const sub = substituteVars(d[1], (name) => ecs.getPropertyValue(name));
            const row = rows[ri];
            if (sub == null) {
              varUndef++;
              row.vu = (row.vu || 0) + 1;
              if (!row.vp) row.vp = [];
              if (row.vp.length < 3 && row.vp.indexOf(d[0]) < 0) row.vp.push(d[0].slice(0, 32));
            } else if (COLOR_PROPS.test(d[0]) && typeof CSS !== "undefined" && !CSS.supports(d[0], sub)) {
              varInvalid++;
              row.vi = (row.vi || 0) + 1;
              if (!row.vp) row.vp = [];
              if (row.vp.length < 3 && row.vp.indexOf(d[0]) < 0) row.vp.push(d[0].slice(0, 32));
            }
          }
        }
      }
    };
    for (const s of readable) {
      try {
        visitRules(s.cssRules);
      } catch (e) {
        // a sheet that became unreadable
      }
    }
    page.varRules = varRules;
    page.varUndef = varUndef;
    page.varInvalid = varInvalid;
    cost.vars = r1(now() - t4);

    page.textInView = textInView;
    page.visInView = visInView;
    page.hitTargets = hits;
    page.stackReads = stacks;
    cost.total = r1(now() - t0);
    return { v: VERSION, page, rows, cost };
  }

  root.__visionLib = { VERSION, parseColor, over, luminance, contrast, textContrast, resolveLayers, scanLeaks, urlClass, parseViewportMeta, varRefs, substituteVars, declarations, stackingReason, trapsFixed, intersect, insideShare, implicitRole, rankForCap, LEAK_PATTERNS, PLACEHOLDER_HOSTS };
  root.__visionExtract = extract;
})(typeof globalThis !== "undefined" ? globalThis : this);
