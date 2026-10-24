// The explore grouping (AGENT.md §5.1): which runs count as the same scenario. What a run records of its actions can
// depend on the response order (Strapi 5.59.0's admin: a sorted header drawn in another element, a relation label that
// gains a count, a title typed with a counter), and runs of the same steps must still be compared with the baselines.
import { describe, expect, it } from "vitest";
import { makeApi } from "../src/api.js";
import { compareRuns, scenarioOf, scenarioShapeOf } from "../src/compare.js";
import { Store } from "../src/store.js";
import { callTool } from "../src/tools.js";
import type { ActStep, Run } from "../src/types.js";
import { act, hello, snap } from "./helpers.js";

function run(acts: ActStep[]): Run {
  return { steps: acts } as unknown as Run;
}

/** An explore session on the store: 2 baselines and `loads.length - 2` seeded loads, each with its own actions. */
function explore(s: Store, loads: { acts: ActStep[]; state: Record<string, string>; text?: string[] }[], route = "/admin/content-manager") {
  const x = s.armExplore({ runs: loads.length - 2, route });
  const ids: string[] = [];
  for (const l of loads) {
    const h = s.hello(hello(route))!;
    ids.push(h.run);
    s.events({ run: h.run, token: h.token, events: [{ t: "steps", steps: l.acts, order: [] }, { t: "snapshot", snapshot: snap(l.state, l.text ?? []) }] });
  }
  return { x, ids };
}

async function report(s: Store, id: string): Promise<string> {
  const api = makeApi(s, { url: "http://127.0.0.1:0", port: 0 });
  const r = await callTool("genclass_explore", { action: "report", id }, { api: async (m, p) => api(m, p), now: () => Date.now(), cwd: process.cwd(), env: {} });
  return r.text;
}

