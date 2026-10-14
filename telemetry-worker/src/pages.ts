// HTML for https://genclass.dev/start (get a token) and https://genclass.dev/dashboard/<secret> (the dashboard), and
// the shell and dashboard the account pages (src/account-pages.ts) reuse: /account/apps/<id> is this dashboard in its
// account mode (the account's apps in the sidebar, the Connect panel, stats from the account API).
// No external scripts; styles and fonts only from Google Fonts. Inline <script>/<style> run under a per-response CSP
// nonce; dynamic text is inserted with textContent in scripts and escaped (esc) in server-rendered HTML.

export const CDN_SCRIPT = "https://cdn.jsdelivr.net/npm/@genclass/runtime";

/**
 * Headers for every HTML page. `account: true` (the account pages) allows same-origin form posts (the sign-out form)
 * and uses the referrer policy `same-origin`: with `no-referrer` browsers send `Origin: null` on a same-origin form
 * post, which the CSRF check refuses; `same-origin` still sends no referrer to any other site.
 */
export function securityHeaders(nonce: string, extra: Record<string, string> = {}, opts: { account?: boolean } = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": opts.account ? "same-origin" : "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "content-security-policy":
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; ` +
      `img-src 'self' data: https://genclass.dev; base-uri 'none'; form-action ${opts.account ? "'self'" : "'none'"}; frame-ancestors 'none'`,
    ...extra,
  };
}

/** HTML-escape text for element content and quoted attributes. */
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** JSON safe to embed in <script type="application/json">. */
export const embed = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

/** The header lockup: the mark from genclass.dev beside the name set in type ("gen" ink, "class" green). */
export const LOGO =
  '<a class="logo" href="https://genclass.dev/" aria-label="GenClass home"><img src="https://genclass.dev/brand/mark-64.png" alt="" width="26" height="26"><span class="wm"><span>gen</span><span class="g">class</span></span></a>';

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
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--rule)}
header.top .wrap{display:flex;align-items:center;gap:12px;height:56px}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;letter-spacing:-.02em;text-decoration:none}
.logo img{width:26px;height:26px}
.logo .wm{font-family:"Outfit","Helvetica Neue",Arial,sans-serif;font-weight:700;letter-spacing:-.03em}
.logo .wm .g{color:var(--accent-f)}
header.top nav a{font-family:"Figtree",system-ui,sans-serif}
header.top nav{margin-left:auto;display:flex;gap:16px;font-size:14px;color:var(--ink2);align-items:center}
header.top nav a{text-decoration:none}
header.top nav form.so{display:contents}
header.top nav .so button,button.lnk{background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer;font-family:"Figtree",system-ui,sans-serif}
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
.skip{position:absolute;left:12px;top:-60px;z-index:20;background:var(--ink);color:var(--paper);padding:10px 14px;border-radius:8px;font-size:14px;text-decoration:none}
.skip:focus{top:12px}
[tabindex="-1"]:focus{outline:none}
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
function gcSelect(node){
  try { var r = document.createRange(); r.selectNodeContents(node); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); return true; } catch (e) { return false; }
}
// Copy text with the Clipboard API; when the browser refuses, select it in node so the person can copy it by hand.
function gcCopy(b, text, node){
  var label = b.getAttribute("data-label") || b.textContent;
  b.setAttribute("data-label", label);
  function say(t){ b.textContent = t; clearTimeout(b.gcT); b.gcT = setTimeout(function(){ b.textContent = label; }, 2500); }
  function fallback(){ say(node && gcSelect(node) ? "Selected, now copy" : "Could not copy"); }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function(){ say("Copied"); }, fallback);
  else fallback();
}
function copyBtn(getText, name, getNode){
  var b = document.createElement("button"); b.type = "button"; b.className = "btn sm ghost"; b.textContent = "Copy";
  if (name) b.setAttribute("aria-label", "Copy " + name);
  b.addEventListener("click", function(){ gcCopy(b, getText(), getNode ? getNode() : null); });
  return b;
}
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function renderSnippets(host, tok){
  host.textContent = "";
  snippets(tok).forEach(function(s){
    var box = el("div", "snip"), pre = el("pre", "code", s[2]);
    var head = el("div", "row between"); var h = el("h2", null, s[0]); h.style.marginBottom = "0";
    head.appendChild(h); head.appendChild(copyBtn(function(){ return s[2]; }, s[0], function(){ return pre; })); box.appendChild(head);
    box.appendChild(el("p", "muted small", s[1])); box.appendChild(pre);
    host.appendChild(box);
  });
}
`;

export interface ShellOptions {
  /** Header links (HTML). Default: Home, Get a token, Docs, Sign in. */
  nav?: string;
  /** No top header: the sign-in pages put the lockup at the top of their own column. */
  bare?: boolean;
  /** An account page: the referrer policy `same-origin` (see securityHeaders), which the meta tag must repeat. */
  account?: boolean;
  /** The id the "Skip to content" link jumps to (default the <main> element; pages with a sidebar name their content). */
  skip?: string;
}

const DEFAULT_NAV =
  '<a href="https://genclass.dev/">Home</a><a href="/start">Get a token</a><a href="https://github.com/genclass-dev/GenClass-lib#readme">Docs</a><a href="/login">Sign in</a>';

/** The page frame shared by every page this worker serves. */
export function shell(nonce: string, title: string, body: string, script: string, opts: ShellOptions = {}): string {
  const header = opts.bare ? "" : `<header class="top"><div class="wrap">${LOGO}
<nav>${opts.nav ?? DEFAULT_NAV}</nav></div></header>
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="${opts.account ? "same-origin" : "no-referrer"}">
<title>${esc(title)}</title>
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Figtree:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<a class="skip" href="#${esc(opts.skip ?? "main")}">Skip to content</a>
${header}<main class="wrap" id="main">${body}</main>
<script nonce="${nonce}">${SNIPPETS_JS}${script}</script>
</body>
</html>`;
}

/** Header links for a signed-in page: the apps, the docs, and a sign-out form (POST /logout, same-origin). */
export const SIGNED_IN_NAV =
  '<a href="/account">Apps</a><a href="https://genclass.dev/docs">Docs</a><form method="post" action="/logout" class="so"><button type="submit">Sign out</button></form>';

// ------------------------------------------------------------------------------------------------- /start

export function startPage(nonce: string): string {
  const body = `
