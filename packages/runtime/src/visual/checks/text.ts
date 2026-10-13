// Text checks (docs/runtime/VISUAL.md 3.8 to 3.12): text-invisible (contrast against a fully known solid
// background), text-template-leak, text-placeholder, text-encoding (one shared walk over text nodes) and
// css-var-undefined. judgeContrast, undefinedVarRefs and cssVarJudgeable are pure and unit-tested with fixtures.

import type { Ctx, Draft } from "../draft.js";
import { fixed2, named } from "../draft.js";
import { AA_LARGE_RATIO, composite, contrast, DARK_CANVASES, INVISIBLE_RATIO, isLargeText, over, parseColor, suggestColor, targetRatio, toHex, toRgb, WHITE, type RGBA } from "../math.js";
import { containsDeep, inShadow, layersAt, rootInfo, safeMatches, textPoints, type Layer, type Reader, type RootInfo } from "../measure.js";
import { excerpt, placeholderHost, scanText, WEAK_VALUES, type TextPattern } from "../patterns.js";

// ------------------------------------------------------------------------------------------- contrast verdict

export interface ContrastInput {
  /** Computed `color`. */
  fg: string;
  /** Computed `-webkit-text-fill-color`, when it differs from `color`. */
  fill?: string;
  /** background-clip: text (gradient text). */
  clipText?: boolean;
  /** -webkit-text-stroke-width in px. */
  stroke?: number;
  /** Computed text-shadow. */
  shadow?: string;
  fontPx: number;
  weight: number;
  /** One layer chain per sample point: the element first, down to the first opaque layer (or the whole stack). */
  chains: Layer[][];
  root: RootInfo;
  /** The element or an ancestor has opacity strictly between 0 and 1. */
  translucent?: boolean;
  /** Fully transparent text with a visible copy of the same text under it (layout reservers, typewriter effects). */
  stackedCopy?: boolean;
}

export type ContrastVerdict =
  | { verdict: "unknown"; reason: string }
  | { verdict: "ok" | "low"; ratio: number; fg: RGBA; bg: RGBA; large: boolean; target: number; transparent: boolean; layer: number; canvas: boolean };

const sameColor = (a: RGBA, b: RGBA) => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[1] - b[1]) <= 1 && Math.abs(a[2] - b[2]) <= 1;

/**
 * VISUAL.md 2.4 and 3.8: the contrast of text against its fully resolved background. "unknown" (abstain) whenever the
 * background is not a known solid colour: an image or gradient, a replaced element, a filter or blend mode, a pseudo
 * layer, partial opacity, a text shadow or stroke, sample points that disagree, or a dark canvas the verdict depends on.
 */
