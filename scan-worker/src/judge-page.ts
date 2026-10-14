// The page side of the model judge (src/judge.ts). judgePage(cmd, options) runs in the scanned page (Puppeteer's
// isolated world), serialised with toString() like src/audits.ts pageSide: self-contained, DOM through `any`.
//
//   "find"     the elements to judge in this view, at the current scroll (the top of the page): the visual checks'
//              findings, matched to their element by selector and box, and the elements the measured checks abstain
//              on, in priority order (covered or partly clipped controls; in the dark view every visible button and
//              link; text whose background is an image, a gradient, media or a filter, above the fold first). The
//              elements are kept in the isolated world under options.name for "facts"; only plain data is returned.
//   "facts"    scrolls so the chosen elements are in the viewport (not at all for those already in it; to the end of
//              the page for a control a fixed bar covers there; by focusing it for a focused element under a sticky
//              bar), waits two frames, and measures each element as vision/src/extract.js measured the labelled crops
//              of the Clef evaluation (wave2/clef-eval, vision/clef/eval.py builds its prompt from these fields)
//   "restore"  takes focus off and scrolls back to the top
//
// Invariants:
// - It never changes the page beyond scrolling and focus, which "restore" undoes.
// - No page text leaves the page except what the evaluation's extractor also kept: text lengths, the id of a leak
//   pattern and its matched characters (at most 24). No attribute values but role and tag names; image URLs only as
//   a class (same site, another site, data, a placeholder host).
// - The measurements follow extract.js (vision-extract-2) field for field for one element and its ancestors, so the
//   prompt the model reads has the shape the evaluation's thresholds were chosen on.

/* eslint-disable @typescript-eslint/no-explicit-any */

