// @vitest-environment happy-dom
// Runtime fixes of the measured visual checks (docs/runtime/VISUAL.md section 11; src/visual/fix.ts): an owned rule
// plus a token attribute, or one removed inline declaration on html/body; undo restores exactly; the app's own writes
// win; the gate never fixes in observe; setMode("observe") undoes everything.
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, CheckFinding, ModeOrOff } from "../src/types.js";
import type { Draft } from "../src/visual/draft.js";
import { Visual } from "../src/visual/engine.js";
import { CONTEXT_CHANGED, Fixer, MAX_FIXES } from "../src/visual/fix.js";
import type { VisualHost } from "../src/visual/host.js";
import { FakeClock } from "./helpers.js";

class FakeSheet {
  cssRules: { cssText: string }[] = [];
  insertRule(t: string, i: number): number {
    this.cssRules.splice(i, 0, { cssText: t });
    return i;
  }
  deleteRule(i: number): void {
    this.cssRules.splice(i, 1);
  }
}

function fixer(prefix?: string) {
  const clock = new FakeClock();
  const doc = { adoptedStyleSheets: [] as unknown[], body: document.body, documentElement: document.documentElement };
  const audits: NonNullable<AuditEntry["fix"]>[] = [];
  const notes: string[] = [];
  const warns: string[] = [];
  const fx = new Fixer({
    win: { document: doc, CSSStyleSheet: FakeSheet } as never,
    clock,
    audit: (a) => void audits.push(a),
    note: (m) => void notes.push(m),
    warn: (m) => void warns.push(m),
    quietly: (fn) => fn(),
    ...(prefix !== undefined ? { prefix } : {}),
  });
  return { fx, clock, doc, audits, notes, warns };
}

const finding = (id = "c1"): CheckFinding => ({
  id,
  source: "check",
  kind: "text-invisible",
  severity: "high",
  at: 0,
  target: "x",
  selector: "p.hero",
  element: () => null,
  measured: {},
  threshold: { value: 1.5, unit: ":1", source: "test" },
  context: { scheme: "light", viewport: { w: 1, h: 1 }, coarse: false, tier: "full" },
  message: "m",
  details: [],
});

afterEach(() => {
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
});

