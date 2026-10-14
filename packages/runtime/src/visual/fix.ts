// Runtime fixes for measured visual checks (docs/runtime/VISUAL.md section 11). The only module that writes to the
// page, and only behind the gate the engine checks (visual.fix allows the kind, guard or heal mode, sampled in,
// visible tab, no abstain condition, the kind not disabled, fewer than 50 fixes on this page). Never in observe.
//
// Two kinds of change:
// 1. An owned rule (text-invisible): one constructed stylesheet adopted by the document, one rule per fix,
//    `[data-genclass-fix~="f3"] { color: rgb(...) !important }`, and that token on the element. The colour is generated
//    here, never page text, so the rule cannot inject CSS. App classes and inline styles are never touched.
// 2. Removing one leaked inline declaration (pointer-events-leak, scroll-lock-stuck) on html or body, after recording
//    its value and priority. Locks set through classes or stylesheets are never touched.
//
// Every fix is re-measured 50 ms later and undone if it did not clear the threshold. A colour fix is computed for one
// background: it is re-measured on every periodic read, after class and style changes anywhere and when the colour
// scheme changes, and undone as soon as the background differs or the colour no longer reaches its target (the app's
// own colour may be right again, for example when an item stops being the active one). Undo restores exactly what was
// there; a developer undo disables the kind for the session (three undos disable all fixes). When the app changes a
// fixed element's class or style, or replaces it, the fix is dropped, never restored over the app's write. Tokens
// carry a per-engine prefix, so two runtimes on one page never share a rule.

import type { AuditEntry, CheckFinding, Clock, VisualFixKind } from "../types.js";
import type { FixPlan } from "./draft.js";
import type { Win } from "./measure.js";

export const FIX_KINDS: VisualFixKind[] = ["text-invisible", "pointer-events-leak", "scroll-lock-stuck"];
export const MAX_FIXES = 50;
/** The undo reason when a colour fix no longer fits its element (a re-check may apply it again). */
export const CONTEXT_CHANGED = "the background or colour scheme changed, so the fix no longer fits";
const ATTR = "data-genclass-fix";

export interface FixHost {
  win: Win;
  clock: Clock;
  audit(fix: NonNullable<AuditEntry["fix"]>): void;
  note(message: string, f: CheckFinding, important: boolean): void;
  warn(message: string): void;
  /** Run a write so that the engine's MutationObserver does not see it as an app change. */
  quietly(fn: () => void): void;
  /** Token prefix of this engine (default none). */
  prefix?: string;
}

interface Applied {
  id: string;
  kind: VisualFixKind;
  el: Element;
  finding: CheckFinding;
  css: string;
  rule?: CSSRule;
  token?: string;
  inline?: { prop: string; value: string; priority: string }[];
  /** Re-measure later (colour fixes): false means the fix no longer fits. */
  recheck?: () => boolean;
}

type AdoptDoc = Document & { adoptedStyleSheets?: CSSStyleSheet[] };

export class Fixer {
  private sheet: CSSStyleSheet | null = null;
  private readopted = false;
  private seq = 0;
  private live = new Map<string, Applied>();
  private perKey = new Map<string, number>();
  private disabledKinds = new Set<VisualFixKind>();
  private devUndos = 0;
  private pageFixes = 0;
  /** Fixes off for the rest of the session (a CSP style-src violation, three developer undos, the page removed our sheet). */
  off = false;
  applied = 0;
  undone = 0;

  constructor(private readonly h: FixHost) {}

  get active(): number {
    return this.live.size;
  }

  /** Live owned-rule (colour) fixes. */
  get colour(): number {
    let n = 0;
    for (const a of this.live.values()) if (a.rule) n++;
    return n;
  }

  /** A removed inline declaration is live. */
  get inline(): boolean {
    for (const a of this.live.values()) if (a.inline) return true;
    return false;
  }

  /** The kind may be fixed now (the engine checks mode, sampling and visibility). */
  allowed(kind: VisualFixKind, key: string): boolean {
    return !this.off && !this.disabledKinds.has(kind) && this.pageFixes < MAX_FIXES && (this.perKey.get(key) ?? 0) < 2;
  }

