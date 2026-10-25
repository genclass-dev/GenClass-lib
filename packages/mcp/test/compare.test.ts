// The explore comparison (AGENT.md §5.1): where a difference shows (tiers), redactions, scenario grouping, snapshots
// that left fields out.
import { describe, expect, it } from "vitest";
import { compareRuns, groupRuns, sameScenario, sameValue, scenarioOf } from "../src/compare.js";
import type { ActStep, Run, Snapshot } from "../src/types.js";
import { act, snap } from "./helpers.js";

let n = 0;
/** A run of an explore session: fifo (a baseline) or seeded, its actions and its final snapshot. */
function run(order: "fifo" | "seeded", acts: ActStep[], s: Snapshot, extra: Partial<Run> = {}): Run {
  const id = `r${++n}`;
  return { id, started: 0, lastSeen: 0, page: { url: "http://localhost:5173/list", route: "/list" }, schedule: { order, ...(order === "seeded" ? { seed: n } : {}) }, steps: acts, lost: 0, order: [], forced: 0, witnesses: [], errors: [], detections: [], interventions: [], checks: [], expectations: [], snapshot: s, snapshots: 1, ended: true, ...extra };
}
const click = act(0, "click", 'link "Next page"');
/** Two baselines and the seeded runs, all with the same steps unless given. */
function session(base: Snapshot, seeded: Snapshot[], acts: ActStep[] = [click]): Run[] {
  return [run("fifo", acts, base), run("fifo", acts, base), ...seeded.map((s) => run("seeded", acts, s))];
}

describe("compare: where a difference shows (AGENT.md §5.1)", () => {
  it("store values that differ while the page shows the same are internal state, not a race", () => {
    const base = snap({ "redux.api.provided.Doc.LIST": '2 items ["list(1)", "list(2)"]', "redux.api.queries.list(2).requestId": '"aaaa"' }, ["Page 2", "Item 11"]);
    const g = compareRuns(session(base, [snap({ "redux.api.provided.Doc.LIST": '2 items ["list(2)", "list(1)"]', "redux.api.queries.list(2).requestId": '"bbbb"' }, ["Page 2", "Item 11"]), base]))[0];
    expect(g.compared).toBe(2);
    expect(g.diffs).toHaveLength(1);
    expect(g.diffs[0].tier).toBe("internal");
    expect(g.diffs[0].fields.map((f) => f.name)).toEqual(["redux.api.provided.Doc.LIST", "redux.api.queries.list(2).requestId"]);
  });

  it("what the page shows, its form values, the requests it sent and its errors are visible: a race", () => {
    const base = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "react" }, requests: { "GET /api/list": 2 } });
    const text = snap({ "list.page": "3" }, ["Page 3"], { fields: { Search: "react" }, requests: { "GET /api/list": 2 } });
    const field = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "reac" }, requests: { "GET /api/list": 2 } });
    const requests = snap({ "list.page": "2" }, ["Page 2"], { fields: { Search: "react" }, requests: { "GET /api/list": 2, "POST /api/orders": 1 } });
    const runs = session(base, [text, field, requests, base]);
    runs[5].errors.push({ t: 1, name: "TypeError", message: "x is undefined", chain: [] });
    const g = compareRuns(runs)[0];
    expect(g.diffs.map((d) => d.tier)).toEqual(["visible", "visible", "visible", "visible"]);
    // what the page shows and sends comes before the store values
    expect(g.diffs[0].textOnlyRun).toEqual(["Page 3"]);
    expect(g.diffs[1].fields[0]).toEqual({ where: "field", name: "Search", baseline: "react", run: "reac" });
    expect(g.diffs[2].fields[0]).toEqual({ where: "requests", name: "POST /api/orders", baseline: "(absent)", run: "1" });
    expect(g.diffs[3].errors).toEqual(["x is undefined"]);
  });

  it("a cache refetching once more (a GET count) and an announcement a slower run let expire are internal, not a race", () => {
    const base = snap({ "doc.status": '"published"' }, ["Article", "Saved document", "Close"], { requests: { "GET /api/doc/:id": 3, "POST /api/doc/:id/publish": 2 }, live: ["Saved document", "Close"] });
    const later = snap({ "doc.status": '"published"' }, ["Article"], { requests: { "GET /api/doc/:id": 5, "POST /api/doc/:id/publish": 2 } });
    const g = compareRuns(session(base, [later]))[0];
    expect(g.diffs[0]).toMatchObject({ tier: "internal", textOnlyBaseline: [], announced: ["Saved document", "Close"], fields: [{ where: "requests", name: "GET /api/doc/:id", baseline: "3", run: "5" }] });
    // the same lines outside a live region are what the page shows: a race
    const shown = compareRuns(session({ ...base, live: undefined }, [later]))[0];
    expect(shown.diffs[0]).toMatchObject({ tier: "visible", textOnlyBaseline: ["Saved document", "Close"] });
  });

  it("a witness only a seeded run had, with the same final state, is an overwrite repaired along the way", () => {
    const base = snap({ "search.results": "react!" }, ["Results for react"]);
    const runs = session(base, [base]);
    runs[2].witnesses.push({ kind: "overwrote-newer", t: 1, subject: "search.results", by: "GET /api/search#1", over: "GET /api/search#2", overKind: "request" });
    expect(compareRuns(runs)[0].diffs[0]).toMatchObject({ tier: "transient", fields: [], witnesses: ["overwrote-newer search.results by GET /api/search"] });
  });
});

