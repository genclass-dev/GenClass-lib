// scan-score/4 (strict): rule points with a log instance factor up to three times the base, diminishing
// (multiplicative) deductions inside a category, the weighted geometric mean over the categories a scan measured on the
// strict curve (squared on a 0 to 1 scale), the caps from critical and serious rules, and what each rule costs.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPS, capOf, CATEGORIES, CATEGORY_FLOOR, categoryValue, CURVE, curved, geometricMean, instanceFactor, INSTANCE_CAP, ruleImpact, rulePoints, rulesOf, score, SCORE_VERSION, SEVERITY_POINTS, type Category, type Scorable,
} from "../src/score.ts";

const ALL = Object.fromEntries(CATEGORIES.map((c) => [c.id, true])) as Record<Category, boolean>;
const f = (category: Category, rule: string, severity: Scorable["severity"], count = 1): Scorable => ({ category, rule, severity, count });
const W = CATEGORIES.reduce((s, c) => s + c.weight, 0);
const w = (id: Category) => CATEGORIES.find((c) => c.id === id)!.weight;
/** The score before caps with one category at `v` and every other at 100: the geometric mean on the strict curve. */
const oneAt = (id: Category, v: number) => 100 * Math.pow(Math.pow(v / 100, w(id) / W), CURVE);

describe("scan-score/4: rule points", () => {
  it("are the severity's base for one instance, grow with log10 of the instances, and stop at three times the base", () => {
    assert.equal(SCORE_VERSION, "scan-score/4");
    // the owner's decision after calibration: minor 12 (was 8), so three minor findings land a page at 85
    assert.deepEqual(SEVERITY_POINTS, { critical: 50, serious: 25, moderate: 15, minor: 12 });
    assert.ok(SEVERITY_POINTS.critical > SEVERITY_POINTS.serious && SEVERITY_POINTS.serious > SEVERITY_POINTS.moderate && SEVERITY_POINTS.moderate > SEVERITY_POINTS.minor);
    assert.equal(INSTANCE_CAP, 3);
    assert.equal(instanceFactor(1), 1);
    assert.equal(instanceFactor(10), 2);
    assert.equal(instanceFactor(100), 3);
    assert.equal(instanceFactor(5000), INSTANCE_CAP, "capped");
    assert.ok(Math.abs(instanceFactor(3) - (1 + Math.log10(3))) < 1e-9);
    assert.equal(instanceFactor(0), 1, "a count below 1 counts as one");
    assert.equal(rulePoints("serious", 1), SEVERITY_POINTS.serious);
    assert.equal(rulePoints("serious", 10), 2 * SEVERITY_POINTS.serious);
    for (const s of ["critical", "serious", "moderate", "minor"] as const) assert.equal(rulePoints(s, 1_000_000), 3 * SEVERITY_POINTS[s], s);
  });
  it("are stricter than scan-score/3 at every severity and count (base 30/15/7/3, at most twice)", () => {
    const old = { critical: 30, serious: 15, moderate: 7, minor: 3 } as const;
    for (const s of ["critical", "serious", "moderate", "minor"] as const)
      for (const n of [1, 3, 10, 50, 1000]) assert.ok(rulePoints(s, n) > old[s] * Math.min(2, 1 + Math.log10(n)), `${s} x${n}`);
  });
  it("group a category's findings by rule: instances add up, the most severe instance sets the severity", () => {
    const rules = rulesOf([f("visual", "image-broken", "moderate"), f("visual", "image-broken", "serious"), f("visual", "image-broken", "moderate", 3), f("visual", "font-failed", "minor")]);
    assert.deepEqual(rules.map((r) => [r.rule, r.severity, r.instances, r.findings]), [["image-broken", "serious", 5, 3], ["font-failed", "minor", 1, 1]]);
    assert.equal(rules[0].points, rulePoints("serious", 5));
  });
});

describe("scan-score/4: what a few minor findings cost", () => {
  it("takes a page with one minor finding to 95, and one with three (two elements of one, two categories) to 85", () => {
    assert.equal(score([f("accessibility", "axe:region", "minor")], ALL).value, 95);
    assert.equal(score([f("accessibility", "axe:empty-heading", "minor"), f("accessibility", "axe:region", "minor", 2), f("speed", "font-display", "minor")], ALL).value, 85);
  });
});

