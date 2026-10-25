// @vitest-environment happy-dom
// Interaction analytics (InitOptions.analytics, docs/runtime/ANALYTICS.md, TELEMETRY.md "Interaction analytics"): off by
// default, only with telemetry and a token, every opt-out; page views, engaged time, scroll milestones, clicks, rage and
// dead clicks per element key; keys from markup only; nothing reaches the event log or the situation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import type { RuntimeImpl } from "../src/runtime.js";
import { DATA_LIKE, type TelemetryClient } from "../src/telemetry/client.js";
import { fromPairs, readMetaConfig } from "../src/cdn/config.js";
import { ANALYTICS_NOTICE, IDLE_MS, KEY_MAX, keyOf, loadNav, PATH_MAX, popNav, type KeyContext } from "../src/analytics/index.js";
import { normalizePath } from "../src/util.js";
import type { TelemetryTransport } from "../src/types.js";
import { FakeClock, ScriptedDecider } from "./helpers.js";

const TOKEN = "gc_abcdefghijklmnopqrstuv";
const OFF = { fetch: false, xhr: false, user: false, errors: false, nav: false, storage: false, perf: false, websocket: false, timers: false };

type Ev = Record<string, unknown>;
function recorder(): TelemetryTransport & { sent: { body: { token?: string; events: Ev[] } }[] } {
  const sent: { body: { token?: string; events: Ev[] } }[] = [];
  return {
    sent,
    send(_url, body) {
      sent.push({ body: JSON.parse(body) });
      return Promise.resolve();
    },
  };
}
const ix = (t: ReturnType<typeof recorder>) => t.sent.flatMap((s) => s.body.events).filter((e) => e.t === "interactions");

