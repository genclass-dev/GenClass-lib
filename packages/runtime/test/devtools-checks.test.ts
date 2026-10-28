// @vitest-environment happy-dom
// The devtools overlay's Checks tab (docs/runtime/VISUAL.md 9.3): measured visual check findings from rt.checks() and
// the "check" event, labelled "measured", with the measured value against its threshold, the suggested CSS (Copy), a
// Show button that outlines the element inside the overlay's own shadow root, and Undo for an applied fix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDevtools, type DevtoolsHandle } from "../src/devtools/index.js";
import type { CheckFinding } from "../src/types.js";
import { MockRuntime } from "./browser/ui/mock-runtime.js";

const frame = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));
let handles: DevtoolsHandle[] = [];
afterEach(() => {
  for (const h of handles) h.unmount();
  handles = [];
  document.body.innerHTML = "";
});

function finding(o: Partial<CheckFinding> = {}): CheckFinding {
  return {
    id: "c1",
    source: "check",
    kind: "text-invisible",
    severity: "high",
    at: 0,
    target: 'paragraph "Ship faster"',
    selector: "p.hero__subtitle",
    element: () => null,
    measured: { ratio: 1.04 },
    threshold: { value: 1.5, unit: ":1 contrast", source: "WCAG 2.2 contrast formula; unreadable-text threshold" },
    context: { scheme: "light", viewport: { w: 1280, h: 800 }, coarse: false, tier: "full" },
    message: '[GenClass] Check (measured): text contrast 1.04:1 on p.hero__subtitle "Ship faster", below 1.5:1. Suggested CSS: p.hero__subtitle { color: #737373; }',
    details: [],
    suggestion: { selector: "p.hero__subtitle", css: "color: #737373;" },
    ...o,
  };
}

function mount(rt: MockRuntime) {
  const h = mountDevtools(rt, { collapsed: false });
  handles.push(h);
  const sr = (h.element as HTMLElement).shadowRoot as ShadowRoot;
  return { sr, $: (s: string) => sr.querySelector<HTMLElement>(s), $$: (s: string) => [...sr.querySelectorAll<HTMLElement>(s)] };
}

describe("devtools: Checks tab (VISUAL.md 9.3)", () => {
  it("lists findings from the check event with their measurement, threshold and suggested CSS", async () => {
    const rt = new MockRuntime();
    const { $, $$ } = mount(rt);
    expect($('[data-pane="checks"] .empty')?.hidden).toBe(false);
    rt.emitTo("check", finding());
    await frame();
    expect($('[data-tab="checks"] .n')?.textContent).toBe("1");
    $('[data-tab="checks"]')!.click();
    await frame();
    const cards = $$('[data-pane="checks"] article.card');
    expect(cards.length).toBe(1);
    expect(cards[0].querySelector(".ct")?.textContent).toBe("text-invisible");
    expect(cards[0].querySelector(".badge")?.textContent).toBe("measured");
    expect(cards[0].querySelector(".cx")?.textContent).toBe('text contrast 1.04:1 on p.hero__subtitle "Ship faster", below 1.5:1.');
    expect(cards[0].querySelector('[data-part="css"]')?.textContent).toBe("p.hero__subtitle { color: #737373; }");
    expect(cards[0].textContent).toContain("threshold 1.5 :1 contrast");
    expect($('[data-pane="checks"] .empty')?.hidden).toBe(true);
    // the same finding twice is one card
    rt.emitTo("check", finding());
    await frame();
    expect($$('[data-pane="checks"] article.card').length).toBe(1);
  });

  it("backfills rt.checks() on mount and asks a 'local' runtime to start its checks", async () => {
    const rt = new MockRuntime() as MockRuntime & { checks(): CheckFinding[]; vis: { start(): void } };
    const start = vi.fn();
    rt.checks = () => [finding(), finding({ id: "c2", kind: "page-overflow-x", severity: "medium", suggestion: undefined, message: "[GenClass] Check (measured): the page scrolls sideways." })];
    rt.vis = { start };
    const { $, $$ } = mount(rt);
    await frame();
    expect(start).toHaveBeenCalledTimes(1);
    $('[data-tab="checks"]')!.click();
    await frame();
    expect($$('[data-pane="checks"] article.card').map((c) => c.dataset.kind)).toEqual(["page-overflow-x", "text-invisible"]); // newest first
  });

  it("Undo removes an applied fix; Show outlines the element inside the overlay, never in the page", async () => {
    const rt = new MockRuntime();
    const { $ } = mount(rt);
    document.body.insertAdjacentHTML("beforeend", '<p class="hero__subtitle">Ship faster</p>');
    const p = document.querySelector("p")!;
    p.scrollIntoView = () => undefined;
    const undo = vi.fn(() => true);
    rt.emitTo("check", finding({ element: () => p, fix: { id: "f1", applied: true, css: "p.hero__subtitle { color: rgb(115, 115, 115); }", undo } }));
    $('[data-tab="checks"]')!.click();
    await frame();
    expect($('[data-pane="checks"] .note.chg')?.textContent).toContain("Runtime fix applied");
    const before = document.body.innerHTML;
    $('[data-pane="checks"] [data-act="show"]')!.click();
    await frame(320);
    expect($('[data-part="highlight"]')).toBeTruthy();
    expect(document.body.innerHTML).toBe(before);
    $('[data-pane="checks"] [data-act="undo"]')!.click();
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("counts measured checks in the collapsed pill, names them in words and opens on them (VISUAL.md 9.3)", async () => {
    const rt = new MockRuntime();
    const h = mountDevtools(rt, {});
    handles.push(h);
    const sr = (h.element as HTMLElement).shadowRoot as ShadowRoot;
    const $ = (s: string) => sr.querySelector<HTMLElement>(s);
    expect($(".pc.c b")?.textContent).toBe("0");
    expect($(".pc.c")?.classList.contains("on")).toBe(false);
    const undo = vi.fn(() => true);
    rt.emitTo("check", finding({ fix: { id: "f1", applied: true, css: "p.hero__subtitle { color: rgb(115, 115, 115); }", undo } }));
    rt.emitTo("check", finding({ id: "c2", kind: "scroll-lock-stuck", suggestion: undefined, message: "[GenClass] Check (measured): the page cannot scroll." }));
    await frame();
    // a page GenClass fixed on screen does not read "0 · 0": the pill's third counter has the checks, and it pulses
    expect($(".pc.a b")?.textContent).toBe("0");
    expect($(".pc.d b")?.textContent).toBe("0");
    expect($(".pc.c b")?.textContent).toBe("2");
    expect($(".pc.c")?.classList.contains("on")).toBe(true);
    expect($(".pc.c")?.title).toBe("2 measured checks, 1 fixed on screen");
    expect($(".pill")?.getAttribute("aria-label")).toContain("2 checks (1 fixed)");
    expect($(".pill")?.classList.contains("pck")).toBe(true);
    // with no interventions or detections yet, the panel opens on the checks
    $(".pill")!.click();
    await frame();
    expect($('[data-tab="checks"]')?.getAttribute("aria-selected")).toBe("true");
    const cards = [...sr.querySelectorAll<HTMLElement>('[data-pane="checks"] article.card')];
    expect(cards.map((c) => c.querySelector(".cl")?.textContent)).toEqual(["Page cannot scroll", "Invisible text"]);
    expect(cards.map((c) => c.querySelector(".ct")?.textContent)).toEqual(["scroll-lock-stuck", "text-invisible"]);
  });
});
