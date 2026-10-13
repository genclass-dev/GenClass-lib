// The page-side checks: their pure helpers (colour parsing, contrast, template-leak matching) and the injected
// sources (valid JavaScript, self-contained, with the __name shim for esbuild's keep-names helper).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installChecksSource, scanChecks } from "../src/checks.ts";
import { probeTargets, runtimeBootstrap, RUNTIME_STATE_SOURCE } from "../src/probe.ts";
import { SAFETY_BOOTSTRAP } from "../src/scan.ts";

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
    for (const src of [installChecksSource(), RUNTIME_STATE_SOURCE, SAFETY_BOOTSTRAP, `(${probeTargets.toString()})({ prepare: true })`, runtimeBootstrap({ mode: "observe", telemetry: false }, "window.GenClass = null;\n//# sourceMappingURL=x.map")]) {
      assert.doesNotThrow(() => new Function(`return ${src}`), src.slice(0, 80));
    }
  });
  it("the checks installer defines a __name shim and never overwrites a visual chunk", () => {
    const src = installChecksSource();
    assert.match(src, /const __name = \(t\) => t;/);
    assert.match(src, /typeof window\.__genclassScanChecks !== "function"/);
  });
  it("the runtime bootstrap runs in the top frame only, sets the config and drops the source map line", () => {
    const src = runtimeBootstrap({ mode: "guard", telemetry: false, model: { baseUrl: "https://genclass.dev/model/x/" } }, "/*rt*/\n//# sourceMappingURL=genclass.global.min.js.map");
    assert.match(src, /window\.top !== window/);
    assert.match(src, /"mode":"guard"/);
    assert.match(src, /"telemetry":false/);
    assert.doesNotMatch(src, /sourceMappingURL/);
  });
  it("the safety bootstrap turns off service workers and can hold WebSocket messages", () => {
    assert.match(SAFETY_BOOTSTRAP, /serviceWorker\.register = function/);
    assert.match(SAFETY_BOOTSTRAP, /__gcScanHold/);
  });
});
