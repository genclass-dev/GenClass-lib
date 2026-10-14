// Interaction checks (docs/runtime/VISUAL.md 3.18 to 3.23): click-blocked, pointer-events-leak, scroll-lock-stuck,
// control-unreachable, focus-obscured, dialog-covered. The engine (src/visual/engine.ts) decides when to run them
// (on clicks, focus, scrolling, a dialog appearing, a periodic read); these functions only read and judge.

import type { Ctx, Draft } from "../draft.js";
import { named, px } from "../draft.js";
import { coverage, parseColor } from "../math.js";
import { containsDeep, DIALOG_SEL, fivePoints, focusableInside, inDialog, INTERACTIVE_SEL, isInteractive, OPEN_SEL, parentOf, REPLACED, safeMatches, type Reader } from "../measure.js";

// ---------------------------------------------------------------------------------------------- click-blocked

export interface ClickRead {
  overlay: Element;
  blocked: Element;
  coverage: number;
}

function transparentBox(r: Reader, el: Element): boolean {
  const s = r.cs(el);
  if (parseFloat(s.opacity) < 0.05) return true;
  const bg = parseColor(s.backgroundColor);
  if (!bg || bg[3] >= 0.05 || (s.backgroundImage && s.backgroundImage !== "none")) return false;
  if (s.boxShadow && s.boxShadow !== "none") return false;
  if (s.backdropFilter && s.backdropFilter !== "none") return false;
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    const w = parseFloat(s[`border${side}Width`]);
    const c = parseColor(s[`border${side}Color`]);
    if (w > 0 && s[`border${side}Style`] !== "none" && c && c[3] > 0) return false;
  }
  return true;
}

/** VISUAL.md 3.18: the click landed on a transparent, non-interactive layer covering 30% of the viewport over a control. */
export function clickBlockedRead(r: Reader, target: Element, x: number, y: number): ClickRead | null {
  const doc = r.doc;
  if (target === doc.documentElement || target === doc.body) return null;
  if (target.tagName === "CANVAS" || target.closest(INTERACTIVE_SEL) || r.cs(target).cursor === "pointer") return null;
  if ((target.textContent ?? "").trim()) return null;
  if (!transparentBox(r, target)) return null;
  const cov = coverage(r.rect(target), r.win.innerWidth, r.win.innerHeight);
  if (cov < 0.3) return null;
  const st = r.stack(x, y);
  const i = st.indexOf(target);
  if (i < 0) return null;
  const below = st.slice(i + 1).find((e) => !containsDeep(e, target));
  if (!below) return null;
  const ctl = (below.closest(INTERACTIVE_SEL) as Element | null) ?? (r.cs(below).cursor === "pointer" ? below : null);
  if (!ctl || !r.visible(ctl)) return null;
  return { overlay: target, blocked: ctl, coverage: cov };
}

export function clickBlockedDraft(ctx: Ctx, c: ClickRead): Draft {
  const sel = ctx.sel(c.overlay);
  const s = ctx.r.cs(c.overlay);
  return {
    kind: "click-blocked",
    el: c.overlay,
    key: `click-blocked|${sel}|${ctx.sel(c.blocked)}`,
    severity: "high",
    measured: { overlay: sel, zIndex: s.zIndex, opacity: s.opacity, coverage: Math.round(c.coverage * 100), blocked: named(ctx, c.blocked), clicks: 2 },
    threshold: { value: 30, unit: "% of the viewport covered by a transparent layer", source: "two clicks within 3 s with no DOM change, navigation, request or focus change" },
    text: `an invisible layer ${named(ctx, c.overlay)} (${Math.round(c.coverage * 100)}% of the viewport, z-index ${s.zIndex}) took 2 clicks meant for ${named(ctx, c.blocked)}, and nothing happened.`,
    suggestion: { selector: sel, css: "pointer-events: none;", note: "Or unmount the overlay after its close transition, for example .backdrop[data-state=\"closed\"] { pointer-events: none; }." },
  };
}

// ------------------------------------------------------------------------------- pointer-events, scroll lock

