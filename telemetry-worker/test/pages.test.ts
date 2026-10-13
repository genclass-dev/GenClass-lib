// The dashboard page's own script, rendered against stats JSON in happy-dom (already in the repo's dev dependencies,
// through packages/runtime): what a developer reads on the page, the possible-issues tier and the display fixes.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { dashboardPage, startPage } from "../src/pages.js";
import { sampleStats } from "../src/sample.js";
import type { Stats } from "../src/dashboard.js";

const NOW = new Date("2026-10-13T20:00:00Z");
const nf = new Intl.NumberFormat();

/** Render the dashboard for `stats`: the page body, then its inline script with fetch answering `stats`. */
async function render(stats: Stats) {
  const html = dashboardPage("NONCE", { name: stats.name, token: stats.token, created: stats.created, lastEvent: stats.lastEvent });
  const main = /<main class="wrap"[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!; // the shell's <main> also has id="main"
  const script = /<script nonce="NONCE">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const win = new Window({ url: "https://genclass.dev/dashboard/sample" });
  const doc = win.document;
  doc.body.innerHTML = main;
  const fetch = async () => ({ ok: true, json: async () => stats });
  const run = new Function("window", "document", "location", "localStorage", "fetch", "setInterval", "navigator", "IntersectionObserver", script);
  run(win, doc, win.location, win.localStorage, fetch, () => 0, win.navigator, class { observe() {} });
  await new Promise((r) => setTimeout(r, 20));
  const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hidden = (id: string) => doc.getElementById(id)!.classList.contains("hidden");
  const heads = (sel: string) => [...doc.querySelectorAll(`${sel} th`)].map((x) => x.textContent);
  return { doc, text, hidden, heads, close: () => win.happyDOM.close() };
}

describe("dashboard page: possible issues tier", () => {
  it("the sample shows possible issues apart from problems (summary, Fig. 2, cards, tables) and says it is simulated", async () => {
    const st = sampleStats("7d", NOW);
    expect(st.totals.possible).toBeGreaterThan(0);
    const { doc, text, hidden, heads, close } = await render(st);
    expect(text("#pname")).toContain("simulated data");
    expect(text("#summary")).toContain(`found ${nf.format(st.totals.detections!)} problems`);
    expect(text("#summary")).toContain(`It also flagged ${nf.format(st.totals.possible!)} possible issues at lower confidence, listed separately and not counted as problems.`);
    // Fig. 1 and its count stay confirmed-only; Fig. 2 draws the possible tier as hollow bars
    expect(text("#trendn")).toBe(`${nf.format(st.totals.detections!)} problems`);
    expect(hidden("possfig")).toBe(false);
    expect(text("#possn")).toBe(`${nf.format(st.totals.possible!)} possible issues`);
    expect(doc.querySelectorAll('#possplot rect[stroke="var(--ink3)"]').length).toBe(st.series.filter((b) => b.possible).length);
    expect(text("#possfig figcaption")).toContain("Not counted in Fig. 1");
    expect(heads("#trendtable")).toContain("Possible (not in total)");
    // cards: their own block, ring keys; the confirmed cards keep solid keys
    expect(hidden("possible-s")).toBe(false);
    expect(doc.querySelectorAll("#possible .find.poss").length).toBe(st.breakdowns.possible_diagnosis!.length);
    expect(doc.querySelectorAll("#possible .key.ring").length).toBe(st.breakdowns.possible_diagnosis!.length);
    expect(doc.querySelectorAll("#issues .key.ring").length).toBe(0);
    expect(text("#possible-s")).toContain("Not counted as problems");
    // the tier's floor is the runtime's (the eager setting's threshold from the model), not a fixed number on the page
    expect(text("#possible-s")).toContain("from the eager setting's threshold up");
    expect(text("#possfig figcaption")).toContain("from the eager setting's threshold up");
    expect(text("#possible-s .poss-note") + text("#possfig figcaption")).not.toMatch(/\d+%/);
    // pages table: a separate Possible column, and pages that only have possible issues
    expect(heads("#pages")).toEqual(["Page", "Problems", "By type", "Possible"]);
    expect(text("#pages")).toContain("/account");
    expect(text("#pages figcaption")).toContain("not counted in Problems");
    await close();
  });

  it("with possible issues and no problems, the summary says so and Fig. 1 stays empty", async () => {
    const st = sampleStats("7d", NOW);
    st.totals.detections = 0;
    st.typeSeries = st.typeSeries.map((b) => ({ ...b, counts: {} }));
    st.breakdowns = { ...st.breakdowns, detect_diagnosis: [], detect_issue: [], detect_route: [] };
    st.distinct = { ...st.distinct, detect_route: 0 };
    const { text, hidden, heads, close } = await render(st);
    // "found", not "confirmed": GenClass only judges the situations that stand out
    expect(text("#summary")).toContain(`found no problems. It flagged ${nf.format(st.totals.possible!)} possible issues at lower confidence`);
    expect(text("#summary")).not.toContain("confirmed");
    expect(text("#trendplot")).toBe("No problems found in this period.");
    expect(hidden("possfig")).toBe(false);
    expect(heads("#trendtable")).toContain("Possible (not in total)");
    expect(hidden("issuesempty")).toBe(false);
    expect(hidden("possible-s")).toBe(false);
    await close();
  });

  it("without possible issues nothing of the tier is shown", async () => {
    const st = sampleStats("7d", NOW);
    st.totals.possible = 0;
    st.series = st.series.map((b) => ({ ...b, possible: 0 }));
    st.breakdowns = { ...st.breakdowns, possible_diagnosis: [], possible_issue: [], possible_route: [] };
    const { text, hidden, heads, close } = await render(st);
    expect(text("#summary")).not.toContain("possible");
    expect(hidden("possfig")).toBe(true);
    expect(hidden("possible-s")).toBe(true);
    expect(heads("#trendtable")).not.toContain("Possible (not in total)");
    expect(heads("#pages")).toEqual(["Page", "Problems", "By type"]);
    await close();
  });
});

describe("dashboard page: display fixes", () => {
  it("Pages affected, the summary and the sidebar count every page with a problem, not only the top 25", async () => {
    const st = sampleStats("7d", NOW);
    st.breakdowns = { ...st.breakdowns, detect_route: Array.from({ length: 25 }, (_, i) => ({ key: `/p/${i}`, count: 1 })) };
    st.distinct = { ...st.distinct, detect_route: 30 };
    const { doc, text, close } = await render(st);
    expect(doc.querySelector("#tiles > div:nth-child(2) .k")!.textContent).toBe("Pages affected");
    expect(doc.querySelector("#tiles > div:nth-child(2) .v")!.textContent).toBe("30");
    expect(text("#summary")).toContain("on 30 pages");
    expect(text("#c-pages")).toBe("30");
    await close();
  });

  it("Recent activity shows the confidence it is given (the diagnosis confidence), and pages without a route are explained", async () => {
    const st = sampleStats("7d", NOW);
    st.recent = [{ t: NOW.toISOString(), route: "/cart", fn: null, trigger: "request", diagnosis: "duplicate", action: "coalesce", ran: "coalesce", confidence: 0.97, mode: "guard", executed: true, acted: true, kind: "acted" }];
    st.totals.detectionsWithPage = st.totals.detections! - 4;
    const { doc, text, close } = await render(st);
    expect([...doc.querySelectorAll("#recent td")].map((x) => x.textContent)).toContain("97%");
    expect(text("#pages figcaption")).toContain("4 problems arrived without a page");
    await close();
  });

  it("possible issues without a page are explained like problems without one", async () => {
    const st = sampleStats("7d", NOW);
    st.totals.possibleWithPage = st.totals.possible! - 3;
    const { text, close } = await render(st);
    expect(text("#pages figcaption")).toContain("3 possible issues arrived without a page.");
    await close();
  });

  it("decision time says it is an average of the records received, and leans when routine records were sampled", async () => {
    const st = sampleStats("7d", NOW);
    Object.assign(st.totals, { latency_ms_n: 35, latencyAvgMs: 120, records_sampled_out: 0, records_capped: 0 });
    let r = await render(st);
    expect(r.text("#health")).toContain("average of 35 decision records received");
    expect(r.text("#health")).not.toContain("leans");
    await r.close();
    Object.assign(st.totals, { records_sampled_out: 75 });
    r = await render(st);
    expect(r.text("#health")).toContain("average of 35 decision records received; routine decisions are sampled, so it leans towards the others");
    await r.close();
  });

  it("health lists what was not checked or not sent; the empty state explains local hosts and the 0.3.0 token", async () => {
    const st = sampleStats("7d", NOW);
    Object.assign(st.totals, { hidden_skipped: 6, model_dropped: 2, records_sampled_out: 40, records_capped: 3, telemetry_dropped: 1, actionLimits: 2 });
    let r = await render(st);
    expect(r.text("#health")).toContain("Not checked8");
    expect(r.text("#health")).toContain("6 in hidden tabs, 2 over the decision rate limit");
    expect(r.text("#health")).toContain("40 routine decisions sampled out, 3 over the per-page cap, 1 dropped in the browser");
    expect(r.text("#health")).toContain("Action limits reached2");
    await r.close();

    r = await render({ ...sampleStats("7d", NOW), lastEvent: null });
    expect(r.hidden("nodata")).toBe(false);
    expect(r.text("#nodata")).toContain("The token needs @genclass/runtime 0.3.0 or later");
    expect(r.text("#nodata")).toContain("never send anything, token or not, unless you pass telemetry: true");
    await r.close();
    expect(startPage("n")).toContain("unless you pass telemetry: true");
  });
});
