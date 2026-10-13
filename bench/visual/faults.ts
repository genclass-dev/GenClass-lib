// Planted faults for the recall runs of the visual bench (docs/runtime/VISUAL.md section 15). Each fault is applied
// from the harness (a style, an attribute or an inserted element marked data-bench-fault="<kind>" and
// data-bench-id="<instance>"), never in the app's source (AGENTS.md rule 4). Candidates are picked with a seeded RNG
// among visible elements, and truth() checks afterwards that the fault really took (a fault that did not take, for
// example sideways overflow on a page whose html clips it, is "not applicable" and leaves the recall denominator).
//
// Element faults (one load holds several, on distinct elements):
//   A1  text-invisible (colour equal to the resolved background, and 1.3:1), font-failed, css-var-undefined,
//       text-template-leak ([object Object], $NaN), text-encoding, text-placeholder
//   A2  an inserted box with image-broken, image-distorted, image-css-broken, media-failed, icon-font-failed,
//       stylesheet-failed, csp-blocked
// Page faults (one per load): page-overflow-x, pointer-events-leak, scroll-lock-stuck, click-blocked,
//   control-unreachable, focus-obscured, dialog-covered, layout-shift; at document start: page-blank,
//   viewport-meta-missing.

import { contrast, luminance, parseColor, toHex, type RGBA } from "../../packages/runtime/src/visual/math.js";

export interface FaultResult {
  kind: string;
  id: string;
  ok: boolean;
  reason?: string;
  /** Where the runner should click or wheel. */
  point?: { x: number; y: number };
  info?: Record<string, unknown>;
}

const OPEN_SEL = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], [role="menu"], [role="listbox"], [data-state="open"]';
const REPLACED = new Set(["IMG", "PICTURE", "VIDEO", "CANVAS", "SVG", "IFRAME", "OBJECT", "EMBED"]);
const TEXT_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "A", "BUTTON", "LI", "SPAN", "DIV", "TD", "TH", "LABEL", "STRONG", "EM", "SMALL"]);

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const used = new Set<Element>();
const planted = new Map<string, { el: Element; color?: string; bg?: RGBA; extra?: Record<string, unknown> }>();
let cspAtInject = 0;
let box: HTMLElement | null = null;