/** Something open and visible owns the page's pointer-events or scroll lock (dialogs, menus, popovers, a drawer). */
export function openOverlay(r: Reader, drawers: boolean): boolean {
  let list: Element[] = [];
  try {
    list = [...r.doc.querySelectorAll(`${OPEN_SEL}, :popover-open`)].slice(0, 50);
  } catch {
    list = [...r.doc.querySelectorAll(OPEN_SEL)].slice(0, 50);
  }
  if (list.some((el) => r.visible(el))) return true;
  if (!drawers) return false;
  for (const el of r.stack(Math.floor(r.win.innerWidth / 2), Math.floor(r.win.innerHeight / 2))) {
    const p = r.pinned(el);
    if (p && p.tagName !== "GENCLASS-DEVTOOLS" && coverage(r.rect(p), r.win.innerWidth, r.win.innerHeight) >= 0.5) return true;
  }
  return false;
}

export interface LockRead {
  /** html or body with pointer-events: none, and whether it is an inline declaration. */
  pointer: { el: HTMLElement; inline: boolean } | null;
  /** html or body with overflow-y hidden or clip (or the iOS fixed-body lock). */
  scroll: { el: HTMLElement; value: string; inline: string[]; fixedBody: boolean } | null;
  /** The document is taller than the viewport by more than 100 px. */
  tall: boolean;
}

export function lockRead(r: Reader): LockRead {
  const doc = r.doc;
  const els = [doc.documentElement, doc.body].filter(Boolean) as HTMLElement[];
  let pointer: LockRead["pointer"] = null;
  let scroll: LockRead["scroll"] = null;
  for (const el of els) {
    const s = r.cs(el);
    if (!pointer && s.pointerEvents === "none") pointer = { el, inline: el.style.getPropertyValue("pointer-events") === "none" };
    if (!scroll && (s.overflowY === "hidden" || s.overflowY === "clip")) {
      const inline = ["overflow", "overflow-y"].filter((p) => /^(hidden|clip)$/.test(el.style.getPropertyValue(p).trim()));
      scroll = { el, value: `overflow-y: ${s.overflowY}`, inline, fixedBody: false };
    }
  }
  const body = doc.body;
  if (!scroll && body && r.cs(body).position === "fixed" && parseFloat(body.style.top) < 0) scroll = { el: body, value: `position: fixed; top: ${body.style.top}`, inline: [], fixedBody: true };
  return { pointer, scroll, tall: doc.documentElement.scrollHeight > r.win.innerHeight + 100 };
}

export function pointerLeakDraft(ctx: Ctx, p: NonNullable<LockRead["pointer"]>, ms: number, rootClicks: number): Draft {
  const sel = p.el === ctx.r.doc.body ? "body" : "html";
  return {
    kind: "pointer-events-leak",
    el: p.el,
    key: `pointer-events-leak|${sel}`,
    severity: "high",
    measured: { element: sel, source: p.inline ? "inline" : "stylesheet", seconds: Math.round(ms / 100) / 10, rootClicks },
    threshold: { value: 1, unit: "s of pointer-events: none on html or body", source: "two reads 1 s apart with no open dialog, menu or popover" },
    text: `pointer-events: none has been left on ${sel} (${p.inline ? "an inline style" : "a stylesheet rule"}) for ${(ms / 1000).toFixed(1)} s with no dialog or menu open, so the whole page ignores clicks${rootClicks ? ` (${rootClicks} click${rootClicks === 1 ? "" : "s"} landed on the page itself)` : ""}.`,
    fixText:
      "release the lock in every close path; with Radix or shadcn/ui, do not unmount a modal DropdownMenu or Dialog during its exit animation, or set modal={false} on a menu that opens a dialog",
    ...(p.inline ? { plan: { type: "inline" as const, kind: "pointer-events-leak" as const, el: p.el, props: ["pointer-events"] } } : {}),
  };
}

