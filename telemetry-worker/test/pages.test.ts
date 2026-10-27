// The dashboard page's own script, rendered against stats JSON in happy-dom (already in the repo's dev dependencies,
// through packages/runtime): what a developer reads on the page, the possible-issues tier and the display fixes.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { ANALYTICS_RUNTIME, analyticsPrompt, CDN_SCRIPT, DASH_CSS, dashboardPage, esc, installPrompt, KEY_RUNTIME, MCP_PKG, MESH_SCRIPT, orgName, RUNTIME_PKG, securityHeaders, SNIPPET_RUNTIME, startPage, type DashboardOptions } from "../src/pages.js";
import { accountPage, devicePage, forgotPage, lockedLinkPage, loginPage, messagePage, newProjectPage, passkeyStepPage, pendingPage, signupPage } from "../src/account-pages.js";
import { sampleStats } from "../src/sample.js";
import type { Stats } from "../src/dashboard.js";

const NOW = new Date("2026-10-13T20:00:00Z");
const nf = new Intl.NumberFormat();

/** The sample without its measured visual checks, for the tests about the model's findings alone. */
function noChecks(st: Stats): Stats {
  st.totals = { ...st.totals, checks: 0, checksWithPage: 0, check_loads: 0, visual_fix: 0, check_ms: 0 };
  st.series = st.series.map((b) => ({ ...b, checks: 0 }));
  st.checkSeries = st.checkSeries.map((b) => ({ ...b, counts: {} }));
  const { check_kind: _k, check_issue: _i, check_fix: _f, check_tier: _t, visual_setting: _v, ...rest } = st.breakdowns;
  st.breakdowns = rest;
  st.previous = { ...st.previous, checks: 0 };
  return st;
}
/** Problems on the page: the model's detections and the measured checks. */
const problems = (st: Stats) => (st.totals.detections ?? 0) + (st.totals.checks ?? 0);

/** A page's <body> (the Studio frame: header, rail, product menus, <main>, dialogs) without its inline script, and the script. */
function page(html: string): { body: string; script: string } {
  const script = /<script nonce="NONCE">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script nonce="NONCE">[\s\S]*?<\/script>/, "");
  return { body, script };
}

/**
 * Render the dashboard for `stats`: the page body, then its inline script with fetch answering `stats` (and, in account
 * mode, the Connect dialog's project list). `opts` as dashboardPage takes them: with `account` the account-mode page
 * (/account/apps/<id>: the Connect dialog's ways in, the period controls in #period, no #ptok or #snips).
 */
async function render(stats: Stats, opts: DashboardOptions = {}, o: { url?: string; copied?: string[] } = {}) {
  const html = dashboardPage("NONCE", { name: stats.name, token: stats.token, created: stats.created, lastEvent: stats.lastEvent }, opts);
  const { body, script } = page(html);
  const win = new Window({ url: o.url ?? (opts.account ? `https://genclass.dev/account/apps/${opts.id}` : "https://genclass.dev/dashboard/sample") });
  const doc = win.document;
  doc.body.innerHTML = body;
  const urls: string[] = [], writes: string[] = [];
  const fetch = async (u: string, init?: { method?: string }) => {
    urls.push(u);
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${u}`);
    // POST .../link: an agent link (auth.ts makeLink)
    if (u.endsWith("/link")) return { ok: true, status: 201, json: async () => ({ dashboardUrl: `https://genclass.dev/dashboard/${"S".repeat(32)}` }) };
    return { ok: true, status: 200, json: async () => (u.startsWith("/api/account/projects?") || u === "/api/account/projects" ? { projects: [] } : stats) };
  };
  // a clipboard that records what was copied (the page's gcCopy writes with it)
  const nav = o.copied ? { clipboard: { writeText: async (t: string) => void o.copied!.push(t) } } : win.navigator;
  const run = new Function("window", "document", "location", "localStorage", "fetch", "setInterval", "navigator", "IntersectionObserver", script);
  run(win, doc, win.location, win.localStorage, fetch, () => 0, nav, class { observe() {} });
  await new Promise((r) => setTimeout(r, 20));
  const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hidden = (id: string) => doc.getElementById(id)!.classList.contains("hidden");
  const heads = (sel: string) => [...doc.querySelectorAll(`${sel} th`)].map((x) => x.textContent);
  return { doc, text, hidden, heads, urls, writes, close: () => win.happyDOM.close() };
}

describe("dashboard page: possible issues tier", () => {
  it("the sample shows possible issues apart from problems (summary, Fig. 2, cards, tables) and says it is simulated", async () => {
    const st = sampleStats("7d", NOW);
    expect(st.totals.possible).toBeGreaterThan(0);
    const { doc, text, hidden, heads, close } = await render(st);
    expect(text("#pname")).toContain("simulated data");
    expect(text("#summary")).toContain(`found ${nf.format(problems(st))} problems (${nf.format(st.totals.checks!)} measured checks)`);
    expect(text("#summary")).toContain(`It also flagged ${nf.format(st.totals.possible!)} possible issues at lower confidence, listed separately and not counted as problems.`);
    // Fig. 1 and its count stay confirmed-only (the model's detections and the measured checks); Fig. 2 draws the possible tier as hollow bars
    expect(text("#trendn")).toBe(`${nf.format(problems(st))} problems`);
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
    const st = noChecks(sampleStats("7d", NOW));
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
    const st = noChecks(sampleStats("7d", NOW));
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
    expect(r.text("#nodata")).toContain("The token needs @genclass/runtime 0.3.0-beta.0 or later");
    // as the runtime behaves (src/telemetry/config.ts) and PRIVACY.md says: any telemetry options object opts in too
    expect(r.text("#nodata")).toContain("do not send by default, token or not; telemetry: true or a telemetry options object opts them in");
    expect(r.text("#nodata")).not.toContain("never send anything");
    await r.close();
    expect(startPage("n")).toContain("telemetry: true or a telemetry options object opts them in");
    expect(startPage("n")).not.toContain("never send anything");
  });
});

