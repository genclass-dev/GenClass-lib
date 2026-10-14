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

  test("10,000 elements with hover, clicks and scrolling: no long task once the checks run", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __lt: { s: number; d: number }[] };
      w.__lt = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lt.push({ s: e.startTime, d: e.duration });
      }).observe({ type: "longtask", buffered: true });
    });
    await open(page, "/f/big.html");
    await settle(page);
    const t0 = await page.evaluate(() => performance.now());
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(80 + i * 7, 120 + i * 40);
      await page.waitForTimeout(150);
    }
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(100, 200 + i * 60);
      await page.waitForTimeout(300);
    }
    for (let i = 0; i < 25; i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(3000); // the end-of-page check and two periodic reads
    await settle(page);
    const long = await page.evaluate((t0) => (window as unknown as { __lt: { s: number; d: number }[] }).__lt.filter((e) => e.s >= t0), t0);
    const v = await page.evaluate(() => (window as unknown as { GenClass: { runtime: { summary(): { visual: { maxSliceMs: number; ms: number } } } } }).GenClass.runtime.summary().visual);
    console.log(`[visual-bench] big.html with interaction: total ${v.ms} ms, max slice ${v.maxSliceMs} ms, long tasks ${JSON.stringify(long)}`);
    expect(long).toEqual([]);
    expect(v.maxSliceMs).toBeLessThan(50);
  });

  test("5,000 stylesheet rules with var(): the walk runs in short slices, no long task", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __lt: { s: number; d: number }[]; __t0: number };
      w.__lt = [];
      w.__t0 = Infinity;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lt.push({ s: e.startTime, d: e.duration });
      }).observe({ type: "longtask", buffered: true });
      // the page's own work (building and applying the stylesheet) is done well before the checks start
      addEventListener("load", () => setTimeout(() => (w.__t0 = performance.now()), 1000));
    });
    await open(page, "/f/big-css.html");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
    const r = await page.evaluate(() => {
      const w = window as unknown as { __lt: { s: number; d: number }[]; __t0: number; GenClass: { runtime: { summary(): { visual: { maxSliceMs: number; ms: number } } } } };
      return { long: w.__lt.filter((e) => e.s >= w.__t0), v: w.GenClass.runtime.summary().visual };
    });
    console.log(`[visual-bench] big-css.html: total ${r.v.ms} ms, max slice ${r.v.maxSliceMs} ms, long tasks ${JSON.stringify(r.long)}`);
    expect(r.long).toEqual([]);
    expect(r.v.maxSliceMs).toBeLessThan(25);
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
    expect(await page.evaluate(() => document.querySelector("[data-k=t1]")!.getAttribute("data-genclass-fix"))).toMatch(/^f[0-9a-z]+-\d+$/);
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

  test("scroll-lock-stuck: a lock a closed dialog left behind is removed and the page scrolls", async ({ page }) => {
    await open(page, "/f/scroll-fix.html");
    await page.click("#open");
    await page.waitForTimeout(600);
    await page.click("#close");
    expect(await page.evaluate(() => [document.body.style.overflow, document.querySelector("[role=dialog]")])).toEqual(["hidden", null]);
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

  test("scroll-lock-stuck: a lock held since the page loaded, with no dialog ever open, is reported but not removed", async ({ page }) => {
    await open(page, "/f/scroll-load-fix.html");
    await page.mouse.move(400, 400);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(500);
      if (await page.evaluate(() => (window as unknown as { GenClass: { runtime: { checks(): { kind: string }[] } } }).GenClass.runtime.checks().length)) break;
    }
    await until(page, "scroll-lock-stuck");
    const found = await seen(page);
    exact(found, await planted(page));
    expect(found[0].fix).toBeUndefined();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  });

  test("text-invisible: a fix computed for one background is undone when the background changes", async ({ page }) => {
    await open(page, "/f/fix-state.html");
    await settle(page);
    const before = await seen(page);
    expect(before.map((f) => `${f.id} ${f.kind}`)).toEqual(["l1 text-invisible"]);
    expect(before[0].fix?.applied).toBe(true);
    const color = () => page.evaluate(() => getComputedStyle(document.querySelector("[data-k=l1]")!).color);
    expect(await color()).not.toBe("rgb(255, 255, 255)");
    // another item becomes active: the first one's label is on its dark background again, where white is right
    await page.click("#second");
    await page.waitForFunction(() => getComputedStyle(document.querySelector("[data-k=l1]")!).color === "rgb(255, 255, 255)", null, { timeout: 10_000 });
    expect(await page.evaluate(() => document.querySelector("[data-k=l1]")!.hasAttribute("data-genclass-fix"))).toBe(false);
  });

  test("a busy shield (pointer-events: none on body while a request runs) is neither reported nor removed", async ({ page }) => {
    await open(page, "/f/clean-busy.html");
    await page.click("#save");
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("none");
    await page.waitForTimeout(4500); // two periodic reads during the request
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("none"); // not removed by a fix
    await page.waitForFunction(() => document.body.style.pointerEvents === "", null, { timeout: 10_000 });
    await page.waitForTimeout(2500);
    expect((await seen(page)).map((f) => f.message)).toEqual([]);
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

// False reports a review found by reading the checks (VISUAL.md section 19, "Review of 2026-10-13"): correct pages
// that looked broken. Each fixture is a correct page; some carry one planted fault next to the pattern, so the check
// is shown to be running.
test.describe("review regressions (VISUAL.md 19): correct pages that looked broken", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const name of ["clean-scheme-meta.html", "clean-scheme-dark.html"]) {
      test(`${name} in ${colorScheme} mode: the canvas follows the page's colour scheme, zero findings`, async ({ browser }) => {
        const ctx = await browser.newContext({ colorScheme });
        const page = await ctx.newPage();
        await open(page, `/f/${name}`);
        expect((await settle(page)).map((f) => f.message)).toEqual([]);
        await ctx.close();
      });
    }
  }

  test("white text over pointer-events: none layers (overlay, canvas, video): only the planted white-on-white card", async ({ page }) => {
    await open(page, "/f/clean-layers.html");
    exact(await settle(page), await planted(page));
    // the pattern is real: hit testing skips the layer under the headline
    const skipped = await page.evaluate(() => {
      const h = document.querySelector("h2")!.getBoundingClientRect();
      return !document.elementsFromPoint(h.left + 10, h.top + h.height / 2).some((e) => e.classList.contains("overlay"));
    });
    expect(skipped).toBe(true);
  });

  test("the same page in guard mode with fixes on: only the planted text is recoloured", async ({ page }) => {
    await open(page, "/f/clean-layers.html?fix");
    const found = await settle(page);
    exact(found, await planted(page));
    expect(found[0].fix?.applied).toBe(true);
    const white = "rgb(255, 255, 255)";
    const nearWhite = "rgb(249, 250, 251)";
    expect(await page.evaluate(() => [...document.querySelectorAll(".hero h2, .hero p")].map((e) => getComputedStyle(e).color))).toEqual([white, nearWhite, white, nearWhite, white, nearWhite]);
    expect(await page.evaluate(() => document.querySelectorAll("[data-genclass-fix]").length)).toBe(1);
  });

  test("a full-screen particles canvas (fixed, z-index -1, pointer-events: none) behind white text: zero findings", async ({ page }) => {
    await open(page, "/f/clean-particles.html");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
  });

  test("a dialog that scrolls inside, over a fixed backdrop: controls scrolled away are not covered", async ({ page }) => {
    await open(page, "/f/clean-dialog-scroll.html");
    // the pattern is real: the hit test at a scrolled-away control's centre lands on the backdrop
    const hit = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".paper button")].at(-1)!.getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.className;
    });
    expect(hit).toBe("backdrop");
    expect((await settle(page)).map((f) => f.message)).toEqual([]);
  });

  test("a web-component app (its UI in a shadow root): no page-blank", async ({ page }) => {
    await open(page, "/f/clean-web-component.html");
    await page.waitForTimeout(8000); // settle + 3 s and 2 s more: the page-blank window has passed
    expect((await seen(page)).map((f) => f.message)).toEqual([]);
  });

  test("a full-page section scroller: wheels at the ends and during transitions are not a stuck scroll lock", async ({ page }) => {
    await open(page, "/f/clean-fullpage.html");
    await page.mouse.move(640, 400);
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, -400); // up, on the first section
      await page.waitForTimeout(400);
    }
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 400); // down to the last section, and on past it
      await page.waitForTimeout(i < 3 ? 950 : 400);
    }
    expect(await page.evaluate(() => [scrollY, document.getElementById("fp")!.style.transform])).toEqual([0, "translateY(-300vh)"]);
    await page.waitForTimeout(4500); // two periodic reads
    expect((await seen(page)).map((f) => f.message)).toEqual([]);
  });
});