  /** A new page (route change): the per-page counters start again. */
  newPage(): void {
    this.pageFixes = 0;
    this.perKey.clear();
  }

  /**
   * Apply a plan for a finding. `verify` re-measures 50 ms later (true: the threshold is cleared); `recheck`, when
   * given, re-measures on every reverify() afterwards. Returns the finding's `fix` value.
   */
  apply(plan: FixPlan, f: CheckFinding, key: string, verify: () => boolean, recheck?: () => boolean): NonNullable<CheckFinding["fix"]> {
    const doc = this.h.win.document as AdoptDoc;
    const id = `f${this.h.prefix ?? ""}${++this.seq}`;
    const a: Applied = { id, kind: plan.kind, el: plan.el, finding: f, css: "", ...(recheck ? { recheck } : {}) };
    const fail = (reason: string): NonNullable<CheckFinding["fix"]> => ({ id, applied: false, reason, undo: () => false });
    try {
      if (plan.type === "color") {
        const Sheet = this.h.win.CSSStyleSheet;
        if (!Sheet || !Array.isArray(doc.adoptedStyleSheets)) return fail("this browser has no constructed stylesheets (adoptedStyleSheets)");
        if (!/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/.test(plan.color)) return fail("no safe colour");
        if (!this.sheet) {
          this.sheet = new Sheet();
          doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, this.sheet];
        }
        const decl = `color: ${plan.color} !important;${plan.fill ? ` -webkit-text-fill-color: ${plan.color} !important;` : ""}`;
        const i = this.sheet.insertRule(`[${ATTR}~="${id}"] { ${decl} }`, this.sheet.cssRules.length);
        a.rule = this.sheet.cssRules[i];
        a.token = id;
        a.css = `${f.selector} { ${decl.replace(/ !important/g, "")} }`;
        this.h.quietly(() => {
          const cur = plan.el.getAttribute(ATTR);
          plan.el.setAttribute(ATTR, cur ? `${cur} ${id}` : id);
        });
      } else {
        const el = plan.el;
        const rec: { prop: string; value: string; priority: string }[] = [];
        for (const prop of plan.props) {
          const value = el.style.getPropertyValue(prop);
          if (!value) continue;
          rec.push({ prop, value, priority: el.style.getPropertyPriority(prop) });
        }
        if (!rec.length) return fail("the inline declaration is gone");
        this.h.quietly(() => {
          for (const r of rec) el.style.removeProperty(r.prop);
        });
        a.inline = rec;
        a.css = `removed the inline ${rec.map((r) => `${r.prop}: ${r.value}`).join("; ")} on ${el === doc.body ? "body" : "html"}`;
      }
    } catch (e) {
      return fail(`could not apply: ${(e as Error)?.message ?? e}`);
    }
    this.live.set(id, a);
    this.applied++;
    this.pageFixes++;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    this.h.audit({ what: "apply", checkId: f.id, kind: f.kind, css: a.css });
    const out: NonNullable<CheckFinding["fix"]> = {
      id,
      applied: true,
      css: a.css,
      undo: () => this.undo(id, "undone by the developer", true),
    };
    this.h.clock.setTimeout(() => {
      if (!this.live.has(id)) return;
      let ok = false;
      try {
        ok = verify();
      } catch {
        ok = false;
      }
      if (!ok) this.undo(id, "did not clear the threshold", false);
    }, 50);
    return out;
  }

  /** Reverse a fix exactly. `developer`: counts toward disabling the kind (and all fixes after three). */
  undo(id: string, reason: string, developer: boolean): boolean {
    const a = this.live.get(id);
    if (!a) return false;
    this.live.delete(id);
    this.revert(a, true);
    this.undone++;
    if (a.finding.fix) {
      a.finding.fix.applied = false;
      a.finding.fix.reason = reason;
    }
    if (developer) {
      this.disabledKinds.add(a.kind);
      if (++this.devUndos >= 3) this.off = true;
    }
    this.h.audit({ what: "undo", checkId: a.finding.id, kind: a.kind, css: a.css, reason });
    this.h.note(`[GenClass] Undid the CSS fix for check ${a.finding.id} (${reason}): ${a.css}.${developer ? ` Fixes of kind ${a.kind} stay off for this session.` : ""}`, a.finding, true);
    return true;
  }

  /** Forget a fix because the app took the element or value over (never written back over the app). */
  drop(id: string, reason: string): void {
    const a = this.live.get(id);
    if (!a) return;
    this.live.delete(id);
    this.revert(a, false);
    if (a.finding.fix) {
      a.finding.fix.applied = false;
      a.finding.fix.reason = reason;
    }
    this.h.audit({ what: "drop", checkId: a.finding.id, kind: a.kind, css: a.css, reason });
    this.h.note(`[GenClass] Dropped the CSS fix for check ${a.finding.id}: ${reason}.`, a.finding, false);
  }

  undoAll(reason: string): void {
    for (const id of [...this.live.keys()]) this.undo(id, reason, false);
  }

  /** Re-measure the fixes that can be (colour fixes): undo each one that no longer fits (CONTEXT_CHANGED). */
  reverify(): void {
    for (const a of [...this.live.values()]) {
      if (!a.recheck || !this.live.has(a.id)) continue;
      let ok = false;
      try {
        ok = a.recheck();
      } catch {
        ok = false;
      }
      if (!ok) this.undo(a.id, CONTEXT_CHANGED, false);
    }
  }

  /** Drop every inline fix (a dialog or menu opened: the app owns html/body again). */
  dropInline(reason: string): void {
    for (const a of [...this.live.values()]) if (a.inline) this.drop(a.id, reason);
  }

  /** The app changed a fixed element's class or style, or removed it: drop those fixes. */
  watch(records: MutationRecord[]): void {
    if (!this.live.size) return;
    for (const rec of records) {
      for (const a of [...this.live.values()]) {
        if (rec.type === "attributes" && rec.target === a.el && (rec.attributeName === "class" || rec.attributeName === "style")) this.drop(a.id, `the app changed the element's ${rec.attributeName}`);
        else if (rec.type === "childList") for (const n of rec.removedNodes) if (n === a.el || (n.nodeType === 1 && (n as Element).contains(a.el))) this.drop(a.id, "the app replaced the element");
      }
    }
  }

  /** Our stylesheet is still adopted; a page that replaces adoptedStyleSheets gets one re-adoption, then fixes stop. */
  checkSheet(): void {
    const doc = this.h.win.document as AdoptDoc;
    if (!this.sheet || !Array.isArray(doc.adoptedStyleSheets) || doc.adoptedStyleSheets.includes(this.sheet)) return;
    const owned = [...this.live.values()].filter((a) => a.rule);
    if (!owned.length) return;
    if (!this.readopted) {
      this.readopted = true;
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, this.sheet];
      return;
    }
    for (const a of owned) this.drop(a.id, "fix removed by the page (it replaced document.adoptedStyleSheets)");
    this.disabledKinds.add("text-invisible");
  }

  /** A CSP style-src violation while fixes are active: remove them all and stop fixing for the session. */
  cspBlocked(): void {
    if (!this.live.size || this.off) return;
    this.undoAll("a Content-Security-Policy style-src violation happened while fixes were active");
    this.off = true;
    this.h.warn("Visual fixes are off for this session: a Content-Security-Policy style-src violation happened while they were active.");
  }

  private revert(a: Applied, restore: boolean): void {
    this.h.quietly(() => {
      if (a.rule && this.sheet) {
        const rules = this.sheet.cssRules;
        for (let i = rules.length - 1; i >= 0; i--) if (rules[i] === a.rule) this.sheet.deleteRule(i);
      }
      if (a.token) {
        const toks = (a.el.getAttribute(ATTR) ?? "").split(/\s+/).filter((t) => t && t !== a.token);
        if (toks.length) a.el.setAttribute(ATTR, toks.join(" "));
        else a.el.removeAttribute(ATTR);
      }
      if (a.inline && restore) {
        const el = a.el as HTMLElement;
        for (const r of a.inline) if (!el.style.getPropertyValue(r.prop)) el.style.setProperty(r.prop, r.value, r.priority);
      }
    });
  }
}