describe("scan-score/4: diminishing deductions inside a category", () => {
  it("multiplies (1 - points / 100) over the rules, so each further rule takes less and the category stays at or above 0", () => {
    const s = SEVERITY_POINTS.serious;
    const one = categoryValue(rulesOf([f("visual", "a", "serious")]));
    const two = categoryValue(rulesOf([f("visual", "a", "serious"), f("visual", "b", "serious")]));
    const three = categoryValue(rulesOf([f("visual", "a", "serious"), f("visual", "b", "serious"), f("visual", "c", "serious")]));
    assert.ok(Math.abs(one - (100 - s)) < 1e-9);
    assert.ok(Math.abs(two - 100 * (1 - s / 100) ** 2) < 1e-9);
    assert.ok(100 - one > one - two && one - two > two - three, "each further rule takes fewer points");
    const many = rulesOf(Array.from({ length: 40 }, (_, i) => f("accessibility", `r${i}`, "critical", 100)));
    assert.ok(categoryValue(many) >= 0);
  });
  it("lets one rule with 1,000 instances take three times its base, as 100 do", () => {
    const s1000 = score([f("accessibility", "axe:color-contrast", "serious", 1000)], ALL);
    const s100 = score([f("accessibility", "axe:color-contrast", "serious", 100)], ALL);
    assert.equal(s1000.categories.find((c) => c.id === "accessibility")!.rules[0].points, 3 * SEVERITY_POINTS.serious);
    assert.equal(s1000.value, s100.value);
  });
});

describe("scan-score/4: the weighted geometric mean of the measured categories", () => {
  it("has eight categories, weights adding up to 100", () => {
    assert.deepEqual(CATEGORIES.map((c) => c.id), ["visual", "accessibility", "phone", "reliability", "speed", "security", "seo", "races"]);
    assert.equal(W, 100);
    assert.equal(score([], ALL).value, 100);
    assert.equal(score([], ALL).cap, null);
  });
  it("is the geometric mean squared: one weak category pulls the score down more than a mean would", () => {
    const s = score([f("accessibility", "axe:a", "moderate"), f("accessibility", "axe:b", "moderate")], ALL);
    const a11y = 100 * (1 - SEVERITY_POINTS.moderate / 100) ** 2;
    assert.equal(s.value, Math.round(oneAt("accessibility", a11y)));
    assert.equal(s.mean, Math.round(oneAt("accessibility", a11y) * 100) / 100);
    const arithmetic = (w("accessibility") * a11y + (W - w("accessibility")) * 100) / W;
    assert.ok(oneAt("accessibility", a11y) < arithmetic);
    assert.equal(CURVE, 2);
    assert.deepEqual([curved(90), curved(70), curved(50), curved(100)].map((x) => Math.round(x * 100) / 100), [81, 49, 25, 100], "the strict curve");
    assert.ok(Math.abs(geometricMean([{ weight: 1, value: 25 }, { weight: 3, value: 100 }])! - 100 * Math.pow(0.25, 0.25)) < 1e-9);
    assert.equal(geometricMean([]), null);
  });
  it("counts a category at 0 as the floor, so one empty category does not make the whole score 0", () => {
    const g = geometricMean([{ weight: 20, value: 0 }, { weight: 80, value: 100 }])!;
    assert.ok(Math.abs(g - 100 * Math.pow(CATEGORY_FLOOR / 100, 0.2)) < 1e-9);
    assert.ok(g > 0);
  });
  it("leaves out the categories the scan did not measure, and gives no score when none was", () => {
    const only = score([f("visual", "text-invisible", "serious")], { visual: true });
    assert.equal(only.value, Math.round(curved(100 - SEVERITY_POINTS.serious)), "the measured categories only");
    const a11y = only.categories.find((c) => c.id === "accessibility")!;
    assert.deepEqual([a11y.measured, a11y.value, a11y.raw, a11y.count], [false, null, null, 0]);
    assert.equal(score([f("accessibility", "axe:region", "minor")], { visual: true }).categories.find((c) => c.id === "accessibility")!.value, null, "findings in an unmeasured category do not make it measured");
    assert.equal(score([], {}).value, null);
    assert.equal(score([], {}).mean, null);
  });
  it("is the same for the same findings in any order", () => {
    const fs = [f("visual", "a", "moderate"), f("phone", "tap-target-small", "serious", 12), f("visual", "b", "minor"), f("speed", "lcp-slow", "minor"), f("security", "hsts-missing", "moderate")];
    assert.deepEqual(score(fs, ALL), score([...fs].reverse(), ALL));
  });
});