<section class="stack mt-xl">
  <h1>Get a token for your web app</h1>
  <p class="lead">One token per app. Add it to GenClass and every page load, detection and fix shows up on your own
  private dashboard. Free, no account.</p>
  <p class="muted small">To keep several apps in one place, <a href="/signup">create an account</a> or <a href="/login">sign in</a>. It is optional.</p>
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
        document.getElementById("tokc").appendChild(copyBtn(function(){ return j.token; }, "token", function(){ return document.getElementById("tok"); }));
        var d = document.getElementById("dash"); d.textContent = j.dashboardUrl; d.href = j.dashboardUrl;
        document.getElementById("dashc").appendChild(copyBtn(function(){ return j.dashboardUrl; }, "dashboard link", function(){ return d; }));
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
// Chart colours: blue, orange, violet, yellow, magenta (dataviz reference hues, light and dark steps, validated in this
// order against the light and dark page); no green, which the brand keeps for "GenClass fixed it". Five problem types
// get a slot, the rest share "Other". Every dynamic string goes through textContent.

export const DASH_CSS = `
:root{--t1:#2a78d6;--t2:#eb6834;--t3:#4a3aa7;--t4:#eda100;--t5:#e87ba4;--t0:#8a93a8;--grid:#E6EAF1;
  --display:"Outfit","Helvetica Neue",Arial,sans-serif;--sans:"Figtree","Helvetica Neue",Arial,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--t1:#3987e5;--t2:#d95926;--t3:#9085e9;--t4:#c98500;--t5:#d55181;--t0:#6f7b98;--grid:#1E2D55}}
body{font-family:var(--sans)}
h1,h2,h3{font-family:var(--display);letter-spacing:-.03em}
.dh{margin-top:40px}
.dh-top{display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:flex-end}
.dh h1{font-size:clamp(30px,4.4vw,46px);font-weight:700;line-height:1.05}
.meta{font:12.5px var(--mono);color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin-top:12px}
.meta .btn.sm{min-height:28px;padding:0 10px;font:500 12.5px var(--sans)}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--ink2)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--ink3);display:inline-block}
.live.on i{background:var(--accent-f)}
.ctl{display:flex;gap:10px;align-items:center}
.seg{display:inline-flex;border:1px solid var(--ink);border-radius:8px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--ink);padding:8px 14px;font:500 13px var(--sans);cursor:pointer}
.seg button+button{border-left:1px solid var(--ink)}
.seg button[aria-pressed=true]{background:var(--ink);color:var(--paper)}
.btn{font-family:var(--sans)}
.summary{margin-top:24px;font-size:clamp(18px,2.1vw,21px);line-height:1.5;max-width:68ch}
.summary b{font-weight:600}
.statrow{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));border-top:1px solid var(--ink);margin-top:32px}
.statrow>div{padding:18px 20px 20px 0;border-bottom:1px solid var(--rule);min-width:0}
.statrow .k{font:500 12px var(--mono);color:var(--ink3)}
.statrow .v{font:600 40px/1.05 var(--display);letter-spacing:-.03em;margin-top:10px;font-variant-numeric:tabular-nums}
.statrow .s{font-size:13.5px;color:var(--ink2);margin-top:6px}
.blk{margin-top:60px}
.blk-h{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--ink)}
.blk-h h2{font-size:22px;font-weight:700;margin:0}
.blk-h .aside{font-size:13.5px;color:var(--ink3)}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--ink2);margin-top:14px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.key{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
figure{margin:0}
figcaption{font:12px var(--mono);color:var(--ink3);margin-top:12px}
.plot{position:relative;margin-top:14px}
.plot svg{display:block;width:100%;height:auto;overflow:visible}
.plot text{font:12px var(--mono);fill:var(--ink3)}
.tip{position:absolute;pointer-events:none;background:var(--paper);border:1px solid var(--ink);border-radius:8px;padding:9px 11px;font-size:13px;min-width:160px;z-index:2}
.tip .t{font:600 13px var(--sans);margin-bottom:5px}
.tip .r{display:flex;align-items:center;gap:8px;justify-content:space-between}
.tip .r span:first-child{display:inline-flex;align-items:center;gap:7px;color:var(--ink2)}
.tip .r b{font-variant-numeric:tabular-nums;font-weight:600}
.finds{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));column-gap:44px}
.find{padding:24px 0;border-bottom:1px solid var(--rule);display:grid;gap:11px;align-content:start;min-width:0}
.find .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.find h3{font:600 17px var(--sans);letter-spacing:-.01em;display:flex;align-items:center;gap:9px}
.find .nw{text-align:right;white-space:nowrap}
.find .n{font:600 30px/1 var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.find .share{display:block;font:12px var(--mono);color:var(--ink3);margin-top:4px}
.find p{font-size:14.5px;color:var(--ink2)}
.find p.fix b{color:var(--ink);font-weight:600}
.where{list-style:none;display:grid;gap:3px}
.where li{display:flex;justify-content:space-between;gap:12px;font:13px var(--mono)}
.where li code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit}
.where li span{color:var(--ink3);font-variant-numeric:tabular-nums;flex:none}
.spark{display:block;width:100%;height:24px}
.two{display:grid;gap:56px 48px;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))}
table.dt{width:100%;border-collapse:collapse;font-size:14px}
table.dt th{font:500 12px var(--mono);color:var(--ink3);text-align:left;padding:12px 14px 10px 0;border-bottom:1px solid var(--rule);white-space:nowrap}
table.dt td{padding:11px 14px 11px 0;border-bottom:1px solid var(--rule);vertical-align:middle;white-space:nowrap}
table.dt .num{text-align:right;font-variant-numeric:tabular-nums}
table.dt td.route{font:13px var(--mono);max-width:240px;overflow:hidden;text-overflow:ellipsis}
table.dt td.wide{width:45%}
.mix{display:flex;gap:2px;height:6px}
.mix i{display:block;height:6px;border-radius:1px;min-width:3px}
.chip{display:inline-flex;align-items:center;gap:7px}
.did-a{color:var(--accent);font-weight:600}
dl.health{display:grid;grid-template-columns:minmax(150px,230px) minmax(0,1fr)}
dl.health dt,dl.health dd{padding:15px 0;border-bottom:1px solid var(--rule)}
dl.health dt{font:500 12.5px var(--mono);color:var(--ink3);padding-right:18px}
dl.health .v{font:600 18px var(--display);letter-spacing:-.01em}
dl.health .s{font-size:13.5px;color:var(--ink2);margin-top:3px}
dl.health ul{list-style:none;margin-top:6px;display:grid;gap:2px;font:12.5px var(--mono);color:var(--ink2)}
.ok-t{font:500 12.5px var(--mono);color:var(--accent);margin-left:8px}
.bad-t{font:500 12.5px var(--mono);color:var(--warn);margin-left:8px}
@media (max-width:560px){dl.health{grid-template-columns:1fr}dl.health dt{border-bottom:0;padding-bottom:0}}
.quiet{padding:36px 0;color:var(--ink3);font-size:14.5px}
details.more{border-top:1px solid var(--rule);padding:16px 0}
details.more summary{font:600 15px var(--sans);cursor:pointer}
.kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px 40px}
.kv h2{font:600 14px var(--sans);margin-bottom:8px}
.first{border-top:1px solid var(--ink);padding:22px 0;margin-top:32px;max-width:72ch}
.first p{font-size:15px;color:var(--ink2)}
.dfoot{margin:64px 0 36px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink3);max-width:90ch}
.dfoot a{color:var(--ink2)}
main.wrap:has(.app){max-width:1360px}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);gap:0 48px;align-items:start}
.side{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;scrollbar-width:thin;padding:28px 24px 28px 0;border-right:1px solid var(--rule);min-height:calc(100vh - 57px)}
.side .proj{font:600 15px var(--sans);letter-spacing:-.01em;overflow-wrap:anywhere}
.side .proj small{display:block;font:12px var(--mono);color:var(--ink3);margin-top:4px;font-weight:400}
.side .live{margin-top:10px;font:12px var(--mono)}
.side .seg{margin-top:18px;display:flex;width:100%}
.side .seg button{flex:1;padding:7px 4px;font-size:12.5px}
.side .grp{font:500 11.5px var(--mono);color:var(--ink3);margin:26px 0 8px}
.side nav a{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;margin:0 -10px;border-radius:7px;font-size:14px;color:var(--ink2);text-decoration:none}
.side nav a:hover{color:var(--ink);background:var(--panel)}
.side nav a[aria-current=true]{color:var(--ink);background:var(--panel);font-weight:600}
.side nav a span{font:12px var(--mono);color:var(--ink3);font-weight:400}
.side .out a{display:block;font-size:13.5px;color:var(--ink2);text-decoration:none;padding:5px 0}
.side .out a:hover{color:var(--ink)}
.side .btn{width:100%;margin-top:14px}
.side nav a[aria-current=page]{color:var(--ink);background:var(--panel);font-weight:600}
.side nav.apps a{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side nav.apps a.new{color:var(--accent);font-weight:500}
#period{display:contents}
.side .out form{display:block}
.side .out button.lnk{display:block;font-size:13.5px;color:var(--ink2);padding:5px 0}
.side .out button.lnk:hover{color:var(--ink)}
.connect{margin-top:36px}
.connect .keyrow{display:grid;grid-template-columns:minmax(150px,230px) minmax(0,1fr);padding:18px 0;border-bottom:1px solid var(--rule)}
.connect .keyrow .k{font:500 12.5px var(--mono);color:var(--ink3);padding-top:7px}
.connect .kval{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;min-width:0}
.connect .kval code{font:500 16px var(--mono);overflow-wrap:anywhere}
.connect .kn{grid-column:2;font-size:13.5px;color:var(--ink2);margin-top:8px;max-width:62ch}
.connect .ways{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:0 48px}
.connect .way{padding:22px 0;border-bottom:1px solid var(--rule);min-width:0;display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-content:start}
.connect .way>*{min-width:0}
.connect .eb{font:500 12.5px var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
.connect h3{font:600 17px var(--sans);letter-spacing:-.01em}
.connect .way p{font-size:14.5px;color:var(--ink2);max-width:62ch}
.connect .sh{display:flex;justify-content:space-between;align-items:center;gap:10px;font:500 12px var(--mono);color:var(--ink3);margin-top:4px}
.connect pre.code{white-space:pre-wrap;overflow-wrap:anywhere}
.connect .cnote{margin-top:18px;padding:12px 0 12px 14px;border-left:3px solid var(--warn);font-size:14.5px;line-height:1.5;color:var(--ink2);max-width:80ch}
.connect .cnote b{color:var(--warn);font-weight:600}
.cstat{display:flex;align-items:center;gap:9px;padding:16px 0;font:500 13.5px var(--mono);color:var(--ink2);border-bottom:1px solid var(--ink)}
.cstat i{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none;animation:gcpulse 1.6s ease-in-out infinite}
.cstat.on{color:var(--accent)}
.cstat.on i{background:var(--accent-f);animation:none}
@keyframes gcpulse{50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.cstat i{animation:none}}
.connect .fine{font-size:13px;color:var(--ink3);margin-top:14px;max-width:90ch}
@media (max-width:560px){.connect .keyrow{grid-template-columns:1fr}.connect .kn{grid-column:1}.connect .keyrow .k{padding-top:0;margin-bottom:6px}}
.mainc{min-width:0;padding-bottom:20px}
.mainc .dh{margin-top:32px}
section[id]{scroll-margin-top:16px}
@media (max-width:920px){
  .app{grid-template-columns:minmax(0,1fr)}
  .side{position:sticky;top:0;z-index:5;max-height:none;min-height:0;overflow:visible;padding:10px 0;border-right:0;border-bottom:1px solid var(--rule);background:var(--paper);display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
  .side .proj,.side .grp,.side .out,.side .live,.side .btn{display:none}
  .side .seg{margin-top:0;width:auto}
  .side .seg button{flex:none;padding:6px 10px}
  .side nav{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
  .side nav a{margin:0;white-space:nowrap;padding:6px 10px;font-size:13px}
  .side nav a span{display:none}
  .side nav.apps{display:none}
  section[id]{scroll-margin-top:64px}
}
`;

