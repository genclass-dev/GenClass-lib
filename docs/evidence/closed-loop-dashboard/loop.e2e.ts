// End-to-end evidence for the closed-loop dashboard (docs/evidence/closed-loop-dashboard/README.md): a real MCP Store
// and the real reporter, posting through the collector's real request handler on the real D1 schema (node:sqlite
// running every migration), then the real stats and the real dashboard page in happy-dom. Writes page-e2e.html (the
// dashboard with this run's stats inlined) and page-sample.html next to itself for record.mjs.
// Run from the repository root: npx vite-node docs/evidence/closed-loop-dashboard/loop.e2e.ts
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { sampleStats } from "../../../telemetry-worker/src/sample.ts";
import { Store } from "../../../packages/mcp/src/store.ts";
import { makeApi } from "../../../packages/mcp/src/api.ts";
import { createReporter } from "../../../packages/mcp/src/report.ts";
import { reportingApi } from "../../../packages/mcp/src/server.ts";
import { handle } from "../../../telemetry-worker/src/collector.ts";
import { createProject, stats } from "../../../telemetry-worker/src/dashboard.ts";
import { dashboardPage } from "../../../telemetry-worker/src/pages.ts";
import { d1 } from "../../../telemetry-worker/test/d1.ts";

const NOW = new Date();
const { api: db, rows } = d1();
const env = { BUCKET: { async put() {} }, DB: db } as never;
const p = await createProject(db, "storefront", NOW);
const http: string[] = [];
const bodies: string[] = [];
const fetchFn = (async (url: string, init: RequestInit) => {
  bodies.push(String(init.body));
  const res = await handle(new Request(url, { method: init.method, headers: init.headers as Record<string, string>, body: init.body as string }), env, { now: () => new Date() });
  http.push(`${init.method} ${url.replace(p.secret, "<secret>")} -> ${res.status} ${await res.clone().text()}`);
  return res;
}) as unknown as typeof fetch;
const reporter = createReporter({ origin: "https://genclass.dev", secret: p.secret }, { fetch: fetchFn, flushMs: 5, log: (s) => console.log("reporter:", s) });
const store = new Store();
store.onFinding(({ finding, fresh }) => { if (fresh) reporter.found(finding); });
const api = reportingApi(makeApi(store, { url: "http://127.0.0.1:47357", port: 47357 }), store, reporter);

const ORIGIN = "http://localhost:5173";
const load = (route = "/search") => {
  const h = store.hello({ schema: "genclass-agent/1", page: { url: `${ORIGIN}${route}`, route, title: "App" }, runtime: { mode: "observe", model: "ready" } }, ORIGIN)!;
  return { ...h, send: (events: unknown[]) => store.events({ run: h.run, token: h.token, events }, ORIGIN) };
};
const typeReact = { k: "act", i: 0, t: 0, kind: "type", target: 'searchbox "Search"', value: "react", count: 5, dur: 400 };
const witness = { kind: "overwrote-newer", t: 900, subject: "search.results", by: "GET /api/search#4", byDetail: "?q=reac", over: "GET /api/search#5", overKind: "request", gapMs: 20, change: "5 items → 3 items" };
const snap = (state: Record<string, string>) => ({ t: 1000, state, text: [], requests: {}, witnesses: 0, errors: 0, forced: 0 });
// the page reports the order its responses were delivered in (the newer request's response first, then the stale one)
const order = ["GET /api/search#5", "GET /api/search#4"];
const buggy = () => load().send([{ t: "steps", steps: [typeReact], order }, { t: "witness", witness }, { t: "snapshot", snapshot: snap({ "search.results": "3 items" }) }]);
const fixed = () => load().send([{ t: "steps", steps: [typeReact], order }, { t: "snapshot", snapshot: snap({ "search.results": "5 items" }) }]);

const step = (s: string) => console.log(`\n== ${s}`);
step("1. a dev-build page load records a stale write (the bridge makes finding)");
buggy();
const f = store.ranked()[0]!;
console.log("finding:", f.id, f.kind, f.route, "|", f.title);
step("2. the agent reads the evidence: genclass_explain (explain + the generated test)");
const ex = api("finding", { id: f.id }) as { test: string | null };
console.log("test generated:", !!ex.test);
step("3. replay armed, the page loaded again with the recorded order: reproduced");
console.log("armed:", JSON.stringify((api("replay.arm", { id: f.id }) as { spec?: unknown; error?: string }).spec ?? api("replay.arm", { id: f.id })));
buggy();
console.log("verdict:", (api("replay.result", { id: f.id }) as { results: { reproduced: boolean | null }[] }).results.map((r) => r.reproduced));
step("4. a first fix tried, replay still reproduces it: round again");
api("replay.arm", { id: f.id }); buggy();
console.log("verdict:", (api("replay.result", { id: f.id }) as { results: { reproduced: boolean | null }[] }).results.map((r) => r.reproduced));
step("5. the real fix, replay no longer reproduces it: fix proven, with the test: closed");
api("replay.arm", { id: f.id }); fixed();
console.log("verdict:", (api("replay.result", { id: f.id }) as { results: { reproduced: boolean | null }[] }).results.map((r) => r.reproduced));
step("6. an explore report and a clear of the runs");
api("explore.start", { runs: 1, route: "/search" }); api("explore.report", {}); api("clear", { what: "runs" });
await reporter.close();

