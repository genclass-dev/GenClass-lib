// The dashboard page's own script, rendered against stats JSON in happy-dom (already in the repo's dev dependencies,
// through packages/runtime): what a developer reads on the page, the possible-issues tier and the display fixes.
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { AGENT_RUNTIME, CDN_SCRIPT, DASH_CSS, dashboardPage, esc, KEY_RUNTIME, MCP_ADD, MCP_ADD_DASHBOARD, MESH_SCRIPT, RUNTIME_PKG, securityHeaders, SNIPPET_RUNTIME, startPage, type DashboardOptions } from "../src/pages.js";
import { accountPage, devicePage, forgotPage, lockedLinkPage, loginPage, messagePage, passkeyStepPage, pendingPage, signupPage } from "../src/account-pages.js";
import { sampleStats } from "../src/sample.js";
import type { Stats } from "../src/dashboard.js";

const NOW = new Date("2026-10-13T20:00:00Z");
const nf = new Intl.NumberFormat();

/**
 * Render the dashboard for `stats`: the page body, then its inline script with fetch answering `stats` (and, in account
 * mode, the Connect panel's app list). `opts` as dashboardPage takes them: with `account` the account-mode page
 * (/account/apps/<id>: the Connect panel, the period controls in #period, no #setup).
 */