export function judgeContrast(i: ContrastInput): ContrastVerdict {
  if (i.shadow && i.shadow !== "none") return { verdict: "unknown", reason: "text-shadow" };
  if ((i.stroke ?? 0) > 0) return { verdict: "unknown", reason: "text-stroke" };
  if (i.translucent) return { verdict: "unknown", reason: "opacity" };
  const fill = i.fill ? parseColor(i.fill) : null;
  const fg = fill ?? parseColor(i.fg);
  if (!fg) return { verdict: "unknown", reason: "color-unparsed" };
  const transparent = fg[3] === 0;
  if (transparent && i.clipText) return { verdict: "unknown", reason: "gradient-text" };
  if (transparent && i.stackedCopy) return { verdict: "unknown", reason: "stacked-copy" };
  if (!i.chains.length) return { verdict: "unknown", reason: "no-points" };
  const canvases = i.root.darkCanvas ? DARK_CANVASES : [WHITE];
  let result: ContrastVerdict | null = null;
  for (const canvas of canvases) {
    let bg: RGBA | null = null;
    let layer = -1;
    let usedCanvas = false;
    for (const chain of i.chains) {
      const cols: RGBA[] = [];
      for (const l of chain) {
        if (l.abstain) return { verdict: "unknown", reason: l.abstain };
        const c = parseColor(l.bg);
        if (!c) return { verdict: "unknown", reason: "background-unparsed" };
        cols.push(c);
        if (c[3] >= 1) break;
      }
      const opaque = cols.findIndex((c) => c[3] >= 1);
      const b = composite(cols, canvas);
      if (!b) return { verdict: "unknown", reason: "background-unknown" };
      if (bg && !sameColor(bg, b)) return { verdict: "unknown", reason: "mixed-background" };
      if (!bg) {
        bg = b;
        layer = opaque;
        usedCanvas = opaque < 0;
      }
    }
    if (!bg) return { verdict: "unknown", reason: "background-unknown" };
    const shown = fg[3] < 1 ? over(fg, bg) : fg;
    const ratio = transparent ? 1 : contrast(shown, bg);
    const v: ContrastVerdict = {
      verdict: ratio < INVISIBLE_RATIO ? "low" : "ok",
      ratio,
      fg: shown,
      bg,
      large: isLargeText(i.fontPx, i.weight),
      target: targetRatio(i.fontPx, i.weight),
      transparent,
      layer,
      canvas: usedCanvas,
    };
    if (result && result.verdict !== v.verdict) return { verdict: "unknown", reason: "dark-canvas-mixed" };
    if (!result || (v.verdict === "low" && result.verdict === "low" && v.ratio > (result as { ratio: number }).ratio)) result = v;
    if (!usedCanvas) break; // the canvas played no part: one evaluation is enough
  }
  return result ?? { verdict: "unknown", reason: "background-unknown" };
}

// --------------------------------------------------------------------------------------------- text walk

const EXCLUDED = new Set(["CODE", "PRE", "KBD", "SAMP", "VAR", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "MATH", "SVG", "IFRAME"]);

export interface TextScan {
  /** Pattern id -> matches. */
  hits: Map<string, { p: TextPattern; node: Text; el: Element; index: number; count: number }>;
  /** Elements with a direct text node in the viewport, for text-invisible (at most 200). */
  cands: Element[];
  candSet: Set<Element>;
  weak: number;
  nodes: number;
}

export function newScan(): TextScan {
  return { hits: new Map(), cands: [], candSet: new Set(), weak: 0, nodes: 0 };
}

function excluded(el: Element): boolean {
  return EXCLUDED.has(el.tagName.toUpperCase()) || el.hasAttribute("data-genclass-ignore") || (el as HTMLElement).isContentEditable === true;
}

/** One walk over text nodes under `roots` (at most `limit`): patterns and text-invisible candidates. */
export function* walkText(ctx: Ctx, roots: Element[], scan: TextScan, limit: number, wantCands: boolean): Generator<void> {
  const doc = ctx.r.doc;
  const SHOW = 0x1 | 0x4; // elements and text
  for (const root of roots) {
    if (!root.isConnected) continue;
    const tw = doc.createTreeWalker(root, SHOW, {
      acceptNode: (n: Node) => (n.nodeType === 1 ? (excluded(n as Element) ? 2 : 3) : 1), // REJECT, SKIP, ACCEPT
    });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (scan.nodes >= limit) return;
      const t = n as Text;
      const data = t.data;
      if (!data || !data.trim()) continue;
      scan.nodes++;
      const el = t.parentElement;
      if (!el) continue;
      if (scan.nodes % 25 === 0) yield;
      const trimmed = data.trim();
      if (WEAK_VALUES.has(trimmed)) scan.weak++;
      const found = scanText(data);
      for (const f of found) {
        if (!ctx.on(f.p.kind) || !ctx.r.visible(el)) continue;
        const h = scan.hits.get(f.p.id);
        if (h) h.count++;
        else scan.hits.set(f.p.id, { p: f.p, node: t, el, index: f.index, count: 1 });
      }
      if (wantCands && scan.cands.length < 200 && !scan.candSet.has(el)) {
        scan.candSet.add(el);
        if (ctx.r.inViewport(el)) scan.cands.push(el);
      }
    }
  }
}