describe("dashboard page: account mode (/account/apps/<id>) with live stats", () => {
  const account = { apps: [{ id: "0123456789abcdef", name: "Shop" }], current: "0123456789abcdef", email: "dev@example.com" };

  it("renders the merged script: possible issues, the period controls in #period, the Connect dialog closed, no #setup", async () => {
    const st = sampleStats("7d", NOW);
    expect(st.totals.possible).toBeGreaterThan(0);
    const r = await render(st, { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    // the script ran to the end without #install, #ptok or #snips (private-link mode only) and loaded the account stats
    expect(r.doc.getElementById("install")).toBeNull();
    expect(r.doc.getElementById("ptok")).toBeNull();
    expect(r.doc.getElementById("setup")).toBeNull();
    expect(r.urls[0]).toBe("/api/account/projects/0123456789abcdef/stats?range=7d");
    expect(r.text("#updated")).not.toContain("Could not load");
    expect(r.text("#updated")).toMatch(/^Updated /);
    // live: the period controls show, the stats render, the possible tier with them
    expect(r.hidden("period")).toBe(false);
    expect(r.hidden("content")).toBe(false);
    expect(r.hidden("nodata")).toBe(true);
    expect(r.text("#trendn")).toBe(`${nf.format(problems(st))} problems`);
    expect(r.hidden("possfig")).toBe(false);
    expect(r.text("#possn")).toBe(`${nf.format(st.totals.possible!)} possible issues`);
    expect(r.hidden("possible-s")).toBe(false);
    expect(r.doc.querySelectorAll("#possible .find.poss").length).toBe(st.breakdowns.possible_diagnosis!.length);
    expect(r.heads("#pages")).toEqual(["Page", "Problems", "By type", "Possible"]);
    // the Connect dialog: closed until the header's Connect opens it, and its status line says connected
    expect(r.doc.getElementById("m-connect")!.classList.contains("open")).toBe(false);
    expect(r.text("#cstatust")).toMatch(/^Connected\. First event /);
    // the header: the organization (named after the account), the project and its live status
    expect(r.text(".sb-crumbs")).toContain("dev's Org");
    expect(r.text("#hname")).toBe(st.name);
    expect(r.text("#hstatus")).toBe("Live");
    expect(r.doc.getElementById("cnote")).toBeNull(); // runtimeReady: no "Not on npm yet"
    await r.close();
  });

  it("while the app waits for its first event: Getting started shows, the period controls and stats stay hidden, nothing throws", async () => {
    const st = { ...sampleStats("7d", NOW), lastEvent: null };
    const r = await render(st, { account, id: "0123456789abcdef", firstEvent: null });
    expect(r.hidden("period")).toBe(true);
    expect(r.hidden("content")).toBe(true);
    // Getting started: its steps open the Connect dialog's tabs and the MCP view
    expect(r.hidden("nodata")).toBe(false);
    expect([...r.doc.querySelectorAll("#nodata [data-open]")].map((b) => b.getAttribute("data-tab"))).toEqual(["fw", "ana"]);
    expect(r.doc.querySelector('#nodata a[data-goto="mcp"]')).not.toBeNull();
    expect(r.text("#hstatus")).toBe("Waiting");
    expect(r.text("#cstatust")).toBe("Waiting for the first event from this app");
    expect(r.text("#updated")).not.toContain("Could not load");
    // not on npm yet (runtimeReady unset): said first, with the @beta command
    expect(r.text("#cnote")).toContain(`Project keys ship in @genclass/runtime ${KEY_RUNTIME} (npm dist-tag beta), which is not published yet`);
    expect(r.text("#connect")).toContain(`npx ${RUNTIME_PKG} login`);
    // analytics: the version they need and the exact install line
    expect(r.text("#canalytics")).toBe(
      `Interaction analytics (the Visitors view) need @genclass/runtime ${ANALYTICS_RUNTIME} or later and analytics: true: npm install ${RUNTIME_PKG}. Earlier versions ignore the option without a word.`,
    );
    await r.close();
  });
});

describe("snippets: the runtime that reads the token", () => {
  it("the script tag pins an exact version (the unversioned URL serves npm's latest, 0.2.x, which ignores a token)", () => {
    expect(CDN_SCRIPT).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@genclass\/runtime@\d+\.\d+\.\d+(-[0-9a-z.]+)?$/);
    expect(CDN_SCRIPT).toBe(`https://cdn.jsdelivr.net/npm/@genclass/runtime@${SNIPPET_RUNTIME}`);
    // while it is a prerelease the npm and npx commands name its dist-tag (plain `@genclass/runtime` installs latest)
    expect(SNIPPET_RUNTIME.includes("-")).toBe(RUNTIME_PKG === "@genclass/runtime@beta");
    for (const html of [startPage("n"), startPage("n", { runtimeReady: true }), dashboardPage("n", { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null })]) {
      expect(html).toContain(CDN_SCRIPT);
      expect(html).not.toMatch(/cdn\.jsdelivr\.net\/npm\/@genclass\/runtime["' ]/);
      // npm and npx name the beta dist-tag while the runtime that reads keys is a prerelease
      expect(html).toContain(`npx ${RUNTIME_PKG} init`);
      expect(html).toContain(`npm i ${RUNTIME_PKG}`);
      expect(html).not.toMatch(/npx @genclass\/runtime (init|login)/);
    }
    // until RUNTIME_ON_NPM reaches it, /start and private dashboards say first that it is not on npm yet
    expect(startPage("n")).toContain("Not on npm yet.");
    expect(startPage("n", { runtimeReady: true })).not.toContain("Not on npm yet.");
    expect(dashboardPage("n", { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null }, { runtimeReady: true })).not.toContain("Not on npm yet.");
  });
});

/** WCAG 2 contrast ratio of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Every page this worker serves, rendered once (account pages with a small made-up account). */
function everyPage(): [string, string][] {
  const project = { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
  const acct = { apps: [{ id: "0123456789abcdef", name: "a" }], current: "0123456789abcdef", email: "ada@example.com" };
  const view = {
    account: { id: "A".repeat(22), email: "ada@example.com", emailVerified: false, google: false, githubLogin: null, created: "2026-10-01T00:00:00.000Z" },
    projects: [],
    passkeys: [],
    web: [],
    cli: [],
    password: null,
    providers: { google: true, github: true },
    dashboards: "plans" as const,
  };
  const providers = { google: true, github: true };
  return [
    ["/start", startPage("n")],
    ["/dashboard", dashboardPage("n", project)],
    ["/account/apps (locked)", dashboardPage("n", project, { account: acct, id: "0123456789abcdef", locked: true })],
    ["/account/apps", dashboardPage("n", project, { account: acct, id: "0123456789abcdef" })],
    ["/login", loginPage("n", { ...providers, next: null })],
    ["/signup", signupPage("n", { ...providers, next: null })],
    ["/login/forgot", forgotPage("n", { contact: "mehar@daybot.ca" })],
    ["/login/passkey", passkeyStepPage("n", { via: "password", who: "ada@example.com", recovery: "mehar@daybot.ca" })],
    ["/login/device", devicePage("n", { signedIn: null, code: "BCDF-GHJK", typed: true, request: null, next: "/login/device?code=BCDF-GHJK", providers })],
    ["/account", accountPage("n", view)],
    ["/account/new", newProjectPage("n", { account: view.account, projects: [] })],
    ["pending", pendingPage("n", { email: "ada@example.com", provider: "google" })],
    ["message", messagePage("n", { title: "T", text: "x", links: [["One", "/a"]] })],
    ["/dashboard/<secret> (locked)", lockedLinkPage("n", { name: "a", signedIn: null, owner: "none", providers })],
  ];
}

/** The pages in the Supabase Studio frame (src/studio.ts); the rest keep genclass.dev's own look. */
const STUDIO = ["/dashboard", "/account/apps (locked)", "/account/apps", "/account", "/account/new"];

/** A token's #RRGGBB value in a page's CSS. */
const tokenOf = (html: string) => (name: string) => {
  const m = new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(html);
  if (!m) throw new Error(`no --${name}`);
  return m[1]!;
};

describe("pages: one dark theme everywhere, genclass.dev's for /start and sign-in, Supabase Studio's for the dashboards", () => {
  it("no page switches palette with the visitor's system theme: no prefers-color-scheme, color-scheme dark, one set of tokens", () => {
    for (const [name, html] of everyPage()) {
      expect(html, name).not.toContain("prefers-color-scheme");
      expect(html, name).toContain("color-scheme:dark;");
      expect(html, name).not.toMatch(/color-scheme:\s*light/);
      // one set of tokens (no second set that could override them)
      expect(html.match(/--paper:/g), name).toHaveLength(1);
      expect(html, name).not.toMatch(/Outfit|Figtree|Geist/);
      // the mark and the name in type; the navy-on-white lockup images are gone
      expect(html, name).not.toContain("lockup-");
      if (STUDIO.includes(name)) {
        // Studio's dark canvas, surface and text; Inter and Source Code Pro
        expect(html, name).toContain('<meta name="theme-color" content="#121212">');
        expect(html, name).toContain("--paper:#121212;--panel:#1f1f1f;--ink:#fafafa;");
        expect(html, name).toContain("https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Source+Code+Pro:wght@400;500&display=swap");
        expect(html, name).toContain('<body class="sb">');
      } else {
        expect(html, name).toContain('<meta name="theme-color" content="#000000">');
        expect(html, name).toContain("--paper:#000000;--panel:#0B0B0A;--ink:#F0F1E9;");
        expect(html, name).toContain("https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap");
      }
    }
    expect(DASH_CSS).toContain(":root{--t1:#3987E5;--t2:#E8552F;--t3:#2AA3C7;--t4:#C98500;--t5:#B964C9;--t0:#88897F;--grid:#262626}");
  });

  it("contrast on both palettes: text at least 4.5:1 on paper, panel and code, inputs' borders and the focus ring at least 3:1", () => {
    const project = { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
    for (const [name, html] of [["site", startPage("n")], ["studio", dashboardPage("n", project)]] as const) {
      const token = tokenOf(html);
      const [paper, panel, code] = [token("paper"), token("panel"), token("code")];
      for (const t of ["ink", "ink2", "ink3", "accent", "warn"]) {
        expect(contrast(token(t), paper), `${name} ${t}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(t), panel), `${name} ${t}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(t), code), `${name} ${t}`).toBeGreaterThanOrEqual(4.5);
      }
      // green and red-orange tints behind their own text (notices, errors, badges)
      expect(contrast(token("accent"), token("accent-t")), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("warn"), token("warn-t")), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("ink3"), token("accent-t")), name).toBeGreaterThanOrEqual(4.5);
      // buttons: their ink on the green fill (and its hover)
      expect(contrast(token("on-green"), token("accent-f")), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token("on-green"), token("green-h")), name).toBeGreaterThanOrEqual(4.5);
      // large green text, the input border and the focus ring
      expect(contrast(token("accent-x"), paper), name).toBeGreaterThanOrEqual(3);
      expect(contrast(token("line"), paper), name).toBeGreaterThanOrEqual(3);
      expect(contrast(token("accent"), paper), name).toBeGreaterThanOrEqual(3);
      // code panels
      expect(contrast(token("codeink"), token("code")), name).toBeGreaterThanOrEqual(4.5);
    }
    // the site's selected segment and tab are paper on ink; Studio's are ink on its raised surface, and its amber on the amber tint
    const site = tokenOf(startPage("n")), studio = tokenOf(dashboardPage("n", project));
    expect(contrast(site("paper"), site("ink"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(studio("ink"), studio("s300"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(studio("amber"), studio("amber-t"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("pages: genclass.dev's palette, buttons, header and focus ring on /start and the sign-in pages", () => {
  const project = { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
  /** HSL hue of a #RRGGBB colour, in degrees. */
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  it("the site's pages carry its tokens, its focus ring and its sticky header; the dashboards Studio's", () => {
    for (const html of [startPage("n"), loginPage("n", { google: false, github: false, next: null })]) {
      // site/src/css/base.css: bone text, the green (text, fills), the red-orange (fills; text), the raised black, the rules
      for (const t of ["--ink:#F0F1E9", "--accent-f:#2FD07F", "--accent:#2FD07F", "--warn-f:#FF5A36", "--warn:#FF6B4A", "--panel:#0B0B0A", "--rule:#30312B", "--rule2:#46463E"]) expect(html).toContain(t);
      expect(html).toContain(":focus-visible{outline:1px solid var(--accent);outline-offset:3px}");
      expect(html).not.toContain("prefers-color-scheme");
      // square corners, as on the site (status dots stay round)
      expect(html).not.toMatch(/border-radius:[1-9]\d*px/);
    }
    expect(startPage("n")).toMatch(/header\.top\{position:sticky;top:0;/);
    expect(startPage("n")).toContain('<a class="logo" href="https://genclass.dev/"><img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a>');
    // Studio: brand #3ecf8e, primary buttons on #006239, borders #2e2e2e, 6px corners, the 48px sticky header
    const dash = dashboardPage("n", project);
    for (const t of ["--accent:#3ecf8e", "--accent-f:#006239", "--rule:#2e2e2e", "--panel:#1f1f1f"]) expect(dash).toContain(t);
    expect(dash).toContain(":focus-visible{outline:2px solid var(--accent);outline-offset:2px}");
    expect(dash).toMatch(/\.sb-top\{position:sticky;top:0;z-index:40;display:flex;align-items:center;height:48px;/);
    expect(dash).toContain(".btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:0 12px;border-radius:6px;");
    expect(dash).toContain('<img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="22" height="22">');
  });

  it("scroll targets clear the sticky headers; one small button size per look; touch targets on coarse pointers", () => {
    expect(startPage("n")).toContain("html:has(header.top){scroll-padding-top:76px}");
    // the 320px header fits: a smaller gap below 361px
    expect(startPage("n")).toContain("@media (max-width:360px){header.top .wrap{gap:10px}}");
    // the site: .btn.sm is 34px (44px on phones); Studio: 26px (40px on touch screens), with no per-place override
    const site = startPage("n") + messagePage("n", { title: "T", text: "x", links: [["One", "/a"]] });
    expect(site).toContain(".btn.sm{min-height:34px;");
    expect(site).toContain("@media (max-width:620px){.btn.sm{min-height:44px}}");
    const dash = dashboardPage("n", project);
    expect(dash).toContain(".btn.sm,.btn.tiny{min-height:26px;padding:0 10px;font-size:12px}");
    expect(dash).toContain("@media (pointer:coarse){.btn,.btn.sm,.btn.tiny{min-height:40px}");
    expect(dash).not.toMatch(/\.btn\.sm\{min-height:(28|30)px/);
    // every #section under Studio's 48px header
    expect(dash).toContain(".sb [id]{scroll-margin-top:64px}");
    expect(startPage("n")).toContain(".tablewrap{overflow-x:auto;padding-left:6px;margin-left:-6px}");
    // a route with a total but no per-type breakdown is drawn in the Other grey, not stale responses' red-orange
    expect(dash).toContain('i0.style.background = "var(--t0)"');
    expect(dash).not.toContain("var(--bar3)");
  });

  it("the main action of a page is the site's green button; the header ends in its green button", () => {
    expect(startPage("n")).toContain('<button class="btn green" id="go" type="submit">Get a token</button>');
    expect(startPage("n")).toContain('<a class="btn" href="/start">Get a token</a>');
    // sign-in: the email and password form's button is the green one, whatever is configured; a passkey is a small link
    const none = loginPage("n", { google: false, github: false, next: null });
    expect(none).toContain('<button class="btn prov green" type="submit"><span>Sign in</span></button>');
    expect(none).toContain('<p class="alt"><button class="lnk" id="pk" type="button"><span>Use a passkey</span></button></p>');
    expect(none).not.toContain('class="btn prov green" id="pk"');
    expect(none).not.toContain('<div class="or">');
    // with Google offered it leads (the paper button), then "or", the form, and the small links
    const g = loginPage("n", { google: true, github: false, next: null });
    expect(g.indexOf("Continue with Google")).toBeLessThan(g.indexOf('<div class="or">or</div>'));
    expect(g.indexOf('<div class="or">or</div>')).toBeLessThan(g.indexOf('id="pwf"'));
    expect(g.indexOf('id="pwf"')).toBeLessThan(g.indexOf("Use a passkey"));
    expect(g).not.toContain("Sign in with a passkey");
    expect(signupPage("n", { google: false, github: false, next: null })).toContain('<button class="btn prov green" type="submit"><span>Create account</span></button>');
    const msg = messagePage("n", { title: "T", text: "x", links: [["One", "/a"], ["Two", "/b"]] });
    expect(msg).toContain('<a class="btn green" href="/a">One</a>');
    expect(msg).toContain('<a class="btn ghost" href="/b">Two</a>');
  });

  it("chart series: the validated slots, dark only, none of them green (green is the frame's brand and what GenClass did)", () => {
    const dark = /:root\{--t1:(#\w{6});--t2:(#\w{6});--t3:(#\w{6});--t4:(#\w{6});--t5:(#\w{6});/.exec(DASH_CSS)!.slice(1);
    // validate_palette.js --mode dark passes on these, in this order (pages.ts, the chart colours comment)
    expect(dark).toEqual(["#3987E5", "#E8552F", "#2AA3C7", "#C98500", "#B964C9"]);
    expect(DASH_CSS.match(/--t1:/g)).toHaveLength(1);
    for (const c of dark) expect(hue(c) < 75 || hue(c) > 170, c).toBe(true);
    // every slot is a visible mark on the site's black and on Studio's canvas and surface
    for (const c of dark) for (const bg of ["#000000", "#0B0B0A", "#121212", "#1f1f1f"]) expect(contrast(c, bg), `${c} on ${bg}`).toBeGreaterThanOrEqual(3);
    expect(hue("#2FD07F")).toBeGreaterThan(75); // the check itself would catch the brand greens
    expect(hue("#3ecf8e")).toBeGreaterThan(75);
  });
});

describe("pages: the sign-in pages sit on genclass.dev's self-healing sphere, as /admin's sign-in does", () => {
  const MESH = ["/login", "/signup", "/login/forgot", "/login/passkey", "/login/device", "pending", "message", "/dashboard/<secret> (locked)"];

  it("the sign-in and message pages load the site's mesh under the page's nonce; dashboards, /start and /account do not", () => {
    expect(MESH_SCRIPT).toBe("https://genclass.dev/signin-mesh.js?v=2");
    for (const [name, html] of everyPage()) {
      const on = MESH.includes(name);
      expect(html.includes('<body class="mesh">'), name).toBe(on);
      expect(html.includes('<canvas data-mesh aria-hidden="true"></canvas>'), name).toBe(on);
      expect(html.includes(`<script nonce="n" src="${MESH_SCRIPT}" defer></script>`), name).toBe(on);
      // the old still lattice is gone
      expect(html, name).not.toContain('class="lat"');
    }
    // the column on the left, the sphere on the right; one column over a dimmed sphere on a phone
    const login = loginPage("n", { google: true, github: true, next: null });
    expect(login).toContain("body.mesh main.wrap{max-width:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,40%) 1fr;");
    expect(login).toContain("@media (max-width:900px){body.mesh main.wrap{grid-template-columns:1fr}");
  });

  it("the CSP allows the site's fonts and nothing more for scripts: the mesh loads by nonce", () => {
    const csp = securityHeaders("n")["content-security-policy"]!;
    expect(csp).toContain("script-src 'nonce-n';");
    expect(csp).toContain("style-src 'nonce-n' https://api.fontshare.com https://fonts.googleapis.com;");
    expect(csp).toContain("font-src https://cdn.fontshare.com https://fonts.gstatic.com;");
  });
});

describe("dashboard page: interaction analytics (docs/runtime/ANALYTICS.md section 3)", () => {
  it("the visitors section: views, time on page, clicks, rage and dead clicks, pages with scroll reach, element tables", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, hidden, heads, close } = await render(st);
    expect(hidden("visits")).toBe(false);
    expect(hidden("clicks")).toBe(false);
    expect(hidden("nav-visits")).toBe(false);
    expect(text("#c-visits")).toBe(nf.format(st.totals.ix_views!));
    expect(text("#ixsum")).toContain("Page views");
    expect(text("#ixsum")).toContain("Unique visitors are not counted");
    expect(heads("#ixpages")).toEqual(["Page", "Views", "Time on page", "Read half", "Read to the end"]);
    expect(doc.querySelectorAll("#ixpages tbody tr").length).toBe(Math.min(12, st.breakdowns.ix_views!.length));
    expect(text("#ixclicks")).toContain("button#pay");
    expect(text("#ixflags")).toContain("button.promo-apply (dead)");
    expect(text("#ixflags")).toContain("button#pay (rage)");
    await close();
  });

  it("how visitors move (ANALYTICS.md section 11): entries, steps, back and forward, exits; paths, page to page, per page", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, hidden, heads, close } = await render(st);
    expect(hidden("moves")).toBe(false);
    for (const t of ["Page loads", "Steps between pages", "Back and forward", "Page load ends", "within one page load"]) expect(text("#ixmoves")).toContain(t);
    expect(heads("#ixpaths")).toEqual(["Path (first 5 pages)", "Page loads", ""]);
    expect(text("#ixpaths")).toContain("/ > /products > /products/:id");
    expect(heads("#ixsteps")).toEqual(["From", "To", "Steps", "Time before the step"]);
    expect(doc.querySelectorAll("#ixsteps tbody tr").length).toBe(Math.min(12, st.breakdowns.ix_nav!.length));
    expect(heads("#ixexits")).toEqual(["Page", "Page loads started", "Page loads ended", "End rate", "Back/forward", "First interaction", "Time to it"]);
    expect(text("#ixexits")).toContain('[data-genclass-name="add-to-cart"]');
    expect(doc.querySelector(".dfoot")!.textContent).toContain("the path between pages");
    await close();
  });

  it("the navigation section stays hidden for a runtime that sends no navigation fields", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of ["ix_entry", "ix_exit", "ix_nav", "ix_nav_ms", "ix_arrive", "ix_first", "ix_first_n", "ix_first_ms", "ix_path"]) delete st.breakdowns[k];
    delete st.totals.ix_entry;
    delete st.totals.ix_exit;
    const { hidden, close } = await render(st);
    expect(hidden("visits")).toBe(false);
    expect(hidden("moves")).toBe(true);
    await close();
  });

  it("an app without analytics: the Visitors view is one big copy-prompt button, the other sections hidden", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of Object.keys(st.breakdowns)) if (k.startsWith("ix_")) delete st.breakdowns[k];
    for (const k of Object.keys(st.totals)) if (k.startsWith("ix_")) delete st.totals[k];
    st.visits = { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] };
    st.funnels = [];
    const { doc, hidden, text, close } = await render(st);
    expect(hidden("visits")).toBe(false);
    expect(hidden("nav-visits")).toBe(false);
    expect(text("#c-visits")).toBe("");
    expect(hidden("ixsetup")).toBe(false);
    for (const id of ["ixsum", "ixpages", "clicks", "ix-sources", "ix-devices", "ix-sessions", "ix-entry", "ix-funnels", "moves"]) expect(hidden(id), id).toBe(true);
    // the button comes first, then at most two lines
    const box = doc.querySelector("#ixsetup .cprompt")!;
    const btn = box.firstElementChild as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toBe("btn green xl");
    expect(btn.textContent).toBe("Copy the prompt for your coding agent");
    expect(box.children).toHaveLength(3);
    expect(box.querySelectorAll("p.cp-sub br")).toHaveLength(0);
    expect(text("#ixsetup .cp-sub").length).toBeLessThanOrEqual(160);
    // under the button: the runtime analytics need and the install line (0.2.x ignores the option)
    expect(text("#ixver")).toBe(`They need @genclass/runtime ${ANALYTICS_RUNTIME} or later (npm install ${RUNTIME_PKG}); earlier versions ignore analytics: true without a word.`);
    expect(ANALYTICS_RUNTIME).toBe("0.3.0-beta.1");
    expect(doc.querySelector(".dfoot")!.textContent).toContain("never its text");
    expect(doc.querySelector(".dfoot")!.textContent).toContain("No text from your pages, no IP addresses and no user agents are stored.");
    // the third child is the fallback: the prompt in a hidden textarea, shown selected when the clipboard refuses
    const ta = box.children[2] as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.hidden).toBe(true);
    expect(ta.value).toBe(btn.getAttribute("data-copy"));
    await close();
  });

  it("the copied prompt: install @beta, analytics on with this app's token in each kind of config, consent, dev server, where to look", () => {
    const p = analyticsPrompt("gc_TestToken0123456789abc", "this app's GenClass dashboard, under Visitors (https://genclass.dev/account/apps/0123456789abcdef#visits)");
    expect(p).toContain(`npm install ${RUNTIME_PKG}`);
    expect(p).toContain("0.2.x has no analytics");
    expect(p).toContain(`npx ${RUNTIME_PKG} init`);
    expect(p).toContain('GenClass.init({ token: "gc_TestToken0123456789abc", analytics: true })');
    expect(p).toContain("genclass.config.ts");
    expect(p).toContain('content="token=gc_TestToken0123456789abc, analytics=on"');
    expect(p).toContain('data-analytics="on"');
    expect(p).toContain("GenClass.runtime?.analytics?.start()");
    expect(p).toContain("Run the dev server once");
    expect(p).toContain("https://genclass.dev/account/apps/0123456789abcdef#visits");
    expect(p).not.toContain("telemetry: { endpoint");
    expect(analyticsPrompt("gc_x", "x", "https://c.example/v1/events")).toContain('Keep telemetry: { endpoint: "https://c.example/v1/events" }');
  });

  it("the button copies the prompt and reads Copied for two seconds (the page's copy code)", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of Object.keys(st.totals)) if (k.startsWith("ix_")) delete st.totals[k];
    for (const k of Object.keys(st.breakdowns)) if (k.startsWith("ix_")) delete st.breakdowns[k];
    const html = dashboardPage("NONCE", { name: st.name, token: st.token, created: st.created, lastEvent: st.lastEvent });
    const { body, script } = page(html);
    const win = new Window({ url: "https://genclass.dev/dashboard/sample" });
    const doc = win.document;
    doc.body.innerHTML = body;
    const copied: string[] = [];
    const timers: [() => void, number][] = [];
    const nav = { clipboard: { writeText: async (t: string) => void copied.push(t) } };
    const fetch = async () => ({ ok: true, status: 200, json: async () => st });
    const run = new Function("window", "document", "location", "localStorage", "fetch", "setInterval", "navigator", "IntersectionObserver", "setTimeout", "clearTimeout", script);
    run(win, doc, win.location, win.localStorage, fetch, () => 0, nav, class { observe() {} }, (f: () => void, ms: number) => timers.push([f, ms]), () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    const btn = doc.querySelector("#ixsetup button") as unknown as HTMLButtonElement;
    btn.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(copied).toEqual([analyticsPrompt(st.token, "this app's GenClass dashboard (the private link I opened it from), under Visitors")]);
    expect(btn.textContent).toBe("Copied");
    const t = timers.find(([, ms]) => ms === 2000)!;
    t[0]();
    expect(btn.textContent).toBe("Copy the prompt for your coding agent");
    await win.happyDOM.close();
  });
});

describe("dashboard page: visitors, sources, devices, sessions, entry and exit pages, funnels (ANALYTICS.md section 3.1)", () => {
  it("every section renders from the sample's stats", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, hidden, heads, close } = await render(st);
    expect(hidden("ixsetup")).toBe(true);
    for (const id of ["ix-sources", "ix-devices", "ix-sessions", "ix-entry", "ix-funnels", "clicks"]) expect(hidden(id), id).toBe(false);
    expect(heads("#ixref")).toEqual(["Source", "Visits", "Share", ""]);
    expect(text("#ixref")).toContain("google.com");
    expect(text("#ixref")).toContain("Direct or unknown");
    expect(text("#ixutm")).toContain("Source: newsletter");
    expect(text("#ixutm")).toContain("Campaign: autumn-sale");
    expect([...doc.querySelectorAll("#ixdev h2")].map((h) => h.textContent)).toEqual(["Device", "Browser", "Operating system", "Country", "New or returning"]);
    expect(text("#ixdev")).toContain("desktop");
    expect(text("#ixdev")).toContain("(US)");
    expect(text("#ixdev")).toContain("Returning");
    expect(text("#ixsess")).toContain("Pages per visit");
    expect(text("#ixsess")).toContain(String(Math.round((10 * st.visits.pages) / st.visits.sessions) / 10));
    expect(text("#ixsess")).toContain("One-page visits");
    expect(doc.querySelectorAll("#ixsess svg rect").length).toBeGreaterThan(0);
    expect(heads("#ixentry")).toEqual(["Page", "Visits", "Share", ""]);
    expect(doc.querySelector("#ixentry tbody td")!.textContent).toBe("/");
    expect(doc.querySelector("#ixexit tbody td")!.textContent).toBe("/products/:id");
    expect([...doc.querySelectorAll("#ixfun h3")].map((h) => h.textContent)).toEqual(["Checkout", "Search to product"]);
    expect(heads("#ixfun > .fun:first-child")).toEqual(["Step", "Page", "Visits", "Of step 1", "From the step before", ""]);
    expect(doc.querySelectorAll("#ixfun .fun:first-child tbody tr")).toHaveLength(3);
    expect(text("#ixfun")).toContain("Most visits are lost between step 1 and step 2");
    expect(text("#ixfunedit")).toBe("Edit funnels");
    expect(text("#ixsum")).toContain("Unique visitors are not counted");
    await close();
  });

  it("edit funnels: the form saves the whole list with PUT to this dashboard's funnels URL and reloads the stats", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, urls, close } = await render(st);
    (doc.querySelector("#ixfunedit button") as unknown as HTMLButtonElement).click();
    const fe = doc.querySelectorAll("#ixfunedit .fe");
    expect(fe).toHaveLength(2);
    expect((fe[0]!.querySelector("textarea") as unknown as HTMLTextAreaElement).value).toBe("/products/:id\n/cart\n/checkout");
    (fe[1]!.querySelector("button") as unknown as HTMLButtonElement).click(); // remove the second
    (doc.querySelector("#ixfunedit form") as unknown as HTMLFormElement).requestSubmit();
    await new Promise((r) => setTimeout(r, 20));
    expect(urls).toContain("/api/projects/sample/funnels");
    await close();
  });

  it("an app sending page views from a runtime without visits: the sessions section says to update; sources stay hidden", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of ["ix_ref", "ix_utm_source", "ix_utm_medium", "ix_utm_campaign", "ix_device", "ix_browser", "ix_os", "ix_country", "ix_returning"]) delete st.breakdowns[k];
    delete st.totals.ix_sessions;
    st.visits = { sessions: 0, pages: 0, bounces: 0, entry: [], exit: [] };
    const { hidden, text, close } = await render(st);
    expect(hidden("ix-sessions")).toBe(false);
    expect(text("#ixsess")).toContain(`need the newest ${RUNTIME_PKG}`);
    for (const id of ["ix-sources", "ix-devices", "ix-entry"]) expect(hidden(id), id).toBe(true);
    expect(hidden("ix-funnels")).toBe(false);
    await close();
  });

  it("account mode: the Connect panel has the same big button, first in its analytics block, with the account link", async () => {
    const account = { apps: [{ id: "0123456789abcdef", name: "Shop" }], current: "0123456789abcdef", email: "dev@example.com" };
    const html = dashboardPage("n", { name: "Shop", token: "gc_TestToken0123456789abc", created: "", lastEvent: null }, { account, id: "0123456789abcdef", origin: "https://genclass.dev" });
    const panel = /<section class="connect[\s\S]*?<\/section>/.exec(html)![0];
    const block = /<div class="cana">([\s\S]*?)<\/div><\/div>/.exec(panel)![1]!;
    expect(block).toMatch(/^<div class="eb">Visitor analytics<\/div><div class="cprompt"><button class="btn green xl" type="button" data-copy="/);
    expect(block).toContain("Copy the prompt for your coding agent</button>");
    expect(block).toContain(esc("https://genclass.dev/account/apps/0123456789abcdef#visits"));
    expect(html).toContain('"funnelsUrl":"/api/account/projects/0123456789abcdef/funnels"');
  });
});

describe("dashboard page: the Visitors empty state names the app's older runtime (docs/runtime/ANALYTICS.md section 4.1)", () => {
  it("lists the versions older than the first with analytics, not the newer ones", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of Object.keys(st.breakdowns)) if (k.startsWith("ix_")) delete st.breakdowns[k];
    for (const k of Object.keys(st.totals)) if (k.startsWith("ix_")) delete st.totals[k];
    st.breakdowns.runtime = [{ key: "0.2.2", count: 5 }, { key: "0.3.0-beta.0", count: 3 }, { key: "0.3.0-beta.1", count: 2 }, { key: "0.3.0", count: 1 }, { key: "(unknown)", count: 1 }];
    const { text, close } = await render(st);
    expect(text("#ixold")).toBe("This app sends from @genclass/runtime 0.2.2, 0.3.0-beta.0, which has no analytics.");
    await close();
  });
});