step("HTTP calls the reporter made into the collector (real handle())");
http.forEach((l) => console.log(" ", l));
const leaked = bodies.join("\n").match(/react|items|Search|overwrote|q=reac/g);
console.log("page text in what was sent:", leaked ? leaked : "none");

step("D1 rows (real schema from migrations/)");
console.table(rows("SELECT finding, kind, route, found IS NOT NULL AS found, explained IS NOT NULL AS explained, reproduced, reproduced_once, reproduced_n, tested IS NOT NULL AS tested, proven IS NOT NULL AS proven FROM agent_reports"));
console.table(rows("SELECT id, t, finding, kind, route, reproduced, runs, races, what FROM agent_log ORDER BY id"));

step("stats(): what the dashboard fetches");
const st = await stats(db, { ...p, last_event: null, first_event: null, account_id: null, private_link: null } as never, "7d", NOW);
console.log("agent.stages:", st.agent.stages);
console.log("agent.log (newest first):", st.agent.log.map((e) => `${e.t}${e.id ? " " + e.id : ""}${e.reproduced === null ? "" : e.reproduced ? " reproduced" : " not-reproduced"}${e.runs !== null ? ` runs=${e.runs} races=${e.races}` : ""}${e.what ? " " + e.what : ""}`).join(", "));

step("the dashboard page rendered in happy-dom against those stats");
const html = dashboardPage("NONCE", { name: st.name, token: st.token, created: st.created, lastEvent: NOW.toISOString() }, {});
const main = /<main class="wrap"[^>]*>([\s\S]*)<\/main>/.exec(html)![1]!;
const script = /<script nonce="NONCE">([\s\S]*?)<\/script>/.exec(html)![1]!;
const win = new Window({ url: "https://genclass.dev/dashboard/x" });
const doc = win.document; doc.body.innerHTML = main;
const pageFetch = async () => ({ ok: true, status: 200, json: async () => ({ ...st, lastEvent: NOW.toISOString() }) });
new Function("window", "document", "location", "localStorage", "fetch", "setInterval", "navigator", "IntersectionObserver", script)(win, doc, win.location, win.localStorage, pageFetch, () => 0, win.navigator, class { observe() {} });
await new Promise((r) => setTimeout(r, 30));
console.log("sidebar link:", doc.querySelector('.snav a[href="#loop"]')!.textContent!.trim(), "| heading:", doc.getElementById("loop-h")!.textContent);
console.log("Fig. 3 stages:", [...doc.querySelectorAll("#loopstages rect[data-stage]")].map((r) => `${r.getAttribute("data-stage")}=${r.getAttribute("data-n")}`).join("  "));
console.log("Fig. 3 labels:", [...doc.querySelectorAll("#loopstages .el")].map((t) => t.textContent).join(" | "));
console.log("Table 15 rows:");
[...doc.querySelectorAll("#agentlog tr")].forEach((tr) => console.log("  ", [...tr.children].slice(1).map((c) => c.textContent!.replace(/\s+/g, " ").trim()).join(" | ")));
console.log("Fig. 6 agent line:", [...doc.querySelectorAll("#loopsvg tspan")].map((t) => t.textContent).filter((t) => t!.startsWith("Agent:")).join(" "));
win.happyDOM.close();

step("static pages for the recording (the dashboard with the stats inlined)");
const here = dirname(fileURLToPath(import.meta.url));
const staticPage = (st2: unknown, name: string, last: string | null) => {
  const h = dashboardPage("NONCE", { name: (st2 as { name: string }).name, token: (st2 as { token: string }).token, created: (st2 as { created: string }).created, lastEvent: last }, {});
  const stub = `<script nonce="NONCE">(function(){var S=${JSON.stringify({ ...(st2 as object), lastEvent: last })};window.fetch=function(){return Promise.resolve({ok:true,status:200,json:function(){return Promise.resolve(S);}});};})();</script>`;
  writeFileSync(join(here, name), h.replace('<script nonce="NONCE">', stub + '<script nonce="NONCE">'));
  console.log("wrote", name);
};
staticPage(st, "page-e2e.html", NOW.toISOString());
staticPage(sampleStats("7d", NOW), "page-sample.html", new Date(NOW.getTime() - 3 * 60_000).toISOString());
