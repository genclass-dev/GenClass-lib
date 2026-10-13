// Measured visual checks in real Chromium (docs/runtime/VISUAL.md section 14). Each fixture page marks every planted
// fault with data-expect="<kind> ..."; a test asserts the exact finding set: every marked kind is found on its
// element (recall) and nothing else is reported (no false reports). Clean controls sit next to the faults on every
// page, and clean.html is a whole page of correct-but-tricky patterns that must produce zero findings.
//
// The pages load dist/genclass.global.js from a 127.0.0.1 server (a development host, so the checks are on by
// default), with the model and telemetry off. Every test checks document.visibilityState === "visible" first: the
// checks never measure a hidden tab.

import { expect, test, type Page } from "@playwright/test";
import { png, startServer } from "./server.mjs";

let base = "";
let close: () => Promise<void> = async () => undefined;

test.beforeAll(async () => {
  const s = await startServer();
  base = s.url;
  close = s.close;
});
test.afterAll(async () => {
  await close();
});

interface Seen {
  kind: string;
  marked: string | null;
  id: string | null;
  selector: string;
  message: string;
  state?: string;
  scheme: string;
  fix?: { applied: boolean; css?: string; reason?: string };
}

/** Open a fixture and wait until the first automatic pass has run. */
async function open(page: Page, path: string): Promise<void> {
  await page.route("https://placehold.co/**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: png(300, 120) }));
  await page.goto(`${base}${path}`);
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  await page.waitForFunction(() => ((window as unknown as { GenClass?: { runtime?: { summary(): { visual?: { passes: number } } } } }).GenClass?.runtime?.summary().visual?.passes ?? 0) >= 1, null, { timeout: 30_000 });
}

/** Every finding so far, with the data-expect marker of its element. */
async function seen(page: Page, attr = "data-expect"): Promise<Seen[]> {
  return page.evaluate((attr) => {
    const rt = (window as unknown as { GenClass: { runtime: { checks(): { kind: string; selector: string; message: string; element(): Element | null; context: { state?: string; scheme: string }; fix?: { applied: boolean; css?: string; reason?: string } }[] } } }).GenClass.runtime;
    return rt.checks().map((f) => {
      const el = f.element()?.closest(`[${attr}]`) ?? null;
      return {
        kind: f.kind,
        marked: el?.getAttribute(attr) ?? null,
        id: el?.getAttribute("data-k") ?? null,
        selector: f.selector,
        message: f.message,
        state: f.context.state,
        scheme: f.context.scheme,
        fix: f.fix ? { applied: f.fix.applied, css: f.fix.css, reason: f.fix.reason } : undefined,
      };
    });
  }, attr);
}

/** Run a pass now (with its persistence re-checks), then return everything found. */
async function settle(page: Page, attr?: string): Promise<Seen[]> {
  await page.evaluate(() => (window as unknown as { GenClass: { runtime: { checkNow(): Promise<unknown> } } }).GenClass.runtime.checkNow());
  return seen(page, attr);
}

/** The planted faults: [element id, kind] pairs from data-expect. */
async function planted(page: Page, attr = "data-expect"): Promise<string[]> {
  return page.evaluate((attr) => [...document.querySelectorAll(`[${attr}]`)].flatMap((el) => (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean).map((k) => `${el.getAttribute("data-k")} ${k}`)).sort(), attr);
}

/** Exactly the planted findings: each on its marked element, nothing unmarked. */
function exact(found: Seen[], want: string[]): void {
  const unexpected = found.filter((f) => !f.marked || !f.marked.split(/\s+/).includes(f.kind));
  expect(unexpected, `unexpected findings:\n${unexpected.map((f) => f.message).join("\n")}`).toEqual([]);
  const got = [...new Set(found.map((f) => `${f.id} ${f.kind}`))].sort();
  expect(got).toEqual(want);
}

async function until(page: Page, kind: string, timeout = 25_000): Promise<void> {
  await page.waitForFunction((k) => (window as unknown as { GenClass: { runtime: { checks(): { kind: string }[] } } }).GenClass.runtime.checks().some((f) => f.kind === k), kind, { timeout });
}

test.describe("measured visual checks (VISUAL.md section 14)", () => {
  test("a clean page of tricky but correct patterns: zero findings, nothing written to the page", async ({ page }) => {
    await open(page, "/f/clean.html");
    const found = await settle(page);
    expect(found.map((f) => f.message)).toEqual([]);
    expect(await page.evaluate(() => document.querySelectorAll("[data-genclass-fix]").length + document.adoptedStyleSheets.length)).toBe(0);
    const v = await page.evaluate(() => (window as unknown as { GenClass: { runtime: { summary(): { visual: { passes: number; abstained: number; checks: object } } } } }).GenClass.runtime.summary().visual);
    expect(v.passes).toBeGreaterThanOrEqual(2);
    expect(v.checks).toEqual({});
    expect(v.abstained).toBeGreaterThan(0); // gradient, image, shadow and translucent text abstain instead of guessing
  });

  test("the clean page on a phone (390 x 844): zero findings", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await open(page, "/f/clean.html");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
    await ctx.close();
  });

  test("text-invisible: white on white, near-white, dark on dark, translucent; clean controls next to them", async ({ page }) => {
    await open(page, "/f/text.html");
    const found = await settle(page);
    exact(found, await planted(page));
    const t1 = found.find((f) => f.id === "t1")!;
    expect(t1.message).toMatch(/^\[GenClass\] Check \(measured\): text contrast 1\.00:1 on p\.hero__subtitle .*, below 1\.5:1 \(WCAG 2\.2 contrast formula/);
    expect(t1.message).toContain("Suggested CSS: p.hero__subtitle { color: #");
    expect(t1.message).not.toMatch(/\(\w+, 0\.\d\d\)$/); // never a model-style probability
    // observe mode wrote nothing
    expect(await page.evaluate(() => document.querySelectorAll("[data-genclass-fix]").length + document.adoptedStyleSheets.length)).toBe(0);
  });

  test("assets: broken image, CSS background, stylesheet, web font, icon font, media, placeholder image", async ({ page }) => {
    await open(page, "/f/assets.html");
    const found = await settle(page);
    exact(found, await planted(page));
    expect(found.find((f) => f.kind === "image-broken")!.message).toContain("HTTP 404");
    expect(found.find((f) => f.kind === "stylesheet-failed")!.message).toContain("/html404/theme.css");
  });

  test("text leaks: [object Object], $NaN, {{ }}, Invalid Date, mojibake, double escaping, lorem ipsum", async ({ page }) => {
    await open(page, "/f/leaks.html");
    exact(await settle(page), await planted(page));
  });

  test("layout: stretched image, sideways scrolling, an undefined custom property (and the invisible text it causes)", async ({ page }) => {
    await open(page, "/f/layout.html");
    const found = await settle(page);
    exact(found, await planted(page));
    expect(found.find((f) => f.kind === "page-overflow-x")!.message).toContain("Suggested CSS: div.wide { max-width: 100%; }");
  });

  test("viewport-meta-missing on a phone", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, "/f/mobile.html");
    exact(await settle(page), await planted(page));
    await ctx.close();
  });

  test("viewport-meta-missing is not reported on a desktop", async ({ page }) => {
    await open(page, "/f/mobile.html");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
  });

  test("page-blank: the main region is stuck at opacity 0", async ({ page }) => {
    await open(page, "/f/blank.html");
    await until(page, "page-blank", 30_000);
    const found = await seen(page);
    exact(found, await planted(page));
    expect(found[0].message).toContain("opacity: 0 on main.app");
  });

  test("click-blocked: two clicks swallowed by an invisible layer", async ({ page }) => {
    await open(page, "/f/overlay.html");
    const box = (await page.locator("#buy").boundingBox())!;
    for (let i = 0; i < 2; i++) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
    }
    await until(page, "click-blocked");
    exact(await seen(page), await planted(page));
    expect(await page.title()).not.toBe("clicked");
  });

  test("pointer-events-leak: pointer-events: none left on body", async ({ page }) => {
    await open(page, "/f/pointer.html");
    await until(page, "pointer-events-leak");
    exact(await seen(page), await planted(page));
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("none"); // observe: unchanged
  });

  test("scroll-lock-stuck: overflow: hidden left on body, a scroll attempt with no effect", async ({ page }) => {
    await open(page, "/f/scroll.html");
    await page.mouse.move(400, 400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(500);
      if (await page.evaluate(() => (window as unknown as { GenClass: { runtime: { checks(): { kind: string }[] } } }).GenClass.runtime.checks().length)) break;
    }
    await until(page, "scroll-lock-stuck");
    exact(await seen(page), await planted(page));
  });

  test("control-unreachable: a button under a fixed bar", async ({ page }) => {
    await open(page, "/f/unreachable.html");
    await until(page, "control-unreachable");
    exact(await seen(page), await planted(page));
  });

  test("focus-obscured: an anchor target under a fixed header", async ({ page }) => {
    await open(page, "/f/anchor.html");
    await page.click("#jump");
    await until(page, "focus-obscured");
    const found = await seen(page);
    exact(found, await planted(page));
    expect(found[0].message).toContain("scroll-padding-top");
  });

  test("dialog-covered: a dialog trapped under a backdrop by its parent's transform", async ({ page }) => {
    await open(page, "/f/dialog.html");
    const found = await settle(page);
    exact(found, await planted(page));
    expect(found[0].message).toContain("Suggested CSS: div.wrap { transform: none; }");
  });

  test("csp-blocked: an inline style and an image blocked by the page's Content-Security-Policy", async ({ page }) => {
    await open(page, "/csp/csp.html");
    exact(await settle(page), await planted(page));
  });

  test("layout-shift: an image without reserved space pushes the content down (Chromium)", async ({ page }) => {
    await open(page, "/f/shift.html");
    exact(await settle(page), await planted(page));
  });

  test("text-invisible in dark mode only: the light page is clean", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const ctx = await browser.newContext({ colorScheme });
      const page = await ctx.newPage();
      await open(page, "/f/dark.html");
      const found = await settle(page, "data-dark-expect");
      if (colorScheme === "light") expect(found.map((f) => f.message)).toEqual([]);
      else {
        exact(found, await planted(page, "data-dark-expect"));
        expect(found[0].scheme).toBe("dark");
      }
      await ctx.close();
    }
  });

  test("text-invisible on hover: readable at rest, white on white while hovered", async ({ page }) => {
    await open(page, "/f/hover.html");
    await settle(page); // the rest measurement
    await page.hover(".nav-link");
    await until(page, "text-invisible");
    const found = await seen(page);
    exact(found, await planted(page));
    expect(found[0].state).toBe("hover");
    expect(found[0].message).toContain(":hover, ");
  });

  test("10,000 elements: no findings, slices stay short", async ({ page }) => {
    await open(page, "/f/big.html");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
    const v = await page.evaluate(() => (window as unknown as { GenClass: { runtime: { summary(): { visual: { maxSliceMs: number; ms: number; passes: number; partial: number; elements: number } } } } }).GenClass.runtime.summary().visual);
    console.log(`[visual-bench] big.html: passes ${v.passes}, total ${v.ms} ms, max slice ${v.maxSliceMs} ms, partial ${v.partial}, reads ${v.elements}`);
    expect(v.maxSliceMs).toBeLessThan(50); // never a long task of its own
  });
});