const DASH_JS = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var secret = location.pathname.split("/").filter(Boolean)[1] || "";
  var statsUrl = P.statsUrl || ("/api/projects/" + encodeURIComponent(secret));
  var range = "7d";
  try { var saved = localStorage.getItem("gc.dash.range"); if (/^(24h|7d|30d|90d|1y)$/.test(saved || "") && document.querySelector('.seg button[data-r="' + saved + '"]')) range = saved; } catch (e) {}
  var nf = new Intl.NumberFormat();
  function fmt(n){ return nf.format(Math.round(n || 0)); }
  function plural(n, one, many){ return fmt(n) + " " + (Math.round(n) === 1 ? one : many); }
  var RANGE = { "24h": "In the last 24 hours", "7d": "In the last 7 days", "30d": "In the last 30 days", "90d": "In the last 90 days", "1y": "In the last year" };
  var PREV = { "24h": "the 24 hours before", "7d": "the previous 7 days", "30d": "the previous 30 days", "90d": "the previous 90 days", "1y": "the year before" };
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
  function key(color){ var s = el("span", "key"); s.style.background = color; return s; }
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
  function stat(label0, value, sub){
    var d = el("div"); d.appendChild(el("div", "k", label0)); d.appendChild(el("div", "v", value)); if (sub) d.appendChild(el("div", "s", sub)); return d;
  }
  function tiles(S){
    var T0 = S.totals, B = S.breakdowns, host = document.getElementById("tiles"); host.textContent = "";
    var ready = T0.model_ready || 0, failed = T0.model_load_failed || 0, modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0;
    var outcomes = map(B.action_outcome), applied = outcomes.applied || T0.interventions || 0, undone = outcomes.undone || 0;
    host.appendChild(stat("Problems found", fmt(T0.detections), delta(T0.detections || 0, (S.previous || {}).detections || 0)));
    host.appendChild(stat("Pages affected", fmt((B.detect_route || []).length), (B.page_route || []).length ? "of " + plural((B.page_route || []).length, "page", "pages") + " that sent data" : ""));
    host.appendChild(stat("Stopped by GenClass", fmt(T0.interventions), acting ? (applied ? Math.round(100 * undone / applied) + "% undone by users" : "nothing needed stopping") : "observe mode reports only"));
    host.appendChild(stat("Model loaded", share(ready, ready + failed), ready ? "average " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") + ", " + plural(failed, "failure", "failures") : "no model loads yet"));
  }
  // ---------- problems over time
  function trend(S){
    var host = document.getElementById("trendplot"), leg = document.getElementById("legend"), tbl = document.getElementById("trendtable");
    host.textContent = ""; leg.textContent = ""; tbl.textContent = "";
    var hourly = S.range === "24h";
    document.getElementById("unit").textContent = hourly ? "hour" : "day";
    var rows = (S.typeSeries || []).map(function(b){
      var o = { bucket: b.bucket, total: 0, parts: {} };
      Object.keys(b.counts).forEach(function(k){ var s = slotOf(k); o.parts[s] = (o.parts[s] || 0) + b.counts[k]; o.total += b.counts[k]; });
      return o;
    });
    var order = SLOTS.concat(["other"]).filter(function(s){ return rows.some(function(r){ return r.parts[s]; }); });
    var total = rows.reduce(function(s, r){ return s + r.total; }, 0);
    document.getElementById("trendn").textContent = plural(total, "problem", "problems");
    if (!total) { host.appendChild(el("p", "quiet", "No problems found in this period.")); return; }
    if (order.length > 1) order.forEach(function(s){ var x = el("span"); x.appendChild(key(colorOf(s))); x.appendChild(document.createTextNode(s === "other" ? "Other" : TYPES[s].name)); leg.appendChild(x); });
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
        g.appendChild(svg("rect", { x: x, y: y, width: bw, height: Math.max(1, h), rx: j === drawn.length - 1 ? 3 : 0, fill: colorOf(s), stroke: "var(--paper)", "stroke-width": drawn.length > 1 ? 2 : 0 }));
      });
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        var lt = svg("text", { x: PL + i * step + step / 2, y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }); lt.textContent = label(r.bucket, hourly); g.appendChild(lt);
      }
      var hit = svg("rect", { x: PL + i * step, y: PT, width: step, height: plotH, fill: "transparent", tabindex: 0 });
      function show(){
        tip.textContent = ""; tip.appendChild(el("div", "t", label(r.bucket, hourly) + ": " + plural(r.total, "problem", "problems")));
        order.forEach(function(s){ if (!r.parts[s]) return; var row = el("div", "r"); var a = el("span"); a.appendChild(key(colorOf(s))); a.appendChild(document.createTextNode(s === "other" ? "Other" : TYPES[s].name)); row.appendChild(a); row.appendChild(el("b", null, fmt(r.parts[s]))); tip.appendChild(row); });
        tip.classList.remove("hidden");
        var box = host.getBoundingClientRect(), left = (PL + i * step + step / 2) / W * box.width;
        tip.style.left = Math.min(Math.max(0, left - 80), box.width - 170) + "px"; tip.style.top = "0px";
      }
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", function(){ tip.classList.add("hidden"); }); hit.addEventListener("blur", function(){ tip.classList.add("hidden"); });
      g.appendChild(hit);
    });
    host.appendChild(g); host.appendChild(tip);
    var tb = el("table", "dt"), hr = el("tr"); hr.appendChild(el("th", null, hourly ? "Hour" : "Day")); order.forEach(function(s){ hr.appendChild(el("th", null, s === "other" ? "Other" : TYPES[s].name)); }); hr.appendChild(el("th", null, "Total"));
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
      var t = T(x.key), c = el("article", "find");
      var top = el("div", "top"), h = el("h3"); h.appendChild(key(colorOf(slotOf(x.key)))); h.appendChild(document.createTextNode(t.name)); top.appendChild(h);
      var nw = el("div", "nw"); nw.appendChild(el("span", "n", fmt(x.count))); nw.appendChild(el("span", "share", total ? Math.round(100 * x.count / total) + "% of problems" : "")); top.appendChild(nw); c.appendChild(top);
      c.appendChild(spark(S, x.key));
      if (t.what) c.appendChild(el("p", null, t.what));
      var where = (byIssue[x.key] || []).slice().sort(function(a, b){ return b.count - a.count; });
      if (!where.length && recentBy[x.key]) where = Object.keys(recentBy[x.key]).map(function(r){ return { route: r, count: recentBy[x.key][r] }; }).sort(function(a, b){ return b.count - a.count; });
      if (where.length) {
        var ul = el("ul", "where");
        where.slice(0, 4).forEach(function(w){ var li = el("li"); li.appendChild(el("code", null, w.route)); li.appendChild(el("span", null, fmt(w.count))); ul.appendChild(li); });
        c.appendChild(ul);
      }
      if (t.fix) { var f = el("p", "fix"); f.appendChild(el("b", null, "Fix: ")); f.appendChild(document.createTextNode(t.fix)); c.appendChild(f); }
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
    if (!list.length) { host.appendChild(el("p", "quiet", "No problems on any page in this period.")); return; }
    var max = list[0].total || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Page")); hr.appendChild(el("th", "num", "Problems")); hr.appendChild(el("th", null, "By type"));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 8).forEach(function(r){
      var tr = el("tr"); var rc = el("td", "route", r.route); rc.title = r.route; tr.appendChild(rc); tr.appendChild(el("td", "num", fmt(r.total)));
      var td = el("td", "wide"), mix = el("div", "mix"), parts = SLOTS.concat(["other"]).filter(function(s){ return r.parts[s]; });
      if (!parts.length) { var i0 = el("i"); i0.style.width = (100 * r.total / max) + "%"; i0.style.background = "var(--bar3)"; mix.appendChild(i0); }
      parts.forEach(function(s){ var i = el("i"); i.style.width = (100 * r.parts[s] / max) + "%"; i.style.background = colorOf(s); i.title = (s === "other" ? "Other" : TYPES[s].name) + ": " + fmt(r.parts[s]); mix.appendChild(i); });
      td.appendChild(mix); tr.appendChild(td); body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
  }
  function acted(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("acted"); host.textContent = "";
    var modes = map(B.mode), acting = (modes.guard || 0) + (modes.heal || 0) > 0, list = B.intervention || [];
    if (!list.length) {
      host.appendChild(el("p", "quiet", acting ? "GenClass did not need to step in during this period." : "This app runs in observe mode, so GenClass only reports. Switch to guard mode when you trust what it reports, and what it stops will show here."));
      return;
    }
    var max = list[0].count || 1, tb = el("table", "dt"), hd = el("thead"), hr = el("tr");
    hr.appendChild(el("th", null, "Action")); hr.appendChild(el("th", "num", "Times")); hr.appendChild(el("th", null, ""));
    hd.appendChild(hr); tb.appendChild(hd); var body = el("tbody");
    list.slice(0, 8).forEach(function(x){
      var tr = el("tr"); tr.appendChild(el("td", null, ACTIONS[x.key] || x.key)); tr.appendChild(el("td", "num", fmt(x.count)));
      var td = el("td", "wide"), mix = el("div", "mix"), i = el("i"); i.style.width = (100 * x.count / max) + "%"; i.style.background = "var(--accent-f)"; mix.appendChild(i); td.appendChild(mix); tr.appendChild(td);
      body.appendChild(tr);
    });
    tb.appendChild(body); host.appendChild(tb);
    var o = map(B.action_outcome), applied = o.applied || T0.interventions || 0;
    host.appendChild(el("figcaption", null, plural(o.undone || 0, "change", "changes") + " undone by users" + (applied ? " (" + Math.round(100 * (o.undone || 0) / applied) + "%)" : "") + (o.failed ? ", " + plural(o.failed, "action", "actions") + " failed" : "") + "."));
  }
  function row(dl, label0, value, sub, flag){
    dl.appendChild(el("dt", null, label0)); var dd = el("dd"), v = el("div", "v", value);
    if (flag) v.appendChild(el("span", flag[0] === "ok" ? "ok-t" : "bad-t", flag[1]));
    dd.appendChild(v); if (sub) dd.appendChild(el("div", "s", sub)); dl.appendChild(dd); return dd;
  }
  function health(S){
    var B = S.breakdowns, T0 = S.totals, host = document.getElementById("health"); host.textContent = "";
    var dl = el("dl", "health"), ready = T0.model_ready || 0, failed = T0.model_load_failed || 0;
    var errs = (B.model_errors && B.model_errors.length) ? B.model_errors : (B.model_error_events || []);
    row(dl, "Model loads", ready + failed ? share(ready, ready + failed) + " succeeded" : "-", plural(ready, "load", "loads") + ", " + plural(failed, "failure", "failures"), (ready + failed) && failed / (ready + failed) > 0.02 ? ["bad", "needs a look"] : ready ? ["ok", "healthy"] : null);
    var be = B.backend || [], beTot = sum(be);
    row(dl, "Where it ran", be.length ? be.map(function(x){ return (x.key === "webgpu" ? "WebGPU" : x.key === "wasm" ? "WASM" : x.key) + " " + Math.round(100 * x.count / beTot) + "%"; }).join(", ") : "-", T0.modelLoadAvgMs ? "average load " + (T0.modelLoadAvgMs >= 1000 ? (T0.modelLoadAvgMs / 1000).toFixed(1) + " s" : fmt(T0.modelLoadAvgMs) + " ms") : "");
    row(dl, "Decision time", T0.latency_ms_n ? fmt(T0.latencyAvgMs) + " ms" : "-", T0.latency_ms_n ? "average over " + plural(T0.latency_ms_n, "decision", "decisions") : "no decisions yet");
    row(dl, "Ran without a decision", fmt(T0.failOpens), "times the app went ahead without a decision (model not ready, budget, hidden tab)", T0.failOpens ? null : ["ok", "none"]);
    if (errs.length) {
      var dd = row(dl, "Load errors", plural(sum(errs), "error", "errors"), "the model did not load on these page loads; the page still worked, without GenClass decisions", null), ul = el("ul");
      errs.slice(0, 4).forEach(function(x){ var li = el("li", null, fmt(x.count) + " \\u00D7 " + x.key); li.title = x.key; ul.appendChild(li); });
      dd.appendChild(ul);
    }
    var rv = B.runtime || [];
    if (rv.length) row(dl, "Runtime versions", rv.slice(0, 3).map(function(x){ return x.key; }).join(", "), rv.length > 1 ? "more than one version is live" : "");
    host.appendChild(dl);
  }
  function recent(S){
    var tb = document.getElementById("recent"); tb.textContent = "";
    (S.recent || []).forEach(function(r){
      var tr = el("tr");
      var t = el("td", null, new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })); t.title = r.t; tr.appendChild(t);
      tr.appendChild(el("td", "route", [r.route, r.fn ? "fn " + r.fn : null].filter(Boolean).join("  ") || "-"));
      var w = el("td"), ch = el("span", "chip"); ch.appendChild(key(colorOf(slotOf(r.diagnosis)))); ch.appendChild(document.createTextNode(r.diagnosis ? T(r.diagnosis).name : (r.trigger || "-"))); w.appendChild(ch); tr.appendChild(w);
      tr.appendChild(el("td", null, typeof r.confidence === "number" ? Math.round(r.confidence * 100) + "%" : "-"));
      var did = r.kind === "acted" && r.executed && r.ran && r.ran !== "deliver" && r.ran !== "send" && r.ran !== "apply";
      tr.appendChild(el("td", did ? "did-a" : null, did ? (ACTIONS[r.ran] || r.ran) : "Reported"));
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
    st.classList.toggle("on", live);
    document.getElementById("statust").textContent = live ? "Last event " + ago(S.lastEvent) : "Waiting for the first event";
    document.getElementById("updated").textContent = "Updated " + new Date(S.generated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    document.getElementById("nodata").classList.toggle("hidden", live || !!P.account);
    document.getElementById("content").classList.toggle("hidden", !live);
    var per = document.getElementById("period"); if (per) per.classList.toggle("hidden", !live);
    if (!live) { var ins = document.getElementById("install"); if (ins) ins.open = true; return; }
    summary(S); tiles(S); trend(S); cards(S); pages(S); acted(S); health(S); recent(S); advanced(S);
    var B2 = S.breakdowns, T2 = S.totals;
    document.getElementById("c-trend").textContent = fmt(T2.detections);
    document.getElementById("c-found").textContent = String((B2.detect_diagnosis || []).filter(function(x){ return x.key !== "expected"; }).length);
    document.getElementById("c-pages").textContent = String((B2.detect_route || []).length);
    document.getElementById("c-did").textContent = fmt(T2.interventions);
  }

  document.getElementById("pname").textContent = P.name;
  document.getElementById("sname").textContent = P.name;
  (function(){
    var links = [].slice.call(document.querySelectorAll(".snav a"));
    links.forEach(function(a){ a.addEventListener("click", function(){
      if (a.getAttribute("href") === "#setup") { var d = document.getElementById("install"); if (d) d.open = true; }
      if (a.getAttribute("href") === "#connect") { var cn = document.getElementById("connect"); if (cn) cn.classList.remove("hidden"); }
    }); });
    if (!("IntersectionObserver" in window)) return;
    var vis = {};
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ vis[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
      var best = null, br = 0; Object.keys(vis).forEach(function(k){ if (vis[k] > br) { br = vis[k]; best = k; } });
      // while an app waits for its first event the section links are hidden: the heading counts as Connect
      var per = document.getElementById("period"); if (best === "top" && per && per.classList.contains("hidden")) best = "connect";
      if (best) links.forEach(function(a){ a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + best)); });
    }, { rootMargin: "-10% 0px -55% 0px", threshold: [0, 0.2, 0.5, 1] });
    ["connect", "top", "trend", "found", "where", "did", "health-s", "recent-s", "setup"].forEach(function(id){ var e = document.getElementById(id); if (e) io.observe(e); });
  })();
  document.title = P.name + " | GenClass dashboard";
  if (document.getElementById("ptok")) {
    document.getElementById("ptok").textContent = P.token;
    document.getElementById("ptokc").appendChild(copyBtn(function(){ return P.token; }, "token", function(){ return document.getElementById("ptok"); }));
    renderSnippets(document.getElementById("snips"), P.token);
  }
  var btn = document.getElementById("refresh");
  function load(){
    btn.disabled = true;
    fetch(statsUrl + "?range=" + range, { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
      .then(function(r){
        if (r.status === 401 && P.account) location.href = "/login?next=" + encodeURIComponent(location.pathname);
        if (!r.ok) throw new Error("HTTP " + r.status); return r.json();
      })
      .then(render)
      .catch(function(e){ document.getElementById("updated").textContent = "Could not load stats (" + e.message + "). Retrying in a minute."; })
      .then(function(){ btn.disabled = false; });
  }
  document.querySelectorAll(".seg button").forEach(function(b){
    b.setAttribute("aria-pressed", String(b.getAttribute("data-r") === range));
    b.addEventListener("click", function(){
      range = b.getAttribute("data-r");
      try { localStorage.setItem("gc.dash.range", range); } catch (e) {}
      document.querySelectorAll(".seg button").forEach(function(o){ o.setAttribute("aria-pressed", String(o === b)); });
      load();
    });
  });
  btn.addEventListener("click", load);
  setInterval(function(){ if (document.visibilityState === "visible") load(); }, 60000);
  load();
})();`;

// The Connect panel (account mode): the project API key, the two ways to wire it in, and a status line that polls the
// account's app list every 5 s until this app's first batch arrives. Shown at the top until then; afterwards it is
// hidden and the sidebar's "Connect" link brings it back.
const CONNECT_JS = `
(function(){
  var P = JSON.parse(document.getElementById("project").textContent);
  var box = document.getElementById("connect"); if (!box) return;
  box.querySelectorAll("[data-copy]").forEach(function(b){
    b.addEventListener("click", function(){
      var at = b.getAttribute("data-target");
      gcCopy(b, b.getAttribute("data-copy"), at ? document.getElementById(at) : null);
    });
  });
  var st = document.getElementById("cstatus"), stt = document.getElementById("cstatust"), poll = document.getElementById("cpoll");
  // "at 14:02" today; "Oct 11, 2:02 PM" on another day, so a week-old first event does not read as this afternoon
  function when(iso){
    var d = new Date(iso), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? "at " + t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + t;
  }
  function show(p){
    if (!p || !p.last_event) { stt.textContent = "Waiting for the first event from this app"; return false; }
    st.classList.add("on"); if (poll) poll.classList.add("hidden");
    stt.textContent = p.first_event ? "Connected. First event " + when(p.first_event) : "Connected. Last event " + when(p.last_event);
    return true;
  }
  if (show({ last_event: P.lastEvent, first_event: P.firstEvent })) return;
  var done = false;
  function tick(){
    if (done || document.visibilityState !== "visible") return;
    fetch("/api/account/projects", { headers: { accept: "application/json" }, cache: "no-store", credentials: "same-origin" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function(j){
        var p = (j.projects || []).filter(function(x){ return x.id === P.id; })[0];
        if (!done && show(p)) { done = true; clearInterval(timer); var rb = document.getElementById("refresh"); if (rb) rb.click(); }
      })
      .catch(function(){ /* keep waiting; the next tick tries again */ });
  }
  var timer = setInterval(tick, 5000);
  // a hidden tab does not poll; check at once when the person comes back from their editor or terminal
  document.addEventListener("visibilitychange", tick);
})();`;

export interface DashboardOptions {
  /** Owned-app mode (/account/apps/<id>): the account's apps in the sidebar, the Connect panel, account stats API. */
  account?: { apps: { id: string; name: string }[]; current: string; email: string | null };
  /** The project's id (account mode). */
  id?: string;
  /** When the app's first batch arrived (account mode; null while waiting). */
  firstEvent?: string | null;
  /** Account mode: whether the app's private dashboard link still opens these stats (the footer says so). */
  privateLink?: boolean;
  /** Whether the @genclass/runtime on npm reads project keys (0.3.0 or later); until then the panel says so first. */
  runtimeReady?: boolean;
  /** Account mode: the time ranges the account's plan shows (src/plans.ts); default 24 h, 7 and 30 days. */
  ranges?: string[];
  /** Account mode: how many days the plan keeps this app's data (the footer says it); default 90. */
  keepDays?: number;
  /** Account mode: plan-dependent sections (forwarding, export; src/billing-pages.ts) and their script. */
  extra?: { html: string; script: string };
}

const RANGE_LABELS: Record<string, string> = { "24h": "24 h", "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year" };
/** Short labels when a plan shows more than three ranges (five buttons fit the sidebar only this way). */
const RANGE_SHORT: Record<string, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "90d": "90d", "1y": "1y" };

function rangeButtons(ranges: string[]): string {
  const short = ranges.length > 3;
  return ranges
    .map((r) => {
      const label = esc(RANGE_LABELS[r] ?? r);
      return `<button type="button" data-r="${esc(r)}" aria-pressed="${r === "7d"}"${short ? ` aria-label="${label}" title="${label}">${esc(RANGE_SHORT[r] ?? r)}` : `>${label}`}</button>`;
    })
    .join("");
}

/** More apps than this and the sidebar lists only the current one, with a link to all of them. */
const SIDEBAR_APPS = 4;

function connectPanel(token: string, connected: boolean, runtimeReady: boolean): string {
  const t = esc(token);
  const init = `import { GenClass } from "@genclass/runtime";\n\nGenClass.init({ token: "${token}" });`;
  const tag = `<script src="${CDN_SCRIPT}" data-token="${token}"></script>`;
  const meta = `<meta name="genclass" content="token=${token}">\n\n// in your entry file\nimport "@genclass/runtime/auto";`;
  let n = 0;
  const snip = (label: string, name: string, code: string) => {
    const id = `csnip${++n}`;
    return `<div><div class="sh"><span>${label}</span><button class="btn sm ghost" type="button" data-copy="${esc(code)}" data-target="${id}" aria-label="Copy ${name}">Copy</button></div><pre class="code" id="${id}" tabindex="0" aria-label="${esc(label)}">${esc(code)}</pre></div>`;
  };
  const notYet = runtimeReady
    ? ""
    : `<p class="cnote" id="cnote"><b>Not on npm yet.</b> Project keys and <code>login</code> ship in @genclass/runtime 0.3.0, the next release. Until it is published, <code>npx @genclass/runtime login</code> stops with "unknown command" and 0.2.x does not send this key, so this line keeps waiting.</p>`;
  return `<section class="connect${connected ? " hidden" : ""}" id="connect" aria-labelledby="connect-h">
  <div class="blk-h"><h2 id="connect-h">Connect this app</h2><span class="aside">Needs @genclass/runtime 0.3.0 or later</span></div>
  ${notYet}
  <div class="keyrow">
    <div class="k">Project API key</div>
    <div class="kval"><code id="ckey">${t}</code><button class="btn sm ghost" type="button" data-copy="${t}" data-target="ckey" aria-label="Copy the project API key">Copy</button></div>
    <p class="kn">Public, and safe in front-end code: it can only add telemetry to this app. It cannot open this dashboard or change anything.</p>
  </div>
  <p class="cstat" id="cstatus" aria-live="polite"><i></i><span id="cstatust">Waiting for the first event from this app</span></p>
  <div class="ways">
    <div class="way">
      <div class="eb">1 · Run in your project</div>
      <h3>Sign in from the terminal</h3>
      ${snip("In the app's folder", "the login command", "npx @genclass/runtime login")}
      <p>Signs you in and connects the app in that folder: you pick this app, it shows the change to your files, and writes the key after you agree.</p>
    </div>
    <div class="way">
      <div class="eb">2 · Or add the key yourself</div>
      <h3>Paste one of these</h3>
      ${snip("In code", "the init code", init)}
      ${snip("Script tag", "the script tag", tag)}
      ${snip("Meta tag, with a bundler", "the meta tag", meta)}
    </div>
  </div>
  <p class="fine">The key needs @genclass/runtime 0.3.0 or later: 0.2.x does not send it. Events arrive in batches every 10 seconds.
  Local hosts (localhost, *.local, *.test, private networks) do not send, even with a key, so the first event comes from your deployed site.<span id="cpoll"> The status line above checks every 5 seconds.</span></p>
</section>`;
}