export function scrollLockDraft(ctx: Ctx, l: NonNullable<LockRead["scroll"]>, attempts: number): Draft {
  const sel = l.el === ctx.r.doc.body ? "body" : "html";
  const cls = [...l.el.classList].filter((c) => /lock|modal|open|noscroll|no-scroll|overflow/i.test(c));
  return {
    kind: "scroll-lock-stuck",
    el: l.el,
    key: `scroll-lock-stuck|${sel}`,
    severity: "high",
    measured: {
      element: sel,
      lock: l.value,
      source: l.inline.length ? "inline" : l.fixedBody ? "inline (position: fixed)" : cls.length ? `class ${cls.join(" ")}` : "stylesheet",
      scrollHeight: ctx.r.doc.documentElement.scrollHeight,
      innerHeight: ctx.r.win.innerHeight,
      attempts,
    },
    threshold: { value: 100, unit: "px of page below the viewport that cannot be scrolled", source: "overflow-y hidden or clip on html or body for 1 s, no open overlay, a scroll attempt without effect" },
    text: `the page cannot scroll: ${sel} has ${l.value}${cls.length ? ` (class ${cls.join(" ")})` : ""} with no dialog or menu open, ${ctx.r.doc.documentElement.scrollHeight - ctx.r.win.innerHeight} px of content is below the viewport, and ${attempts} scroll attempt${attempts === 1 ? "" : "s"} had no effect.`,
    fixText: cls.length
      ? `remove the ${cls[0]} class in every close path (including an unmount mid-animation and route changes)`
      : "release the lock in every close path, including an unmount mid-animation and route changes (cleanup in the effect's return); prefer lock utilities that count nested locks",
    ...(l.inline.length ? { plan: { type: "inline" as const, kind: "scroll-lock-stuck" as const, el: l.el, props: l.inline } } : {}),
  };
}

// --------------------------------------------------------------------------------------- control-unreachable

/** The element at all five points, if they agree. */
function sameHit(r: Reader, el: Element): Element | null {
  let hit: Element | null = null;
  for (const p of fivePoints(r.rect(el))) {
    const h = r.at(p.x, p.y);
    if (!h) return null;
    if (hit && h !== hit) return null;
    hit = h;
  }
  return hit;
}

/**
 * Whether a fixed or sticky element can be judged as the cover of a control (VISUAL.md 3.21): it has no controls of
 * its own (consent banners and bottom navigation are left out), it is a bar or banner rather than a full-screen layer
 * (an invisible full-screen layer is click-blocked's case), and it has a box. A box of 0 px is a shadow host whose
 * banner renders inside a shadow root the page does not expose (bench/visual: a consent banner's buttons were in a
 * closed shadow root, so the banner looked like a bar without controls).
 */
export function coverJudgeable(o: { width: number; height: number; innerHeight: number; controls: number }): "ok" | "has-controls" | "too-tall" | "no-box" {
  if (o.controls > 0) return "has-controls";
  if (o.width < 1 || o.height < 1) return "no-box";
  if (o.height > o.innerHeight * 0.4) return "too-tall";
  return "ok";
}

/** VISUAL.md 3.21: a control under a fixed or sticky element that scrolling cannot move it out from under. */
export function unreachableRead(r: Reader, ctl: Element, atMax: boolean): { cover: Element; pinned: Element } | null {
  const hit = sameHit(r, ctl);
  if (!hit || hit === ctl || containsDeep(ctl, hit) || containsDeep(hit, ctl)) return null;
  const p = r.pinned(hit);
  if (!p || containsDeep(p, ctl) || inDialog(p) || p.tagName === "GENCLASS-DEVTOOLS") return null;
  const pr = r.rect(p);
  if (coverJudgeable({ width: pr.width, height: pr.height, innerHeight: r.win.innerHeight, controls: focusableInside(p).filter((f) => f !== p).length }) !== "ok") return null;
  const bottom = pr.bottom >= r.win.innerHeight - 2;
  const top = pr.top <= 2;
  if (!((bottom && atMax) || (top && r.win.scrollY <= 1))) return null;
  return { cover: hit, pinned: p };
}