/** Placeholder images (placehold.co and similar) among visible images. */
export function placeholderImages(ctx: Ctx, roots: Element[], scan: TextScan): void {
  if (!ctx.on("text-placeholder")) return;
  for (const root of roots) {
    const imgs: Element[] = root === ctx.r.doc.body ? [...ctx.r.doc.images] : [...root.querySelectorAll("img")];
    for (const img of imgs.slice(0, ctx.max) as HTMLImageElement[]) {
      const host = placeholderHost(img.currentSrc || img.src || "", ctx.ignore);
      if (!host) continue;
      const id = `placeholder-image:${host}`;
      if (!ctx.r.visible(img)) continue;
      const h = scan.hits.get(id);
      if (h) h.count++;
      else
        scan.hits.set(id, { p: { id, kind: "text-placeholder", re: /$^/, label: `placeholder images from ${host}` }, node: img.firstChild as Text, el: img, index: 0, count: 1 });
    }
  }
}

/** Drafts for the pattern hits (confirmed 2 s later after network quiet, VISUAL.md 3.9). */
export function patternDrafts(ctx: Ctx, scan: TextScan, out: Draft[]): void {
  for (const [id, h] of scan.hits) {
    const kind = h.p.kind;
    const isImg = id.startsWith("placeholder-image:");
    const text = isImg ? "" : h.node.data;
    const ex = isImg ? (h.el as HTMLImageElement).currentSrc : excerpt(text, h.index);
    const fixText =
      kind === "text-template-leak"
        ? 'the fix is in code: format values before rendering (for example {price != null ? formatPrice(price) : "-"}), never interpolate an object, and check the template engine runs on this route'
        : kind === "text-placeholder"
          ? "replace the placeholder copy and images; a CI grep for lorem ipsum and the placeholder hosts keeps them out"
          : "serve Content-Type: text/html; charset=utf-8, put <meta charset=\"utf-8\"> first in <head>, store text as utf8mb4 and escape once";
    const d: Draft = {
      kind,
      el: h.el,
      key: `${kind}|${id}`,
      severity: kind === "text-template-leak" ? "high" : "medium",
      count: h.count,
      measured: { pattern: id, excerpt: ex.slice(0, 80), count: h.count, ...(kind === "text-encoding" ? { charset: ctx.r.doc.characterSet } : {}) },
      threshold: { value: h.p.label, unit: "pattern", source: "rendered text, still present 2 s later after network quiet" },
      text: `the page shows ${h.p.label} in ${named(ctx, h.el)}${isImg ? "" : `: "${ex}"`}${h.count > 1 ? ` (${h.count} places)` : ""}.`,
      fixText,
      persistMs: 2000,
      quiet: true,
      recheck: (r) => {
        if (!h.el.isConnected || !r.visible(h.el)) return null;
        if (isImg) return (h.el as HTMLImageElement).currentSrc === ex ? d : null;
        return h.node.isConnected && h.p.re.test(h.node.data) ? d : null;
      },
    };
    if (kind === "text-template-leak" && (id === "mustache" || id === "template-literal")) d.suggestion = { selector: "[v-cloak]", css: "display: none;", note: "Only for uncompiled Vue templates (Angular: ng-cloak); otherwise the template is not rendering on this route." };
    out.push(d);
  }
}

// --------------------------------------------------------------------------------------------- text-invisible