/** A trusted event (a real user's), unless `trusted` is false. */
function fire(target: EventTarget, type: string, init: MouseEventInit = {}, trusted = true) {
  const ev = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, ...init });
  Object.defineProperty(ev, "isTrusted", { value: trusted });
  target.dispatchEvent(ev);
}
function key(target: EventTarget, k: string) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, composed: true, key: k });
  Object.defineProperty(ev, "isTrusted", { value: true });
  target.dispatchEvent(ev);
}
function setVisibility(v: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { value: v, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function geometry(height: number, viewport: number, y: number) {
  Object.defineProperty(document.documentElement, "scrollHeight", { value: height, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: viewport, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}
/** Let happy-dom deliver mutation records. */
const settle = () => new Promise((r) => setTimeout(r, 5));
const $ = (id: string) => document.getElementById(id)!;

let rt: RuntimeImpl | null = null;

// telemetry draws its session id from crypto.getRandomValues on the runtime's global
const w = window as unknown as { crypto?: { getRandomValues?: unknown } };
if (typeof w.crypto?.getRandomValues !== "function") Object.defineProperty(window, "crypto", { value: globalThis.crypto, configurable: true });

async function arun(o: { analytics?: boolean; token?: string | null; telemetry?: Record<string, unknown> | false; nav?: boolean; user?: boolean } = {}) {
  const clock = new FakeClock();
  const transport = recorder();
  rt = createRuntime({
    clock,
    global: window,
    decider: new ScriptedDecider(),
    report: "silent",
    observe: { ...OFF, nav: !!o.nav, user: !!o.user },
    telemetry: o.telemetry === false ? false : { transport, ...(o.telemetry ?? {}) },
    ...(o.token === null ? {} : { token: o.token ?? TOKEN }),
    ...(o.analytics === undefined ? { analytics: true } : { analytics: o.analytics }),
  }) as RuntimeImpl;
  const client = rt.telemetry as unknown as TelemetryClient;
  if (rt.analytics?.enabled) await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
  return { clock, transport, rt, client };
}

afterEach(() => {
  rt?.destroy();
  rt = null;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  for (const [o, p] of [
    [document, "visibilityState"],
    [document.documentElement, "scrollHeight"],
    [window, "innerHeight"],
    [window, "scrollY"],
    [window.navigator, "globalPrivacyControl"],
  ] as const)
    delete (o as unknown as Record<string, unknown>)[p];
  window.localStorage.removeItem("genclass.telemetry");
  vi.restoreAllMocks();
});

describe("interaction analytics: off by default, telemetry and token required, every opt-out (ANALYTICS.md section 4, 5)", () => {
  it("off unless the app turns it on: no listener, no event", async () => {
    document.body.innerHTML = `<button id="b">B</button>`;
    const { transport, rt: r } = await arun({ analytics: false });
    expect(r.analytics).toMatchObject({ enabled: false, reason: "option" });
    fire($("b"), "click");
    setVisibility("hidden");
    expect(ix(transport)).toHaveLength(0);
  });

  it("the init option unset is off too", async () => {
    const clock = new FakeClock();
    const transport = recorder();
    rt = createRuntime({ clock, global: window, decider: new ScriptedDecider(), report: "silent", observe: OFF, telemetry: { transport }, token: TOKEN }) as RuntimeImpl;
    expect(rt.analytics).toMatchObject({ enabled: false, reason: "option" });
    expect((rt.telemetry as unknown as TelemetryClient).pre).toBeUndefined();
  });

  it("needs telemetry: off with telemetry: false", async () => {
    const { rt: r } = await arun({ telemetry: false });
    expect(r.analytics).toMatchObject({ enabled: false, reason: "telemetry-off" });
    expect(r.analytics!.start()).toBe(false);
  });

  it("needs the app's token with the default endpoint (one warning); a custom endpoint needs none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rt: r } = await arun({ token: null });
    expect(r.analytics).toMatchObject({ enabled: false, reason: "no-token" });
    expect(warn.mock.calls.flat().join(" ")).toContain("analytics: true needs the app's token");
    r.destroy();
    const own = await arun({ token: null, telemetry: { endpoint: "https://collector.example/v1/events" } });
    expect(own.rt.analytics).toMatchObject({ enabled: true });
  });

  it("every telemetry opt-out turns it off: Global Privacy Control, ?genclass=no-telemetry, localStorage", async () => {
    Object.defineProperty(window.navigator, "globalPrivacyControl", { value: true, configurable: true });
    let a = await arun();
    expect(a.rt.telemetry).toMatchObject({ enabled: false, reason: "gpc" });
    expect(a.rt.analytics).toMatchObject({ enabled: false, reason: "telemetry-off" });
    a.rt.destroy();
    delete (window.navigator as unknown as Record<string, unknown>).globalPrivacyControl;

    window.history.replaceState({}, "", "/?genclass=no-telemetry");
    a = await arun();
    expect(a.rt.analytics).toMatchObject({ enabled: false, reason: "telemetry-off" });
    a.rt.destroy();
    window.history.replaceState({}, "", "/");

    window.localStorage.setItem("genclass.telemetry", "off");
    a = await arun();
    expect(a.rt.analytics).toMatchObject({ enabled: false, reason: "telemetry-off" });
  });

  it("the page config: analytics=on / off (meta tag, data attribute)", () => {
    expect(fromPairs({ analytics: "on" }).analytics).toBe(true);
    expect(fromPairs({ analytics: "" }).analytics).toBe(true);
    expect(fromPairs({ analytics: "off" }).analytics).toBe(false);
    const doc = { querySelectorAll: () => [{ getAttribute: () => `analytics=on, token=${TOKEN}` }] };
    expect(readMetaConfig(doc)).toMatchObject({ analytics: true, token: TOKEN });
  });

  it("one console notice when they start, never page text in it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await arun();
    expect(ANALYTICS_NOTICE).toContain("never page text");
    // shown once per page: by this test or an earlier one in the file
    expect(info.mock.calls.flat().filter((m) => m === ANALYTICS_NOTICE).length).toBeLessThanOrEqual(1);
  });
});

describe("interaction analytics: what a page view records (ANALYTICS.md section 1)", () => {
  it("a page view: start, engaged time, scroll milestones, clicks per element key, sent with the token; no text", async () => {
    document.body.innerHTML = `<main><button data-genclass-name="buy">Buy now for Alice</button><div class="hero-image">Picture</div></main>`;
    const { clock, transport } = await arun();
    geometry(4000, 1000, 0);
    await clock.advance(2000);
    fire(document.querySelector("button")!, "click");
    await clock.advance(1500);
    fire(document.querySelector("button")!, "click");
    fire(document.querySelector(".hero-image")!, "click");
    await clock.advance(1500);
    geometry(4000, 1000, 1100); // bottom at 2100 of 4000: 52 %
    fire(window, "scroll");
    await clock.advance(4000);
    setVisibility("hidden");
    const evs = ix(transport);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      t: "interactions",
      view: 1,
      route: "/",
      start: true,
      engagedMs: 9000,
      scroll: [25, 50],
      clicks: { '[data-genclass-name="buy"]': 2, "div.hero-image": 1 },
    });
    expect(evs[0].end).toBeUndefined();
    expect(transport.sent.every((s) => s.body.token === TOKEN)).toBe(true);
    const text = JSON.stringify(transport.sent);
    for (const s of ["Alice", "Buy now", "Picture"]) expect(text).not.toContain(s);
  });

  it("engaged time: at most IDLE_MS after the last input, nothing while hidden; deltas per event", async () => {
    const { clock, transport } = await arun();
    await clock.advance(120_000); // the page open, untouched
    setVisibility("hidden");
    await clock.advance(60_000);
    setVisibility("visible");
    await clock.advance(10_000);
    key(document.body, "a");
    await clock.advance(5_000);
    setVisibility("hidden");
    const evs = ix(transport);
    expect(evs.map((e) => e.engagedMs)).toEqual([IDLE_MS, 15_000]);
    expect(evs.map((e) => e.start)).toEqual([true, undefined]);
    expect(evs.map((e) => e.view)).toEqual([1, 1]);
  });

  it("scroll: each milestone once per view; a page that fits the screen reaches 100 %", async () => {
    const { clock, transport } = await arun();
    geometry(800, 1000, 0);
    setVisibility("hidden");
    setVisibility("visible");
    geometry(800, 1000, 0);
    fire(window, "scroll");
    await clock.advance(1000);
    setVisibility("hidden");
    const evs = ix(transport);
    expect(evs[0].scroll).toEqual([25, 50, 75, 100]);
    expect(evs[1]?.scroll).toBeUndefined();
  });

  it("rage clicks: 3 on one element within 1 s, once per burst; not across elements", async () => {
    document.body.innerHTML = `<div class="hero-image"></div><div class="caption"></div>`;
    const { clock, transport } = await arun();
    const img = document.querySelector(".hero-image")!;
    for (const gap of [0, 300, 300, 200, 100]) {
      await clock.advance(gap);
      fire(img, "click");
    }
    await clock.advance(1500);
    for (let i = 0; i < 3; i++) {
      await clock.advance(200);
      fire(img, "click");
    }
    await clock.advance(1500);
    fire(document.querySelector(".caption")!, "click");
    fire(img, "click");
    fire(document.querySelector(".caption")!, "click");
    setVisibility("hidden");
    const [e] = ix(transport);
    expect(e.rage).toEqual({ "div.hero-image": 2 });
    expect(e.clicks).toEqual({ "div.hero-image": 9, "div.caption": 2 });
  });

  it("dead clicks: a link or button after which nothing changed within 1 s; not after a change, a new tab or a modified click", async () => {
    document.body.innerHTML = `<button id="copy">Copy</button><button id="open">Open</button><a id="ext" href="https://example.org/" target="_blank">Ext</a>
      <button id="dev">Dev</button><div data-genclass-ignore id="overlay"></div><div class="tile">Tile</div>`;
    document.addEventListener("click", (e) => e.preventDefault());
    $("open").addEventListener("click", () => document.body.appendChild(document.createElement("p")));
    $("dev").addEventListener("click", () => $("overlay").appendChild(document.createElement("span")));
    const { clock, transport } = await arun();
    const step = async (id: string, init: MouseEventInit = {}) => {
      fire($(id), "click", init);
      await settle();
      await clock.advance(1100);
    };
    await step("copy");
    await step("open");
    await step("ext");
    await step("copy", { ctrlKey: true });
    await step("dev"); // a change inside [data-genclass-ignore] (the devtools overlay) is not a change in the page
    fire(document.querySelector(".tile")!, "click"); // not a link or button
    await clock.advance(1100);
    setVisibility("hidden");
    const [e] = ix(transport);
    expect(e.dead).toEqual({ "button#copy": 1, "button#dev": 1 });
  });

  it("untrusted events and events inside [data-genclass-ignore] do not count", async () => {
    document.body.innerHTML = `<button id="b">B</button><div data-genclass-ignore><button id="tool">T</button></div>`;
    const { transport } = await arun();
    fire($("b"), "click", {}, false);
    fire($("tool"), "click");
    fire($("b"), "click");
    setVisibility("hidden");
    expect(ix(transport)[0].clicks).toEqual({ "button#b": 1 });
  });

  it("route changes: the view ends and the next starts (nav events, or the next input without the nav observer)", async () => {
    document.body.innerHTML = `<button id="b">B</button>`;
    for (const nav of [true, false]) {
      const { clock, transport, rt: r } = await arun({ nav });
      fire($("b"), "click");
      await clock.advance(1000);
      window.history.pushState({}, "", "/orders/123456");
      await clock.advance(1000);
      fire($("b"), "click");
      setVisibility("hidden");
      const evs = ix(transport);
      expect(evs.map((e) => [e.view, e.route, e.start, e.end, e.clicks]), `nav ${nav}`).toEqual([
        [1, "/", true, true, { "button#b": 1 }],
        [2, "/orders/:id", true, undefined, { "button#b": 1 }],
      ]);
      r.destroy();
      setVisibility("visible");
      window.history.replaceState({}, "", "/");
    }
  });

  it("destroy sends the open view's last event (end) and removes the listeners", async () => {
    document.body.innerHTML = `<button id="b">B</button>`;
    const { transport, rt: r } = await arun();
    fire($("b"), "click");
    r.destroy();
    rt = null;
    const evs = ix(transport);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ start: true, end: true, clicks: { "button#b": 1 } });
    fire($("b"), "click");
    expect(ix(transport)).toHaveLength(1);
  });

  it("stop() drops the counts not sent; start() records again (consent)", async () => {
    document.body.innerHTML = `<button id="b">B</button>`;
    const { transport, rt: r, client } = await arun({ analytics: false });
    expect(r.analytics!.start()).toBe(true);
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    fire($("b"), "click");
    r.analytics!.stop();
    expect(r.analytics).toMatchObject({ enabled: false, reason: "stopped" });
    expect(client.pre).toBeUndefined();
    fire($("b"), "click");
    setVisibility("hidden");
    expect(ix(transport)).toHaveLength(0);
    setVisibility("visible");
    expect(r.analytics!.start()).toBe(true);
    await vi.waitFor(() => expect(client.pre).toBeTypeOf("function"));
    fire($("b"), "click");
    setVisibility("hidden");
    expect(ix(transport)).toEqual([expect.objectContaining({ view: 1, start: true, clicks: { "button#b": 1 } })]);
  });
});