export function unreachableDraft(ctx: Ctx, ctl: Element, u: { cover: Element; pinned: Element }): Draft {
  const pr = ctx.r.rect(u.pinned);
  const s = ctx.r.cs(u.pinned);
  const bottom = pr.bottom >= ctx.r.win.innerHeight - 2;
  const coverSel = ctx.sel(u.pinned);
  return {
    kind: "control-unreachable",
    el: ctl,
    key: `control-unreachable|${ctx.sel(ctl)}|${coverSel}`,
    severity: "high",
    measured: { control: named(ctx, ctl), cover: coverSel, position: s.position, zIndex: s.zIndex, coverHeight: Math.round(pr.height), points: "5 of 5", scrollY: Math.round(ctx.r.win.scrollY) },
    threshold: { value: 5, unit: "of 5 hit points covered", source: `a fixed or sticky element with no controls of its own, ${bottom ? "at the end of the page" : "at the top of the page"}, 1 s apart` },
    text: `${named(ctx, ctl)} cannot be clicked: ${coverSel} (position: ${s.position}) covers all 5 of its hit points ${bottom ? "even at the end of the page" : "at the top of the page"}.`,
    suggestion: bottom
      ? { selector: "body", css: `padding-bottom: ${Math.ceil(pr.height) + 16}px;`, note: `Reserves space for ${coverSel}, or move it on small screens: @media (max-width: 640px) { ${coverSel} { bottom: ${Math.ceil(pr.height) + 24}px; } }` }
      : { selector: "body", css: `padding-top: ${Math.ceil(pr.height) + 8}px;`, note: `Reserves space for ${coverSel}.` },
  };
}

// -------------------------------------------------------------------------------------------- focus-obscured

/** The tallest cover focus-obscured judges, as a share of the viewport: a header, footer or banner, not a full-screen layer. */
export const FOCUS_COVER_MAX = 0.5;

/**
 * The cover paints over the point: its opacity is at least 0.5 and some layer from the element hit up to the fixed or
 * sticky element has a background with alpha 0.5 or more, a background image, or is an image, video or canvas. A
 * transparent layer hides nothing (bench/visual: a transparent full-screen pop-up layer was reported as hiding the
 * focused links that showed through it).
 */
export function paintsAt(layers: { bg: string; bgImage: string; tag: string }[], opacity: number): boolean {
  if (!(opacity >= 0.5)) return false;
  return layers.some((l) => {
    const c = parseColor(l.bg);
    return (!!c && c[3] >= 0.5) || (!!l.bgImage && l.bgImage !== "none") || REPLACED.has(l.tag.toUpperCase());
  });
}

function coverPaints(r: Reader, hit: Element, pin: Element): boolean {
  const layers: { bg: string; bgImage: string; tag: string }[] = [];
  for (let x: Element | null = hit; x; x = parentOf(x)) {
    const s = r.cs(x);
    layers.push({ bg: s.backgroundColor, bgImage: s.backgroundImage, tag: x.tagName });
    if (x === pin) break;
  }
  return paintsAt(layers, parseFloat(r.cs(pin).opacity));
}

/** VISUAL.md 3.22: every testable point of the target is under a painted fixed or sticky bar that is not a dialog. */
export function obscuredRead(r: Reader, target: Element, pts: { x: number; y: number }[], minPoints: number): { cover: Element; overlap: number } | null {
  let cover: Element | null = null;
  let n = 0;
  for (const p of pts) {
    const h = r.at(p.x, p.y);
    if (!h) continue;
    n++;
    if (h === target || containsDeep(target, h)) return null;
    const pin = r.pinned(h);
    if (!pin || containsDeep(pin, target) || inDialog(pin) || pin.tagName === "GENCLASS-DEVTOOLS") return null;
    if (!coverPaints(r, h, pin)) return null;
    cover ??= pin;
  }
  if (!cover || n < minPoints) return null;
  if (r.rect(cover).height > r.win.innerHeight * FOCUS_COVER_MAX) return null;
  const a = r.rect(target);
  const b = r.rect(cover);
  if (parseFloat(r.cs(target).scrollMarginTop) >= b.height) return null;
  return { cover, overlap: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) };
}

export function topEdgePoints(rc: DOMRect): { x: number; y: number }[] {
  return [0.25, 0.5, 0.75].map((f) => ({ x: Math.floor(rc.left + rc.width * f), y: Math.floor(rc.top + 4) }));
}

