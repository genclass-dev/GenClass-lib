// CONTRACT §8 (delivery decisions): SubjectRef.cellConflicts, the cell-level conflict count of a delivery. Structured
// data for decision providers only; the situation text the model reads must not change.
import { describe, expect, it } from "vitest";
import { cellConflicts } from "../src/decide/cells.js";
import { defaultScript, setup } from "./helpers.js";

const cmp = (path: string, incoming: unknown, current: unknown, start?: unknown, known = true) => ({
  path,
  incoming,
  current,
  same: JSON.stringify(incoming) === JSON.stringify(current),
  ...(known ? { start: { value: start } } : {}),
  others: [],
});
const newer = (path: string) => ({ path, kind: "newer" as const });

describe("cellConflicts (SubjectRef.cellConflicts)", () => {
  it("counts list cells the response changes that are newer than at the operation's start", () => {
    const start = [{ id: 1, col: "todo", title: "A" }, { id: 2, col: "todo", title: "B" }, { id: 3, col: "done", title: "C" }];
    // since the GET started, card 1 moved to "doing" and card 2 was renamed; the stale response has the old board
    const current = [{ id: 1, col: "doing", title: "A" }, { id: 2, col: "todo", title: "B2" }, { id: 3, col: "done", title: "C" }];
    const incoming = start;
    expect(cellConflicts([newer("board.cards")], [cmp("board.cards", incoming, current, start)] as never)).toEqual({ cells: 2, fields: 1, approx: false });
  });

  it("does not count cells the response changes that nobody touched since the start (an ordinary update)", () => {
    const start = [{ id: 1, col: "todo" }, { id: 2, col: "todo" }];
    const current = [{ id: 1, col: "doing" }, { id: 2, col: "todo" }];
    const incoming = [{ id: 1, col: "doing" }, { id: 2, col: "done" }]; // the server moved card 2; card 1 agrees
    expect(cellConflicts([newer("board.cards")], [cmp("board.cards", incoming, current, start)] as never)).toEqual({ cells: 0, fields: 0, approx: false });
  });

  it("scalars count as one cell; equal values and A→B→A histories count as none", () => {
    expect(cellConflicts([newer("doc.title")], [cmp("doc.title", "old", "new", "old")] as never)).toEqual({ cells: 1, fields: 1, approx: false });
    expect(cellConflicts([newer("doc.title")], [cmp("doc.title", "same", "same", "x")] as never)).toEqual({ cells: 0, fields: 0, approx: false });
    expect(cellConflicts([newer("doc.title")], [cmp("doc.title", "old", "a", "a")] as never)).toEqual({ cells: 0, fields: 0, approx: false });
  });

  it("an unknown start counts every changed cell and says so", () => {
    const current = [{ id: 1, col: "doing" }, { id: 2, col: "todo" }];
    const incoming = [{ id: 1, col: "todo" }, { id: 2, col: "todo" }];
    expect(cellConflicts([newer("board.cards")], [cmp("board.cards", incoming, current, undefined, false)] as never)).toEqual({ cells: 1, fields: 1, approx: true });
  });

  it("is undefined without conflicts or without a comparison for them", () => {
    expect(cellConflicts([], [cmp("a", 1, 2, 1)] as never)).toBeUndefined();
    expect(cellConflicts([newer("a")], [cmp("b", 1, 2, 1)] as never)).toBeUndefined();
  });
});

describe("delivery: cellConflicts reaches the decision provider, the situation text does not change", () => {
  async function typeahead(withCells: boolean) {
    const s = setup({ script: defaultScript({ delivery: { diagnosis: "stale", action: "discard" } }) });
    const { rt, clock, server, fetch } = s;
    server.on("GET", "/api/search", ({ url }) => {
      const q = url.searchParams.get("q");
      return { body: { q, results: [`${q}-1`, `${q}-2`] }, latency: q === "rea" ? 900 : 120 };
    });
    const search = rt.atom("search", { query: "", results: [] as string[] });
    const type = (q: string) =>
      rt.user({ kind: "type", target: 'input "Search"', value: q }, () => {
        search.set((v) => ({ ...v, query: q }));
        void (async () => {
          const res = await fetch(`/api/search?q=${q}`);
          const data = (await res.json()) as { q: string; results: string[] };
          search.set((v) => ({ ...v, results: data.results }));
        })();
      });
    type("r");
    await clock.advance(80);
    type("re");
    await clock.advance(70);
    type("rea");
    await clock.advance(90);
    type("reac");
    await clock.advance(3000);
    void withCells;
    return s.decider.calls.filter((c) => c.trigger === "delivery");
  }

  it("the stale typeahead delivery carries the count on req.subject", async () => {
    const calls = await typeahead(true);
    const stale = calls.find((c) => (c.subject as { cellConflicts?: unknown } | undefined)?.cellConflicts);
    expect(stale).toBeDefined();
    const cc = (stale!.subject as { cellConflicts: { cells: number; fields: number } }).cellConflicts;
    expect(cc.fields).toBe(1);
    expect(cc.cells).toBeGreaterThanOrEqual(1);
    // structured only: no mention in the text the model reads
    expect(JSON.stringify(stale!.state)).not.toMatch(/cellConflicts|cell conflict/i);
  });
});