describe("compare: the scenario fingerprint (AGENT.md §5.1)", () => {
  it("blanks digits in typed values, as page text", () => {
    expect(scenarioOf(run([act(0, "type", 'textbox "title"', "Post 17 v2")]))).toBe('type textbox "title" = Post N N');
    expect(scenarioOf(run([act(0, "type", 'textbox "title"', "Post 17")]))).toBe(scenarioOf(run([act(0, "type", 'textbox "title"', "Post 3")])));
    // words are kept: another query is another scenario
    expect(scenarioOf(run([act(0, "type", 'searchbox "Search"', "react")]))).not.toBe(scenarioOf(run([act(0, "type", 'searchbox "Search"', "vue")])));
  });

  it("drops a trailing parenthesised count from a target's name, and only that", () => {
    expect(scenarioOf(run([act(0, "click", 'combobox "author (1)"')]))).toBe('click combobox "author"');
    expect(scenarioOf(run([act(0, "click", 'link "Inbox (1,204)"')]))).toBe('click link "Inbox"');
    expect(scenarioOf(run([act(0, "click", 'button "(3)"')]))).toBe('click button "(3)"');
    expect(scenarioOf(run([act(0, "click", 'button "Step (beta)"')]))).toBe('click button "Step (beta)"');
    expect(scenarioOf(run([act(0, "click", "page")]))).toBe("click page");
  });

  it("merges consecutive typing bursts on the same field into one with the final value", () => {
    // the label gained its count mid-burst, so the runtime recorded two bursts
    const split = run([act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author"', "r"), act(2, "type", 'combobox "author (1)"', "re"), act(3, "click", 'option "Remy"')]);
    const whole = run([act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author (1)"', "re", { count: 2 }), act(2, "click", 'option "Remy"')]);
    expect(scenarioOf(split)).toBe('click combobox "author"\ntype combobox "author" = re\nclick option "Remy"');
    expect(scenarioOf(whole)).toBe(scenarioOf(split));
    // bursts on two fields, or separated by another action, stay apart
    expect(scenarioOf(run([act(0, "type", 'textbox "title"', "a"), act(1, "type", 'textbox "slug"', "a")])).split("\n")).toHaveLength(2);
    expect(scenarioOf(run([act(0, "type", 'textbox "q"', "a"), act(1, "key", 'textbox "q"', undefined, { key: "Enter" }), act(2, "type", 'textbox "q"', "ab")])).split("\n")).toHaveLength(3);
  });

  it("the fallback is action kinds and element roles in order; elements without a role of their own are one role", () => {
    expect(scenarioShapeOf(run([act(0, "click", 'div "RANK"'), act(1, "click", 'span "RANK"', undefined, { clicks: 2 }), act(2, "type", 'combobox "author"', "re")]))).toBe("click generic\nclick generic ×2\ntype combobox");
    expect(scenarioShapeOf(run([act(0, "click", 'button "Save"')]))).not.toBe(scenarioShapeOf(run([act(0, "click", 'link "Save"')])));
  });
});

describe("compare: runs of the same steps are compared whatever their response order did to the recording (AGENT.md §5.1)", () => {
  const header = (third: string, fourth: string) => [act(0, "click", 'div "RANK"'), act(1, "click", 'div "RANK"'), act(2, "click", `${third} "RANK"`), act(3, "click", `${fourth} "RANK"`)];

  it("a sorted header drawn in another element: one group, the other elements listed as variants, no race", async () => {
    const s = new Store();
    const tags: [string, string][] = [["div", "div"], ["div", "span"], ["span", "span"], ["div", "span"], ["span", "div"], ["div", "div"], ["span", "span"], ["div", "span"]];
    const { x, ids } = explore(
      s,
      tags.map(([a, b]) => ({ acts: header(a, b), state: { "list.sort": "rank:ASC" }, text: ["Rank", "1", "2", "3"] })),
    );
    const rep = s.reportExplore(x.id)!;
    expect(rep.groups).toHaveLength(1);
    const g = rep.groups[0];
    expect(g.runs).toBe(8);
    expect(g.baselines).toEqual(ids.slice(0, 2));
    expect(g.scenario).toBe(scenarioOf(s.runs.get(ids[0])!));
    expect(g.variants.flatMap((v) => v.runs).sort()).toEqual([ids[1], ids[2], ids[3], ids[4], ids[6], ids[7]].sort());
    expect(g.diffs).toEqual([]);
    expect(rep.findings).toEqual([]);
    const text = await report(s, x.id);
    expect(text).toContain("Grouped by action kinds and element roles: 6 run(s) recorded other elements, element names or typed values");
    expect(text).toContain('action 4 "click span \\"RANK\\""');
    expect(text).toContain("No race found: all 6 reordered run(s) ended in the baseline's state.");
  });

  it("a variant run that ended differently is a race, and says it was matched by kinds and roles", async () => {
    const s = new Store();
    const tags: [string, string][] = [["div", "div"], ["div", "div"], ["div", "div"], ["div", "span"]];
    const { x, ids } = explore(
      s,
      tags.map(([a, b], i) => ({ acts: header(a, b), state: { "list.sort": i === 3 ? "rank:DESC" : "rank:ASC" } })),
    );
    const rep = s.reportExplore(x.id)!;
    expect(rep.groups).toHaveLength(1);
    expect(rep.groups[0].diffs.map((d) => d.run)).toEqual([ids[3]]);
    expect(rep.findings).toHaveLength(1);
    const text = await report(s, x.id);
    expect(text).toContain("RACE: 1 of 2 reordered run(s)");
    expect(text).toContain(`- run ${ids[3]} (seed 2) (its recorded elements, names or values differed: matched by action kinds and roles):`);
  });

  it("a relation label that gains a count, and a burst split by it: one scenario, no variants", () => {
    const s = new Store();
    const picker = [
      // the count response landed before the click, after the first keystroke, or after the burst
      [act(0, "click", 'combobox "author (1)"'), act(1, "type", 'combobox "author (1)"', "re", { count: 2 }), act(2, "click", 'option "Remy"')],
      [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author"', "r"), act(2, "type", 'combobox "author (1)"', "re"), act(3, "click", 'option "Remy"')],
      [act(0, "click", 'combobox "author"'), act(1, "type", 'combobox "author"', "re", { count: 2 }), act(2, "click", 'option "Remy"')],
    ];
    const { x } = explore(
      s,
      [0, 1, 2, 1, 0, 2, 1, 0].map((p) => ({ acts: picker[p], state: { "article.author": "Remy" } })),
    );
    const rep = s.reportExplore(x.id)!;
    expect(rep.groups).toHaveLength(1);
    expect(rep.groups[0].scenario).toBe('click combobox "author"\ntype combobox "author" = re\nclick option "Remy"');
    expect(rep.groups[0].variants).toEqual([]);
    expect(rep.groups[0].runs).toBe(8);
    expect(rep.groups[0].diffs).toEqual([]);
  });

  it("a value typed with a counter on every load: one scenario; the counter itself differs between the baselines, so it is noise", () => {
    const s = new Store();
    const { x } = explore(
      s,
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ acts: [act(0, "type", 'textbox "title"', `Post ${n}`, { count: 6 }), act(1, "click", 'button "Save"')], state: { "article.title": `Post ${n}`, "article.status": "saved" }, text: [`Post ${n}`, "Saved"] })),
    );
    const rep = s.reportExplore(x.id)!;
    expect(rep.groups).toHaveLength(1);
    const g = rep.groups[0];
    expect(g.scenario).toBe('type textbox "title" = Post N\nclick button "Save"');
    expect(g.variants).toEqual([]);
    expect(g.runs).toBe(8);
    expect(g.noise).toContain("state article.title");
    expect(g.diffs).toEqual([]);
  });

  it("actions that really differ (another field, another click) stay another scenario", () => {
    const runs = [act(0, "type", 'textbox "title"', "Post 1"), act(0, "type", 'textarea "body"', "Post 1"), act(0, "click", 'button "Save"')].map((a, i) => ({
      ...run([a]),
      id: `r${i}`,
      page: { url: "http://localhost/a", route: "/a" },
      schedule: { order: "fifo" as const },
      snapshot: snap({}),
      witnesses: [],
      errors: [],
      forced: 0,
    })) as unknown as Run[];
    expect(compareRuns(runs)).toHaveLength(3);
  });
});

describe("compare: a group with nothing to compare is never a negative result (AGENT.md §5.1)", () => {
  it("baselines whose reordered runs all recorded other actions: 0 compared, not 'No race found'", async () => {
    const s = new Store();
    const save = [act(0, "type", 'textbox "title"', "Hello"), act(1, "click", 'button "Save"')];
    // the reordered loads also clicked Publish (another scenario), so the baselines' group holds no reordered run
    const other = [...save, act(2, "click", 'button "Publish"')];
    const { x } = explore(s, [save, save, other, other, other].map((acts) => ({ acts, state: { "article.status": "saved" } })));
    const rep = s.reportExplore(x.id)!;
    expect(rep.groups.map((g) => g.runs)).toEqual([2, 3]);
    const text = await report(s, x.id);
    expect(text).toContain("0 reordered runs could be compared: their recorded actions differed from the baselines' (3 reordered run(s) are in the other group(s) of this report).");
    expect(text).not.toContain("No race found");
    expect(text).toContain("No baseline run in this group");
  });

  it("baselines with no reordered run recorded yet: 0 compared, none recorded", async () => {
    const s = new Store();
    const save = [act(0, "click", 'button "Save"')];
    const x = s.armExplore({ runs: 2, route: "/a" });
    for (let i = 0; i < 2; i++) {
      const h = s.hello(hello("/a"))!;
      s.events({ run: h.run, token: h.token, events: [{ t: "steps", steps: save, order: [] }, { t: "snapshot", snapshot: snap({ "a.saved": "true" }) }] });
    }
    const text = await report(s, x.id);
    expect(text).toContain("0 reordered runs could be compared: none was recorded yet");
    expect(text).not.toContain("No race found");
  });
});