/** The input judgeContrast needs, read from the page for one element (null: skipped before measuring). */
export function contrastInput(r: Reader, el: Element, rootI: RootInfo): ContrastInput | null {
  const s = r.cs(el);
  const fontPx = parseFloat(s.fontSize) || 0;
  if (fontPx < 6) return null;
  const pts = textPoints(r, el);
  const chains: Layer[][] = [];
  let copy = false;
  const fill = (s as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor;
  const fg = parseColor(fill && fill !== s.color ? fill : s.color);
  for (const p of pts) {
    const l = layersAt(r, el, p.x, p.y);
    if (l === "covered" || l === "outside") continue;
    chains.push(l);
    if (fg && fg[3] === 0 && !copy) {
      const text = (el.textContent ?? "").trim();
      const st = r.stack(p.x, p.y);
      copy = st.slice(st.indexOf(el) + 1).some((x) => !containsDeep(x, el) && (x.textContent ?? "").trim() === text && r.visible(x));
    }
  }
  if (!chains.length) return null;
  const clip = (s as CSSStyleDeclaration & { webkitBackgroundClip?: string }).webkitBackgroundClip;
  return {
    fg: s.color,
    ...(fill && fill !== s.color ? { fill } : {}),
    clipText: s.backgroundClip === "text" || clip === "text",
    stroke: parseFloat((s as CSSStyleDeclaration & { webkitTextStrokeWidth?: string }).webkitTextStrokeWidth ?? "0") || 0,
    shadow: s.textShadow,
    fontPx,
    weight: parseInt(s.fontWeight, 10) || 400,
    chains,
    root: rootI,
    translucent: r.translucent(el),
    stackedCopy: copy,
  };
}

/** Elements text-invisible never judges: disabled controls and their labels, SVG text, a single icon glyph. */
export function skipText(el: Element): boolean {
  if (safeMatches(el, ":disabled, [aria-disabled=true]") || el.closest(':disabled, [aria-disabled="true"], svg')) return true;
  const label = el.closest("label") as HTMLLabelElement | null;
  if (label && (label.control as HTMLInputElement | null)?.disabled) return true;
  const t = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => (c as Text).data).join("").trim();
  if ([...t].length === 1) {
    const cp = t.codePointAt(0) ?? 0;
    if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  }
  return false;
}

export interface ContrastRead {
  v: ContrastVerdict;
  input: ContrastInput;
}

/** Measure one element (null: skipped or abstained; the reason is counted through ctx.abstain). */
export function readContrast(ctx: Ctx, r: Reader, el: Element, rootI: RootInfo): ContrastRead | null {
  if (!el.isConnected || skipText(el) || !r.visible(el)) return null;
  const input = contrastInput(r, el, rootI);
  if (!input) return null;
  const v = judgeContrast(input);
  if (v.verdict === "unknown") {
    ctx.abstain(`text-invisible:${v.reason}`);
    return null;
  }
  return { v, input };
}

/** A text-invisible draft for a low verdict (state: rest unless measured on hover or focus). */
export function contrastDraft(ctx: Ctx, el: Element, read: ContrastRead, state: "rest" | "hover" | "focus" | "touch", restRatio?: number): Draft {
  const v = read.v as Extract<ContrastVerdict, { verdict: "low" | "ok" }>;
  const sel = ctx.sel(el);
  const sug = suggestColor([v.fg[0], v.fg[1], v.fg[2], 1], v.bg, v.target);
  const layer = v.layer >= 0 ? read.input.chains[0]?.[v.layer]?.el : undefined;
  const from = layer ? ctx.sel(layer) : v.canvas ? `the page canvas (${ctx.scheme})` : "the page";
  const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  const stateSel = state === "rest" ? sel : `${sel}:hover, ${sel}:focus-visible`;
  const fill = !!read.input.fill;
  const d: Draft = {
    kind: "text-invisible",
    el,
    key: `text-invisible|${sel}|${state}|${ctx.scheme}`,
    severity: "high",
    state,
    measured: {
      ratio: v.ratio,
      fg: toHex(v.fg),
      bg: toHex(v.bg),
      bgFrom: from,
      fontPx: Math.round(read.input.fontPx * 100) / 100,
      fontWeight: read.input.weight,
      large: v.large,
      ...(v.transparent ? { transparent: true } : {}),
      ...(restRatio !== undefined ? { restRatio } : {}),
      text: t.slice(0, 40),
    },
    threshold: { value: INVISIBLE_RATIO, unit: ":1 contrast", source: "WCAG 2.2 contrast formula; unreadable-text threshold (VISUAL.md 3.8)" },
    text: `text contrast ${fixed2(v.ratio)}:1 ${state === "rest" ? "" : `on ${state} `}on ${named(ctx, el)}, below ${INVISIBLE_RATIO}:1 (WCAG 2.2 contrast formula; unreadable-text threshold): ${v.transparent ? "transparent text" : toHex(v.fg)} on ${toHex(v.bg)} from ${from}${restRatio !== undefined ? `; ${fixed2(restRatio)}:1 at rest` : ""}.`,
    suggestion: {
      selector: stateSel,
      css: `color: ${toHex(sug)};${fill ? ` -webkit-text-fill-color: ${toHex(sug)};` : ""}`,
      note: `Reaches ${v.target}:1${v.large ? " (large text)" : ""}. Set colour and background together on the same selector, add the dark-mode variant, or remove a prefers-color-scheme: dark block the site has no design for.`,
    },
    details: [`Sample points: ${read.input.chains.length}; scheme: ${ctx.scheme}; state: ${state}.`],
  };
  if (state === "rest") d.plan = { type: "color", kind: "text-invisible", el, color: toRgb(sug), fill, target: v.target };
  return d;
}

