import { describe, expect, it } from "vitest";
import addon from "../src/index.js";

describe("the add-on definition", () => {
  it("is @genclass/sv with the mode and telemetry options, observe and off by default", () => {
    expect(addon.id).toBe("@genclass/sv");
    expect(addon.options.mode.type).toBe("select");
    expect(addon.options.mode.default).toBe("observe");
    expect((addon.options.mode as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(["observe", "guard"]);
    expect(addon.options.telemetry.type).toBe("boolean");
    expect(addon.options.telemetry.default).toBe(false);
  });

  it("refuses projects that are not SvelteKit", async () => {
    const reasons: string[] = [];
    const ws = { isKit: false, unsupported: (r: string) => reasons.push(r) };
    await addon.setup?.(ws as unknown as Parameters<NonNullable<typeof addon.setup>>[0]);
    expect(reasons).toEqual(["Requires SvelteKit"]);
    reasons.length = 0;
    await addon.setup?.({ ...ws, isKit: true } as unknown as Parameters<NonNullable<typeof addon.setup>>[0]);
    expect(reasons).toEqual([]);
  });

  it("says in its next steps what the model download costs, whether diagnostics are sent, and how to undo it", () => {
    const steps = (telemetry: boolean, mode: "observe" | "guard") =>
      addon.nextSteps?.({ options: { mode, telemetry }, packageManager: "pnpm", directory: { src: "src" } } as unknown as Parameters<NonNullable<typeof addon.nextSteps>>[0]).join("\n") ?? "";
    const off = steps(false, "observe");
    expect(off).toContain("pnpm run dev");
    expect(off).toContain("13 MB");
    expect(off).toContain("Anonymous diagnostics are off");
    expect(off).toContain("telemetry=off");
    expect(off).toContain("never holds, drops or changes a request");
    expect(off).toContain("npx @genclass/runtime@beta remove");
    const on = steps(true, "guard");
    expect(on).toContain("Anonymous diagnostics are on for your deployed site (never from localhost)");
    expect(on).toContain("Mode guard");
  });
});