export function obscuredDraft(ctx: Ctx, target: Element, o: { cover: Element; overlap: number }, trigger: "focus" | "anchor"): Draft {
  const cr = ctx.r.rect(o.cover);
  const top = cr.top <= ctx.r.win.innerHeight / 2;
  const coverSel = ctx.sel(o.cover);
  const h = Math.ceil(cr.height);
  return {
    kind: "focus-obscured",
    el: target,
    key: `focus-obscured|${ctx.sel(target)}|${trigger}`,
    severity: "medium",
    measured: { target: named(ctx, target), cover: coverSel, coverHeight: h, overlap: Math.round(o.overlap), trigger },
    threshold: { value: "entirely", unit: "hidden", source: "WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum), re-checked 400 ms later" },
    text: `${trigger === "focus" ? "the focused element" : "the link target"} ${named(ctx, target)} is entirely hidden under ${coverSel} (${px(h)} tall, ${px(o.overlap)} overlap).`,
    suggestion: { selector: "html", css: `${top ? "scroll-padding-top" : "scroll-padding-bottom"}: calc(${h}px + 8px);`, note: `Or a scroll-margin-${top ? "top" : "bottom"} of ${h + 8}px on the targets.` },
  };
}

/** Skip links and targets inside a closed drawer are not judged. */
export function skipFocusTarget(r: Reader, el: Element): boolean {
  if (safeMatches(el, 'a[href^="#"]') && /skip/i.test(el.textContent ?? "")) return true;
  return r.hiddenByAncestor(el);
}

// --------------------------------------------------------------------------------------------- dialog-covered

export interface DialogRead {
  total: number;
  covered: number;
  cover?: Element;
  /** A focusable child whose centre is covered. */
  child?: Element;
  /** A focusable child below the viewport of a fixed dialog that does not scroll. */
  below?: Element;
  /** The first ancestor that makes a stacking context, and the property. */
  stacking?: { el: Element; prop: string };
}

const STACKING: [string, (s: CSSStyleDeclaration) => boolean][] = [
  ["transform", (s) => !!s.transform && s.transform !== "none"],
  ["filter", (s) => !!s.filter && s.filter !== "none"],
  ["will-change", (s) => /transform|opacity|filter/.test(s.willChange)],
  ["contain", (s) => /paint|layout|strict|content/.test(s.contain)],
  ["perspective", (s) => !!s.perspective && s.perspective !== "none"],
];

export function dialogsToTest(r: Reader): Element[] {
  return [...r.doc.querySelectorAll(DIALOG_SEL)].slice(0, 20).filter((d) => {
    if (safeMatches(d, ":modal") || safeMatches(d, ":popover-open")) return false;
    for (let p = parentOf(d); p; p = parentOf(p)) if (safeMatches(p, DIALOG_SEL)) return false;
    return r.visible(d) && r.inViewport(d);
  });
}

/** VISUAL.md 3.23: an open dialog covered by elements outside it, or with controls below a viewport it cannot scroll. */
export function dialogRead(r: Reader, dlg: Element): DialogRead {
  const rc = r.rect(dlg);
  const area = rc.width * rc.height;
  const vw = r.win.innerWidth;
  const vh = r.win.innerHeight;
  const L = Math.max(0, rc.left);
  const T = Math.max(0, rc.top);
  const W = Math.min(vw, rc.right) - L;
  const H = Math.min(vh, rc.bottom) - T;
  const pts: { x: number; y: number; child?: Element }[] = [];
  if (W > 4 && H > 4) for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.1, 0.5, 0.9]) pts.push({ x: Math.floor(L + W * fx), y: Math.floor(T + H * fy) });
  const kids = focusableInside(dlg).filter((k) => r.visible(k)).slice(0, 11);
  for (const k of kids) {
    const kr = r.rect(k);
    if (kr.bottom > 0 && kr.top < vh) pts.push({ x: Math.floor(kr.left + kr.width / 2), y: Math.floor(kr.top + kr.height / 2), child: k });
  }
  const out: DialogRead = { total: 0, covered: 0 };
  for (const p of pts) {
    const h = r.at(p.x, p.y);
    if (!h) continue;
    out.total++;
    if (containsDeep(dlg, h) || inDialog(h) || h.closest("genclass-devtools")) continue;
    const box = r.pinned(h) ?? h;
    const br = r.rect(box);
    if (br.width * br.height < 0.1 * area) continue; // a small toast over the dialog
    out.covered++;
    out.cover ??= h;
    if (p.child) out.child ??= p.child;
  }
  const s = r.cs(dlg);
  if (s.position === "fixed" && rc.bottom > vh && !/auto|scroll/.test(s.overflowY)) {
    const b = kids.length ? kids : focusableInside(dlg);
    out.below = b.find((k) => r.rect(k).top >= vh);
  }
  for (let p = parentOf(dlg); p && p !== r.doc.body; p = parentOf(p)) {
    const ps = r.cs(p);
    const hit = STACKING.find(([, test]) => test(ps));
    if (hit) {
      out.stacking = { el: p, prop: hit[0] };
      break;
    }
  }
  return out;
}