export function dashboardPage(
  nonce: string,
  project: { name: string; token: string; created: string; lastEvent: string | null },
  opts: DashboardOptions = {},
): string {
  const acct = opts.account;
  const waiting = !!acct && !project.lastEvent;
  const data = acct ? { ...project, id: opts.id, firstEvent: opts.firstEvent ?? null, statsUrl: `/api/account/projects/${opts.id}/stats`, account: true } : project;
  let appLinks = "";
  if (acct) {
    const many = acct.apps.length > SIDEBAR_APPS;
    const shown = many ? acct.apps.filter((a) => a.id === acct.current) : acct.apps;
    appLinks =
      shown.map((a) => `<a href="/account/apps/${esc(a.id)}"${a.id === acct.current ? ' aria-current="page"' : ""}>${esc(a.name)}</a>`).join("") +
      (many ? `<a href="/account#apps">All apps <span>${acct.apps.length}</span></a>` : "");
  }
  const apps = acct
    ? `<div class="grp">Your apps</div>
  <nav class="apps" aria-label="Your apps">${appLinks}<a class="new" href="/account#new-app">New app</a></nav>
  <div class="grp">Account</div>
  <div class="out"><a href="/account">Account</a><a href="/account/billing">Plan and billing</a><form method="post" action="/logout"><button class="lnk" type="submit">Sign out</button></form></div>`
    : "";
  const setup = acct
    ? ""
    : `<section class="blk" id="setup"><details class="more" id="install"><summary>Setup: your token and install snippets</summary>
  <div class="row small mt-s"><span class="muted">Token</span><code id="ptok" class="mono brk"></code><span id="ptokc"></span></div>
  <div id="snips" class="stack mt-s"></div></details></section>`;
  const report = '<a href="https://github.com/genclass-dev/GenClass-lib/issues/new?title=False%20detection%3A%20">Report a false detection</a>';
  const privacy = acct
    ? `${
        opts.privateLink
          ? "This app also has the private dashboard link it had before it joined your account, and anyone with that link can see these stats. You can turn the link off on your <a href=\"/account#apps\">account page</a>."
          : "Only you can open this page, while signed in."
      } <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a> · ${report} · <a href="/account">All apps</a>`
    : `Keep this link private: anyone with it can see these stats. <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a> · <a href="/start">Get another token</a>`;
  // Account mode: Connect has its own group; while the app waits for its first event the range control and the section
  // links (which point into the hidden stats) stay hidden, and render() shows them when data arrives.
  const sections = `<div class="seg" role="group" aria-label="Time range">
    ${rangeButtons(opts.ranges ?? ["24h", "7d", "30d"])}
  </div>
  <div class="grp">This period</div>
  <nav class="snav" id="snav" aria-label="Sections">
    <a href="#top">Overview</a>
    <a href="#trend">Problems found <span id="c-trend"></span></a>
    <a href="#found">What it found <span id="c-found"></span></a>
    <a href="#where">Pages <span id="c-pages"></span></a>
    <a href="#did">What GenClass did <span id="c-did"></span></a>
    <a href="#health-s">Health</a>
    <a href="#recent-s">Recent activity</a>
    ${acct ? "" : '<a href="#setup">Setup</a>'}
  </nav>`;
  const side = acct
    ? `<div class="grp">Setup</div>
  <nav class="snav" id="cnav" aria-label="Setup"><a href="#connect"${waiting ? ' aria-current="true"' : ""}>Connect</a></nav>
  <div id="period"${waiting ? ' class="hidden"' : ""}>
  ${sections}
  </div>
  ${apps}`
    : `${sections}
  <div class="grp">Elsewhere</div>
  <div class="out">
    <a href="https://genclass.dev/docs">Docs</a>
    <a href="https://github.com/genclass-dev/GenClass-lib/blob/main/packages/runtime/TELEMETRY.md">What is collected</a>
    ${report}
    <a href="https://discord.gg/kN9kRnFtZm">Discord</a>
  </div>`;
  const body = `
<script type="application/json" id="project">${embed(data)}</script>
<style nonce="${nonce}">${DASH_CSS}</style>
<div class="app">
<aside class="side" aria-label="Dashboard">
  <div class="proj"><span id="sname"></span><small>Dashboard</small></div>
  <div class="live" id="status"><i></i><span id="statust">Loading</span></div>
  ${side}
</aside>
<div class="mainc" id="mc" tabindex="-1">
<section class="dh" id="top">
  <h1 id="pname"></h1>
  <div class="meta"><span id="updated"></span><button class="btn ghost sm" id="refresh" type="button">Refresh</button></div>
  <p class="summary" id="summary"></p>
</section>
${acct ? connectPanel(project.token, !!project.lastEvent, opts.runtimeReady === true) : ""}
<section id="nodata" class="first hidden"><p>No data yet. Add the snippet under Setup to your app, load a page, and come back in a minute.
Events arrive in batches every 10 seconds and when a tab is hidden. Local hosts (localhost, *.local, *.test, private networks) do not send, even with a token: load a page of your deployed site.</p></section>
<div id="content" class="hidden">
<div class="statrow" id="tiles"></div>
<section class="blk" id="trend">
  <div class="blk-h"><h2>Problems found</h2><span class="aside" id="trendn"></span></div>
  <figure>
    <div class="legend" id="legend"></div>
    <div class="plot" id="trendplot"></div>
    <figcaption>Fig. 1. Problems GenClass found, per <span id="unit">day</span>, by type. Hover a bar for its breakdown.</figcaption>
  </figure>
  <details class="more"><summary>Table view</summary><div id="trendtable" class="mt-s"></div></details>
</section>
<section class="blk" id="found">
  <div class="blk-h"><h2>What GenClass found</h2><span class="aside">Each kind of problem, where it happened and how to fix it</span></div>
  <div class="finds" id="issues"></div>
  <p class="quiet hidden" id="issuesempty">No problems found in this period.</p>
</section>
<section class="blk two" id="where">
  <div><div class="blk-h"><h2>Pages</h2><span class="aside">Table 1. Pages with the most problems</span></div><div id="pages"></div></div>
  <div id="did"><div class="blk-h"><h2>What GenClass did</h2><span class="aside">Table 2. Actions it took</span></div><div id="acted"></div></div>
</section>
<section class="blk" id="health-s">
  <div class="blk-h"><h2>Health</h2><span class="aside">Whether GenClass could watch your pages at all</span></div>
  <div id="health"></div>
</section>
<section class="blk" id="recent-s">
  <div class="blk-h"><h2>Recent activity</h2><span class="aside">Table 3. The latest 50 detections and interventions</span></div>
  <div class="tablewrap"><table class="dt"><thead><tr><th>Time</th><th>Page / function</th><th>What</th><th class="num">Confidence</th><th>GenClass</th><th>Mode</th></tr></thead>
  <tbody id="recent"></tbody></table></div>
  <p class="quiet hidden" id="recent0">Nothing detected in this period.</p>
</section>
<section class="blk"><details class="more"><summary>All breakdowns</summary><div class="kv mt-s" id="adv"></div></details></section>
</div>
${setup}
${opts.extra?.html ?? ""}
<footer class="dfoot">This page shows counts only: the kind of problem, the page route, confidence, what GenClass did and how fast it
decided. No text from your pages, no IP addresses and no user agents are stored. Data is kept ${(opts.keepDays ?? 90) >= 365 ? "1 year" : `${opts.keepDays ?? 90} days`} (hourly detail 48 hours). ${privacy}</footer>
</div>
</div>`;
  return shell(
    nonce,
    `${project.name} | GenClass dashboard`,
    body,
    acct ? DASH_JS + CONNECT_JS + (opts.extra?.script ?? "") : DASH_JS,
    acct ? { nav: SIGNED_IN_NAV, account: true, skip: "mc" } : { skip: "mc" },
  );
}