/** Measure the candidates (at most 200), producing persistence-checked drafts; records rest ratios for state checks. */
export function* measureContrast(ctx: Ctx, cands: Element[], out: Draft[], rest: WeakMap<Element, number>): Generator<void> {
  if (!ctx.on("text-invisible")) return;
  const rootI = rootInfo(ctx.r);
  for (const el of cands.slice(0, 200)) {
    yield;
    const read = readContrast(ctx, ctx.r, el, rootI);
    if (!read || read.v.verdict === "unknown") continue;
    rest.set(el, read.v.ratio);
    if (read.v.verdict !== "low") continue;
    if (ctx.r.animating(el)) continue;
    const d = contrastDraft(ctx, el, read, "rest");
    d.persistMs = 1000;
    d.recheck = (r) => {
      if (r.animating(el)) return null;
      const again = readContrast(ctx, r, el, rootInfo(r));
      return again && again.v.verdict === "low" ? contrastDraft(ctx, el, again, "rest") : null;
    };
    out.push(d);
  }
}

// --------------------------------------------------------------------------------------------- css-var-undefined

const VAR_NO_FALLBACK = /var\(\s*(--[\w-]+)\s*\)/g;

/** VISUAL.md 3.12: references without a fallback to custom properties defined nowhere (Tailwind internals excluded). */
export function undefinedVarRefs(decls: { selector: string; prop: string; value: string }[], defined: Set<string>): { name: string; selector: string; prop: string }[] {
  const out: { name: string; selector: string; prop: string }[] = [];
  for (const d of decls) {
    for (const m of d.value.matchAll(VAR_NO_FALLBACK)) {
      const name = m[1];
      if (name.startsWith("--tw-") || defined.has(name)) continue;
      out.push({ name, selector: d.selector, prop: d.prop });
    }
  }
  return out;
}

