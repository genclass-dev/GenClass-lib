// The page-side code: the injected sources (valid JavaScript, self-contained), the installer of the GenClass visual
// checks (taken only from the built chunk, never from the page), the runtime state reader, the probe's target finder
// and the safety bootstrap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";
import { VISUAL_KINDS } from "../src/catalog.ts";
import { probeTargets, runtimeBootstrap, runtimeStateSource } from "../src/probe.ts";
import { SAFETY_BOOTSTRAP, safetyBootstrap } from "../src/scan.ts";
import { callSource, installSource } from "../src/visual.ts";
import { VISUAL_BUILD, VISUAL_SOURCE } from "../src/visual-source.ts";

const CHUNK = "window.__genclassScanVisual = function chunkVisual(cmd) { return { ok: true, cmd: cmd }; };";

describe("injected sources", () => {
  it("are valid JavaScript expressions that do not depend on outer variables", () => {
    for (const src of [installSource("__gcsTest", CHUNK), callSource("__gcsTest", "collect", { id: "a", pass: true }), runtimeStateSource("__gcsR"), SAFETY_BOOTSTRAP, `(${probeTargets.toString()})({ prepare: true })`, runtimeBootstrap({ mode: "observe", telemetry: false }, "window.GenClass = null;\n//# sourceMappingURL=x.map")]) {
      assert.doesNotThrow(() => new Function(`return ${src}`), src.slice(0, 80));
    }
  });
  it("the runtime bootstrap runs in the top frame only, sets the config and drops the source map line", () => {
    const src = runtimeBootstrap({ mode: "guard", telemetry: false, model: { baseUrl: "https://genclass.dev/model/x/" } }, "/*rt*/\n//# sourceMappingURL=genclass.global.min.js.map");
    assert.match(src, /window\.top !== window/);
    assert.match(src, /"mode":"guard"/);
    assert.match(src, /"telemetry":false/);
    assert.doesNotMatch(src, /sourceMappingURL/);
  });
  it("the safety bootstrap turns off service workers and new windows, and can hold WebSocket messages", () => {
    assert.match(SAFETY_BOOTSTRAP, /serviceWorker\.register = function/);
    assert.match(SAFETY_BOOTSTRAP, /window\.open = function \(\) \{ return null; \}/);
    assert.match(SAFETY_BOOTSTRAP, /if \(held\) return;/);
  });
});

describe("the embedded visual checks", () => {
  it("are the chunk CI builds from the pinned wave2/visual commit, with the scanner's entry", () => {
    assert.ok(VISUAL_SOURCE && VISUAL_SOURCE.length > 50_000, "src/visual-source.ts holds a built chunk");
    assert.match(VISUAL_SOURCE!, /__genclassScanVisual/);
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.match(ci, new RegExp(`VISUAL_REF: ${VISUAL_BUILD.commit}`), "ci.yml's VISUAL_REF is the commit the embedded copy was built from");
  });
  it("name every kind the scanner's catalog knows, and no other", () => {
    for (const k of VISUAL_KINDS) assert.ok(VISUAL_SOURCE!.includes(`"${k}"`), k);
    assert.equal(VISUAL_KINDS.length, 23);
  });
  it("see the page's requests in flight through the net command, not a stand-in 0", () => {
    assert.match(VISUAL_SOURCE!, /inFlight:\{get size\(\)\{return \w+\}\}/, "the runtime stand-in reads the count the scanner hands in");
    assert.doesNotMatch(VISUAL_SOURCE!, /inFlight:\{size:0\}/);
    const ctx = sandbox();
    assert.equal(vm.runInContext(installSource("__gcsN", VISUAL_SOURCE!), ctx), true);
    assert.equal(vm.runInContext(`JSON.stringify(window.__gcsN("net", { n: 2 }))`, ctx), JSON.stringify({ ok: true }));
  });
  it("install from the built bundle, and answer under the per-scan name only", () => {
    const ctx = sandbox();
    assert.equal(vm.runInContext(installSource("__gcsV", VISUAL_SOURCE!), ctx), true);
    assert.equal(vm.runInContext("typeof window.__genclassScanVisual", ctx), "undefined", "the well-known name is removed");
    assert.equal(vm.runInContext("typeof window.__gcsV", ctx), "function");
    assert.deepEqual(vm.runInContext(`JSON.stringify(window.__gcsV("status", { id: "a" }))`, ctx), JSON.stringify({ ok: false }));
    assert.deepEqual(JSON.parse(String(vm.runInContext(`JSON.stringify(window.__gcsV("start", { id: "BAD id" }))`, ctx))).ok, false);
  });
});

// ------------------------------------------------------------------------------- page code against a fake page

/** A sandbox that stands in for a page's window: `window` is the global, as in a browser. */
function sandbox(setup = ""): vm.Context {
  const ctx = vm.createContext({ URL, DOMException: class extends Error {}, console });
  vm.runInContext(`var window = globalThis; window.top = window; ${setup}`, ctx);
  return ctx;
}

