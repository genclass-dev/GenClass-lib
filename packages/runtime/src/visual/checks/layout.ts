// Layout checks (docs/runtime/VISUAL.md 3.13 to 3.17): image-distorted, page-overflow-x, viewport-meta-missing,
// layout-shift, page-blank. The thresholds live in math.ts; the verdict functions here are pure where they can be.

import type { Ctx, Draft } from "../draft.js";
import { named, px } from "../draft.js";
import { distortion, isDistorted, overflowsX, shiftWindows } from "../math.js";
import type { Reader } from "../measure.js";

// ---------------------------------------------------------------------------------------------- image-distorted

const isSvg = (url: string) => /\.svg(\?|#|$)/i.test(url) || url.startsWith("data:image/svg");

function contentBox(r: Reader, el: HTMLElement): { w: number; h: number } {
  const s = r.cs(el);
  const p = (v: string) => parseFloat(v) || 0;
  return { w: el.clientWidth - p(s.paddingLeft) - p(s.paddingRight), h: el.clientHeight - p(s.paddingTop) - p(s.paddingBottom) };
}

function distortedDraft(ctx: Ctx, r: Reader, img: HTMLImageElement): Draft | null {
  if (!img.isConnected || !img.complete || img.naturalWidth <= 5 || img.naturalHeight <= 5) return null;
  if (isSvg(img.currentSrc || img.src || "")) return null;
  if (!r.visible(img) || r.animating(img)) return null;
  const s = r.cs(img);
  if (s.objectFit !== "fill" || /pixelated|crisp-edges/.test(s.imageRendering)) return null;
  const { w, h } = contentBox(r, img);
  if (!isDistorted(w, h, img.naturalWidth, img.naturalHeight)) return null;
  const d = distortion(w, h, img.naturalWidth, img.naturalHeight);
  const sel = ctx.sel(img);
  return {
    kind: "image-distorted",
    el: img,
    key: `image-distorted|${sel}|${img.currentSrc || img.src}`,
    severity: "medium",
    measured: { width: Math.round(w), height: Math.round(h), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, distortion: Math.round(d * 1000) / 10, objectFit: s.objectFit },
    threshold: { value: 5, unit: "% aspect mismatch (and more than 2 px)", source: "rendered content box against natural size, object-fit fill (Lighthouse image-aspect-ratio uses 2 px)" },
    text: `an image is ${w / h > img.naturalWidth / img.naturalHeight ? "stretched" : "squashed"} on ${named(ctx, img)}: shown at ${Math.round(w)} x ${px(h)}, its file is ${img.naturalWidth} x ${img.naturalHeight} (${Math.round(d * 100)}% aspect mismatch, above 5% and 2 px).`,
    suggestion: { selector: sel, css: "object-fit: cover;", note: `Or height: auto when only the width is fixed; width and height attributes should match the file's ratio (${img.naturalWidth} x ${img.naturalHeight}).` },
  };
}

export function* distortedImages(ctx: Ctx, roots: Element[], out: Draft[]): Generator<void> {
  if (!ctx.on("image-distorted")) return;
  for (const root of roots) {
    const imgs: Element[] = root === ctx.r.doc.body ? [...ctx.r.doc.images] : [...(root.tagName === "IMG" ? [root] : []), ...root.querySelectorAll("img")];
    for (const img of imgs.slice(0, ctx.max) as HTMLImageElement[]) {
      yield;
      const d = distortedDraft(ctx, ctx.r, img);
      if (!d) continue;
      d.persistMs = 1000;
      d.recheck = (r) => distortedDraft(ctx, r, img);
      out.push(d);
    }
  }
}

// ---------------------------------------------------------------------------------------------- page-overflow-x

export interface OverflowFact {
  scrollWidth: number;
  clientWidth: number;
  /** The viewport clips sideways overflow (html, or body when html is visible: overflow-x hidden or clip). */
  clipped: boolean;
  rtl: boolean;
}

export function overflowFact(r: Reader): OverflowFact {
  const html = r.doc.documentElement;
  let ox = r.cs(html).overflowX;
  if (ox === "visible" && r.doc.body) ox = r.cs(r.doc.body).overflowX;
  return { scrollWidth: html.scrollWidth, clientWidth: html.clientWidth, clipped: ox === "hidden" || ox === "clip", rtl: r.cs(html).direction === "rtl" };
}

/** VISUAL.md 3.14: the page scrolls sideways and the viewport does not clip it. */
export function overflowReportable(f: OverflowFact): boolean {
  return !f.clipped && overflowsX(f.scrollWidth, f.clientWidth);
}

const clips = (s: CSSStyleDeclaration) => /hidden|clip|auto|scroll/.test(s.overflowX) || /paint|strict|content/.test(s.contain);

interface Culprit {
  el: Element;
  edge: number;
  cause: string;
  css: string;
  sel: string;
}

function causeOf(ctx: Ctx, r: Reader, el: Element, cw: number): { cause: string; css: string; sel: string } {
  const s = r.cs(el);
  const rc = r.rect(el);
  const sel = ctx.sel(el);
  const tag = el.tagName.toLowerCase();
  if (["img", "video", "iframe", "embed", "object", "canvas"].includes(tag)) return { cause: `a <${tag}> without max-width`, css: "max-width: 100%; height: auto;", sel };
  if (tag === "table" || tag === "pre") return { cause: `a wide <${tag}>`, css: "display: block; max-width: 100%; overflow-x: auto;", sel };
  if (rc.width >= r.win.innerWidth && cw < r.win.innerWidth && Math.abs(rc.width - r.win.innerWidth) <= 1) return { cause: "a width of 100vw with a classic scrollbar", css: "width: 100%;", sel };
  if (s.transform && s.transform !== "none") {
    const p = el.parentElement;
    return { cause: "a transformed (off-canvas) element", css: "overflow-x: clip;", sel: p ? ctx.sel(p) : sel };
  }
  if (parseFloat(s.marginRight) < 0 || parseFloat(s.marginLeft) < 0) return { cause: "a negative margin", css: "margin-inline: 0;", sel };
  const text = [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => (c as Text).data).join(" ");
  const long = text.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  if (long >= 30 && s.overflowWrap === "normal" && s.wordBreak === "normal") return { cause: `an unbroken word of ${long} characters`, css: "overflow-wrap: anywhere;", sel };
  const p = el.parentElement;
  if (p && /flex|grid/.test(r.cs(p).display) && s.minWidth === "auto") return { cause: "a flex or grid item that cannot shrink", css: "min-width: 0;", sel };
  return { cause: "a width wider than the viewport", css: "max-width: 100%;", sel };
}

/** The outermost elements past the right edge (left edge for RTL), at most 3, outside any clipping ancestor. */
export function* overflowCulprits(ctx: Ctx, r: Reader, f: OverflowFact, out: Culprit[]): Generator<void> {
  const body = r.doc.body;
  if (!body) return;
  const queue: Element[] = [...body.children];
  let n = 0;
  while (queue.length && n < 3000 && out.length < 3) {
    const el = queue.shift()!;
    n++;
    if (n % 20 === 0) yield;
    if (el.hasAttribute("data-genclass-ignore")) continue;
    const s = r.cs(el);
    if (s.display === "none" || s.position === "fixed") continue;
    const rc = r.rect(el);
    const edge = f.rtl ? rc.left + r.win.scrollX : rc.right + r.win.scrollX;
    const past = f.rtl ? edge < -1 : edge > f.clientWidth + 1;
    if (past && rc.width > 0) {
      out.push({ el, edge, ...causeOf(ctx, r, el, f.clientWidth) });
      continue;
    }
    if (clips(s)) continue;
    queue.push(...el.children);
  }
}

function overflowDraft(ctx: Ctx, r: Reader, f: OverflowFact, culprits: Culprit[]): Draft {
  const coarse = !!ctx.win.matchMedia?.("(pointer: coarse)").matches;
  const c = culprits[0];
  const excess = f.scrollWidth - f.clientWidth;
  const el = c?.el ?? r.doc.documentElement;
  return {
    kind: "page-overflow-x",
    el,
    els: culprits.map((x) => x.el),
    key: `page-overflow-x|${c ? c.sel : "page"}|${f.clientWidth}`,
    severity: f.clientWidth <= 640 || coarse ? "high" : "medium",
    measured: {
      scrollWidth: f.scrollWidth,
      clientWidth: f.clientWidth,
      excess,
      ...(c ? { culprit: c.sel, edge: Math.round(c.edge), cause: c.cause } : { culprit: "not found within 3,000 elements" }),
      ...(culprits.length > 1 ? { others: culprits.slice(1).map((x) => x.sel).join(", ") } : {}),
    },
    threshold: { value: 1, unit: "px of scroll width beyond the client width", source: "documentElement.scrollWidth > clientWidth + 1, the viewport not clipping, 1 s apart" },
    text: c
      ? `the page scrolls sideways on a ${f.clientWidth} px viewport: ${named(ctx, c.el)} ends at ${px(c.edge)} (${excess} px too wide, ${c.cause}).`
      : `the page scrolls sideways on a ${f.clientWidth} px viewport (${excess} px too wide); no single element past the edge was found.`,
    ...(c ? { suggestion: { selector: c.sel, css: c.css } } : { fixText: "look for wide media, 100vw widths, negative margins and off-canvas panels" }),
  };
}

export function* pageOverflow(ctx: Ctx, out: Draft[]): Generator<void> {
  if (!ctx.on("page-overflow-x")) return;
  const f = overflowFact(ctx.r);
  if (!overflowReportable(f)) return;
  const culprits: Culprit[] = [];
  yield* overflowCulprits(ctx, ctx.r, f, culprits);
  if (culprits.some((c) => ctx.r.animating(c.el))) return;
  const d = overflowDraft(ctx, ctx.r, f, culprits);
  d.persistMs = 1000;
  d.recheck = (r) => {
    const g = overflowFact(r);
    if (!overflowReportable(g) || culprits.some((c) => r.animating(c.el))) return null;
    return d;
  };
  out.push(d);
}

// ---------------------------------------------------------------------------------------- viewport-meta-missing

/** VISUAL.md 3.15: a phone shows the default 980 px layout because no viewport meta sets width=device-width. */
export function viewportMetaMissing(o: { coarse: boolean; screenW: number; content: string | null; clientWidth: number }): boolean {
  if (!o.coarse || !(o.screenW > 0) || o.screenW > 500) return false;
  if (o.content && /width\s*=\s*device-width/i.test(o.content)) return false;
  return o.clientWidth >= 1.5 * o.screenW;
}

export function viewportMeta(ctx: Ctx, out: Draft[]): void {
  if (!ctx.on("viewport-meta-missing")) return;
  const doc = ctx.r.doc;
  const meta = doc.querySelector('meta[name="viewport"]');
  const content = meta?.getAttribute("content") ?? null;
  const coarse = !!ctx.win.matchMedia?.("(pointer: coarse)").matches;
  const screenW = ctx.win.screen?.width ?? 0;
  const cw = doc.documentElement.clientWidth;
  if (!viewportMetaMissing({ coarse, screenW, content, clientWidth: cw })) return;
  out.push({
    kind: "viewport-meta-missing",
    el: doc.documentElement,
    key: "viewport-meta-missing",
    severity: "high",
    measured: { meta: content ?? "absent", clientWidth: cw, screenWidth: screenW },
    threshold: { value: 1.5, unit: "x the screen width", source: "a coarse pointer, screen.width <= 500 and no width=device-width" },
    text: `the page is laid out ${cw} px wide on a ${screenW} px phone screen: ${content ? `the viewport meta tag ("${content.slice(0, 60)}") has no width=device-width` : "there is no viewport meta tag"}.`,
    fixText: 'add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head> (HTML, not CSS)',
  });
}

// --------------------------------------------------------------------------------------------------- layout-shift

export interface ShiftEntry {
  t: number;
  value: number;
  sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
}

/** VISUAL.md 3.16: session windows above 0.25 (web.dev "poor"); 0.1 to 0.25 are counted, not reported. */
export function poorWindows(entries: { t: number; value: number }[]): { start: number; end: number; score: number }[] {
  return shiftWindows(entries).filter((w) => w.score > 0.25);
}

export function layoutShifts(ctx: Ctx, entries: ShiftEntry[], fontSwaps: number[], out: Draft[]): void {
  if (!ctx.on("layout-shift") || !entries.length) return;
  const all = shiftWindows(entries);
  for (const w of all) {
    if (w.score <= 0.25) {
      if (w.score > 0.1) ctx.abstain("layout-shift:needs-improvement");
      continue;
    }
    const inWin = entries.filter((e) => e.t >= w.start && e.t <= w.end);
    const moved: { el: Element; dist: number; prev: DOMRectReadOnly }[] = [];
    for (const e of inWin)
      for (const s of e.sources) {
        const el = s.node && s.node.nodeType === 1 ? (s.node as Element) : s.node?.parentElement ?? null;
        if (!el || !el.isConnected) continue;
        moved.push({ el, dist: Math.max(Math.abs(s.currentRect.y - s.previousRect.y), Math.abs(s.currentRect.x - s.previousRect.x)), prev: s.previousRect });
      }
    moved.sort((a, b) => b.dist - a.dist);
    const top = moved[0];
    const el = top?.el ?? ctx.r.doc.documentElement;
    let cause = "";
    let css = "";
    let sel = top ? ctx.sel(top.el) : "";
    const img = top ? ((top.el.tagName === "IMG" ? top.el : top.el.querySelector("img")) as HTMLImageElement | null) : null;
    if (img && !img.getAttribute("width") && !img.getAttribute("height") && ctx.r.cs(img).aspectRatio === "auto") {
      cause = "an image without width and height";
      sel = ctx.sel(img);
      css = img.naturalWidth && img.naturalHeight ? `aspect-ratio: ${img.naturalWidth} / ${img.naturalHeight};` : "aspect-ratio: 16 / 9;";
    } else if (fontSwaps.some((t) => t <= w.start && w.start - t <= 100)) cause = "a web font swap";
    out.push({
      kind: "layout-shift",
      el,
      key: `layout-shift|${Math.round(w.start)}`,
      severity: "medium",
      measured: {
        score: Math.round(w.score * 1000) / 1000,
        startS: Math.round(w.start / 100) / 10,
        ...(top ? { moved: sel, movedPx: Math.round(top.dist) } : {}),
        ...(cause ? { cause } : {}),
        sources: moved.slice(0, 5).map((m) => `${ctx.sel(m.el)} ${Math.round(m.dist)} px`).join("; "),
      },
      threshold: { value: 0.25, unit: "layout-shift score per session window", source: 'web.dev CLS "poor" (windows: gap under 1 s, at most 5 s; shifts after input excluded)' },
      text: `the layout shifted by ${(Math.round(w.score * 100) / 100).toFixed(2)} (above 0.25) ${(w.start / 1000).toFixed(1)} s after navigation start${top ? `; the largest move: ${named(ctx, top.el)} moved ${px(top.dist)}` : ""}${cause ? ` (${cause})` : ""}.`,
      ...(css ? { suggestion: { selector: sel, css, note: "Reserves the image's space before it loads." } } : { fixText: "reserve space for content that loads above it (a min-height on its slot) or use a metric-matched fallback font" }),
    });
  }
}

// ------------------------------------------------------------------------------------------------------ page-blank

const MEDIA = new Set(["SVG", "CANVAS", "VIDEO", "IFRAME", "EMBED", "OBJECT"]);
const CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

export interface BlankRead {
  region: Element;
  /** Visible text or media was found (or the walk hit its limit). */
  content: boolean;
  elements: number;
  /** When the region holds text that is hidden: the property hiding it, for example "opacity: 0 on main". */
  hiddenBy?: string;
}

/** VISUAL.md 3.17: the main region (or body) shows no visible text and no visible media. */
export function blankRead(r: Reader, sel: (el: Element) => string): BlankRead | null {
  const doc = r.doc;
  const main = doc.querySelector("main, [role=main]");
  const region = main && r.visible(main) ? main : doc.body;
  if (!region) return null;
  let n = 0;
  const tw = doc.createTreeWalker(region, 0x1 | 0x4);
  let firstText: Text | null = null;
  for (let x = tw.nextNode(); x; x = tw.nextNode()) {
    if (++n > 5000) return { region, content: true, elements: n };
    if (x.nodeType === 3) {
      const t = x as Text;
      if (!t.data.trim()) continue;
      const p = t.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      firstText ??= t;
      if (r.visible(p)) return { region, content: true, elements: n };
      continue;
    }
    const el = x as Element;
    const tag = el.tagName.toUpperCase();
    if (el.hasAttribute("data-genclass-ignore")) continue;
    if (tag === "IMG" ? (el as HTMLImageElement).naturalWidth > 0 : MEDIA.has(tag) || CONTROLS.has(tag)) {
      const rc = r.rect(el);
      if (rc.width >= 16 && rc.height >= 16 && r.visible(el)) return { region, content: true, elements: n };
      continue;
    }
    const bi = r.cs(el).backgroundImage;
    if (bi && bi.includes("url(")) {
      const rc = r.rect(el);
      if (rc.width >= 16 && rc.height >= 16 && r.visible(el)) return { region, content: true, elements: n };
    }
  }
  let hiddenBy: string | undefined;
  if (firstText) {
    for (let p: Element | null = firstText.parentElement; p; p = p.parentElement) {
      const s = r.cs(p);
      const prop = s.display === "none" ? "display: none" : s.visibility === "hidden" ? "visibility: hidden" : s.opacity === "0" ? "opacity: 0" : s.contentVisibility === "hidden" ? "content-visibility: hidden" : "";
      if (prop) {
        hiddenBy = `${prop} on ${sel(p)}`;
        break;
      }
      if (p === region) break;
    }
  }
  return { region, content: false, elements: n, ...(hiddenBy ? { hiddenBy } : {}) };
}

export function blankDraft(ctx: Ctx, b: BlankRead, errors: number): Draft {
  const regionSel = ctx.sel(b.region);
  const prop = b.hiddenBy?.split(" on ")[0] ?? "";
  const undo: Record<string, string> = { "display: none": "display: block;", "visibility: hidden": "visibility: visible;", "opacity: 0": "opacity: 1;", "content-visibility: hidden": "content-visibility: visible;" };
  return {
    kind: "page-blank",
    el: b.region,
    key: `page-blank|${regionSel}`,
    severity: "high",
    measured: { region: regionSel, elements: b.elements, errors, ...(b.hiddenBy ? { hiddenBy: b.hiddenBy } : {}) },
    threshold: { value: 0, unit: "visible text characters or media", source: "3 s after the page settled and again 2 s later, nothing in flight" },
    text: `${regionSel} shows no text and no media 3 s after the page settled (and again 2 s later, with nothing in flight)${b.hiddenBy ? `; its text is hidden by ${b.hiddenBy}` : ""}${errors ? `; ${errors} error${errors === 1 ? " was" : "s were"} reported in this session` : ""}.`,
    ...(b.hiddenBy && undo[prop]
      ? { suggestion: { selector: b.hiddenBy.split(" on ")[1], css: undo[prop], note: "Make the visible state the default and animate from there." } }
      : { fixText: "render a fallback in an error boundary, and fix the hydration or chunk-load error the console shows" }),
  };
}