describe("dashboard page: the closed loop (Fig. 3)", () => {
  it("draws this app's problems, one agent step each, the shared fix, prove and ship, and observe with the deltas", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, close } = await render(st);
    expect(text('.snav a[href="#loop"]')).toBe("Closed loop");
    expect(doc.getElementById("loop")!.getAttribute("data-v")).toBe("loop");
    const kinds = st.breakdowns.detect_diagnosis!.filter((x) => x.key !== "expected").slice(0, 5).map((x) => x.key);
    const problems = [...doc.querySelectorAll('#loopsvg rect[data-s="problem"]')].map((r) => r.getAttribute("data-k"));
    expect(problems).toEqual(kinds);
    const agents = [...doc.querySelectorAll('#loopsvg rect[data-s="agent"]')].map((r) => r.getAttribute("data-k"));
    expect(agents).toEqual(kinds);
    for (const s of ["fix", "prove", "ship", "observe"]) expect(doc.querySelector(`#loopsvg rect[data-s="${s}"]`)).not.toBeNull();
    expect(doc.querySelector('#loopsvg rect[data-s="ship"]')!.classList.contains("gate")).toBe(true);
    const svgText = text("#loopsvg");
    expect(svgText).toContain("Stale responses: ");
    expect(svgText).toContain("genclass_replay");
    expect(svgText).toContain(`${nf.format(st.totals.sessions!)} page loads watched`);
    expect(svgText).toMatch(/Problems (down|up|unchanged)/);
    expect(svgText).toContain("a person decides");
    expect(text("#loop-foot")).toContain("@genclass/mcp");
    // the sample's agent reports: the stale-response row names f3 as proven, the double-submit row f7 as reproduced and tested
    expect(doc.querySelector('#loopsvg rect[data-s="problem"][data-k="stale"]')!.getAttribute("data-agent")).toBe("f3");
    expect(svgText).toContain("Agent: f3 on /search reproduced, test");
    expect(svgText).toContain("fix proven");
    expect(doc.querySelector('#loopsvg rect[data-s="problem"][data-k="duplicate"]')!.getAttribute("data-agent")).toBe("f7");
    expect(svgText).toContain("Agent: f7 on /checkout: found");
    expect(svgText).toContain("replay reproduced");
    expect(svgText).toContain("Last fix proven: f3 on /search");
    expect(svgText).toContain("Your agent wrote 2 regression tests");
    expect(text("#loop-foot")).toContain("Your agent reported 3 findings in this period");
    // every problem row points at its agent step, every agent step at Fix, Fix at Prove, Prove at Ship, Ship back to Observe
    expect(doc.querySelectorAll("#loopsvg path.edge").length).toBe(kinds.length * 2 + 4);
    close();
  });

  it("with nothing found, the flow says so and still shows the shared chain", async () => {
    const st = sampleStats("7d", NOW);
    st.totals.detections = 0; st.totals.possible = 0; st.breakdowns.detect_diagnosis = []; st.breakdowns.detect_issue = []; st.breakdowns.detect_route = []; st.recent = [];
    st.previous = { sessions: 0, detections: 0, acted: 0, ix_views: 0 };
    const { doc, text, close } = await render(st);
    expect(doc.querySelector('#loopsvg rect[data-s="problem"]')!.getAttribute("data-k")).toBe("none");
    expect(text("#loopsvg")).toContain("Nothing broke in this period");
    expect(text("#loopsvg")).toContain("Nothing to compare with yet.");
    expect(doc.querySelectorAll('#loopsvg rect[data-s="fix"], #loopsvg rect[data-s="prove"], #loopsvg rect[data-s="ship"]').length).toBe(3);
    close();
  });

  it("without agent reports the rows carry no agent line and the foot says reporting is off by default", async () => {
    const st = sampleStats("7d", NOW);
    st.agent = { findings: [], counts: { found: 0, reproduced: 0, tested: 0, proven: 0 }, stages: { found: 0, explained: 0, reproduced: 0, fixed: 0, closed: 0, open: 0, continued: 0 }, log: [], last: null };
    const { doc, text, hidden, close } = await render(st);
    expect([...doc.querySelectorAll('#loopsvg rect[data-s="problem"]')].every((r) => r.getAttribute("data-agent") === "")).toBe(true);
    expect(text("#loopsvg")).not.toContain("Agent:");
    expect(text("#loop-foot")).toContain("No agent has reported on this app");
    expect(text("#loop-foot")).toContain("GENCLASS_REPORT");
    // the stages show dashes, not zeros, and say reporting is off; the log is empty with the same hint
    expect([...doc.querySelectorAll("#loopstages rect[data-stage]")].map((r) => r.getAttribute("data-n"))).toEqual(["", "", "", ""]);
    expect(doc.querySelectorAll("#loopstages .nn.off").length).toBe(4);
    expect(text("#loopstages")).toContain("reporting is off (GENCLASS_REPORT)");
    expect(doc.querySelectorAll("#agentlog tr").length).toBe(0);
    expect(hidden("agentlog0")).toBe(false);
    expect(text("#agentlog0")).toContain("GENCLASS_REPORT");
    close();
  });

  it("the stages (Fig. 3): every issue's path with the period's counts, the round-again edge and the loop back to production", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, close } = await render(st);
    expect(text("#loop-h")).toBe("Closed-loop development");
    const nodes = [...doc.querySelectorAll("#loopstages rect[data-stage]")];
    expect(nodes.map((r) => r.getAttribute("data-stage"))).toEqual(["found", "reproduced", "fixed", "closed"]);
    expect(nodes.map((r) => Number(r.getAttribute("data-n")))).toEqual([st.agent.stages.found, st.agent.stages.reproduced, st.agent.stages.fixed, st.agent.stages.closed]);
    expect(doc.querySelector('#loopstages rect[data-stage="closed"]')!.classList.contains("closed")).toBe(true);
    const t = text("#loopstages");
    for (const s of ["Issue found", "Reproduced", "Fix proven", "Closed", "replay", "fix, replay", "write test", "genclass_replay", "handed to the agent.", "A person ships."]) expect(t).toContain(s);
    expect(t).toContain(`still reproduces: round again (${st.agent.stages.continued})`);
    expect(t).toContain(`production is watched again · ${st.agent.stages.open} issues open now`);
    // three forward edges, the round-again edge and the loop edge, the two back edges dashed
    expect(doc.querySelectorAll("#loopstages path.edge").length).toBe(5);
    expect(doc.querySelector('#loopstages path[data-edge="continue"]')!.classList.contains("dim")).toBe(true);
    expect(doc.querySelector('#loopstages path[data-edge="loop"]')!.classList.contains("dim")).toBe(true);
    close();
  });

  it("the log (Table 15): the agent's steps newest first, each with its finding, page and outcome; never page text", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, hidden, close } = await render(st);
    const rows = [...doc.querySelectorAll("#agentlog tr")];
    expect(rows.length).toBe(st.agent.log.length);
    expect(rows.map((r) => r.getAttribute("data-t"))).toEqual(st.agent.log.map((e) => e.t));
    expect(hidden("agentlog0")).toBe(true);
    const row = (i: number) => [...rows[i]!.children].map((c) => c.textContent!.replace(/\s+/g, " ").trim());
    expect(row(0).slice(1)).toEqual(["Found", "f9 · error", "/products/:id", "open"]);
    expect(row(1).slice(1)).toEqual(["Replay", "f3 · stale response", "/search", "not reproduced: the fix holds"]);
    expect(rows[1]!.children[4]!.className).toBe("did-a");
    expect(row(2).slice(1)).toEqual(["Replay armed", "f3 · stale response", "/search", "waiting for the next page load"]);
    expect(row(3).slice(1)).toEqual(["Test written", "f7 · duplicate request", "/checkout", "guards the fix"]);
    expect(row(4).slice(1)).toEqual(["Evidence read", "f7 · duplicate request", "/checkout", "genclass_explain: the evidence in causal order"]);
    expect(row(5).slice(1)).toEqual(["Replay", "f7 · duplicate request", "/checkout", "reproduced: the bug is still there"]);
    expect(row(10).slice(1)).toEqual(["Explore", "–", "/search", "8 page loads compared, 1 race found"]);
    expect(rows[0]!.children[0]!.getAttribute("title")).toBe(st.agent.log[0]!.at);
    expect(text("#agentlog")).not.toMatch(/overwrote|q=rea|results/);
    // a clear shows what was cleared on the developer's machine
    st.agent.log = [{ at: st.agent.log[0]!.at, t: "cleared", id: null, kind: null, route: null, reproduced: null, runs: null, races: null, what: "runs" }];
    const r2 = await render(st);
    expect([...r2.doc.querySelectorAll("#agentlog tr")].length).toBe(1);
    expect(r2.text("#agentlog")).toContain("runs cleared on the developer's machine");
    r2.close();
    close();
  });
});