describe("the scanner's checks cannot be replaced by the page", () => {
  it("takes the visual checks only when the chunk itself defined them, and pins them under the per-scan name", async () => {
    const fresh = sandbox();
    assert.equal(vm.runInContext(installSource("__gcsB", CHUNK), fresh), true);
    assert.equal(vm.runInContext("window.__gcsB.name", fresh), "chunkVisual");
    vm.runInContext("try { window.__gcsB = function fake() {}; } catch (e) {}", fresh);
    assert.equal(vm.runInContext("window.__gcsB.name", fresh), "chunkVisual", "the installed name cannot be overwritten");
    assert.equal(JSON.parse(String(await vm.runInContext(callSource("__gcsB", "collect", { id: "a" }), fresh))).cmd, "collect");
    // a page that defined the chunk's name itself gets nothing installed: its function is never called
    const planted = sandbox(`window.__genclassScanVisual = function fake() { return { ok: true, findings: [] }; };`);
    assert.equal(vm.runInContext(installSource("__gcsA", ""), planted), false);
    assert.equal(vm.runInContext("typeof window.__gcsA", planted), "undefined");
    assert.equal(await vm.runInContext(callSource("__gcsA", "collect"), planted), "{}");
    // a page that pinned the name (a global var cannot be deleted) gets nothing either
    const pinned = sandbox(`Object.defineProperty(window, "__genclassScanVisual", { value: function fake() {}, writable: true, configurable: false });`);
    assert.equal(vm.runInContext(installSource("__gcsC", CHUNK), pinned), false);
    // and a page that put a getter there does not get its function called
    const getter = sandbox(`Object.defineProperty(window, "__genclassScanVisual", { configurable: true, get() { return function fake() {}; }, set() {} });`);
    assert.equal(vm.runInContext(installSource("__gcsD", CHUNK), getter), false);
  });
  it("keeps what GenClass reported in the bootstrap's closure, not where the page can rewrite it", () => {
    const rt = `window.GenClass = { runtime: { mode: "observe", status: { state: "ready" }, holdBudgetMs: function () { return 900; }, decisions: function () { return [1, 2]; },
      on: function (ev, fn) { (this.h = this.h || {})[ev] = fn; } } };`;
    const ctx = sandbox("var document = { visibilityState: 'visible' };");
    vm.runInContext(runtimeBootstrap({ mode: "observe" }, rt, "__gcsR"), ctx);
    vm.runInContext(`window.GenClass.runtime.h.detect({ id: "d1", trigger: "request", subject: "POST /a (#1)", diagnosis: "duplicate", diagnosisConfidence: 0.99, action: "coalesce", ran: "observe" });`, ctx);
    // the page tries to fake an action, rewrite the state reader and break JSON.stringify
    vm.runInContext(`window.__gcScan = { acts: [{ action: "coalesce", ok: true }] }; try { window.__gcsR = function () { return "{}"; }; } catch (e) {} JSON.stringify = function () { return '{"acts":[{"ok":true}]}'; };`, ctx);
    const state = JSON.parse(String(vm.runInContext(runtimeStateSource("__gcsR"), ctx)));
    assert.equal(state.present, true);
    assert.equal(state.decisions, 2);
    assert.equal(state.detections.length, 1);
    assert.deepEqual(state.acts, [], "no action the runtime did not report");
  });
});

/** A minimal DOM for probeTargets: forms with submit buttons, all visible. */
function formPage(forms: { attrs: Record<string, string>; button?: Record<string, string>; inLink?: boolean }[], base?: string) {
  const node = (tag: string, attrs: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    tagName: tag, nodeType: 1, parentElement: null, disabled: false, id: attrs.id || "", innerText: attrs.label || "",
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null), hasAttribute: (k: string) => k in attrs, setAttribute: (k: string, v: string) => void (attrs[k] = v),
    getBoundingClientRect: () => ({ left: 10, top: 10, width: 120, height: 40 }), scrollIntoView: () => undefined, ...extra,
  });
  const origin = "https://shop.example.com";
  const docForms = forms.map((f, i) => {
    const b = node("BUTTON", { type: "submit", label: `Send ${i}`, ...(f.button || {}) }, {
      formAction: f.button?.formaction ? new URL(f.button.formaction, origin).href : new URL(f.attrs.action || "/", origin).href,
      closest: (sel: string) => (f.inLink && sel === "a[href]" ? { tagName: "A" } : null),
    });
    return node("FORM", { id: `f${i}`, ...f.attrs }, { action: new URL(f.attrs.action || "/", origin).href, elements: [b], querySelector: () => null, noValidate: false });
  });
  return {
    document: { forms: docForms, querySelectorAll: () => [], querySelector: (sel: string) => (sel === "base[target]" && base ? node("BASE", { target: base }) : null) },
    getComputedStyle: () => ({ visibility: "visible", display: "block", pointerEvents: "auto", opacity: "1" }),
    location: { href: `${origin}/`, origin },
  };
}

function withPage<T>(page: Record<string, unknown>, fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(page).map((k) => [k, g[k]]));
  Object.assign(g, page);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete g[k];
      else g[k] = v;
  }
}