function visible(el: Element): boolean {
  const cv = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof cv === "function" && !cv.call(el, { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
}

function inView(el: Element, maxFy = 0.9): boolean {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight * maxFy && r.right <= innerWidth;
}

function firstText(el: Element): Text | null {
  for (const n of el.childNodes) if (n.nodeType === 3 && (n as Text).data.trim().length >= 2) return n as Text;
  return null;
}

/** Overlaps an element already used by another fault (itself, an ancestor or a descendant). */
function clash(el: Element): boolean {
  for (const u of used) if (u === el || u.contains(el) || el.contains(u)) return true;
  return false;
}

function pinned(el: Element): boolean {
  for (let x: Element | null = el; x && x !== document.body; x = x.parentElement) {
    const p = getComputedStyle(x).position;
    if (p === "fixed" || p === "sticky") return true;
  }
  return false;
}

function translucentOrFiltered(el: Element): boolean {
  for (let x: Element | null = el; x; x = x.parentElement) {
    const s = getComputedStyle(x);
    if (parseFloat(s.opacity) < 1 || (s.filter && s.filter !== "none") || (s.mixBlendMode && s.mixBlendMode !== "normal")) return true;
  }
  return false;
}

/** Visible text elements in the viewport, not overlapping earlier faults, in document order. */
function textCands(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const all = document.body?.querySelectorAll("*") ?? [];
  for (let i = 0; i < all.length && i < 6000 && out.length < 300; i++) {
    const el = all[i] as HTMLElement;
    if (!TEXT_TAGS.has(el.tagName) || !firstText(el)) continue;
    if (el.closest("code, pre, svg, textarea, select, genclass-devtools, [data-genclass-ignore], [aria-hidden='true'], [inert], [data-bench-box], [contenteditable], :disabled, [aria-disabled='true']")) continue;
    if (clash(el) || !inView(el) || !visible(el)) continue;
    const s = getComputedStyle(el);
    if (parseFloat(s.fontSize) < 10 || s.textShadow !== "none") continue;
    const t = (firstText(el)?.data ?? "").trim();
    const cp = t.codePointAt(0) ?? 0;
    if ([...t].length === 1 && cp >= 0xe000 && cp <= 0xf8ff) continue;
    out.push(el);
  }
  return out;
}

/** The solid background under the element's first text line, or null when it is not a known solid colour. */
function bgOf(el: Element): RGBA | null {
  const tn = firstText(el);
  if (!tn) return null;
  const range = document.createRange();
  range.selectNodeContents(tn);
  const rr = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
  if (!rr) return null;
  const x = Math.floor(rr.left + rr.width / 2);
  const y = Math.floor(rr.top + rr.height / 2);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
  const st = document.elementsFromPoint(x, y);
  if (!st.length || !(st[0] === el || el.contains(st[0]))) return null;
  const i = st.indexOf(el);
  if (i < 0) return null;
  if (translucentOrFiltered(el)) return null;
  for (let j = i; j < st.length; j++) {
    const e = st[j];
    const s = getComputedStyle(e);
    if (s.backgroundImage !== "none") return null;
    if (j > i && REPLACED.has(e.tagName.toUpperCase())) return null;
    if ((s.backdropFilter && s.backdropFilter !== "none") || (s.filter && s.filter !== "none")) return null;
    for (const p of ["::before", "::after"]) {
      const ps = getComputedStyle(e, p);
      if (ps.content !== "none" && ps.content !== "normal") {
        const pc = parseColor(ps.backgroundColor);
        if ((pc && pc[3] > 0) || ps.backgroundImage !== "none") return null;
      }
    }
    const c = parseColor(s.backgroundColor);
    if (!c) return null;
    if (c[3] > 0 && c[3] < 1) return null;
    if (c[3] >= 1) return c;
  }
  const html = parseColor(getComputedStyle(document.documentElement).backgroundColor);
  if (html && html[3] >= 1) return html;
  const body = document.body ? parseColor(getComputedStyle(document.body).backgroundColor) : null;
  if (body && body[3] >= 1) return body;
  if (/dark/.test(getComputedStyle(document.documentElement).colorScheme) && matchMedia("(prefers-color-scheme: dark)").matches) return null;
  return [255, 255, 255, 1];
}

/** A grey with the given contrast ratio against bg (darker on light backgrounds, lighter on dark ones). */
function greyAt(bg: RGBA, ratio: number): RGBA {
  const lb = luminance(bg);
  const lf = lb > 0.18 ? (lb + 0.05) / ratio - 0.05 : ratio * (lb + 0.05) - 0.05;
  const l = Math.min(1, Math.max(0, lf));
  const c = l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  const v = Math.round(Math.min(1, Math.max(0, c)) * 255);
  return [v, v, v, 1];
}

function mark(el: Element, kind: string, id: string): void {
  el.setAttribute("data-bench-fault", kind);
  el.setAttribute("data-bench-id", id);
  used.add(el);
}

function pick<T>(list: T[], r: () => number): T | undefined {
  return list.length ? list[Math.floor(r() * list.length)] : undefined;
}

function addStyle(css: string): HTMLStyleElement {
  const s = document.createElement("style");
  s.setAttribute("data-bench-style", "");
  s.textContent = css;
  (document.head ?? document.documentElement).appendChild(s);
  return s;
}

function setImp(el: HTMLElement, props: Record<string, string>): void {
  for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
}

/** The inserted box for A2 faults: before the first visible in-flow child of body, in the viewport. */
function theBox(): HTMLElement {
  if (box?.isConnected) return box;
  box = document.createElement("div");
  box.setAttribute("data-bench-box", "");
  setImp(box, { display: "flex", "flex-wrap": "wrap", gap: "8px", "align-items": "flex-start", padding: "8px", "box-sizing": "border-box", "max-width": "100%", position: "relative", "z-index": "0", "font-size": "16px" });
  const anchor = [...(document.body?.children ?? [])].find((c) => {
    if (c.tagName === "SCRIPT" || c.tagName === "STYLE" || c.tagName === "GENCLASS-DEVTOOLS") return false;
    const s = getComputedStyle(c);
    return s.position !== "fixed" && s.position !== "absolute" && s.display !== "none" && c.getBoundingClientRect().height > 0;
  });
  if (anchor) anchor.parentElement!.insertBefore(box, anchor);
  else document.body.prepend(box);
  return box;
}

/** A w x h PNG as a data URL (solid colour), drawn on a canvas. */
function pngUrl(w: number, h: number): string {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#6080a0";
    g.fillRect(0, 0, w, h);
  }
  return c.toDataURL("image/png");
}

function openOverlay(): boolean {
  return [...document.querySelectorAll(OPEN_SEL)].slice(0, 50).some((e) => visible(e));
}

function interactiveInView(r: () => number): HTMLElement | undefined {
  const list = [...document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="submit"]')].filter((el) => {
    if (el.closest("genclass-devtools, [data-bench-box]") || pinned(el) || !visible(el)) return false;
    const rc = el.getBoundingClientRect();
    if (rc.width < 12 || rc.height < 12 || !inView(el, 0.95)) return false;
    const h = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
    return !!h && (h === el || el.contains(h));
  }) as HTMLElement[];
  return pick(list, r);
}