async function render(stats: Stats, opts: DashboardOptions = {}, url?: string) {
  const html = dashboardPage("NONCE", { name: stats.name, token: stats.token, created: stats.created, lastEvent: stats.lastEvent }, opts);
  const main = /<main class="wrap"[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!; // the shell's <main> also has id="main"
  const script = /<script nonce="NONCE">([\s\S]*?)<\/script>/.exec(html)![1]!;
  const win = new Window({ url: url ?? (opts.account ? `https://genclass.dev/account/apps/${opts.id}` : "https://genclass.dev/dashboard/sample") });
  const doc = win.document;
  doc.body.innerHTML = main;
  const urls: string[] = [];
  const fetch = async (u: string) => {
    urls.push(u);
    return { ok: true, status: 200, json: async () => (u.startsWith("/api/account/projects?") || u === "/api/account/projects" ? { projects: [] } : stats) };
  };
  const run = new Function("window", "document", "location", "localStorage", "fetch", "setInterval", "navigator", "IntersectionObserver", script);
  run(win, doc, win.location, win.localStorage, fetch, () => 0, win.navigator, class { observe() {} });
  await new Promise((r) => setTimeout(r, 20));
  const text = (sel: string) => (doc.querySelector(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
  const hidden = (id: string) => doc.getElementById(id)!.classList.contains("hidden");
  const heads = (sel: string) => [...doc.querySelectorAll(`${sel} th`)].map((x) => x.textContent);
  return { doc, win, html, text, hidden, heads, urls, close: () => win.happyDOM.close() };
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

  it("renders the merged script: possible issues, the period controls in #period, the Connect panel hidden, no #setup", async () => {
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
    expect(r.text("#trendn")).toBe(`${nf.format(st.totals.detections!)} problems`);
    expect(r.hidden("possfig")).toBe(false);
    expect(r.text("#possn")).toBe(`${nf.format(st.totals.possible!)} possible issues`);
    expect(r.hidden("possible-s")).toBe(false);
    expect(r.doc.querySelectorAll("#possible .find.poss").length).toBe(st.breakdowns.possible_diagnosis!.length);
    expect(r.heads("#pages")).toEqual(["Page", "Problems", "By type", "Possible"]);
    // the Connect panel: hidden once the app has sent, and its status line says connected
    expect(r.doc.getElementById("connect")!.classList.contains("hidden")).toBe(true);
    expect(r.text("#cstatust")).toMatch(/^Connected\. First event /);
    expect(r.doc.getElementById("cnote")).toBeNull(); // runtimeReady: no "Not on npm yet"
    await r.close();
  });

  it("while the app waits for its first event: Connect shows, the period controls and stats stay hidden, nothing throws", async () => {
    const st = { ...sampleStats("7d", NOW), lastEvent: null };
    const r = await render(st, { account, id: "0123456789abcdef", firstEvent: null });
    expect(r.hidden("period")).toBe(true);
    expect(r.hidden("content")).toBe(true);
    expect(r.hidden("nodata")).toBe(true); // account mode explains in the Connect panel instead
    expect(r.doc.getElementById("connect")!.classList.contains("hidden")).toBe(false);
    expect(r.text("#cstatust")).toBe("Waiting for the first event from this app");
    expect(r.text("#updated")).not.toContain("Could not load");
    // not on npm yet (runtimeReady unset): said first, with the @beta command
    expect(r.text("#cnote")).toContain(`Project keys ship in @genclass/runtime ${KEY_RUNTIME} (npm dist-tag beta), which is not published yet`);
    expect(r.text("#connect")).toContain(`npx ${RUNTIME_PKG} login`);
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
    ["pending", pendingPage("n", { email: "ada@example.com", provider: "google" })],
    ["message", messagePage("n", { title: "T", text: "x", links: [["One", "/a"]] })],
    ["/dashboard/<secret> (locked)", lockedLinkPage("n", { name: "a", signedIn: null, owner: "none", providers })],
  ];
}

describe("pages: one black theme everywhere, as on genclass.dev", () => {
  it("no page switches palette with the visitor's system theme: no prefers-color-scheme, color-scheme dark", () => {
    for (const [name, html] of everyPage()) {
      expect(html, name).not.toContain("prefers-color-scheme");
      expect(html, name).toContain("color-scheme:dark;");
      expect(html, name).not.toMatch(/color-scheme:\s*light/);
      expect(html, name).toContain('<meta name="theme-color" content="#000000">');
      // the site's black tokens, once (no second set that could override them)
      expect(html.match(/--paper:/g), name).toHaveLength(1);
      expect(html, name).toContain("--paper:#000000;--panel:#0B0B0A;--ink:#F0F1E9;");
      // the site's type, not the light design's
      expect(html, name).toContain("https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap");
      expect(html, name).not.toMatch(/Outfit|Figtree|Geist/);
      // the mark and the name in type; the navy-on-white lockup images are gone
      expect(html, name).not.toContain("lockup-");
    }
    expect(DASH_CSS).toContain(":root{--t1:#3987E5;--t2:#E8552F;--t3:#2AA3C7;--t4:#C98500;--t5:#B964C9;--t0:#88897F;--grid:#1E1F1B}");
  });

  it("contrast on the black palette: text at least 4.5:1 on paper, panel and code, inputs' borders and the focus ring at least 3:1", () => {
    const html = startPage("n");
    const token = (name: string) => {
      const m = new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(html);
      if (!m) throw new Error(`no --${name}`);
      return m[1]!;
    };
    const [paper, panel, code] = [token("paper"), token("panel"), token("code")];
    for (const t of ["ink", "ink2", "ink3", "accent", "warn"]) {
      expect(contrast(token(t), paper), t).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(t), panel), t).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(t), code), t).toBeGreaterThanOrEqual(4.5);
    }
    // green and red-orange tints behind their own text (notices, errors)
    expect(contrast(token("accent"), token("accent-t"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("warn"), token("warn-t"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink3"), token("accent-t"))).toBeGreaterThanOrEqual(4.5);
    // the selected segment and tab (paper on ink); buttons: their ink on the green fill (and its hover)
    expect(contrast(paper, token("ink"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("on-green"), token("accent-f"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("on-green"), token("green-h"))).toBeGreaterThanOrEqual(4.5);
    // large green text, the input border and the focus ring
    expect(contrast(token("accent-x"), paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(token("line"), paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(token("accent"), paper)).toBeGreaterThanOrEqual(3);
    // the code panels are the site's raised black, with bone text
    expect(contrast(token("codeink"), token("code"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("pages: genclass.dev's palette, buttons, header and focus ring", () => {
  const project = { name: "a", token: "gc_TestToken0123456789abc", created: "", lastEvent: null };
  /** HSL hue of a #RRGGBB colour, in degrees. */
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  it("every page carries the site's tokens, its focus ring and its sticky header", () => {
    for (const html of [startPage("n"), dashboardPage("n", project), loginPage("n", { google: false, github: false, next: null })]) {
      // site/src/css/base.css: bone text, the green (text, fills), the red-orange (fills; text), the raised black, the rules
      for (const t of ["--ink:#F0F1E9", "--accent-f:#2FD07F", "--accent:#2FD07F", "--warn-f:#FF5A36", "--warn:#FF6B4A", "--panel:#0B0B0A", "--rule:#30312B", "--rule2:#46463E"]) expect(html).toContain(t);
      expect(html).toContain(":focus-visible{outline:1px solid var(--accent);outline-offset:3px}");
      expect(html).not.toContain("prefers-color-scheme");
      // square corners, as on the site (status dots stay round)
      expect(html).not.toMatch(/border-radius:[1-9]\d*px/);
    }
    expect(startPage("n")).toMatch(/header\.top\{position:sticky;top:0;/);
    expect(startPage("n")).toContain('<a class="logo" href="https://genclass.dev/"><img src="https://genclass.dev/brand/mark-64.png?v=2" alt="" width="24" height="24">GenClass</a>');
  });

  it("scroll targets clear the sticky header; one small button size; focus rings unclipped; one green item in the sidebar", () => {
    // the 64px header plus a margin. It covers /start's out.scrollIntoView(), every #section link (the div #did
    // included) and focus scrolling; the dashboard adds the sticky sidebar strip below 920px.
    for (const html of [startPage("n"), dashboardPage("n", project)]) expect(html).toContain("html:has(header.top){scroll-padding-top:76px}");
    expect(DASH_CSS).toContain("@media (max-width:920px){");
    expect(DASH_CSS).toContain("html:has(.app>.side:not(.acct)){scroll-padding-top:125px}");
    expect(DASH_CSS).not.toContain("scroll-margin-top"); // it would add to the padding
    // the 320px header fits: a smaller gap below 361px
    expect(startPage("n")).toContain("@media (max-width:360px){header.top .wrap{gap:10px}}");
    // .btn.sm is 34px everywhere (44px on phones), with no per-place override
    const all = startPage("n") + dashboardPage("n", project) + messagePage("n", { title: "T", text: "x", links: [["One", "/a"]] });
    expect(all).toContain(".btn.sm{min-height:34px;");
    expect(all).toContain("@media (max-width:620px){.btn.sm{min-height:44px}}");
    expect(all).not.toMatch(/\.btn\.sm\{min-height:(28|30)px/);
    // room for the ring at 3px offset inside the sidebar's and the tables' scroll containers
    expect(DASH_CSS).toContain("padding:28px 24px 28px 16px;margin-left:-16px;");
    expect(startPage("n")).toContain(".tablewrap{overflow-x:auto;padding-left:6px;margin-left:-6px}");
    // the current app is ink on panel; the green tint is the scroll-spy section's alone
    expect(DASH_CSS).toContain(".side nav a[aria-current=page]{color:var(--ink);background:var(--panel);font-weight:500}");
    // a route with a total but no per-type breakdown is drawn in the Other grey, not stale responses' red-orange
    expect(dashboardPage("n", project)).toContain('i0.style.background = "var(--t0)"');
    expect(dashboardPage("n", project)).not.toContain("var(--bar3)");
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

  it("chart series: the validated slots, dark only, none of them green (green means GenClass fixed it)", () => {
    const dark = /:root\{--t1:(#\w{6});--t2:(#\w{6});--t3:(#\w{6});--t4:(#\w{6});--t5:(#\w{6});/.exec(DASH_CSS)!.slice(1);
    // validate_palette.js --mode dark passes on these, in this order (pages.ts, the chart colours comment)
    expect(dark).toEqual(["#3987E5", "#E8552F", "#2AA3C7", "#C98500", "#B964C9"]);
    expect(DASH_CSS.match(/--t1:/g)).toHaveLength(1);
    for (const c of dark) expect(hue(c) < 75 || hue(c) > 170, c).toBe(true);
    // every slot is a visible mark on the page and on a panel
    for (const c of dark) for (const bg of ["#000000", "#0B0B0A"]) expect(contrast(c, bg), c).toBeGreaterThanOrEqual(3);
    expect(hue("#2FD07F")).toBeGreaterThan(75); // the check itself would catch the brand green
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

  it("hidden for an app that has not turned analytics on; the footer says what interaction data is", async () => {
    const st = sampleStats("7d", NOW);
    for (const k of Object.keys(st.breakdowns)) if (k.startsWith("ix_")) delete st.breakdowns[k];
    for (const k of Object.keys(st.totals)) if (k.startsWith("ix_")) delete st.totals[k];
    const { doc, hidden, close } = await render(st);
    expect(hidden("visits")).toBe(true);
    expect(hidden("clicks")).toBe(true);
    expect(hidden("nav-visits")).toBe(true);
    expect(doc.querySelector(".dfoot")!.textContent).toContain("never its text");
    expect(doc.querySelector(".dfoot")!.textContent).toContain("No text from your pages, no IP addresses and no user agents are stored.");
    await close();
  });
});

describe("dashboard page: sessions and problem rate (Fig. 3)", () => {
  it("two line charts on one time axis after Fig. 1, each with its own aria-label, a caption and a table view", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, html, text, heads, close } = await render(st);
    // on the Overview view, after the Problems found section
    expect(doc.getElementById("rate")!.getAttribute("data-v")).toBe("overview");
    expect(html.indexOf('id="rate"')).toBeGreaterThan(html.indexOf('id="trend"'));
    expect(html.indexOf('id="rate"')).toBeLessThan(html.indexOf('id="found"'));
    expect(text("#rate .blk-h h2")).toBe("Sessions and problem rate");
    expect(text("#rate figcaption")).toMatch(/^Fig\. 3\. Sessions \(page loads\) per day/);
    // two svgs (never one with two y axes), each named, each one line
    const svgs = [...doc.querySelectorAll("#rateplot svg")];
    expect(svgs).toHaveLength(2);
    expect(svgs.map((g) => g.getAttribute("aria-label"))).toEqual(["Sessions per day", "Problems found per 1,000 sessions, per day; no value where there were no sessions"]);
    for (const g of svgs) {
      expect(g.querySelectorAll("path")).toHaveLength(1);
      expect(g.querySelector("path")!.getAttribute("stroke-width")).toBe("2");
      expect(g.querySelector("path")!.getAttribute("stroke-linejoin")).toBe("round");
    }
    // y axes from 0; the x labels only on the bottom chart (3 y ticks each, 3 x labels)
    expect(svgs[0]!.querySelector("text")!.textContent).toBe("0");
    expect(svgs[0]!.querySelectorAll("text")).toHaveLength(3);
    expect(svgs[1]!.querySelectorAll("text")).toHaveLength(6);
    // the table view: every bucket, the rate as detections / sessions * 1000
    expect(heads("#ratetable")).toEqual(["Day", "Sessions", "Problems", "Per 1,000 sessions"]);
    const trs = [...doc.querySelectorAll("#ratetable tbody tr")];
    expect(trs).toHaveLength(st.series.length);
    const b0 = st.series[0]!;
    expect([...trs[0]!.querySelectorAll("td")].map((x) => x.textContent).slice(1)).toEqual([nf.format(b0.sessions), nf.format(b0.detections), new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format((1000 * b0.detections) / b0.sessions)]);
    // keyboard: only the top chart's buckets take focus; focus shows the crosshair in both charts and one tooltip
    const keys = [...doc.querySelectorAll("#rateplot rect[tabindex]")];
    expect(keys).toHaveLength(st.series.length);
    expect(svgs[1]!.querySelectorAll("rect[tabindex]")).toHaveLength(0);
    keys[1]!.dispatchEvent(new (doc.defaultView as any).Event("focus"));
    expect(doc.querySelectorAll('#rateplot line[visibility="visible"]')).toHaveLength(2);
    expect(doc.querySelectorAll('#rateplot circle[visibility="visible"]')).toHaveLength(2);
    expect(doc.querySelectorAll("#rateplot .tip:not(.hidden)")).toHaveLength(1);
    expect(text("#rateplot .tip")).toContain(`Sessions${nf.format(st.series[1]!.sessions)}`);
    expect(text("#rateplot .tip")).toContain("Per 1,000 sessions");
    keys[1]!.dispatchEvent(new (doc.defaultView as any).Event("blur"));
    expect(doc.querySelectorAll('#rateplot line[visibility="visible"]')).toHaveLength(0);
    expect(doc.querySelectorAll("#rateplot .tip.hidden")).toHaveLength(1);
    await close();
  });

  it("a bucket with no sessions has no rate: a gap in the line, '-' in the table, 'no sessions' in the tooltip", async () => {
    const st = sampleStats("7d", NOW);
    st.series = st.series.map((b, i) => (i === 3 ? { ...b, sessions: 0, detections: 2 } : b));
    const { doc, text, close } = await render(st);
    const rate = doc.querySelectorAll("#rateplot svg")[1]!.querySelector("path")!.getAttribute("d")!;
    expect(rate.match(/M/g)).toHaveLength(2);
    expect(rate).not.toMatch(/NaN|Infinity/);
    expect(doc.querySelectorAll("#ratetable tbody tr")[3]!.querySelectorAll("td")[3]!.textContent).toBe("-");
    // the sessions line itself has no gap: 0 sessions is a value
    expect(doc.querySelectorAll("#rateplot svg")[0]!.querySelector("path")!.getAttribute("d")!.match(/M/g)).toHaveLength(1);
    doc.querySelectorAll("#rateplot rect[tabindex]")[3]!.dispatchEvent(new (doc.defaultView as any).Event("focus"));
    expect(text("#rateplot .tip")).toContain("no sessions");
    expect(doc.querySelectorAll('#rateplot circle[visibility="visible"]')).toHaveLength(1);
    await close();
  });

  it("a point between two gaps is still drawn (a zero-length round segment)", async () => {
    const st = sampleStats("7d", NOW);
    st.series = st.series.map((b, i) => (i === 2 || i === 4 ? { ...b, sessions: 0 } : b));
    const { doc, close } = await render(st);
    const rate = doc.querySelectorAll("#rateplot svg")[1]!.querySelector("path")!;
    expect(rate.getAttribute("d")).toContain("h0");
    expect(rate.getAttribute("stroke-linecap")).toBe("round");
    await close();
  });

  it("24 hours: hourly buckets, labels and table", async () => {
    const st = sampleStats("24h", NOW);
    const { doc, text, heads, close } = await render(st);
    expect(heads("#ratetable")[0]).toBe("Hour");
    expect(doc.querySelectorAll("#ratetable tbody tr")).toHaveLength(24);
    expect(text("#rate figcaption")).toContain("per hour");
    expect(doc.querySelectorAll("#rateplot svg")[0]!.getAttribute("aria-label")).toBe("Sessions per hour");
    await close();
  });

  it("no sessions in the period: a short empty-state line instead of axes", async () => {
    const st = sampleStats("7d", NOW);
    st.series = st.series.map((b) => ({ ...b, sessions: 0 }));
    const { doc, text, close } = await render(st);
    expect(doc.querySelectorAll("#rateplot svg")).toHaveLength(0);
    expect(text("#rateplot")).toBe("No sessions in this period, so there is nothing to draw.");
    expect(text("#raten")).toBe("");
    await close();
  });
});

describe("dashboard page: the AI agent view (docs/runtime/AGENT.md sections 1 and 4)", () => {
  const account = { apps: [{ id: "0123456789abcdef", name: "Shop" }], current: "0123456789abcdef", email: "dev@example.com" };
  const filled = (url: string) => MCP_ADD_DASHBOARD.replace("<this dashboard's URL>", url);

  it("private link: the sidebar link, the install steps and the command with this dashboard's URL (no query or fragment)", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, html, text, close } = await render(st, {}, "https://genclass.dev/dashboard/sample?range=24h#agent");
    const link = doc.querySelector('#snav a[href="#agent"]')!;
    expect(link.textContent).toBe("AI agent");
    expect(DASH_CSS).toContain('.snav a[href="#agent"]{--ic:url(');
    expect(doc.getElementById("agent")!.getAttribute("data-v")).toBe("agent");
    // the hash opened the view: the agent section shows, the overview does not, the link is current
    expect(doc.getElementById("agent")!.classList.contains("vh")).toBe(false);
    expect(doc.getElementById("rate")!.classList.contains("vh")).toBe(true);
    expect(link.getAttribute("aria-current")).toBe("true");
    expect(text("#crumbv")).toBe("/ AI agent");
    // step 1: the command and the plugin; the optional dashboard command is rendered with its placeholder (escaped)
    // and filled in from the page's URL
    expect(html).toContain(esc(MCP_ADD_DASHBOARD));
    expect(text("#agent")).toContain(MCP_ADD);
    expect(text("#agent")).toContain("/plugin marketplace add genclass-dev/GenClass-lib");
    expect(text("#agent")).toContain("/plugin install genclass@genclass");
    const cmd = filled("https://genclass.dev/dashboard/sample");
    expect(doc.getElementById("asnipd")!.textContent).toBe(cmd);
    expect(doc.getElementById("asnipdb")!.getAttribute("data-copy")).toBe(cmd);
    expect(cmd).not.toMatch(/[?#]/);
    expect(text("#agentwarn")).toContain("stores this dashboard's private link in your Claude configuration, and anyone with the link can see these stats");
    expect(doc.getElementById("agentprod")).toBeNull();
    // steps 2 and 3, and the docs
    expect(text("#agent")).toContain(`npm install @genclass/runtime@${AGENT_RUNTIME}`);
    expect(text("#agent")).toContain(`needs @genclass/runtime ${AGENT_RUNTIME} or later`);
    expect([...doc.querySelectorAll("#agent pre")].map((p) => p.textContent)).toContain('import { GenClass } from "@genclass/runtime";\nimport { connectAgent } from "@genclass/runtime/agent";\n\nconst rt = GenClass.init();\nif (import.meta.env.DEV) connectAgent(rt);');
    expect(text("#agent")).toContain('Next.js uses process.env.NODE_ENV === "development"');
    expect(doc.querySelectorAll("#agent ul.asks li")).toHaveLength(3);
    expect(doc.querySelector('#agent a[href="https://github.com/genclass-dev/GenClass-lib/blob/main/docs/runtime/AGENT.md"]')).not.toBeNull();
    // every copy button carries the text of its block and names it; no inline handlers
    for (const b of doc.querySelectorAll("#agent button[data-copy]")) {
      expect(b.getAttribute("data-copy")).toBe(doc.getElementById(b.getAttribute("data-target")!)!.textContent);
      expect(b.getAttribute("aria-label")).toMatch(/^Copy /);
    }
    expect(/<[^>]+\son[a-z]+=/i.test(/<section class="blk connect agent"[\s\S]*?<\/section>/.exec(html)![0])).toBe(false);
    await close();
  });

  it("account mode: the link under Setup and the steps, without the GENCLASS_DASHBOARD command", async () => {
    const st = sampleStats("7d", NOW);
    const r = await render(st, { account, id: "0123456789abcdef", firstEvent: "2026-10-12T09:00:00.000Z", runtimeReady: true });
    expect(r.doc.querySelector('#cnav a[href="#agent"]')!.textContent).toBe("AI agent");
    expect(r.doc.getElementById("agent")!.getAttribute("data-v")).toBe("agent");
    expect(r.html).not.toContain("GENCLASS_DASHBOARD");
    expect(r.doc.getElementById("asnipd")).toBeNull();
    expect(r.doc.getElementById("agentwarn")).toBeNull();
    expect(r.text("#agentprod")).toBe("Production numbers in the agent are available for private-link dashboards for now.");
    expect(r.text("#agent")).toContain(MCP_ADD);
    // the page's script still ran to the end
    expect(r.text("#updated")).toMatch(/^Updated /);
    await r.close();
    // while the app waits for its first event the link stays reachable (the period links are hidden)
    const w = await render({ ...st, lastEvent: null }, { account, id: "0123456789abcdef", firstEvent: null });
    expect(w.hidden("period")).toBe(true);
    expect(w.doc.querySelector('#cnav a[href="#agent"]')).not.toBeNull();
    await w.close();
  });

  it("the sample dashboard keeps working with the view: stats load, the overview is the first view", async () => {
    const st = sampleStats("7d", NOW);
    const { doc, text, close } = await render(st);
    expect(text("#updated")).toMatch(/^Updated /);
    expect(text("#summary")).toContain(`found ${nf.format(st.totals.detections!)} problems`);
    expect(doc.getElementById("agent")!.classList.contains("vh")).toBe(true);
    expect(doc.getElementById("trend")!.classList.contains("vh")).toBe(false);
    expect(doc.getElementById("asnipd")!.textContent).toBe(filled("https://genclass.dev/dashboard/sample"));
    await close();
  });
});
