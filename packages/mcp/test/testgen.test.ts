// Regression tests from findings (AGENT.md §5.3) and the text rules (§6).
import { describe, expect, it } from "vitest";
import { actionLines, locator, parseTarget, regressionTest } from "../src/testgen.js";
import { clean, pathShape, q } from "../src/text.js";
import type { Finding, Run } from "../src/types.js";
import { act } from "./helpers.js";

function run(steps: Run["steps"], url = "http://localhost:5173/search?q=1&genclass-schedule=fifo#/tab"): Run {
  return { id: "r1", started: 0, lastSeen: 0, page: { url, route: "/search" }, schedule: null, steps, lost: 0, order: ["GET /api/search#2", "GET /api/search#1"], forced: 0, witnesses: [], errors: [], detections: [], interventions: [], checks: [], expectations: [], snapshots: 1, ended: false };
}

function finding(kind: Finding["kind"], evidence: Record<string, unknown>): Finding {
  return { id: "f1", key: "k", kind, title: "t", route: "/search", count: 1, runs: ["r1"], first: 0, last: 0, evidence, replays: [], run: "r1" };
}

describe("testgen (AGENT.md §5.3)", () => {
  it("targets: the runtime's element descriptions become Playwright locators", () => {
    expect(parseTarget('button "Place order"')).toEqual({ role: "button", name: "Place order" });
    expect(locator('button "Place order"')).toBe('page.getByRole("button", { name: "Place order", exact: true }).or(page.locator("[name=\\"Place order\\"], [id=\\"Place order\\"]")).first()');
    const field = locator('input "q"');
    expect(field).toContain('page.getByLabel("q", { exact: true }).or(page.getByPlaceholder("q", { exact: true })).or(page.getByTitle("q", { exact: true }))');
    expect(field).toContain('page.locator("[name=\\"q\\"], [id=\\"q\\"]")');
    expect(locator('li "Milk"')).toBe('page.getByText("Milk", { exact: true }).first()');
    expect(locator(undefined)).toBe('page.locator("body").first()');
    expect(locator("range")).toBe('page.locator("input[type=\\"range\\"]").first()');
  });

  it("a name the runtime truncated matches by its prefix (built at run time from a string literal)", () => {
    expect(locator('link "How to fix race conditions in React app…"')).toBe('page.getByRole("link", { name: new RegExp("^How to fix race conditions in React app") }).first()');
    expect(locator('li "Price (USD) and more…"')).toBe('page.getByText(new RegExp("^Price \\\\(USD\\\\) and more")).first()');
  });

  it("actions: typing at the recorded pace, a continued burst types only the new characters, a double click, a nameless target", () => {
    const S = locator('input "Search"');
    const lines = actionLines([
      act(0, "type", 'input "Search"', "rea", { count: 3, dur: 200 }),
      act(1, "type", 'input "Search"', "react", { count: 2, dur: 50 }),
      act(2, "click", 'button "Pay"'),
      act(3, "click", 'button "Pay"', undefined, { clicks: 2 }),
      act(4, "change", 'checkbox "Gift"', "checked"),
      act(5, "type", 'input "Card"', "[redacted]"),
      act(6, "click", "button"),
    ]);
    expect(lines).toEqual([
      `await ${S}.fill("");`,
      `await ${S}.pressSequentially("rea", { delay: 100 });`,
      `await ${S}.pressSequentially("ct", { delay: 50 });`,
      `await ${locator('button "Pay"')}.dblclick();`,
      `await ${locator('checkbox "Gift"')}.check();`,
      `await ${locator('input "Card"')}.fill("example"); // the recorded value was redacted`,
      '// TODO: the recorded element "button" had no name; check that this locator finds it',
      'await page.locator("button").first().click();',
    ]);
  });

  it("a stale-write test replays the recorded order and asserts no stale overwrite on the field, whatever its record id", () => {
    const t = regressionTest(finding("stale-write", { subject: "notes.byId.8f3a9c2e.body" }), run([act(0, "type", 'searchbox "Search"', "react")]), { order: "given", given: ["GET /api/search#2", "GET /api/search#1"] })!;
    expect(t).toContain('const SCHEDULE = {"order":"given","given":["GET /api/search#2","GET /api/search#1"]};');
    expect(t).toContain('await page.goto(APP + "/search?q=1#/tab");');
    expect(t).toContain('const SUBJECT = new RegExp("^notes\\\\.byId\\\\.[^.]+\\\\.body$");');
    expect(t).toContain('w.kind === "overwrote-newer" && SUBJECT.test(w.subject)');
    expect(t).toContain('getByRole("searchbox", { name: "Search", exact: true })');
    expect(t).not.toContain("could not derive");
  });

  it("a race test asserts every kind of difference it has, and never passes asserting nothing", () => {
    const onlyRun = regressionTest(finding("race", { fields: [], textOnlyBaseline: [], textOnlyRun: ["Something went wrong"], errors: ["TypeError: x is undefined at 12"], witnesses: [] }), run([]), { order: "seeded", seed: 3 })!;
    expect(onlyRun).toContain('expect(snap.text, "the page does not show what only the failing order showed").not.toContain("Something went wrong");');
    expect(onlyRun).toContain('shape(e.message) === "TypeError: x is undefined at N"');
    const nothing = regressionTest(finding("race", { fields: [], textOnlyBaseline: [], textOnlyRun: [], errors: [], witnesses: [] }), run([]), { order: "seeded", seed: 3 })!;
    expect(nothing).toContain('expect(false, "GenClass could not derive a generic assertion');
    const base = regressionTest(finding("race", { fields: [{ where: "state", name: "search.results", baseline: "2 items", run: "1 item" }], textOnlyBaseline: ["Results for react"], textOnlyRun: [], errors: [], witnesses: [] }), run([]), { order: "seeded", seed: 3 })!;
    expect(base).toContain('expect(snap.state["search.results"], "as with responses in request order").toBe("2 items");');
    expect(base).toContain('expect(snap.text, "the page shows what it shows with responses in request order").toContain("Results for react");');
  });

  it("a race on fresh record ids asserts the records' values; a field only the failing run had must be absent", () => {
    const t = regressionTest(finding("race", { fields: [{ where: "state", name: "todos.entities.*.title", baseline: "Buy milk", run: "Buy mil" }, { where: "state", name: "ui.error", baseline: "(absent)", run: "oops" }], textOnlyBaseline: [], textOnlyRun: [], errors: [], witnesses: [] }), run([]), { order: "seeded", seed: 2 })!;
    expect(t).toContain('expect(stateValue(snap.state, "todos.entities.*.title"), "as with responses in request order").toBe("Buy milk");');
    expect(t).toContain('expect(snap.state["ui.error"], "as with responses in request order").toBeUndefined();');
    expect(t).toContain('const re = new RegExp("^" + name.split(".").map((s) => (s === "*" ? "[^.]+" : s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"))).join("\\\\.") + "$");');
  });

  it("an error test matches the error by name and shape, so a changing number in the message cannot hide it", () => {
    const t = regressionTest(finding("error", { name: "Error", message: "Error: Order 4312 not found  " }), run([]), { order: "given", given: [] })!;
    expect(t).toContain('e.name === "Error" && shape(e.message) === "Error: Order N not found"');
  });

  it("page strings cannot break out of the generated code", () => {
    const evil = '"); require("child_process").exec("rm -rf ~"); ("';
    const t = regressionTest(finding("error", { name: "Error", message: evil }), run([act(0, "click", `button "${evil}"`)]), undefined)!;
    // every occurrence is inside a JSON string literal: the quote is escaped
    expect(t).not.toContain('("rm -rf ~"); ("');
    expect(t).toContain('\\"); require(\\"child_process\\")');
  });

  it("clean and q: printable, single line, capped, quoted, no invisible text", () => {
    expect(clean("a\u0000b\nc\u001b[2Jd‮e", 100)).toBe("a b cd e"); // an ANSI sequence is removed, other controls become a space
    expect(clean("x".repeat(300), 10)).toHaveLength(10);
    expect(q('he said "hi"\nnew line')).toBe('"he said \\"hi\\" new line"');
    expect(clean("a\u{E0041}\u{E0042}b️c")).toBe("abc");
    expect(q("ok\u{E0049}")).not.toMatch(/\uDB40/);
    expect(clean("😀".repeat(5), 3)).toBe("😀😀…");
  });

  it("pathShape blanks id-like segments only", () => {
    expect(pathShape("notes.byId.8f3a9c2e.body")).toBe("notes.byId.*.body");
    expect(pathShape("todos.entities.Zt7m9.title")).toBe("todos.entities.*.title");
    expect(pathShape("orders.42.total")).toBe("orders.*.total");
    expect(pathShape("search.results")).toBe("search.results");
    expect(pathShape("user.address2.city")).toBe("user.address2.city");
  });
});