/** Rules, defined names and references of the readable stylesheets; null when one cannot be read (abstain). */
export function readSheets(doc: Document, limit = 5000): { decls: { selector: string; prop: string; value: string; href: string }[]; defined: Set<string> } | null {
  const decls: { selector: string; prop: string; value: string; href: string }[] = [];
  const defined = new Set<string>();
  let n = 0;
  const walk = (rules: CSSRuleList, href: string): void => {
    for (const rule of rules) {
      if (++n > limit) return;
      const name = (rule as { name?: string }).name;
      if (rule.constructor?.name === "CSSPropertyRule" && name) defined.add(name);
      const st = (rule as CSSStyleRule).style;
      const sel = (rule as CSSStyleRule).selectorText;
      if (st) {
        for (let i = 0; i < st.length; i++) if (st[i].startsWith("--")) defined.add(st[i]);
        if (sel && st.cssText.includes("var(")) {
          for (const part of st.cssText.split(";")) {
            const c = part.indexOf(":");
            if (c < 0) continue;
            const prop = part.slice(0, c).trim();
            const value = part.slice(c + 1).trim();
            if (prop.startsWith("--")) defined.add(prop);
            if (value.includes("var(")) decls.push({ selector: sel, prop, value, href });
          }
        }
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) walk(inner, href);
    }
  };
  const sheets = [...doc.styleSheets, ...((doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])];
  for (const sh of sheets) {
    let rules: CSSRuleList;
    try {
      rules = sh.cssRules;
    } catch {
      return null;
    }
    walk(rules, sh.href ?? "inline <style>");
  }
  for (const el of doc.querySelectorAll('[style*="--"]')) {
    const st = (el as HTMLElement).style;
    for (let i = 0; i < st.length; i++) if (st[i].startsWith("--")) defined.add(st[i]);
  }
  return { decls, defined };
}

/**
 * Properties whose undefined var() can leave text unreadable: the text colour falls back to the inherited one, or the
 * background to transparent. The bench (bench/visual, VISUAL.md 19) found no visible effect for the other properties
 * on public sites: layout tokens a script sets only when needed (a banner height), optional per-token theme variables
 * (font-style, text-decoration), custom-property aliases.
 */
export const CSS_VAR_PROPS = new Set(["color", "background-color", "background"]);
const STATE_OR_PSEUDO = /::|:(?:hover|focus|focus-visible|focus-within|active|visited|target|checked|before|after|first-line|first-letter|marker|selection|placeholder|backdrop)\b/;

/**
 * Whether an undefined reference can be judged on the page at rest: not a custom-property declaration (an alias only
 * matters where it is used), a colour property, and a rule without a state pseudo-class or a pseudo-element (it does
 * not apply at rest, so its fallback cannot be measured).
 */
export function cssVarJudgeable(ref: { prop: string; selector: string }): "ok" | "custom-property" | "property" | "state-rule" {
  if (ref.prop.startsWith("--")) return "custom-property";
  if (!CSS_VAR_PROPS.has(ref.prop)) return "property";
  if (STATE_OR_PSEUDO.test(ref.selector)) return "state-rule";
  return "ok";
}

/** The text css-var-undefined judges: the element's own text, else its first visible descendant with text. */
function textOf(r: Reader, el: Element, sameColor: string | null): Element | null {
  if ([...el.childNodes].some((c) => c.nodeType === 3 && (c as Text).data.trim())) return el;
  let n = 0;
  for (const d of el.querySelectorAll("*")) {
    if (++n > 200) break;
    if (![...d.childNodes].some((c) => c.nodeType === 3 && (c as Text).data.trim())) continue;
    if (sameColor !== null && r.cs(d).color !== sameColor) continue;
    if (r.visible(d) && r.inViewport(d)) return d;
  }
  return null;
}

/**
 * One reference, measured: the declaration is in effect (the property shows its fallback, so no other rule won the
 * cascade) and the text it affects reads below 3:1. Null when it is not reportable; the reason is counted.
 */
function cssVarRead(ctx: Ctx, el: Element, prop: string): { textEl: Element; ratio: number } | null {
  const r = ctx.r;
  const s = r.cs(el);
  if (prop === "color") {
    const p = el.parentElement;
    if (!p || s.color !== r.cs(p).color) {
      ctx.abstain("css-var-undefined:overridden");
      return null;
    }
  } else {
    const bg = parseColor(s.backgroundColor);
    if (!bg || bg[3] > 0 || (s.backgroundImage && s.backgroundImage !== "none")) {
      ctx.abstain("css-var-undefined:overridden");
      return null;
    }
  }
  const textEl = textOf(r, el, prop === "color" ? s.color : null);
  if (!textEl) {
    ctx.abstain("css-var-undefined:no-text");
    return null;
  }
  const read = readContrast(ctx, r, textEl, rootInfo(r));
  if (!read || read.v.verdict === "unknown") return null;
  if (read.v.ratio >= AA_LARGE_RATIO) {
    ctx.abstain("css-var-undefined:readable");
    return null;
  }
  return { textEl, ratio: read.v.ratio };
}