describe("probeTargets never picks a submit that opens another window", () => {
  it("skips target=_blank forms, formtarget=_blank buttons, <base target>, buttons in links and third-party formaction", () => {
    const picked = (forms: Parameters<typeof formPage>[0], base?: string) => withPage(formPage(forms, base), () => probeTargets({}).button);
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe" } }])?.label, "Send 0", "a plain same-origin POST form is used");
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe", target: "_self" } }])?.label, "Send 0");
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe", target: "_blank" } }]), null);
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe", target: "results" } }]), null, "a named target can open a new window");
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe" }, button: { formtarget: "_blank" } }]), null);
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe" } }], "_blank"), null, "<base target=_blank> applies to forms");
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe" }, inLink: true }]), null);
    assert.equal(picked([{ attrs: { method: "post", action: "/subscribe" }, button: { formaction: "https://forms.example.net/x" } }]), null);
    // with a new-window form first, the next safe form is still found
    assert.equal(picked([{ attrs: { method: "post", action: "/a", target: "_blank" } }, { attrs: { method: "post", action: "/b" } }])?.label, "Send 1");
  });
});

describe("the safety bootstrap", () => {
  const run = () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const opened: string[] = [];
    class FakeWS {
      static OPEN = 1;
      url: string;
      constructor(url: string) {
        this.url = url;
        opened.push(url);
      }
      send() {}
    }
    const ctx = sandbox();
    Object.assign(ctx, {
      WebSocket: FakeWS, location: { href: "https://shop.example.com/" }, navigator: {},
      HTMLFormElement: class { submit() {} },
      addEventListener: (ev: string, fn: (e: unknown) => void) => void (listeners[ev] = [...(listeners[ev] || []), fn]),
      document: { querySelector: () => null, addEventListener: (ev: string, fn: (e: unknown) => void) => void (listeners[`doc:${ev}`] = [...(listeners[`doc:${ev}`] || []), fn]) },
      open: () => ({ fake: "window" }),
    });
    vm.runInContext(safetyBootstrap("__gcsS"), ctx);
    return { ctx, listeners, opened };
  };
  it("returns null from window.open", () => {
    const { ctx } = run();
    assert.equal(vm.runInContext("window.open('https://elsewhere.example.net/', '_blank')", ctx), null);
  });
  it("points a submit into another window at the page itself", () => {
    const { listeners } = run();
    const attrs: Record<string, string> = { target: "_blank" };
    const form = { getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => void (attrs[k] = v) };
    const sAttrs: Record<string, string> = { formtarget: "_blank" };
    const submitter = { hasAttribute: (k: string) => k in sAttrs, getAttribute: (k: string) => sAttrs[k] ?? null, setAttribute: (k: string, v: string) => void (sAttrs[k] = v) };
    for (const fn of listeners.submit) fn({ target: form, submitter });
    assert.equal(attrs.target, "_self");
    assert.equal(sAttrs.formtarget, "_self");
  });
  it("refuses WebSockets to IP addresses and local names, keeps the other hosts for a DNS check, and holds messages", () => {
    const { ctx, opened } = run();
    for (const u of ["ws://127.0.0.1:9000/", "ws://10.0.0.5/", "wss://[::1]/", "ws://printer.local/", "ws://dev.internal/"]) {
      assert.throws(() => vm.runInContext(`new WebSocket(${JSON.stringify(u)})`, ctx), u);
    }
    vm.runInContext(`window.ws = new WebSocket("wss://live.example.net/socket")`, ctx);
    assert.deepEqual(opened, ["wss://live.example.net/socket"]);
    assert.deepEqual(JSON.parse(String(vm.runInContext(`window.__gcsS("read")`, ctx))).wsHosts, ["live.example.net"]);
    vm.runInContext(`window.__gcsS("hold", true)`, ctx);
    assert.equal(JSON.parse(String(vm.runInContext(`window.__gcsS("read")`, ctx))).held, true);
  });
  it("records the browser's Content-Security-Policy violations as plain data for the visual checks, and not the page's own", () => {
    const { ctx, listeners } = run();
    // a page can dispatch a fake securitypolicyviolation event (isTrusted false) to plant text in a public report
    for (const fn of listeners["doc:securitypolicyviolation"]) fn({ isTrusted: false, disposition: "enforce", effectiveDirective: "img-src", violatedDirective: "img-src", blockedURI: "https://planted.example/ad text", sourceFile: "" });
    for (const fn of listeners["doc:securitypolicyviolation"]) fn({ isTrusted: true, disposition: "enforce", effectiveDirective: "img-src", violatedDirective: "img-src", blockedURI: "https://cdn.example.net/a.png", sourceFile: "" });
    assert.deepEqual(JSON.parse(String(vm.runInContext(`window.__gcsS("read")`, ctx))).csp, [{ disposition: "enforce", effectiveDirective: "img-src", violatedDirective: "img-src", blockedURI: "https://cdn.example.net/a.png", sourceFile: "" }]);
  });
});