describe("dashboard page: the Supabase Studio frame (src/studio.ts): header, rail, product menus, views", () => {
  const account = { apps: [{ id: "0123456789abcdef", name: "Shop" }, { id: "fedcba9876543210", name: "Blog" }], current: "0123456789abcdef", email: "dev@example.com", plan: "Free" };

  it("the header: the organization (named after the account, with its plan), the project switcher, Connect, search, help, the account", async () => {
    const r = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    expect(orgName("dev@example.com")).toBe("dev's Org");
    expect(orgName("@octo")).toBe("octo's Org");
    expect(orgName(null)).toBe("Personal");
    expect(r.text(".sb-org .nm")).toBe("dev's Org");
    expect(r.text(".sb-org .bdg")).toBe("Free");
    // the project switcher lists every project in the account, then All projects and New project
    const sw = [...r.doc.querySelectorAll(".sb-crumbs .dd:not(.sb-org) .dd-m a")].map((a) => a.getAttribute("href"));
    expect(sw).toEqual(["/account/apps/0123456789abcdef", "/account/apps/fedcba9876543210", "/account", "/account/new"]);
    expect(r.doc.querySelector('.sb-crumbs a[href="/account/apps/0123456789abcdef"]')!.getAttribute("aria-current")).toBe("true");
    expect(r.doc.getElementById("hconnect")!.getAttribute("data-open")).toBe("m-connect");
    expect(r.doc.querySelector(".sb-search")!.getAttribute("data-open")).toBe("m-cmd");
    expect(r.text(".sb-right .who")).toContain("dev@example.com");
    expect(r.doc.querySelector('.sb-right form[action="/logout"]')).not.toBeNull();
    // a private link: no switchers, a Sign in button
    const p = await render(sampleStats("7d", NOW));
    expect(p.text(".sb-org .nm")).toBe("Private link");
    expect(p.doc.querySelector('.sb-right a[href="/login"]')!.textContent).toBe("Sign in");
    await r.close();
    await p.close();
  });

  it("the rail in Studio's order; its links switch views, with the view's title and its product menu", async () => {
    const r = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    expect([...r.doc.querySelectorAll(".snav a .lbl")].map((x) => x.textContent)).toEqual(
      ["Project overview", "Problems", "Pages", "Actions", "Activity", "Visitors", "Health", "MCP", "Closed loop", "Project Settings"],
    );
    const vh = (sel: string) => r.doc.querySelector(sel)!.classList.contains("vh");
    // the overview first: the name, its parts; no product menu
    expect(vh("#pname")).toBe(false);
    expect(vh("#usage")).toBe(false);
    expect(r.hidden("vtitle")).toBe(true);
    expect([...r.doc.querySelectorAll(".sb-pm")].every((m) => m.classList.contains("vh"))).toBe(true);
    // Problems: its view, its title, its product menu; the rail marks it
    (r.doc.querySelector('.snav a[href="#found"]') as unknown as HTMLElement).click();
    expect(vh("#found")).toBe(false);
    expect(vh("#usage")).toBe(true);
    expect(vh("#pname")).toBe(true);
    expect(r.text("#vtitle")).toBe("Problems");
    expect(vh('.sb-pm[aria-label="Problems"]')).toBe(false);
    expect(vh('.sb-pm[aria-label="Visitors"]')).toBe(true);
    expect(r.doc.querySelector('.snav a[href="#found"]')!.getAttribute("aria-current")).toBe("true");
    expect(r.doc.querySelector('.snav a[href="#top"]')!.getAttribute("aria-current")).toBe("false");
    // Project Settings: the key, the agent access; the tools of the data views hide
    (r.doc.querySelector('.snav a[href="#settings"]') as unknown as HTMLElement).click();
    expect(vh("#settings")).toBe(false);
    expect(vh(".tools")).toBe(true);
    expect(r.text("#skey")).toBe(sampleStats("7d", NOW).token);
    expect(vh('.sb-pm[aria-label="Project Settings"]')).toBe(false);
    await r.close();
  });

  it("Connect: Studio's dialog, from the header or #connect, with its tabs; the Framework tab's prompt installs with this key", async () => {
    const r = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    const dlg = r.doc.getElementById("m-connect")!;
    expect(dlg.classList.contains("open")).toBe(false);
    (r.doc.getElementById("hconnect") as unknown as HTMLElement).click();
    expect(dlg.classList.contains("open")).toBe(true);
    expect([...dlg.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual(["Framework", "API Keys", "MCP", "Analytics"]);
    expect(r.doc.getElementById("tp-fw")!.classList.contains("on")).toBe(true);
    (r.doc.getElementById("tab-mcp") as unknown as HTMLElement).click();
    expect(r.doc.getElementById("tp-mcp")!.classList.contains("on")).toBe(true);
    expect(r.doc.getElementById("tp-fw")!.classList.contains("on")).toBe(false);
    expect(r.doc.querySelector("#tp-mcp [data-mcp] pre")!.textContent).toContain(`npx -y ${MCP_PKG}`);
    r.doc.dispatchEvent(new (r.doc.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape" }));
    expect(dlg.classList.contains("open")).toBe(false);
    await r.close();
    // #connect opens it over the overview
    const h = await render(sampleStats("7d", NOW), {}, { url: "https://genclass.dev/dashboard/sample#connect" });
    expect(h.doc.getElementById("m-connect")!.classList.contains("open")).toBe(true);
    expect(h.doc.getElementById("pname")!.classList.contains("vh")).toBe(false);
    await h.close();
    const p = installPrompt("gc_TestToken0123456789abc");
    expect(p).toContain(`npm install ${RUNTIME_PKG}`);
    expect(p).toContain('GenClass.init({ token: "gc_TestToken0123456789abc" });');
    expect(p).toContain(`<script src="${CDN_SCRIPT}" data-token="gc_TestToken0123456789abc" data-devtools="local"></script>`);
    expect(p).toContain("observe");
    expect(p).toContain("Run the dev server");
    // the whole flow from one paste: the state, the agent link, the MCP server in the agent, the status check
    expect(p).toContain("rt.atom(");
    expect(p).toContain("rt.guard(");
    expect(p).toContain('import { connectAgent } from "@genclass/runtime/agent"; if (import.meta.env.DEV) connectAgent(rt);');
    expect(p).toContain(`npx -y ${MCP_PKG} init`);
    expect(p).toContain('import("@genclass/runtime/devtools").then((d) => d.mountDevtools(rt))');
    expect(p).toContain("genclass_status should then list the page");
    expect(p).toContain(`npx ${RUNTIME_PKG} init --token gc_TestToken0123456789abc --yes`);
    expect(installPrompt("gc_x", "https://c.example/v1/events")).toContain('GenClass.init({ token: "gc_x", telemetry: { endpoint: "https://c.example/v1/events" } });');
    // a site with no build step gets everything from the prompt alone: the script tag, the agent link from the CDN on local hosts
    expect(p).toContain("A site with no build step (plain HTML pages, no bundler) installs nothing");
    expect(p).toContain(`import("${CDN_SCRIPT}/dist/agent.js")`);
    expect(p).toContain('["localhost", "127.0.0.1"].includes(location.hostname)');
    // values one response writes together go in one atom
    expect(p).toContain('rt.atom("search", { query: "", results: [] })');
    expect(p).not.toContain("Deploy it");
  });

  it("Connect prompt choices: guard (and eager), the badge on every host, the agent link with the Loop view, deploy", () => {
    const t = "gc_TestToken0123456789abc";
    const g = installPrompt(t, null, { guard: true, eager: true, badge: true, deploy: true, agentLink: "https://genclass.dev/dashboard/LINK" });
    expect(g).toContain(`const rt = GenClass.init({ token: "${t}", mode: "guard", aggressiveness: "eager", visual: { on: true, fix: true } });`);
    expect(g).toContain('<script>window.GENCLASS_CONFIG = { aggressiveness: "eager" };</script>');
    expect(g).toContain(`<script src="${CDN_SCRIPT}" data-token="${t}" data-mode="guard" data-visual="fix" data-devtools></script>`);
    expect(g).toContain("3. Mode guard, as chosen on the dashboard");
    expect(g).toContain("Mount the devtools overlay on every host, the deployed site too");
    expect(g).toContain(`claude mcp add genclass -e GENCLASS_DASHBOARD=https://genclass.dev/dashboard/LINK -e GENCLASS_REPORT=on -- npx -y ${MCP_PKG}`);
    expect(g).not.toContain(`npx -y ${MCP_PKG} init`);
    expect(g).toContain("8. Deploy it, as chosen on the dashboard");
    expect(g).toContain("9. Tell me what you changed and where it is deployed");
    // eager only with guard
    expect(installPrompt(t, null, { eager: true })).not.toContain("eager");
  });

  it("Project overview: usage cards from the period's totals, the three problems that need attention first, each with its prompt", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st);
    expect([...r.doc.querySelectorAll("#usage .ucard .k")].map((x) => x.textContent)).toEqual(["Page loads", "Problems found", "Stepped in", "Visits"]);
    expect([...r.doc.querySelectorAll("#usage .ucard .v")].map((x) => x.textContent)).toEqual(
      [st.totals.sessions, problems(st), st.totals.interventions, st.totals.ix_sessions].map((n) => nf.format(n!)),
    );
    expect(r.text("#ulead")).toBe(nf.format(st.totals.sessions!));
    // the model's kinds and the measured checks' kinds
    const kinds = [...st.breakdowns.detect_diagnosis!.filter((x) => x.key !== "expected"), ...st.breakdowns.check_kind!];
    expect(r.doc.querySelectorAll("#advisor article")).toHaveLength(3);
    expect(r.text("#advn")).toBe(`${kinds.length} kinds of problems need attention`);
    expect(r.doc.querySelectorAll("#advisor [data-copy]")).toHaveLength(3);
    // every problem card copies a prompt: what, where, the usual fix, and the MCP steps that prove the fix
    const prompts = [...r.doc.querySelectorAll("#issues .find [data-copy]")].map((b) => b.getAttribute("data-copy")!);
    expect(prompts).toHaveLength(kinds.length);
    const dup = prompts.find((x) => x.includes("double submits"))!;
    expect(dup).toContain("Fix a problem GenClass found in production in this web app (Sample storefront (simulated data)): double submits");
    expect(dup).toContain("in the last 7 days, on /checkout (");
    expect(dup).toContain("How it is usually fixed: Disable the control while the request is in flight");
    expect(dup).toContain(MCP_PKG);
    expect(dup).toContain("genclass_explain");
    expect(dup).toContain("genclass_replay");
    expect(dup).toContain("not reproduced");
    await r.close();
  });

  it("MCP: a private link is its own agent link; the configuration and the prompt name it, and Claude Code keeps it out of .mcp.json", async () => {
    const secret = "A".repeat(32);
    const r = await render(sampleStats("7d", NOW), {}, { url: `https://genclass.dev/dashboard/${secret}#mcp` });
    expect(r.doc.getElementById("mcp")!.classList.contains("vh")).toBe(false);
    expect(r.text("#vtitle")).toBe("MCP");
    const link = `https://genclass.dev/dashboard/${secret}`;
    const view = r.doc.querySelector("#mcp [data-mcp]")!;
    expect(view.querySelector("pre")!.textContent).toBe(`claude mcp add genclass -e GENCLASS_DASHBOARD=${link} -- npx -y ${MCP_PKG}`);
    expect(view.querySelector(".where")!.textContent).toContain("out of .mcp.json");
    const prompt = [...view.querySelectorAll("[data-copy]")].find((b) => b.textContent === "Copy prompt")!.getAttribute("data-copy")!;
    expect(prompt).toContain(`GENCLASS_DASHBOARD=${link}`);
    expect(prompt).toContain("genclass_setup");
    expect(prompt).toContain('genclass_analytics with source "production"');
    expect(prompt).toContain("Keep the dashboard link out of files you commit");
    // another agent: Cursor's JSON, in the user's own file
    ([...view.querySelectorAll(".clients button")].find((b) => b.textContent === "Cursor") as unknown as HTMLElement).click();
    const cursor = r.doc.querySelector("#mcp [data-mcp]")!;
    expect(JSON.parse(cursor.querySelector("pre")!.textContent!)).toEqual({ mcpServers: { genclass: { command: "npx", args: ["-y", MCP_PKG], env: { GENCLASS_DASHBOARD: link } } } });
    expect(cursor.querySelector(".where")!.textContent).toContain("~/.cursor/mcp.json");
    // the agent link box and the JSON address
    expect(r.doc.querySelector("#mcp .alink-out code")!.textContent).toBe(link);
    expect(r.text("#jsonurl")).toBe(`curl -s "https://genclass.dev/api/projects/${secret}?range=7d"`);
    await r.close();
    // the sample reads as "sample", and project scope is fine for it
    const s = await render(sampleStats("7d", NOW));
    expect(s.doc.querySelector("#mcp [data-mcp] pre")!.textContent).toBe(`claude mcp add --scope project genclass -e GENCLASS_DASHBOARD=sample -- npx -y ${MCP_PKG}`);
    await s.close();
  });

  it("MCP in an account: no agent link until one is made; Create agent link posts, then the configuration names the new link", async () => {
    const r = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    const pre = () => r.doc.querySelector("#mcp [data-mcp] pre")!.textContent;
    expect(pre()).toBe(`claude mcp add --scope project genclass -- npx -y ${MCP_PKG}`);
    expect(r.text("#mcp [data-mcp] .warn")).toContain("No agent link yet");
    expect(r.text("#mcp .alink-st")).toBe("None yet.");
    (r.doc.querySelector("#mcp [data-mklink]") as unknown as HTMLElement).click();
    await new Promise((x) => setTimeout(x, 10));
    expect(r.writes).toEqual(["POST /api/account/projects/0123456789abcdef/link"]);
    const link = `https://genclass.dev/dashboard/${"S".repeat(32)}`;
    expect(pre()).toBe(`claude mcp add genclass -e GENCLASS_DASHBOARD=${link} -- npx -y ${MCP_PKG}`);
    expect(r.doc.querySelector("#mcp .alink-out")!.classList.contains("hidden")).toBe(false);
    expect(r.doc.querySelector("#settings .alink-out code")!.textContent).toBe(link);
    expect(r.text("#mcp .alink-st")).toContain("Copy it now");
    // a link already exists: making a new one asks first (the old one stops working)
    const b = r.doc.querySelector("#settings [data-mklink]") as unknown as HTMLElement;
    expect(b.textContent).toBe("Make a new agent link");
    b.click();
    expect(b.textContent).toBe("Confirm: the old link stops working");
    expect(r.writes).toHaveLength(1);
    await r.close();
  });

  it("Fix them all: one prompt for every kind of problem, and the dev page's checks; the agent waits for page loads itself", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st);
    const b = r.doc.getElementById("fixall")!, b2 = r.doc.getElementById("fixall2")!;
    expect(b.classList.contains("hidden")).toBe(false);
    const p = b.getAttribute("data-copy")!;
    expect(b2.getAttribute("data-copy")).toBe(p);
    for (const x of st.breakdowns.detect_diagnosis!.filter((x) => x.key !== "expected")) expect(p).toMatch(new RegExp(`\\n- [^\\n]*${nf.format(x.count)} times?`));
    expect(p).toContain("check genclass_findings lists from the dev page");
    expect(p).toContain("then wait for the loads yourself: check every 10 seconds (sleep 10 in a shell in between)");
    expect(p).toContain("4. Replay the recorded order again: it must say not reproduced.");
    // each problem's own prompt waits the same way
    expect(r.doc.querySelector("#issues [data-copy]")!.getAttribute("data-copy")).toContain("then wait for the loads yourself");
    await r.close();
  });

  it("Connect choices: ticking them rewrites the copied prompt with the server's own installPrompt; the agent choice makes the link", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st, { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    const box = (k: string) => r.doc.querySelector(`#cchoices [data-choice="${k}"]`) as unknown as HTMLInputElement;
    const copied = () => r.doc.getElementById("cpinstall")!.getAttribute("data-copy");
    expect(copied()).toBe(installPrompt(st.token));
    expect(box("eager").disabled).toBe(true);
    box("guard").click();
    expect(box("eager").disabled).toBe(false);
    box("eager").click();
    box("badge").click();
    box("deploy").click();
    expect(copied()).toBe(installPrompt(st.token, null, { guard: true, eager: true, badge: true, deploy: true }));
    expect((r.doc.getElementById("cpinstallt") as unknown as HTMLTextAreaElement).value).toBe(copied());
    // the agent choice makes the agent link (POST .../link), which the prompt then names, as the MCP page does
    box("agent").click();
    await new Promise((x) => setTimeout(x, 10));
    const link = `https://genclass.dev/dashboard/${"S".repeat(32)}`;
    expect(r.writes).toEqual(["POST /api/account/projects/0123456789abcdef/link"]);
    expect(copied()).toBe(installPrompt(st.token, null, { guard: true, eager: true, badge: true, deploy: true, agentLink: link }));
    expect(r.doc.querySelector("#mcp .alink-out code")!.textContent).toBe(link);
    // unticking guard unticks eager
    box("guard").click();
    expect(box("eager").checked).toBe(false);
    expect(copied()).toBe(installPrompt(st.token, null, { badge: true, deploy: true, agentLink: link }));
    await r.close();
    // a private link names itself; no request
    const s = await render(st);
    (s.doc.querySelector('#cchoices [data-choice="agent"]') as unknown as HTMLInputElement).click();
    expect(s.doc.getElementById("cpinstall")!.getAttribute("data-copy")).toBe(installPrompt(st.token, null, { agentLink: "sample" }));
    expect(s.writes).toEqual([]);
    await s.close();
  });

  it("Delete project in an account: Project Settings' danger zone asks once, then sends DELETE with the confirm; a private link has none", async () => {
    const r = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    expect([...r.doc.querySelectorAll(".sb-pm a")].some((a) => a.getAttribute("href") === "#delproj" && a.textContent === "Delete project")).toBe(true);
    const b = r.doc.querySelector("#settings #delproj [data-delproj]") as unknown as HTMLElement;
    expect(b.textContent).toBe("Delete project");
    b.click();
    expect(b.textContent).toBe("Confirm: delete this project and its data");
    expect(r.writes).toEqual([]);
    b.click();
    await new Promise((x) => setTimeout(x, 10));
    expect(r.writes).toEqual(["DELETE /api/account/projects/0123456789abcdef"]);
    expect(r.text("#delproj .err")).toBe("");
    await r.close();
    const a = await render(sampleStats("7d", NOW), { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true }, { url: "https://genclass.dev/account/apps/0123456789abcdef#settings" });
    expect(a.text("#vdesc")).toBe("This project's name, key and agent access, and deleting it.");
    await a.close();
    const s = await render(sampleStats("7d", NOW), {}, { url: "https://genclass.dev/dashboard/sample#settings" });
    expect(s.doc.querySelector("[data-delproj]")).toBeNull();
    expect(s.doc.querySelector('a[href="#delproj"]')).toBeNull();
    expect(s.text("#vdesc")).toBe("This project's name, key and agent access.");
    await s.close();
  });

  it("Copy as Markdown: the period as a report a person or an agent can read (totals, problems with pages and fixes, latest detections)", async () => {
    const st = sampleStats("7d", NOW);
    const copied: string[] = [];
    const r = await render(st, {}, { copied });
    (r.doc.getElementById("mdcopy") as unknown as HTMLElement).click();
    await new Promise((x) => setTimeout(x, 5));
    const md = copied[0]!;
    expect(md.startsWith("# Sample storefront (simulated data) (GenClass dashboard)\n\nIn the last 7 days, to ")).toBe(true);
    expect(md).toContain(`| Page loads | ${nf.format(st.totals.sessions!)} |`);
    expect(md).toContain(`| Problems found | ${nf.format(problems(st))} |`);
    expect(md).toContain(`| Of them measured checks (not model findings) | ${nf.format(st.totals.checks!)} |`);
    expect(md).toContain("## Problems by type");
    expect(md).toMatch(/### Double submits: \d+/);
    expect(md).toContain("Pages: `/checkout` (");
    expect(md).toContain("Fix: Disable the control while the request is in flight");
    expect(md).toContain("## Latest detections");
    expect(md).toContain("Counts only: GenClass stores no text from the app's pages.");
    await r.close();
  });

  it("every page's inline script parses (the frame's, the page's and the account scripts together)", () => {
    for (const [name, html] of everyPage()) {
      const scripts = [...html.matchAll(/<script nonce="n">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length, name).toBeGreaterThan(0);
      for (const code of scripts) expect(() => new Function(code), name).not.toThrow();
    }
  });
});

describe("dashboard page: measured visual checks (docs/runtime/VISUAL.md section 10)", () => {
  /** A period with measured checks only: no model detections, `fixed` check fixes still in place. */
  function checksOnly(checks: number, fixed = 0): Stats {
    const st = noChecks(sampleStats("7d", NOW));
    st.totals = { ...st.totals, detections: 0, detectionsWithPage: 0, interventions: 0, possible: 0, sessions: 100, checks, checksWithPage: checks, check_loads: 100 };
    st.breakdowns = { ...st.breakdowns, detect_diagnosis: [], detect_issue: [], detect_route: [], intervention: [], action_outcome: [], possible_diagnosis: [], possible_issue: [], possible_route: [], check_kind: checks ? [{ key: "scroll-lock-stuck", count: checks }] : [], check_issue: checks ? [{ key: "scroll-lock-stuck\t/", count: checks }] : [], check_fix: fixed ? [{ key: "applied", count: fixed }] : [], visual_setting: [{ key: "on", count: 100 }] };
    st.distinct = { ...st.distinct, detect_route: 0 };
    st.typeSeries = st.typeSeries.map((b) => ({ ...b, counts: {} }));
    st.series = st.series.map((b, i) => ({ ...b, detections: 0, possible: 0, checks: i === st.series.length - 1 ? checks : 0 }));
    st.checkSeries = st.checkSeries.map((b, i) => ({ ...b, counts: i === st.checkSeries.length - 1 ? { "scroll-lock-stuck": checks } : {} }));
    st.recent = [];
    return st;
  }

  it("the sample: a card per check with the Measured check badge, what was measured, where, the usual fix and its own prompt", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st);
    const cards = [...r.doc.querySelectorAll("#issues .find.chk")];
    expect(cards.map((c) => c.querySelector("h3 .bdg")!.textContent)).toEqual(st.breakdowns.check_kind!.map(() => "Measured check"));
    expect(cards).toHaveLength(st.breakdowns.check_kind!.length);
    // the model's cards carry no such badge
    expect(r.doc.querySelectorAll("#issues .find:not(.chk) .bdg")).toHaveLength(0);
    const lock = cards.find((c) => c.querySelector("h3")!.textContent!.startsWith("Scroll locked"))!;
    expect(lock.querySelector(".n")!.textContent).toBe(nf.format(st.breakdowns.check_kind!.find((x) => x.key === "scroll-lock-stuck")!.count));
    expect(lock.textContent).toContain("overflow: hidden");
    expect(lock.querySelector(".where")!.textContent).toContain("/products/:id");
    expect(lock.querySelector("p.fix")!.textContent).toContain("GenClass removes the leaked lock");
    const prompt = lock.querySelector("[data-copy]")!.getAttribute("data-copy")!;
    expect(prompt).toContain("Fix a problem GenClass measured in production in this web app (Sample storefront (simulated data)): scroll locked (the measured check scroll-lock-stuck)");
    expect(prompt).toContain("not a model finding");
    expect(prompt).toContain("1. genclass_scan on /products/:id");
    expect(prompt).toContain("Open and close every dialog, menu and notice on the page");
    expect(prompt).toContain("must not list scroll-lock-stuck any more");
    expect(prompt).toContain("then wait for the loads yourself");
    expect(prompt).not.toContain("genclass_replay");
    await r.close();
  });

  it("Fig. 1 gives the checks their own hatched slot; the summary, the tiles and the rail count them as problems, never as detections", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st);
    const checks = st.totals.checks!;
    expect([...r.doc.querySelectorAll("#legend span")].map((x) => x.textContent)).toContain("Measured checks");
    const hatched = [...r.doc.querySelectorAll('#trendplot rect[data-slot="checks"]')];
    expect(hatched).toHaveLength(st.series.filter((b) => b.checks).length);
    expect(hatched.every((x) => x.getAttribute("fill") === "url(#chkp)")).toBe(true);
    expect(r.doc.querySelector("#trendplot pattern#chkp")).not.toBeNull();
    expect(r.heads("#trendtable")).toContain("Measured checks");
    expect(r.text("#trendn")).toBe(`${nf.format(problems(st))} problems`);
    expect(r.text("#summary")).toContain(`(${nf.format(checks)} measured checks)`);
    expect(r.text("#tiles > div:nth-child(1) .v")).toBe(nf.format(problems(st)));
    expect(r.text("#tiles > div:nth-child(1) .s")).toContain(`${nf.format(checks)} measured checks`);
    expect(r.text("#c-trend")).toBe(nf.format(problems(st)));
    expect(r.text("#c-found")).toBe(String(st.breakdowns.detect_diagnosis!.length + st.breakdowns.check_kind!.length));
    // the Pages table draws them hatched and says what the hatching is
    expect([...r.doc.querySelectorAll("#pages .mix i")].some((i) => (i.getAttribute("title") ?? "").startsWith("Measured checks: "))).toBe(true);
    expect(r.text("#pages figcaption")).toContain("Hatched: measured checks, not model findings.");
    // the possible tier and the detections' own counts are untouched
    expect(r.text("#possn")).toBe(`${nf.format(st.totals.possible!)} possible issues`);
    await r.close();
  });

  it("What GenClass did lists the check fixes as their own action, with the undone ones; Health says where the checks ran", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st);
    const applied = st.breakdowns.check_fix!.find((x) => x.key === "applied")!.count;
    const row = [...r.doc.querySelectorAll("#acted tbody tr")].find((tr) => tr.textContent!.includes("Fixed a measured check"))!;
    expect(row.querySelector(".bdg")!.textContent).toBe("Measured check");
    expect(row.querySelector("td.num")!.textContent).toBe(nf.format(applied));
    expect(r.text("#acted figcaption")).toContain("1 check fix undone");
    expect(r.text("#health")).toContain("Measured checks");
    expect(r.text("#health")).toContain(`${nf.format(st.totals.check_loads!)} page loads ran them`);
    expect(r.text("#c-did")).toBe(nf.format(st.totals.interventions! + applied));
    await r.close();
  });

  it("the app's status counts them: Critical when they are not fixed live, Needs attention when every one was, Healthy with none", async () => {
    let r = await render(checksOnly(10));
    expect(r.text("#verdictt")).toBe("Critical");
    expect(r.text("#verdicts")).toBe("10 problems not fixed live");
    expect(r.text("#summary")).toContain("found 10 problems (all measured checks) on 1 page");
    await r.close();
    r = await render(checksOnly(10, 10));
    expect(r.text("#verdictt")).toBe("Needs attention");
    expect(r.text("#verdicts")).toBe("every problem was fixed live; the code still needs the fix");
    expect(r.text("#summary")).toContain("It fixed 10 measured checks on visitors' screens");
    await r.close();
    r = await render(checksOnly(0));
    expect(r.text("#verdictt")).toBe("Healthy");
    await r.close();
  });

  it("Fix them all names every check with its kind and measures the page again with genclass_scan", async () => {
    const r = await render(checksOnly(4));
    const b = r.doc.getElementById("fixall")!;
    expect(b.classList.contains("hidden")).toBe(false);
    const p = b.getAttribute("data-copy")!;
    expect(p).toContain("- Scroll locked (measured check scroll-lock-stuck), 4 times, on /.");
    expect(p).toContain("run genclass_scan on its page instead");
    expect(p).toContain("For a measured check, genclass_scan on its page must no longer list it.");
    expect(p).toContain("every other check genclass_findings lists from the dev page");
    // the overview's first card is the check, with its own prompt
    expect(r.doc.querySelector("#advisor article h3 .bdg")!.textContent).toBe("Measured check");
    expect(r.doc.querySelector("#advisor [data-copy]")!.getAttribute("data-copy")).toContain("genclass_scan");
    await r.close();
  });

  it("Health tells an app whose pages do not run the checks how to turn them on", async () => {
    const st = checksOnly(0);
    st.totals.check_loads = 0;
    st.breakdowns.visual_setting = [{ key: "local", count: 100 }];
    const r = await render(st);
    expect(r.text("#health")).toContain("They are off on public hosts unless the app turns them on: visual: true");
    expect(r.text("#health")).toContain("not running");
    await r.close();
  });

  it("the demo's project shows its estimate's labels only while the stats are the estimate", async () => {
    const st = { ...checksOnly(3), name: "Snowday Predictor" };
    const r = await render(st);
    // measured stats (no demo flag): the measured tile, not the estimate's "Fixed live" and "+"
    expect(r.text("#tiles > div:nth-child(1) .v")).toBe("3");
    expect(r.text("#tiles")).toContain("Stopped by GenClass");
    expect(r.text("#tiles")).not.toContain("Fixed live");
    await r.close();
  });
});