describe("interaction analytics: navigation paths (ANALYTICS.md section 11)", () => {
  /** A history traversal as the browser reports it: the URL is already the new one when popstate fires. */
  function traverse(path: string, index?: number) {
    window.history.replaceState({}, "", path);
    if (index !== undefined) (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index = index;
    window.dispatchEvent(new Event("popstate"));
  }
  const pagehide = () => window.dispatchEvent(new Event("pagehide"));
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).navigation;
  });

  it("how each view was reached, the previous route with the time between, and at pagehide the exit and the path", async () => {
    document.body.innerHTML = `<button id="b">B</button>`;
    Object.defineProperty(window, "navigation", { value: { currentEntry: { index: 0 } }, configurable: true, writable: true });
    for (const nav of [true, false]) {
      (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index = 0;
      const { clock, transport, rt: r } = await arun({ nav });
      await clock.advance(1500);
      window.history.pushState({}, "", "/pricing");
      (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index = 1;
      if (!nav) fire($("b"), "click"); // without the nav observer the route change is seen at the next input
      await clock.advance(2500);
      traverse("/", 0);
      if (!nav) fire($("b"), "click");
      await clock.advance(500);
      pagehide();
      const evs = ix(transport);
      const starts = evs.filter((e) => e.start).map((e) => [e.route, e.nav, e.from, e.fromMs]);
      expect(starts, `nav ${nav}`).toEqual([
        ["/", "load", undefined, undefined],
        ["/pricing", "push", "/", 1500],
        ["/", "back", "/pricing", 2500],
      ]);
      const last = evs[evs.length - 1];
      expect(last, `nav ${nav}`).toMatchObject({ route: "/", exit: true, end: true, path: ["/", "/pricing", "/"] });
      expect(evs.filter((e) => e.exit)).toHaveLength(1);
      r.destroy();
      window.history.replaceState({}, "", "/");
    }
  });

  it("forward, and a traversal whose direction the browser does not expose", async () => {
    expect(popNav(2, 1)).toBe("back");
    expect(popNav(1, 2)).toBe("forward");
    expect(popNav(undefined, 2)).toBe("pop");
    expect(popNav(2, 2)).toBe("pop");
    const { clock, transport } = await arun({ nav: true });
    window.history.pushState({}, "", "/a");
    await clock.advance(100);
    traverse("/"); // no Navigation API in this environment
    await clock.advance(100);
    setVisibility("hidden");
    expect(ix(transport).filter((e) => e.start).map((e) => e.nav)).toEqual(["load", "push", "pop"]);
  });

  it("the page load's own type: reload and back_forward from Navigation Timing; load otherwise", () => {
    const g = (type?: string) => ({ performance: { getEntriesByType: () => (type ? [{ type }] : []) } });
    expect(loadNav(g("reload"))).toBe("reload");
    expect(loadNav(g("back_forward"))).toBe("back_forward");
    expect(loadNav(g("navigate"))).toBe("load");
    expect(loadNav(g("prerender"))).toBe("load");
    expect(loadNav(g())).toBe("load");
    expect(loadNav({})).toBe("load");
  });

  it("the first interaction per view: a click, or a focus on a form field after a key press; once per view, never text", async () => {
    document.body.innerHTML = `<input id="email" type="email" value="alice@example.com"><a id="docs" href="/docs">Read the docs</a>`;
    const { clock, transport } = await arun({ nav: true });
    $("email").focus(); // the page moving focus is not the visitor's interaction
    await clock.advance(1200);
    key(document.body, "Tab");
    $("email").blur();
    const ev = new FocusEvent("focusin", { bubbles: true, composed: true });
    Object.defineProperty(ev, "isTrusted", { value: true });
    $("email").dispatchEvent(ev);
    await clock.advance(800);
    fire($("docs"), "click");
    window.history.pushState({}, "", "/docs");
    await clock.advance(3000);
    fire(document.body, "click");
    setVisibility("hidden");
    const evs = ix(transport);
    const firsts = evs.filter((e) => e.first).map((e) => [e.route, e.first, e.firstMs]);
    expect(firsts).toEqual([
      ["/", "input#email", 1200],
      ["/docs", "body", 3000],
    ]);
    const text = JSON.stringify(transport.sent);
    for (const t of ["alice", "Read the docs"]) expect(text).not.toContain(t);
  });

  it("a restore from the back/forward cache starts a new path, reached by back_forward", async () => {
    const { clock, transport } = await arun({ nav: true });
    window.history.pushState({}, "", "/a");
    await clock.advance(100);
    pagehide();
    const show = new Event("pageshow");
    Object.defineProperty(show, "persisted", { value: true });
    window.dispatchEvent(show);
    setVisibility("hidden");
    setVisibility("visible");
    await clock.advance(100);
    setVisibility("hidden");
    const evs = ix(transport);
    expect(evs.filter((e) => e.exit).map((e) => e.path)).toEqual([["/", "/a"]]);
    expect(evs.filter((e) => e.start).map((e) => [e.route, e.nav, e.from])).toEqual([
      ["/", "load", undefined],
      ["/a", "push", "/"],
      ["/a", "back_forward", undefined],
    ]);
  });

  it(`a path holds at most PATH_MAX (${PATH_MAX}) routes, then "(more)"`, async () => {
    const { clock, transport } = await arun({ nav: true });
    for (let i = 1; i <= PATH_MAX + 3; i++) {
      window.history.pushState({}, "", `/p${i}`);
      await clock.advance(10);
    }
    pagehide();
    const exit = ix(transport).find((e) => e.exit)!;
    expect((exit.path as string[]).length).toBe(PATH_MAX + 1);
    expect((exit.path as string[]).at(-1)).toBe("(more)");
  });
});