// --------------------------------------------------------------------------------------------- early faults

/** Faults that must exist before the page renders (called from the init script at document start). */
export function earlyFault(kind: string): void {
  if (kind === "page-blank") {
    // the main content never fades in: everything in body stays at opacity 0 (a stuck enter animation)
    try {
      const s = new CSSStyleSheet();
      s.replaceSync("body > *:not(genclass-devtools) { opacity: 0 !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
    } catch {
      /* no constructable sheets */
    }
    planted.set("page-blank", { el: document.documentElement });
  } else if (kind === "viewport-meta-missing") {
    const strip = () => {
      for (const m of document.querySelectorAll('meta[name="viewport"]')) m.remove();
    };
    new MutationObserver(strip).observe(document, { childList: true, subtree: true });
    strip();
    planted.set("viewport-meta-missing", { el: document.documentElement });
  }
}

// --------------------------------------------------------------------------------------------------- inject

export function inject(kind: string, seed: number, extra: Record<string, unknown>): FaultResult {
  const r = rng(seed * 7919 + kind.length * 104729 + [...kind].reduce((a, c) => a + c.charCodeAt(0), 0));
  const id = `${kind}#${seed}`;
  const fail = (reason: string): FaultResult => ({ kind: kind.split(":")[0], id, ok: false, reason });
  const base = kind.split(":")[0];
  try {
    switch (kind) {
      case "text-invisible:equal":
      case "text-invisible:1.3": {
        const cands = textCands().filter((el) => {
          const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitTextFillColor?: string };
          return (!s.webkitTextFillColor || s.webkitTextFillColor === s.color) && !!bgOf(el);
        });
        const el = pick(cands, r);
        if (!el) return fail("no visible text over a known solid background in the viewport");
        const bg = bgOf(el)!;
        const fg = kind.endsWith("equal") ? bg : greyAt(bg, 1.3);
        const color = toHex(fg);
        // a stylesheet rule, as real bugs come from stylesheets (an inline !important colour would also beat the
        // runtime fix's own rule, and the fix rate would measure the harness)
        const cls = `bench-ti-${seed}-${kind.endsWith("equal") ? "eq" : "13"}`;
        addStyle(`.${cls} { color: ${color} !important; transition: none !important; }`);
        el.classList.add(cls);
        mark(el, "text-invisible", id);
        planted.set(id, { el, color, bg });
        return { kind: base, id, ok: true, info: { color, bg: toHex(bg), ratio: Math.round(contrast(fg, bg) * 100) / 100, tag: el.tagName.toLowerCase() } };
      }
      case "font-failed": {
        const el = pick(textCands(), r);
        if (!el) return fail("no visible text element in the viewport");
        const fam = `BenchBrand${seed}`;
        addStyle(`@font-face { font-family: "${fam}"; src: url("__bench/missing-font-${seed}.woff2") format("woff2"); font-display: swap; }`);
        setImp(el, { "font-family": `"${fam}", serif` });
        mark(el, "font-failed", id);
        planted.set(id, { el, extra: { fam } });
        return { kind: base, id, ok: true, info: { tag: el.tagName.toLowerCase() } };
      }
      case "css-var-undefined": {
        const el = pick(textCands(), r);
        if (!el) return fail("no visible element in the viewport");
        const cls = `bench-var-${seed}`;
        addStyle(`.${cls} { outline: 2px solid var(--bench-missing-token-${seed}); }`);
        el.classList.add(cls);
        mark(el, "css-var-undefined", id);
        planted.set(id, { el });
        return { kind: base, id, ok: true };
      }
      case "text-template-leak:object":
      case "text-template-leak:nan":
      case "text-encoding":
      case "text-placeholder": {
        const el = pick(textCands(), r);
        if (!el) return fail("no visible text element in the viewport");
        const text = kind === "text-template-leak:object" ? " Total: [object Object]" : kind === "text-template-leak:nan" ? " $NaN" : kind === "text-encoding" ? " CafÃ© â€“ open" : " Lorem ipsum dolor sit amet.";
        const span = document.createElement("span");
        span.textContent = text;
        el.appendChild(span);
        mark(span, base, id);
        used.add(el);
        planted.set(id, { el: span });
        return { kind: base, id, ok: true };
      }
      case "image-broken": {
        const img = document.createElement("img");
        img.alt = "Product photo";
        img.src = `__bench/missing-${seed}.png`;
        setImp(img, { display: "block", width: "160px", height: "100px" });
        mark(img, base, id);
        theBox().appendChild(img);
        planted.set(id, { el: img });
        return { kind: base, id, ok: true };
      }
      case "image-distorted": {
        const img = document.createElement("img");
        img.alt = "";
        img.src = pngUrl(200, 100);
        setImp(img, { display: "block", width: "120px", height: "120px", "object-fit": "fill", padding: "0", border: "0" });
        mark(img, base, id);
        theBox().appendChild(img);
        planted.set(id, { el: img });
        return { kind: base, id, ok: true };
      }
      case "image-css-broken": {
        const cls = `bench-cssimg-${seed}`;
        addStyle(`.${cls} { background-image: url("__bench/missing-bg-${seed}.png"); }`);
        const d = document.createElement("div");
        d.className = cls;
        setImp(d, { display: "block", width: "120px", height: "80px" });
        mark(d, base, id);
        theBox().appendChild(d);
        planted.set(id, { el: d, extra: { path: `__bench/missing-bg-${seed}.png` } });
        return { kind: base, id, ok: true };
      }
      case "media-failed": {
        const v = document.createElement("video");
        v.muted = true;
        v.preload = "auto";
        v.setAttribute("playsinline", "");
        v.src = `__bench/missing-${seed}.mp4`;
        setImp(v, { display: "block", width: "160px", height: "90px" });
        mark(v, base, id);
        theBox().appendChild(v);
        planted.set(id, { el: v });
        return { kind: base, id, ok: true };
      }
      case "icon-font-failed": {
        const fam = `Bench Icons ${seed}`;
        addStyle(`@font-face { font-family: "${fam}"; src: url("__bench/missing-icons-${seed}.woff2") format("woff2"); }`);
        const s = document.createElement("span");
        s.className = "material-icons";
        s.textContent = "shopping_cart";
        setImp(s, { "font-family": `"${fam}"`, "font-size": "24px", "white-space": "nowrap", display: "inline-block", "line-height": "1" });
        mark(s, base, id);
        theBox().appendChild(s);
        planted.set(id, { el: s, extra: { fam } });
        return { kind: base, id, ok: true };
      }
      case "stylesheet-failed": {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = `__bench/missing-${seed}.css`;
        mark(l, base, id);
        (document.head ?? document.documentElement).appendChild(l);
        planted.set(id, { el: l });
        return { kind: base, id, ok: true };
      }
      case "csp-blocked": {
        const m = document.createElement("meta");
        m.httpEquiv = "Content-Security-Policy";
        m.content = "img-src 'self' data: blob:";
        (document.head ?? document.documentElement).appendChild(m);
        cspAtInject = (window as unknown as { __gcBench?: { csp: number } }).__gcBench?.csp ?? 0;
        const img = document.createElement("img");
        img.alt = "Partner logo";
        img.src = `http://localhost:9/__bench/csp-${seed}.png`;
        setImp(img, { display: "block", width: "40px", height: "40px" });
        mark(img, base, id);
        theBox().appendChild(img);
        planted.set(id, { el: img });
        return { kind: base, id, ok: true };
      }
      case "page-overflow-x": {
        const d = document.createElement("div");
        setImp(d, { display: "block", "min-width": "130vw", height: "24px" });
        d.textContent = "Wide promo strip";
        mark(d, base, id);
        document.body.appendChild(d);
        planted.set(id, { el: d });
        return { kind: base, id, ok: true };
      }
      case "pointer-events-leak": {
        if (openOverlay()) return fail("a dialog or menu is open on this page");
        document.body.style.setProperty("pointer-events", "none");
        planted.set(id, { el: document.body });
        return { kind: base, id, ok: true };
      }
      case "scroll-lock-stuck": {
        if (openOverlay()) return fail("a dialog or menu is open on this page");
        if (document.documentElement.scrollHeight <= innerHeight + 100) {
          const sp = document.createElement("div");
          sp.setAttribute("data-bench-spacer", "");
          setImp(sp, { display: "block", height: "200vh" });
          document.body.appendChild(sp);
        }
        document.body.style.setProperty("overflow", "hidden");
        planted.set(id, { el: document.body });
        return { kind: base, id, ok: true, point: quiet() };
      }
      case "click-blocked": {
        const el = interactiveInView(r);
        if (!el) return fail("no visible control in the viewport");
        const rc = el.getBoundingClientRect();
        const ov = document.createElement("div");
        setImp(ov, { position: "fixed", inset: "0", "z-index": "2147483000", background: "transparent" });
        mark(ov, base, id);
        document.body.appendChild(ov);
        planted.set(id, { el: ov, extra: { ctl: el } });
        return { kind: base, id, ok: true, point: { x: Math.floor(rc.left + rc.width / 2), y: Math.floor(rc.top + rc.height / 2) }, info: { control: el.tagName.toLowerCase() } };
      }
      case "control-unreachable": {
        const wrap = document.createElement("div");
        setImp(wrap, { display: "flex", "flex-direction": "column", "justify-content": "flex-end", "align-items": "flex-end", "min-height": "110vh", padding: "0 24px 12px 0", "box-sizing": "border-box", width: "100%", clear: "both" });
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Load more";
        setImp(b, { padding: "8px 14px", "font-size": "16px" });
        wrap.appendChild(b);
        mark(b, base, id);
        document.body.appendChild(wrap);
        scrollTo(0, document.documentElement.scrollHeight);
        const rc = b.getBoundingClientRect();
        const cover = document.createElement("div");
        cover.setAttribute("data-bench-cover", "");
        const h = Math.max(72, innerHeight - rc.top + 12);
        if (h > innerHeight * 0.38) return fail("the button does not reach the bottom of the page");
        setImp(cover, { position: "fixed", bottom: "0", left: `${Math.max(0, Math.floor(rc.left - 20))}px`, width: `${Math.ceil(rc.width + 40)}px`, height: `${Math.ceil(h)}px`, "z-index": "2147483000", background: "#2563eb", "border-radius": "24px 24px 0 0" });
        document.body.appendChild(cover);
        scrollBy(0, -300);
        planted.set(id, { el: b, extra: { cover } });
        return { kind: base, id, ok: true, point: quiet() };
      }
      case "focus-obscured": {
        const header = document.createElement("div");
        header.setAttribute("data-bench-cover", "");
        setImp(header, { position: "fixed", top: "0", left: "0", right: "0", height: "72px", "z-index": "2147483000", background: "#111827" });
        const t = document.createElement("h2");
        t.id = `bench-target-${seed}`;
        t.textContent = "Pricing";
        setImp(t, { margin: "0", padding: "8px 0", "font-size": "20px", "scroll-margin-top": "0" });
        mark(t, base, id);
        const sp = document.createElement("div");
        setImp(sp, { display: "block", height: "150vh" });
        document.body.append(t, sp, header);
        planted.set(id, { el: t, extra: { cover: header } });
        setTimeout(() => {
          location.hash = `#bench-target-${seed}`;
        }, 50);
        return { kind: base, id, ok: true };
      }
      case "dialog-covered": {
        const d = document.createElement("div");
        d.setAttribute("role", "dialog");
        d.setAttribute("aria-label", "Confirm order");
        d.innerHTML = '<p style="margin:0 0 12px">Place this order?</p><button type="button">Place order</button> <button type="button">Cancel</button>';
        setImp(d, { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "min(360px, 80vw)", padding: "16px", background: "#ffffff", color: "#111827", "z-index": "10", "box-sizing": "border-box", "font-size": "16px" });
        mark(d, base, id);
        const cover = document.createElement("div");
        cover.setAttribute("data-bench-cover", "");
        setImp(cover, { position: "fixed", left: "0", right: "0", top: "0", height: "60vh", "z-index": "20", background: "#1f2937" });
        document.body.append(d, cover);
        planted.set(id, { el: d, extra: { cover } });
        return { kind: base, id, ok: true };
      }
      case "layout-shift": {
        const d = document.createElement("div");
        setImp(d, { display: "block", height: "60vh", width: "100%" });
        mark(d, base, id);
        document.body.prepend(d);
        planted.set(id, { el: d });
        return { kind: base, id, ok: true };
      }
      default:
        return fail(`unknown fault ${kind} ${JSON.stringify(extra).slice(0, 20)}`);
    }
  } catch (e) {
    return fail(`inject threw: ${String(e).slice(0, 200)}`);
  }
}

