// HTML for https://genclass.dev/start (get a token) and https://genclass.dev/dashboard/<secret> (the dashboard).
// No external scripts, styles or fonts. Inline <script>/<style> run under a per-response CSP nonce; all dynamic text is
// inserted with textContent, never innerHTML.

export const CDN_SCRIPT = "https://cdn.jsdelivr.net/npm/@genclass/runtime";

export function securityHeaders(nonce: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; ` +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe to embed in <script type="application/json">. */
const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0E1F4D"/><path d="M9 21l5-10 4 7 2-3 3 6" fill="none" stroke="#14B86A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const CSS = `
:root{
  --paper:#fff;--panel:#F5F8FB;--ink:#0E1F4D;--ink2:#3D4B6B;--ink3:#5A6684;--rule:#DFE4EC;--rule2:#C6CEDB;
  --accent:#08794A;--accent-f:#14B86A;--accent-t:#DCF5E8;--warn:#C42A12;--warn-t:#FDE6E0;--bar:#0E1F4D;--bar2:#14B86A;--bar3:#F0451C;
  --code:#0B1736;--codeink:#E8EDF8;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root{
  --paper:#0B1736;--panel:#13224A;--ink:#E8EDF8;--ink2:#C3CCE2;--ink3:#97A3C2;--rule:#26355E;--rule2:#34467A;
  --accent:#4FD08F;--accent-f:#14B86A;--accent-t:#123A2C;--warn:#FF8A6B;--warn-t:#3A1C1A;--bar:#9DB2E8;--bar2:#3ED68A;--bar3:#FF7A55;
  --code:#060E24;--codeink:#E8EDF8;
}}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent-f);outline-offset:2px}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--rule)}
header.top .wrap{display:flex;align-items:center;gap:12px;height:56px}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;letter-spacing:-.02em;text-decoration:none}
.logo img{width:26px;height:26px}
header.top nav{margin-left:auto;display:flex;gap:16px;font-size:14px;color:var(--ink2)}
header.top nav a{text-decoration:none}
h1{font-size:clamp(26px,4vw,40px);line-height:1.1;letter-spacing:-.03em;font-weight:750}
h2{font-size:17px;letter-spacing:-.01em;font-weight:700;margin-bottom:10px}
p.lead{color:var(--ink2);font-size:16px;max-width:62ch;margin-top:10px}
.muted{color:var(--ink3)}
.small{font-size:13px}
.mono{font-family:var(--mono)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:0 16px;border-radius:8px;font:600 14px/1 var(--sans);cursor:pointer;border:1px solid var(--ink);background:var(--ink);color:var(--paper);text-decoration:none;white-space:nowrap}
.btn:disabled{opacity:.6;cursor:progress}
.btn.ghost{background:transparent;color:var(--ink);border-color:var(--rule2)}
.btn.ghost:hover{border-color:var(--ink)}
.btn.sm{min-height:30px;padding:0 10px;font-size:13px}
input[type=text]{min-height:42px;padding:0 12px;border-radius:8px;border:1px solid var(--rule2);background:var(--paper);color:var(--ink);font:15px var(--sans);width:100%}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:12px;padding:16px;min-width:0}
.grid{display:grid;gap:12px}
.kpis{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}
.cols{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.charts{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
@media (max-width:420px){.cols{grid-template-columns:1fr}}
.kpi .v{font-size:26px;font-weight:750;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .l{font-size:13px;color:var(--ink2)}
.kpi .s{font-size:12px;color:var(--ink3);margin-top:2px}
pre.code{background:var(--code);color:var(--codeink);border-radius:10px;padding:12px 14px;font:13px/1.55 var(--mono);overflow-x:auto;white-space:pre}
.snip>*+*{margin-top:6px}
.snip .between{align-items:center}
.note{border-left:3px solid var(--warn);background:var(--warn-t);padding:10px 12px;border-radius:6px;font-size:14px}
.ok{border-left-color:var(--accent-f);background:var(--accent-t)}
.pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rule2);border-radius:999px;padding:3px 10px;font-size:13px;color:var(--ink2)}
.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--ink3)}
.pill.live .dot{background:var(--accent-f)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tabs{display:inline-flex;border:1px solid var(--rule2);border-radius:8px;overflow:hidden}
.tabs button{border:0;background:transparent;color:var(--ink2);padding:7px 12px;font:600 13px var(--sans);cursor:pointer}
.tabs button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.bars{list-style:none;display:grid;gap:6px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:13px}
.bars .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono)}
.bars .n{font-variant-numeric:tabular-nums;color:var(--ink2)}
.bars .track{grid-column:1/-1;height:6px;border-radius:3px;background:var(--rule)}
.bars .fill{height:6px;border-radius:3px;background:var(--bar)}
.empty{color:var(--ink3);font-size:13px}
.chart svg{width:100%;height:120px;display:block}
.chart .axis{font-size:11px;color:var(--ink3);display:flex;justify-content:space-between;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);white-space:nowrap}
th{color:var(--ink3);font-weight:600}
td.mono{font-family:var(--mono)}
.tablewrap{overflow-x:auto}
section{margin-top:22px}
details summary{cursor:pointer;font-weight:700}
footer{margin:36px 0 28px;color:var(--ink3);font-size:13px}
.hidden{display:none!important}
.field{display:grid;gap:6px;max-width:520px}
.field label{font-size:14px;font-weight:600}
.stack>*+*{margin-top:12px}
.mt-xl{margin-top:44px}.mt-l{margin-top:28px}.mt-s{margin-top:12px}.big{font-size:16px}.brk{word-break:break-all}.h2l{font-size:20px}.between{justify-content:space-between;align-items:flex-end}.minw0{min-width:0}
`;

const SNIPPETS_JS = `
function snippets(tok){
  return [
    ["Easy: one script tag", "Paste into your HTML. GenClass starts itself and protects the whole app.",
     '<script src="${CDN_SCRIPT}" data-token="' + tok + '"></' + 'script>'],
    ["Easy: with a bundler", "A meta tag plus one import (npm i @genclass/runtime).",
     '<meta name="genclass" content="token=' + tok + '">\\n\\n// in your entry file\\nimport "@genclass/runtime/auto";'],
    ["Function-specific", "Protect only the functions you choose; the dashboard shows each by name.",
     'import { GenClass, protect } from "@genclass/runtime";\\n\\nGenClass.init({ token: "' + tok + '", scope: "functions" });\\nconst save = protect("saveCart", saveCartImpl);'],
    ["Automatic setup", "Run in your project folder: it detects your setup and wires GenClass (and a token) in for you.",
     'npx @genclass/runtime init']
  ];
}
function copyBtn(getText){
  var b = document.createElement("button"); b.type = "button"; b.className = "btn sm ghost"; b.textContent = "Copy";
  b.addEventListener("click", function(){
    var t = getText();
    var done = function(){ b.textContent = "Copied"; setTimeout(function(){ b.textContent = "Copy"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function(){ b.textContent = "Select and copy"; });
    else b.textContent = "Select and copy";
  });
  return b;
}
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function renderSnippets(host, tok){
  host.textContent = "";
  snippets(tok).forEach(function(s){
    var box = el("div", "snip");
    var head = el("div", "row between"); var h = el("h2", null, s[0]); h.style.marginBottom = "0";
    head.appendChild(h); head.appendChild(copyBtn(function(){ return s[2]; })); box.appendChild(head);
    box.appendChild(el("p", "muted small", s[1])); box.appendChild(el("pre", "code", s[2]));
    host.appendChild(box);
  });
}
`;

function shell(nonce: string, title: string, body: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap"><a class="logo" href="https://genclass.dev/"><img src="${ICON}" alt="">GenClass</a>
<nav><a href="https://genclass.dev/">Home</a><a href="/start">Get a token</a><a href="https://github.com/genclass-dev/GenClass-lib#readme">Docs</a></nav></div></header>
<main class="wrap">${body}</main>
<script nonce="${nonce}">${SNIPPETS_JS}${script}</script>
</body>
</html>`;
}

// ------------------------------------------------------------------------------------------------- /start

export function startPage(nonce: string): string {
  const body = `
<section class="stack mt-xl">
  <h1>Get a token for your web app</h1>
  <p class="lead">One token per app. Add it to GenClass and every page load, detection and fix shows up on your own
  private dashboard. Free, no account.</p>
</section>
<section>
  <form id="f" class="card stack" novalidate>
    <div class="field"><label for="name">App name <span class="muted small">(optional, shown on your dashboard)</span></label>
    <input id="name" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Acme checkout"></div>
    <div class="row"><button class="btn" id="go" type="submit">Get a token</button><span id="err" class="small" role="alert"></span></div>
  </form>
</section>
<section id="out" class="hidden stack" aria-live="polite">
  <div class="card stack">
    <h2>Your token</h2>
    <p class="muted small">Public: it goes in your app's code and only lets data be sent.</p>
    <div class="row"><code id="tok" class="mono big brk"></code><span id="tokc"></span></div>
  </div>
  <div class="card stack">
    <h2>Your private dashboard link</h2>
    <div class="note"><strong>Save this link now.</strong> It is the only way back to your dashboard; we cannot recover it.
    Anyone with the link can see your app's stats, so do not commit it to code.</div>
    <div class="row"><a id="dash" class="mono brk"></a><span id="dashc"></span></div>
    <div class="row"><a id="open" class="btn" href="#">Open dashboard</a></div>
  </div>
  <div class="card stack"><h2 class="h2l">Install</h2><div id="snips" class="stack"></div></div>
</section>
<footer>Dashboards show counts only (never the situation text) and keep data for 90 days.
See <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/PRIVACY.md">privacy</a> and
<a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">what is sent</a>.</footer>`;
  const script = `
(function(){
  var f = document.getElementById("f"), go = document.getElementById("go"), err = document.getElementById("err");
  f.addEventListener("submit", function(ev){
    ev.preventDefault(); err.textContent = ""; go.disabled = true; go.textContent = "Creating...";
    fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: document.getElementById("name").value }) })
      .then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })
      .then(function(x){
        if (x.s !== 201) throw new Error(x.s === 429 ? "Too many new tokens from your network. Try again in a minute." : (x.j && x.j.error) || "Something went wrong.");
        var j = x.j;
        document.getElementById("tok").textContent = j.token;
        document.getElementById("tokc").appendChild(copyBtn(function(){ return j.token; }));
        var d = document.getElementById("dash"); d.textContent = j.dashboardUrl; d.href = j.dashboardUrl;
        document.getElementById("dashc").appendChild(copyBtn(function(){ return j.dashboardUrl; }));
        document.getElementById("open").href = j.dashboardUrl;
        renderSnippets(document.getElementById("snips"), j.token);
        f.classList.add("hidden");
        var out = document.getElementById("out"); out.classList.remove("hidden"); out.scrollIntoView({ behavior: "smooth" });
      })
      .catch(function(e){ err.textContent = e.message || String(e); go.disabled = false; go.textContent = "Get a token"; });
  });
})();`;
  return shell(nonce, "Get a token | GenClass", body, script);
}

// ------------------------------------------------------------------------------------------------- 404

export function notFoundPage(nonce: string): string {
  return shell(
    nonce,
    "Dashboard not found | GenClass",
    `<section class="stack mt-xl"><h1>Dashboard not found</h1>
<p class="lead">This link does not match any GenClass dashboard. Check that you copied the whole link, or
<a href="/start">get a new token</a>.</p></section>`,
    "",
  );
}

// ------------------------------------------------------------------------------------------------- dashboard

// ---------------------------------------------------------------------------------------------- /dashboard
// The per-app dashboard: a one-sentence summary, four tiles, problems over time by type, one card per kind of
// problem (what it means, where it happened, how to fix it), pages, what GenClass did, model health, recent activity.
// Chart colours: the validated categorical order (dataviz reference palette, light and dark steps, checked against
// --panel); five problem types get a slot, the rest share "Other". Every dynamic string goes through textContent.

const DASH_CSS = `
:root{--t1:#2a78d6;--t2:#eb6834;--t3:#1baf7a;--t4:#eda100;--t5:#e87ba4;--t0:#8a93a8;--grid:#E6EAF1}
@media (prefers-color-scheme:dark){:root{--t1:#3987e5;--t2:#d95926;--t3:#199e70;--t4:#c98500;--t5:#d55181;--t0:#6f7b98;--grid:#22325C}}
.dh{margin-top:28px}
.dh-top{display:flex;flex-wrap:wrap;gap:16px;justify-content:space-between;align-items:flex-end}
.eyebrow{font:600 12px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink3);margin-bottom:6px}
.summary{margin-top:14px;font-size:clamp(17px,2vw,20px);line-height:1.45;max-width:72ch;color:var(--ink)}
.summary b{font-weight:700}
.tiles{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.tile{background:var(--panel);border:1px solid var(--rule);border-radius:14px;padding:16px 18px;min-width:0}
.tile .l{font-size:13px;color:var(--ink2);display:flex;align-items:center;gap:7px}
.tile .v{font-size:34px;font-weight:750;letter-spacing:-.03em;line-height:1.1;margin-top:6px}
.tile .s{font-size:13px;color:var(--ink3);margin-top:4px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block;flex:none}
.sw.bug{background:var(--bar3)}.sw.fix{background:var(--accent-f)}.sw.ink{background:var(--ink)}
.hd{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:12px}
.hd h2{margin:0}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--ink2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.plot{position:relative}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot text{font:11px var(--sans);fill:var(--ink3)}
.tip{position:absolute;pointer-events:none;background:var(--paper);border:1px solid var(--rule2);border-radius:10px;padding:8px 10px;font-size:12.5px;box-shadow:0 6px 20px rgba(14,31,77,.12);min-width:150px;z-index:2}
.tip .t{font-weight:700;margin-bottom:4px}
.tip .r{display:flex;align-items:center;gap:6px;justify-content:space-between}
.tip .r span:first-child{display:inline-flex;align-items:center;gap:6px;color:var(--ink2)}
.tip .r b{font-variant-numeric:tabular-nums}
.issues{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(330px,1fr))}
@media (max-width:420px){.issues{grid-template-columns:1fr}}
.issue{background:var(--panel);border:1px solid var(--rule);border-radius:14px;padding:16px 18px;min-width:0;display:grid;gap:10px;align-content:start}
.issue .top{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.issue h3{font-size:16px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.issue .n{font-size:26px;font-weight:750;letter-spacing:-.02em;line-height:1;text-align:right}
.issue .n small{display:block;font-size:12px;font-weight:500;color:var(--ink3);margin-top:3px;letter-spacing:0}
.issue p{font-size:13.5px;color:var(--ink2)}
.issue .fix{border-top:1px solid var(--rule);padding-top:10px}
.issue .fix b{color:var(--ink);font-weight:650}
.where{list-style:none;display:grid;gap:4px;font-size:13px}
.where li{display:flex;justify-content:space-between;gap:10px}
.where code{font:12.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.where span{color:var(--ink3);font-variant-numeric:tabular-nums;flex:none}
.spark{display:block;width:100%;height:24px}
.two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
@media (max-width:420px){.two{grid-template-columns:1fr}}
.prow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--rule)}
.prow:last-child{border-bottom:0}
.prow code{font:12.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prow .c{font-variant-numeric:tabular-nums;color:var(--ink2)}
.seg{grid-column:1/-1;display:flex;gap:2px;height:8px}
.seg i{display:block;height:8px;border-radius:2px;min-width:3px}
.health{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.hb{border:1px solid var(--rule);border-radius:12px;padding:12px 14px;background:var(--paper)}
.hb .l{font-size:12.5px;color:var(--ink3)}
.hb .v{font-size:20px;font-weight:700;margin-top:2px;letter-spacing:-.01em}
.hb .v.sm{font-size:15px;line-height:1.35}
.hb ul{list-style:none;margin-top:4px;display:grid;gap:2px;font-size:12.5px;color:var(--ink2)}
.hb ul li{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hb .s{font-size:12.5px;color:var(--ink2);margin-top:2px}
.flag{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600}
.flag.ok{color:var(--accent)}.flag.bad{color:var(--warn)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap}
.did{font-size:12.5px}
.did.acted{color:var(--accent);font-weight:600}
.quiet{padding:28px 8px;text-align:center;color:var(--ink3);font-size:14px}
.privacy{display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--ink2)}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
`;

const DASH_JS = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var secret = location.pathname.split("/").filter(Boolean)[1] || "";
  var range = "7d";
  try { var saved = localStorage.getItem("gc.dash.range"); if (saved === "24h" || saved === "7d" || saved === "30d") range = saved; } catch (e) {}
  var nf = new Intl.NumberFormat();
  function fmt(n){ return nf.format(Math.round(n || 0)); }
  function plural(n, one, many){ return fmt(n) + " " + (Math.round(n) === 1 ? one : many); }
  var RANGE = { "24h": "In the last 24 hours", "7d": "In the last 7 days", "30d": "In the last 30 days" };
  var PREV = { "24h": "the 24 hours before", "7d": "the previous 7 days", "30d": "the previous 30 days" };
  var TYPES = {
    duplicate: { name: "Double submits", c: "--t1",
      what: "The same request was sent again with no new intent behind it. Usually a second click on a button that stays enabled while the first request is still running.",
      fix: "Disable the control while the request is in flight, or send an idempotency key so the server ignores the repeat. In guard mode GenClass can merge the repeat into the request already running." },
    stale: { name: "Stale responses", c: "--t2",
      what: "An older response arrived after newer data and was about to replace it, like results for \\u201cpa\\u201d under a search box that says \\u201cparis\\u201d.",
      fix: "Ignore responses that are no longer the latest, with an AbortController or a request counter. In guard mode GenClass can drop the stale write." },
    failing: { name: "Failing endpoints", c: "--t3",
      what: "An endpoint kept failing while the app kept calling it.",
      fix: "Back off after repeated failures and tell the user something is wrong instead of retrying in silence." },
    slow: { name: "Slow operations", c: "--t4",
      what: "An operation took far longer than it usually does on this app.",
      fix: "Check that endpoint's latency around these times, and show progress while users wait." },
    conflict: { name: "Write races", c: "--t5",
      what: "Two operations wrote the same state at about the same time, and whichever landed last won.",
      fix: "Send writes to the same field one at a time, or merge a server echo with what the user changed since." },
    transient: { name: "One-off failures", c: "--t0",
      what: "A request failed once in a way that usually succeeds on a second try.",
      fix: "Retry idempotent requests once after a short delay. In heal mode GenClass can retry them for you." },
    inconsistent: { name: "Broken state", c: "--t0",
      what: "Your state broke a rule it normally keeps, such as a cart total that no longer matches its lines.",
      fix: "Find the write that updated one of the fields without the other." },
    overload: { name: "Request storms", c: "--t0",
      what: "Work was triggered far more often than usual, often by a polling or re-render loop.",
      fix: "Debounce or deduplicate whatever triggers the requests." },
    unusual: { name: "Unusual behaviour", c: "--t0",
      what: "An operation did something different from what it normally does, such as writing fewer fields than usual.",
      fix: "Compare the operation's result with what it usually returns." }
  };
  var SLOTS = ["duplicate", "stale", "failing", "slow", "conflict"];
  var ACTIONS = { coalesce: "Merged a repeated request", discard: "Dropped a stale write", defer: "Waited for related requests", delay: "Delayed a request",
    retry: "Retried a failed request", serve_cached: "Answered from cache", block: "Blocked a request", hedge: "Sent a backup request", rollback: "Rolled back a write", resync: "Re-synced state" };
  function T(k){ return TYPES[k] || { name: k && k !== "(unknown)" ? k.charAt(0).toUpperCase() + k.slice(1) : "Other", c: "--t0", what: "", fix: "" }; }
  function slotOf(k){ return SLOTS.indexOf(k) >= 0 ? k : "other"; }
  function colorOf(slot){ return "var(" + (slot === "other" ? "--t0" : TYPES[slot].c) + ")"; }
  function sw(color){ var s = el("span", "sw"); s.style.background = color; return s; }
  function ago(iso){
    var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return Math.round(s) + " s ago"; if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " days ago";
  }
  function label(b, hourly){
    var d = new Date(hourly ? b + ":00:00Z" : b + "T00:00:00Z");
    return hourly ? d.toLocaleTimeString([], { hour: "numeric" }) : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  }
  function share(a, b){ if (!b) return "-"; var r = 100 * a / b; return (r > 99.5 && a < b ? Math.floor(r * 10) / 10 : Math.round(r)) + "%"; }
  function sum(list){ return (list || []).reduce(function(s, x){ return s + x.count; }, 0); }
  function map(list){ var m = {}; (list || []).forEach(function(x){ m[x.key] = (m[x.key] || 0) + x.count; }); return m; }
  function issues(B){
    var out = {};
    (B.detect_issue || []).forEach(function(x){
      var i = x.key.indexOf("\\t"); if (i < 0) return;
      var d = x.key.slice(0, i), r = x.key.slice(i + 1);
      (out[d] = out[d] || []).push({ route: r, count: x.count });
    });
    return out;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs){ var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function niceMax(v){ if (v <= 4) return 4; var p = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  // ---------- summary and tiles
  function summary(S){
    var T0 = S.totals, B = S.breakdowns, host = document.getElementById("summary"); host.textContent = "";
    var pages = (B.detect_route || []).length, modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0;
    function put(t, bold){ host.appendChild(bold ? el("b", null, t) : document.createTextNode(t)); }
    if (!T0.sessions) { put("No page loads in this period yet."); return; }
    put(RANGE[S.range] + " GenClass watched "); put(plural(T0.sessions, "page load", "page loads"), true);
    if (!T0.detections) { put(" and found nothing wrong. It only reports situations that stand out, so a quiet stretch is normal."); return; }
    put(" and found "); put(plural(T0.detections, "problem", "problems"), true);
    if (pages) { put(" on "); put(plural(pages, "page", "pages"), true); }
    put(". ");
    if (acting && T0.interventions) { put("It stepped in "); put(plural(T0.interventions, "time", "times"), true); var u = map(B.action_outcome).undone || 0; put(u ? ", and " + plural(u, "change was", "changes were") + " undone." : ", and nothing it changed was undone."); }
    else if (acting) put("It is allowed to step in and did not need to.");
    else put("It is in observe mode, so it reported them and changed nothing.");
  }
  function delta(now, before){
    if (!before && !now) return "";
    if (!before) return "none in " + PREV[range];
    var d = now - before; if (!d) return "same as " + PREV[range];
    return (d > 0 ? "\\u2191 " : "\\u2193 ") + fmt(Math.abs(d)) + " vs " + PREV[range];
  }
  function tile(sw0, label0, value, sub){
    var t = el("div", "tile"); var l = el("div", "l"); if (sw0) l.appendChild(el("span", "sw " + sw0)); l.appendChild(document.createTextNode(label0)); t.appendChild(l);
    t.appendChild(el("div", "v", value)); if (sub) t.appendChild(el("div", "s", sub)); return t;
  }
  function tiles(S){
    var T0 = S.totals, B = S.breakdowns, host = document.getElementById("tiles"); host.textContent = "";
    var ready = T0.model_ready || 0, failed = T0.model_load_failed || 0, modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0;
    var outcomes = map(B.action_outcome), applied = outcomes.applied || T0.interventions || 0, undone = outcomes.undone || 0;
    host.appendChild(tile("bug", "Problems found", fmt(T0.detections), delta(T0.detections || 0, (S.previous || {}).detections || 0)));
    host.appendChild(tile("ink", "Pages affected", fmt((B.detect_route || []).length), (B.page_route || []).length ? "of " + plural((B.page_route || []).length, "page", "pages") + " that sent data" : ""));
    host.appendChild(tile("fix", "Stopped by GenClass", fmt(T0.interventions), acting ? (applied ? Math.round(100 * undone / applied) + "% undone by users" : "nothing needed stopping") : "observe mode: reports only"));
    host.appendChild(tile(null, "Model loaded", share(ready, ready + failed), ready ? "avg " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") + ", " + plural(failed, "failure", "failures") : "no model loads yet"));
  }

  // ---------- problems over time
  function trend(S){
    var host = document.getElementById("trendplot"), leg = document.getElementById("legend"), tbl = document.getElementById("trendtable");
    host.textContent = ""; leg.textContent = ""; tbl.textContent = "";
    var hourly = S.range === "24h";
    var rows = (S.typeSeries || []).map(function(b){
      var o = { bucket: b.bucket, total: 0, parts: {} };
      Object.keys(b.counts).forEach(function(k){ var s = slotOf(k); o.parts[s] = (o.parts[s] || 0) + b.counts[k]; o.total += b.counts[k]; });
      return o;
    });
    var order = SLOTS.concat(["other"]).filter(function(s){ return rows.some(function(r){ return r.parts[s]; }); });
    var total = rows.reduce(function(s, r){ return s + r.total; }, 0);
    document.getElementById("trendn").textContent = plural(total, "problem", "problems");
    if (!total) { host.appendChild(el("div", "quiet", "No problems found in this period.")); return; }
    if (order.length > 1) order.forEach(function(s){ var x = el("span"); x.appendChild(sw(colorOf(s))); x.appendChild(document.createTextNode(s === "other" ? "Other" : TYPES[s].name)); leg.appendChild(x); });
    var W = 720, H = 210, PL = 30, PB = 24, PT = 6, n = rows.length, plotW = W - PL, plotH = H - PB - PT;
    var max = niceMax(Math.max.apply(null, rows.map(function(r){ return r.total; })));
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Problems found per " + (hourly ? "hour" : "day") + " by type" });
    [0, max / 2, max].forEach(function(v){
      var y = PT + plotH - plotH * v / max;
      g.appendChild(svg("line", { x1: PL, x2: W, y1: y, y2: y, stroke: v ? "var(--grid)" : "var(--rule2)", "stroke-width": 1 }));
      if (v === Math.round(v)) { var t = svg("text", { x: PL - 6, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(v); g.appendChild(t); }
    });
    var step = plotW / n, bw = Math.max(2, Math.min(28, step * 0.64));
    var tip = el("div", "tip hidden");
    rows.forEach(function(r, i){
      var x = PL + i * step + (step - bw) / 2, y = PT + plotH, drawn = order.filter(function(s){ return r.parts[s]; });
      drawn.forEach(function(s, j){
        var h = plotH * r.parts[s] / max; y -= h;
        g.appendChild(svg("rect", { x: x, y: y, width: bw, height: Math.max(1, h), rx: j === drawn.length - 1 ? 3 : 0, fill: colorOf(s), stroke: "var(--panel)", "stroke-width": drawn.length > 1 ? 1 : 0 }));
      });
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
      var hit = svg("rect", { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent", tabindex: 0 });
      function show(){
        tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly) + ": " + plural(r.total, "problem", "problems")));
        order.forEach(function(s){ if (!r.parts[s]) return; var row = el("div", "r"); var a = el("span"); a.appendChild(sw(colorOf(s))); a.appendChild(document.createTextNode(s === "other" ? "Other" : TYPES[s].name)); row.appendChild(a); row.appendChild(el("b", null, fmt(r.parts[s]))); tip.appendChild(row); });
        tip.classList.remove("hidden");
        var box = host.getBoundingClientRect(), left = (PL + i * step + step / 2) / W * box.width;
        tip.style.left = Math.min(Math.max(0, left - 80), box.width - 170) + "px"; tip.style.top = "0px";
      }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.classList.add("hidden"); }); hit.addEventListener("blur", function(){ tip.classList.add("hidden"); });
      g.appendChild(hit);
    });
    host.appendChild(g); host.appendChild(tip);
    var tb = el("table"), hr = el("tr"); hr.appendChild(el("th", null, hourly ? "Hour" : "Day")); order.forEach(function(s){ hr.appendChild(el("th", null, s === "other" ? "Other" : TYPES[s].name)); }); hr.appendChild(el("th", null, "Total"));
    var th = el("thead"); th.appendChild(hr); tb.appendChild(th); var body = el("tbody");
    rows.forEach(function(r){ var tr = el("tr"); tr.appendChild(el("td", null, label(r.bucket, hourly))); order.forEach(function(s){ tr.appendChild(el("td", null, fmt(r.parts[s] || 0))); }); tr.appendChild(el("td", null, fmt(r.total))); body.appendChild(tr); });
    tb.appendChild(body); var wrap = el("div", "tablewrap"); wrap.appendChild(tb); tbl.appendChild(wrap);
  }

  // ---------- one card per kind of problem
  function spark(S, d){
    var vals = (S.typeSeries || []).map(function(b){ return b.counts[d] || 0; }), n = vals.length, max = Math.max.apply(null, vals) || 1;
    var g = svg("svg", { viewBox: "0 0 " + (n * 10) + " 24", preserveAspectRatio: "none", "class": "spark", "aria-hidden": "true" });
    g.appendChild(svg("line", { x1: 0, x2: n * 10, y1: 23.5, y2: 23.5, stroke: "var(--rule)", "stroke-width": 1 }));
    vals.forEach(function(v, i){ if (!v) return; var h = Math.max(2, 22 * v / max); g.appendChild(svg("rect", { x: i * 10 + 3, y: 23 - h, width: 4, height: h, rx: 1, fill: colorOf(slotOf(d)) })); });
    return g;
  }
  function cards(S){
    var B = S.breakdowns, host = document.getElementById("issues"), byIssue = issues(B); host.textContent = "";
    var list = (B.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; }), total = sum(list);
    document.getElementById("issuesempty").classList.toggle("hidden", list.length > 0);
    var recentBy = {};
    (S.recent || []).forEach(function(r){ if (r.kind === "detect" && r.diagnosis && r.route) { var m = recentBy[r.diagnosis] = recentBy[r.diagnosis] || {}; m[r.route] = (m[r.route] || 0) + 1; } });
    list.forEach(function(x){
      var t = T(x.key), c = el("article", "issue");
      var top = el("div", "top"), h = el("h3"); h.appendChild(sw(colorOf(slotOf(x.key)))); h.appendChild(document.createTextNode(t.name)); top.appendChild(h);
      var n = el("div", "n", fmt(x.count)); n.appendChild(el("small", null, total ? Math.round(100 * x.count / total) + "% of problems" : "")); top.appendChild(n); c.appendChild(top);
      c.appendChild(spark(S, x.key));
      if (t.what) c.appendChild(el("p", null, t.what));
      var where = (byIssue[x.key] || []).slice().sort(function(a, b){ return b.count - a.count; });
      if (!where.length && recentBy[x.key]) where = Object.keys(recentBy[x.key]).map(function(r){ return { route: r, count: recentBy[x.key][r] }; }).sort(function(a, b){ return b.count - a.count; });
      if (where.length) {
        var ul = el("ul", "where");
        where.slice(0, 4).forEach(function(w){ var li = el("li"); li.appendChild(el("code", null, w.route)); li.appendChild(el("span", null, fmt(w.count))); ul.appendChild(li); });
        c.appendChild(ul);
      }
      if (t.fix) { var f = el("p", "fix"); f.appendChild(el("b", null, "How to fix it: ")); f.appendChild(document.createTextNode(t.fix)); c.appendChild(f); }
      host.appendChild(c);
    });
  }

  // ---------- pages, actions, health
  function pages(S){
    var B = S.breakdowns, host = document.getElementById("pages"), byIssue = issues(B); host.textContent = "";
    var routes = {};
    Object.keys(byIssue).forEach(function(d){ byIssue[d].forEach(function(w){ var r = routes[w.route] = routes[w.route] || { route: w.route, total: 0, parts: {} }; var s = slotOf(d); r.parts[s] = (r.parts[s] || 0) + w.count; r.total += w.count; }); });
    var list = Object.keys(routes).map(function(k){ return routes[k]; });
    if (!list.length) list = (B.detect_route || []).map(function(x){ return { route: x.key, total: x.count, parts: {} }; });
    list.sort(function(a, b){ return b.total - a.total; });
    if (!list.length) { host.appendChild(el("p", "empty", "No problems on any page in this period.")); return; }
    var max = list[0].total || 1;
    list.slice(0, 8).forEach(function(r){
      var row = el("div", "prow"); row.appendChild(el("code", null, r.route)); row.appendChild(el("span", "c", fmt(r.total)));
      var seg = el("div", "seg"), parts = SLOTS.concat(["other"]).filter(function(s){ return r.parts[s]; });
      if (!parts.length) { var i0 = el("i"); i0.style.width = (100 * r.total / max) + "%"; i0.style.background = "var(--bar3)"; seg.appendChild(i0); }
      parts.forEach(function(s){ var i = el("i"); i.style.width = (100 * r.parts[s] / max) + "%"; i.style.background = colorOf(s); i.title = (s === "other" ? "Other" : TYPES[s].name) + ": " + fmt(r.parts[s]); seg.appendChild(i); });
      row.appendChild(seg); host.appendChild(row);
    });
  }
  function acted(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("acted"); host.textContent = "";
    var modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0, list = B.intervention || [];
    if (!list.length) {
      host.appendChild(el("p", "empty", acting ? "GenClass did not need to step in during this period." : "This app runs in observe mode, so GenClass only reports. Switch to guard mode when you trust what it reports, and its interventions will show here."));
      return;
    }
    var max = list[0].count || 1;
    list.slice(0, 8).forEach(function(x){
      var row = el("div", "prow"); row.appendChild(el("span", null, ACTIONS[x.key] || x.key)); row.appendChild(el("span", "c", fmt(x.count)));
      var seg = el("div", "seg"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; seg.appendChild(i); row.appendChild(seg); host.appendChild(row);
    });
    var o = map(B.action_outcome), applied = o.applied || T0.interventions || 0;
    host.appendChild(el("p", "muted small mt-s", plural(o.undone || 0, "change", "changes") + " undone by users" + (applied ? " (" + Math.round(100 * (o.undone || 0) / applied) + "%)" : "") + (o.failed ? ", " + plural(o.failed, "action", "actions") + " failed" : "") + "."));
  }
  function hb(label0, value, sub, flag){
    var b = el("div", "hb"); b.appendChild(el("div", "l", label0)); var v = el("div", "v", value); b.appendChild(v);
    if (flag) { var f = el("span", "flag " + flag[0], flag[1]); b.appendChild(f); }
    if (sub) b.appendChild(el("div", "s", sub)); return b;
  }
  function health(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("health"); host.textContent = "";
    var ready = T0.model_ready || 0, failed = T0.model_load_failed || 0;
    var errs = (B.model_errors && B.model_errors.length) ? B.model_errors : (B.model_error_events || []);
    host.appendChild(hb("Model loads", ready + failed ? share(ready, ready + failed) + " succeeded" : "-", plural(ready, "load", "loads") + ", " + plural(failed, "failure", "failures"), failed ? ["bad", "\\u25B2 needs a look"] : ready ? ["ok", "\\u2713 healthy"] : null));
    var be = B.backend || [], beTot = sum(be);
    var wb = hb("Where it ran", be.length ? be.map(function(x){ return (x.key === "webgpu" ? "WebGPU" : x.key === "wasm" ? "WASM" : x.key) + " " + Math.round(100 * x.count / beTot) + "%"; }).join(", ") : "-", T0.modelLoadAvgMs ? "average load " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") : "");
    wb.querySelector(".v").classList.add("sm"); host.appendChild(wb);
    host.appendChild(hb("Decision time", T0.latency_ms_n ? fmt(T0.latencyAvgMs) + " ms" : "-", T0.latency_ms_n ? "average over " + plural(T0.latency_ms_n, "decision", "decisions") : "no decisions yet"));
    host.appendChild(hb("Ran without a decision", fmt(T0.failOpens), "times the app went ahead unprotected (model not ready, budget, hidden tab)", T0.failOpens ? null : ["ok", "\\u2713 none"]));
    if (errs.length) {
      var eb = hb("Load errors", plural(sum(errs), "error", "errors"), null, ["bad", "\\u25B2 the model did not load on these page loads"]), ul = el("ul");
      errs.slice(0, 4).forEach(function(x){ var li = el("li", null, fmt(x.count) + " \\u00D7 " + x.key); li.title = x.key; ul.appendChild(li); });
      eb.appendChild(ul); host.appendChild(eb);
    }
    var rv = B.runtime || [];
    if (rv.length) host.appendChild(hb("Runtime versions", rv.slice(0, 3).map(function(x){ return x.key; }).join(", "), rv.length > 1 ? "more than one version is live" : ""));
  }
  function recent(S){
    var tb = document.getElementById("recent"); tb.textContent = "";
    (S.recent || []).forEach(function(r){
      var tr = el("tr");
      var t = el("td", null, new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })); t.title = r.t; tr.appendChild(t);
      tr.appendChild(el("td", "mono", [r.route, r.fn ? "fn " + r.fn : null].filter(Boolean).join("  ") || "-"));
      var w = el("td"), ch = el("span", "chip"); ch.appendChild(sw(colorOf(slotOf(r.diagnosis)))); ch.appendChild(document.createTextNode(r.diagnosis ? T(r.diagnosis).name : (r.trigger || "-"))); w.appendChild(ch); tr.appendChild(w);
      tr.appendChild(el("td", null, typeof r.confidence === "number" ? Math.round(r.confidence * 100) + "%" : "-"));
      var did = r.kind === "acted" && r.executed && r.ran && r.ran !== "deliver" && r.ran !== "send" && r.ran !== "apply";
      tr.appendChild(el("td", "did" + (did ? " acted" : ""), did ? (ACTIONS[r.ran] || r.ran) : "Reported"));
      tr.appendChild(el("td", null, r.mode || "-"));
      tb.appendChild(tr);
    });
    document.getElementById("recent0").classList.toggle("hidden", (S.recent || []).length > 0);
  }
  function advanced(S){
    var B = S.breakdowns, host = document.getElementById("adv"); host.textContent = "";
    [["Triggers", B.trigger], ["Diagnoses (all decisions)", B.diagnosis], ["Top routes (decisions)", B.route], ["Top pages (page loads)", B.page_route], ["Protected functions", B.fn],
     ["Model load states", B.model_state], ["Decision latency", B.latency_bucket], ["Fail-opens (reason:trigger)", B.fail_open], ["Modes", B.mode], ["Model versions", B.model_version],
     ["Hosts seen", B.host]].forEach(function(p){
      var c = el("div"); c.appendChild(el("h2", null, p[0]));
      if (!p[1] || !p[1].length) { c.appendChild(el("p", "empty", "None in this period.")); host.appendChild(c); return; }
      var max = p[1][0].count || 1, ul = el("ul", "bars");
      p[1].slice(0, 10).forEach(function(x){ var li = el("li"); var k = el("span", "k", x.key); k.title = x.key; li.appendChild(k); li.appendChild(el("span", "n", fmt(x.count))); var tr = el("span", "track"); var fi = el("span", "fill"); fi.style.display = "block"; fi.style.width = Math.max(2, 100 * x.count / max) + "%"; tr.appendChild(fi); li.appendChild(tr); ul.appendChild(li); });
      c.appendChild(ul); host.appendChild(c);
    });
  }

  function render(S){
    var live = !!S.lastEvent, st = document.getElementById("status");
    st.classList.toggle("live", live);
    document.getElementById("statust").textContent = live ? "Last event " + ago(S.lastEvent) : "Waiting for the first event";
    document.getElementById("updated").textContent = "Updated " + new Date(S.generated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    document.getElementById("nodata").classList.toggle("hidden", live);
    document.getElementById("content").classList.toggle("hidden", !live);
    if (!live) { document.getElementById("install").open = true; return; }
    summary(S); tiles(S); trend(S); cards(S); pages(S); acted(S); health(S); recent(S); advanced(S);
  }

  document.getElementById("pname").textContent = P.name;
  document.title = P.name + " | GenClass dashboard";
  document.getElementById("ptok").textContent = P.token;
  document.getElementById("ptokc").appendChild(copyBtn(function(){ return P.token; }));
  renderSnippets(document.getElementById("snips"), P.token);
  var btn = document.getElementById("refresh");
  function load(){
    btn.disabled = true;
    fetch("/api/projects/" + encodeURIComponent(secret) + "?range=" + range, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function(e){ document.getElementById("updated").textContent = "Could not load stats (" + e.message + "). Retrying in a minute."; })
      .then(function(){ btn.disabled = false; });
  }
  document.querySelectorAll(".tabs button").forEach(function(b){
    b.setAttribute("aria-pressed", String(b.getAttribute("data-r") === range));
    b.addEventListener("click", function(){
      range = b.getAttribute("data-r");
      try { localStorage.setItem("gc.dash.range", range); } catch (e) {}
      document.querySelectorAll(".tabs button").forEach(function(o){ o.setAttribute("aria-pressed", String(o === b)); });
      load();
    });
  });
  btn.addEventListener("click", load);
  setInterval(function(){ if (document.visibilityState === "visible") load(); }, 60000);
  load();
})();`;

export function dashboardPage(nonce: string, project: { name: string; token: string; created: string; lastEvent: string | null }): string {
  const body = `
<script type="application/json" id="project">${embed(project)}</script>
<style nonce="${nonce}">${DASH_CSS}</style>
<section class="dh">
  <div class="dh-top">
    <div class="minw0">
      <p class="eyebrow">Dashboard</p>
      <h1 id="pname"></h1>
      <div class="row small mt-s"><span class="pill" id="status"><span class="dot"></span><span id="statust">Loading</span></span><span class="muted" id="updated"></span></div>
    </div>
    <div class="row">
      <div class="tabs" role="group" aria-label="Time range">
        <button type="button" data-r="24h" aria-pressed="false">24 h</button><button type="button" data-r="7d" aria-pressed="true">7 days</button><button type="button" data-r="30d" aria-pressed="false">30 days</button>
      </div>
      <button class="btn ghost sm" id="refresh" type="button">Refresh</button>
    </div>
  </div>
  <p class="summary" id="summary"></p>
</section>
<section id="nodata" class="hidden"><div class="note ok">No data yet. Add the snippet below to your app, load a page, and come back in a
minute. Events arrive in batches every 10 seconds and when a tab is hidden. Local hosts (localhost, *.test) only send data with an explicit token.</div></section>
<div id="content" class="hidden">
<section class="tiles" id="tiles"></section>
<section class="card">
  <div class="hd"><h2>Problems found <span class="muted small" id="trendn"></span></h2><div class="legend" id="legend"></div></div>
  <div class="plot" id="trendplot"></div>
  <details class="mt-s"><summary class="small">Table view</summary><div id="trendtable" class="mt-s"></div></details>
</section>
<section>
  <div class="hd"><h2>What GenClass found</h2><span class="muted small">Each kind of problem, where it happened and how to fix it</span></div>
  <div class="issues" id="issues"></div>
  <p class="empty hidden" id="issuesempty">No problems found in this period.</p>
</section>
<section class="two">
  <div class="card"><div class="hd"><h2>Pages with the most problems</h2></div><div id="pages"></div></div>
  <div class="card"><div class="hd"><h2>What GenClass did</h2></div><div id="acted"></div></div>
</section>
<section class="card">
  <div class="hd"><h2>Model and runtime health</h2><span class="muted small">Whether GenClass could watch your pages at all</span></div>
  <div class="health" id="health"></div>
</section>
<section class="card">
  <div class="hd"><h2>Recent activity</h2><span class="muted small">The latest 50 detections and interventions</span></div>
  <div class="tablewrap"><table><thead><tr><th>Time</th><th>Page / function</th><th>What</th><th>Confidence</th><th>GenClass</th><th>Mode</th></tr></thead>
  <tbody id="recent"></tbody></table></div>
  <p class="empty hidden" id="recent0">Nothing detected in this period.</p>
</section>
<section class="card"><details><summary>All breakdowns</summary><div class="kv mt-s" id="adv"></div></details></section>
</div>
<section class="card"><details id="install"><summary>Setup: your token and install snippets</summary>
  <div class="row small mt-s"><span class="muted">Token</span><code id="ptok" class="mono brk"></code><span id="ptokc"></span></div>
  <div id="snips" class="stack mt-s"></div></details></section>
<footer><div class="privacy"><span class="sw fix" aria-hidden="true"></span><span>What this page shows is counts only: the kind of problem,
the page route, confidence, what GenClass did and how fast it decided. No text from your pages, no IP addresses and no user agents are stored.
Data is kept 90 days (hourly detail 48 hours). Keep this link private: anyone with it can see these stats.
<a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a> · <a href="/start">Get another token</a></span></div></footer>`;
  return shell(nonce, `${project.name} | GenClass dashboard`, body, DASH_JS);
}