describe("compare: a redaction is never a difference (AGENT.md §5.1)", () => {
  it("[redacted] equals any value, alone or inside a summary; the rest of the summary still counts", () => {
    expect(sameValue("[redacted]", '"wE3kfQ8"')).toBe(true);
    expect(sameValue('"wEkfQq"', "[redacted]")).toBe(true);
    expect(sameValue("{id: 1, requestId: [redacted], status: \"fulfilled\"}", '{id: 1, requestId: "abc", status: "fulfilled"}')).toBe(true);
    expect(sameValue("{id: 1, requestId: [redacted], status: \"fulfilled\"}", '{id: 2, requestId: "abc", status: "fulfilled"}')).toBe(false);
    expect(sameValue("{id: 1, requestId: [redacted]}", '{id: 1, requestId: "abc", status: "pending"}')).toBe(false);
    expect(sameValue('"a"', '"b"')).toBe(false);
  });

  it("an opaque id redacted in the baselines and plain in a seeded run (it had no digit) is no race", () => {
    const base = snap({ "AuthProvider.external2.requestId": "[redacted]", "AuthProvider.external2.status": '"fulfilled"' }, ["Home"]);
    const g = compareRuns(session(base, [snap({ "AuthProvider.external2.requestId": '"pXkqLmZaRtWbYcNdQeVfG"', "AuthProvider.external2.status": '"fulfilled"' }, ["Home"])]))[0];
    expect(g.diffs).toEqual([]);
    // and between the baselines: a redaction flip is not noise either, so the field stays compared
    const flip = compareRuns([run("fifo", [click], base), run("fifo", [click], snap({ "AuthProvider.external2.requestId": '"pXkq"', "AuthProvider.external2.status": '"fulfilled"' }, ["Home"])), run("seeded", [click], snap({ "AuthProvider.external2.requestId": "[redacted]", "AuthProvider.external2.status": '"pending"' }, ["Home"]))])[0];
    expect(flip.noise).toEqual([]);
    expect(flip.diffs[0].fields.map((f) => f.name)).toEqual(["AuthProvider.external2.status"]);
  });

  it("records pooled under fresh ids match with a redacted value among them", () => {
    const a = snap({ "subs.aK3x.token": "[redacted]", "subs.aK3x.n": "1", "x.y": "1" });
    const b = snap({ "subs.Q9pz.token": '"plain"', "subs.Q9pz.n": "1", "x.y": "1" });
    const c = snap({ "subs.Zt7m.token": '"other"', "subs.Zt7m.n": "1", "x.y": "1" });
    expect(compareRuns([run("fifo", [click], a), run("fifo", [click], b), run("seeded", [click], c)])[0].diffs).toEqual([]);
  });
});