export function judgePage(cmd: string, options?: any): any {
  const o = options || {};
  const g: any = globalThis as any;
  const doc: any = g.document;
  const html: any = doc.documentElement;
  const body: any = doc.body;

  // ---------------------------------------------------------------- colour (CSS Color 4), as extract.js
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const encode = (c: number) => {
    const a = Math.abs(c);
    return a <= 0.0031308 ? 12.92 * c : Math.sign(c) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
  };
  const decode = (c: number) => {
    const a = Math.abs(c);
    return a <= 0.04045 ? c / 12.92 : Math.sign(c) * Math.pow((a + 0.055) / 1.055, 2.4);
  };
  const mul = (m: number[], v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  const XYZ65_TO_LSRGB = [3.2409699419045226, -1.537383177570094, -0.4986107602930034, -0.9692436362808796, 1.8759675015077202, 0.04155505740717559, 0.05563007969699366, -0.20397695888897652, 1.0569715142428786];
  const D50_TO_D65 = [0.955473421488075, -0.02309845494876471, 0.06325924320057072, -0.0283697093338637, 1.0099953980813041, 0.021041441191917323, 0.012314014864481998, -0.020507649298898964, 1.330365926242124];
  const LP3_TO_XYZ65 = [0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488, 0.6917385218365064, 0.079286914093745, 0, 0.04511338185890264, 1.043944368900976];
  const D50_WHITE = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const fromLinear = (l: number[], alpha: number) => [clamp01(encode(l[0])) * 255, clamp01(encode(l[1])) * 255, clamp01(encode(l[2])) * 255, clamp01(alpha)];
  const oklabToLinear = (L: number, a: number, b: number) => {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  };
  const labToLinear = (L: number, a: number, b: number) => {
    const k = 24389 / 27;
    const e = 216 / 24389;
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const xyz50 = [(fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k) * D50_WHITE[0], (L > k * e ? fy ** 3 : L / k) * D50_WHITE[1], (fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k) * D50_WHITE[2]];
    return mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, xyz50));
  };
  const hslToRgb = (h: number, s: number, l: number) => {
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  };
  const hue = (t: string) => {
    const m = /^(-?[\d.]+(?:e-?\d+)?)(deg|rad|grad|turn)?$/i.exec(t);
    if (!m) return t === "none" ? 0 : NaN;
    const v = Number(m[1]);
    const u = (m[2] || "deg").toLowerCase();
    const d = u === "rad" ? (v * 180) / Math.PI : u === "grad" ? v * 0.9 : u === "turn" ? v * 360 : v;
    return ((d % 360) + 360) % 360;
  };
  const numT = (t: string, pct: number) => {
    if (t === "none") return 0;
    const m = /^(-?[\d.]+(?:e-?\d+)?)(%)?$/i.exec(t);
    if (!m) return NaN;
    const v = Number(m[1]);
    return m[2] ? (v / 100) * pct : v;
  };
  const hex = (s: string) => {
    const h = s.slice(1);
    if (!/^[\da-f]+$/i.test(h) || [3, 4, 6, 8].indexOf(h.length) < 0) return null;
    const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  };
  /** A computed colour string to [r, g, b] 0..255 and alpha 0..1, or null when it does not parse. */
  const parseColor = (input: any): number[] | null => {
    const s = String(input == null ? "" : input).trim().toLowerCase();
    if (!s) return null;
    if (s === "transparent") return [0, 0, 0, 0];
    if (s === "white") return [255, 255, 255, 1];
    if (s === "black") return [0, 0, 0, 1];
    if (s[0] === "#") return hex(s);
    const m = /^([a-z-]+)\((.*)\)$/.exec(s);
    if (!m) return null;
    const fn = m[1];
    let bodyT = m[2].trim();
    let space = "";
    if (fn === "color") {
      const sp = /^([a-z0-9-]+)\s+(.*)$/.exec(bodyT);
      if (!sp) return null;
      space = sp[1];
      bodyT = sp[2];
    }
    let parts: string[];
    let alphaT: string | undefined;
    if (bodyT.indexOf(",") >= 0) {
      parts = bodyT.split(",").map((x) => x.trim());
      if (parts.length === 4) alphaT = parts.pop();
    } else {
      const sl = bodyT.split("/").map((x) => x.trim());
      parts = sl[0].split(/\s+/).filter(Boolean);
      alphaT = sl[1];
    }
    if (parts.length !== 3) return null;
    const alpha = alphaT === undefined ? 1 : numT(alphaT, 1);
    if (!Number.isFinite(alpha)) return null;
    let out: number[] | null = null;
    if (fn === "rgb" || fn === "rgba") {
      const v = parts.map((p) => numT(p, 255));
      out = [Math.min(255, Math.max(0, v[0])), Math.min(255, Math.max(0, v[1])), Math.min(255, Math.max(0, v[2])), clamp01(alpha)];
    } else if (fn === "hsl" || fn === "hsla") {
      const rgb = hslToRgb(hue(parts[0]), clamp01(numT(parts[1], 100) / 100), clamp01(numT(parts[2], 100) / 100));
      out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
    } else if (fn === "hwb") {
      const h = hue(parts[0]);
      const w = clamp01(numT(parts[1], 100) / 100);
      const bl = clamp01(numT(parts[2], 100) / 100);
      if (w + bl >= 1) {
        const gr = w / (w + bl);
        out = [gr * 255, gr * 255, gr * 255, clamp01(alpha)];
      } else {
        const rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w - bl) + w);
        out = [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, clamp01(alpha)];
      }
    } else if (fn === "lab") out = fromLinear(labToLinear(numT(parts[0], 100), numT(parts[1], 125), numT(parts[2], 125)), alpha);
    else if (fn === "lch") {
      const H = (hue(parts[2]) * Math.PI) / 180;
      const C = numT(parts[1], 150);
      out = fromLinear(labToLinear(numT(parts[0], 100), C * Math.cos(H), C * Math.sin(H)), alpha);
    } else if (fn === "oklab") out = fromLinear(oklabToLinear(numT(parts[0], 1), numT(parts[1], 0.4), numT(parts[2], 0.4)), alpha);
    else if (fn === "oklch") {
      const H = (hue(parts[2]) * Math.PI) / 180;
      const C = numT(parts[1], 0.4);
      out = fromLinear(oklabToLinear(numT(parts[0], 1), C * Math.cos(H), C * Math.sin(H)), alpha);
    } else if (fn === "color") {
      const v = parts.map((p) => numT(p, 1));
      if (space === "srgb") out = [clamp01(v[0]) * 255, clamp01(v[1]) * 255, clamp01(v[2]) * 255, clamp01(alpha)];
      else if (space === "srgb-linear") out = fromLinear(v, alpha);
      else if (space === "display-p3") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(LP3_TO_XYZ65, [decode(v[0]), decode(v[1]), decode(v[2])])), alpha);
      else if (space === "xyz" || space === "xyz-d65") out = fromLinear(mul(XYZ65_TO_LSRGB, v), alpha);
      else if (space === "xyz-d50") out = fromLinear(mul(XYZ65_TO_LSRGB, mul(D50_TO_D65, v)), alpha);
      else return null;
    } else return null;
    return out && out.every((x) => Number.isFinite(x)) ? out : null;
  };
  const over = (top: number[], bottom: number[]) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a <= 0) return [0, 0, 0, 0];
    const c = (i: number) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [c(0), c(1), c(2), a];
  };
  const luminance = (c: number[]) => {
    const v = [c[0], c[1], c[2]].map((x) => decode(x / 255));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const contrast = (a: number[], b: number[]) => {
    const la = luminance(a);
    const lb = luminance(b);
    return Math.floor(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100 + 1e-9) / 100;
  };
  const textContrast = (fg: number[] | null, bg: number[] | null, opacity: number) => {
    if (!fg || !bg) return null;
    const a = fg[3] * (opacity == null ? 1 : opacity);
    const shown = over([fg[0], fg[1], fg[2], a], [bg[0], bg[1], bg[2], 1]);
    return contrast(shown, bg);
  };
  /** extract.js resolveLayers: the first opaque layer from the element outwards, and how reliable that is (0 to 5). */
  const resolveLayers = (layers: any[], base: number[]) => {
    let status = 0;
    const seen: number[][] = [];
    let opaque: number[] | null = null;
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
  };

  // ---------------------------------------------------------------- text patterns and URLs, as extract.js
  const LEAK_PATTERNS: [string, RegExp][] = [
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
  const scanLeaks = (text: string) => {
    const out: string[][] = [];
    if (!text) return out;
    const t = String(text);
    const tt = t.trim();
    if (tt === "undefined" || tt === "null" || tt === "NaN") out.push(["weak-" + tt, tt]);
    if (t.length < 3) return out;
    for (const p of LEAK_PATTERNS) {
      const m = p[1].exec(t);
      if (m) out.push([p[0], m[0].slice(0, 24)]);
    }
    return out;
  };
  const PLACEHOLDER_HOSTS = ["placehold.co", "via.placeholder.com", "placeholder.com", "dummyimage.com", "picsum.photos", "placekitten.com", "placehold.it", "fakeimg.pl", "loremflickr.com"];
  const origin = String(g.location.origin);
  const urlClass = (url: string) => {
    if (!url) return "";
    if (/^data:/i.test(url)) return "data";
    if (/^blob:/i.test(url)) return "blob";
    let u: any;
    try {
      u = new g.URL(url, origin || "http://x.invalid/");
    } catch (e) {
      return "";
    }
    const host = String(u.hostname).toLowerCase();
    for (const h of PLACEHOLDER_HOSTS) if (host === h || host.endsWith("." + h)) return "ph";
    if (/(^|\.)unsplash\.com$/.test(host)) return "unsplash";
    return origin && u.origin === origin ? "same" : "cross";
  };

  // ---------------------------------------------------------------- CSS variables (extract.js), for one element
  const substituteVars = (value: string, lookup: (n: string) => string, depth: number): string | null => {
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
  };
  const declarations = (cssText: string) => {
    const bodyT = String(cssText);
    const open = bodyT.indexOf("{");
    const close = bodyT.lastIndexOf("}");
    const inner = open >= 0 && close > open ? bodyT.slice(open + 1, close) : bodyT;
    const out: string[][] = [];
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
  };
  const COLOR_PROPS = /(^|-)(color|background|fill|stroke|border|outline|shadow|caret|accent)/;
  /** The var() pass of extract.js for one element: declarations with an undefined var(), invalid colours. */
  const varsOf = (el: any, cs: any) => {
    let rules = 0;
    let vu = 0;
    let vi = 0;
    const vp: string[] = [];
    const visit = (list: any) => {
      for (const rule of Array.from(list) as any[]) {
        if (rules >= 2500) return;
        if (typeof g.CSSImportRule !== "undefined" && rule instanceof g.CSSImportRule) {
          try {
            if (rule.styleSheet && (!rule.media || !rule.media.mediaText || g.matchMedia(rule.media.mediaText).matches)) visit(rule.styleSheet.cssRules);
          } catch (e) {
            /* a cross-origin import */
          }
          continue;
        }
        if (rule.cssRules && rule.cssRules.length && !(rule instanceof g.CSSStyleRule)) {
          if (rule.media && rule.media.mediaText && !g.matchMedia(rule.media.mediaText).matches) continue;
          if (rule.conditionText && typeof g.CSS !== "undefined" && rule instanceof g.CSSSupportsRule && !g.CSS.supports(rule.conditionText)) continue;
          visit(rule.cssRules);
          continue;
        }
        if (!(rule instanceof g.CSSStyleRule)) continue;
        const text = rule.cssText;
        if (text.indexOf("var(") < 0) continue;
        const decls = declarations(text).filter((d) => d[1].indexOf("var(") >= 0 && d[0].slice(0, 2) !== "--");
        if (!decls.length) continue;
        rules++;
        const sel = String(rule.selectorText).replace(/::?(before|after|placeholder|marker|selection|backdrop|first-line|first-letter|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)/g, "");
        if (!sel.trim()) continue;
        let hit = false;
        try {
          hit = el.matches(sel);
        } catch (e) {
          hit = false;
        }
        if (!hit) continue;
        for (const d of decls) {
          const sub = substituteVars(d[1], (name) => cs.getPropertyValue(name), 0);
          if (sub == null) {
            vu++;
            if (vp.length < 3 && vp.indexOf(d[0]) < 0) vp.push(d[0].slice(0, 32));
          } else if (COLOR_PROPS.test(d[0]) && typeof g.CSS !== "undefined" && !g.CSS.supports(d[0], sub)) {
            vi++;
            if (vp.length < 3 && vp.indexOf(d[0]) < 0) vp.push(d[0].slice(0, 32));
          }
        }
      }
    };
    const sheets: any[] = [];
    for (const s of Array.from(doc.styleSheets) as any[]) {
      try {
        if (s.cssRules) sheets.push(s);
      } catch (e) {
        /* unreadable */
      }
    }
    try {
      for (const s of Array.from(doc.adoptedStyleSheets || []) as any[]) sheets.push(s);
    } catch (e) {
      /* none */
    }
    for (const s of sheets) {
      try {
        visit(s.cssRules);
      } catch (e) {
        /* became unreadable */
      }
    }
    return { vu, vi, vp };
  };

  // ---------------------------------------------------------------- layout helpers, as extract.js
  const trapsFixed = (cs: any) =>
    (cs.transform && cs.transform !== "none") || (cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") ||
    (cs.perspective && cs.perspective !== "none") || /\b(paint|layout|strict|content)\b/.test(cs.contain || "") ||
    /\b(transform|filter|perspective)\b/.test(cs.willChange || "") || (cs.containerType && cs.containerType !== "normal")
      ? true
      : false;
  const intersect = (a: any, b: any) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const insideShare = (r: any, clip: any) => {
    const w = r.r - r.l;
    const h = r.b - r.t;
    const i = intersect(r, clip);
    const iw = Math.max(0, i.r - i.l);
    const ih = Math.max(0, i.b - i.t);
    if (w <= 0 || h <= 0) return iw >= 0 && ih >= 0 && r.l >= clip.l && r.r <= clip.r && r.t >= clip.t && r.b <= clip.b ? 1 : 0;
    return (iw * ih) / (w * h);
  };
  const OVF: any = { visible: "v", hidden: "h", clip: "c", auto: "a", scroll: "s", overlay: "a" };
  const POS: any = { static: "", relative: "r", absolute: "a", fixed: "f", sticky: "s" };
  const OBJECT_FIT: any = { fill: "", contain: "c", cover: "v", none: "n", "scale-down": "d" };
  const SKIP: any = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, WBR: 1, TITLE: 1, BASE: 1, SOURCE: 1, TRACK: 1, PARAM: 1 };
  const MEDIA: any = { IMG: 1, PICTURE: 1, VIDEO: 1, CANVAS: 1, SVG: 1, IFRAME: 1, OBJECT: 1, EMBED: 1 };
  const INTERACTIVE_ROLES: any = { button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, combobox: 1, textbox: 1, slider: 1, spinbutton: 1, searchbox: 1, treeitem: 1 };
  const implicitRole = (el: any): string => {
    const t = el.tagName;
    if (t === "A" || t === "AREA") return el.hasAttribute("href") ? "link" : "";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = String(el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return "";
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return "searchbox";
      if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
      return "textbox";
    }
    if (t === "IMG") return el.getAttribute("alt") === "" ? "presentation" : "img";
    const map: any = { NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", UL: "list", OL: "list", LI: "listitem", TABLE: "table", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading" };
    return map[t] || "";
  };
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const rgbOut = (c: number[] | null) => (c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] : null);
  const rgbaOut = (c: number[] | null) => (c ? [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), r2(c[3])] : null);
  const styles = new Map();
  const style = (el: any) => {
    let s = styles.get(el);
    if (!s) {
      s = g.getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };
  const isSvgChild = (el: any) => el instanceof g.SVGElement && String(el.tagName).toLowerCase() !== "svg";
  const interactive = (el: any) => {
    const role = el.getAttribute("role") || implicitRole(el);
    const natively = !!implicitRole(el) && INTERACTIVE_ROLES[implicitRole(el)] ? 1 : 0;
    return natively || INTERACTIVE_ROLES[role] || el.hasAttribute("onclick") || (el.tabIndex >= 0 && el.hasAttribute("tabindex")) || el.isContentEditable ? 1 : 0;
  };
  const ownText = (el: any) => {
    let own = "";
    let first: any = null;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const v = n.nodeValue;
        if (v && v.trim()) {
          own += (own ? " " : "") + v.trim();
          if (!first) first = n;
        }
      }
    }
    return { own, first };
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
    if (!/#/.test(s) && el.parentElement && el.parentElement !== body && el.parentElement !== html) s = one(el.parentElement) + " > " + s;
    return s.slice(0, 160);
  };

  // the canvas colour when nothing is opaque (extract.js rootBase)
  const rootBase = () => {
    const prefersDark = g.matchMedia("(prefers-color-scheme: dark)").matches;
    const hcs = style(html);
    const darkCanvas = prefersDark && /dark/.test(hcs.colorScheme || "");
    const canvas = darkCanvas ? [18, 18, 18, 1] : [255, 255, 255, 1];
    const hb = parseColor(hcs.backgroundColor);
    const bb = body ? parseColor(style(body).backgroundColor) : null;
    return hb && hb[3] > 0 ? over(hb, canvas) : bb && bb[3] > 0 ? over(bb, canvas) : canvas;
  };

  /** The page facts the prompt uses (eval.py page_words). */
  const pageFacts = () => {
    const hcs = style(html);
    const res: any = { cssFailed: 0, imgFailed: 0, fontFailed: 0, scriptFailed: 0 };
    try {
      for (const e of g.performance.getEntriesByType("resource")) {
        if ((e.responseStatus || 0) < 400) continue;
        const it = e.initiatorType;
        if (it === "link" && /\.css(\?|$)/.test(e.name)) res.cssFailed++;
        else if (it === "css" && /\.(woff2?|ttf|otf)(\?|$)/.test(e.name)) res.fontFailed++;
        else if (it === "img" || /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/.test(e.name)) res.imgFailed++;
        else if (it === "script") res.scriptFailed++;
      }
    } catch (e) {
      /* no resource timing */
    }
    const appDark = html.classList.contains("dark") || /dark/i.test(html.getAttribute("data-theme") || "") || (body && body.classList.contains("dark")) ? 1 : 0;
    return { vw: g.innerWidth, vh: g.innerHeight, colorScheme: String(hcs.colorScheme || "").slice(0, 40), appDark, scrollW: html.scrollWidth, clientW: html.clientWidth, res, fontsStatus: doc.fonts ? String(doc.fonts.status) : "" };
  };

  /**
   * One element's row, as extract.js computes it: the state it inherits from body down (effective opacity, the
   * background layers, the clip rect, aria-hidden, a closed details, a running animation), then its own features,
   * the paint stack under its text and the five-point hit test when it is in the viewport.
   */
  const factsOf = (el: any, base: number[], animated: any, withVars: boolean) => {
    const vw = g.innerWidth;
    const vh = g.innerHeight;
    const chain: any[] = [];
    for (let e = el; e && e !== html; e = e.parentElement) chain.unshift(e);
    const rootClip = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    let ps: any = { eop: 1, layers: null, ah: 0, an: 0, clip: rootClip, fixedTrap: 0, nClipAnc: 0, details: 0, disp: style(html).display };
    let st: any = ps;
    let parentState: any = ps;
    for (const e of chain) {
      const cs = style(e);
      const parent = e.parentElement;
      const op = parseFloat(cs.opacity);
      const bgc = parseColor(cs.backgroundColor);
      const bgImg = cs.backgroundImage && cs.backgroundImage !== "none";
      const filt = (cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.mixBlendMode && cs.mixBlendMode !== "normal");
      const layer = { color: isSvgChild(e) ? [0, 0, 0, 0] : bgc, image: !!bgImg, media: !!MEDIA[String(e.tagName).toUpperCase()], filter: !!filt };
      let layers: any[];
      if (layer.color && layer.color[3] >= 1) layers = [layer];
      else {
        layers = [layer];
        if (ps.layers) for (let i = 0; i < ps.layers.length && layers.length < 24; i++) layers.push(ps.layers[i]);
      }
      let clip = ps.clip;
      if (cs.position === "fixed" && !ps.fixedTrap) clip = rootClip;
      const rect = e.getBoundingClientRect();
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
      parentState = ps;
      st = {
        eop: ps.eop * (Number.isFinite(op) ? op : 1),
        layers,
        ah: ps.ah || e.getAttribute("aria-hidden") === "true" || e.hasAttribute("inert") ? 1 : 0,
        an: ps.an || animated.has(e) ? 1 : 0,
        clip: childClip,
        selfClip: clip,
        fixedTrap: ps.fixedTrap || trapsFixed(cs) ? 1 : 0,
        trappedByAncestor: ps.fixedTrap,
        nClipAnc: (ps.nClipAnc || 0) + (clipsSelf ? 1 : 0),
        details: ps.details || (parent && parent.tagName === "DETAILS" && !parent.open && e.tagName !== "SUMMARY") ? 1 : 0,
        disp: cs.display,
      };
      ps = st;
    }
    const cs = style(el);
    const rect = el.getBoundingClientRect();
    const row: any = { tag: String(el.tagName).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) };
    // visibility (VISUAL.md 2.1), with the reason when not
    let vis = 1;
    let why = "";
    let cv = true;
    try {
      cv = el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) : cs.visibility !== "hidden" && st.eop > 0;
    } catch (e) {
      cv = true;
    }
    const ox0 = cs.overflowX;
    const srOnly = (cs.clip && /rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(cs.clip)) || /inset\(\s*50%/.test(cs.clipPath || "") || (rect.width <= 1 && rect.height <= 1 && ox0 !== "visible") || parseFloat(cs.textIndent) <= -999 || rect.right < -500 || rect.bottom < -500;
    if (!cv) {
      vis = 0;
      why = cs.visibility === "hidden" ? "visibility" : st.eop <= 0 ? "opacity" : "check";
    } else if (rect.width < 2 || rect.height < 2) {
      vis = 0;
      why = "tiny";
    } else if (st.ah) {
      vis = 0;
      why = "aria-hidden";
    } else if (st.details) {
      vis = 0;
      why = "details";
    } else if (srOnly) {
      vis = 0;
      why = "sr-only";
    }
    const inv = insideShare({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, { l: 0, t: 0, r: vw, b: vh });
    row.x = r1(rect.left);
    row.y = r1(rect.top);
    row.w = r1(rect.width);
    row.h = r1(rect.height);
    row.inv = r2(inv);
    row.vis = vis;
    if (why) row.why = why;
    if (srOnly) row.sr = 1;
    const role = el.getAttribute("role") || implicitRole(el);
    if (role) row.role = String(role).slice(0, 24);
    if (interactive(el)) row.ia = 1;
    if (cs.cursor === "pointer") row.cur = 1;
    if (cs.pointerEvents === "none") row.pen = 1;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") row.dis = 1;
    if (el.tabIndex >= 0) row.foc = 1;
    const pos = POS[cs.position];
    if (pos) row.pos = pos;
    if (cs.display !== "block") row.disp = String(cs.display).slice(0, 16);
    const t = ownText(el);
    const own = t.own;
    if (own) row.tl = own.length;
    const tc = el.textContent;
    if (tc) row.tt = Math.min(tc.length, 100000);
    const fs = parseFloat(cs.fontSize);
    const fw = parseInt(cs.fontWeight, 10) || 400;
    row.fs = r1(fs);
    if (fw !== 400) row.fw = fw;
    if (own || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
      row.lh = cs.lineHeight === "normal" ? -1 : r1(parseFloat(cs.lineHeight));
      if (cs.textShadow && cs.textShadow !== "none") row.tsh = 1;
      if (cs.whiteSpace === "nowrap" || cs.textWrapMode === "nowrap") row.nw = 1;
      if (cs.textOverflow === "ellipsis") row.ell = 1;
      const lc = cs.webkitLineClamp || cs.getPropertyValue("-webkit-line-clamp");
      if (lc && lc !== "none") row.lcl = parseInt(lc, 10) || 1;
    }
    const fg = parseColor(cs.color);
    row.c = rgbaOut(fg);
    const bgc0 = st.layers[0].color;
    if (bgc0 && bgc0[3] > 0) row.bg = rgbaOut(bgc0);
    const bi = cs.backgroundImage;
    if (bi && bi !== "none") row.bgi = /url\(/.test(bi) && /gradient\(/.test(bi) ? 3 : /url\(/.test(bi) ? 1 : 2;
    const bclip = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text" || cs.getPropertyValue("-webkit-background-clip") === "text";
    if (bclip) row.bclip = 1;
    const tfc = parseColor(cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color"));
    if (tfc && fg && (tfc[3] !== fg[3] || tfc[0] !== fg[0])) row.tfc = rgbaOut(tfc);
    const eb = resolveLayers(st.layers, base);
    row.eb = rgbOut(eb.rgb);
    if (eb.status) row.ebs = eb.status;
    if (st.eop < 1) row.eop = r2(st.eop);
    const op = parseFloat(cs.opacity);
    if (op < 1) row.op = r2(op);
    if (own && fg) {
      const shownFg = bclip && fg[3] === 0 ? null : tfc && tfc[3] === 0 && !bclip ? tfc : fg;
      row.cr = shownFg ? textContrast(shownFg, eb.rgb, st.eop) : null;
    }
    // the paint stack at the text centre, in the viewport only
    if (own && vis && inv > 0) {
      const cx = Math.min(vw - 1, Math.max(0, rect.left + rect.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, rect.top + rect.height / 2));
      const stack = doc.elementsFromPoint(cx, cy);
      const k = stack.indexOf(el);
      const topOk = stack.length && (stack[0] === el || el.contains(stack[0]));
      if (k < 0) row.sbs = 7;
      else {
        const layers: any[] = [];
        for (let j = k; j < stack.length && layers.length < 24; j++) {
          const s = stack[j];
          const scs = j === k ? cs : style(s);
          const sbi = scs.backgroundImage && scs.backgroundImage !== "none";
          const sf = (scs.filter && scs.filter !== "none") || (scs.backdropFilter && scs.backdropFilter !== "none") || (scs.mixBlendMode && scs.mixBlendMode !== "normal");
          layers.push({ color: isSvgChild(s) ? [0, 0, 0, 0] : parseColor(scs.backgroundColor), image: !!sbi, media: j > k && !!MEDIA[String(s.tagName).toUpperCase()], filter: !!sf });
        }
        const sb = resolveLayers(layers, base);
        row.sb = rgbOut(sb.rgb);
        row.sbs = topOk ? sb.status : 6;
        if (fg) row.scr = textContrast(bclip && fg[3] === 0 ? null : fg, sb.rgb, st.eop);
      }
    }
    // lines of the first text node, and text that spills out of the box
    if (t.first && vis && inv > 0) {
      try {
        const rg = doc.createRange();
        rg.selectNodeContents(t.first);
        const rs = rg.getClientRects();
        let lines = 0;
        let lastTop = -1e9;
        for (const q of Array.from(rs) as any[]) {
          if (Math.abs(q.top - lastTop) > 1) {
            lines++;
            lastTop = q.top;
          }
        }
        row.ln = lines;
        const b = rg.getBoundingClientRect();
        const spill = Math.max(0, b.right - rect.right, rect.left - b.left, b.bottom - rect.bottom, rect.top - b.top);
        if (spill > 0.5) row.tspill = r1(spill);
      } catch (e) {
        /* ranges unsupported */
      }
    }
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
    if (parentState.nClipAnc) row.nca = parentState.nClipAnc;
    const cvisShare = insideShare({ l: rect.left, t: rect.top, r: rect.right, b: rect.bottom }, st.selfClip);
    if (cvisShare < 1) row.cvis = r2(cvisShare);
    if (cs.clipPath && cs.clipPath !== "none") row.cpath = 1;
    if (cs.clip && cs.clip !== "auto") row.clip = 1;
    const z = cs.zIndex;
    if (z !== "auto") row.z = parseInt(z, 10) || 0;
    if (cs.transform && cs.transform !== "none") row.tf = 1;
    if ((cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none")) row.flt = 1;
    if (st.an) row.an = 1;
    const tag = el.tagName;
    if (tag === "IMG") {
      row.nw = el.naturalWidth;
      row.nh = el.naturalHeight;
      row.cmp = el.complete ? 1 : 0;
      row.iok = el.complete && el.naturalWidth > 0 ? 1 : 0;
      row.src = urlClass(el.currentSrc || el.getAttribute("src") || "");
      if (el.getAttribute("loading") === "lazy") row.lazy = 1;
      const of = OBJECT_FIT[cs.objectFit];
      if (of) row.of = of;
      row.alt = el.hasAttribute("alt") ? el.getAttribute("alt").length : -1;
      if (el.naturalWidth > 0 && el.naturalHeight > 0 && rect.width > 0 && rect.height > 0) row.dist = r2(Math.abs(rect.width / rect.height / (el.naturalWidth / el.naturalHeight) - 1));
    } else if (tag === "VIDEO") {
      row.rs = el.readyState;
      if (el.error) row.verr = el.error.code;
    } else if (String(tag).toLowerCase() === "svg") {
      row.vb = el.hasAttribute("viewBox") ? 1 : 0;
      row.wa = el.hasAttribute("width") ? 1 : 0;
    }
    if (bi && /url\(/.test(bi)) {
      const m = /url\(["']?([^"')]+)/.exec(bi);
      if (m) row.bsrc = urlClass(m[1]);
    }
    const leaks = scanLeaks(own);
    if (tag === "IMG" && el.getAttribute("alt")) for (const l of scanLeaks(el.getAttribute("alt"))) leaks.push(["alt:" + l[0], l[1]]);
    if (leaks.length) row.lk = leaks.slice(0, 4);
    // the five-point hit test, for targets in the viewport
    if (vis && inv > 0 && (row.tl || row.ia || row.tag === "img" || row.tag === "svg" || row.tag === "input" || row.tag === "video" || row.tag === "canvas")) {
      let self = 0;
      let other = 0;
      let anc = 0;
      let none = 0;
      for (const p of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
        const x = rect.left + rect.width * p[0];
        const y = rect.top + rect.height * p[1];
        if (x < 0 || y < 0 || x >= vw || y >= vh) {
          none++;
          continue;
        }
        const top = doc.elementFromPoint(x, y);
        if (!top) none++;
        else if (top === el || el.contains(top)) self++;
        else if (top.contains(el)) anc++;
        else other++;
      }
      row.hs = self;
      if (other) row.ho = other;
      if (anc) row.ha = anc;
      if (none) row.hn = none;
    }
    if (withVars) {
      const v = varsOf(el, cs);
      if (v.vu) row.vu = v.vu;
      if (v.vi) row.vi = v.vi;
      if (v.vp.length) row.vp = v.vp;
    }
    // the nearest rendered ancestor (eval.py's anc[0]) and the rendered children
    let parentRow: any = null;
    for (let a = el.parentElement; a && a !== html; a = a.parentElement) {
      const ar = a.getBoundingClientRect();
      if (ar.width * ar.height <= 0 || style(a).display === "none") continue;
      const acs = style(a);
      parentRow = { tag: String(a.tagName).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24), w: r1(ar.width), h: r1(ar.height) };
      const aox = OVF[acs.overflowX] || "v";
      const aoy = OVF[acs.overflowY] || "v";
      if (aox !== "v") parentRow.ox = aox;
      if (aoy !== "v") parentRow.oy = aoy;
      if (a.scrollWidth > a.clientWidth + 1 || a.scrollHeight > a.clientHeight + 1 || aox !== "v" || aoy !== "v") {
        parentRow.sw = a.scrollWidth;
        parentRow.sh = a.scrollHeight;
        parentRow.cw = a.clientWidth;
        parentRow.ch = a.clientHeight;
      }
      break;
    }
    const kidsOf = (e: any, depth: number): number => {
      let n = 0;
      for (const k of Array.from(e.children) as any[]) {
        if (SKIP[k.tagName] || style(k).display === "none") continue;
        const kr = k.getBoundingClientRect();
        if (kr.width * kr.height > 0) n++;
        else if (depth < 3) n += kidsOf(k, depth + 1);
        if (n > 500) break;
      }
      return n;
    };
    return { el: row, anc: parentRow, kids: kidsOf(el, 0) };
  };

  const store = (): any => {
    const d = Object.getOwnPropertyDescriptor(g, o.name);
    return d && d.value && Array.isArray(d.value.els) ? d.value : null;
  };

  if (cmd === "find") {
    const vw = g.innerWidth;
    const vh = g.innerHeight;
    const sx = g.scrollX || 0;
    const sy = g.scrollY || 0;
    const shotW = Number(o.shotW) || vw;
    const shotH = Number(o.shotH) || vh;
    const max = Math.max(0, Math.min(60, Number(o.max) || 30));
    const items: any[] = [];
    const els: any[] = [];
    const taken = new Set();
    const unmatched: string[] = [];
    // the visual checks' findings: their element by selector and box (document coordinates)
    for (const t of Array.isArray(o.targets) ? o.targets.slice(0, 60) : []) {
      let best: any = null;
      let bd = Infinity;
      let list: any[] = [];
      try {
        list = Array.prototype.slice.call(doc.querySelectorAll(String(t.selector || "")), 0, 80);
      } catch (e) {
        list = [];
      }
      const b = t.box || {};
      for (const el of list) {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + sx - b.x) + Math.abs(r.top + sy - b.y) + Math.abs(r.width - b.w) + Math.abs(r.height - b.h);
        if (d < bd) {
          bd = d;
          best = el;
        }
      }
      if (best && bd <= Math.max(12, 0.1 * ((b.w || 0) + (b.h || 0)))) {
        const r = best.getBoundingClientRect();
        taken.add(best);
        els.push(best);
        items.push({ i: els.length - 1, cls: "finding", key: String(t.key || ""), kind: String(t.kind || ""), sel: String(t.selector || "").slice(0, 200), box: { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) } });
      } else unmatched.push(String(t.key || ""));
    }
    // the elements the measured checks abstain on
    const found: any[] = [];
    if (o.find && body) {
      const base = rootBase();
      const memo = new Map();
      // extract.js resolveLayers along the ancestor chain, memoised: the first unreliable layer up to the first opaque one
      const chainStatus = (el: any): number => {
        if (!el || el === html || el.nodeType !== 1) return 1;
        if (memo.has(el)) return memo.get(el);
        const cs = style(el);
        const color = isSvgChild(el) ? [0, 0, 0, 0] : parseColor(cs.backgroundColor);
        let s = 0;
        if (!color) s = 5;
        else if (cs.backgroundImage && cs.backgroundImage !== "none") s = 2;
        else if (MEDIA[String(el.tagName).toUpperCase()]) s = 3;
        else if ((cs.filter && cs.filter !== "none") || (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.mixBlendMode && cs.mixBlendMode !== "normal")) s = 4;
        if (!s) s = color && color[3] >= 1 ? 0 : chainStatus(el.parentElement);
        memo.set(el, s);
        return s;
      };
      const stackStatus = (el: any, r: any): number => {
        const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
        const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
        const stack = doc.elementsFromPoint(cx, cy);
        const k = stack.indexOf(el);
        if (k < 0) return 7;
        const layers: any[] = [];
        for (let j = k; j < stack.length && layers.length < 24; j++) {
          const s = stack[j];
          const scs = style(s);
          layers.push({ color: isSvgChild(s) ? [0, 0, 0, 0] : parseColor(scs.backgroundColor), image: scs.backgroundImage && scs.backgroundImage !== "none", media: j > k && !!MEDIA[String(s.tagName).toUpperCase()], filter: (scs.filter && scs.filter !== "none") || (scs.backdropFilter && scs.backdropFilter !== "none") });
        }
        return resolveLayers(layers, base).status;
      };
      const covered = (el: any, r: any): boolean => {
        let other = 0;
        for (const p of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
          const x = r.left + r.width * p[0];
          const y = r.top + r.height * p[1];
          if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
          const top = doc.elementFromPoint(x, y);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) other++;
        }
        return other > 0;
      };
      const clipShare = (el: any, r: any): number => {
        let c = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
        for (let a = el.parentElement, n = 0; a && a !== html && n < 40; a = a.parentElement, n++) {
          const s = style(a);
          if (s.position === "fixed") break;
          if (s.overflowX !== "visible" || s.overflowY !== "visible") {
            const ar = a.getBoundingClientRect();
            c = intersect(c, { l: s.overflowX !== "visible" ? ar.left : -Infinity, r: s.overflowX !== "visible" ? ar.right : Infinity, t: s.overflowY !== "visible" ? ar.top : -Infinity, b: s.overflowY !== "visible" ? ar.bottom : Infinity });
          }
        }
        return insideShare({ l: r.left, t: r.top, r: r.right, b: r.bottom }, c);
      };
      const all = body.getElementsByTagName("*");
      for (let i = 0; i < all.length && i < 6000; i++) {
        const el = all[i];
        if (SKIP[el.tagName] || isSvgChild(el) || taken.has(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const dx = r.left + sx;
        const dy = r.top + sy;
        if (dy >= shotH || dy + r.height <= 0 || dx >= shotW || dx + r.width <= 0) continue;
        let shown = true;
        try {
          shown = el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
        } catch (e) {
          shown = true;
        }
        if (!shown) continue;
        // decoration and pictures (WCAG 1.4.3's incidental text), inert and closed parts: not what a visitor reads or uses
        if (el.closest('[aria-hidden="true"], [role="img"], [inert]')) continue;
        const dt = el.closest("details");
        if (dt && !dt.open && !el.closest("summary")) continue;
        const inFold = r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
        let cls = "";
        let rank = 9;
        if (interactive(el) && (el.textContent.trim() || el.querySelector("img, svg") || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) {
          if (inFold && covered(el, r)) {
            cls = "covered";
            rank = 0;
          } else {
            const share = clipShare(el, r);
            if (share > 0 && share < 0.9) {
              cls = "clipped";
              rank = inFold ? 1 : 4;
            } else if (o.dark) {
              cls = "dark-control";
              rank = inFold ? 2 : 4;
            }
          }
        }
        if (!cls) {
          const t = ownText(el).own;
          if (t.length >= 2) {
            const s = chainStatus(el);
            const ps = inFold ? stackStatus(el, r) : 0;
            if (s === 2 || s === 3 || s === 4 || ps === 2 || ps === 3 || ps === 4) {
              cls = "text-bg";
              rank = inFold ? 3 : 5;
            }
          }
        }
        if (!cls) continue;
        found.push({ el, cls, rank, x: Math.round(dx), y: Math.round(dy), w: Math.round(r.width), h: Math.round(r.height) });
        if (found.length >= 400) break;
      }
      found.sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x);
      const chosen: any[] = [];
      for (const f of found) {
        if (items.length + chosen.length >= max) break;
        // one crop per place: nothing inside or around an element already chosen
        if (chosen.some((c) => c.el.contains(f.el) || f.el.contains(c.el)) || els.some((e) => e.contains(f.el) || f.el.contains(e))) continue;
        chosen.push(f);
      }
      for (const f of chosen) {
        els.push(f.el);
        items.push({ i: els.length - 1, cls: f.cls, key: "", kind: "", sel: sel(f.el), box: { x: f.x, y: f.y, w: f.w, h: f.h } });
      }
    }
    Object.defineProperty(g, o.name, { value: { els }, writable: true, configurable: true, enumerable: false });
    return { ok: true, vw, vh, sx, sy, docH: Math.max(html.scrollHeight, body ? body.scrollHeight : 0), items, unmatched, considered: found.length };
  }

  if (cmd === "facts") {
    const s = store();
    if (!s) return { ok: false, error: "the elements were not found again" };
    const idx: number[] = Array.isArray(o.idx) ? o.idx.filter((i: any) => typeof i === "number" && s.els[i]).slice(0, 60) : [];
    const go = (y: number) => {
      try {
        g.scrollTo({ left: 0, top: y, behavior: "instant" });
      } catch (e) {
        g.scrollTo(0, y);
      }
    };
    if (o.mode === "end") go(Math.max(html.scrollHeight, body ? body.scrollHeight : 0));
    else if (o.mode === "focus" && idx.length) {
      try {
        s.els[idx[0]].focus();
      } catch (e) {
        /* not focusable */
      }
    } else if (typeof o.y === "number") go(Math.max(0, o.y));
    const frame = () => new Promise((resolve) => g.requestAnimationFrame(() => resolve(true)));
    const settle = Promise.race([frame().then(frame), new Promise((resolve) => g.setTimeout(resolve, 250))]);
    return settle.then(() => {
      styles.clear();
      const animated = new Set();
      try {
        for (const a of doc.getAnimations()) if (a.playState === "running" && a.effect && a.effect.target) animated.add(a.effect.target);
      } catch (e) {
        /* no Web Animations */
      }
      const base = rootBase();
      const page = pageFacts();
      const out: any[] = [];
      for (const i of idx) {
        const el = s.els[i];
        if (!el || !el.isConnected) continue;
        try {
          const f = factsOf(el, base, animated, (o.vars || []).indexOf(i) >= 0);
          out.push({ i, ...f });
        } catch (e) {
          /* skip this element */
        }
      }
      return { ok: true, sx: g.scrollX || 0, sy: g.scrollY || 0, vw: g.innerWidth, vh: g.innerHeight, page, items: out };
    });
  }

  if (cmd === "restore") {
    try {
      const a = doc.activeElement;
      if (a && a !== body && typeof a.blur === "function") a.blur();
    } catch (e) {
      /* nothing focused */
    }
    try {
      g.scrollTo({ left: 0, top: 0, behavior: "instant" });
    } catch (e) {
      g.scrollTo(0, 0);
    }
    return { ok: true };
  }
  return { ok: false, error: "unknown command" };
}

/** The source that runs judgePage in the page and returns its result as a JSON string. */
export function judgePageSource(cmd: "find" | "facts" | "restore", options: Record<string, unknown> = {}): string {
  return `(async () => JSON.stringify(await (${judgePage.toString()})(${JSON.stringify(cmd)}, ${JSON.stringify(options)})))()`;
}