export function cssVarDrafts(ctx: Ctx, out: Draft[]): void {
  if (!ctx.on("css-var-undefined")) return;
  const doc = ctx.r.doc;
  const sheets = readSheets(doc);
  if (!sheets) {
    ctx.abstain("css-var-undefined:unreadable-sheet");
    return;
  }
  const refs = undefinedVarRefs(sheets.decls, sheets.defined);
  const byName = new Map<string, { selector: string; prop: string; href: string; el: Element; textEl: Element; ratio: number }[]>();
  const rootCs = ctx.r.cs(doc.documentElement);
  for (const ref of refs.slice(0, 200)) {
    const why = cssVarJudgeable(ref);
    if (why !== "ok") {
      ctx.abstain(`css-var-undefined:${why}`);
      continue;
    }
    if (rootCs.getPropertyValue(ref.name).trim()) continue;
    let el: Element | null = null;
    try {
      el = ref.selector.trim() ? doc.querySelector(ref.selector) : null;
    } catch {
      el = null;
    }
    // html and body: theme-scope rules whose root colours the other root element or the descendants paint over
    if (!el || el === doc.documentElement || el === doc.body || inShadow(el) || !ctx.r.visible(el)) continue;
    if (ctx.r.cs(el).getPropertyValue(ref.name).trim()) continue;
    const m = cssVarRead(ctx, el, ref.prop);
    if (!m) continue;
    const href = sheets.decls.find((d) => d.selector === ref.selector && d.prop === ref.prop)?.href ?? "";
    const list = byName.get(ref.name) ?? [];
    list.push({ ...ref, href, el, ...m });
    byName.set(ref.name, list);
  }
  for (const [name, list] of byName) {
    const first = list[0];
    const fallback = first.prop === "color" ? "the inherited colour" : "transparent";
    const d: Draft = {
      kind: "css-var-undefined",
      el: first.el,
      els: list.map((x) => x.el),
      count: list.length,
      key: `css-var-undefined|${name}`,
      severity: "medium",
      measured: { variable: name, property: first.prop, rule: first.selector.slice(0, 120), sheet: first.href.slice(0, 120), rules: list.length, ratio: Math.floor(first.ratio * 100) / 100 },
      threshold: { value: AA_LARGE_RATIO, unit: ":1 contrast of the text it affects", source: "a var() defined in no readable stylesheet, @property or inline style and empty at computed-value time, whose fallback leaves text below 3:1 (WCAG 2.2 large-text minimum)" },
      text: `${first.prop}: var(${name}) in "${first.selector.slice(0, 80)}" uses a custom property defined nowhere, so ${first.prop} falls back to ${fallback} and the text on ${named(ctx, first.textEl)} reads at ${fixed2(first.ratio)}:1 (below 3:1).`,
      suggestion: { selector: ":root", css: `${name}: <value>;`, note: `Define the token, check the theme CSS is imported, or add a fallback: var(${name}, <value>). After a Tailwind v4 or shadcn/ui upgrade, v3-style hsl(var(--x)) can point at tokens that no longer exist.` },
      persistMs: 1000,
    };
    d.recheck = (r) => {
      if (!first.el.isConnected || !r.visible(first.el)) return null;
      if (r.cs(doc.documentElement).getPropertyValue(name).trim() || r.cs(first.el).getPropertyValue(name).trim()) return null;
      const again = cssVarRead({ ...ctx, r }, first.el, first.prop);
      return again ? d : null;
    };
    out.push(d);
  }
}