// False reports the bench found on real pages (bench/visual, docs/runtime/VISUAL.md section 19), reproduced with the
// same visitor actions the bench uses (keyboard focus, then scrolling to the end): nothing but the planted fault.
test.describe("bench regressions (VISUAL.md 19): patterns that were false reports on public sites", () => {
  for (const name of ["regress-css-var.html", "regress-focus-overlay.html", "regress-shift-scroll.html", "regress-shadow-banner.html", "regress-menu-lock.html"]) {
    test(`${name}: only the planted faults, after keyboard focus and scrolling`, async ({ page }) => {
      await open(page, `/f/${name}`);
      let underLayer = 0;
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        await page.waitForTimeout(300);
        underLayer += await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || a === document.body) return 0;
          const r = a.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.classList.contains("survey-layer") ? 1 : 0;
        });
      }
      await page.waitForTimeout(800);
      await page.mouse.move(640, 300);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(300);
      }
      await page.waitForTimeout(1500);
      exact(await settle(page), await planted(page));
      // the pattern really happened (so the exclusion, not its absence, kept the page clean)
      if (name === "regress-focus-overlay.html") expect(underLayer).toBeGreaterThan(0);
      if (name === "regress-menu-lock.html") {
        // the menu stayed open and its lock held while the wheel tried to scroll
        expect(await page.evaluate(() => [document.body.style.overflow, document.getElementById("platform")!.getAttribute("aria-expanded"), scrollY])).toEqual(["hidden", "true", 0]);
      }
      if (name === "regress-shadow-banner.html") {
        // at the end of the page both footer links sit under a banner host
        const hits = await page.evaluate(() =>
          ["terms", "language"].map((id) => {
            const r = document.getElementById(id)!.getBoundingClientRect();
            return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id ?? "";
          }),
        );
        expect(hits).toEqual(["consent-a", "consent-b"]);
      }
      if (name === "regress-shift-scroll.html") {
        // layout-shift entries are only observable, not in the timeline buffer: read the buffered ones
        const worst = await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              const all: { t: number; v: number }[] = [];
              const po = new PerformanceObserver((l) => {
                for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) all.push({ t: e.startTime, v: e.value });
              });
              po.observe({ type: "layout-shift", buffered: true });
              setTimeout(() => {
                po.disconnect();
                let best = 0;
                let cur = 0;
                let start = -Infinity;
                let last = -Infinity;
                for (const e of all.sort((a, b) => a.t - b.t)) {
                  if (e.t - last > 1000 || e.t - start > 5000) {
                    cur = 0;
                    start = e.t;
                  }
                  cur += e.v;
                  last = e.t;
                  best = Math.max(best, cur);
                }
                resolve(best);
              }, 300);
            }),
        );
        expect(worst).toBeGreaterThan(0.25);
      }
    });
  }
});
