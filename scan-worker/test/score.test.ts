// scan-score/3: rule points with a bounded instance factor, diminishing (multiplicative) deductions inside a category,
// the weighted mean over the categories a scan measured, and what each rule costs the overall score.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORIES, categoryValue, instanceFactor, INSTANCE_CAP, ruleImpact, rulePoints, rulesOf, score, SCORE_VERSION, SEVERITY_POINTS, type Category, type Scorable } from "../src/score.ts";

const ALL: Record<Category, boolean> = { visual: true, accessibility: true, phone: true, reliability: true, speed: true, races: true };
const f = (category: Category, rule: string, severity: Scorable["severity"], count = 1): Scorable => ({ category, rule, severity, count });

describe("scan-score/3: rule points", () => {
  it("are the severity's base for one instance, grow with log10 of the instances, and stop at twice the base", () => {
    assert.equal(SCORE_VERSION, "scan-score/3");
    assert.deepEqual(SEVERITY_POINTS, { critical: 30, serious: 15, moderate: 7, minor: 3 });
    assert.equal(instanceFactor(1), 1);
    assert.equal(instanceFactor(10), 2);
    assert.ok(Math.abs(instanceFactor(3) - (1 + Math.log10(3))) < 1e-9);
    assert.equal(instanceFactor(200), INSTANCE_CAP, "200 instances are capped");
    assert.equal(instanceFactor(0), 1, "a count below 1 counts as one");
    assert.equal(rulePoints("serious", 1), 15);
    assert.equal(rulePoints("serious", 200), 30);
    assert.equal(rulePoints("critical", 2), 39.03);
    for (const s of ["critical", "serious", "moderate", "minor"] as const) assert.equal(rulePoints(s, 1_000_000), 2 * SEVERITY_POINTS[s], s);
  });
  it("group a category's findings by rule: instances add up, the most severe instance sets the severity", () => {
    const rules = rulesOf([f("visual", "image-broken", "moderate"), f("visual", "image-broken", "serious"), f("visual", "image-broken", "moderate", 3), f("visual", "font-failed", "minor")]);
    assert.deepEqual(rules.map((r) => [r.rule, r.severity, r.instances, r.findings]), [["image-broken", "serious", 5, 3], ["font-failed", "minor", 1, 1]]);
    assert.equal(rules[0].points, rulePoints("serious", 5));
  });
});

describe("scan-score/3: diminishing deductions inside a category", () => {
  it("multiplies (1 - points / 100) over the rules, so each further rule takes less and the category stays above 0", () => {
    const one = categoryValue(rulesOf([f("visual", "a", "serious")]));
    const two = categoryValue(rulesOf([f("visual", "a", "serious"), f("visual", "b", "serious")]));
    const three = categoryValue(rulesOf([f("visual", "a", "serious"), f("visual", "b", "serious"), f("visual", "c", "serious")]));
    assert.equal(one, 85);
    assert.ok(Math.abs(two - 72.25) < 1e-9);
    assert.ok(100 - one > one - two && one - two > two - three, "each further rule takes fewer points");
    const many = rulesOf(Array.from({ length: 40 }, (_, i) => f("accessibility", `r${i}`, "critical", 100)));
    assert.ok(categoryValue(many) > 0, "never below 0");
    assert.ok(categoryValue(many) < 1);
  });
  it("bounds what one rule with 200 instances can take: the same as 10", () => {
    const s200 = score([f("accessibility", "axe:color-contrast", "serious", 200)], ALL);
    const s10 = score([f("accessibility", "axe:color-contrast", "serious", 10)], ALL);
    assert.equal(s200.categories.find((c) => c.id === "accessibility")!.value, 70);
    assert.equal(s200.value, s10.value);
    assert.equal(s200.categories.find((c) => c.id === "accessibility")!.rules[0].points, 30);
  });
});

describe("scan-score/3: the weighted mean", () => {
  it("weights Visual 25, Accessibility 25, Phone 20, Reliability 15, Speed 10, Races 5", () => {
    assert.deepEqual(CATEGORIES.map((c) => [c.id, c.weight]), [["visual", 25], ["accessibility", 25], ["phone", 20], ["reliability", 15], ["speed", 10], ["races", 5]]);
    assert.equal(CATEGORIES.reduce((s, c) => s + c.weight, 0), 100);
    assert.equal(score([], ALL).value, 100);
    // visual 85 and everything else 100: (25 * 85 + 75 * 100) / 100 = 96.25
    assert.equal(score([f("visual", "text-invisible", "serious")], ALL).value, 96);
    // one category at its lowest possible value cannot take more than its weight
    const worst = score(Array.from({ length: 30 }, (_, i) => f("races", `r${i}`, "critical", 50)), ALL);
    assert.ok(worst.value! >= 95, `races is 5% of the score: ${worst.value}`);
  });
  it("leaves out the categories the scan did not measure, and gives no score when none was", () => {
    const only = score([f("visual", "text-invisible", "serious")], { visual: true });
    assert.equal(only.value, 85, "the mean of the measured categories only");
    const a11y = only.categories.find((c) => c.id === "accessibility")!;
    assert.deepEqual([a11y.measured, a11y.value, a11y.raw, a11y.count], [false, null, null, 0]);
    assert.equal(score([f("accessibility", "axe:region", "minor")], { visual: true }).categories.find((c) => c.id === "accessibility")!.value, null, "findings in an unmeasured category do not make it measured");
    assert.equal(score([], {}).value, null);
  });
  it("is the same for the same findings in any order", () => {
    const fs = [f("visual", "a", "moderate"), f("phone", "tap-target-small", "serious", 12), f("visual", "b", "minor"), f("speed", "lcp-slow", "minor")];
    assert.deepEqual(score(fs, ALL), score([...fs].reverse(), ALL));
  });
  it("names what each rule costs the overall score, most first", () => {
    const fs = [f("accessibility", "axe:image-alt", "critical", 2), f("races", "duplicate-submit", "serious"), f("visual", "font-failed", "minor")];
    const impact = ruleImpact(fs, ALL);
    assert.deepEqual(impact.map((i) => i.rule), ["axe:image-alt", "duplicate-submit", "font-failed"]);
    // image-alt alone: accessibility 60.97, so it costs 25 * 39.03 / 100 = 9.76 points
    assert.equal(impact[0].points, 9.76);
    assert.equal(impact[1].points, 0.75);
  });
});