export function dialogReportable(d: DialogRead): boolean {
  return (d.total > 0 && d.covered * 2 >= d.total && d.covered > 0) || !!d.child || !!d.below;
}

export function dialogDraft(ctx: Ctx, dlg: Element, d: DialogRead): Draft {
  const sel = ctx.sel(dlg);
  const ds = ctx.r.cs(dlg);
  const cs = d.cover ? ctx.r.cs(d.cover) : null;
  const coverSel = d.cover ? ctx.sel(d.cover) : "";
  if (!d.covered && d.below) {
    return {
      kind: "dialog-covered",
      el: dlg,
      key: `dialog-covered|${sel}|below`,
      severity: "high",
      measured: { dialog: sel, unreachable: named(ctx, d.below), height: Math.round(ctx.r.rect(dlg).height), innerHeight: ctx.r.win.innerHeight, overflowY: ds.overflowY },
      threshold: { value: "below the viewport", unit: "focusable child", source: "a fixed dialog taller than the viewport that does not scroll" },
      text: `the dialog ${named(ctx, dlg)} is taller than the viewport and does not scroll: ${named(ctx, d.below)} is below the bottom edge and cannot be reached.`,
      suggestion: { selector: sel, css: "max-height: 90dvh; overflow-y: auto;" },
    };
  }
  return {
    kind: "dialog-covered",
    el: dlg,
    key: `dialog-covered|${sel}|${coverSel}`,
    severity: "high",
    measured: {
      dialog: sel,
      covered: `${d.covered} of ${d.total} points`,
      cover: coverSel,
      dialogZ: ds.zIndex,
      coverZ: cs?.zIndex ?? "auto",
      ...(d.child ? { child: named(ctx, d.child) } : {}),
      ...(d.stacking ? { stackingContext: `${d.stacking.prop} on ${ctx.sel(d.stacking.el)}` } : {}),
    },
    threshold: { value: 50, unit: "% of hit points, or any control's centre", source: "a non-top-layer dialog, tested twice 500 ms apart" },
    text: `the open dialog ${named(ctx, dlg)} is covered by ${d.cover ? named(ctx, d.cover) : "another element"}: ${d.covered} of ${d.total} points${d.child ? `, including ${named(ctx, d.child)}` : ""} (dialog z-index ${ds.zIndex}, cover z-index ${cs?.zIndex ?? "auto"})${d.stacking ? `; ${ctx.sel(d.stacking.el)} has ${d.stacking.prop}, which traps the dialog in its stacking context` : ""}.`,
    ...(d.stacking
      ? { suggestion: { selector: ctx.sel(d.stacking.el), css: `${d.stacking.prop}: none;`, note: "Or render the dialog in a portal at the end of body, or use <dialog> with showModal()." } }
      : { fixText: "render the dialog in a portal at the end of body, or use <dialog> with showModal() (the top layer is above every z-index)" }),
  };
}

/** Controls to test for control-unreachable: visible, interactive, intersecting the viewport (at most 50). */
export function controlsInView(r: Reader, max: number): Element[] {
  const out: Element[] = [];
  const all = r.doc.querySelectorAll(INTERACTIVE_SEL);
  for (let i = 0; i < all.length && i < max && out.length < 50; i++) {
    const el = all[i];
    if (el.closest("genclass-devtools") || !r.inViewport(el) || !r.visible(el) || !isInteractive(el, r)) continue;
    out.push(el);
  }
  return out;
}