describe("compare: scenario grouping (AGENT.md §5.1)", () => {
  const empty = snap({}, ["Saved"]);

  it("typed digits are blanked: a title unique to each run is one scenario", () => {
    const runs = [0, 1, 2, 3].map((i) => run(i < 2 ? "fifo" : "seeded", [act(0, "type", 'textbox "title"', `React guide 1 edit ${i + 1} ${12345 + i * 777}`), act(1, "click", 'button "Save"', undefined, { clicks: 2 })], empty));
    const { grouping, groups } = groupRuns(runs);
    expect(grouping).toBe("names");
    expect(groups.size).toBe(1);
    expect(compareRuns(runs)[0].compared).toBe(2);
  });

  it("a parenthesised count in a label, and a typing burst split when that label changed, are one scenario", () => {
    const one = [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author (1)"', "re")];
    const split = [act(0, "click", 'combobox "author (1)"'), act(1, "type", 'combobox "author"', "r"), act(2, "type", 'combobox "author (1)"', "re")];
    expect(scenarioOf(run("fifo", one, empty), "names")).toBe(scenarioOf(run("fifo", split, empty), "names"));
    const runs = [run("fifo", one, empty), run("fifo", split, empty), run("seeded", one, empty), run("seeded", split, empty)];
    const g = compareRuns(runs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ grouping: "names", compared: 2 });
    // the exact recording is what the report shows; the key is the normalised one
    expect(g[0].scenario).toBe('click combobox "author"\ntype combobox "author (1)" = re');
    expect(g[0].scenarioKey).toBe('click combobox "author"\ntype combobox "author" = re');
  });

  it("names that changed with the order fall back to action kinds and element roles, then to kinds alone", () => {
    const sort = (t: string) => [act(0, "click", 'div "TITLE"'), act(1, "click", t)];
    const roles = [run("fifo", sort('div "RANK"'), empty), run("fifo", sort('div "RANK"'), empty), run("seeded", sort('span "RANK"'), empty), run("seeded", sort('div "RANK"'), empty)];
    expect(compareRuns(roles)[0]).toMatchObject({ grouping: "roles", compared: 2, scenario: 'click div "TITLE"\nclick div "RANK"' });
    const kinds = [run("fifo", sort('columnheader "RANK"'), empty), run("fifo", sort('columnheader "RANK"'), empty), run("seeded", sort('span "RANK"'), empty)];
    expect(compareRuns(kinds)[0]).toMatchObject({ grouping: "kinds", compared: 1 });
  });

  it("the finest grouping that compares every comparable run wins; other routes and other steps stay apart", () => {
    const runs = [run("fifo", [click], empty), run("fifo", [click], empty), run("seeded", [click], empty), run("seeded", [act(0, "type", 'input "Search"', "x")], empty), run("seeded", [click], empty, { page: { url: "http://localhost:5173/other", route: "/other" } })];
    const g = compareRuns(runs);
    expect(g[0].grouping).toBe("names");
    expect(g.find((x) => x.route === "/list" && x.baselines.length === 2)!.compared).toBe(1);
    expect(g.filter((x) => x.compared === 0)).toHaveLength(2);
  });

  it("a replay with a label that changed with the order did the same steps", () => {
    const a = run("seeded", [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author"', "re")], empty);
    const b = run("seeded", [act(0, "click", 'combobox "author (1)"'), act(1, "type", 'combobox "author (1)"', "re")], empty);
    const c = run("seeded", [act(0, "click", 'button "Delete"')], empty);
    expect(sameScenario(a, b)).toBe(true);
    expect(sameScenario(a, c)).toBe(false);
  });
});

describe("compare: snapshots that left store fields out (AGENT.md §2)", () => {
  it("a field missing from a snapshot that left fields out was not compared; the group says so", () => {
    const base = snap({ "a.x": "1", "z.deep.field": "2" }, ["Home"], { stateLeft: 40, stateTotal: 1040 });
    const cut = snap({ "a.x": "1" }, ["Home"], { stateLeft: 41, stateTotal: 1041 });
    const g = compareRuns(session(base, [cut]))[0];
    expect(g.diffs).toEqual([]);
    expect(g.truncated).toEqual({ runs: 3, left: 41, total: 1041 });
    // without a cut, a missing field is a difference (internal: the page is the same)
    const whole = compareRuns(session(snap({ "a.x": "1", "z.deep.field": "2" }, ["Home"]), [snap({ "a.x": "1" }, ["Home"])]))[0];
    expect(whole.diffs[0]).toMatchObject({ tier: "internal", fields: [{ where: "state", name: "z.deep.field", baseline: "2", run: "(absent)" }] });
    expect(whole.truncated).toBeUndefined();
  });
});