test.describe("runtime fixes (guard mode, visual: { on: true, fix: true })", () => {
  test("text-invisible: an owned rule fixes the colour, setMode('observe') removes it", async ({ page }) => {
    await open(page, "/f/fix.html");
    await settle(page);
    const before = await seen(page);
    expect(before.map((f) => `${f.id} ${f.kind}`)).toEqual(["t1 text-invisible"]);
    expect(before[0].fix?.applied).toBe(true);
    const color = () => page.evaluate(() => getComputedStyle(document.querySelector("[data-k=t1]")!).color);
    expect(await color()).not.toBe("rgb(255, 255, 255)");
    expect(await page.evaluate(() => document.querySelector("[data-k=t1]")!.getAttribute("data-genclass-fix"))).toMatch(/^f\d+$/);
    await page.waitForTimeout(300); // the 50 ms re-measure kept it
    expect(await color()).not.toBe("rgb(255, 255, 255)");
    await page.evaluate(() => (window as unknown as { GenClass: { runtime: { setMode(m: string): void } } }).GenClass.runtime.setMode("observe"));
    expect(await color()).toBe("rgb(255, 255, 255)");
    expect(await page.evaluate(() => document.querySelector("[data-k=t1]")!.hasAttribute("data-genclass-fix"))).toBe(false);
  });

  test("pointer-events-leak: the inline declaration is removed, and undo puts it back", async ({ page }) => {
    await open(page, "/f/pointer-fix.html");
    await until(page, "pointer-events-leak");
    const f = (await seen(page))[0];
    expect(f.fix?.applied).toBe(true);
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("");
    await page.click("#save"); // the page takes clicks again
    const undone = await page.evaluate(() => (window as unknown as { GenClass: { runtime: { checks(): { fix?: { undo(): boolean } }[] } } }).GenClass.runtime.checks()[0].fix!.undo());
    expect(undone).toBe(true);
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("none");
  });

  test("scroll-lock-stuck: the inline overflow is removed and the page scrolls", async ({ page }) => {
    await open(page, "/f/scroll-fix.html");
    await page.mouse.move(400, 400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(500);
      if (await page.evaluate(() => (window as unknown as { GenClass: { runtime: { checks(): { kind: string }[] } } }).GenClass.runtime.checks().length)) break;
    }
    await until(page, "scroll-lock-stuck");
    expect((await seen(page))[0].fix?.applied).toBe(true);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(() => window.scrollY > 0);
  });

  test("under a strict CSP (style-src 'self'): the owned rule applies with no violation", async ({ page }) => {
    await open(page, "/csp/csp-fix.html");
    await settle(page);
    const found = await seen(page);
    expect(found.map((f) => `${f.id} ${f.kind}`)).toEqual(["t1 text-invisible"]);
    expect(found[0].fix?.applied).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-k=t1]")!).color)).not.toBe("rgb(255, 255, 255)");
    const v = await page.evaluate(() => (window as unknown as { __violations: { directive: string }[] }).__violations);
    expect(v.filter((x) => x.directive.startsWith("style-src"))).toEqual([]);
  });
});