describe("interaction analytics: element keys from markup only (ANALYTICS.md section 1)", () => {
  const k: KeyContext = { route: (p) => normalizePath(p), loc: { href: "https://shop.example/pricing", origin: "https://shop.example" }, url: URL, data: DATA_LIKE };
  const keyFor = (html: string, sel = "#t") => {
    document.body.innerHTML = html;
    return keyOf(document.querySelector(sel), k);
  };

  it("in order: data-genclass-name, data-testid, a stable id, a link's target, stable classes", () => {
    expect(keyFor(`<button id="t" data-genclass-name="pricing-cta" data-testid="x" class="btn">Start</button>`)).toBe('[data-genclass-name="pricing-cta"]');
    expect(keyFor(`<button id="t" data-testid="checkout">Pay</button>`)).toBe('[data-testid="checkout"]');
    expect(keyFor(`<button id="t">Sign up</button>`)).toBe("button#t");
    expect(keyFor(`<a href="/users/12345?tab=orders#top" class="x">Alice</a>`, "a")).toBe('a[href="/users/:id#top"]');
    expect(keyFor(`<a href="https://github.com/genclass-dev/x">GitHub</a>`, "a")).toBe('a[href^="https://github.com"]');
    expect(keyFor(`<a href="mailto:alice@example.com">Mail</a>`, "a")).toBe('a[href^="mailto:"]');
    expect(keyFor(`<a href="javascript:void(0)" class="nav-link">Menu</a>`, "a")).toBe("a.nav-link");
    expect(keyFor(`<button class="btn-primary css-1x2y3z px-4 Button_primary__a1B2c large">Go</button>`, "button")).toBe("button.btn-primary.large");
  });

  it("generated or data-like ids and names are skipped; then a structural path under a named ancestor or landmark", () => {
    expect(keyFor(`<nav><ul><li><a>One</a></li><li><a id=":r1:">Two</a></li></ul></nav>`, "li:nth-of-type(2) a")).toBe("nav > ul > li:nth-of-type(2) > a");
    expect(keyFor(`<section id="pricing"><div><div><span id="order-123456">x</span></div></div></section>`, "span")).toBe("section#pricing > div > div > span");
    expect(keyFor(`<div><button data-genclass-name="alice@example.com" id="t">x</button></div>`)).toBe("button#t");
    expect(keyFor(`<footer><p><button>Alice Smith</button></p></footer>`, "button")).toBe("footer > p > button");
    expect(keyFor(`<footer><p><button>Alice Smith</button></p></footer>`, "button")).not.toContain("Alice");
  });

  it("at most KEY_MAX characters; the page itself", () => {
    expect(keyFor(`<button data-genclass-name="${"a".repeat(200)}">x</button>`, "button").length).toBeLessThanOrEqual(KEY_MAX);
    expect(keyOf(document.body, k)).toBe("body");
    expect(keyOf(null, k)).toBe("(page)");
  });
});

describe("interaction analytics: never model input (AGENTS.md rules 1 to 3)", () => {
  it("the event log and the situation are identical with analytics on and off", async () => {
    document.body.innerHTML = `<form><input id="q"><button id="go">Go</button></form>`;
    $("go").addEventListener("click", (e) => e.preventDefault());
    const run = async (analytics: boolean) => {
      const { clock, rt: r } = await arun({ analytics, user: true });
      fire($("go"), "click");
      await clock.advance(300);
      key($("q"), "Enter");
      await clock.advance(2000);
      const out = JSON.stringify({ history: r.history(), situation: r.situation() });
      r.destroy();
      rt = null;
      setVisibility("visible");
      return out;
    };
    const off = await run(false);
    const on = await run(true);
    expect(on).toBe(off);
    expect(off).not.toContain("interactions");
  });
});