describe("visual fixes: owned rule (VISUAL.md 11.2, 11.3)", () => {
  it("applies one rule and a token; developer undo restores the element exactly and turns the kind off", () => {
    const { fx, doc, audits } = fixer();
    document.body.innerHTML = '<p class="hero" style="margin: 0">Hi</p>';
    const p = document.querySelector("p")!;
    const before = p.outerHTML;
    const f = finding();
    const fix = (f.fix = fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(115, 115, 115)", fill: false, target: 4.5 }, f, "k1", () => true));
    expect(fix.applied).toBe(true);
    expect(doc.adoptedStyleSheets.length).toBe(1);
    const sheet = doc.adoptedStyleSheets[0] as FakeSheet;
    expect(sheet.cssRules.map((r) => r.cssText)).toEqual([`[data-genclass-fix~="${fix.id}"] { color: rgb(115, 115, 115) !important; }`]);
    expect(p.getAttribute("data-genclass-fix")).toBe(fix.id);
    expect(p.getAttribute("class")).toBe("hero"); // app classes and inline styles untouched
    expect(p.getAttribute("style")).toBe("margin: 0");
    expect(fix.undo()).toBe(true);
    expect(p.outerHTML).toBe(before);
    expect(sheet.cssRules).toEqual([]);
    expect(fix.undo()).toBe(false);
    expect(fx.allowed("text-invisible", "k2")).toBe(false); // a developer undo turns the kind off for the session
    expect(audits.map((a) => a.what)).toEqual(["apply", "undo"]);
  });

  it("a fix that does not clear the threshold is undone 50 ms later", async () => {
    const { fx, clock, notes } = fixer();
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    const f = finding();
    f.fix = fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(115, 115, 115)", fill: true, target: 4.5 }, f, "k1", () => false);
    await clock.advance(49);
    expect(p.hasAttribute("data-genclass-fix")).toBe(true);
    await clock.advance(1);
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(f.fix.applied).toBe(false);
    expect(f.fix.reason).toBe("did not clear the threshold");
    expect(notes.at(-1)).toContain("did not clear the threshold");
    expect(fx.allowed("text-invisible", "k2")).toBe(true); // not a developer undo
  });

  it("a colour fix that no longer fits its element is undone (the item stopped being active, the scheme changed)", () => {
    const { fx, audits } = fixer();
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    const f = finding();
    let fits = true;
    f.fix = fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(17, 24, 39)", fill: false, target: 4.5, bg: "#ffffff" }, f, "k", () => true, () => fits);
    expect(fx.colour).toBe(1);
    fx.reverify();
    expect(p.hasAttribute("data-genclass-fix")).toBe(true);
    fits = false; // the background it was computed for is gone
    fx.reverify();
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(f.fix.applied).toBe(false);
    expect(f.fix.reason).toBe(CONTEXT_CHANGED);
    expect(fx.allowed("text-invisible", "k2")).toBe(true); // not a developer undo: the kind stays on
    expect(audits.map((a) => a.what)).toEqual(["apply", "undo"]);
  });

  it("two engines on one page never share a token (a per-engine prefix)", () => {
    const a = fixer("a1-");
    const b = fixer("b2-");
    document.body.innerHTML = "<p>One</p><p>Two</p>";
    const [p1, p2] = [...document.querySelectorAll("p")];
    const fa = a.fx.apply({ type: "color", kind: "text-invisible", el: p1, color: "rgb(0, 0, 0)", fill: false, target: 4.5, bg: "#ffffff" }, finding(), "k", () => true);
    const fb = b.fx.apply({ type: "color", kind: "text-invisible", el: p2, color: "rgb(255, 255, 255)", fill: false, target: 4.5, bg: "#000000" }, finding(), "k", () => true);
    expect(fa.id).not.toBe(fb.id);
    expect(p1.getAttribute("data-genclass-fix")).toBe("fa1-1");
    expect(p2.getAttribute("data-genclass-fix")).toBe("fb2-1");
    expect((a.doc.adoptedStyleSheets[0] as FakeSheet).cssRules[0].cssText).toContain('[data-genclass-fix~="fa1-1"]');
  });

  it("never writes a colour it did not generate", () => {
    const { fx } = fixer();
    document.body.innerHTML = "<p>Hi</p>";
    const f = finding();
    const fix = fx.apply({ type: "color", kind: "text-invisible", el: document.querySelector("p")!, color: "red; } * { display: none", fill: false, target: 4.5 }, f, "k", () => true);
    expect(fix.applied).toBe(false);
    expect(document.querySelector("p")!.hasAttribute("data-genclass-fix")).toBe(false);
  });

  it("the app changing the element's class drops the fix (never restored over the app's write)", () => {
    const { fx, audits } = fixer();
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    const f = finding();
    f.fix = fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(0, 0, 0)", fill: false, target: 4.5 }, f, "k", () => true);
    fx.watch([{ type: "attributes", target: p, attributeName: "class" } as unknown as MutationRecord]);
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(fx.active).toBe(0);
    expect(audits.map((a) => a.what)).toEqual(["apply", "drop"]);
  });

  it("at most two applications per finding and 50 per page; a CSP style-src violation turns fixes off", () => {
    const { fx, warns } = fixer();
    document.body.innerHTML = "<p>Hi</p>";
    const p = document.querySelector("p")!;
    for (let i = 0; i < 2; i++) fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(0, 0, 0)", fill: false, target: 4.5 }, finding(), "same", () => true);
    expect(fx.allowed("text-invisible", "same")).toBe(false);
    for (let i = 0; i < MAX_FIXES; i++) fx.apply({ type: "color", kind: "text-invisible", el: p, color: "rgb(0, 0, 0)", fill: false, target: 4.5 }, finding(), `k${i}`, () => true);
    expect(fx.allowed("text-invisible", "fresh")).toBe(false);
    fx.newPage();
    expect(fx.allowed("text-invisible", "fresh")).toBe(true);
    fx.cspBlocked();
    expect(fx.active).toBe(0);
    expect(fx.off).toBe(true);
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(warns.length).toBe(1);
  });
});

describe("visual fixes: a leaked inline declaration (VISUAL.md 11.2, 11.3)", () => {
  it("removes it, and undo restores the value and priority", () => {
    const { fx } = fixer();
    document.body.style.setProperty("pointer-events", "none", "important");
    const f = finding();
    const fix = fx.apply({ type: "inline", kind: "pointer-events-leak", el: document.body, props: ["pointer-events"] }, f, "k", () => true);
    expect(fix.applied).toBe(true);
    expect(fix.css).toBe("removed the inline pointer-events: none on body");
    expect(document.body.style.getPropertyValue("pointer-events")).toBe("");
    expect(fix.undo()).toBe(true);
    expect(document.body.style.getPropertyValue("pointer-events")).toBe("none");
    expect(document.body.style.getPropertyPriority("pointer-events")).toBe("important");
  });

  it("undo leaves an inline value the app wrote since", () => {
    const { fx } = fixer();
    document.body.style.setProperty("overflow", "hidden");
    const f = finding();
    const fix = fx.apply({ type: "inline", kind: "scroll-lock-stuck", el: document.body, props: ["overflow", "overflow-y"] }, f, "k", () => true);
    expect(document.body.style.overflow).toBe("");
    document.body.style.overflow = "scroll";
    fix.undo();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("a dialog opening drops inline fixes: the app owns html and body again", () => {
    const { fx } = fixer();
    document.body.style.setProperty("pointer-events", "none");
    fx.apply({ type: "inline", kind: "pointer-events-leak", el: document.body, props: ["pointer-events"] }, finding(), "k", () => true);
    fx.dropInline("a dialog opened");
    expect(fx.active).toBe(0);
    expect(document.body.style.getPropertyValue("pointer-events")).toBe(""); // forgotten, not restored
  });
});

describe("the fix gate (VISUAL.md 11.1)", () => {
  function engine(mode: { m: ModeOrOff }) {
    const clock = new FakeClock();
    const rect = { width: 1024, height: 768, top: 0, left: 0, right: 1024, bottom: 768, x: 0, y: 0, toJSON: () => ({}) };
    document.documentElement.getBoundingClientRect = () => rect as DOMRect;
    const reports: CheckFinding[] = [];
    const host: VisualHost = {
      clock,
      global: window as unknown as Record<string, unknown>,
      seed: "s",
      mode: () => mode.m,
      sampled: () => true,
      active: () => true,
      inflight: () => 0,
      errors: () => 0,
      describe: () => 'paragraph "Hi"',
      route: () => "/",
      report: (f) => void reports.push(f),
      note: () => undefined,
      audit: () => undefined,
    };
    const v = new Visual(host, { on: true, fix: true }, [], false);
    return { v, reports };
  }

  const draft = (el: Element): Draft => ({
    kind: "text-invisible",
    el,
    key: "text-invisible|p.hero|rest|light",
    severity: "high",
    measured: { ratio: 1 },
    threshold: { value: 1.5, unit: ":1", source: "test" },
    text: "text contrast 1.00:1 on p.hero, below 1.5:1.",
    plan: { type: "color", kind: "text-invisible", el, color: "rgb(115, 115, 115)", fill: false, target: 4.5, bg: "#ffffff" },
  });

  it("observe with fix: true: reported, nothing written", () => {
    document.body.innerHTML = '<p class="hero">Hi</p>';
    const p = document.querySelector("p")!;
    const sheets = document.adoptedStyleSheets.length;
    const { v, reports } = engine({ m: "observe" });
    (v as unknown as { publish(d: Draft[]): CheckFinding[] }).publish([draft(p)]);
    expect(reports.length).toBe(1);
    expect(reports[0].fix).toBeUndefined();
    expect(reports[0].details.some((l) => l.startsWith("Runtime fix: not applied (the mode here is observe"))).toBe(true);
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(document.adoptedStyleSheets.length).toBe(sheets);
    v.stop();
  });

  it("guard: applied; the mode dropping to observe undoes it", () => {
    document.body.innerHTML = '<p class="hero">Hi</p>';
    const p = document.querySelector("p")!;
    const mode = { m: "guard" as ModeOrOff };
    const { v, reports } = engine(mode);
    (v as unknown as { publish(d: Draft[]): CheckFinding[] }).publish([draft(p)]);
    expect(reports[0].fix?.applied).toBe(true);
    expect(p.getAttribute("data-genclass-fix")).toMatch(/^f[0-9a-z]+-\d+$/);
    mode.m = "observe";
    v.gateFixes();
    expect(p.hasAttribute("data-genclass-fix")).toBe(false);
    expect(reports[0].fix?.applied).toBe(false);
    v.stop();
  });

  it("a colour fix stays while its element is scrolled out of view (nothing to re-measure there)", () => {
    document.body.innerHTML = '<p class="hero">Hi</p>';
    const p = document.querySelector("p")!;
    const { v, reports } = engine({ m: "guard" });
    (v as unknown as { publish(d: Draft[]): CheckFinding[] }).publish([draft(p)]);
    expect(reports[0].fix?.applied).toBe(true);
    // the banner scrolled above the viewport: the periodic re-measure must not read that as a changed background
    p.getBoundingClientRect = () => ({ width: 300, height: 20, top: -400, left: 0, right: 300, bottom: -380, x: 0, y: -400, toJSON: () => ({}) }) as DOMRect;
    (v as unknown as { fixer: { reverify(): void } }).fixer.reverify();
    expect(reports[0].fix?.applied).toBe(true);
    expect(p.hasAttribute("data-genclass-fix")).toBe(true);
    v.stop();
  });
});
