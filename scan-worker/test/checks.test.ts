// The page-side checks: their pure helpers (colour parsing, contrast, template-leak matching) and the injected
// sources (valid JavaScript, self-contained, with the __name shim for esbuild's keep-names helper).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { installChecksSource, scanChecks } from "../src/checks.ts";
import { probeTargets, runtimeBootstrap, runtimeStateSource } from "../src/probe.ts";
import { SAFETY_BOOTSTRAP, safetyBootstrap } from "../src/scan.ts";

const H = scanChecks({ helpersOnly: true });

describe("colour helpers", () => {
  it("parses computed colours", () => {
    assert.deepEqual(H.parseColor("rgb(255, 0, 10)"), [255, 0, 10, 1]);
    assert.deepEqual(H.parseColor("rgba(0, 0, 0, 0.5)"), [0, 0, 0, 0.5]);
    assert.deepEqual(H.parseColor("rgb(0 0 0 / 25%)"), [0, 0, 0, 0.25]);
    assert.deepEqual(H.parseColor("color(srgb 1 0.5 0)"), [255, 127.5, 0, 1]);
    assert.deepEqual(H.parseColor("transparent"), [0, 0, 0, 0]);
    assert.equal(H.parseColor("oklch(0.7 0.1 200)"), null, "without a canvas (no DOM) other spaces are skipped, not guessed");
  });
  it("computes WCAG contrast", () => {
    assert.equal(Math.round(H.ratio([0, 0, 0], [255, 255, 255]) * 10) / 10, 21);
    assert.equal(Math.round(H.ratio([119, 119, 119], [255, 255, 255]) * 100) / 100, 4.48);
    assert.ok(H.ratio([250, 250, 250], [255, 255, 255]) < 1.5);
    assert.deepEqual(H.blend([0, 0, 0, 0.5], [255, 255, 255, 1]), [127.5, 127.5, 127.5, 1]);
  });
});

describe("template leaks", () => {
  it("finds undefined, NaN, [object Object] and {{...}} in short visible text", () => {
    for (const t of ["Total: NaN", "$NaN", "[object Object]", "Hello {{ user.name }}", "{{price | currency}}", "Hi undefined", "undefined items in your cart"]) assert.ok(H.leakIn(t), t);
  });
  it("leaves prose and look-alike words alone", () => {
    for (const t of ["Banana", "NaNa", "The behaviour of this function is undefined when the input array is empty, as the spec says.", "undefinedness", "{ not a template }", "a {single} brace"]) assert.equal(H.leakIn(t), null, t);
  });
});

describe("injected sources", () => {
  it("are valid JavaScript expressions that do not depend on outer variables", () => {
    for (const src of [installChecksSource("__gcsTest"), installChecksSource("__gcsTest", "window.__genclassScanChecks = function () {};"), runtimeStateSource("__gcsR"), SAFETY_BOOTSTRAP, `(${probeTargets.toString()})({ prepare: true })`, runtimeBootstrap({ mode: "observe", telemetry: false }, "window.GenClass = null;\n//# sourceMappingURL=x.map")]) {
      assert.doesNotThrow(() => new Function(`return ${src}`), src.slice(0, 80));
    }
  });
  it("the checks installer defines a __name shim", () => {
    assert.match(installChecksSource("__gcsTest"), /const __name = \(t\) => t;/);
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

// ------------------------------------------------------------------------------- page code against a fake page

/** A sandbox that stands in for a page's window: `window` is the global, as in a browser. */
function sandbox(setup = ""): vm.Context {
  const ctx = vm.createContext({ URL, DOMException: class extends Error {}, console });
  vm.runInContext(`var window = globalThis; window.top = window; ${setup}`, ctx);
  return ctx;
}

describe("the scanner's checks cannot be replaced by the page", () => {
  const BUILT_IN = /contrastSkipped/; // only the built-in checks' source has it
  it("ignores checks and fixes the page defined, under the chunk's names or any other", () => {
    const ctx = sandbox(`window.__genclassScanChecks = function fake() { return { findings: [] }; }; window.__genclassScanFixes = function fake() { return { applied: [{ kind: "low-contrast", selector: "p", how: "x" }] }; };`);
    assert.equal(vm.runInContext(installChecksSource("__gcsA"), ctx), false, "no fixes without a chunk");
    assert.match(String(vm.runInContext("String(window.__gcsA)", ctx)), BUILT_IN);
    assert.equal(vm.runInContext("typeof window.__gcsAFix", ctx), "undefined");
    // the installed name cannot be overwritten afterwards
    vm.runInContext("try { window.__gcsA = function fake() {}; } catch (e) {}", ctx);
    assert.match(String(vm.runInContext("String(window.__gcsA)", ctx)), BUILT_IN);
  });
  it("takes a visual chunk's functions only when the chunk itself defined them", () => {
    const chunk = "window.__genclassScanChecks = function chunkChecks() { return { findings: [] }; }; window.__genclassScanFixes = function chunkFixes() { return { applied: [] }; };";
    const fresh = sandbox();
    assert.equal(vm.runInContext(installChecksSource("__gcsB", chunk), fresh), true);
    assert.equal(vm.runInContext("window.__gcsB.name", fresh), "chunkChecks");
    assert.equal(vm.runInContext("window.__gcsBFix.name", fresh), "chunkFixes");
    // a page that pinned the chunk's names (a global var cannot be deleted) gets the built-in checks and no fixes
    const pinned = sandbox(`for (const k of ["__genclassScanChecks", "__genclassScanFixes"]) Object.defineProperty(window, k, { value: function fake() {}, writable: true, configurable: false });`);
    assert.equal(vm.runInContext(installChecksSource("__gcsC", chunk), pinned), false);
    assert.match(String(vm.runInContext("String(window.__gcsC)", pinned)), BUILT_IN);
    // and a page that put a getter there does not get its function called either
    const getter = sandbox(`Object.defineProperty(window, "__genclassScanChecks", { configurable: true, get() { return function fake() {}; }, set() {} });`);
    assert.equal(vm.runInContext(installChecksSource("__gcsD", chunk), getter), false);
    assert.match(String(vm.runInContext("String(window.__gcsD)", getter)), BUILT_IN);
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
      document: { querySelector: () => null },
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
});
