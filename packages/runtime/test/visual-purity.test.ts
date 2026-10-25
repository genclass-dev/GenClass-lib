// The measured visual checks are separate from the network-boundary model (AGENTS.md rule 2 exception, docs/runtime/
// VISUAL.md sections 1 and 13): src/visual/ imports nothing but types from situation/, decide/, model/, state/, trace/
// or runtime.ts; those never import src/visual/; runtime.ts imports only a type from the stub; and a session with the
// checks on (a chunk that reports findings and fix audit entries through the real bridge) produces exactly the same
// event history, decisions and situation text as the same session with them off.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stateText } from "../src/situation/serialize.js";
import type { CheckFinding, CreateOptions } from "../src/types.js";
import { hostFor } from "../src/visual/bridge.js";
import type { VisualChunk } from "../src/visual/host.js";
import { visualRegistry } from "../src/visual/registry.js";
import { setup } from "./helpers.js";

const SRC = join(__dirname, "..", "src");

function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every static import and dynamic import() of a file: [specifier, type-only]. */
function imports(file: string): [string, boolean][] {
  const src = readFileSync(file, "utf8");
  const out: [string, boolean][] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+"([^"]+)"/gm)) out.push([m[3], !!m[2]]);
  for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push([m[1], false]);
  for (const m of src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) out.push([m[1], false]);
  return out;
}

const rel = (f: string) => relative(SRC, f).split("\\").join("/");

describe("visual checks stay out of the model's path (AGENTS.md rule 2 exception, VISUAL.md 13)", () => {
  it("src/visual imports only types from the runtime; the chunk imports only src/visual", () => {
    const FIRST_LOAD: Record<string, string[]> = {
      "visual/start.ts": ["../devhost.js", "../observe/dom-user.js", "../telemetry/config.js", "../util.js", "./registry.js", "./index.js"],
      "visual/entry.ts": ["../clock.js", "./index.js"],
      "visual/registry.ts": [],
    };
    const VISUAL = join(SRC, "visual");
    for (const f of files(VISUAL)) {
      const r = rel(f);
      for (const [spec, typeOnly] of imports(f)) {
        if (typeOnly) continue;
        if (FIRST_LOAD[r]) expect(FIRST_LOAD[r], `${r} imports ${spec}`).toContain(spec);
        else {
          // the chunk (dist/visual/index.js) is one file: every value import stays inside src/visual
          const target = resolve(dirname(f), spec);
          expect(spec.startsWith("."), `${r} imports ${spec}`).toBe(true);
          expect(target.startsWith(VISUAL + sep), `${r} imports ${spec}`).toBe(true);
        }
      }
    }
  });

  it("situation/, decide/, model/, state/ and trace/ never import src/visual; runtime.ts imports only a type", () => {
    for (const dir of ["situation", "decide", "model", "state", "trace", "learn", "observe"])
      for (const f of files(join(SRC, dir))) for (const [spec] of imports(f)) expect(spec, rel(f)).not.toMatch(/visual\//);
    for (const [spec, typeOnly] of imports(join(SRC, "runtime.ts"))) if (/visual\//.test(spec)) expect(typeOnly, spec).toBe(true);
  });

  it("the checks never push events, facts or situations: the bridge has no access to them", () => {
    const bridge = readFileSync(join(SRC, "visual", "bridge.ts"), "utf8").replace(/\/\/.*$/gm, "");
    for (const forbidden of ["events.push", ".trigger(", ".build(", "situation(", "queue.", "hub.", "decider", "breakerImpl"]) expect(bridge, forbidden).not.toContain(forbidden);
    for (const f of files(join(SRC, "visual")))
      if (!/bridge\.ts$|start\.ts$/.test(f)) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/\bRuntimeImpl\b/);
  });
});

describe("a session is byte-identical with visual checks on and off (VISUAL.md 14)", () => {
  afterEach(() => {
    delete visualRegistry.loader;
  });

  const finding = (): CheckFinding => ({
    id: "c1",
    source: "check",
    kind: "text-invisible",
    severity: "high",
    at: 0,
    target: "page",
    selector: "p.a",
    element: () => null,
    measured: { ratio: 1 },
    threshold: { value: 1.5, unit: ":1", source: "test" },
    context: { scheme: "light", viewport: { w: 1, h: 1 }, coarse: false, tier: "full" },
    message: "[GenClass] Check (measured): test.",
    details: [],
  });

  async function session(visual: boolean): Promise<{ history: string[]; decisions: string[]; situation: string; calls: number; checks: number; audits: string[] }> {
    if (visual)
      visualRegistry.loader = () =>
        Promise.resolve({
          startVisual: (rt: unknown, _o: unknown, _e: unknown, d: (el: Element) => string, n: (p: string) => string) => {
            const host = hostFor(rt, d, n);
            host.report(finding(), true);
            host.note("[GenClass] Applied a CSS fix for check c1.", finding(), true);
            host.audit({ what: "apply", checkId: "c1", kind: "text-invisible", css: "p.a { color: #737373 }" });
            return { now: () => Promise.resolve([]), summary: () => null, gateFixes: () => undefined, stop: () => undefined };
          },
        } as unknown as VisualChunk);
    const doc = { readyState: "complete", title: "Shop", visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined };
    const s = setup({
      visual,
      extraGlobal: { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined },
    } as Partial<CreateOptions>);
    s.server.on("GET", "/api/items", { body: { items: [1, 2] }, latency: 80 });
    s.server.on("POST", "/api/cart", { body: { ok: true }, latency: 120 });
    const cart = s.rt.atom("cart", { items: [] as number[] });
    for (let i = 0; i < 3; i++) {
      void s.fetch("/api/items").then((r) => r.json()).then(() => cart.set({ items: [i] }));
      await s.clock.advance(700);
      void s.fetch("/api/cart", { method: "POST", body: JSON.stringify({ i }) });
      await s.clock.advance(500);
    }
    await s.clock.advance(3000);
    const out = {
      history: s.rt.history().map((e) => `${e.seq} ${e.t} ${e.kind} ${e.name}`),
      decisions: s.rt.decisions().map((d) => `${d.id} ${d.trigger} ${d.diagnosis} ${d.ran}`),
      situation: stateText(s.rt.situation("ask").state),
      calls: s.decider.calls.length,
      checks: s.rt.checks().length,
      audits: s.rt.audit().map((a) => a.kind),
    };
    s.rt.destroy();
    return out;
  }

  it("history, decisions, situation text and model calls do not change", async () => {
    const off = await session(false);
    const on = await session(true);
    expect(on.checks).toBe(1); // the chunk did run and report
    expect(off.checks).toBe(0);
    expect(on.history).toEqual(off.history);
    expect(on.decisions).toEqual(off.decisions);
    expect(on.situation).toBe(off.situation);
    expect(on.calls).toBe(off.calls);
    expect(on.audits.filter((k) => k !== "fix")).toEqual(off.audits);
  });
});