function quiet(): { x: number; y: number } {
  const q = (window as unknown as { __gcBench?: { quietPoint(): { x: number; y: number } } }).__gcBench?.quietPoint();
  return q ?? { x: Math.floor(innerWidth / 2), y: Math.floor(innerHeight / 2) };
}

function five(rc: DOMRect): { x: number; y: number }[] {
  const cx = rc.left + rc.width / 2;
  const cy = rc.top + rc.height / 2;
  return [
    [cx, cy],
    [rc.left + rc.width * 0.25, cy],
    [rc.left + rc.width * 0.75, cy],
    [cx, rc.top + rc.height * 0.25],
    [cx, rc.top + rc.height * 0.75],
  ].map(([x, y]) => ({ x: Math.floor(x), y: Math.floor(y) }));
}

// ---------------------------------------------------------------------------------------------------- truth

type BenchState = { shifts: { t: number; value: number }[]; injectedAt: number | null; csp: number };

/**
 * Whether a planted fault (by its id, as inject returned it; the kind itself for page-blank and
 * viewport-meta-missing) is really on the page now. The runner calls it before it collects the findings.
 */
export function truth(id: string, B: BenchState): { ok: boolean; why: string; value?: number } {
  const p = planted.get(id);
  if (!p) return { ok: false, why: "not planted" };
  const kind = id.split("#")[0].split(":")[0];
  const el = p.el as HTMLElement;
  const no = (why: string) => ({ ok: false, why });
  switch (kind) {
    case "text-invisible": {
      if (!el.isConnected || !visible(el) || !inView(el, 1)) return no("the element left the viewport or the page");
      const bg = bgOf(el);
      const fg = parseColor(getComputedStyle(el).color);
      if (!bg || !fg) return no("background no longer a known solid colour");
      const ratio = contrast(fg, bg);
      return ratio < 1.5 ? { ok: true, why: "", value: Math.round(ratio * 100) / 100 } : no(`ratio is ${ratio.toFixed(2)}`);
    }
    case "font-failed":
    case "icon-font-failed": {
      const fam = String(p.extra?.fam ?? "").toLowerCase();
      const faces = [...(document.fonts as unknown as Iterable<FontFace>)].filter((f) => f.family.replace(/["']/g, "").toLowerCase() === fam);
      if (!faces.length || !faces.every((f) => f.status === "error")) return no(`font status ${faces.map((f) => f.status).join(",") || "none"}`);
      if (!el.isConnected || !visible(el) || !inView(el, 1)) return no("the element left the viewport");
      return { ok: true, why: "" };
    }
    case "css-var-undefined":
    case "text-template-leak":
    case "text-encoding":
    case "text-placeholder":
      return el.isConnected && visible(el) ? { ok: true, why: "" } : no("the element is gone or hidden");
    case "image-broken": {
      const img = el as HTMLImageElement;
      if (!img.isConnected || !img.complete || img.naturalWidth !== 0) return no("the image is not broken");
      const rc = img.getBoundingClientRect();
      return visible(img) && rc.width >= 16 && rc.height >= 16 ? { ok: true, why: "" } : no("the image is hidden or smaller than 16 px");
    }
    case "image-distorted": {
      const img = el as HTMLImageElement;
      if (!img.isConnected || !img.complete || img.naturalWidth !== 200) return no("not loaded");
      const ok = visible(img) && Math.abs(img.clientWidth - img.clientHeight) <= 2 && getComputedStyle(img).objectFit === "fill";
      return ok ? { ok: true, why: "" } : no(`rendered ${img.clientWidth} x ${img.clientHeight}`);
    }
    case "image-css-broken": {
      const path = String(p.extra?.path ?? "");
      const e = (performance.getEntriesByType("resource") as (PerformanceResourceTiming & { responseStatus?: number })[]).find((x) => x.name.includes(path));
      if (!e) return no("no resource entry for the background image");
      if (!((e.responseStatus ?? 0) >= 400)) return no(`status ${e.responseStatus}`);
      return visible(el) ? { ok: true, why: "" } : no("the element is hidden");
    }
    case "media-failed": {
      const v = el as HTMLVideoElement;
      const code = v.error?.code ?? 0;
      return visible(v) && (code >= 2 || v.networkState === 3) ? { ok: true, why: "", value: code } : no(`error ${code}, networkState ${v.networkState}`);
    }
    case "stylesheet-failed":
      return (el as HTMLLinkElement).sheet === null ? { ok: true, why: "" } : no("the stylesheet loaded");
    case "csp-blocked":
      return B.csp > cspAtInject ? { ok: true, why: "" } : no("no securitypolicyviolation event (the meta policy did not apply)");
    case "page-overflow-x": {
      const html = document.documentElement;
      let ox = getComputedStyle(html).overflowX;
      if (ox === "visible") ox = getComputedStyle(document.body).overflowX;
      if (/hidden|clip/.test(ox)) return no(`the viewport clips overflow (overflow-x: ${ox})`);
      return html.scrollWidth > html.clientWidth + 1 ? { ok: true, why: "", value: html.scrollWidth - html.clientWidth } : no("the page does not scroll sideways");
    }
    case "pointer-events-leak":
      if (openOverlay()) return no("a dialog or menu is open");
      return getComputedStyle(document.body).pointerEvents === "none" ? { ok: true, why: "" } : no("body has pointer events");
    case "scroll-lock-stuck": {
      if (openOverlay()) return no("a dialog or menu is open");
      const s = getComputedStyle(document.body);
      const tall = document.documentElement.scrollHeight > innerHeight + 100;
      return /hidden|clip/.test(s.overflowY) && tall ? { ok: true, why: "" } : no(`overflow-y ${s.overflowY}, tall ${tall}`);
    }
    case "click-blocked": {
      const ctl = p.extra?.ctl as Element | undefined;
      if (!ctl?.isConnected || !el.isConnected) return no("the control or the overlay is gone");
      const rc = ctl.getBoundingClientRect();
      const st = document.elementsFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
      return st[0] === el && st.some((x) => x === ctl || ctl.contains(x)) ? { ok: true, why: "" } : no("the overlay is not over the control");
    }
    case "control-unreachable": {
      const cover = p.extra?.cover as Element | undefined;
      if (!cover?.isConnected) return no("not planted");
      const atMax = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
      if (!atMax) return no("the page is not at its end");
      const ok = five(el.getBoundingClientRect()).every((q) => document.elementFromPoint(q.x, q.y) === cover);
      return ok ? { ok: true, why: "" } : no("the cover does not hide all 5 points of the button");
    }
    case "focus-obscured": {
      const cover = p.extra?.cover as Element | undefined;
      const rc = el.getBoundingClientRect();
      const pts = [0.25, 0.5, 0.75].map((f) => ({ x: Math.floor(rc.left + rc.width * f), y: Math.floor(rc.top + 4) }));
      const ok = !!cover && location.hash === `#${el.id}` && pts.every((q) => document.elementFromPoint(q.x, q.y) === cover);
      return ok ? { ok: true, why: "" } : no(`target top ${Math.round(rc.top)}, hash ${location.hash.slice(0, 30)}`);
    }
    case "dialog-covered": {
      const cover = p.extra?.cover as Element | undefined;
      const rc = el.getBoundingClientRect();
      const h = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
      return h === cover ? { ok: true, why: "" } : no("the cover is not over the dialog");
    }
    case "layout-shift": {
      const t0 = (B.injectedAt ?? 0) - 50;
      const after = B.shifts.filter((s) => s.t >= t0);
      let best = 0;
      let cur = 0;
      let start = -Infinity;
      let last = -Infinity;
      for (const s of after) {
        if (s.t - last > 1000 || s.t - start > 5000) {
          cur = 0;
          start = s.t;
        }
        cur += s.value;
        last = s.t;
        best = Math.max(best, cur);
      }
      return best > 0.25 ? { ok: true, why: "", value: Math.round(best * 1000) / 1000 } : { ok: false, why: `the planted shift scored ${best.toFixed(3)} (not above 0.25)`, value: best };
    }
    case "page-blank": {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const t = n as Text;
        if (!t.data.trim() || !t.parentElement || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(t.parentElement.tagName)) continue;
        if (t.parentElement.closest("genclass-devtools")) continue;
        if (visible(t.parentElement)) return no("some text is still visible");
      }
      return { ok: true, why: "" };
    }
    case "viewport-meta-missing": {
      const sw = screen.width;
      const cw = document.documentElement.clientWidth;
      return cw >= 1.5 * sw ? { ok: true, why: "", value: cw } : no(`layout ${cw} px on a ${sw} px screen`);
    }
    default:
      return no("no truth for this kind");
  }
}