describe("scan-score/4: caps from critical and serious findings", () => {
  const capAt = (sev: "critical" | "serious", rules: number) => CAPS.filter((c) => (c.severity === sev || (sev === "critical" && c.severity === "serious")) && rules >= c.rules).reduce((m, c) => Math.min(m, c.cap), 100);
  it("caps the score at 59 with one critical rule, 35 with two, and 69 with three serious or critical rules", () => {
    assert.deepEqual(CAPS.map((c) => [c.severity, c.rules, c.cap]).sort(), [["critical", 1, 59], ["critical", 2, 35], ["serious", 3, 69]].sort());
    const one = score([f("races", "duplicate-submit", "critical")], ALL);
    assert.equal(one.value, 59);
    assert.deepEqual([one.cap?.at, one.cap?.severity, one.cap?.by], [59, "critical", ["races|duplicate-submit"]]);
    assert.ok(one.mean! > 59, "the score before the cap is kept beside it");
    assert.equal(score([f("visual", "a", "critical"), f("accessibility", "axe:b", "critical")], ALL).value, 35);
    const serious = score([f("visual", "a", "serious"), f("phone", "b", "serious"), f("speed", "c", "serious")], ALL);
    assert.equal(serious.value, Math.min(69, Math.round(serious.mean!)));
    assert.equal(serious.cap?.at, 69);
    assert.deepEqual(serious.cap?.by, ["phone|b", "speed|c", "visual|a"]);
    assert.equal(capAt("critical", 1), 59);
  });
  it("counts critical rules toward the serious cap, and never caps below the mean (the cap is null then)", () => {
    assert.equal(capOf([{ key: "a", severity: "critical" }, { key: "b", severity: "serious" }, { key: "c", severity: "serious" }])?.at, 59, "the lowest cap that applies");
    assert.equal(capOf([{ key: "a", severity: "moderate" }, { key: "b", severity: "minor" }]), null);
    const deep = Array.from({ length: 12 }, (_, i) => f("accessibility", `axe:r${i}`, "critical", 50));
    const s = score(deep, ALL);
    assert.ok(s.mean! < 35 || s.cap !== null);
    if (s.mean! < 35) assert.equal(s.cap, null, "a cap above the mean is not reported");
  });
  it("leaves findings that are not scored, or in unmeasured categories, out of the caps", () => {
    assert.equal(score([f("accessibility", "axe:image-alt", "critical")], { visual: true }).cap, null);
  });
});

describe("scan-score/4: what each rule costs", () => {
  it("is the score before caps without the rule minus the score before caps with it, most first", () => {
    const fs = [f("accessibility", "axe:image-alt", "critical", 2), f("races", "duplicate-submit", "serious"), f("visual", "font-failed", "minor")];
    const impact = ruleImpact(fs, ALL);
    // a minor visual rule (weight 20) costs more than a serious race (weight 5)
    assert.deepEqual(impact.map((i) => i.rule), ["axe:image-alt", "font-failed", "duplicate-submit"]);
    const a11y = 100 * (1 - rulePoints("critical", 2) / 100);
    const withAll = score(fs, ALL).mean!;
    const without = score(fs.slice(1), ALL).mean!;
    assert.ok(Math.abs(impact[0].points - (without - withAll)) < 0.02);
    assert.ok(impact[0].points > 0 && a11y < 100);
    assert.ok(impact.every((i) => i.points > 0), "under the cap every rule still shows what it costs");
  });
});
